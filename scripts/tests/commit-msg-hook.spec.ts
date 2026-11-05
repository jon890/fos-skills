// githooks/commit-msg 가 금지어가 든 커밋 메시지를 커밋 전에 막는지 본다.
// 임시 저장소에 훅, 설치 명령, korean-check 를 복사하고 설치 명령으로 건 훅을 실제 `git commit` 으로 부른다.

import assert from 'node:assert/strict'
import { cpSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { runCommand } from '../../modules/testkit/command.ts'
import { gitEnv } from '../../modules/testkit/git.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { copyFromRepo, REPO_ROOT } from './boundary.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const INSTALL = ['node', 'scripts/install-hooks.ts']
const FILES = ['scripts/install-hooks.ts', 'scripts/skill_paths.ts', 'modules/kit/py.ts', 'githooks/commit-msg', 'githooks/commit-msg.ts']
// ──

const KOREAN_CHECK = 'export-only-skills/korean-check'
let repo = ''

function git(...args: string[]) {
  return runCommand(['git', ...args], { cwd: repo, env: gitEnv() })
}

function commit(message: string) {
  writeFileSync(join(repo, 'f.txt'), message)
  git('add', 'f.txt')
  const file = join(repo, '.git', 'MSG')
  writeFileSync(file, message)
  return git('commit', '-q', '-F', file)
}

function commits(): number {
  return Number(git('rev-list', '--count', '--all').stdout.trim() || 0)
}

describe('commit-msg 훅', () => {
  beforeEach(() => {
    repo = tempDir('commit-msg-')
    copyFromRepo(repo, FILES)
    for (const dir of ['scripts', 'references']) {
      cpSync(join(REPO_ROOT, KOREAN_CHECK, dir), join(repo, KOREAN_CHECK, dir), { recursive: true, filter: (src) => !src.includes('__pycache__') })
    }
    git('init', '-q')
    const installed = runCommand(INSTALL, { cwd: repo, env: gitEnv() })
    assert.equal(installed.code, 0, installed.stderr)
    assert.match(installed.stdout, /commit-msg/)
  })

  test('금지어가 있으면 커밋을 막고 이유를 낸다', () => {
    const done = commit('feat: 매트릭스를 고친다\n')
    assert.notEqual(done.code, 0)
    assert.match(done.stderr, /매트릭스/)
    assert.match(done.stderr, /커밋 메시지에 금지어가 있어 커밋하지 않았다/)
    assert.equal(commits(), 0)
  })

  test('보고 줄의 임시 파일 경로는 「커밋 메시지」 로 바꿔 낸다', () => {
    const done = commit('feat: 매트릭스를 고친다\n')
    assert.ok(!done.stderr.includes('COMMIT_EDITMSG.md'), done.stderr)
    assert.match(done.stderr, /커밋 메시지/)
  })

  test('깨끗한 메시지는 커밋한다', () => {
    const done = commit('feat: 영향 표를 고친다\n\n본문도 평범하다.\n')
    assert.equal(done.code, 0, done.stderr)
    assert.equal(commits(), 1)
  })

  test('잘라내기 줄 아래 diff 는 보지 않는다', () => {
    const done = commit('feat: 영향 표를 고친다\n\n# ------------------------ >8 ------------------------\n+매트릭스 는 diff 다\n')
    assert.equal(done.code, 0, done.stderr)
  })

  test('파일로 준 메시지의 주석 줄은 커밋에 남으므로 검사한다', () => {
    assert.notEqual(commit('feat: 영향 표를 고친다\n\n# 매트릭스\n').code, 0)
  })

  test('검사기가 없으면 막지 않는다', () => {
    rmSync(join(repo, KOREAN_CHECK), { recursive: true })
    const done = commit('feat: 매트릭스를 고친다\n')
    assert.equal(done.code, 0, done.stderr)
  })
})
