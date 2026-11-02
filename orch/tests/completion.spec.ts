// lib/completion.ts 의 classify 를 본다. 부모 Dispatch ID 를 복사한 하위 세션의 완료를 PR 준비 보고와 구별한다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { classify, isoTime } from '../scripts/lib/completion.ts'

type Json = Record<string, unknown>

const SHA = 'a'.repeat(40)

function message(kind: string, second = 1, changes: Json = {}): Json {
  return {
    id: `m${second}`,
    type: kind,
    from_handle: 'term_parent',
    created_at: `2026-10-23T00:00:${String(second).padStart(2, '0')}Z`,
    task_id: 'task_a',
    dispatch_id: 'ctx_a',
    subject: '준비 보고',
    body: '',
    payload: { outcome: 'succeeded' },
    ...changes,
  }
}

function ready(changes: Json = {}): Json {
  return message('status', 1, { subject: `준비됨 #123, head ${SHA}`, ...changes })
}

describe('classify', () => {
  test('준비 상태 없이 온 하위 세션의 완료는 의심스럽고 원본은 바뀌지 않는다', () => {
    const done = message('worker_done', 2, { subject: '검토 완료' })
    const result = classify([done])[0]
    assert.equal(result.type, 'suspicious_worker_done')
    assert.equal(result.originalType, 'worker_done')
    assert.equal(done.type, 'worker_done')
  })

  test('같은 Task, Dispatch, 발신자의 앞선 준비 상태는 근거다', () => {
    const result = classify([message('worker_done', 2)], [ready()])[0]
    assert.equal(result.type, 'worker_done')
    assert.deepEqual(result.completionVerification, { status: 'ready', pr: 123, head: SHA, statusMessageId: 'm1' })
  })

  test('줄은 \\n 에서만 나눈다. 옛 명령처럼 \\r 이나 \\u2028 앞의 준비됨 줄은 근거가 아니다', () => {
    for (const subject of [`준비됨 #123, head ${SHA}\r`, `준비됨 #123, head ${SHA}\u2028설명`, `설명\r준비됨 #123, head ${SHA}`]) {
      const result = classify([message('worker_done', 2)], [ready({ subject })])[0]
      assert.equal(result.type, 'suspicious_worker_done', JSON.stringify(subject))
    }
    const body = classify([message('worker_done', 2)], [ready({ subject: '보고', body: `설명\n준비됨 #123, head ${SHA}\n끝` })])[0]
    assert.equal(body.type, 'worker_done')
  })

  test('SHA 뒤에 같은 줄로 붙인 설명도 근거다', () => {
    for (const subject of [
      `준비됨 #626, head ${SHA} (claude-review P3 1건 반영 안 함)`,
      `준비됨 #626, head ${SHA}. 리뷰 반영`,
      `준비됨 #626, head ${SHA}, CI 통과`,
      `준비됨 #626, head ${SHA}; 설명`,
      `준비됨 #626, head ${SHA}: 설명`,
      `준비됨 #626, head ${SHA}\t설명`,
      `준비됨 #626, head ${SHA}(설명)`,
    ]) {
      const result = classify([message('worker_done', 2)], [ready({ subject })])[0]
      assert.equal(result.type, 'worker_done', JSON.stringify(subject))
      assert.deepEqual(result.completionVerification, { status: 'ready', pr: 626, head: SHA, statusMessageId: 'm1' })
    }
  })

  test('SHA 가 40자리보다 길거나 SHA 뒤에 다른 글자가 바로 붙으면 근거가 아니다', () => {
    for (const subject of [`준비됨 #123, head ${SHA}b`, `준비됨 #123, head ${SHA}설명`, `준비됨 #123, head ${SHA}-설명`]) {
      assert.equal(classify([message('worker_done', 2)], [ready({ subject })])[0].type, 'suspicious_worker_done', subject)
    }
  })

  test('다른 Task, 발신자, 나중 상태, 짧은 해시, 줄 중간의 준비됨, 깨진 시각은 근거가 아니다', () => {
    const candidates = [
      ready({ task_id: 'task_old' }),
      ready({ from_handle: 'term_other' }),
      message('status', 3, { subject: `준비됨 #123, head ${SHA}` }),
      ready({ subject: '준비됨 #123, head abc1234' }),
      ready({ subject: `아직 준비됨 #123, head ${SHA}` }),
      ready({ created_at: 'bad' }),
    ]
    for (const candidate of candidates) {
      assert.equal(classify([message('worker_done', 2)], [candidate])[0].type, 'suspicious_worker_done', JSON.stringify(candidate))
    }
  })

  test('payload 의 id 와 camelCase 키를 읽는다', () => {
    const status = ready({ task_id: null, dispatch_id: null, payload: '{"taskId":"task_a","dispatchId":"ctx_a"}' })
    assert.equal(classify([status, message('worker_done', 2)])[1].type, 'worker_done')
  })

  test('Dispatch 가 없는 완료는 믿지 않는다', () => {
    assert.equal(classify([ready(), message('worker_done', 2, { dispatch_id: null })])[1].type, 'suspicious_worker_done')
  })

  test('실패 보고는 PR 준비를 요구하지 않는다', () => {
    const result = classify([message('worker_done', 1, { payload: { outcome: 'failed' } })])[0]
    assert.deepEqual(result.completionVerification, { status: 'failure_report' })
    assert.equal(result.type, 'worker_done')
  })

  test('대기가 붙인 근거는 이력 없이 파일을 다시 분류해도 남는다', () => {
    const checked = classify([message('worker_done', 2)], [ready()])
    assert.deepEqual(classify(checked), checked)
  })

  test('시각 없는 이력은 근거가 아니지만 같은 묶음에서 먼저 온 상태는 근거다', () => {
    const status = ready({ created_at: null })
    const done = message('worker_done', 2, { created_at: null })
    assert.equal(classify([done], [status])[0].type, 'suspicious_worker_done')
    assert.equal(classify([status, done])[1].type, 'worker_done')
  })

  test('시간대가 다른 시각도 같은 순간으로 비교한다', () => {
    // 09:00:00+09:00 은 00:00:00Z 다. 문자열로 비교하면 완료(00:00:02Z)보다 늦어 보인다
    const status = ready({ created_at: '2026-10-23T09:00:00+09:00' })
    assert.equal(classify([message('worker_done', 2)], [status])[0].type, 'worker_done')
  })
})

describe('isoTime', () => {
  test('시간대가 없으면 UTC 로 읽는다', () => {
    assert.equal(isoTime('2026-10-23T00:00:00'), Date.UTC(2026, 9, 23))
    assert.equal(isoTime('2026-10-23 00:00:00.5'), Date.UTC(2026, 9, 23, 0, 0, 0, 500))
    assert.equal(isoTime('2026-10-23'), Date.UTC(2026, 9, 23))
    assert.equal(isoTime('2026-10-23T09:00:00+0900'), Date.UTC(2026, 9, 23))
  })

  test('ISO 꼴이 아니거나 문자열이 아니면 null', () => {
    for (const value of ['bad', '', '2026-13-40T99:00:00Z', null, 12]) assert.equal(isoTime(value), null, String(value))
  })
})

test('같은 Task 의 앞선 dispatch 준비 상태는 재시작한 발신자의 근거다', () => {
  const prior = ready({ dispatch_id: 'ctx_old', from_handle: 'term_old' })
  assert.equal(classify([message('worker_done', 2)], [prior])[0].type, 'worker_done')
  assert.equal(classify([message('worker_done', 2)], [ready({ from_handle: 'term_other' })])[0].type, 'suspicious_worker_done')
})

test('최신순 이력에서도 현재 dispatch 의 최신 PR 준비 상태를 우선한다', () => {
  const old = ready({ dispatch_id: 'old', from_handle: 'term_old' })
  const current = message('status', 2, { id: 'current', subject: `준비됨 #456, head ${SHA}` })
  const other = message('status', 3, { dispatch_id: 'another', from_handle: 'term_another', subject: `준비됨 #789, head ${SHA}` })
  const done = message('worker_done', 4)
  for (const history of [[other, current, old], [old, current, other]]) {
    assert.equal((classify([done], history)[0].completionVerification as Record<string, unknown>).pr, 456)
    assert.equal((classify([done], history.filter((m) => m !== current))[0].completionVerification as Record<string, unknown>).pr, 789)
  }
  const latest = message('status', 3, { subject: `준비됨 #999, head ${SHA}` })
  assert.equal((classify([done], [latest, current, old])[0].completionVerification as Record<string, unknown>).pr, 999)
})

test('다른 dispatch 의 미래 준비 상태와 다른 Task 의 준비 상태는 거부한다', () => {
  for (const candidate of [
    message('status', 3, { dispatch_id: 'later', from_handle: 'term_later', subject: `준비됨 #456, head ${SHA}` }),
    ready({ task_id: 'other-task', dispatch_id: 'other', from_handle: 'term_other' }),
  ]) {
    assert.equal(classify([message('worker_done', 2)], [candidate])[0].type, 'suspicious_worker_done')
  }
})
