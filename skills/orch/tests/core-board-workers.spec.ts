import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardWorkerRows, hasWorkRows, lostDispatches, rowsReviewPr, workingDispatches, workerEnds, workerRevivals } from '../scripts/core/board-workers.ts'

test('worker 줄의 구조, 작업 역할과 최근 리뷰 PR 을 읽는다', () => {
  assert.deepEqual(boardWorkerRows({ workers: [null, 1, {}, { worktree: 'w' }] }), [{ worktree: 'w' }])
  assert.equal(hasWorkRows({}), null)
  assert.equal(hasWorkRows({ workers: [] }), false)
  assert.equal(hasWorkRows({ workers: [{ worktree: 'w', role: 'follow', status: 'done' }] }), true)
  const workers = [{ worktree: 'r', role: 'review', pr: 7, at: '2026-01-01', dispatch: 'd', status: 'working' }, { worktree: 'v', role: 'verify', pr: 8, at: '2026-01-02', status: 'done' }]
  assert.equal(hasWorkRows({ workers }), false)
  assert.equal(rowsReviewPr({ workers }), 8)
  assert.deepEqual([...workingDispatches([{ workers }])], ['d'])
})

test('보고와 succeeded 는 done, 끝난 상태와 터미널 소실은 lost 다', () => {
  const rows = [
    { dispatchId: 'ok', projection: { outcome: 'succeeded' } },
    { dispatchId: 'report', projection: { outcome: 'failed' } },
    { dispatchId: 'stopped', workerState: 'stopped' },
    { dispatchId: 'failed', dispatchStatus: 'failed' },
    { dispatchId: 'cancelled', projection: { outcome: 'cancelled' } },
    { dispatchId: 'missing', projection: { stage: { detail: 'terminal_missing' } } },
    { dispatchId: 'live', dispatchStatus: 'running' },
    { dispatchId: 'outside', dispatchStatus: 'failed' },
  ]
  const watched = new Set(['ok', 'report', 'stopped', 'failed', 'cancelled', 'missing', 'live', 'only-report'])
  assert.deepEqual(workerEnds(rows, new Set(['report', 'only-report', 'outside']), watched), {
    ok: 'done', report: 'done', stopped: 'lost', failed: 'lost', cancelled: 'lost', missing: 'lost', 'only-report': 'done',
  })
})

test('끊김 줄은 dispatch 가 다시 열려 있으면 working, 성공했으면 done 으로 되살리고 진짜 끊긴 것은 그대로 둔다', () => {
  const live = { verdict: 'live' }
  const rows = [
    // 띄운 직후 liveness 가 잠깐 exited 였다가 지금은 live 다
    { dispatchId: 'back', dispatchStatus: 'dispatched', workerState: 'ready', projection: { outcome: 'in_progress', liveness: live } },
    // 끝난 worker 가 succeeded 로 닫혔다
    { dispatchId: 'ok', dispatchStatus: 'completed', workerState: 'succeeded', projection: { outcome: 'succeeded', liveness: { verdict: 'exited' } } },
    // 터미널이 닫혀 dispatch 가 failed 로 닫혔다(진짜 끊김)
    { dispatchId: 'dead', dispatchStatus: 'failed', workerState: 'failed', projection: { outcome: 'failed', liveness: { verdict: 'exited' } } },
    // 열린 dispatch 인데 지금도 프로세스가 끝나 있다(진짜 끊김)
    { dispatchId: 'exited', dispatchStatus: 'dispatched', workerState: 'ready', projection: { outcome: 'in_progress', liveness: { verdict: 'exited' } } },
    { dispatchId: 'other', dispatchStatus: 'dispatched', projection: { liveness: live } },
  ]
  const lost = new Set(['back', 'ok', 'dead', 'exited', 'reported', 'absent'])
  assert.deepEqual(workerRevivals(rows, new Set(['reported']), lost), { back: 'working', ok: 'done', reported: 'done' })
})

test('끊김 dispatch 는 보드의 lost 줄에서만 모은다', () => {
  const rows = (status: string, dispatch: unknown) => ({ workers: [{ worktree: 'w', role: 'impl', status, dispatch }] })
  assert.deepEqual([...lostDispatches([rows('lost', 'a'), rows('working', 'b'), rows('done', 'c'), rows('lost', null), rows('lost', ' ')])], ['a'])
})
