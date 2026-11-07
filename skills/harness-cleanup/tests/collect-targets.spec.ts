// collect_targets 의 명령 경계 테스트. 대상 선택(target_files.is_target)도 이 명령의 출력으로 본다.

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { gitEnv } from '../../../modules/testkit/git.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { Repo, run } from './helpers.ts'

const names = (stdout: string) =>
  stdout
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => line.trim().split(/\s+/)[0])

describe('대상 선택', () => {
  test('저장소 지침과 오버레이와 참조 문서를 고른다', () => {
    const r = new Repo()
    for (const f of ['AGENTS.md', 'CLAUDE.md', 'sub/AGENTS.md', '.orch/overlay.md', '.claude/plan-overlay.md', 'skills/a/SKILL.md', 'skills/a/references/x.md', '.claude/rules/r.md', '.claude/agents/a.md', '.claude/references/ref.md', '.agents/roles/role.md', '.claude/skills/_shared/s.md', '.codex/agents/a.toml'])
      r.file(f, 'x\n')
    const done = r.run('collect_targets', [r.root])
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(names(done.stdout).sort(), ['.agents/roles/role.md', '.claude/agents/a.md', '.claude/plan-overlay.md', '.claude/references/ref.md', '.claude/rules/r.md', '.claude/skills/_shared/s.md', '.codex/agents/a.toml', '.orch/overlay.md', 'AGENTS.md', 'CLAUDE.md', 'skills/a/SKILL.md', 'skills/a/references/x.md', 'sub/AGENTS.md'].sort())
  })

  test('다른 이름의 overlay 와 일반 references 와 README 는 고르지 않는다', () => {
    const r = new Repo()
    for (const f of ['CLAUDE.md', 'skills/orch/references/overlay.md', '.orch/specs/spec-a.md', 'docs/references/x.md', 'README.md', 'docs/overlay.md', 'skills/a/other.md']) r.file(f, 'x\n')
    r.file('skills/a/SKILL.md', 'x\n')
    const done = r.run('collect_targets', [r.root])
    assert.deepEqual(names(done.stdout).sort(), ['CLAUDE.md', 'skills/a/SKILL.md'])
  })

  test('건너뛰는 폴더 아래는 보지 않는다', () => {
    const r = new Repo()
    r.file('CLAUDE.md', 'x\n')
    for (const d of ['.git', '.omx', '.venv', 'node_modules', 'applications', 'cache', 'data', 'logs', 'private', 'reports', 'sources', 'tasks', 'worktrees']) r.file(`${d}/AGENTS.md`, 'x\n')
    const done = r.run('collect_targets', [r.root])
    assert.deepEqual(names(done.stdout), ['CLAUDE.md'])
  })

  test('출력은 정렬하고 줄 수와 합계를 센다', () => {
    const r = new Repo()
    r.file('b/AGENTS.md', 'a\nb\nc\n')
    r.file('a/AGENTS.md', '한\n')
    r.file('CLAUDE.md', '')
    const done = r.run('collect_targets', [r.root])
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `감사 대상\n  ${'CLAUDE.md'.padEnd(60)}     0\n  ${'a/AGENTS.md'.padEnd(60)}     1\n  ${'b/AGENTS.md'.padEnd(60)}     3\n\n합계: 3개 파일, 4줄\n`)
  })

  test('줄 수는 CR 과 유니코드 줄바꿈도 줄로 센다', () => {
    const r = new Repo()
    r.file('CLAUDE.md', 'a\rb\r\nc d\x85e\n')
    assert.ok(r.run('collect_targets', [r.root]).stdout.includes('합계: 1개 파일, 5줄'))
  })

  test('디렉터리 링크는 내려가지 않고 같은 파일을 가리키는 링크는 한 번만 센다', () => {
    const r = new Repo()
    r.file('real/AGENTS.md', 'x\n')
    r.link('linkdir', 'real')
    r.link('sub/AGENTS.md', '../real/AGENTS.md')
    const done = r.run('collect_targets', [r.root])
    assert.deepEqual(names(done.stdout), ['real/AGENTS.md'])
  })

  test('순환 심볼릭 링크는 파일로 보고 순회를 계속한다', () => {
    const r = new Repo()
    r.file('CLAUDE.md', 'x\n')
    r.link('loop', 'loop')
    r.link('sub/a', 'b')
    r.link('sub/b', 'a')
    r.link('skills/loop', 'loop')
    r.file('skills/ok/SKILL.md', 'x\n')
    const done = r.run('collect_targets', [r.root])
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(names(done.stdout), ['CLAUDE.md', 'skills/ok/SKILL.md'])
    assert.equal(r.run('collect_targets', [r.root, '--scope', 'sub']).code, 2)
  })

  test('저장소 밖을 가리키는 링크는 대상 아님으로 낸다', () => {
    const r = new Repo()
    const outside = tempDir('hc-out-')
    r.file('CLAUDE.md', 'x\n')
    r.link('a/AGENTS.md', join(outside, 'AGENTS.md'))
    const done = r.run('collect_targets', [r.root])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.includes('  a/AGENTS.md  (외부 symlink, 대상 아님)\n'), done.stdout)
    assert.ok(done.stdout.includes('합계: 1개 파일, 1줄\n외부 symlink: 1개\n'), done.stdout)
  })
})

describe('범위와 인자', () => {
  test('스크립트만 있는 범위는 개수를 알리고 2 로 끝난다', () => {
    const r = new Repo()
    r.file('.claude/scripts/a.py')
    r.file('.claude/scripts/b.sh')
    r.file('.claude/scripts/c.bash')
    r.file('.claude/scripts/d.zsh')
    r.file('.claude/scripts/e.ts')
    r.file('.claude/scripts/node_modules/f.py')
    const done = r.run('collect_targets', [r.root, '--scope', '.claude/scripts'])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('Markdown 대상은 없고 스크립트 4개가 있다.\n'), done.stderr)
    assert.ok(done.stderr.includes('references/script-audit.md'))
    assert.ok(!done.stderr.includes('저장소 루트를 확인한다'))
    assert.ok(done.stdout.includes('감사 대상 (범위: .claude/scripts)\n'))
    assert.ok(done.stdout.includes('합계: 0개 파일, 0줄'))
  })

  test('스크립트 파일 하나를 범위로 주면 하나로 센다', () => {
    const r = new Repo()
    r.file('x.py')
    const done = r.run('collect_targets', [r.root, '--scope', 'x.py'])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('스크립트 1개'))
  })

  test('범위에 아무것도 없으면 저장소 루트 안내와 2', () => {
    const r = new Repo()
    mkdirSync(join(r.root, 'empty'))
    const done = r.run('collect_targets', [r.root, '--scope', 'empty'])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('대상 파일을 찾지 못했다. 저장소 루트를 확인한다.'))
  })

  test('범위가 없거나 저장소 밖이면 2 와 이유', () => {
    const r = new Repo()
    r.file('CLAUDE.md', 'x\n')
    const missing = r.run('collect_targets', [r.root, '--scope', 'nope'])
    assert.equal(missing.code, 2)
    assert.equal(missing.stderr, '범위 경로가 없다: nope\n')
    const outside = r.run('collect_targets', [r.root, '--scope', '..'])
    assert.equal(outside.code, 2)
    assert.equal(outside.stderr, '범위가 저장소 밖을 가리킨다: ..\n')
    const noValue = r.run('collect_targets', [r.root, '--scope'])
    assert.equal(noValue.code, 2)
    assert.equal(noValue.stderr, '--scope 에 경로가 없다\n')
  })

  test('--scope=값 꼴과 절대 경로 범위를 받는다', () => {
    const r = new Repo()
    r.file('a/AGENTS.md', 'x\n')
    r.file('b/AGENTS.md', 'x\n')
    const eq = r.run('collect_targets', [r.root, '--scope=a'])
    assert.deepEqual(names(eq.stdout), ['a/AGENTS.md'])
    assert.ok(eq.stdout.startsWith('감사 대상 (범위: a)\n'))
    const abs = r.run('collect_targets', [r.root, '--scope', join(r.root, 'b')])
    assert.deepEqual(names(abs.stdout), ['b/AGENTS.md'])
  })

  test('범위로 저장소 루트를 주면 범위 표기는 점이다', () => {
    const r = new Repo()
    r.file('CLAUDE.md', 'x\n')
    const done = r.run('collect_targets', [r.root, '--scope', '.'])
    assert.ok(done.stdout.startsWith('감사 대상 (범위: .)\n'), done.stdout)
  })

  test('범위가 파일 하나이면 그 파일만 대상이다', () => {
    const r = new Repo()
    r.file('a/AGENTS.md', 'x\n')
    r.file('a/notes.md', 'x\n')
    assert.deepEqual(names(r.run('collect_targets', [r.root, '--scope', 'a/AGENTS.md']).stdout), ['a/AGENTS.md'])
    assert.equal(r.run('collect_targets', [r.root, '--scope', 'a/notes.md']).code, 2)
  })

  test('범위 안의 링크로 저장소 밖 경로를 우회한 범위는 거부한다', () => {
    const r = new Repo()
    const outside = tempDir('hc-out-')
    r.link('esc', outside)
    const done = r.run('collect_targets', [r.root, '--scope', 'esc'])
    assert.equal(done.code, 2)
    assert.equal(done.stderr, '범위가 저장소 밖을 가리킨다: esc\n')
  })

  test('범위의 .. 는 링크를 따라간 뒤 처리한다', () => {
    const r = new Repo()
    r.file('real/inner/AGENTS.md', 'x\n')
    r.file('AGENTS.md', 'x\n')
    r.link('ln', 'real/inner')
    // ln/.. 는 링크 대상(real/inner)의 부모인 real 이다
    const done = r.run('collect_targets', [r.root, '--scope', 'ln/..'])
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(names(done.stdout), ['real/inner/AGENTS.md'])
    assert.ok(done.stdout.startsWith('감사 대상 (범위: real)\n'))
  })

  test('저장소 경로가 디렉터리가 아니면 2', () => {
    const r = new Repo()
    const done = r.run('collect_targets', [join(r.root, 'nope')])
    assert.equal(done.code, 2)
    assert.equal(done.stderr, `대상 저장소를 찾을 수 없다: ${join(r.root, 'nope')}\n`)
  })

  test('저장소 경로를 생략하면 현재 폴더이고 링크 경로는 실체로 푼다', () => {
    const r = new Repo()
    r.file('CLAUDE.md', 'x\n')
    const done = r.run('collect_targets', [])
    assert.equal(done.code, 0)
    assert.deepEqual(names(done.stdout), ['CLAUDE.md'])
    const other = new Repo('hc-link-')
    other.link('here', r.root)
    assert.deepEqual(names(run('collect_targets', [join(other.root, 'here')]).stdout), ['CLAUDE.md'])
  })

  test('Markdown 이 있으면 0 이다', () => {
    const r = new Repo()
    r.file('CLAUDE.md', '# 지침\n')
    const done = r.run('collect_targets', [r.root])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes('CLAUDE.md'))
  })
})

describe('git 추적 없는 스킬 폴더 경고', () => {
  function stray(): Repo {
    const r = new Repo('hc-stray-', true)
    r.file('plugins/p/skills/live/SKILL.md', '---\nname: live\n---\n')
    r.commitAll('init')
    return r
  }

  test('SKILL.md 도 추적 파일도 없는 폴더는 경고하고 종료 코드는 그대로다', () => {
    const r = stray()
    r.file('plugins/p/skills/old/__pycache__/x.pyc')
    const done = r.run('collect_targets', [r.root])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stderr, '경고: git 이 추적하지 않는 스킬 폴더가 있다 (SKILL.md 없음): plugins/p/skills/old\n')
  })

  test('추적하는 폴더는 경고하지 않는다', () => {
    const r = stray()
    assert.equal(r.run('collect_targets', [r.root]).stderr, '')
    r.file('plugins/p/skills/_shared/notes.txt', 'x')
    r.git('add', '.')
    assert.equal(r.run('collect_targets', [r.root]).stderr, '')
  })

  test('git 이 없으면 경고를 건너뛴다', () => {
    const r = stray()
    r.file('plugins/p/skills/old/x', '')
    const empty = tempDir('hc-nopath-')
    const done = r.run('collect_targets', [r.root], { env: { ...gitEnv(), PATH: empty } })
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stderr, '')
  })

  test('범위가 스킬 하나이면 형제 폴더를 경고하지 않는다', () => {
    const r = stray()
    mkdirSync(join(r.root, 'plugins/p/skills/old'), { recursive: true })
    const one = r.run('collect_targets', [r.root, '--scope', 'plugins/p/skills/live'])
    assert.equal(one.code, 0, one.stderr)
    assert.ok(!one.stderr.includes('plugins/p/skills/old'))
    assert.ok(r.run('collect_targets', [r.root, '--scope', 'plugins/p/skills']).stderr.includes('plugins/p/skills/old'))
  })

  test('git 저장소가 아니면 경고하지 않는다', () => {
    const plain = new Repo('hc-plain-')
    plain.file('skills/old/x', '')
    plain.file('CLAUDE.md', '# 지침\n')
    const done = plain.run('collect_targets', [plain.root])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(!done.stderr.includes('경고'))
  })

  test('최상위 skills 폴더도 본다', () => {
    const r = new Repo('hc-top-', true)
    r.file('skills/live/SKILL.md', '---\nname: live\n---\n')
    r.commitAll('init')
    r.file('skills/ghost/.omc/state', '')
    assert.ok(r.run('collect_targets', [r.root]).stderr.includes('skills/ghost'))
  })
})
