// cleanup-sweep.ts 테스트 가운데 리뷰 worker 의 흔적(pr-N, review/pr-N 브랜치와 리뷰 지시서) 정리를 본다.
// 가짜 실행 파일, 상태와 공통 도우미는 fixtures/cleanup-sweep.ts 가 소유한다.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { branches, fx, git, has, lacks, runSweep } from './fixtures/cleanup-sweep.ts'

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

  test('detached 리뷰 워크트리가 남아 있으면 그것을 만든 브랜치를 남긴다', () => {
    const head = prHead(71)
    fx.prViews['71'] = { state: 'MERGED', headRefOid: head }
    const path = join(fx.wts, 'review-pr-71')
    git('-C', fx.repo, 'worktree', 'add', '-q', '-b', 'review/pr-71', path, 'origin/main')
    git('-C', path, 'fetch', '-q', 'origin', 'refs/pull/71/head')
    git('-C', path, 'checkout', '-q', '--detach', 'FETCH_HEAD')
    const out = runSweep(['--apply'])
    lacks(out, '리뷰 브랜치 삭제 review/pr-71')
    assert.ok(branches().has('review/pr-71'))
    assert.ok(existsSync(path))
  })
})
