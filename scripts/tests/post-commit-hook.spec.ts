// githooks/post-commit 의 명령 경계 테스트.
// 커밋 훅이 팀 저장소와의 어긋남을 전부 내면 이번 변경이 가려진다. 이번 커밋이 건드린 스킬의 어긋남만 자세히 내고
// 나머지는 개수로만 낸다. 내보내기 명령은 어긋남 줄을 고정 출력하는 가짜로 바꿔 훅의 분류만 본다.

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { runCommand } from '../../modules/testkit/command.ts'
import { git, gitEnv } from '../../modules/testkit/git.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { copyFromRepo, REPO_ROOT } from './boundary.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const HOOK = join(REPO_ROOT, 'githooks/post-commit')
const SYNC = 'scripts/export-to-team.ts'
// 내보내기 명령의 가짜. 공용 스킬 목록과 출력 줄, 종료 코드를 받는다
function fakeSync(skills: string[], lines: string[], code: number): string {
  return `export const SHARED_SKILLS = [${skills.map((s) => `'${s}'`).join(', ')}]\nexport const SHARED_TOOLS = []\nprocess.stdout.write(${JSON.stringify(lines.map((line) => `${line}\n`).join(''))})\nprocess.exitCode = ${code}\n`
}
// 설치 명령과 훅 파일
const INSTALL = ['node', 'scripts/install-hooks.ts']
const HOOK_FILES = ['scripts/install-hooks.ts', 'scripts/skill_paths.ts', 'scripts/export-lists.ts', 'modules/kit/py.ts', 'githooks/post-commit', 'githooks/post-commit.ts']
// ──

const DRIFT = [
  '원본: HEAD (abc)',
  '팀 저장소의 사본이 원본과 어긋난다:',
  '  다름   skills/alpha/SKILL.md',
  '  없음   skills/beta/scripts/x.py',
  '  다름   skills/beta/SKILL.md',
  '  다름   tools/browser-driver/README.md',
  '',
  '팀 저장소: /nowhere',
]

let repo = ''

function setSync(lines: string[], code = 1): void {
  const path = join(repo, SYNC)
  writeFileSync(path, fakeSync(['alpha', 'beta'], lines, code))
  chmodSync(path, 0o755)
}

function commitTouching(...dirs: string[]): void {
  for (const dir of dirs) {
    mkdirSync(join(repo, dir), { recursive: true })
    writeFileSync(join(repo, dir, 'f.txt'), dir)
  }
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'c', '--no-verify'])
}

function runHook() {
  return runCommand([HOOK], { cwd: repo, env: gitEnv() })
}

describe('post-commit 훅', () => {
  beforeEach(() => {
    repo = tempDir('post-commit-')
    mkdirSync(join(repo, 'scripts'))
    setSync(DRIFT)
    git(repo, ['init', '-q'])
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'init', '--no-verify'])
  })

  test('이번 커밋이 건드린 스킬만 자세히 내고 나머지는 개수로 낸다', () => {
    commitTouching('alpha')
    const done = runHook()
    assert.equal(done.code, 0)
    assert.equal(
      done.stdout,
      [
        '',
        '── 이번 커밋이 건드린 공용 스킬이 팀 저장소와 어긋난다.',
        '원본: HEAD (abc)',
        '  다름   skills/alpha/SKILL.md',
        `반영: ${SYNC} --source-ref HEAD --apply`,
        `다른 스킬의 어긋난 파일 3개 (이번 커밋과 무관). 전체는 ${SYNC} 로 본다.`,
        '──',
        '',
      ].join('\n'),
    )
  })

  test('두 원본 루트 아래 스킬을 알아본다', () => {
    commitTouching('skills/alpha', 'export-only-skills/beta')
    const out = runHook().stdout
    assert.ok(out.includes('skills/alpha/SKILL.md'))
    assert.ok(out.includes('skills/beta/scripts/x.py'))
    assert.ok(out.includes('다른 스킬의 어긋난 파일 1개'))
  })

  test('건드린 스킬 둘을 모두 낸다', () => {
    commitTouching('alpha', 'beta')
    const out = runHook().stdout
    assert.ok(out.includes('skills/alpha/SKILL.md'))
    assert.ok(out.includes('skills/beta/scripts/x.py'))
    assert.ok(out.includes('다른 스킬의 어긋난 파일 1개'))
  })

  test('공용 스킬을 건드리지 않은 커밋은 조용하다', () => {
    commitTouching('unrelated')
    const done = runHook()
    assert.equal(done.stdout, '')
    assert.equal(done.code, 0)
  })

  test('건드린 스킬에 어긋남이 없으면 같다고 하고 나머지 개수만 낸다', () => {
    setSync(DRIFT.map((line) => line.replace('skills/alpha/', 'skills/gamma/')))
    commitTouching('alpha')
    const out = runHook().stdout
    assert.ok(out.includes('── 이번 커밋이 건드린 공용 스킬은 팀 저장소와 같다.\n'))
    assert.ok(!out.includes('skills/alpha/'))
    assert.ok(out.includes('다른 스킬의 어긋난 파일 4개'))
  })

  test('내보내기 명령이 0 으로 끝나면 조용하다', () => {
    setSync(['원본: HEAD (abc)', '팀 저장소의 사본이 원본과 같다.'], 0)
    commitTouching('alpha')
    assert.equal(runHook().stdout, '')
  })

  test('다른 스킬의 어긋남이 없으면 개수 줄을 내지 않는다', () => {
    setSync(DRIFT.slice(0, 3))
    commitTouching('alpha')
    const out = runHook().stdout
    assert.ok(out.includes('  다름   skills/alpha/SKILL.md\n'))
    assert.ok(!out.includes('다른 스킬의 어긋난 파일'))
  })
})

describe('설치한 post-commit 훅', () => {
  test('install-hooks 로 건 훅이 git commit 때 돌아 어긋남을 알린다. 워크트리의 커밋도 같다', (t) => {
    repo = join(tempDir('post-commit-installed-', t), 'main')
    copyFromRepo(repo, HOOK_FILES)
    setSync(DRIFT)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'init'])
    const installed = runCommand(INSTALL, { cwd: repo, env: gitEnv() })
    assert.equal(installed.code, 0, installed.stderr)

    mkdirSync(join(repo, 'alpha'))
    writeFileSync(join(repo, 'alpha', 'f.txt'), 'a')
    git(repo, ['add', '-A'])
    const done = runCommand(['git', 'commit', '-q', '-m', 'alpha'], { cwd: repo, env: gitEnv() })
    assert.equal(done.code, 0, done.stderr)
    assert.ok((done.stdout + done.stderr).includes('  다름   skills/alpha/SKILL.md\n'), done.stdout + done.stderr)

    const worktree = join(repo, '..', 'wt')
    git(repo, ['worktree', 'add', '-q', worktree])
    mkdirSync(join(worktree, 'beta'))
    writeFileSync(join(worktree, 'beta', 'f.txt'), 'b')
    git(worktree, ['add', '-A'])
    const inWorktree = runCommand(['git', 'commit', '-q', '-m', 'beta'], { cwd: worktree, env: gitEnv() })
    assert.equal(inWorktree.code, 0, inWorktree.stderr)
    assert.ok((inWorktree.stdout + inWorktree.stderr).includes('  없음   skills/beta/scripts/x.py\n'), inWorktree.stdout + inWorktree.stderr)
  })
})
