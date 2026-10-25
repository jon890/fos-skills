// cleanup-sweep.ts 테스트 가운데 머지 판정, PR 커밋 목록, 다른 Run 의 터미널, PR 찾기을 본다.
// 가짜 실행 파일, 상태와 공통 도우미는 fixtures/cleanup-sweep.ts 가 소유한다.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { type Row, branches, calls, exists, freshGoneBranch, fx, git, gone, has, lacks, mergedWorkerWithTerminal, remoteBranches, renamedWorktree, runSweep, squashMerge, sweepCalls, worktree } from './fixtures/cleanup-sweep.ts'

describe('머지 판정과 기본 정리', () => {
  test('squash 머지된 worktree 를 터미널, dispatch, 지시서와 함께 정리한다', () => {
    const path = worktree('feat-a')
    squashMerge('feat-a', path)
    fx.terminals = [{ handle: 'term_a', worktreePath: path }]
    fx.workers = [{ dispatchId: 'ctx_a', workerState: 'succeeded', resource: { worktreeId: `x::${path}`, releaseState: 'retained' } }]
    const specs = join(fx.repo, '.orch/specs')
    mkdirSync(specs, { recursive: true })
    writeFileSync(join(specs, 'spec-feat-a.md'), 'x')
    writeFileSync(join(specs, 'spec-other.md'), 'x')
    const out = runSweep(['--run', 'run_x', '--specs-dir', '.orch/specs', '--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-a'))
    assert.ok(!existsSync(join(specs, 'spec-feat-a.md')))
    assert.ok(existsSync(join(specs, 'spec-other.md')))
    has(calls(), 'orca terminal close --terminal term_a')
    has(calls(), 'orca orchestration worker-release --dispatch ctx_a')
  })

  test('dry-run 은 아무것도 바꾸지 않는다', () => {
    const path = worktree('feat-a')
    squashMerge('feat-a', path)
    const out = runSweep()
    has(out, '정리')
    exists(path, out)
    assert.ok(branches().has('feat-a'))
  })

  test('OPEN PR 의 worktree 는 남긴다', () => {
    const path = worktree('feat-b')
    fx.prs['feat-b'] = ['OPEN', git('-C', path, 'rev-parse', 'HEAD')]
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '남김')
    assert.ok(remoteBranches().has('feat-b'))
  })

  test('커밋 안 된 변경이 있는 worktree 는 건너뛴다', () => {
    const path = worktree('feat-c')
    squashMerge('feat-c', path)
    writeFileSync(join(path, 'new.txt'), 'x')
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '커밋 안 된 변경')
  })

  test('머지된 PR HEAD 뒤에 커밋이 더해진 worktree 는 남긴다', () => {
    const path = worktree('feat-d')
    squashMerge('feat-d', path)
    writeFileSync(join(path, 'later.txt'), 'x')
    git('-C', path, 'add', '-A')
    git('-C', path, 'commit', '-q', '-m', 'later')
    const out = runSweep(['--apply'])
    exists(path, out)
    // 끝 커밋이 PR HEAD 의 조상이 아니므로 그 PR 의 브랜치로 보지 않고, base 에 없는 커밋이 있어 남긴다
    has(out, '남김')
    assert.ok(branches().has('feat-d'))
  })

  test('살아 있는 worker 의 worktree 는 건너뛴다', () => {
    const path = worktree('feat-e')
    squashMerge('feat-e', path)
    fx.workers = [{ dispatchId: 'ctx_e', workerState: 'working', resource: { worktreeId: `x::${path}` } }]
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '살아 있는 worker ctx_e')
  })

  test('프로세스가 쥔 경로는 다음 실행에서 다시 시도한다', () => {
    const path = worktree('feat-f')
    squashMerge('feat-f', path)
    fx.held = [path]
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '다음 실행에서 다시 시도')
    fx.held = []
    const again = runSweep(['--apply'])
    gone(path, again)
  })

  test('upstream 이 gone 이고 커밋이 base 에 있으면 PR 없이도 정리한다', () => {
    const path = worktree('feat-g')
    git('-C', fx.repo, 'merge', '-q', '--no-ff', '-m', 'merge g', 'feat-g')
    git('-C', fx.repo, 'push', '-q', 'origin', 'main')
    git('-C', fx.repo, 'push', '-q', 'origin', '--delete', 'feat-g')
    const out = runSweep(['--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-g'))
  })

  test('upstream 이 gone 이어도 base 에 없는 커밋이 있으면 남긴다', () => {
    const path = worktree('feat-h')
    git('-C', fx.repo, 'push', '-q', 'origin', '--delete', 'feat-h')
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, 'base 에 없는 커밋 1 개')
  })

  test('worktree 없는 로컬 브랜치를 원격과 함께 지운다', () => {
    const path = worktree('feat-i')
    const head = git('-C', path, 'rev-parse', 'HEAD')
    git('-C', fx.repo, 'worktree', 'remove', path)
    fx.prs['feat-i'] = ['MERGED', head]
    const out = runSweep(['--apply'])
    assert.ok(!branches().has('feat-i'), out)
    assert.ok(!remoteBranches().has('feat-i'))
  })

  test('release 브랜치는 건드리지 않는다', () => {
    const path = worktree('release/1.0')
    squashMerge('release/1.0', path)
    const out = runSweep(['--apply'])
    exists(path, out)
  })

  test('cherry 로 판정한 브랜치는 succeeded dispatch 의 터미널이 살아 있으면 살아 있는 worker 다', () => {
    const path = freshGoneBranch('prompt-fix')
    fx.workers = [{ dispatchId: 'ctx_p', workerState: 'succeeded', agentTerminalHandle: 'term_p', resource: { worktreeId: `x::${path}` } }]
    fx.terminals = [{ handle: 'term_p', worktreePath: path }]
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '살아 있는 worker ctx_p')
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
  })

  test('PR 이 MERGED 이고 worker 가 끝났으면 남은 터미널을 닫고 정리한다', () => {
    const path = mergedWorkerWithTerminal('sensor-fail', 'succeeded', 'completed')
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    has(calls(), 'terminal close --terminal term_s')
  })

  test('PR 이 MERGED 여도 working worker 의 worktree 는 남긴다', () => {
    const path = mergedWorkerWithTerminal('sensor-busy', 'working', 'dispatched')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '살아 있는 worker ctx_s')
    lacks(calls(), 'terminal close')
  })

  test('cherry 로 판정한 브랜치는 completed dispatch 의 터미널이 있으면 남긴다', () => {
    const path = freshGoneBranch('fresh-done')
    fx.workers = [{ dispatchId: 'ctx_s', workerState: 'succeeded', dispatchStatus: 'completed', agentTerminalHandle: 'term_s', resource: { worktreeId: `x::${path}` } }]
    fx.terminals = [{ handle: 'term_s', worktreePath: path }]
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '살아 있는 worker ctx_s')
    lacks(calls(), 'terminal close')
  })
})

// 머지 큐가 원격 PR 에 base 를 합치고(update-branch), 저장소가 merge commit 으로 머지한 상태를 만든다.
// PR HEAD 는 원격의 머지 커밋이라 로컬 브랜치 끝 커밋보다 앞서 가고, 머지 뒤 로컬 커밋은 모두 base 에 들어간다.
function updateBranchThenMergeCommit(name: string, path: string): void {
  const tip = git('-C', path, 'rev-parse', 'HEAD')
  writeFileSync(join(fx.repo, 'other.txt'), 'x')
  git('-C', fx.repo, 'add', '-A')
  git('-C', fx.repo, 'commit', '-q', '-m', 'base moved')
  git('-C', fx.repo, 'push', '-q', 'origin', 'main')
  const other = join(fx.tmp, 'queue-clone')
  git('clone', '-q', '-b', name, join(fx.tmp, 'repo-origin.git'), other)
  git('-C', other, 'merge', '-q', '--no-ff', '-m', 'update branch', 'origin/main')
  git('-C', other, 'push', '-q', 'origin', name)
  const head = git('-C', other, 'rev-parse', 'HEAD')
  git('-C', fx.repo, 'fetch', '-q', 'origin')
  git('-C', fx.repo, 'merge', '-q', '--no-ff', '-m', 'merge pr', `origin/${name}`)
  git('-C', fx.repo, 'push', '-q', 'origin', 'main')
  git('-C', fx.repo, 'push', '-q', 'origin', '--delete', name)
  fx.prs[name] = ['MERGED', head]
  fx.prCommits['1'] = [tip, head]
  assert.equal(git('-C', fx.repo, 'rev-list', '--count', `origin/main..${name}`), '0')
}

describe('PR 커밋 목록으로 브랜치 인정', () => {
  const finished = (path: string) => {
    fx.workers = [{ dispatchId: 'ctx_s', workerState: 'succeeded', dispatchStatus: 'completed', agentTerminalHandle: 'term_s', resource: { worktreeId: `x::${path}` } }]
    fx.terminals = [{ handle: 'term_s', worktreePath: path }]
  }

  test('update-branch 뒤 merge commit 으로 머지된 브랜치를 PR 커밋 목록으로 알아본다', () => {
    const path = worktree('feat-um')
    updateBranchThenMergeCommit('feat-um', path)
    finished(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    has(out, 'PR MERGED')
    gone(path, out)
    has(calls(), 'terminal close --terminal term_s')
    assert.ok(!branches().has('feat-um'))
  })

  test('옛 같은 이름 PR 이 있는 막 만든 브랜치는 알아보지 않는다', () => {
    const path = freshGoneBranch('feat-fresh')
    const oldHead = '0'.repeat(40)
    fx.prs['feat-fresh'] = ['MERGED', oldHead]
    fx.prCommits['1'] = [oldHead]
    finished(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '살아 있는 worker ctx_s')
    has(calls(), 'pr view 1 --json commits')
    lacks(calls(), 'terminal close')
  })

  test('PR 커밋 목록을 읽지 못하면 막 만든 브랜치를 남긴다', () => {
    const path = freshGoneBranch('feat-fresh2')
    fx.prs['feat-fresh2'] = ['MERGED', '0'.repeat(40)]
    finished(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
  })

  test('끝 커밋이 PR HEAD 와 같으면 커밋 목록을 읽지 않고 알아본다', () => {
    const path = mergedWorkerWithTerminal('feat-same', 'succeeded', 'completed')
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    has(calls(), 'terminal close --terminal term_s')
    lacks(calls(), 'pr view')
  })
})

// 머지된 워크트리에 다른 Run 의 worker 터미널이 붙어 있다. 이 Run 은 그 worker 를 모른다.
function foreignTerminalAt(name: string): string {
  const path = worktree(name)
  squashMerge(name, path)
  fx.terminals = [{ handle: 'term_codex', worktreePath: path }]
  fx.allWorkers = [{ runId: 'run_other', dispatchId: 'ctx_o', agentTerminalHandle: 'term_codex' }]
  return path
}

// 코디네이터 터미널에서 부른다. 범위 없는 worker-list 는 bound 만 주고, Run 은 run-list 로 하나씩 읽는다.
function boundToCoordinator(ownPath: string, other: Row[] = []): void {
  fx.env.ORCA_TERMINAL_HANDLE = 'term_coordinator'
  fx.pageSize = 1
  const own = { dispatchId: 'ctx_a', workerState: 'succeeded', agentTerminalHandle: 'term_mine', resource: { worktreeId: `x::${ownPath}`, terminalHandle: 'term_mine' } }
  fx.workers = [own]
  fx.runs = { run_x: [own, { dispatchId: 'ctx_old', workerState: 'succeeded' }], run_other: other, run_idle: [] }
}

describe('다른 Run 의 터미널', () => {
  test('다른 Run 의 터미널은 닫지 않는다', () => {
    const path = foreignTerminalAt('feat-o1')
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    exists(path, out)
    has(out, '다른 Run 의 worker 터미널 term_codex')
    lacks(calls(), 'terminal close')
    assert.ok(branches().has('feat-o1'))
  })

  test('다른 곳의 다른 Run worker 는 이 경로를 막지 않는다', () => {
    const path = foreignTerminalAt('feat-o2')
    fx.allWorkers.push({ runId: 'run_x', dispatchId: 'ctx_a', agentTerminalHandle: 'term_mine' })
    fx.terminals = [
      { handle: 'term_mine', worktreePath: path },
      { handle: 'term_codex', worktreePath: join(fx.tmp, 'elsewhere') },
    ]
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    has(calls(), 'orca terminal close --terminal term_mine')
    lacks(calls(), '--terminal term_codex')
  })

  test('bound 범위면 Run 마다 읽어 정리하되 정리 한 번에 한 번만 읽는다', () => {
    const path = worktree('feat-b1')
    squashMerge('feat-b1', path)
    fx.terminals = [
      { handle: 'term_mine', worktreePath: path },
      { handle: 'term_codex', worktreePath: join(fx.tmp, 'elsewhere') },
    ]
    boundToCoordinator(path, [{ dispatchId: 'ctx_o', agentTerminalHandle: 'term_codex' }])
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    lacks(out, '터미널 소유 상태 조회 실패')
    has(calls(), 'orca terminal close --terminal term_mine')
    // Run 목록과 Run 마다의 페이지를 끝까지 따라가되, 정리 한 번에 한 번만 읽는다
    assert.equal(sweepCalls('run-list').length, 3, calls())
    assert.equal(sweepCalls('--run run_other').length, 1, calls())
  })

  test('bound 범위에서도 다른 Run 의 터미널은 남긴다', () => {
    const path = worktree('feat-b2')
    squashMerge('feat-b2', path)
    fx.terminals = [{ handle: 'term_codex', worktreePath: path }]
    boundToCoordinator(path, [{ dispatchId: 'ctx_o', agentTerminalHandle: 'term_codex' }])
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '다른 Run 의 worker 터미널 term_codex')
    lacks(calls(), 'terminal close')
  })

  test('bound 범위에서 다른 Run 의 사용자 보유 터미널은 남긴다', () => {
    const path = worktree('feat-b3')
    squashMerge('feat-b3', path)
    fx.terminals = [{ handle: 'term_user', worktreePath: path }]
    boundToCoordinator(path, [
      { dispatchId: 'ctx_o', agentTerminalHandle: 'term_user', terminalState: 'retained', resource: { terminalHandle: 'term_user', ownershipState: 'user_owned' } },
    ])
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '남김: 사용자 보유 터미널')
    lacks(calls(), 'terminal close')
  })

  test('bound 범위에서 Run 하나를 읽지 못하면 경로를 남긴다', () => {
    const path = worktree('feat-b4')
    squashMerge('feat-b4', path)
    fx.terminals = [{ handle: 'term_mine', worktreePath: path }]
    boundToCoordinator(path)
    ;(fx.runs as Record<string, Row[] | null>).run_other = null
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })

  test('Run 목록을 읽지 못하면 모르는 터미널을 남긴다', () => {
    const path = foreignTerminalAt('feat-o3')
    fx.scope = 'bound'
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })

  test('--run 이 없으면 예전처럼 경로로 터미널을 찾는다', () => {
    const path = foreignTerminalAt('feat-o5')
    const out = runSweep(['--apply'])
    gone(path, out)
    has(calls(), 'orca terminal close --terminal term_codex')
    has(calls(), 'worker-list --limit 100')
  })

  test('PR 이 MERGED 가 아니면 터미널을 닫지 않는다', () => {
    const path = freshGoneBranch('fresh')
    fx.terminals = [{ handle: 'term_f', worktreePath: path }]
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '살아 있는 터미널')
    lacks(calls(), 'terminal close')
  })

  test('터미널 목록을 읽지 못하면 아무것도 건드리지 않고 2 로 끝난다', () => {
    const path = worktree('feat-x')
    squashMerge('feat-x', path)
    fx.orcaFail = true
    runSweep(['--apply'], { code: 2 })
    assert.ok(existsSync(path))
  })
})

describe('PR 찾기', () => {
  test('PR HEAD 가 worktree HEAD 보다 앞서면 받아 와 merged-head 로 넘긴다', () => {
    const path = worktree('feat-j')
    const other = join(fx.tmp, 'other')
    git('clone', '-q', '-b', 'feat-j', join(fx.tmp, 'repo-origin.git'), other)
    writeFileSync(join(other, 'update.txt'), 'x')
    git('-C', other, 'add', '-A')
    git('-C', other, 'commit', '-q', '-m', 'Merge branch main into feat-j')
    const ahead = git('-C', other, 'rev-parse', 'HEAD')
    git('-C', other, 'push', '-q', 'origin', `${ahead}:refs/pull/1/head`)
    git('-C', other, 'push', '-q', 'origin', ':feat-j')
    fx.prs['feat-j'] = ['MERGED', ahead]
    assert.notEqual(git('-C', path, 'rev-parse', 'HEAD'), ahead)
    const out = runSweep(['--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-j'))
  })

  test('upstream 이름으로 PR 을 찾고 원격 브랜치를 지운다', () => {
    const path = renamedWorktree('dev/proj-topic', 'proj/topic')
    fx.prs['proj/topic'] = ['MERGED', git('-C', path, 'rev-parse', 'HEAD')]
    const out = runSweep(['--apply'])
    gone(path, out)
    assert.ok(!branches().has('dev/proj-topic'))
    assert.ok(!remoteBranches().has('proj/topic'))
    has(calls(), '--head proj/topic')
    lacks(calls(), '--head dev/proj-topic')
  })

  test('upstream 이 없으면 이름 변형으로 PR 을 찾는다', () => {
    const path = renamedWorktree('dev/proj-topic', 'proj/topic', false)
    git('-C', fx.repo, 'push', '-q', 'origin', '--delete', 'proj/topic')
    fx.prs['proj/topic'] = ['MERGED', git('-C', path, 'rev-parse', 'HEAD')]
    const out = runSweep(['--apply'])
    gone(path, out)
  })

  test('브랜치를 담지 않은 이름 변형 PR 은 무시한다', () => {
    const path = worktree('dev/topic')
    fx.prs.topic = ['MERGED', git('-C', fx.repo, 'rev-parse', 'origin/main')]
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '남김')
  })

  test('새 커밋이 더해진 원격 브랜치는 남긴다', () => {
    const path = renamedWorktree('dev/proj-b', 'proj/b')
    const head = git('-C', path, 'rev-parse', 'HEAD')
    git('-C', fx.repo, 'worktree', 'remove', path)
    const other = join(fx.tmp, 'other')
    git('clone', '-q', '-b', 'proj/b', join(fx.tmp, 'repo-origin.git'), other)
    writeFileSync(join(other, 'more.txt'), 'x')
    git('-C', other, 'add', '-A')
    git('-C', other, 'commit', '-q', '-m', 'more')
    git('-C', other, 'push', '-q', 'origin', 'proj/b')
    fx.prs['proj/b'] = ['MERGED', head]
    const out = runSweep(['--apply'])
    assert.ok(!branches().has('dev/proj-b'), out)
    assert.ok(remoteBranches().has('proj/b'))
    has(out, '끝점이 머지된 커밋과 다르다')
  })

  test('fork 에서 온 PR 은 맞지 않는다', () => {
    const path = worktree('feat-k')
    fx.prs['feat-k'] = ['MERGED', git('-C', path, 'rev-parse', 'HEAD'), true]
    const out = runSweep(['--apply'])
    exists(path, out)
  })

  test('빈 PR 조회는 PR 없음이고 worktree 를 남긴다', () => {
    const path = worktree('feat-l')
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, 'PR 없음')
    assert.ok(remoteBranches().has('feat-l'))
  })

  test('null 글자 조회는 머지가 아니다', () => {
    const path = worktree('feat-m')
    for (const name of ['feat-m', 'feat/m']) fx.ghRaw[name] = 'null'
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '조회 실패')
    assert.ok(branches().has('feat-m'))
  })

  test('gh 가 실패하면 worktree 와 브랜치를 남긴다', () => {
    const path = worktree('feat-n')
    fx.ghFail = true
    runSweep(['--apply'])
    assert.ok(existsSync(path))
    assert.ok(branches().has('feat-n'))
  })
})
