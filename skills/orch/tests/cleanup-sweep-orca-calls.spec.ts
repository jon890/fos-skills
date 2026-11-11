import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { calls, exists, fx, git, runSweep, squashMerge, worktree } from './fixtures/cleanup-sweep.ts'

function shareWorkers(): void {
  const dir = join(fx.tmp, 'tick')
  mkdirSync(dir)
  writeFileSync(join(dir, 'known-workers.json'), JSON.stringify({ own: [] }))
  fx.env.ORCH_SWEEP_CACHE = dir
}

test('Run 을 지정한 정리는 다른 Run 의 워크트리와 목록을 조회하지 않는다', () => {
  const foreign = worktree('foreign')
  squashMerge('foreign', foreign)
  fx.runs = { own: [], foreign: [{ dispatchId: 'foreign', dispatchStatus: 'running', resource: { worktreeId: `repo::${foreign}` } }] }
  fx.scope = 'flag'
  const out = runSweep(['--run', 'own', '--apply'])
  exists(foreign, out)
  assert.match(out, /이 Run 의 워크트리가 아니다/)
  assert.doesNotMatch(calls(), /run-list|worker-list.*--run foreign|task-list.*--run foreign/)
})

test('틱이 준 worker 행은 정리에서 다시 읽지 않는다', () => {
  fx.runs = { own: [], foreign: [] }
  shareWorkers()
  runSweep(['--run', 'own'])
  assert.doesNotMatch(calls(), /worker-list|task-list|run-list/)
})

test('열린 PR 의 리뷰 브랜치는 모든 Run 의 지시서를 조회하지 않고 남긴다', () => {
  git('-C', fx.repo, 'branch', 'review/pr-77')
  fx.prViews['77'] = { state: 'OPEN' }
  shareWorkers()
  runSweep(['--run', 'own'])
  assert.doesNotMatch(calls(), /worker-list|task-list|run-list/)
})
