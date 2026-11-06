// review-fix 의 checkout_pr 명령 경계 테스트. 임시 저장소와 가짜 gh 로 브랜치 정렬을 본다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { git, setup } from './helpers.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['python3', join(import.meta.dirname, '..', 'scripts', 'checkout_pr.py')]
// ──

function repoWithCommit(t: Parameters<typeof setup>[0]) {
  const s = setup(t)
  writeFileSync(join(s.repo, 'a.txt'), 'a')
  git(s.repo, ['add', '.'], s.env)
  git(s.repo, ['commit', '-q', '-m', 'init'], s.env)
  return s
}

const VIEW = ['pr', 'view', '7', '--json', 'headRefName', '--jq', '.headRefName']

describe('checkout_pr', () => {
  test('이미 head 브랜치면 체크아웃하지 않고 이름을 낸다', (t) => {
    const s = repoWithCommit(t)
    s.gh.setRules([{ match: ['view'], stdout: 'main\n' }])
    const done = s.exec(COMMAND, ['7'])
    assert.deepEqual([done.code, done.stdout], [0, 'main\n'])
    assert.deepEqual(s.gh.calls().map((c) => c.argv), [VIEW])
  })

  test('다른 브랜치면 gh pr checkout 으로 맞추고 바뀐 브랜치를 낸다', (t) => {
    const s = repoWithCommit(t)
    s.gh.setRules([
      { match: ['view'], stdout: 'feat\n' },
      { match: ['checkout'], exec: ['git', 'checkout', '-q', '-b', 'feat'] },
    ])
    const done = s.exec(COMMAND, ['7'])
    assert.deepEqual([done.code, done.stdout], [0, 'feat\n'])
    assert.deepEqual(s.gh.calls().map((c) => c.argv), [VIEW, ['pr', 'checkout', '7']])
  })

  test('작업 트리가 dirty 하면 gh 를 부르지 않고 1', (t) => {
    const s = repoWithCommit(t)
    writeFileSync(join(s.repo, 'dirty.txt'), 'x')
    const done = s.exec(COMMAND, ['7'])
    assert.deepEqual([done.code, done.stdout], [1, ''])
    assert.match(done.stderr, /작업 트리가 dirty 하다/)
    assert.match(done.stderr, /\?\? dirty\.txt\n/)
    assert.equal(s.gh.calls().length, 0)
  })

  test('head 브랜치를 읽지 못하면 3 과 gh 의 stderr', (t) => {
    const s = repoWithCommit(t)
    s.gh.setRules([{ match: ['view'], stderr: 'no pull request\n', code: 1 }])
    const done = s.exec(COMMAND, ['7'])
    assert.deepEqual([done.code, done.stdout], [3, ''])
    assert.equal(done.stderr, 'PR #7 의 head 브랜치를 읽지 못했다\nno pull request\n')
  })

  test('종료 코드 0 이어도 브랜치 이름이 비면 3', (t) => {
    const s = repoWithCommit(t)
    s.gh.setRules([{ match: ['view'], stdout: '\n' }])
    const done = s.exec(COMMAND, ['7'])
    assert.deepEqual([done.code, done.stderr], [3, 'PR #7 의 head 브랜치를 읽지 못했다\n'])
  })

  test('체크아웃이 실패하면 3 과 gh 의 stderr', (t) => {
    const s = repoWithCommit(t)
    s.gh.setRules([{ match: ['view'], stdout: 'feat\n' }, { match: ['checkout'], stderr: 'conflict\n', code: 1 }])
    const done = s.exec(COMMAND, ['7'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [3, '', 'conflict\n'])
  })

  test('인자 수가 틀리면 2', (t) => {
    const s = repoWithCommit(t)
    for (const args of [[], ['7', '8']]) {
      const done = s.exec(COMMAND, args)
      assert.deepEqual([done.code, done.stdout], [2, ''])
      assert.match(done.stderr, /checkout_pr/)
    }
    assert.equal(s.gh.calls().length, 0)
  })
})
