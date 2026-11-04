// cleanup-sweep.ts 테스트 가운데 저장소 여러 개, detached 워크트리, 하위 에이전트, 지시서와 기준 브랜치을 본다.
// 가짜 실행 파일, 상태와 공통 도우미는 fixtures/cleanup-sweep.ts 가 소유한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { REMOVE, branches, calls, exists, fx, git, gone, has, idleShell, lacks, makeRepo, remoteBranches, renamedWorktree, runSweep, save, squashMerge, worktree } from './fixtures/cleanup-sweep.ts'

// 그 이름의 PR 이 예전에 squash 머지되고 브랜치와 워크트리가 지워진 상태. 옛 PR HEAD 를 돌려준다.
function oldMergedPr(name: string): string {
  const old = worktree(name)
  const head = squashMerge(name, old)
  git('-C', fx.repo, 'worktree', 'remove', old)
  git('-C', fx.repo, 'branch', '-D', name)
  const main = join(fx.tmp, 'main-clone')
  git('clone', '-q', join(fx.tmp, 'repo-origin.git'), main)
  writeFileSync(join(main, 'squash.txt'), name)
  git('-C', main, 'add', '-A')
  git('-C', main, 'commit', '-q', '-m', `squash ${name}`)
  git('-C', main, 'push', '-q', 'origin', 'main')
  git('-C', fx.repo, 'fetch', '-q', 'origin')
  rmSync(main, { recursive: true, force: true })
  return head
}

describe('저장소 여러 개, 남은 브랜치, 이름만 같은 PR', () => {
  test('저장소 여러 개를 한 번에 정리한다', () => {
    const second = makeRepo('second')
    const a = worktree('feat-s1')
    const b = worktree('feat-s2', { repo: second })
    squashMerge('feat-s1', a)
    git('-C', second, 'push', '-q', 'origin', '--delete', 'feat-s2')
    fx.prs['feat-s2'] = ['MERGED', git('-C', b, 'rev-parse', 'HEAD')]
    const out = runSweep(['--apply'], { repos: [fx.repo, second] })
    gone(a, out)
    gone(b, out)
    has(out, second)
    assert.ok(calls().includes('terminal list'))
  })

  test('읽지 못한 저장소가 있어도 나머지를 정리하고 2 로 끝난다', () => {
    const a = worktree('feat-t')
    squashMerge('feat-t', a)
    const out = runSweep(['--apply'], { repos: [join(fx.tmp, 'missing'), fx.repo], code: 2 })
    gone(a, out)
  })

  test('worktree 없는 머지된 로컬 브랜치의 이름이 다른 원격 브랜치를 지운다', () => {
    const path = renamedWorktree('dev/proj-c', 'proj/c')
    const head = git('-C', path, 'rev-parse', 'HEAD')
    git('-C', fx.repo, 'worktree', 'remove', path)
    fx.prs['proj/c'] = ['MERGED', head]
    const out = runSweep(['--apply'])
    assert.ok(!branches().has('dev/proj-c'), out)
    assert.ok(!remoteBranches().has('proj/c'))
  })

  test('열린 PR 의 base 인 브랜치는 남긴다', () => {
    const path = worktree('feat-u')
    const head = git('-C', path, 'rev-parse', 'HEAD')
    git('-C', fx.repo, 'worktree', 'remove', path)
    fx.prs['feat-u'] = ['MERGED', head]
    fx.openBases = ['feat-u']
    const out = runSweep(['--apply'])
    assert.ok(branches().has('feat-u'), out)
    assert.ok(remoteBranches().has('feat-u'))
  })

  test('옛 머지된 PR 과 이름이 같은 새 브랜치는 남긴다', () => {
    oldMergedPr('feature/x')
    const path = worktree('feature/x', { commits: 0 })
    const out = runSweep(['--apply'])
    exists(path, out)
    assert.ok(branches().has('feature/x'))
    assert.ok(remoteBranches().has('feature/x'))
    has(out, '이름만 같은 PR')
    lacks(calls(), '--merged-head')
  })

  test('자기 커밋이 있고 옛 PR 이름을 쓴 새 브랜치도 남긴다', () => {
    oldMergedPr('feature/x')
    const path = worktree('feature/x', { push: false })
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '이름만 같은 PR')
  })

  test('갱신하지 않은 base 에서 옛 PR 이름으로 만든 브랜치도 남긴다', () => {
    // 갱신하지 않은 base 에서 만든 브랜치의 끝 커밋은 옛 PR HEAD 의 조상이다. base 위 커밋이 0 개라 새 브랜치로 본다
    const stale = git('-C', fx.repo, 'rev-parse', 'origin/main')
    oldMergedPr('feature/x')
    const path = join(fx.wts, 'feature-x-new')
    git('-C', fx.repo, 'worktree', 'add', '-q', '-b', 'feature/x', path, stale)
    const out = runSweep(['--apply'])
    exists(path, out)
    assert.ok(branches().has('feature/x'))
  })

  test('PR HEAD 가 브랜치 끝인 merge commit PR 은 정리한다', () => {
    // 일반 merge 는 브랜치 커밋이 base 에 들어가 base 위 커밋이 0 개가 된다. 끝 커밋이 PR HEAD 와 같으면 머지로 본다
    const path = worktree('feat-v')
    const head = git('-C', path, 'rev-parse', 'HEAD')
    git('-C', fx.repo, 'merge', '-q', '--no-ff', '-m', 'merge v', 'feat-v')
    git('-C', fx.repo, 'push', '-q', 'origin', 'main')
    fx.prs['feat-v'] = ['MERGED', head]
    const out = runSweep(['--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-v'))
  })

  test('remove-worktree 는 HEAD 가 merged-head 의 조상이 아니면 거부한다', () => {
    const head = oldMergedPr('feature/x')
    const path = worktree('feature/x', { commits: 0 })
    save()
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', REMOVE, path, '--delete-branch', '--merged-head', head], {
      env: fx.env,
      encoding: 'utf8',
    })
    assert.equal(done.status, 1, done.stdout + done.stderr)
    has(done.stdout, '조상도 아니다')
    assert.ok(existsSync(path))
  })
})

// 임시 폴더에 만든 detached 워크트리. push 가 false 면 HEAD 가 원격에 없는 커밋이다.
function detached(name: string, push = true): string {
  const path = join(fx.tmp, 'scratch', name)
  git('-C', fx.repo, 'worktree', 'add', '-q', '--detach', path, 'origin/main')
  if (!push) git('-C', path, 'commit', '-q', '--allow-empty', '-m', 'local only')
  return path
}

describe('저장소 밖 detached 워크트리', () => {
  test('저장소 밖 detached 워크트리를 지운다', () => {
    const path = detached('baseline')
    const out = runSweep(['--apply'])
    gone(path, out)
    has(out, 'detached 워크트리 삭제')
    lacks(git('-C', fx.repo, 'worktree', 'list'), path)
  })

  test('dry-run 은 남긴다', () => {
    const path = detached('baseline-dry')
    const out = runSweep()
    exists(path, out)
    has(out, 'detached 워크트리를 지울 것')
  })

  test('변경, 프로세스, 터미널, 로컬 커밋이 있으면 남긴다', () => {
    const dirtyPath = detached('d-dirty')
    writeFileSync(join(dirtyPath, 'x.txt'), 'x')
    const heldPath = detached('d-held')
    fx.held = [heldPath]
    const termPath = detached('d-term')
    fx.terminals = [{ handle: 'term_d', worktreePath: termPath }]
    const localPath = detached('d-local', false)
    const out = runSweep(['--apply'])
    for (const path of [dirtyPath, heldPath, termPath, localPath]) exists(path, out)
    has(out, `건너뜀 detached ${dirtyPath}: 커밋 안 된 변경`)
    has(out, `건너뜀 detached ${heldPath}: 그 경로를 쓰는 프로세스`)
    has(out, `건너뜀 detached ${termPath}: Orca 터미널이 있다`)
    has(out, `건너뜀 detached ${localPath}: HEAD 가 원격에 없다`)
  })

  test('저장소 안의 detached 워크트리는 그대로 둔다', () => {
    const path = join(fx.repo, 'worktrees', 'repo', 'tmp-check')
    git('-C', fx.repo, 'worktree', 'add', '-q', '--detach', path, 'origin/main')
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '브랜치가 없다(detached)')
  })

  test('지워진 폴더의 등록을 먼저 prune 한다', () => {
    const path = detached('gone')
    rmSync(path, { recursive: true, force: true })
    const dry = runSweep()
    has(dry, 'prune: Removing worktrees/gone')
    has(git('-C', fx.repo, 'worktree', 'list'), path)
    const out = runSweep(['--apply'])
    has(out, 'prune: Removing worktrees/gone')
    lacks(git('-C', fx.repo, 'worktree', 'list'), path)
  })
})

function agentWithShell(name: string, child = false): string {
  const path = worktree(name)
  squashMerge(name, path)
  const shell = idleShell(path, 'term_agent', child)
  fx.terminals = [{ handle: 'term_agent', worktreePath: path }]
  fx.processes = shell.processes
  // 모든 Run 범위를 읽지 못해 이 터미널이 누구 것인지 모른다
  fx.scope = 'bound'
  return path
}

function mergedWithSpecs(name: string): { path: string; specs: string } {
  const path = worktree(name)
  squashMerge(name, path)
  const specs = join(fx.repo, '.orch/specs')
  mkdirSync(specs, { recursive: true })
  writeFileSync(join(specs, `spec-${name}.md`), 'x')
  return { path, specs }
}

describe('하위 에이전트 워크트리와 사용자 보유 터미널', () => {
  test('모든 Run 을 읽지 못하면 하위 에이전트 워크트리의 빈 셸도 남긴다', () => {
    const path = agentWithShell('agent-a1')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })

  test('머지됐어도 사용자 보유 터미널이 있으면 아무것도 정리하지 않는다', () => {
    const { path, specs } = mergedWithSpecs('user-owned')
    fx.terminals = [{ handle: 'term_user', worktreePath: path }]
    fx.allWorkers = [{ agentTerminalHandle: 'term_user', resource: { terminalHandle: 'term_user', ownershipState: 'user_owned' } }]
    const out = runSweep(['--apply', '--kill-holders', '--specs-dir', specs])
    exists(path, out)
    has(out, '남김: 사용자 보유 터미널')
    assert.ok(branches().has('user-owned'))
    assert.ok(existsSync(join(specs, 'spec-user-owned.md')))
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
  })

  test('remove-worktree 를 바로 불러도 사용자 보유 터미널을 남긴다', () => {
    const path = worktree('direct-user')
    fx.terminals = [{ handle: 'term_user', worktreePath: path }]
    fx.allWorkers = [{ agentTerminalHandle: 'term_user', resource: { ownershipState: 'user_owned' } }]
    save()
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', REMOVE, path, '--delete-branch'], { env: fx.env, encoding: 'utf8' })
    assert.equal(done.status, 1, done.stdout + done.stderr)
    has(done.stdout, '남김: 사용자 보유 터미널')
    assert.ok(existsSync(path))
  })

  test('자식이 도는 하위 에이전트 터미널은 남긴다', () => {
    const path = agentWithShell('agent-a2', true)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })

  test('glob 밖의 빈 셸은 여전히 누구 것인지 모른다', () => {
    const path = agentWithShell('feat-a3')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
  })

  test('--agent-glob 이 패턴을 바꾼다', () => {
    const path = agentWithShell('sub-a4')
    fx.scope = 'all'
    const out = runSweep(['--run', 'run_x', '--agent-glob', 'sub-*', '--apply'])
    gone(path, out)
  })

  test('다른 Run 의 worker 로 확인된 터미널이 있는 하위 에이전트 경로는 남긴다', () => {
    const path = agentWithShell('agent-a5')
    fx.scope = 'all'
    fx.allWorkers = [{ runId: 'run_other', dispatchId: 'ctx_o', agentTerminalHandle: 'term_agent' }]
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '다른 Run 의 worker 터미널 term_agent')
  })
})

describe('지시서, PR 본문, 기준 브랜치', () => {
  test('살아 있는 dispatch 의 지시서는 남긴다', () => {
    // 브랜치가 머지돼도 그 지시서로 아직 일하는 worker 가 있다
    const { path, specs } = mergedWithSpecs('feat-live')
    const spec = join(specs, 'spec-feat-live.md')
    fx.tasks = [{ id: 'task_1', status: 'dispatched', spec: `지시서 ${spec} 를 끝까지 읽고 수행한다.` }]
    const out = runSweep(['--specs-dir', '.orch/specs', '--apply'])
    gone(path, out)
    exists(spec, out)
    has(out, '살아 있는 dispatch 가 쓴다')
  })

  test('끝난 Task 의 지시서는 지운다', () => {
    const { specs } = mergedWithSpecs('feat-done')
    const spec = join(specs, 'spec-feat-done.md')
    fx.tasks = [{ id: 'task_1', status: 'completed', spec: `지시서 ${spec} 를 끝까지 읽고 수행한다.` }]
    const out = runSweep(['--specs-dir', '.orch/specs', '--apply'])
    gone(spec, out)
  })

  // launch-worker 가 남기는 기록과 같은 꼴이다(lib/launched.ts)
  function launched(dispatch: string, path: string, spec: string): void {
    const dir = join(fx.repo, '.orch/state/launched-workers')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${dispatch}.json`), JSON.stringify({ dispatch, task: `task_${dispatch}`, terminal: null, worktree: path, run: null, spec }))
  }

  test('워크트리를 지우면 기록된 지시서를 이름과 상관없이 휴지통으로 옮기고 기록을 지운다', () => {
    const { path, specs } = mergedWithSpecs('feat-rec')
    const resume = join(specs, 'spec-feat-rec-resume.md')
    const conflict = join(specs, 'spec-conflict-9-abc.md')
    const other = join(specs, 'spec-unrelated.md')
    for (const file of [resume, conflict, other]) writeFileSync(file, 'x')
    launched('ctx_a', path, join(specs, 'spec-feat-rec.md'))
    launched('ctx_b', path, resume)
    launched('ctx_c', path, conflict)
    const trash = join(fx.tmp, 'trash-s')
    const out = runSweep(['--specs-dir', '.orch/specs', '--trash', trash, '--apply'])
    gone(path, out)
    for (const file of [resume, conflict, join(specs, 'spec-feat-rec.md')]) gone(file, out)
    assert.ok(existsSync(join(trash, '.orch', 'specs', 'spec-feat-rec-resume.md')), out)
    assert.ok(existsSync(join(trash, '.orch', 'specs', 'spec-conflict-9-abc.md')), out)
    // 기록에 없는 지시서는 건드리지 않는다
    exists(other, out)
    assert.deepEqual(readdirSync(join(fx.repo, '.orch/state/launched-workers')), [])
  })

  test('기록된 지시서도 살아 있는 dispatch 가 쓰면 남긴다', () => {
    const { path, specs } = mergedWithSpecs('feat-rec-live')
    const follow = join(specs, 'spec-follow-up.md')
    writeFileSync(follow, 'x')
    launched('ctx_f', path, follow)
    fx.tasks = [{ id: 'task_2', status: 'dispatched', spec: `지시서 ${follow} 를 끝까지 읽고 수행한다.` }]
    const out = runSweep(['--specs-dir', '.orch/specs', '--trash', join(fx.tmp, 'trash-l'), '--apply'])
    gone(path, out)
    exists(follow, out)
    has(out, '살아 있는 dispatch 가 쓴다')
  })

  test('dry-run 은 기록된 지시서를 옮길 것만 낸다', () => {
    const { path, specs } = mergedWithSpecs('feat-rec-dry')
    const resume = join(specs, 'spec-feat-rec-dry-resume.md')
    writeFileSync(resume, 'x')
    launched('ctx_d', path, resume)
    const out = runSweep(['--specs-dir', '.orch/specs', '--trash', join(fx.tmp, 'trash-d')])
    has(out, `휴지통으로 옮길 것 ${resume}`)
    exists(resume, out)
  })

  test('살아 있는 dispatch 를 읽지 못하면 지시서를 남긴다', () => {
    const { path, specs } = mergedWithSpecs('feat-unknown')
    fx.tasksFail = true
    const out = runSweep(['--specs-dir', '.orch/specs', '--apply'])
    gone(path, out)
    assert.ok(existsSync(join(specs, 'spec-feat-unknown.md')))
    has(out, '목록을 읽지 못했다')
  })

  test('살아 있는 지시서 목록을 읽지 못하면 PR 본문도 남긴다', () => {
    const path = worktree('mac/kept')
    squashMerge('mac/kept', path)
    const orch = join(fx.repo, '.orch')
    mkdirSync(join(orch, 'specs'), { recursive: true })
    const spec = join(orch, 'specs', 'spec-kept.md')
    const body = join(orch, 'pr-mac-kept.md')
    writeFileSync(spec, 'x')
    writeFileSync(body, 'x')
    fx.tasksFail = true
    const out = runSweep(['--specs-dir', '.orch/specs', '--apply'])
    gone(path, out)
    exists(spec, out)
    exists(body, out)
    has(out, `  지시서를 남긴다 ${spec}: 살아 있는 지시서 목록을 읽지 못했다`)
    has(out, `  PR 본문을 남긴다 ${body}: 살아 있는 지시서 목록을 읽지 못했다`)
  })

  test('지시서 폴더 옆의 PR 본문 파일을 지운다', () => {
    const path = worktree('mac/body')
    squashMerge('mac/body', path)
    const orch = join(fx.repo, '.orch')
    mkdirSync(join(orch, 'specs'), { recursive: true })
    for (const name of ['pr-body.md', 'pr-mac-body.md', 'pr-1.md', 'pr-other.md']) writeFileSync(join(orch, name), 'x')
    const dry = runSweep(['--specs-dir', '.orch/specs'])
    has(dry, `PR 본문을 지울 것 ${join(orch, 'pr-mac-body.md')}`)
    runSweep(['--specs-dir', '.orch/specs', '--apply'])
    const left = readdirSync(orch)
      .filter((name) => name.startsWith('pr-') && name.endsWith('.md'))
      .sort()
    assert.deepEqual(left, ['pr-other.md'])
  })

  test('기준 브랜치를 fast-forward 한다', () => {
    const other = join(fx.tmp, 'other')
    git('clone', '-q', join(fx.tmp, 'repo-origin.git'), other)
    git('-C', other, 'commit', '-q', '--allow-empty', '-m', 'ahead')
    git('-C', other, 'push', '-q', 'origin', 'main')
    const remote = git('-C', other, 'rev-parse', 'HEAD')
    const dry = runSweep()
    has(dry, 'fast-forward 할 것 main')
    assert.notEqual(git('-C', fx.repo, 'rev-parse', 'HEAD'), remote)
    const out = runSweep(['--apply'])
    has(out, '기준 브랜치 fast-forward main')
    assert.equal(git('-C', fx.repo, 'rev-parse', 'HEAD'), remote)
  })

  test('로컬 커밋이 있는 기준 브랜치는 그대로 둔다', () => {
    git('-C', fx.repo, 'commit', '-q', '--allow-empty', '-m', 'local')
    const head = git('-C', fx.repo, 'rev-parse', 'HEAD')
    const out = runSweep(['--apply'])
    has(out, 'origin/main 에 없는 커밋이 있다')
    assert.equal(git('-C', fx.repo, 'rev-parse', 'HEAD'), head)
  })
})
