// 보드 항목 id 로 대상 리뷰 PR 을 찾는 판정(lib/review.ts 의 reviewPrsByItem, reviewPrOfItem, boardItemOfDispatch)을 본다.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { writeNodeBin } from './fixtures/merge-queue-fakes.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { boardItemOfDispatch, reviewPrOfItem, reviewPrsByItem, reviewOriginsByItem, isReviewItem } from '../scripts/lib/review.ts'

let tmp: string
let saved: string | undefined
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'review-item-')))
  saved = process.env.ORCH_DIR
  process.env.ORCH_DIR = join(tmp, 'orch')
  mkdirSync(join(tmp, 'orch', 'state'), { recursive: true })
})
after(() => {
  if (saved === undefined) delete process.env.ORCH_DIR
  else process.env.ORCH_DIR = saved
  rmSync(tmp, { recursive: true, force: true })
})

function spec(name: string, text: string): string {
  const file = join(tmp, name)
  writeFileSync(file, text)
  return file
}

test('항목 id 의 가장 최근 띄우기 지시서에 리뷰 PR 줄이 없으면 id 꼴이어도 리뷰 항목이 아니다', async () => {
  const old = spec('old.md', '# 리뷰\n\n리뷰 PR: #5\n보드 항목 id: `review-pr-5-x`\n')
  const now = spec('now.md', '# 구현\n\n보드 항목 id: `review-pr-5-x`\n')
  const lines = [
    { dispatch: 'ctx_a', at: '2026-11-13T01:00:00Z', worktree: 'w1', spec: old },
    { dispatch: 'ctx_b', at: '2026-11-13T02:00:00Z', worktree: 'w2', spec: now },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n'
  const { pathOf } = await import('../scripts/lib/paths.ts')
  writeFileSync(join(pathOf('state', tmp), 'launch-history.jsonl'), lines)
  const byItem = reviewPrsByItem(tmp)
  assert.equal(reviewPrOfItem('review-pr-5-x', byItem), null)
  assert.equal(boardItemOfDispatch(tmp, 'ctx_b'), 'review-pr-5-x')
})

test('지시서 판정이 없으면 id 꼴로 읽고 다른 꼴은 리뷰 항목이 아니다', () => {
  const none = new Map<string, number | null>()
  assert.equal(reviewPrOfItem('review-pr-477-r2', none), 477)
  assert.equal(reviewPrOfItem('review-pr-486-b', none), 486)
  assert.equal(reviewPrOfItem('verify-pr-486', none), 486)
  assert.equal(reviewPrOfItem('review-pr-12abc', none), null)
})

test('리뷰 생성 이력과 구현 증거로 항목의 목적을 정한다', () => {
  const impl = spec('origin-impl.md', '# 구현\n보드 항목 id: build')
  const review = spec('origin-review.md', '# 리뷰\n보드 항목 id: build\n리뷰 PR: #7')
  const orphan = spec('origin-orphan.md', '# 리뷰\n리뷰 PR: #7')
  writeFileSync(join(tmp, 'orch/state/launch-history.jsonl'), [
    { at: '2026-01-01T00:00:00Z', dispatch: 'impl', worktree: 'build', spec: impl },
    { at: '2026-01-02T00:00:00Z', dispatch: 'review', worktree: 'r', spec: review },
    { at: '2026-01-03T00:00:00Z', dispatch: 'orphan', worktree: 'review-only', spec: orphan },
  ].map((row) => JSON.stringify(row)).join('\n'))
  const items = [{ id: 'build', workers: [{ role: 'review', worktree: 'r', dispatch: 'review' }] },
    { id: 'review-only', workers: [{ role: 'review', worktree: 'review-only', dispatch: 'orphan' }] }]
  const origins = reviewOriginsByItem(tmp, items)
  assert.equal(isReviewItem(items[0], origins), false)
  assert.equal(isReviewItem(items[1], origins), true)
  assert.equal(isReviewItem({ ...items[1], pr: 7 }, origins), false)
  assert.equal(isReviewItem({ id: 'unknown', stages: 'pr=1,merge=2' }, origins), false)
})

test('명시한 항목에 붙은 리뷰 이력이 구현 항목을 닫지 않는다', () => {
  const review = spec('attached-review.md', '# 리뷰\n보드 항목 id: attached\n리뷰 PR: #7')
  writeFileSync(join(tmp, 'orch/state/launch-history.jsonl'), JSON.stringify({ dispatch: 'attached-review', at: '2026-11-13T03:00:00Z', worktree: 'r', spec: review }) + '\n')
  const gh = writeNodeBin(tmp, 'gh', "process.stdout.write(process.argv.includes('list') ? '[]' : 'MERGED')")
  const file = join(tmp, 'board.json')
  for (const role of ['impl', null, 'review']) {
    writeFileSync(file, JSON.stringify({ items: [{ id: 'attached', status: 'doing', details: ['1. 구현'], ...(role ? { workers: [{ role, worktree: 'w', status: 'done', at: '2026-01-01', pr: 7 }] } : {}) }] }))
    const r = spawnSync(process.execPath, [new URL('../scripts/board/board-sync.ts', import.meta.url).pathname, '--repo', tmp, '--board', file, '--completed-items', '["attached"]'], { env: { ...process.env, GH: gh, GIT_CEILING_DIRECTORIES: tmp }, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[0].status, role === 'impl' ? 'doing' : 'done')
  }
})
