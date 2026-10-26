// cleanup-sweep.ts 가 코디네이터가 띄운 worker 터미널을 알아보는 것과, PR 없이 끝난 워크트리를 치우는 것을 본다.
// 가짜 실행 파일, 상태와 공통 도우미는 fixtures/cleanup-sweep.ts 가 소유한다.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { type Row, branches, calls, exists, fx, git, gone, has, lacks, runSweep, squashMerge, worktree } from './fixtures/cleanup-sweep.ts'

type Own = { record?: boolean | Row; status?: string; state?: string; otherTerminal?: boolean }

// 끝난 worker 가 user_owned 로 남은 터미널을 쥔 워크트리. 기록은 launch-worker.ts 가 남기는 파일과 같은 꼴이다
function ownTerminal(path: string, opts: Own = {}): void {
  const dispatch = 'ctx_o'
  if (opts.record !== false) {
    const dir = join(fx.repo, '.orch/state/launched-workers')
    mkdirSync(dir, { recursive: true })
    const record = { dispatch, terminal: 'term_o', worktree: path, run: 'run_x', ...(typeof opts.record === 'object' ? opts.record : {}) }
    writeFileSync(join(dir, `${dispatch}.json`), JSON.stringify(record))
  }
  const worker: Row = {
    runId: 'run_x',
    dispatchId: dispatch,
    dispatchStatus: opts.status ?? 'completed',
    workerState: opts.state ?? 'succeeded',
    agentTerminalHandle: 'term_o',
    resource: { worktreeId: `x::${path}`, terminalHandle: 'term_o', ownershipState: 'user_owned', retainedReason: 'user_takeover' },
  }
  fx.terminals = [{ handle: 'term_o', worktreePath: path }]
  fx.allWorkers = [worker]
  fx.workers = [worker]
}

describe('launch-worker 가 기록한 user_owned 터미널', () => {
  test('끝난 dispatch 면 닫고 PR 상태로 정리한다', () => {
    const path = worktree('feat-l1')
    squashMerge('feat-l1', path)
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-l1'))
    has(calls(), 'orca terminal close --terminal term_o')
    has(calls(), 'orca orchestration worker-release --dispatch ctx_o')
    assert.ok(!existsSync(join(fx.repo, '.orch/state/launched-workers/ctx_o.json')))
  })

  test('failed 와 canceled 도 끝난 것으로 본다', () => {
    for (const status of ['failed', 'canceled']) {
      const path = worktree(`feat-l-${status}`)
      squashMerge(`feat-l-${status}`, path)
      ownTerminal(path, { status, state: 'fenced' })
      const out = runSweep(['--run', 'run_x', '--apply'])
      gone(path, out)
    }
  })

  test('기록에 없는 터미널은 사람의 것으로 보고 남긴다', () => {
    const path = worktree('feat-l2')
    squashMerge('feat-l2', path)
    ownTerminal(path, { record: false })
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '남김: 사용자 보유 터미널')
    lacks(calls(), 'terminal close')
  })

  test('끝나지 않은 dispatch 는 남긴다', () => {
    const path = worktree('feat-l3')
    squashMerge('feat-l3', path)
    ownTerminal(path, { status: 'dispatched', state: 'ready' })
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
  })

  test('기록한 워크트리나 터미널이 다르면 남긴다', () => {
    for (const [label, record] of Object.entries({ worktree: { worktree: '/elsewhere' }, terminal: { terminal: 'term_other' } })) {
      const path = worktree(`feat-l4-${label}`)
      squashMerge(`feat-l4-${label}`, path)
      ownTerminal(path, { record })
      const out = runSweep(['--run', 'run_x', '--apply'])
      exists(path, out)
      has(out, '남김: 사용자 보유 터미널')
    }
  })

  test('--run 이 없으면 어느 dispatch 의 것인지 몰라 남긴다', () => {
    const path = worktree('feat-l5')
    squashMerge('feat-l5', path)
    ownTerminal(path)
    const out = runSweep(['--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
  })

  test('PR 이 MERGED 가 아니면 터미널을 닫지 않는다', () => {
    const path = worktree('feat-l6')
    fx.prs['feat-l6'] = ['OPEN', git('-C', path, 'rev-parse', 'HEAD')]
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
  })

  test('dry-run 은 닫을 것만 낸다', () => {
    const path = worktree('feat-l7')
    squashMerge('feat-l7', path)
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x'])
    exists(path, out)
    has(out, '터미널을 닫을 것 term_o')
    lacks(calls(), 'terminal close')
  })
})

describe('PR 없이 끝난 워크트리', () => {
  test('앞선 커밋과 변경이 없으면 워크트리, 로컬과 원격 브랜치를 치운다', () => {
    const path = worktree('meas-1', { commits: 0 })
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    assert.ok(!branches().has('meas-1'))
    has(calls(), 'orca terminal close --terminal term_o')
  })

  test('터미널이 없어도 치운다', () => {
    const path = worktree('meas-2', { commits: 0, push: false })
    ownTerminal(path)
    fx.terminals = []
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
  })

  test('base 보다 앞선 커밋이 있으면 남기고 이유를 낸다', () => {
    for (const push of [false, true]) {
      const path = worktree(`meas-3-${push}`, { push })
      ownTerminal(path)
      const out = runSweep(['--run', 'run_x', '--apply'])
      exists(path, out)
      has(out, '치우지 않는 이유: base 보다 앞선 커밋 1 개')
      lacks(calls(), 'terminal close')
    }
  })

  test('커밋 안 된 변경이 있으면 남긴다', () => {
    const path = worktree('meas-4', { commits: 0, push: false })
    writeFileSync(join(path, 'wip.txt'), 'x')
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '치우지 않는 이유: 커밋 안 된 변경')
  })

  test('끝나지 않은 dispatch 는 남긴다', () => {
    const path = worktree('meas-5', { commits: 0, push: false })
    ownTerminal(path, { status: 'dispatched', state: 'ready' })
    fx.terminals = []
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '치우지 않는 이유: 끝나지 않은 dispatch ctx_o')
  })

  test('failed dispatch 는 다시 맡길 수 있어 남긴다', () => {
    const path = worktree('meas-6', { commits: 0, push: false })
    ownTerminal(path, { status: 'failed', state: 'fenced' })
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '치우지 않는 이유: 끝나지 않은 dispatch ctx_o')
  })

  test('dispatch 를 모르면(--run 이 없으면) 남긴다', () => {
    const path = worktree('meas-7', { commits: 0, push: false })
    ownTerminal(path)
    fx.terminals = []
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '치우지 않는 이유: 그 경로의 dispatch 를 모른다')
  })

  test('원격 브랜치에 앞선 커밋이 있으면 원격과 워크트리를 남긴다', () => {
    const path = worktree('meas-8')
    git('-C', path, 'reset', '-q', '--hard', 'origin/main')
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '치우지 않는 이유: 원격 브랜치 meas-8 에 base 보다 앞선 커밋 1 개')
    assert.ok(git('-C', fx.repo, 'ls-remote', '--heads', 'origin', 'meas-8').includes('meas-8'))
  })

  test('기록 없는 터미널이 있으면 닫지 않고 남긴다', () => {
    const path = worktree('meas-9', { commits: 0, push: false })
    ownTerminal(path, { record: false })
    fx.allWorkers = []
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
  })

  test('dry-run 은 치울 것만 낸다', () => {
    const path = worktree('meas-10', { commits: 0, push: false })
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x'])
    exists(path, out)
    has(out, 'worktree 와 로컬 브랜치를 지울 것 meas-10')
    lacks(calls(), 'terminal close')
  })
})
