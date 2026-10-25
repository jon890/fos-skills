// cleanup-sweep.ts 테스트 가운데 반납 뒤 빈 셸과 경로를 쥔 프로세스(--kill-holders)을 본다.
// 가짜 실행 파일, 상태와 공통 도우미는 fixtures/cleanup-sweep.ts 가 소유한다.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { HOOK, type Proc, branches, calls, exists, fx, git, gone, has, idleShell, lacks, runSweep, squashMerge, sweepCalls, worktree } from './fixtures/cleanup-sweep.ts'

function releasedWorkerWithShell(name: string, child = false): string {
  const path = worktree(name)
  squashMerge(name, path)
  fx.workers = [{ dispatchId: 'ctx_w', workerState: 'succeeded', resource: { worktreeId: `x::${path}`, releaseState: 'retained' } }]
  fx.spawnOnRelease = idleShell(path, 'term_shell', child)
  return path
}

// 코디네이터가 끝난 worker 터미널을 닫자 Orca 가 그 탭에 빈 셸을 다시 열었다. 모든 Run 범위는 읽지 못한다.
function reopenedShell(name: string, opts: { child?: boolean; agent?: string; scope?: string } = {}): string {
  const path = worktree(name)
  squashMerge(name, path)
  fx.workers = [{ dispatchId: 'ctx_w', workerState: 'succeeded', dispatchStatus: 'completed', agentTerminalHandle: 'term_gone', resource: { worktreeId: `x::${path}` } }]
  const shell = idleShell(path)
  fx.terminals = [{ handle: 'term_shell', worktreePath: path, ...(opts.agent ? { agentIdentity: opts.agent } : {}) }]
  fx.processes = [...shell.processes, ...(opts.child ? [{ pid: 502, ppid: 501, cwd: path, command: 'sleep 100' }] : [])]
  fx.scope = opts.scope ?? 'bound'
  return path
}

describe('Orca 가 worker 반납 뒤 띄운 빈 셸', () => {
  test('반납 뒤 남은 빈 셸 터미널을 닫고 worktree 를 지운다', () => {
    const path = releasedWorkerWithShell('feat-o')
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-o'))
    has(calls(), 'orca terminal close --terminal term_shell')
  })

  test('자식이 도는 셸은 닫지 않는다', () => {
    const path = releasedWorkerWithShell('feat-p', true)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
    has(out, '다음 실행에서 다시 시도')
  })

  test('다른 프로세스는 빈 셸로 보지 않는다', () => {
    const path = worktree('feat-q')
    squashMerge('feat-q', path)
    fx.terminals = [{ handle: 'term_q', worktreePath: path }]
    fx.processes = [{ pid: 601, ppid: 1, cwd: path, command: 'node server.js' }]
    const out = runSweep(['--apply'])
    exists(path, out)
    assert.equal(sweepCalls('terminal close').length, 1, calls())
    has(out, '다음 실행에서 다시 시도')
  })

  test('Orca 터미널 없는 빈 셸은 그대로 둔다', () => {
    const path = worktree('feat-r')
    squashMerge('feat-r', path)
    fx.processes = idleShell(path).processes
    const out = runSweep(['--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
  })

  test('다시 열린 빈 셸도 모든 Run 을 읽지 못하면 남긴다', () => {
    const path = reopenedShell('feat-s1')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })

  test('자식 프로세스가 있는 다시 열린 셸은 건너뛴다', () => {
    const path = reopenedShell('feat-s2', { child: true })
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })

  test('에이전트가 있거나 다른 Run 의 터미널은 건너뛴다', () => {
    const path = reopenedShell('feat-s3', { agent: 'claude' })
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
    const other = reopenedShell('feat-s4', { scope: 'all' })
    fx.allWorkers = [{ runId: 'run_other', dispatchId: 'ctx_o', agentTerminalHandle: 'term_shell' }]
    const again = runSweep(['--run', 'run_x', '--apply'])
    exists(other, again)
    has(again, '다른 Run 의 worker 터미널 term_shell')
    lacks(calls(), 'terminal close')
  })

  test('--apply 가 없으면 다시 열린 셸을 닫지 않는다', () => {
    const path = reopenedShell('feat-s5')
    const out = runSweep(['--run', 'run_x'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })
})

function finishedWorkerWithHolders(name: string, state = 'succeeded'): string {
  const path = worktree(name)
  squashMerge(name, path)
  fx.workers = [{ dispatchId: 'ctx_k', workerState: state, agentTerminalHandle: 'term_gone', resource: { worktreeId: `x::${path}`, releaseState: 'released' } }]
  mkdirSync(join(path, 'sub'))
  fx.processes = [
    { pid: 701, ppid: 1, cwd: path, command: 'claude --resume' },
    { pid: 702, ppid: 1, cwd: join(path, 'sub'), command: '-/bin/zsh -l', ignores: ['TERM'] },
    { pid: 703, ppid: 1, cwd: path, command: 'node plugin.js' },
    { pid: 709, ppid: 1, cwd: `${path}-other`, command: '-/bin/zsh -l' },
  ]
  return path
}

function killCalls(): string[] {
  return calls()
    .split('\n')
    .filter((line) => line.startsWith('kill '))
}

function remainingPids(): Set<unknown> {
  const st = JSON.parse(readFileSync(join(fx.tmp, 'state.json'), 'utf8')) as { processes: Proc[] }
  return new Set(st.processes.map((q) => q.pid))
}

describe('worker 가 끝난 뒤에도 경로를 쥔 프로세스 (--kill-holders)', () => {
  test('끝난 worker 의 프로세스를 끄고 worktree 를 지운다', () => {
    const path = finishedWorkerWithHolders('feat-k1')
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-k1'))
    // TERM 을 무시한 로그인 셸에만 HUP 을 보낸다. 이름이 비슷한 다른 경로의 셸은 건드리지 않는다
    assert.deepEqual(killCalls(), ['kill -TERM 701 702 703', 'kill -HUP 702'])
    assert.deepEqual(remainingPids(), new Set([709]))
  })

  test('TERM 과 HUP 을 무시하면 KILL 까지 보낸다', () => {
    const path = finishedWorkerWithHolders('feat-k2')
    fx.processes[0].ignores = ['TERM', 'HUP']
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    gone(path, out)
    assert.deepEqual(killCalls(), ['kill -TERM 701 702 703', 'kill -HUP 701 702', 'kill -KILL 701'])
  })

  test('Orca 가 띄운 프로세스만 끈다', () => {
    const path = finishedWorkerWithHolders('feat-k7')
    const helper = '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper'
    fx.processes = [
      // Orca 터미널: Orca Helper → login → 로그인 셸 → claude
      { pid: 800, ppid: 1, cwd: '/', command: '/Applications/Orca.app/Contents/MacOS/Orca' },
      { pid: 801, ppid: 800, cwd: '/', command: helper },
      { pid: 802, ppid: 801, cwd: '/', command: '/usr/bin/login -fpl user /bin/zsh' },
      { pid: 803, ppid: 802, cwd: path, command: '-/bin/zsh -l' },
      { pid: 804, ppid: 803, cwd: path, command: 'claude' },
      // iTerm 에서 그 폴더로 들어간 사용자 셸과, 편집기가 띄운 language server
      { pid: 810, ppid: 1, cwd: '/', command: '/Applications/iTerm.app/Contents/MacOS/iTerm2' },
      { pid: 811, ppid: 810, cwd: '/', command: '/usr/bin/login -fpl user /bin/zsh' },
      { pid: 812, ppid: 811, cwd: path, command: '-/bin/zsh -l' },
      { pid: 820, ppid: 1, cwd: '/', command: '/Applications/Code.app/Contents/MacOS/Code' },
      { pid: 821, ppid: 820, cwd: path, command: 'node tsserver.js' },
    ]
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    exists(path, out)
    assert.deepEqual(killCalls(), ['kill -TERM 803 804'])
    has(out, 'Orca 밖에서 띄웠거나')
    const left = remainingPids()
    assert.ok(left.has(812) && left.has(821), `812 와 821 이 남아야 한다: ${[...left].join(', ')}`)
  })

  test('이 명령 자신과 안쪽 워크트리를 쓰는 프로세스는 끄지 않는다', () => {
    const path = worktree('feat-k8')
    writeFileSync(join(path, '.gitignore'), 'nested/\n')
    git('-C', path, 'add', '-A')
    git('-C', path, 'commit', '-q', '-m', 'ignore nested')
    git('-C', path, 'push', '-q')
    squashMerge('feat-k8', path)
    git('-C', fx.repo, 'worktree', 'add', '-q', '-b', 'other-k8', join(path, 'nested'), 'origin/main')
    fx.workers = [{ dispatchId: 'ctx_k', workerState: 'succeeded', agentTerminalHandle: 'term_gone', resource: { worktreeId: `x::${path}`, releaseState: 'released' } }]
    fx.processes = [
      { pid: 'SWEEP', ppid: 1, cwd: path, command: 'node cleanup-sweep.ts' },
      { pid: 851, ppid: 1, cwd: join(path, 'nested'), command: 'claude' },
      { pid: 852, ppid: 1, cwd: path, command: 'node plugin.js' },
    ]
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    exists(path, out)
    assert.deepEqual(killCalls(), ['kill -TERM 852'])
    assert.ok(remainingPids().has(851))
    has(out, '다음 실행에서 다시 시도')
  })

  test('OMC session-end hook 만 남으면 remove-worktree 에 넘긴다', () => {
    // 건너뛰지 않고 remove-worktree.ts 에 넘긴다. 그 명령이 hook 이 끝날 때까지 기다린다
    const path = worktree('feat-h1')
    squashMerge('feat-h1', path)
    fx.processes = [{ pid: 861, ppid: 1, cwd: path, command: HOOK }]
    fx.env.ORCH_HOOK_WAIT = '0'
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, 'OMC session-end hook 861 은 끄지 않는다')
    has(out, 'session-end hook 861 는 스스로 끝난다')
    lacks(out, '다음 실행에서 다시 시도')
  })

  test('--kill-holders 도 session-end hook 은 끄지 않는다', () => {
    const path = finishedWorkerWithHolders('feat-h2')
    fx.processes.push({ pid: 862, ppid: 1, cwd: path, command: HOOK })
    fx.env.ORCH_HOOK_WAIT = '0'
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    exists(path, out)
    assert.ok(killCalls().every((line) => !line.includes('862')), killCalls().join('\n'))
    assert.ok(remainingPids().has(862))
  })

  test('옵션이 없으면 끄지 않는다', () => {
    const path = finishedWorkerWithHolders('feat-k3')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    assert.deepEqual(killCalls(), [])
    has(out, '다음 실행에서 다시 시도')
  })

  test('끝난 dispatch 를 모르면 끄지 않는다', () => {
    const path = finishedWorkerWithHolders('feat-k4')
    const out = runSweep(['--kill-holders', '--apply'])
    exists(path, out)
    has(out, '그 경로의 worker 를 모른다')
    for (const state of ['failed', 'abandoned']) {
      fx.workers[0].workerState = state
      const again = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
      exists(path, again)
      has(again, '끝나지 않은 dispatch ctx_k')
    }
    assert.deepEqual(killCalls(), [])
  })

  test('그 경로에 Orca 터미널이 남아 있으면 끄지 않는다', () => {
    const path = finishedWorkerWithHolders('feat-k5')
    // 닫기 명령이 성공을 돌려줘도 터미널이 남은 경우를 흉내 낸다
    fx.terminals = [{ handle: 'term_stuck', worktreePath: path }]
    fx.closeNoop = true
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    exists(path, out)
    has(out, 'Orca 터미널이 남아 있거나')
    assert.deepEqual(killCalls(), [])
  })

  test('dry-run 은 신호를 보내지 않는다', () => {
    const path = finishedWorkerWithHolders('feat-k6')
    // 실제 실행은 MERGED 면 이 터미널을 먼저 닫으므로 dry-run 도 끈다고 낸다
    fx.terminals = [{ handle: 'term_k6', worktreePath: path }]
    const out = runSweep(['--run', 'run_x', '--kill-holders'])
    exists(path, out)
    has(out, 'TERM, HUP, KILL 순으로 끈다')
    assert.deepEqual(killCalls(), [])
  })
})
