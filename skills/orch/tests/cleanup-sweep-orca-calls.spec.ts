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
  assert.match(out, /FINISH-MISSING #\d+.*실제 담당 Run/)
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

test('틱 시작 뒤 사용자가 넘겨받은 머지 워크트리는 닫거나 삭제하지 않는다', () => {
  const directory = worktree('taken-after-tick')
  squashMerge('taken-after-tick', directory)
  const old = { runId: 'own', dispatchId: 'd', dispatchStatus: 'completed', workerState: 'succeeded', agentTerminalHandle: 'term_d', resource: { worktreeId: `repo::${directory}`, terminalHandle: 'term_d', ownershipState: 'owned' } }
  shareWorkers()
  writeFileSync(join(fx.env.ORCH_SWEEP_CACHE!, 'known-workers.json'), JSON.stringify({ own: [old] }))
  const launched = join(fx.repo, '.orch/state/launched-workers')
  mkdirSync(launched, { recursive: true })
  writeFileSync(join(launched, 'd.json'), JSON.stringify({ dispatch: 'd', worktree: directory, terminal: 'term_d', run: 'own' }))
  fx.terminals = [{ handle: 'term_d', worktreePath: directory }]
  fx.runs = { own: [{ ...old, resource: { ...old.resource, ownershipState: 'user_owned' } }] }
  const out = runSweep(['--run', 'own', '--apply'])
  exists(directory, out)
  assert.match(out, /사용자 보유 터미널/)
  assert.doesNotMatch(calls(), /terminal close|worker-release/)
})

test('틱 시작 뒤 같은 경로에 새 dispatch 가 생기면 머지 워크트리를 남긴다', () => {
  const directory = worktree('reused-after-tick')
  squashMerge('reused-after-tick', directory)
  const old = { runId: 'own', dispatchId: 'old', dispatchStatus: 'completed', workerState: 'succeeded', resource: { worktreeId: `repo::${directory}`, ownershipState: 'owned' } }
  shareWorkers()
  writeFileSync(join(fx.env.ORCH_SWEEP_CACHE!, 'known-workers.json'), JSON.stringify({ own: [old] }))
  fx.runs = { own: [old], next: [{ runId: 'next', dispatchId: 'new', dispatchStatus: 'running', workerState: 'running', resource: { worktreeId: `repo::${directory}`, ownershipState: 'owned' } }] }
  const out = runSweep(['--run', 'own', '--apply'])
  exists(directory, out)
  assert.match(out, /살아 있는 dispatch 가 경로를 쓴다/)
  assert.doesNotMatch(calls(), /terminal close|worker-release/)
})
