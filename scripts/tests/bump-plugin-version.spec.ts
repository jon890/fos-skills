// 플러그인 version 자동 상향 명령(scripts/bump-plugin-version)의 명령 경계 테스트.
// 임시 git 저장소에 명령을 복사해 --base --head --date 로 부르고 stdout, stderr 의 경고, 바뀐 파일, 종료 코드를 본다.
// main push 에서만 도는 workflow 의 명령이라 PR CI 로 실제 동작을 보지 못한다. 그래서 사례를 넉넉히 둔다.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { runCommand } from '../../modules/testkit/command.ts'
import { git, gitEnv } from '../../modules/testkit/git.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { copyFromRepo } from './boundary.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['python3', 'scripts/bump-plugin-version.py']
const FILES = ['scripts/bump-plugin-version.py', 'scripts/skill_changes.py', 'scripts/skill_paths.py']
// ──

const MANIFEST = '{\n  "name": "demo",\n  "version": "1.4.0",\n  "skills": ["./orch"]\n}\n'
const PLUGIN_LOG = '# CHANGELOG: demo 플러그인\n\n설명.\n\n## 1.4.0 (2026-11-01)\n\n- orch 5.15.0 (#280)\n'
const SKILL_LOG = '# CHANGELOG: orch\n\n## 5.15.0 (2026-11-01)\n\n- 앞 변경\n'
const SKILL_MD = '---\nname: orch\nmetadata:\n  version: "5.15.0"\n---\n'
const ZERO = '0'.repeat(40)

type Repo = { root: string; base: string }

function write(root: string, path: string, text: string): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function commit(root: string, subject: string): string {
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', subject])
  return git(root, ['rev-parse', 'HEAD'])
}

function repo(t: { after(fn: () => void): void }): Repo {
  const root = tempDir('bump-', t)
  git(root, ['init', '-q', '-b', 'main'])
  write(root, '.claude-plugin/plugin.json', MANIFEST)
  write(root, '.claude-plugin/CHANGELOG.md', PLUGIN_LOG)
  write(root, 'skills/orch/CHANGELOG.md', SKILL_LOG)
  write(root, 'skills/orch/SKILL.md', SKILL_MD)
  return { root, base: commit(root, 'init') }
}

// 명령 파일은 커밋한 뒤에 복사한다. 추적하지 않는 파일이라 base..head 의 바뀐 파일에 들지 않는다
function bump(root: string, args: string[]) {
  if (!existsSync(join(root, FILES[0]))) copyFromRepo(root, FILES)
  return runCommand([...COMMAND, ...args], { cwd: root, env: gitEnv() })
}

function run(r: Repo, head: string, date = '2026-11-02') {
  return bump(r.root, ['--base', r.base, '--head', head, '--date', date])
}

function version(root: string): string {
  return JSON.parse(read(root, '.claude-plugin/plugin.json')).version
}

describe('bump-plugin-version 등급과 요약 줄', () => {
  test('새 스킬 버전 절은 minor 이고 스킬과 PR 번호를 적는다. plugin.json 은 version 줄만 바뀐다', (t) => {
    const r = repo(t)
    write(r.root, 'skills/orch/CHANGELOG.md', SKILL_LOG.replace('## 5.15.0', '## 5.16.0 (2026-11-02)\n\n- 새 기능\n\n## 5.15.0'))
    const done = run(r, commit(r.root, 'Merge pull request #286 from jon890/feat/x'))
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, '1.5.0\n')
    assert.equal(read(r.root, '.claude-plugin/plugin.json'), MANIFEST.replace('1.4.0', '1.5.0'))
    assert.equal(
      read(r.root, '.claude-plugin/CHANGELOG.md'),
      '# CHANGELOG: demo 플러그인\n\n설명.\n\n## 1.5.0 (2026-11-02)\n\n- orch 5.16.0 (#286)\n\n## 1.4.0 (2026-11-01)\n\n- orch 5.15.0 (#280)\n',
    )
  })

  test('CHANGELOG 를 옮기면 옛 버전을 다시 적지 않고 patch 다', (t) => {
    const r = repo(t)
    git(r.root, ['mv', 'skills/orch', 'orch'])
    const done = run(r, commit(r.root, 'refactor: move skill'))
    assert.equal(done.stdout, '1.4.1\n')
    assert.ok(!read(r.root, '.claude-plugin/CHANGELOG.md').split('## 1.4.0')[0].includes('orch 5.15.0 (#'))
  })

  test('호환성 줄은 major 다', (t) => {
    const r = repo(t)
    write(r.root, 'skills/orch/CHANGELOG.md', SKILL_LOG.replace('## 5.15.0', '## 6.0.0 (2026-11-02)\n\n- 호환성: 단계가 바뀐다\n\n## 5.15.0'))
    const done = run(r, commit(r.root, 'feat(orch): 단계를 바꾼다 (#287)'))
    assert.equal(done.stdout, '2.0.0\n')
    assert.ok(read(r.root, '.claude-plugin/CHANGELOG.md').includes('## 2.0.0 (2026-11-02)\n\n- orch 6.0.0 (#287)\n'))
  })

  test('스킬 버전이 없는 변경은 patch 이고 바뀐 최상위 폴더를 적는다', (t) => {
    const r = repo(t)
    write(r.root, 'docs/flow.md', '흐름\n')
    write(r.root, 'scripts/x.txt', '1\n')
    const done = run(r, commit(r.root, 'docs: 흐름을 고친다 (#288)'))
    assert.equal(done.stdout, '1.4.1\n')
    assert.ok(read(r.root, '.claude-plugin/CHANGELOG.md').includes('## 1.4.1 (2026-11-02)\n\n- 바뀐 곳: docs, scripts (#288)\n\n## 1.4.0'))
  })

  test('PR 번호가 없으면 괄호를 붙이지 않는다', (t) => {
    const r = repo(t)
    write(r.root, 'docs/a.md', 'a\n')
    const done = run(r, commit(r.root, 'docs: a'))
    assert.equal(done.stdout, '1.4.1\n')
    assert.ok(read(r.root, '.claude-plugin/CHANGELOG.md').includes('## 1.4.1 (2026-11-02)\n\n- 바뀐 곳: docs\n\n'))
  })
})

describe('bump-plugin-version 을 건너뛰는 경우', () => {
  test('직접 올린 version 은 skip 이고 파일을 그대로 둔다', (t) => {
    const r = repo(t)
    write(r.root, '.claude-plugin/plugin.json', MANIFEST.replace('1.4.0', '2.0.0'))
    write(r.root, 'docs/flow.md', '흐름\n')
    const done = run(r, commit(r.root, 'chore: 직접 올린다'))
    assert.equal(done.code, 0)
    assert.equal(done.stdout, 'skip: 이번 변경이 version 을 이미 바꿨어요\n')
    assert.equal(version(r.root), '2.0.0')
  })

  test('플러그인 이력만 바뀌면 skip 이다', (t) => {
    const r = repo(t)
    write(r.root, '.claude-plugin/CHANGELOG.md', PLUGIN_LOG + '\n')
    const done = run(r, commit(r.root, 'chore: 플러그인 이력만'))
    assert.equal(done.stdout, 'skip: 플러그인 버전 파일 말고 바뀐 것이 없어요\n')
    assert.equal(version(r.root), '1.4.0')
  })

  test('앞 실행이 처리한 조각을 더한 범위는 다시 올리지 않는다', (t) => {
    const r = repo(t)
    write(r.root, 'skills/orch/changes/a.minor.md', '- 하나\n')
    const head = commit(r.root, 'add fragment')
    git(r.root, ['rm', '-q', 'skills/orch/changes/a.minor.md'])
    commit(r.root, 'bot: processed')
    assert.match(run(r, head).stdout, /^skip:/)
    assert.equal(version(r.root), '1.4.0')
  })

  test('직접 올린 version 이어도 조각은 적용한다', (t) => {
    const r = repo(t)
    write(r.root, '.claude-plugin/plugin.json', MANIFEST.replace('1.4.0', '2.0.0'))
    write(r.root, 'skills/orch/changes/a.minor.md', '- 하나\n')
    const done = run(r, commit(r.root, 'chore: 직접 올린다'))
    assert.match(done.stdout, /^skip:/)
    assert.equal(version(r.root), '2.0.0')
    assert.ok(read(r.root, 'skills/orch/CHANGELOG.md').startsWith('# CHANGELOG: orch\n\n## 5.16.0 (2026-11-02)\n\n- 하나\n\n## 5.15.0'))
  })
})

describe('bump-plugin-version 의 base', () => {
  for (const [name, base] of [
    ['0 40개', ZERO],
    ['빈 문자열', ''],
  ]) {
    test(`base 가 ${name}이면 head 의 부모를 쓴다`, (t) => {
      const r = repo(t)
      write(r.root, 'docs/a.md', 'a\n')
      const head = commit(r.root, 'docs: a')
      const done = bump(r.root, ['--base', base, '--head', head, '--date', '2026-11-02'])
      assert.equal(done.stdout, '1.4.1\n', done.stderr)
    })
  }

  test('--base 를 주지 않아도 head 의 부모를 쓴다', (t) => {
    const r = repo(t)
    write(r.root, 'docs/a.md', 'a\n')
    commit(r.root, 'docs: a')
    assert.equal(bump(r.root, ['--date', '2026-11-02']).stdout, '1.4.1\n')
  })
})

describe('bump-plugin-version 의 변경 이력 조각', () => {
  test('조각은 스킬 버전과 플러그인 minor 를 올리고 새 스킬 버전을 적는다', (t) => {
    const r = repo(t)
    write(r.root, 'skills/orch/changes/add-queue.patch.md', '- 문구를 고쳤다\n')
    write(r.root, 'skills/orch/SKILL.md', SKILL_MD + '본문\n')
    const done = run(r, commit(r.root, 'Merge pull request #290 from jon890/fix/x'))
    assert.equal(done.stdout, '1.5.0\n')
    assert.equal(done.stderr, '')
    assert.ok(read(r.root, '.claude-plugin/CHANGELOG.md').includes('## 1.5.0 (2026-11-02)\n\n- orch 5.15.1 (#290)\n'))
    assert.equal(read(r.root, 'skills/orch/SKILL.md'), SKILL_MD.replace('5.15.0', '5.15.1') + '본문\n')
    assert.equal(read(r.root, 'skills/orch/CHANGELOG.md'), SKILL_LOG.replace('## 5.15.0', '## 5.15.1 (2026-11-02)\n\n- 문구를 고쳤다\n\n## 5.15.0'))
    assert.ok(!existsSync(join(r.root, 'skills/orch/changes')))
  })

  test('조각과 옛 호환성 줄이 섞이면 major 이고 새 CHANGELOG 의 절을 모두 적는다', (t) => {
    const r = repo(t)
    write(r.root, 'skills/orch/changes/a.minor.md', '- 새 기능\n')
    write(r.root, 'skills/plan/CHANGELOG.md', '# CHANGELOG: plan\n\n## 6.0.0 (2026-11-02)\n\n- 호환성: 단계가 바뀐다\n\n## 5.0.0 (2026-11-01)\n\n- 앞\n')
    const done = run(r, commit(r.root, 'feat: 섞인 변경 (#291)'))
    assert.equal(done.stdout, '2.0.0\n')
    assert.ok(read(r.root, '.claude-plugin/CHANGELOG.md').includes('- orch 5.16.0, plan 6.0.0, plan 5.0.0 (#291)\n'))
  })

  test('조각 둘은 플러그인을 한 번 올리고 새 버전을 모두 적는다', (t) => {
    const r = repo(t)
    write(r.root, 'skills/orch/changes/a.minor.md', '- 하나\n')
    commit(r.root, 'feat: a (#293)')
    write(r.root, 'skills/orch/changes/b.patch.md', '- 둘\n')
    const done = run(r, commit(r.root, 'fix: b (#294)'))
    assert.equal(done.stdout, '1.5.0\n')
    const log = read(r.root, '.claude-plugin/CHANGELOG.md')
    assert.ok(log.includes('## 1.5.0 (2026-11-02)\n\n- orch 5.16.0, orch 5.16.1 (#294 #293)\n'), log)
    assert.equal(log.split('## 1.5.0').length, 2)
  })

  test('머지 커밋 범위를 끝까지 처리한다', (t) => {
    const r = repo(t)
    git(r.root, ['checkout', '-q', '-b', 'feature'])
    write(r.root, 'skills/orch/changes/a.minor.md', '- 하나\n')
    commit(r.root, 'feat: a')
    git(r.root, ['checkout', '-q', 'main'])
    git(r.root, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #295 from jon890/feature', 'feature'])
    const done = run(r, git(r.root, ['rev-parse', 'HEAD']), '2026-11-04')
    assert.equal(done.stdout, '1.5.0\n')
    assert.ok(read(r.root, '.claude-plugin/CHANGELOG.md').includes('## 1.5.0 (2026-11-04)\n\n- orch 5.16.0 (#295)'))
  })

  test('틀린 조각은 남기고 stderr 에 경고를 내며 플러그인은 patch 다', (t) => {
    const r = repo(t)
    write(r.root, 'skills/orch/changes/bad.md', '- 하나\n')
    write(r.root, 'docs/a.md', 'a\n')
    const done = run(r, commit(r.root, 'docs: a (#292)'))
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '1.4.1\n')
    assert.match(done.stderr, /^경고: skills\/orch\/changes\/bad\.md: 이름이 /m)
    assert.ok(existsSync(join(r.root, 'skills/orch/changes/bad.md')))
  })
})

describe('bump-plugin-version 의 옵션과 종료 코드', () => {
  test('긴 옵션의 고유 접두와 --이름=값 을 받는다', (t) => {
    const r = repo(t)
    write(r.root, 'docs/a.md', 'a\n')
    const head = commit(r.root, 'docs: a')
    const done = bump(r.root, [`--ba=${r.base}`, '--hea', head, '--da', '2026-11-03'])
    assert.equal(done.stdout, '1.4.1\n', done.stderr)
    assert.ok(read(r.root, '.claude-plugin/CHANGELOG.md').includes('## 1.4.1 (2026-11-03)'))
  })

  for (const args of [['--he', 'HEAD'], ['--nope'], ['--date'], ['extra']]) {
    test(`사용법 오류 ${args.join(' ')} 는 종료 코드 2 이고 파일을 바꾸지 않는다`, (t) => {
      const r = repo(t)
      const done = bump(r.root, args)
      assert.equal(done.code, 2, done.stderr)
      assert.equal(done.stdout, '')
      assert.equal(read(r.root, '.claude-plugin/CHANGELOG.md'), PLUGIN_LOG)
    })
  }

  test('--help 는 0 이다', (t) => {
    assert.equal(bump(repo(t).root, ['--help']).code, 0)
  })

  test('--head 를 주지 않으면 HEAD 다', (t) => {
    const r = repo(t)
    write(r.root, 'docs/a.md', 'a\n')
    commit(r.root, 'docs: a')
    assert.equal(bump(r.root, ['--base', r.base, '--date', '2026-11-02']).stdout, '1.4.1\n')
  })

  test('plugin.json 의 version 이 X.Y.Z 가 아니면 1 이고 이유를 stderr 에 낸다', (t) => {
    const r = repo(t)
    write(r.root, '.claude-plugin/plugin.json', MANIFEST.replace('1.4.0', '1.4'))
    commit(r.root, 'chore: 틀린 version')
    write(r.root, 'docs/a.md', 'a\n')
    const head = commit(r.root, 'docs: a')
    write(r.root, 'skills/orch/changes/a.minor.md', '- 하나\n')
    const done = bump(r.root, ['--head', head, '--date', '2026-11-02'])
    assert.equal(done.code, 1)
    assert.equal(done.stdout, '')
    assert.match(done.stderr, /version 이 X\.Y\.Z 가 아니에요/)
    // 조각 적용은 version 검사보다 먼저 돈다. 플러그인 파일은 그대로다
    assert.ok(!existsSync(join(r.root, 'skills/orch/changes/a.minor.md')))
    assert.equal(read(r.root, '.claude-plugin/CHANGELOG.md'), PLUGIN_LOG)
  })

  test('버전 절이 없는 플러그인 CHANGELOG 는 끝에 절을 붙인다', (t) => {
    const r = repo(t)
    write(r.root, '.claude-plugin/CHANGELOG.md', '# CHANGELOG\n\n설명.\n\n\n')
    commit(r.root, 'chore: 이력 비움')
    write(r.root, 'docs/a.md', 'a\n')
    const done = bump(r.root, ['--head', commit(r.root, 'docs: a (#9)'), '--date', '2026-11-02'])
    assert.equal(done.stdout, '1.4.1\n')
    assert.equal(read(r.root, '.claude-plugin/CHANGELOG.md'), '# CHANGELOG\n\n설명.\n\n## 1.4.1 (2026-11-02)\n\n- 바뀐 곳: docs (#9)\n')
  })
})
