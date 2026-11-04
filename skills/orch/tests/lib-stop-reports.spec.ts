import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isQuietStop, stopDispatch, stopReason } from '../scripts/lib/stop-reports.ts'

// Orca 1.4.246 이 보내는 멈춤 보고의 꼴. 전체 기록(--full)의 payload 는 JSON 문자열이다
function report(reason: string, subject: string, payloadAsString = true) {
  const payload = { taskId: 'task_1', dispatchId: 'ctx_1', handle: 'term_w', stopReason: reason }
  return { id: 'msg_stop_abc', type: 'escalation', subject, payload: payloadAsString ? JSON.stringify(payload) : payload }
}

describe('stop-reports', () => {
  test('payload 의 stopReason 으로 멈춤 보고를 가린다', () => {
    assert.equal(stopReason(report('finished', 'Worker stopped without reporting')), 'finished')
    assert.equal(stopReason(report('exited', 'Worker exited without reporting', false)), 'exited')
    assert.equal(stopDispatch(report('errored', 'x')), 'ctx_1')
  })

  test('payload 가 없으면 제목, 그것도 아니면 id 접두로 가린다', () => {
    assert.equal(stopReason({ type: 'escalation', subject: 'Worker is waiting on a prompt' }), 'needs-input')
    assert.equal(stopReason({ id: 'msg_stop_x', type: 'escalation', subject: '?' }), 'unknown')
  })

  test('worker 가 보낸 escalation 과 다른 종류는 멈춤 보고가 아니다', () => {
    assert.equal(stopReason({ id: 'msg_1', type: 'escalation', subject: 'Blocked: 권한 거부', payload: '{"taskId":"t"}' }), null)
    assert.equal(stopReason({ id: 'msg_stop_x', type: 'status', subject: 'Worker stopped without reporting' }), null)
  })

  test('턴만 끝낸 보고만 quiet 다', () => {
    assert.equal(isQuietStop(report('finished', 'Worker stopped without reporting')), true)
    for (const reason of ['errored', 'needs-input', 'exited']) assert.equal(isQuietStop(report(reason, 'x')), false)
    assert.equal(isQuietStop({ type: 'question', subject: 'Worker stopped without reporting' }), false)
  })
})
