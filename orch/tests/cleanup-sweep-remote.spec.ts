// cleanup-sweep.ts 테스트 가운데 user_takeover 터미널, 정리 이벤트, 원격 브랜치, CLOSED PR, 옛 경로을 본다.
// 가짜 실행 파일, 상태와 공통 도우미는 fixtures/cleanup-sweep.ts 가 소유한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { type Row, SHIM, branches, calls, exists, fx, git, gone, has, hook, idleShell, lacks, mergedWorkerWithTerminal, remoteBranches, runSweep, runSweepFull, save, squashMerge, worktree } from './fixtures/cleanup-sweep.ts'

type TakeOver = { row?: Row; entry?: Row; child?: boolean; otherRun?: boolean }

function takenOver(name: string, opts: TakeOver = {}): string {
  const path = worktree(name)
  squashMerge(name, path)
  const resource = {
    worktreeId: `x::${path}`,
    terminalHandle: 'term_t',
    releaseState: 'retained',
    ownershipState: 'user_owned',
    retainedReason: 'user_takeover',
    ...((opts.row?.resource as Row | undefined) ?? {}),
  }
  const worker: Row = {
    runId: 'run_x',
    dispatchId: 'ctx_t',
    dispatchStatus: 'completed',
    workerState: 'succeeded',
    agentTerminalHandle: 'term_t',
    ...(opts.row ?? {}),
    resource,
  }
  fx.terminals = [{ handle: 'term_t', worktreePath: path, ...(opts.entry ?? {}) }]
  fx.processes = idleShell(path, 'term_t', opts.child).processes
  fx.allWorkers = [worker]
  fx.workers = opts.otherRun ? [] : [worker]
  return path
}

describe('끝난 dispatch 의 user_takeover 터미널 (--close-own-taken-over)', () => {
  test('옵션을 주면 끝난 dispatch 의 넘겨받은 터미널을 닫고 정리한다', () => {
    const path = takenOver('feat-t1')
    const out = runSweep(['--run', 'run_x', '--close-own-taken-over', '--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-t1'))
    has(calls(), 'orca terminal close --terminal term_t')
    has(calls(), 'orca orchestration worker-release --dispatch ctx_t')
  })

  test('옵션이 없으면 남긴다', () => {
    const path = takenOver('feat-t2')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '남김: 사용자 보유 터미널')
    lacks(calls(), 'terminal close')
  })

  test('--run 없이 주면 사용법 오류다', () => {
    const path = takenOver('feat-t3')
    runSweep(['--close-own-taken-over', '--apply'], { code: 2 })
    assert.ok(existsSync(path))
    lacks(calls(), 'terminal close')
  })

  const cases: Record<string, TakeOver> = {
    'other-run': { otherRun: true },
    running: { row: { dispatchStatus: 'dispatched', workerState: 'ready' } },
    'other-reason': { row: { resource: { retainedReason: 'external_terminal' } } },
    agent: { entry: { agentIdentity: 'claude' } },
    child: { child: true },
  }
  for (const [label, opts] of Object.entries(cases)) {
    test(`조건 하나가 어긋나면 남긴다: ${label}`, () => {
      const path = takenOver(`feat-t4-${label}`, opts)
      const out = runSweep(['--run', 'run_x', '--close-own-taken-over', '--apply'])
      exists(path, out)
      lacks(calls(), 'terminal close')
    })
  }

  test('dry-run 은 넘겨받은 터미널을 닫지 않는다', () => {
    const path = takenOver('feat-t5')
    const out = runSweep(['--run', 'run_x', '--close-own-taken-over'])
    exists(path, out)
    has(out, '터미널을 닫을 것 term_t')
    lacks(calls(), 'terminal close')
  })
})

function hookInputs(event: string): Record<string, unknown>[] {
  if (!existsSync(fx.hookLog)) return []
  return readFileSync(fx.hookLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((input) => input.event === event)
}

describe('before-cleanup 과 after-cleanup 이벤트', () => {
  test('before-cleanup 이 거부하면 워크트리와 터미널을 남긴다', () => {
    const path = mergedWorkerWithTerminal('hook-reject', 'succeeded', 'completed')
    hook('before-cleanup', 10, '저장소가 남긴다')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, 'HOOK-REJECT before-cleanup 저장소가 남긴다')
    has(out, `남김 ${path}: 저장소 핸들러 거부`)
    lacks(out, `removed ${path}`)
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
    assert.ok(branches().has('hook-reject'))
    const st = JSON.parse(readFileSync(join(fx.tmp, 'state.json'), 'utf8')) as { terminals: Row[] }
    assert.deepEqual(
      st.terminals.map((t) => t.handle),
      ['term_s'],
    )
  })

  test('before-cleanup 이 실패하면 HOOK-FAIL 과 같은 남김 줄로 남긴다', () => {
    const path = mergedWorkerWithTerminal('hook-fail', 'succeeded', 'completed')
    hook('before-cleanup', 1)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, 'HOOK-FAIL before-cleanup 1')
    has(out, `남김 ${path}: 저장소 핸들러 거부`)
    lacks(calls(), 'terminal close')
  })

  test('before-cleanup 은 지운 워크트리의 경로, 브랜치, PR, worker 를 받는다', () => {
    const path = mergedWorkerWithTerminal('hook-pass', 'succeeded', 'completed')
    const head = (fx.prs['hook-pass'] as string[])[1]
    hook('before-cleanup', 0)
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    const inputs = hookInputs('before-cleanup')
    assert.equal(inputs.length, 1, JSON.stringify(inputs))
    const input = inputs[0]
    assert.equal(input.worktree, path)
    assert.equal(input.branch, 'hook-pass')
    assert.equal(input.run, 'run_x')
    assert.equal(input.base, 'main')
    const pr = input.pr as Record<string, unknown>
    assert.equal(pr.number, 1)
    assert.equal(pr.head, head)
    assert.equal(pr.branch, 'hook-pass')
    const worker = input.worker as Record<string, unknown>
    assert.equal(worker.dispatch, 'ctx_s')
    assert.equal(worker.terminal, 'term_s')
    assert.equal(worker.worktree, path)
  })

  test('after-cleanup 은 지운 워크트리와 남긴 워크트리를 받는다', () => {
    const removed = worktree('after-gone')
    squashMerge('after-gone', removed)
    const kept = worktree('after-dirty')
    squashMerge('after-dirty', kept)
    writeFileSync(join(kept, 'new.txt'), 'x')
    hook('after-cleanup', 0)
    const out = runSweep(['--apply'])
    gone(removed, out)
    exists(kept, out)
    const inputs = hookInputs('after-cleanup')
    assert.equal(inputs.length, 1, JSON.stringify(inputs))
    assert.deepEqual(inputs[0].removed, [removed])
    assert.deepEqual(inputs[0].skipped, [{ path: kept, reason: '커밋 안 된 변경' }])
  })

  test('워크트리가 없는 저장소의 after-cleanup 은 빈 목록을 받는다', () => {
    hook('after-cleanup', 0)
    runSweep(['--apply'])
    const inputs = hookInputs('after-cleanup')
    assert.equal(inputs.length, 1, JSON.stringify(inputs))
    assert.deepEqual(inputs[0].removed, [])
    assert.deepEqual(inputs[0].skipped, [])
  })

  test('after-cleanup 이 실패해도 종료 코드는 0 이다', () => {
    const path = worktree('after-fail')
    squashMerge('after-fail', path)
    hook('after-cleanup', 1)
    const out = runSweep(['--apply'])
    gone(path, out)
    has(out, 'HOOK-FAIL after-cleanup 1')
  })

  test('--apply 가 없으면 두 핸들러 모두 부르지 않는다', () => {
    const path = worktree('hook-dry')
    squashMerge('hook-dry', path)
    hook('before-cleanup', 0)
    hook('after-cleanup', 0)
    const out = runSweep()
    has(out, `정리 ${path}`)
    exists(path, out)
    assert.deepEqual(hookInputs('before-cleanup'), [])
    assert.deepEqual(hookInputs('after-cleanup'), [])
    assert.equal(existsSync(fx.hookLog), false, '핸들러가 입력을 남겼다')
  })
})

// origin 에만 있는 브랜치를 만든다. 로컬 브랜치는 두지 않는다. 끝 커밋을 돌려준다.
function remoteOnly(name: string, parent = 'origin/main'): string {
  const tree = git('-C', fx.repo, 'rev-parse', `${parent}^{tree}`)
  const oid = git('-C', fx.repo, 'commit-tree', tree, '-p', parent, '-m', name)
  git('-C', fx.repo, 'push', '-q', 'origin', `${oid}:refs/heads/${name}`)
  return oid
}

function closedPr(name: string, oid: string, state: 'MERGED' | 'CLOSED', opts: { number?: number; author?: string; cross?: boolean } = {}): void {
  fx.closedPrs.push({
    number: opts.number ?? 1,
    state,
    headRefName: name,
    headRefOid: oid,
    baseRefName: 'main',
    isCrossRepository: opts.cross ?? false,
    mergedAt: state === 'MERGED' ? '2026-10-01T00:00:00Z' : null,
    author: opts.author ?? 'me',
  })
}

function authorsConfig(authors: string[]): void {
  mkdirSync(join(fx.repo, '.orch'), { recursive: true })
  writeFileSync(join(fx.repo, '.orch/config.json'), JSON.stringify({ pipeline: { authors } }))
}

describe('원격 브랜치 정리 (--remote-branches)', () => {
  beforeEach(() => {
    fx.ghUser = 'me'
  })

  test('로컬 브랜치가 없는 MERGED 인 내 PR 의 원격 브랜치를 지운다', () => {
    closedPr('feat-m', remoteOnly('feat-m'), 'MERGED', { number: 7 })
    // 원격에 없는 이름은 줄을 내지 않는다
    closedPr('feat-already-gone', '1'.repeat(40), 'MERGED', { number: 8 })
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 삭제 feat-m (#7 MERGED)')
    assert.ok(!remoteBranches().has('feat-m'), out)
    assert.ok(remoteBranches().has('main'), out)
    lacks(out, 'feat-already-gone')
  })

  test('CLOSED 이고 head 커밋이 base 에 들어 있으면(다른 PR 에 합쳐 닫혔다) 지운다', () => {
    const oid = remoteOnly('feat-folded')
    git('-C', fx.repo, 'push', '-q', 'origin', `${oid}:refs/heads/main`)
    closedPr('feat-folded', oid, 'CLOSED', { number: 3 })
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 삭제 feat-folded (#3 CLOSED)')
    assert.ok(!remoteBranches().has('feat-folded'), out)
  })

  test('CLOSED 이고 head 커밋이 base 에 없으면 남긴다', () => {
    closedPr('feat-dropped', remoteOnly('feat-dropped'), 'CLOSED')
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 남김 feat-dropped: CLOSED 이고 head 가 base 에 없다')
    assert.ok(remoteBranches().has('feat-dropped'), out)
  })

  test('다른 작성자의 PR 브랜치는 남기고 그 작성자의 목록을 부르지 않는다', () => {
    authorsConfig(['me'])
    fx.ghUser = ''
    closedPr('feat-theirs', remoteOnly('feat-theirs'), 'MERGED', { author: 'other' })
    const out = runSweep(['--remote-branches', '--apply'])
    assert.ok(remoteBranches().has('feat-theirs'), out)
    has(calls(), '--author me')
    lacks(calls(), '--author other')
    // pipeline.authors 가 있으면 gh 현재 사용자를 읽지 않는다
    lacks(calls(), 'gh api user')
  })

  test('열린 PR 의 base 인 브랜치는 남기고 그 PR 의 base 를 바꾸지 않는다', () => {
    closedPr('feat-stack', remoteOnly('feat-stack'), 'MERGED')
    fx.openBases = ['feat-stack']
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 남김 feat-stack: 열린 PR 의 base 다')
    assert.ok(remoteBranches().has('feat-stack'), out)
    lacks(calls(), 'pr edit')
  })

  test('열린 PR 의 head 인 브랜치는 남긴다', () => {
    closedPr('feat-reopened', remoteOnly('feat-reopened'), 'MERGED')
    fx.openHeads = ['feat-reopened']
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 남김 feat-reopened: 열린 PR 의 head 다')
    assert.ok(remoteBranches().has('feat-reopened'), out)
  })

  test('release 브랜치는 남긴다', () => {
    closedPr('release/x', remoteOnly('release/x'), 'MERGED')
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 남김 release/x: 보호 브랜치다')
    assert.ok(remoteBranches().has('release/x'), out)
  })

  test('fork PR 과 같은 이름의 원격 브랜치는 남긴다', () => {
    closedPr('feat-fork', remoteOnly('feat-fork'), 'MERGED', { cross: true })
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 남김 feat-fork: fork 의 브랜치다')
    assert.ok(remoteBranches().has('feat-fork'), out)
  })

  test('원격 끝점이 PR head 와 다르면 남긴다', () => {
    const merged = remoteOnly('feat-moved')
    closedPr('feat-moved', merged, 'MERGED')
    // 머지 뒤 같은 이름에 커밋이 더해졌다
    remoteOnly('feat-moved', merged)
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 남김 feat-moved: 원격 끝점이 PR head 와 다르다')
    assert.ok(remoteBranches().has('feat-moved'), out)
  })

  test('--apply 가 없으면 지울 것만 내고 원격은 그대로다', () => {
    closedPr('feat-dry', remoteOnly('feat-dry'), 'MERGED', { number: 5 })
    const out = runSweep(['--remote-branches'])
    has(out, '원격 브랜치를 지울 것 feat-dry (#5 MERGED)')
    lacks(out, '원격 브랜치 삭제')
    assert.ok(remoteBranches().has('feat-dry'), out)
  })

  test('열린 PR 목록을 읽지 못하면 아무것도 지우지 않고 2 로 끝난다', () => {
    closedPr('feat-m2', remoteOnly('feat-m2'), 'MERGED')
    fx.ghFailOn = ['--state open --limit 1000']
    const out = runSweep(['--remote-branches', '--apply'], { code: 2 })
    has(out, '원격 브랜치 정리 건너뜀')
    assert.ok(remoteBranches().has('feat-m2'), out)
  })

  test('남은 워크트리와 로컬 브랜치가 쓰는 원격 브랜치는 남긴다', () => {
    // 열린 PR 이 없어 남는 워크트리. 그 브랜치 이름의 옛 PR 이 MERGED 로 닫혀 있다
    const path = worktree('feat-wt')
    closedPr('feat-wt', git('-C', path, 'rev-parse', 'HEAD'), 'MERGED', { number: 11 })
    // 워크트리 없이 원격 브랜치를 upstream 으로 둔 로컬 브랜치
    closedPr('feat-lb', remoteOnly('feat-lb'), 'MERGED', { number: 12 })
    git('-C', fx.repo, 'fetch', '-q', 'origin')
    git('-C', fx.repo, 'branch', '-q', '--track', 'feat-lb', 'origin/feat-lb')
    const out = runSweep(['--remote-branches', '--apply'])
    exists(path, out)
    has(out, '원격 브랜치 남김 feat-wt: 워크트리가 쓴다')
    has(out, '원격 브랜치 남김 feat-lb: 로컬 브랜치가 쓴다')
    assert.ok(remoteBranches().has('feat-wt'), out)
    assert.ok(remoteBranches().has('feat-lb'), out)
  })

  test('열린 PR 이 limit 만큼 읽히면 목록이 잘렸을 수 있어 건너뛰고 2 로 끝난다', () => {
    closedPr('feat-many', remoteOnly('feat-many'), 'MERGED', { number: 9 })
    fx.openHeads = Array.from({ length: 1000 }, (_, i) => `open-${i}`)
    const out = runSweep(['--remote-branches', '--apply'], { code: 2 })
    has(out, '원격 브랜치 정리 건너뜀: 열린 PR 이 1000 개 이상이라')
    assert.ok(remoteBranches().has('feat-many'), out)
    // 하나 적으면 다 읽은 목록이다
    fx.openHeads = fx.openHeads.slice(1)
    has(runSweep(['--remote-branches', '--apply']), '원격 브랜치 삭제 feat-many (#9 MERGED)')
    assert.ok(!remoteBranches().has('feat-many'))
  })

  test('내 PR 의 작성자를 정하지 못하면 아무것도 지우지 않고 2 로 끝난다', () => {
    fx.ghUser = ''
    closedPr('feat-m3', remoteOnly('feat-m3'), 'MERGED')
    const done = runSweepFull(['--remote-branches', '--apply'], { code: 2 })
    has(done.stderr, '내 PR 의 작성자를 정하지 못해')
    has(done.stdout, '원격 브랜치 정리 건너뜀')
    assert.ok(remoteBranches().has('feat-m3'), done.stdout)
    lacks(calls(), '--author')
  })

  test('옵션이 없으면 작성자도 닫힌 PR 도 읽지 않는다', () => {
    fx.ghUser = ''
    closedPr('feat-m4', remoteOnly('feat-m4'), 'MERGED')
    const out = runSweep(['--apply'])
    assert.ok(remoteBranches().has('feat-m4'), out)
    lacks(calls(), 'gh api user')
    lacks(calls(), '--author')
  })
})

// 이 Run 의 끝난 dispatch 와 그 터미널이 path 에 있다.
function finishedWorker(path: string): void {
  fx.workers = [
    {
      dispatchId: 'ctx_c',
      workerState: 'succeeded',
      dispatchStatus: 'completed',
      agentTerminalHandle: 'term_c',
      resource: { worktreeId: `x::${path}`, terminalHandle: 'term_c' },
    },
  ]
  fx.terminals = [{ handle: 'term_c', worktreePath: path }]
}

// 머지 없이 CLOSED 가 된 PR 의 워크트리. upstream 을 지우지 않으면 원격 브랜치가 남는다.
function closedWorktree(name: string, opts: { author?: string; dropUpstream?: boolean; intoBase?: boolean } = {}): string {
  const path = worktree(name)
  const head = git('-C', path, 'rev-parse', 'HEAD')
  if (opts.intoBase) git('-C', fx.repo, 'push', '-q', 'origin', `${head}:refs/heads/main`)
  if (opts.dropUpstream || opts.intoBase) git('-C', fx.repo, 'push', '-q', 'origin', '--delete', name)
  fx.prs[name] = ['CLOSED', head]
  fx.prAuthors[name] = opts.author ?? 'me'
  finishedWorker(path)
  return path
}

describe('머지 없이 CLOSED 가 된 PR 의 터미널', () => {
  beforeEach(() => {
    fx.ghUser = 'me'
  })

  test('내 PR 의 끝난 dispatch 터미널을 닫고 반납하되 원격에 없는 커밋이 있는 워크트리는 남긴다', () => {
    const path = closedWorktree('closed-a', { dropUpstream: true })
    fx.terminals.push({ handle: 'term_user_shell', worktreePath: path })
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, `남김 ${path}: upstream gone 이지만 base 에 없는 커밋 1 개`)
    has(out, '터미널 닫음 term_c (CLOSED #1)')
    has(calls(), 'orca terminal close --terminal term_c')
    has(calls(), 'orca orchestration worker-release --dispatch ctx_c')
    // 같은 경로의 다른 터미널은 닫지 않는다
    lacks(calls(), '--terminal term_user_shell')
    assert.ok(branches().has('closed-a'))
  })

  test('열린 PR 의 끝난 dispatch 터미널은 남긴다', () => {
    const path = worktree('open-a')
    fx.prs['open-a'] = ['OPEN', git('-C', path, 'rev-parse', 'HEAD')]
    fx.prAuthors['open-a'] = 'me'
    finishedWorker(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
    lacks(calls(), 'gh api user')
  })

  test('다른 작성자의 CLOSED PR 이면 터미널을 남긴다', () => {
    const path = closedWorktree('closed-theirs', { author: 'other' })
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
  })

  test('cherry 판정을 통과한 CLOSED PR 은 한 번 실행에 터미널을 닫고 워크트리를 지운다', () => {
    const path = closedWorktree('closed-folded', { intoBase: true })
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    has(out, `정리 ${path} (closed-folded, upstream gone, base 에 없는 커밋 0 개)`)
    has(calls(), 'orca terminal close --terminal term_c')
    has(calls(), 'orca orchestration worker-release --dispatch ctx_c')
    lacks(calls(), '--merged-head')
    assert.ok(!branches().has('closed-folded'))
  })

  test('upstream 이 남은 CLOSED PR 은 터미널만 닫고 워크트리를 남긴다', () => {
    const path = closedWorktree('closed-up')
    const dry = runSweep(['--run', 'run_x'])
    has(dry, '닫을 것: term_c (CLOSED #1)')
    lacks(calls(), 'terminal close')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, `남김 ${path}: PR CLOSED, upstream 이 남아 있다`)
    has(calls(), 'orca terminal close --terminal term_c')
    has(calls(), 'orca orchestration worker-release --dispatch ctx_c')
  })

  test('before-cleanup 이 거부하면 CLOSED PR 의 터미널도 닫지 않는다', () => {
    const path = closedWorktree('closed-hook', { intoBase: true })
    hook('before-cleanup', 10, '저장소가 남긴다')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, `남김 ${path}: 저장소 핸들러 거부`)
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
  })

  test('내 PR 의 작성자를 정하지 못하면 터미널을 닫지 않고 2 로 끝난다', () => {
    fx.ghUser = ''
    const path = closedWorktree('closed-unknown')
    const done = runSweepFull(['--run', 'run_x', '--apply'], { code: 2 })
    exists(path, done.stdout)
    has(done.stderr, '내 PR 의 작성자를 정하지 못해')
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
  })

  test('--run 이 없으면 CLOSED PR 의 터미널을 닫지 않는다', () => {
    const path = closedWorktree('closed-norun')
    const out = runSweep(['--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
    lacks(calls(), 'gh api user')
  })
})

describe('옛 경로', () => {
  test('cleanup-sweep.py 는 DEPRECATED 줄을 내고 cleanup-sweep.ts 로 넘긴다', () => {
    const path = worktree('shim-a')
    squashMerge('shim-a', path)
    save()
    const done = spawnSync('python3', [SHIM, '--repo', fx.repo, '--wait', '0.01', '--poll-interval', '0.01', '--apply'], { env: fx.env, encoding: 'utf8' })
    assert.equal(done.status, 0, done.stdout + done.stderr)
    has(done.stderr, 'DEPRECATED')
    has(done.stdout, `cleanup-sweep apply: ${fx.repo}`)
    gone(path, done.stdout)
  })
})
