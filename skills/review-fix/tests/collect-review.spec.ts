// review-fix 의 collect_review 명령 경계 테스트. 가짜 gh 하나가 collect_review 와 그것이 띄우는 review_threads 의 호출을 함께 받는다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setup, threadsResponse, type Rule } from './helpers.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['python3', join(import.meta.dirname, '..', 'scripts', 'collect_review.py')]
// ──

const REVIEW_JQ = '[.[] | {id, body: .body[0:1000], state, author: .user.login}]'
const COMMENT_JQ = '[.[] | {id, path, line, body: .body[0:500], author: .user.login, in_reply_to_id}]'
const THREAD_LINE = '{"author":"bot","head":"x","id":"T0","line":0,"outdated":false,"path":"a.py","resolved":false}\n'

const CARRIED = JSON.stringify({
  data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, nodes: [{ id: 'T9', isResolved: true, path: 'b.py', line: 4, comments: { nodes: [{ author: { login: 'bot' }, body: '지적', url: 'u0' }, { author: { login: 'me' }, body: '다음 PR 에서 반영한다', url: 'u1' }] } }] } } } },
})

function baseRules(): Rule[] {
  return [
    { match: ['pulls/5/reviews'], stdout: 'REVIEWS\n' },
    { match: ['pulls/5/comments'], stdout: 'COMMENTS\n' },
    { match: ['view', '--comments'], stdout: 'ISSUE\n' },
    { match: ['graphql', 'num=5'], stdout: threadsResponse([false]) },
    { match: ['graphql', 'num=3'], stdout: CARRIED },
    { match: ['graphql', 'num=4'], stdout: CARRIED },
  ]
}

const H1 = '## 1. GitHub Review (요약 리뷰가 담기는 곳)\n'
const H2 = '## 2. 인라인 코드 리뷰 댓글 (diff 라인에 달림)\n'
const H3 = '## 3. 일반 PR(issue) 댓글\n'
const H4 = '## 4. 미해결 리뷰 스레드 (「회신」 단계의 대상)\n'
const PLAIN = `${H1}REVIEWS\n${H2}COMMENTS\n${H3}ISSUE\n${H4}${THREAD_LINE}`
const carriedLine = '{"author":"bot","head":"지적","id":"T9","line":4,"path":"b.py","pr":%PR%,"reply_url":"u1","resolved":true}\n'

describe('collect_review', () => {
  test('네 소스를 머리말과 함께 순서대로 내고 gh 인자를 지킨다', (t) => {
    const s = setup(t)
    s.gh.setRules(baseRules())
    const done = s.exec(COMMAND, ['o', 'r', '5'])
    assert.deepEqual([done.code, done.stdout], [0, PLAIN])
    const calls = s.gh.calls()
    assert.deepEqual(calls[0].argv, ['api', 'repos/o/r/pulls/5/reviews', '--jq', REVIEW_JQ])
    assert.deepEqual(calls[1].argv, ['api', 'repos/o/r/pulls/5/comments', '--jq', COMMENT_JQ])
    assert.deepEqual(calls[2].argv, ['pr', 'view', '5', '--repo', 'o/r', '--comments'])
    assert.deepEqual(calls[3].argv.slice(0, 2), ['api', 'graphql'])
    // origin 이 대상 저장소와 같아 호스트를 구하려고 gh 를 따로 부르지 않았다
    assert.equal(calls.length, 4)
    assert.deepEqual(calls.map((c) => c.ghHost), ['github.com', 'github.com', 'github.com', 'github.com'])
  })

  test('PR URL 은 그 호스트를 모든 호출에 준다', (t) => {
    const s = setup(t, { origin: null })
    s.gh.setRules(baseRules())
    const done = s.exec(COMMAND, ['https://ghe.example.com/o/r/pull/5'])
    assert.deepEqual([done.code, done.stdout], [0, PLAIN])
    assert.deepEqual([...new Set(s.gh.calls().map((c) => c.ghHost))], ['ghe.example.com'])
    assert.equal(s.gh.calls().length, 4)
  })

  test('HOST/OWNER/REPO 와 번호도 받는다', (t) => {
    const s = setup(t, { origin: null })
    s.gh.setRules(baseRules())
    const done = s.exec(COMMAND, ['ghe.example.com/o/r', '5'])
    assert.deepEqual([done.code, done.stdout], [0, PLAIN])
    assert.deepEqual([...new Set(s.gh.calls().map((c) => c.ghHost))], ['ghe.example.com'])
  })

  test('--carried-from 은 번호마다 다섯째 소스를 더한다', (t) => {
    const s = setup(t)
    s.gh.setRules(baseRules())
    const done = s.exec(COMMAND, ['o', 'r', '5', '--carried-from', '3', '4'])
    assert.equal(done.code, 0)
    assert.equal(
      done.stdout,
      `${PLAIN}## 5. 이전 PR #3 에서 「다음 PR」 로 회신한 스레드\n${carriedLine.replace('%PR%', '3')}## 5. 이전 PR #4 에서 「다음 PR」 로 회신한 스레드\n${carriedLine.replace('%PR%', '4')}`,
    )
  })

  test('옵션이 위치 인자 앞에 와도 되고 --carried-marker 가 머리말과 carried 에 간다', (t) => {
    const s = setup(t)
    s.gh.setRules([{ match: ['graphql', 'num=3'], stdout: CARRIED.replace('다음 PR 에서 반영한다', '후속 처리') }, ...baseRules()])
    const done = s.exec(COMMAND, ['--carried-from', '3', '--carried-marker', '후속', 'o', 'r', '5'])
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `${PLAIN}## 5. 이전 PR #3 에서 「후속」 로 회신한 스레드\n${carriedLine.replace('%PR%', '3')}`)
  })

  test('한 소스가 실패해도 나머지를 모으고 1 로 끝난다', (t) => {
    const s = setup(t)
    s.gh.setRules([{ match: ['pulls/5/reviews'], stderr: 'boom\n', code: 1 }, ...baseRules()])
    const done = s.exec(COMMAND, ['o', 'r', '5'])
    assert.equal(done.code, 1)
    assert.equal(done.stdout, `${H1}${H2}COMMENTS\n${H3}ISSUE\n${H4}${THREAD_LINE}`)
    assert.match(done.stderr, /boom/)
  })

  test('호스트를 구하지 못하면 gh 를 부르지 않고 2', (t) => {
    const s = setup(t, { origin: null })
    const done = s.exec(COMMAND, ['o', 'r', '5'])
    assert.deepEqual([done.code, done.stdout], [2, ''])
    assert.match(done.stderr, /origin 리모트에서 호스트를 읽지 못했다/)
    assert.equal(s.gh.calls().filter((c) => c.argv[0] !== 'auth').length, 0)
  })

  for (const [name, args] of [
    ['인자가 없다', []],
    ['위치 인자가 둘이다', ['o', 'r']],
    ['--carried-from 에 번호가 없다', ['o', 'r', '5', '--carried-from']],
    ['--carried-from 이 대상 PR 번호를 삼킨다', ['o', 'r', '--carried-from', '3', '5']],
    ['--carried-marker 에 값이 없다', ['o', 'r', '5', '--carried-marker']],
    ['PR URL 이 pull 경로가 아니다', ['https://github.com/o/r/issues/5']],
    ['PR URL 뒤에 인자가 더 있다', ['https://github.com/o/r/pull/5', 'x']],
  ] as [string, string[]][]) {
    test(`사용법 오류 2: ${name}`, (t) => {
      const s = setup(t)
      const done = s.exec(COMMAND, args)
      assert.deepEqual([done.code, done.stdout], [2, ''])
      assert.match(done.stderr, /collect_review/)
      assert.equal(s.gh.calls().length, 0)
    })
  }
})
