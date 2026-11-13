import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardWorkerRows, hasWorkRows, rowsReviewPr, workingDispatches, workerEnds } from '../scripts/core/board-workers.ts'

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
