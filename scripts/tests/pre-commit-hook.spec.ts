// githooks/pre-commit 이 스테이징된 변경 조각 형식을 실제 git commit 전에 검사하는지 본다.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { runCommand } from '../../modules/testkit/command.ts'
import { gitEnv } from '../../modules/testkit/git.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { copyFromRepo, REPO_ROOT } from './boundary.ts'

const INSTALL = ['node', 'scripts/install-hooks.ts']
const FILES = [
  'scripts/install-hooks.ts', 'scripts/is-main.ts', 'scripts/skill_paths.ts', 'scripts/skill_changes.ts',
  'modules/kit/py.ts', 'githooks/pre-commit', 'githooks/pre-commit.ts',
]
const FRAGMENT = 'skills/example/changes/update.patch.md'
let repo = ''

function git(...args: string[]) {
  return runCommand(['git', ...args], { cwd: repo, env: gitEnv() })
}

function write(path: string, content: string) {
  const full = join(repo, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return git('add', path)
}

function commit() {
  return git('commit', '-q', '-m', 'test: fragment check')
}

describe('pre-commit 훅', () => {
  beforeEach(() => {
    repo = tempDir('pre-commit-')
    copyFromRepo(repo, FILES)
    git('init', '-q')
    const installed = runCommand(INSTALL, { cwd: repo, env: gitEnv() })
    assert.equal(installed.code, 0, installed.stderr)
    assert.match(installed.stdout, /pre-commit/)
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git('add', 'base.txt')
    assert.equal(git('commit', '-q', '-m', 'init').code, 0)
  })

  test('잘못된 조각을 스테이징하면 이유를 내고 커밋을 막는다', () => {
    write(FRAGMENT, '이것은 목록 항목이 아니다\n')
    const done = commit()
    assert.equal(done.code, 1)
    assert.match(done.stderr, new RegExp(`${FRAGMENT}: 목록 항목`))
    assert.equal(git('rev-list', '--count', 'HEAD').stdout.trim(), '1')
  })

  test('맞는 조각은 커밋한다', () => {
    write(FRAGMENT, '- 형식이 맞는 조각이다\n')
    const done = commit()
    assert.equal(done.code, 0, done.stderr)
    assert.equal(git('rev-list', '--count', 'HEAD').stdout.trim(), '2')
  })

  test('변경 조각이 없으면 커밋한다', () => {
    write('plain.txt', '일반 파일\n')
    const done = commit()
    assert.equal(done.code, 0, done.stderr)
  })

  test('작업 트리 내용 대신 인덱스의 blob 을 검사한다', () => {
    write(FRAGMENT, '목록이 아닌 스테이징 내용\n')
    writeFileSync(join(repo, FRAGMENT), '- 작업 트리의 올바른 내용\n')
    const done = commit()
    assert.equal(done.code, 1)
    assert.match(done.stderr, new RegExp(`${FRAGMENT}: 목록 항목`))
  })
})
