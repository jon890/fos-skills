// 훅 설치 명령(scripts/install-hooks)의 명령 경계 테스트.
// .git/hooks 는 워크트리끼리 공유하므로, 워크트리에서 불러도 원본 체크아웃의 githooks/ 를 가리켜야 한다.

import assert from 'node:assert/strict'
import { lstatSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runCommand } from '../../modules/testkit/command.ts'
import { git, gitEnv } from '../../modules/testkit/git.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { copyFromRepo } from './boundary.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['node', 'scripts/install-hooks.ts']
const FILES = ['scripts/install-hooks.ts', 'scripts/skill_paths.ts', 'modules/kit/py.ts', 'githooks/commit-msg', 'githooks/commit-msg.ts', 'githooks/post-commit', 'githooks/post-commit.ts']
// git 이 부르는 훅 이름
const HOOKS = ['commit-msg', 'post-commit']
// ──

function repo(t: { after(fn: () => void): void }): string {
  const root = join(tempDir('install-hooks-', t), 'main')
  copyFromRepo(root, FILES)
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'init'])
  return root
}

function install(cwd: string, root = cwd) {
  return runCommand([COMMAND[0], join(root, COMMAND[1])], { cwd, env: gitEnv() })
}

function assertLinked(main: string): void {
  for (const hook of HOOKS) {
    const link = join(main, '.git/hooks', hook)
    assert.ok(lstatSync(link).isSymbolicLink(), link)
    assert.equal(realpathSync(readlinkSync(link)), realpathSync(join(main, 'githooks', hook)))
  }
}

describe('install-hooks 명령', () => {
  test('githooks/ 의 훅마다 .git/hooks 에 링크를 걸고 이름을 낸다', (t) => {
    const main = repo(t)
    const done = install(main)
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, HOOKS.map((hook) => `  걸었다: ${hook}\n`).join(''))
    assertLinked(main)
  })

  test('다시 불러도 링크를 바꿔 걸고 0 이다', (t) => {
    const main = repo(t)
    assert.equal(install(main).code, 0)
    const again = install(main)
    assert.equal(again.code, 0, again.stderr)
    assertLinked(main)
  })

  test('워크트리에서 불러도 공유 hooks 에 원본 체크아웃의 훅을 건다', (t) => {
    const main = repo(t)
    const worktree = join(main, '..', 'wt')
    git(main, ['worktree', 'add', '-q', worktree])
    const done = install(worktree)
    assert.equal(done.code, 0, done.stderr)
    assertLinked(main)
  })

  test('githooks/ 가 없으면 2 다', (t) => {
    const main = repo(t)
    rmSync(join(main, 'githooks'), { recursive: true })
    const done = install(main)
    assert.equal(done.code, 2)
    assert.match(done.stderr, /githooks\/ 가 없다: /)
  })
})
