// 「결정 필요」 상자에 사람이 답할 것만 남기고, Orca 자동 알림을 worker 줄의 상태로 옮기는 순수 함수를 본다.
// 스펙: docs/features/board-decision-box/spec.md. 테스트 이름 끝의 (R…) 가 그 요구사항이다.
//
// 실행: node --test work-board/tests/decision-box.spec.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  alertNoteText, autoAlertKind, ciPassed, errorSummary, idleStepMinutes, isQuietStop, marksArgv, mergingIds, parseMarks, queryQuestions, spanText, statusLine, stepRows, workerNoneText, workerNotes,
} from '../hooks/register.js'

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

// ---- worker 줄의 멈춤과 오류 (R4, R5) ----

test('멈춤 판정은 「멈춤 N분」 이나 「멈춤 · 터미널 종료」 로, 기다리거나 판정이 없으면 글이 없다 (R4)', () => {
  const worker = { id: 'd1' }
  assert.deepEqual(workerNotes(worker, { d1: { reason: 'idle', idleMin: 45 } }, []), ['멈춤 45분'])
  assert.deepEqual(workerNotes(worker, { d1: { reason: 'idle', idleMin: 130 } }, []), ['멈춤 2시간'])
  assert.deepEqual(workerNotes(worker, { d1: { reason: 'exited', idleMin: null } }, []), ['멈춤 · 터미널 종료'])
  assert.deepEqual(workerNotes(worker, { d1: { reason: null, waiting: '질문의 답을 기다린다' } }, []), [])
  assert.deepEqual(workerNotes(worker, null, []), [])
  assert.deepEqual(workerNotes({ id: 'other' }, { d1: { reason: 'idle', idleMin: 45 } }, []), [])
  assert.deepEqual([spanText(45), spanText(130), spanText(3000)], ['45분', '2시간', '2일'])
})

test('오류는 그 뒤 워크트리가 바뀌지 않았으면 보이고, 바뀌었으면 빠진다 (R5)', () => {
  const at = Date.parse('2026-11-02T11:00:00Z')
  const failures = [{ worker: 'd1', kind: 'error', at, text: '오류: 계정 한도', reason: null }]
  const worker = { id: 'd1' }
  assert.deepEqual(workerNotes(worker, { d1: { reason: null, workedAt: at - 60_000 } }, failures), ['오류: 계정 한도'])
  assert.deepEqual(workerNotes(worker, { d1: { reason: null, workedAt: null } }, failures), ['오류: 계정 한도'])
  assert.deepEqual(workerNotes(worker, null, failures), ['오류: 계정 한도'])
  assert.deepEqual(workerNotes(worker, { d1: { reason: null, workedAt: at + 60_000 } }, failures), [])
  assert.deepEqual(workerNotes(worker, { d1: { reason: 'idle', idleMin: 60, workedAt: at - 60_000 } }, failures), ['멈춤 1시간', '오류: 계정 한도'])
  // 오류 글이 멈춤 보고 글보다 앞이고, 터미널 종료로 멈춘 worker 에는 「종료 보고」 를 붙이지 않는다
  const both = [{ worker: 'd1', kind: 'stop', at, text: '입력 대기', reason: 'needs-input' }, ...failures]
  assert.deepEqual(workerNotes(worker, null, both), ['오류: 계정 한도', '입력 대기'])
  const exited = [{ worker: 'd1', kind: 'stop', at, text: '종료 보고', reason: 'exited' }]
  assert.deepEqual(workerNotes(worker, { d1: { reason: 'exited', idleMin: null, workedAt: null } }, exited), ['멈춤 · 터미널 종료'])
  assert.deepEqual(workerNotes(worker, null, exited), ['종료 보고'])
})

test('멈춤 보고는 이유마다 worker 줄 글이 되고, 턴만 끝낸 것은 글이 없다 (R1, R5)', () => {
  assert.equal(alertNoteText(stop('msg_stop_a', 'x')), '')
  assert.equal(alertNoteText(stop('msg_stop_b', 'x', 'errored')), '오류로 멈춤')
  assert.equal(alertNoteText(stop('msg_stop_c', 'x', 'needs-input')), '입력 대기')
  assert.equal(alertNoteText(stop('msg_stop_d', 'x', 'exited')), '종료 보고')
  assert.equal(alertNoteText(chatError('msg_chaterr_e', 'x')), '오류: 계정 한도')
  assert.equal(alertNoteText(ask('msg_q', 'question', 'x')), '')
})

test('오류 요약은 분류어이고, 분류하지 못하면 오류 첫 줄이다 (R5)', () => {
  assert.equal(errorSummary(chatError('msg_chaterr_1', '2026-11-02T11:00:00Z')), '계정 한도')
  const capacity = chatError('msg_chaterr_2', '2026-11-02T11:00:00Z', {
    payload: JSON.stringify({ dispatchId: 'open', error: 'Selected model is at capacity. Please try a different model.' }) })
  assert.equal(errorSummary(capacity), '모델 용량 부족')
  const weekly = chatError('msg_chaterr_3', '2026-11-02T11:00:00Z', { payload: { error: "You've hit your weekly limit" } })
  assert.equal(errorSummary(weekly), '계정 한도')
  assert.equal(errorSummary({ id: 'msg_chaterr_4', payload: { error: 'boom\nmore' }, body: '' }), 'boom')
  assert.equal(errorSummary({ id: 'msg_chaterr_5', body: 'Worker w hit an error while running task.\nError: disk full\nmore' }), 'disk full')
  // task 제목에 든 낱말로 분류하지 않는다
  assert.equal(errorSummary({ id: 'msg_chaterr_6', body: 'Worker w hit an error while running task "overloaded usage limit reached 처리".\nError: disk full' }), 'disk full')
})

test('같은 worker 의 오류는 늦은 하나로 묶고, 답을 기다리는 worker 는 루프처럼 턴만 끝낸 멈춤 보고를 빼고 정한다 (R4, R5)', async () => {
  const rows = [
    chatError('msg_chaterr_old', '2026-11-02T10:00:00Z', { payload: { dispatchId: 'open', error: 'first' } }),
    chatError('msg_chaterr_new', '2026-11-02T11:00:00Z'),
    stop('msg_stop_aa', '2026-11-02T09:00:00Z'),
    ask('msg_q1', 'question', '2026-11-02T08:00:00Z'),
  ]
  const result = await queryQuestions(fake(rows), RUN, ACTIVE)
  assert.deepEqual(result.notes, [{ worker: 'open', kind: 'error', at: Date.parse('2026-11-02T11:00:00Z'), text: '오류: 계정 한도', reason: null }])
  // 미답변 question 하나면 그 dispatch 와 터미널이 답을 기다린다
  assert.deepEqual((await queryQuestions(fake([ask('msg_q1', 'question', '2026-11-02T08:00:00Z')]), RUN, ACTIVE)).asking.sort(), ['open', 'structworker_w'])
  // 답 없는 오류 알림만 있어도 루프처럼 답을 기다리는 것이다
  assert.deepEqual((await queryQuestions(fake([chatError('msg_chaterr_new', '2026-11-02T11:00:00Z')]), RUN, ACTIVE)).asking.sort(), ['open', 'structworker_w'])
  // 해제·중지된 worker 의 오류는 글이 없다
  assert.deepEqual((await queryQuestions(fake([chatError('msg_chaterr_x', '2026-11-02T11:00:00Z')]), RUN, [])).notes, [])
  assert.deepEqual((await queryQuestions(fake([chatError('msg_chaterr_x', '2026-11-02T11:00:00Z')]), RUN, [{ id: 'other', terminal: 'term_o' }])).notes, [])
  // 입력을 기다리는 멈춤 보고는 상자에 없고 worker 줄 글이 된다
  const waitingPrompt = await queryQuestions(fake([stop('msg_stop_np', '2026-11-02T11:00:00Z', 'needs-input')]), RUN, ACTIVE)
  assert.deepEqual(waitingPrompt.questions, [])
  assert.deepEqual(waitingPrompt.notes.map((n: Json) => n.text), ['입력 대기'])
  // 턴만 끝낸 멈춤 보고만 남으면 답을 기다리는 것이 아니다
  assert.deepEqual((await queryQuestions(fake([stop('msg_stop_aa', '2026-11-02T09:00:00Z')]), RUN, ACTIVE)).asking, [])
  // 오류로 멈춘 보고(errored)는 루프처럼 답을 기다리는 것이다
  const errored = await queryQuestions(fake([stop('msg_stop_bb', '2026-11-02T09:00:00Z', 'errored')]), RUN, ACTIVE)
  assert.deepEqual(errored.asking.sort(), ['open', 'structworker_w'])
  // 답한 질문은 기다리는 것이 아니다
  assert.deepEqual((await queryQuestions(fake([ask('msg_q1', 'question', '2026-11-02T08:00:00Z')], [answer('msg_q1')]), RUN, ACTIVE)).asking, [])
})

test('턴만 끝낸 멈춤 보고는 payload 나 제목으로 가린다', () => {
  assert.equal(isQuietStop(stop('msg_stop_a', 'x')), true)
  assert.equal(isQuietStop({ id: 'msg_stop_b', type: 'escalation', subject: 'Worker stopped without reporting' }), true)
  assert.equal(isQuietStop(stop('msg_stop_c', 'x', 'errored')), false)
  assert.equal(isQuietStop({ id: 'q', type: 'question', subject: 'Worker stopped without reporting' }), false)
})

const pr = (extra: Json) => ({ number: 1, branch: 'wt-a', pass: 2, fail: 0, pending: 0, failed: [], ...extra })

test('CI 를 통과한 PR 의 worker 만 머지를 기다린다. 판정은 루프처럼 선택 검사 실패도 실패로 본다 (R4)', () => {
  assert.equal(ciPassed(pr({})), true)
  assert.equal(ciPassed(pr({ pending: 1 })), false)
  assert.equal(ciPassed(pr({ fail: 1, failed: ['claude-review'] })), false)
  assert.equal(ciPassed(pr({ pass: 0 })), false)
  const workers = [{ id: 'd1', worktree: 'wt-a' }, { id: 'd2', worktree: 'wt-b' }]
  assert.deepEqual(mergingIds(workers, [pr({})]), ['d1'])
  assert.deepEqual(mergingIds(workers, [pr({ fail: 1 })]), [])
  assert.deepEqual(mergingIds(workers, []), [])
  assert.deepEqual(mergingIds(workers, null), [])
})

test('판정 명령의 인자와 출력 읽기 (R4)', () => {
  assert.deepEqual(marksArgv('/p/worker-marks.ts', '/repo', 'r', ['d1', 't1'], ['d2'], true), [
    'node', '--disable-warning=ExperimentalWarning', '/p/worker-marks.ts', '--repo', '/repo', '--run', 'r',
    '--asking', 'd1', '--asking', 't1', '--merging', 'd2', '--questions-unknown',
  ])
  assert.deepEqual(marksArgv('/p/w.ts', '/repo', '', [], [], false), ['node', '--disable-warning=ExperimentalWarning', '/p/w.ts', '--repo', '/repo'])
  const out = { settings: { idleMin: 30, exited: true }, workers: [{ dispatch: 'd1', reason: 'idle', idleMin: 45 }], error: null }
  assert.deepEqual(parseMarks(JSON.stringify(out)), { settings: out.settings, marks: { d1: out.workers[0] }, error: null })
  assert.throws(() => parseMarks(JSON.stringify({ result: { workers: [] } })), /형식/)
  assert.throws(() => parseMarks('not json'))
})

// ---- worker 없이 남은 단계 (R6) ----

test('doing 항목의 끝나지 않은 단계가 stepAt 부터 idle_min 넘게 worker 없이 남으면 경과 분을 낸다 (R6)', () => {
  const at = Date.parse('2026-11-02T12:00:00+09:00')
  const ago = (minutes: number) => new Date(at - minutes * 60_000).toISOString()
  const item = (extra: Json) => ({ id: 'a', status: 'doing', worktree: 'wt-a', next: [{ text: '1. 구현', done: true }, { text: '2. 리뷰', done: false }], stepAt: ago(40), ...extra })
  const minutes = (value: Json, idleMin = 30) => idleStepMinutes(value, stepRows(value), at, idleMin)
  assert.equal(minutes(item({})), 40)
  assert.equal(minutes(item({ status: 'wait' })), null)
  assert.equal(minutes(item({ status: 'decide' })), null)
  assert.equal(minutes(item({ next: [{ text: '1. 구현', done: true }] })), null)
  assert.equal(minutes(item({ stepAt: undefined })), null)
  assert.equal(minutes(item({ stepAt: ago(20) })), null)
  assert.equal(minutes(item({}), 0), null)
  const late = item({ stepAt: ago(180) })
  assert.equal(workerNoneText(late, stepRows(late), at, 30), '⚙ worker 없음 · 3시간 (wt-a)')
  const old = item({ stepAt: undefined })
  assert.equal(workerNoneText(old, stepRows(old), at, 30), '⚙ worker 없음 (wt-a)')
})
