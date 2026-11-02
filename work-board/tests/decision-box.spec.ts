// 「결정 필요」 상자에 사람이 답할 것만 남기고, Orca 자동 알림을 worker 줄의 상태로 옮기는 순수 함수를 본다.
// 스펙: docs/features/board-decision-box/spec.md. 테스트 이름 끝의 (R…) 가 그 요구사항이다.
//
// 실행: node --test work-board/tests/decision-box.spec.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoAlertKind, queryQuestions, statusLine } from '../hooks/register.js'

type Json = Record<string, unknown>

const RUN = 'r'
const ask = (id: string, type: string, at: string, extra: Json = {}): Json => ({
  id, type, run_id: RUN, to_handle: 'run:' + RUN, from_handle: 'structworker_w', thread_id: id, created_at: at,
  payload: JSON.stringify({ dispatchId: 'open' }), ...extra,
})
const stop = (id: string, at: string, reason = 'finished') => ask(id, 'escalation', at, {
  subject: 'Worker stopped without reporting', body: 'Worker structworker_w ended its turn without sending worker_done',
  payload: JSON.stringify({ dispatchId: 'open', handle: 'structworker_w', stopReason: reason }),
})
const chatError = (id: string, at: string, extra: Json = {}) => ask(id, 'escalation', at, {
  subject: 'Agent hit an error: Claude hit its session limit.',
  body: 'Worker structworker_w hit an error while running task "x".\nError: Claude hit its session limit.',
  payload: JSON.stringify({ dispatchId: 'open', handle: 'structworker_w', failureKind: 'usageLimitReached',
    error: 'Claude hit its session limit.', detail: "You've hit your 5-hour limit · resets 8:50pm (Asia/Seoul)" }),
  ...extra,
})
const answer = (thread: string) => ({ id: 'a-' + thread, type: 'status', run_id: RUN, thread_id: thread, from_handle: 'term_c', to_handle: 'dispatch:open' })

// check 는 rows, inbox 는 replies 를 내는 가짜 $ 다
function fake(rows: Json[], replies: Json[] = []) {
  return { process: { run: async (argv: string[]) => ({ exitCode: 0, stderr: '',
    stdout: JSON.stringify({ messages: argv.includes('check') ? rows : replies }) }) } }
}
const ACTIVE = [{ id: 'open', terminal: 'structworker_w' }]
const ids = (list: Json[]) => list.map((m) => m.id)

test('자동 알림은 id 접두로만 가린다 (R2)', () => {
  assert.equal(autoAlertKind({ id: 'msg_stop_1d39bda81e4601e1fd242ef9' }), 'stop')
  assert.equal(autoAlertKind({ id: 'msg_chaterr_c4fb0a4cdbd1db6875aa79b5' }), 'error')
  assert.equal(autoAlertKind({ id: 'msg_stopx' }), null)
  assert.equal(autoAlertKind({ id: 'msg_9f2c0a' }), null)
  assert.equal(autoAlertKind({}), null)
})

test('결정 필요 상자에는 worker 의 question 과 직접 보낸 escalation 만 남는다 (R1)', async () => {
  const rows = [
    stop('msg_stop_aa', '2026-11-02T10:00:00Z'),
    chatError('msg_chaterr_bb', '2026-11-02T10:01:00Z'),
    ask('msg_q1', 'question', '2026-11-02T09:00:00Z'),
    ask('msg_e1', 'escalation', '2026-11-02T09:30:00Z', { subject: '막힘: 권한 거부' }),
  ]
  const result = await queryQuestions(fake(rows), RUN, ACTIVE)
  // 같은 worker 의 질문과 막힘은 늦은 하나로 묶인다. 더 늦은 자동 알림이 그것을 가리지 않는다
  assert.deepEqual(result.questions.map((q: Json) => [q.id, q.repeats]), [['msg_e1', 1]])
  assert.deepEqual(ids(result.alerts), ['msg_stop_aa', 'msg_chaterr_bb'])
})

test('자동 알림은 결정 필요 수에 세지 않는다 (R1)', async () => {
  const only = await queryQuestions(fake([stop('msg_stop_aa', '2026-11-02T10:00:00Z'), chatError('msg_chaterr_bb', '2026-11-02T10:01:00Z')]), RUN, ACTIVE)
  assert.deepEqual(only.questions, [])
  assert.doesNotMatch(statusLine([], { questions: only.questions, errors: {} }), /결정 필요/)
  const mixed = await queryQuestions(fake([stop('msg_stop_aa', '2026-11-02T10:00:00Z'), ask('msg_q1', 'question', '2026-11-02T09:00:00Z')]), RUN, ACTIVE)
  assert.match(statusLine([], { questions: mixed.questions, errors: {} }), /결정 필요 1/)
})

test('worker 가 보낸 메시지는 자동 알림과 제목이 같아도 상자에 남는다 (R2)', async () => {
  const own = ask('msg_9f2c0a', 'escalation', '2026-11-02T10:00:00Z', { subject: 'Worker stopped without reporting' })
  const result = await queryQuestions(fake([own]), RUN, ACTIVE)
  assert.deepEqual(ids(result.questions), ['msg_9f2c0a'])
  assert.deepEqual(result.alerts, [])
})

test('직접 올린 막힘은 답장이나 worker 해제·중지로 사라지고, 그 밖에는 남는다 (R3)', async () => {
  const blocker = ask('msg_e1', 'escalation', '2026-11-02T09:30:00Z')
  // 답이 없으면 남는다. worker 가 움직였는지는 보지 않는다
  assert.deepEqual(ids((await queryQuestions(fake([blocker]), RUN, ACTIVE)).questions), ['msg_e1'])
  // 그 thread 에 답이 있으면 빠진다
  assert.deepEqual((await queryQuestions(fake([blocker], [answer('msg_e1')]), RUN, ACTIVE)).questions, [])
  // dispatch 가 살아 있지 않으면(해제·중지) 빠진다
  assert.deepEqual((await queryQuestions(fake([blocker]), RUN, [])).questions, [])
  assert.deepEqual((await queryQuestions(fake([blocker]), RUN, [{ id: 'other', terminal: 'term_o' }])).questions, [])
})

test('더 늦은 자동 알림에 답했으면 앞선 막힘도 푼 것이고, 답 없는 자동 알림은 막힘을 가리지 않는다 (R3)', async () => {
  const blocker = ask('msg_e1', 'escalation', '2026-11-02T09:30:00Z')
  const later = stop('msg_stop_aa', '2026-11-02T10:00:00Z')
  assert.deepEqual((await queryQuestions(fake([blocker, later], [answer('msg_stop_aa')]), RUN, ACTIVE)).questions, [])
  assert.deepEqual(ids((await queryQuestions(fake([blocker, later]), RUN, ACTIVE)).questions), ['msg_e1'])
  // 답한 막힘 뒤에 온 미답변 막힘은 남는다
  const again = ask('msg_e2', 'escalation', '2026-11-02T10:30:00Z')
  assert.deepEqual(ids((await queryQuestions(fake([blocker, later, again], [answer('msg_stop_aa')]), RUN, ACTIVE)).questions), ['msg_e2'])
})
