// cleanup-sweep.ts 가 lib/worker-state.ts 의 판정으로 일하는 중인 워크트리를 먼저 건너뛰고, 끝난 워크트리를 치우는 것을 본다.
// 코디네이터 후보(2026-10-30) 4, 8, 9 번 사례를 재현한다. 가짜 실행 파일과 도우미는 fixtures/cleanup-sweep.ts 가 소유한다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type Row, branches, calls, exists, fx, gone, has, lacks, runSweep, squashMerge, sweepCalls, worktree } from './fixtures/cleanup-sweep.ts'

const WORKING = ['⏺ 테스트를 고친다.', '✳ Thinking… (12s · esc to interrupt)']
const IDLE = ['⏺ 끝났다.', '───────────', '❯ ', '───────────']

function liveRow(path: string, dispatch: string, handle: string, resource: Row = {}): Row {
  return {
    dispatchId: dispatch,
    dispatchStatus: 'dispatched',
    workerState: 'ready',
    agentTerminalHandle: handle,
    resource: { worktreeId: `x::${path}`, terminalHandle: handle, ...resource },
  }
}

describe('일하는 중인 워크트리는 비싼 조회 앞에서 건너뛴다 (사례 4)', () => {
  test('살아 있는 dispatch 의 워크트리 7개는 PR 을 조회하지 않고, 끝난 워크트리만 치운다', () => {
    const rows: Row[] = []
    for (let i = 0; i < 7; i++) {
      const path = worktree(`busy-${i}`)
      rows.push(liveRow(path, `ctx_b${i}`, `term_b${i}`))
      fx.terminals.push({ handle: `term_b${i}`, worktreePath: path })
    }
    const merged = worktree('done-1')
    squashMerge('done-1', merged)
    rows.push({ dispatchId: 'ctx_d', dispatchStatus: 'completed', workerState: 'succeeded', resource: { worktreeId: `x::${merged}` } })
    fx.workers = rows
    fx.allWorkers = rows
    const out = runSweep(['--run', 'run_x', '--apply'])
    for (let i = 0; i < 7; i++) {
      has(out, `건너뜀 ${fx.wts}/busy-${i}: 살아 있는 worker ctx_b${i}. 근거: 살아 있는 dispatch ctx_b${i}`)
      assert.deepEqual(sweepCalls(`--head busy-${i}`), [])
    }
    assert.deepEqual(sweepCalls('--base busy-'), [])
    gone(merged, out)
  })
})

describe('끝난 worker 의 남은 프로세스와 PR 없는 워크트리 (사례 8)', () => {
  test('failed dispatch 이고 PR 이 MERGED 면 --kill-holders 가 남은 실험 서버를 끈다', () => {
    const path = worktree('bfcache-online')
    squashMerge('bfcache-online', path)
    fx.workers = [{ dispatchId: 'ctx_f', dispatchStatus: 'failed', workerState: 'failed', resource: { worktreeId: `x::${path}` } }]
    fx.processes = [{ pid: 801, ppid: 1, cwd: path, command: 'node lab-server.js' }]
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    has(out, 'TERM 를 보낸다: 801 node')
    gone(path, out)
  })

  test('PR 이 없고 main 에 없는 커밋이 0 이면 빈 셸 터미널 둘을 닫고 치운다', () => {
    const path = worktree('server-economy-followups', { commits: 0 })
    fx.workers = [{ dispatchId: 'ctx_e', dispatchStatus: 'completed', workerState: 'succeeded', agentTerminalHandle: 'term_gone', resource: { worktreeId: `x::${path}` } }]
    fx.terminals = [
      { handle: 'term_sh1', worktreePath: path },
      { handle: 'term_sh2', worktreePath: path },
    ]
    fx.processes = [
      { pid: 811, ppid: 1, cwd: path, command: '-/bin/zsh -l', terminal: 'term_sh1' },
      { pid: 812, ppid: 1, cwd: path, command: '-/bin/zsh -l', terminal: 'term_sh2' },
    ]
    const out = runSweep(['--run', 'run_x', '--apply'])
    has(out, 'PR 없음, 끝난 dispatch')
    has(calls(), 'orca terminal close --terminal term_sh1')
    has(calls(), 'orca terminal close --terminal term_sh2')
    gone(path, out)
    assert.ok(!branches().has('server-economy-followups'))
  })

  test('PR 이 없어도 끝난 worker 의 터미널 화면이 작업 중이면 남긴다', () => {
    const path = worktree('meas-busy', { commits: 0, push: false })
    fx.workers = [{ dispatchId: 'ctx_m', dispatchStatus: 'completed', workerState: 'succeeded', agentTerminalHandle: 'term_m', resource: { worktreeId: `x::${path}`, terminalHandle: 'term_m' } }]
    fx.terminals = [{ handle: 'term_m', worktreePath: path }]
    fx.screens = { term_m: WORKING }
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '치우지 않는 이유: dispatch ctx_m 가 completed 지만 화면이 작업 중이다')
    lacks(calls(), 'terminal close')
  })
})

describe('user_takeover 로 표시된 살아 있는 worker (사례 9)', () => {
  test('화면이 작업 중이면 일하는 중으로 건너뛰고 근거를 남긴다', () => {
    const path = worktree('takeover-busy')
    const row = liveRow(path, 'ctx_t', 'term_t', { ownershipState: 'user_owned', retainedReason: 'user_takeover' })
    fx.workers = [row]
    fx.allWorkers = [row]
    fx.terminals = [{ handle: 'term_t', worktreePath: path }]
    fx.screens = { term_t: WORKING }
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '살아 있는 worker ctx_t. 근거: user_takeover 표시지만 화면이 작업 중이다(ctx_t, term_t)')
    has(calls(), 'orca terminal read --terminal term_t --screen')
    lacks(calls(), '--head takeover-busy')
  })

  test('화면이 작업 중이 아니면 사용자 보유 터미널로 남긴다', () => {
    const path = worktree('takeover-idle')
    const row = liveRow(path, 'ctx_u', 'term_u', { ownershipState: 'user_owned', retainedReason: 'user_takeover' })
    fx.workers = [row]
    fx.allWorkers = [row]
    fx.terminals = [{ handle: 'term_u', worktreePath: path }]
    fx.screens = { term_u: IDLE }
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, `남김: 사용자 보유 터미널 (${path}). 근거: 사용자가 넘겨받은 터미널(ctx_u user_takeover, 화면 term_u idle)`)
  })
})
