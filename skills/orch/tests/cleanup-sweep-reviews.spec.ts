// cleanup-sweep.ts 테스트 가운데 리뷰 worker 의 흔적(pr-N, review/pr-N 브랜치와 리뷰 지시서) 정리를 본다.
// 가짜 실행 파일, 상태와 공통 도우미는 fixtures/cleanup-sweep.ts 가 소유한다.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { branches, fx, git, has, lacks, runSweep } from './fixtures/cleanup-sweep.ts'
import { recordLaunch } from '../scripts/lib/launched.ts'

// 원격에 PR head 를 올리고(refs/pull/<n>/head) 그 커밋을 돌려준다. fetch 는 하지 않는다
function prHead(n: number): string {
  const other = join(fx.tmp, `pr-${n}-clone`)
  git('clone', '-q', join(fx.tmp, 'repo-origin.git'), other)
  git('-C', other, 'commit', '-q', '--allow-empty', '-m', `pr ${n}`)
  git('-C', other, 'push', '-q', 'origin', `HEAD:refs/pull/${n}/head`)
  return git('-C', other, 'rev-parse', 'HEAD')
}

// 옛 리뷰 지시서처럼 `git fetch origin pull/N/head:pr-N` 으로 공유 저장소에 만든 브랜치
function fetchedBranch(n: number): string {
  const head = prHead(n)
  git('-C', fx.repo, 'fetch', '-q', 'origin', `refs/pull/${n}/head:pr-${n}`)
  return head
}

function specsDir(): string {
  const dir = join(fx.repo, '.orch', 'specs')
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('리뷰 흔적', () => {
  test('MERGED, CLOSED PR 의 pr-N 과 review/pr-N 브랜치를 지우고 OPEN PR 의 것은 남긴다', () => {
    const merged = fetchedBranch(11)
    fx.prViews['11'] = { state: 'MERGED', headRefOid: merged }
    git('-C', fx.repo, 'branch', 'review/pr-12', 'origin/main')
    git('-C', fx.repo, 'branch', 'review/pr-12-3', 'origin/main')
    fx.prViews['12'] = { state: 'CLOSED', headRefOid: prHead(12) }
    git('-C', fx.repo, 'branch', 'review/pr-13', 'origin/main')
    fx.prViews['13'] = { state: 'OPEN' }
    const dry = runSweep()
    has(dry, '리뷰 브랜치를 지울 것 pr-11 (#11 MERGED)')
    has(dry, '리뷰 브랜치를 지울 것 review/pr-12-3 (#12 CLOSED)')
    assert.ok(branches().has('pr-11'), 'dry-run 이 지웠다')
    const out = runSweep(['--apply'])
    has(out, '리뷰 브랜치 삭제 pr-11 (#11 MERGED)')
    has(out, '리뷰 브랜치 삭제 review/pr-12 (#12 CLOSED)')
    const left = branches()
    assert.deepEqual(['pr-11', 'review/pr-12', 'review/pr-12-3', 'review/pr-13'].filter((b) => left.has(b)), ['review/pr-13'])
    lacks(out, '#13')
  })

  test('리뷰 지시서는 이름이나 리뷰 PR 줄로 찾아 지우고, 리뷰가 아닌 지시서는 남긴다', () => {
    const dir = specsDir()
    fx.prViews['21'] = { state: 'MERGED', headRefOid: prHead(21) }
    const named = join(dir, 'spec-review-pr-21.md')
    const again = join(dir, 'spec-review-pr-21-2.md')
    const lined = join(dir, 'spec-recheck.md')
    const other = join(dir, 'spec-feature.md')
    writeFileSync(named, '# 리뷰\n')
    writeFileSync(again, '# 다시 리뷰\n')
    writeFileSync(lined, '# 리뷰\n\n- **리뷰 PR:** #21\n')
    writeFileSync(other, '# 기능\n\n브랜치: `feat-x`\n')
    const out = runSweep(['--specs-dir', '.orch/specs', '--apply'])
    for (const file of [named, again, lined]) has(out, `지시서 삭제 ${file}`)
    assert.deepEqual([named, again, lined, other].map((file) => existsSync(file)), [false, false, false, true])
  })

  test('살아 있는 dispatch 가 그 PR 의 리뷰 지시서를 쓰면 브랜치와 지시서를 모두 남긴다', () => {
    const dir = specsDir()
    const head = fetchedBranch(31)
    fx.prViews['31'] = { state: 'MERGED', headRefOid: head }
    const spec = join(dir, 'spec-review-pr-31.md')
    writeFileSync(spec, '# 리뷰\n')
    fx.tasks = [{ id: 'task_r', status: 'running', spec: `지시서 ${spec} 를 끝까지 읽는다` }]
    const out = runSweep(['--specs-dir', '.orch/specs', '--apply'])
    has(out, '리뷰 흔적 남김 #31: 리뷰 dispatch 가 살아 있다')
    assert.ok(branches().has('pr-31'))
    assert.ok(existsSync(spec))
  })

  test('살아 있는 지시서 목록을 읽지 못하면 남긴다', () => {
    git('-C', fx.repo, 'branch', 'review/pr-41', 'origin/main')
    fx.prViews['41'] = { state: 'CLOSED' }
    fx.tasksFail = true
    const out = runSweep(['--apply'])
    has(out, '리뷰 흔적 남김 #41: 살아 있는 지시서 목록을 읽지 못했다')
    assert.ok(branches().has('review/pr-41'))
  })

  test('PR 을 읽지 못하면 남긴다', () => {
    git('-C', fx.repo, 'branch', 'review/pr-51', 'origin/main')
    const out = runSweep(['--apply'])
    has(out, '리뷰 흔적 남김 #51: PR 을 읽지 못했다')
    assert.ok(branches().has('review/pr-51'))
  })

  test('기준 브랜치에도 PR head 에도 없는 커밋이 있는 리뷰 브랜치는 남긴다', () => {
    const head = fetchedBranch(61)
    fx.prViews['61'] = { state: 'MERGED', headRefOid: head }
    const path = join(fx.wts, 'scratch-61')
    git('-C', fx.repo, 'worktree', 'add', '-q', path, 'pr-61')
    git('-C', path, 'commit', '-q', '--allow-empty', '-m', 'reviewer local commit')
    git('-C', fx.repo, 'worktree', 'remove', path)
    const out = runSweep(['--apply'])
    has(out, '리뷰 브랜치 남김 pr-61: 기준 브랜치에도 PR head 에도 없는 커밋이 있다')
    assert.ok(branches().has('pr-61'))
  })

  // launch-worker 처럼 review/pr-<n> 브랜치로 워크트리를 만들고 PR head 를 detached 로 꺼낸다
  function reviewWorktree(n: number): string {
    const path = join(fx.wts, `review-pr-${n}`)
    git('-C', fx.repo, 'worktree', 'add', '-q', '-b', `review/pr-${n}`, path, 'origin/main')
    git('-C', path, 'fetch', '-q', 'origin', `refs/pull/${n}/head`)
    git('-C', path, 'checkout', '-q', '--detach', 'FETCH_HEAD')
    return path
  }

  test('끝난 리뷰의 변경 없는 detached 워크트리를 지우고 그것을 만든 review/pr-N 브랜치도 지운다', () => {
    fx.prViews['71'] = { state: 'MERGED', headRefOid: prHead(71) }
    const path = reviewWorktree(71)
    const dry = runSweep()
    has(dry, `리뷰 워크트리를 지울 것 ${path} (#71)`)
    assert.ok(existsSync(path), 'dry-run 이 지웠다')
    const out = runSweep(['--apply'])
    has(out, `리뷰 워크트리 삭제 ${path} (#71)`)
    has(out, '리뷰 브랜치 삭제 review/pr-71 (#71 MERGED)')
    lacks(out, '브랜치가 없다(detached)')
    assert.ok(!existsSync(path))
    assert.ok(!branches().has('review/pr-71'))
  })

  test('PR 이 열려 있어도 리뷰가 끝났으면 워크트리는 지우고 브랜치는 남긴다', () => {
    fx.prViews['72'] = { state: 'OPEN', headRefOid: prHead(72) }
    const path = reviewWorktree(72)
    const out = runSweep(['--apply'])
    has(out, `리뷰 워크트리 삭제 ${path} (#72)`)
    assert.ok(branches().has('review/pr-72'))
  })

  // 다른 Run 의 살아 있는 dispatch 가 그 경로를 이어 쓴다. --run current 의 worker 목록에는 없다
  function reusedBy(path: string, row: Record<string, unknown>): void {
    const full = { runId: 'run_other', taskId: 'task_other', dispatchId: 'ctx_other', dispatchStatus: 'running', workerState: 'working', resource: { ownershipState: 'owned', worktreeId: `repo::${path}` }, ...row }
    fx.runs = { run_current: [], run_other: [full] }
    fx.allWorkers = [full]
  }

  test('다른 Run 의 살아 있는 dispatch 가 옛 리뷰 워크트리를 이어 쓰면 남긴다', () => {
    const cases: [number, string, Record<string, unknown>, (path: string) => void][] = [
      // 다른 PR 의 리뷰가 옛 리뷰 워크트리를 재사용한다. 지시서 번호(77)로는 옛 리뷰가 리뷰가 끝난 것으로 보인다
      [76, '다른 PR 리뷰', { agentTerminalHandle: 'term_other' }, () => {
        const spec = join(specsDir(), 'spec-review-pr-77.md')
        writeFileSync(spec, '# 리뷰\n\n리뷰 PR: #77\n')
        fx.tasks = [{ id: 'task_other', status: 'running', spec: `지시서 ${spec} 를 읽는다` }]
      }],
      [78, '일반 작업', { agentTerminalHandle: 'term_other' }, () => {}],
      // 터미널 없는 구조화 worker 라 터미널 목록으로는 보이지 않는다
      [79, '터미널 없는 구조화 worker', { agentTerminalHandle: 'structworker_other' }, () => {}],
    ]
    for (const [n, name, row, prepare] of cases) {
      fx.prViews[String(n)] = { state: 'MERGED', headRefOid: prHead(n) }
      const path = reviewWorktree(n)
      reusedBy(path, row)
      prepare(path)
      const out = runSweep(['--run', 'run_current', '--apply'])
      assert.ok(existsSync(path), `${name}: ${out}`)
      lacks(out, `리뷰 워크트리 삭제 ${path}`)
      assert.ok(branches().has(`review/pr-${n}`), name)
      fx.tasks = []
    }
  })

  test('브랜치 이름이 리뷰 꼴이 아니어도 띄우기 기록의 지시서가 리뷰 지시서면 리뷰 워크트리다', () => {
    fx.prViews['75'] = { state: 'MERGED', headRefOid: prHead(75) }
    const path = join(fx.wts, 'check-75')
    git('-C', fx.repo, 'worktree', 'add', '-q', '-b', 'check-75', path, 'origin/main')
    git('-C', path, 'checkout', '-q', '--detach', 'origin/main')
    const spec = join(specsDir(), 'spec-check.md')
    writeFileSync(spec, '# 리뷰\n\n리뷰 PR: #75\n')
    recordLaunch(fx.repo, { dispatch: 'ctx_r75', terminal: null, worktree: path, run: null, spec })
    const out = runSweep(['--apply'])
    has(out, `리뷰 워크트리 삭제 ${path} (#75)`)
  })

  test('커밋 안 된 변경이 있거나 리뷰 dispatch 가 살아 있으면 리뷰 워크트리와 브랜치를 남긴다', () => {
    fx.prViews['73'] = { state: 'MERGED', headRefOid: prHead(73) }
    const changed = reviewWorktree(73)
    writeFileSync(join(changed, 'note.txt'), '메모\n')
    fx.prViews['74'] = { state: 'MERGED', headRefOid: prHead(74) }
    const running = reviewWorktree(74)
    const spec = join(specsDir(), 'spec-review-pr-74.md')
    writeFileSync(spec, '# 리뷰\n\n리뷰 PR: #74\n')
    fx.tasks = [{ id: 'task_r', status: 'running', spec: `지시서 ${spec} 를 끝까지 읽는다` }]
    const out = runSweep(['--apply'])
    has(out, `건너뜀 리뷰 워크트리 ${changed} (#73): 커밋 안 된 변경`)
    has(out, `건너뜀 리뷰 워크트리 ${running} (#74): 리뷰 dispatch 가 살아 있다`)
    assert.ok(existsSync(changed) && existsSync(running))
    assert.ok(branches().has('review/pr-73') && branches().has('review/pr-74'))
  })

  test('--run 이 달라도 다른 Run 에서 도는 리뷰의 지시서는 남긴다', () => {
    const dir = specsDir()
    const spec = join(dir, 'spec-review-pr-91.md')
    writeFileSync(spec, '# 리뷰\n브랜치: `review/pr-91`\n')
    const wt = join(fx.wts, 'review-pr-91')
    git('-C', fx.repo, 'worktree', 'add', '-q', '-b', 'review/pr-91', wt, 'origin/main')
    git('-C', wt, 'checkout', '-q', '--detach', 'origin/main')
    const row = {
      runId: 'run_other',
      taskId: 'task_other',
      dispatchId: 'ctx_other',
      dispatchStatus: 'running',
      workerState: 'working',
      agentTerminalHandle: 'term_other',
      resource: { ownershipState: 'owned', worktreeId: `repo::${wt}` },
    }
    fx.runs = { run_current: [], run_other: [row] }
    fx.allWorkers = [row]
    fx.terminals = [{ handle: 'term_other', worktreePath: wt }]
    fx.prViews['91'] = { state: 'MERGED' }
    const out = runSweep(['--run', 'run_current', '--specs-dir', '.orch/specs', '--apply'])
    has(out, '리뷰 흔적 남김 #91: 살아 있는 지시서 목록을 읽지 못했다')
    assert.ok(existsSync(spec), out)
    assert.ok(existsSync(wt))
  })

  test('모든 Run 의 지시서에서 다른 Run 의 살아 있는 리뷰를 찾으면 남긴다', () => {
    const dir = specsDir()
    const spec = join(dir, 'spec-review-pr-92.md')
    writeFileSync(spec, '# 리뷰\n')
    fx.prViews['92'] = { state: 'MERGED' }
    fx.allWorkers = [{ runId: 'run_other', taskId: 'task_o', dispatchId: 'ctx_o', dispatchStatus: 'running' }]
    fx.tasks = [{ id: 'task_o', status: 'running', spec: `지시서 ${spec} 를 읽는다` }]
    const out = runSweep(['--run', 'run_current', '--specs-dir', '.orch/specs', '--apply'])
    has(out, '리뷰 흔적 남김 #92: 리뷰 dispatch 가 살아 있다')
    assert.ok(existsSync(spec))
  })

  test('다른 열린 PR 의 base 인 리뷰 브랜치는 남긴다', () => {
    git('-C', fx.repo, 'branch', 'pr-81', 'origin/main')
    fx.openBases = ['pr-81']
    fx.prViews['81'] = { state: 'CLOSED' }
    const out = runSweep(['--apply'])
    has(out, '리뷰 브랜치 남김 pr-81: 다른 열린 PR 의 base')
    assert.ok(branches().has('pr-81'))
  })

  test('그 브랜치를 head 로 둔 열린 PR 이 있으면 이름의 PR 이 닫혀도 남긴다', () => {
    git('-C', fx.repo, 'branch', 'pr-82', 'origin/main')
    fx.prs['pr-82'] = ['OPEN', git('-C', fx.repo, 'rev-parse', 'origin/main')]
    fx.prViews['82'] = { state: 'CLOSED' }
    const out = runSweep(['--apply'])
    has(out, '리뷰 브랜치 남김 pr-82: 그 브랜치를 head 로 둔 열린 PR #1 가 있다')
    assert.ok(branches().has('pr-82'))
  })

  test('리뷰 이름 규칙에 맞지 않는 비슷한 브랜치는 건드리지 않는다', () => {
    git('-C', fx.repo, 'branch', 'pr-81-fix', 'origin/main')
    fx.prViews['81'] = { state: 'CLOSED' }
    const out = runSweep(['--apply'])
    lacks(out, 'pr-81-fix')
    assert.ok(branches().has('pr-81-fix'))
  })
})
