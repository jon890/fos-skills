// review-fix 의 gh_host 명령 경계 테스트. 가짜 gh, ssh 와 임시 저장소의 origin 으로 호스트 결정을 본다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setup } from './helpers.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['python3', join(import.meta.dirname, '..', 'scripts', 'gh_host.py')]
// ──

// 사내 호스트의 토큰 확인이 timeout 나면 gh auth status 는 종료 코드 1 이다. github.com 은 정상이다
const PARTIAL_FAILURE = `github.example.com
  X Timeout trying to log in to github.example.com account dev-user (keyring)
  - Active account: true

github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
`

describe('gh_host', () => {
  test('GH_HOST 가 있으면 저장소 이름을 줘도 그것을 낸다', (t) => {
    const s = setup(t)
    for (const args of [[], ['o', 'r']]) {
      const done = s.exec(COMMAND, args, { GH_HOST: 'ghe.example.com' })
      assert.deepEqual([done.code, done.stdout], [0, 'ghe.example.com\n'])
    }
    assert.deepEqual(s.gh.calls(), [])
  })

  test('인자 없이 부르면 origin 에서 읽고 ssh -G 가 되돌린 이름을 쓴다', (t) => {
    const s = setup(t, { origin: 'git@github-personal:o/r.git' })
    const done = s.exec(COMMAND, [])
    assert.deepEqual([done.code, done.stdout], [0, 'github.com\n'])
    assert.deepEqual(s.ssh.calls().map((c) => c.argv), [['-G', 'github-personal']])
  })

  for (const [origin, host] of [
    ['https://ghe.example.com/o/r.git', 'ghe.example.com'],
    // ssh:// 주소의 사용자 부분은 떼지 않는다. 실제로는 ssh -G 가 호스트로 되돌린다
    ['ssh://git@ghe.example.com/o/r.git', 'git@ghe.example.com'],
    ['git@ghe.example.com:o/r.git', 'ghe.example.com'],
  ]) {
    test(`origin 주소 ${origin}`, (t) => {
      const s = setup(t, { origin })
      s.ssh.setRules([])
      const done = s.exec(COMMAND, [])
      assert.deepEqual([done.code, done.stdout], [0, `${host}\n`])
    })
  }

  test('origin 이 없으면 1 과 안내', (t) => {
    const s = setup(t, { origin: null })
    const done = s.exec(COMMAND, [])
    assert.deepEqual([done.code, done.stdout], [1, ''])
    assert.match(done.stderr, /origin 리모트에서 호스트를 읽지 못했다/)
  })

  for (const origin of ['https://github.com/o/r.git', 'git@github-alias:o/r.git', 'https://github.com/O/R']) {
    test(`origin 이 대상 저장소와 같으면 로그인 호스트를 조회하지 않는다: ${origin}`, (t) => {
      const s = setup(t, { origin })
      const done = s.exec(COMMAND, ['o', 'r'])
      assert.deepEqual([done.code, done.stdout], [0, 'github.com\n'])
      assert.deepEqual(s.gh.calls(), [])
    })
  }

  test('다른 저장소의 origin 호스트는 쓰지 않고 로그인 호스트를 쓴다', (t) => {
    const s = setup(t, { origin: 'git@wrong.example:other/repo.git' })
    s.gh.setRules([{ match: ['auth', 'status'], stdout: 'right.example\n  ✓ Logged in\n' }])
    const done = s.exec(COMMAND, ['o', 'r'])
    assert.deepEqual([done.code, done.stdout], [0, 'right.example\n'])
    assert.deepEqual(s.gh.calls().map((c) => c.argv), [['auth', 'status']])
  })

  test('gh auth status 가 종료 코드 1 이어도 호스트를 읽고 저장소가 있는 호스트를 고른다', (t) => {
    const s = setup(t, { origin: 'git@wrong.example:other/repo.git' })
    s.gh.setRules([
      { match: ['auth', 'status'], stderr: PARTIAL_FAILURE, code: 1 },
      { match: ['api', 'github.example.com'], code: 1 },
      { match: ['api', 'github.com'], stdout: '1\n' },
    ])
    const done = s.exec(COMMAND, ['octocat', 'sample-repo'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [0, 'github.com\n', ''])
    const argvs = s.gh.calls().map((c) => c.argv)
    assert.deepEqual(argvs[1], ['api', '--hostname', 'github.example.com', 'repos/octocat/sample-repo', '--jq', '.id'])
    assert.deepEqual(argvs[2], ['api', '--hostname', 'github.com', 'repos/octocat/sample-repo', '--jq', '.id'])
  })

  test('로그인 호스트가 없으면 경고하고 origin 으로 되돌아간다', (t) => {
    const s = setup(t, { origin: 'git@wrong.example:other/repo.git' })
    s.gh.setRules([{ match: ['auth', 'status'], code: 1 }])
    s.ssh.setRules([])
    const done = s.exec(COMMAND, ['o', 'r'])
    assert.deepEqual([done.code, done.stdout], [0, 'wrong.example\n'])
    assert.equal(done.stderr, 'gh_host: 로그인된 호스트가 없다. o/r 대신 현재 디렉터리의 origin 으로 정한다.\n')
  })

  test('어느 호스트에도 저장소가 없으면 그 이유로 경고하고 origin 으로 되돌아간다', (t) => {
    const s = setup(t, { origin: 'git@wrong.example:other/repo.git' })
    s.gh.setRules([{ match: ['auth', 'status'], stdout: 'a.example\nb.example\n' }, { match: ['api'], code: 1 }])
    s.ssh.setRules([])
    const done = s.exec(COMMAND, ['o', 'r'])
    assert.deepEqual([done.code, done.stdout], [0, 'wrong.example\n'])
    assert.equal(done.stderr, 'gh_host: 로그인된 호스트에 그 저장소가 없다. o/r 대신 현재 디렉터리의 origin 으로 정한다.\n')
  })

  test('인자 수가 틀리면 2 와 사용법', (t) => {
    const s = setup(t)
    for (const args of [['o'], ['o', 'r', 'x']]) {
      const done = s.exec(COMMAND, args)
      assert.deepEqual([done.code, done.stdout], [2, ''])
      assert.match(done.stderr, /사용법/)
    }
  })
})
