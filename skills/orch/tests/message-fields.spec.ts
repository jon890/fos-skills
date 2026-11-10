// Orca 명령마다 다른 메시지 필드 이름을 한 곳에서 읽는지 확인한다.
// 가짜 메시지 꼴는 2026-11-10 실측이다. `inbox --json`(줄인 보기)은 from, to 만 있고 created_at, thread_id, sequence 가 없다.
// `check --json` 과 `inbox --full --json` 은 from_handle, to_handle, thread_id, created_at, sequence 가 있다.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classify } from '../scripts/core/completion.ts'
import { unanswered } from '../scripts/core/questions.ts'
import { payloadOf, recipientOf, senderOf, subjectOf, threadOf } from '../scripts/core/message-fields.ts'

const status = (rows: Record<string, unknown>[], i = 0) => (rows[i].completionVerification as { status?: string } | undefined)?.status
const SHA = 'a'.repeat(40)
const payload = (dispatch: string) => ({ taskId: 'task', dispatchId: dispatch })

test('제목과 객체·문자열 payload 를 같은 꼴로 읽는다', () => {
  assert.equal(subjectOf({ title: 'fallback' }), 'fallback')
  assert.equal(subjectOf({ subject: 'first', title: 'second' }), 'first')
  assert.equal(subjectOf({}), '')
  for (const value of [{ id: 'a' }, '{"id":"a"}']) assert.deepEqual(payloadOf({ payload: value }), { id: 'a' })
  for (const value of ['{', null, [], '[]', 1, undefined]) assert.deepEqual(payloadOf({ payload: value }), {})
})

test('from_handle, fromHandle, from 을 모두 보낸 쪽으로 읽는다', () => {
  assert.equal(senderOf({ from_handle: 'a' }), 'a')
  assert.equal(senderOf({ fromHandle: 'b' }), 'b')
  assert.equal(senderOf({ from: 'c' }), 'c')
  assert.equal(recipientOf({ to: 'run:R' }), 'run:R')
  assert.equal(recipientOf({ to_handle: 'x' }), 'x')
  assert.equal(threadOf({ threadId: 't' }), 't')
  assert.equal(senderOf({}), '')
})

test('줄인 보기(from 만 있음)의 준비 상태와 완료도 같은 발신자로 맞춘다', () => {
  const ready = { id: 's', type: 'status', from: 'w', to: 'run:R', subject: `준비됨 #7, head ${SHA}`, payload: payload('d') }
  const done = { id: 'd', type: 'worker_done', from: 'w', to: 'run:R', payload: payload('d') }
  // 줄인 보기에는 시각이 없어 같은 묶음에서 앞선 status 만 근거가 된다
  assert.equal(status(classify([ready, done], [ready]), 1), 'ready')
})

test('리뷰 결과 status 와 worker_done 이 같은 초에 와도 sequence 가 앞서면 근거로 센다', () => {
  const at = '2026-11-10T02:56:16Z'
  const verdict = { id: 'v', type: 'status', from_handle: 'w', created_at: at, sequence: 10, subject: '리뷰 결과', body: '판정: 머지 가능', payload: payload('d') }
  const done = { id: 'd', type: 'worker_done', from_handle: 'w', created_at: at, sequence: 11, payload: payload('d') }
  assert.equal(status(classify([done], [verdict], { isReview: () => true }), 0), 'ready')
  // 순번이 반대(결과가 완료보다 늦다)면 여전히 근거가 아니다
  assert.equal(status(classify([{ ...done, sequence: 9 }], [verdict], { isReview: () => true }), 0), 'suspicious')
})

test('답이 질문 스레드에 있으면 from_handle, to_handle 로도 to 로도 미답변이 아니다', () => {
  const question = { id: 'q', run_id: 'R', type: 'question', from_handle: 'dispatch:d', to_handle: 'run:R', created_at: '2026-11-10T00:00:00Z' }
  const full = { id: 'r', run_id: 'R', type: 'status', from_handle: 'run:R', to_handle: 'dispatch:d', thread_id: 'q' }
  const brief = { id: 'r', run_id: 'R', type: 'status', from: 'run:R', to: 'dispatch:d', threadId: 'q' }
  assert.equal(unanswered([question], 'R').length, 1)
  assert.equal(unanswered([question, full], 'R').length, 0)
  assert.equal(unanswered([{ ...question, from: 'dispatch:d', to: 'run:R', from_handle: undefined, to_handle: undefined }, brief], 'R').length, 0)
})
