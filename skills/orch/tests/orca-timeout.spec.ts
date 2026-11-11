// 실제 대기 없이 실행 경계에서 가짜 Orca 의 stdout 과 시간 초과를 재현한다.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { orcaJson, orcaJsonOrThrow } from '../scripts/lib/orca.ts'
import { withRun, type RunResult } from '../scripts/lib/proc.ts'
import { workerRows } from '../scripts/lib/workers.ts'

const envelope = (result: unknown) => JSON.stringify({ ok: true, result })
const response = (stdout: string, timedOut = true, code = 124): RunResult => ({ stdout, stderr: '', timedOut, code })

test('시간 초과여도 온전한 성공 봉투는 result 를 반환한다', () => {
  for (const result of [{ workers: [{ dispatchId: 'd' }] }, null, false, 0]) {
    withRun(() => response(envelope(result)), () => {
      assert.deepEqual(orcaJson(['orchestration', 'worker-list']), { ok: true, data: result })
    })
  }
})

test('잘린 JSON, 실패 봉투, result 또는 명시적 성공 누락, 일반 비정상 종료는 실패다', () => {
  for (const done of [
    response('{"ok":true,"result":'),
    response(JSON.stringify({ ok: false, result: {}, error: { code: 'denied' } })),
    response('{"ok":true}'),
    response('{"result":{}}'),
    response('{"ok":1,"result":{}}'),
    response('[]'),
    response(envelope({}), false, 3),
    response(envelope({}), false, 124),
  ]) {
    withRun(() => done, () => assert.equal(orcaJson(['query']).ok, false, JSON.stringify(done)))
  }
})

test('예외형 호출은 쓰기 호출자의 엄격한 종료 코드 계약을 유지한다', () => {
  withRun(() => response(envelope({})), () => assert.throws(() => orcaJsonOrThrow(['orchestration', 'reply']), /실패/))
})

test('실패한 페이지만 같은 인자로 한 번 더 읽고 이미 읽은 행은 중복하지 않는다', () => {
  const calls: string[][] = []
  const replies = [
    response(envelope({ workers: [{ dispatchId: 'first' }], page: { nextCursor: 'next' } }), false, 0),
    response('{"ok":true,"result":'),
    response(envelope({ workers: [{ dispatchId: 'second' }] }), false, 0),
  ]
  withRun((argv) => { calls.push(argv); return replies.shift()! }, () => {
    assert.deepEqual(workerRows('run'), { ok: true, rows: [{ dispatchId: 'first' }, { dispatchId: 'second' }] })
  })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[1], calls[2])
  assert.ok(calls[1].includes('--cursor') && calls[1].includes('next'))
})

test('두 번째 시간 초과도 실패하면 멈추고 다른 종류의 실패는 다시 읽지 않는다', () => {
  for (const [done, expected] of [
    [response('{'), 2],
    [response('{', false, 3), 1],
    [response('{', false, 124), 1],
    [response('{', false, 0), 1],
    [response(JSON.stringify({ ok: false, error: 'denied' }), false, 0), 1],
  ] as const) {
    let calls = 0
    withRun(() => { calls++; return done }, () => assert.equal(workerRows(null).ok, false))
    assert.equal(calls, expected)
  }
})

test('온전한 성공 응답 뒤 시간 초과는 재조회하지 않는다', () => {
  let calls = 0
  withRun(() => { calls++; return response(envelope({ workers: [{ dispatchId: 'd' }] })) }, () => {
    assert.deepEqual(workerRows(null), { ok: true, rows: [{ dispatchId: 'd' }] })
  })
  assert.equal(calls, 1)
})
