// 재부팅으로 끊긴 worker 의 워크트리를 정리 도구가 남기는지 본다(docs/features/cleanup-keep-lost/spec.md).
// PR 본문의 기능 완료 근거 블록으로는 남기지 않는다(사용자 결정 2026-11-24).
// 실제 Orca 와 워크트리는 건드리지 않는다. 가짜 orca·gh 와 임시 저장소는 fixtures/cleanup-sweep.ts 가 소유한다.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { sweepLine } from '../scripts/cleanup/cleanup-sweep.ts'
import { checkHeldWorktrees, HELD_NOTICE_MS } from '../scripts/doctor/orch-doctor.ts'
import { failedKind, heldDispatch, heldSince } from '../scripts/lib/worker-state.ts'
import { type Row, branches, calls, exists, fx, gone, has, lacks, runSweep, squashMerge, worktree } from './fixtures/cleanup-sweep.ts'

// Orca 가 재시작 복구에서 터미널을 잃고 닫은 dispatch 행. 실측(2026-11-20) 모양을 줄였다
function lostRow(path: string, dispatch = 'ctx_lost', over: Row = {}): Row {
  return {
    dispatchId: dispatch,
    taskId: 'task_a',
    dispatchStatus: 'failed',
    workerState: 'abandoned',
    agentTerminalHandle: 'term_lost',
    terminalState: 'released',
    resource: { worktreeId: `x::${path}`, ownershipState: 'released', releaseState: 'released', releaseCompletedAt: '2026-11-20 07:07:47' },
    projection: { stage: { worker: 'abandoned', dispatch: 'failed', detail: 'terminal_missing' } },
    ...over,
  }
}

function failedRow(path: string, detail: unknown, dispatch = 'ctx_err'): Row {
  return lostRow(path, dispatch, { workerState: 'failed', projection: detail === undefined ? {} : { stage: { detail } } })
}

function doneRow(path: string, dispatch = 'ctx_new'): Row {
  return { dispatchId: dispatch, taskId: 'task_a', dispatchStatus: 'completed', workerState: 'succeeded', terminalState: 'released', resource: { worktreeId: `x::${path}`, releaseState: 'released' } }
}

// 이 Run 의 행(--run)과 모든 Run 의 행(삭제 직전 소유 확인)을 같게 둔다. worker-list 처럼 최신 dispatch 가 앞이다
function rows(...list: Row[]): void {
  fx.workers = list
  fx.allWorkers = list.map((row) => ({ ...row }))
}

function mergedWorktree(name: string): string {
  const path = worktree(name)
  squashMerge(name, path)
  return path
}

describe('failed 의 이유', () => {
  test('terminal_missing 은 끊김, 알려진 detail 은 오류, 모르는 것은 unknown 이다', () => {
    assert.equal(failedKind(lostRow('/p')), 'lost')
    for (const detail of ['settled', 'process_exited', 'process_stopped', 'abandoned', 'agent_readiness', 'dispatch_input']) {
      assert.equal(failedKind(failedRow('/p', detail)), 'error', detail)
    }
    assert.equal(failedKind(failedRow('/p', 'new_reason')), 'unknown')
    assert.equal(failedKind(failedRow('/p', undefined)), 'unknown')
    assert.equal(failedKind(doneRow('/p')), null)
  })

  test('가장 최근 행만 본다. 뒤에 뜬 dispatch 가 있으면 남기지 않는다', () => {
    assert.equal(heldDispatch([lostRow('/p')])?.dispatch, 'ctx_lost')
    assert.equal(heldDispatch([doneRow('/p'), lostRow('/p')]), null)
    assert.equal(heldDispatch([failedRow('/p', 'settled')]), null)
    assert.equal(heldDispatch([failedRow('/p', undefined)])?.kind, 'unknown')
    assert.equal(heldDispatch([]), null)
  })

  test('Run 사이의 순서는 믿지 않는다. 다른 Run 의 가장 최근 행이 끊겼으면 남긴다', () => {
    assert.equal(heldDispatch([{ ...doneRow('/p'), runId: 'run_a' }, { ...lostRow('/p'), runId: 'run_b' }])?.dispatch, 'ctx_lost')
    assert.equal(heldDispatch([{ ...doneRow('/p'), runId: 'run_b' }, { ...lostRow('/p'), runId: 'run_b' }]), null)
  })

  test('살아 있지도 끝나지도 않은 행은 끊김인지 몰라 남긴다', () => {
    const held = heldDispatch([{ ...doneRow('/p'), dispatchStatus: 'dispatched', workerState: 'abandoned', terminalState: 'active', resource: {} }])
    assert.equal(held?.kind, 'unknown')
    assert.equal(held?.detail, 'dispatched/abandoned')
  })

  test('끊긴 시각은 resource 의 반납 시각을 UTC 로 읽는다', () => {
    assert.equal(heldSince(lostRow('/p')), Date.parse('2026-11-20T07:07:47Z'))
    assert.equal(heldSince(lostRow('/p', 'ctx', { resource: {} })), null)
  })
})

describe('끊긴 worker 의 워크트리', () => {
  test('PR 이 MERGED 여도 워크트리, 터미널, 지시서를 남기고 미리 보기에도 지울 것으로 내지 않는다', () => {
    const path = mergedWorktree('feat-lost')
    rows(lostRow(path))
    fx.terminals = [{ handle: 'term_shell', worktreePath: path }]
    const specs = join(fx.repo, '.orch/specs')
    mkdirSync(specs, { recursive: true })
    writeFileSync(join(specs, 'spec-feat-lost.md'), '브랜치: `feat-lost`\n')
    const dry = runSweep(['--run', 'run_x', '--specs-dir', '.orch/specs'])
    has(dry, `남김 ${path}: 끊긴 worker ctx_lost, 다시 띄우거나 직접 정리한다`)
    lacks(dry, '지울 것')
    const out = runSweep(['--run', 'run_x', '--specs-dir', '.orch/specs', '--apply'])
    has(out, `남김 ${path}: 끊긴 worker ctx_lost`)
    exists(path, out)
    assert.ok(branches().has('feat-lost'))
    assert.ok(existsSync(join(specs, 'spec-feat-lost.md')))
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
  })

  test('--run 없는 정리도 모든 Run 의 행으로 남긴다', () => {
    const path = mergedWorktree('feat-lost')
    fx.allWorkers = [lostRow(path)]
    const out = runSweep(['--apply'])
    has(out, `남김 ${path}: 끊긴 worker ctx_lost`)
    exists(path, out)
  })

  test('짧은 출력에서는 KEPT 줄이다', () => {
    assert.equal(sweepLine('남김 /w/a: 끊긴 worker ctx_lost, 다시 띄우거나 직접 정리한다', { path: null }), 'KEPT /w/a 끊긴 worker ctx_lost, 다시 띄우거나 직접 정리한다')
  })

  test('resume 이나 새 dispatch 가 뒤에 끝났으면 보통 규칙대로 지운다', () => {
    const path = mergedWorktree('feat-resumed')
    rows(doneRow(path), lostRow(path))
    const out = runSweep(['--run', 'run_x', '--apply'])
    lacks(out, '끊긴 worker')
    gone(path, out)
  })

  test('resume 한 worker 가 아직 일하면 일하는 중으로 건너뛴다', () => {
    const path = mergedWorktree('feat-resumed')
    rows({ ...doneRow(path), dispatchStatus: 'dispatched', workerState: 'ready' }, lostRow(path))
    const out = runSweep(['--run', 'run_x', '--apply'])
    has(out, `건너뜀 ${path}: 살아 있는 worker ctx_new`)
    exists(path, out)
  })

  test('오류로 끝난 failed 는 지금처럼 끝난 것으로 보고 지운다', () => {
    const path = mergedWorktree('feat-error')
    rows(failedRow(path, 'process_exited'))
    const out = runSweep(['--run', 'run_x', '--apply'])
    lacks(out, '끊긴 worker')
    gone(path, out)
  })

  test('기록으로 끊김인지 알 수 없는 failed 는 남긴다', () => {
    const path = mergedWorktree('feat-unknown')
    rows(failedRow(path, undefined))
    const out = runSweep(['--run', 'run_x', '--apply'])
    has(out, `남김 ${path}: 끊김인지 확인하지 못한 failed dispatch ctx_err(없음), 다시 띄우거나 직접 정리한다`)
    exists(path, out)
  })
})

describe('PR 본문의 완료 근거', () => {
  test('기능 PR 의 본문에 후속 검증 대기가 있어도 워크트리와 지시서를 지운다', () => {
    const name = 'feat-follow'
    const path = mergedWorktree(name)
    const head = String(fx.prs[name][1])
    fx.prViews['1'] = { state: 'MERGED', headRefOid: head, headRefName: name, body: `<!-- fos-feature-evidence -->
검증 커밋: ${head}
후속 검증: 대기 | 배포 후 smoke
<!-- /fos-feature-evidence -->` }
    const specs = join(fx.repo, '.orch/specs')
    mkdirSync(specs, { recursive: true })
    const spec = join(specs, `spec-${name}.md`)
    writeFileSync(spec, `브랜치: \`${name}\`\n## 할 일 · 기능\n1. 루프를 쓴다(스펙: 새로 쓴다)\n`)
    const out = runSweep(['--specs-dir', '.orch/specs', '--apply'])
    lacks(out, '후속 검증')
    gone(path, out)
    assert.ok(!existsSync(spec))
  })
})

describe('직접 정리(--remove-kept)', () => {
  test('끊긴 worker 의 남김을 넘어 워크트리와 지시서를 지운다', () => {
    const path = mergedWorktree('feat-lost')
    rows(lostRow(path))
    const specs = join(fx.repo, '.orch/specs')
    mkdirSync(specs, { recursive: true })
    writeFileSync(join(specs, 'spec-feat-lost.md'), '브랜치: `feat-lost`\n')
    const out = runSweep(['--run', 'run_x', '--specs-dir', '.orch/specs', '--remove-kept', path, '--apply'])
    lacks(out, '끊긴 worker')
    gone(path, out)
    assert.ok(!existsSync(join(specs, 'spec-feat-lost.md')))
  })

  test('커밋 안 된 변경은 그대로 막는다', () => {
    const path = mergedWorktree('feat-lost')
    rows(lostRow(path))
    writeFileSync(join(path, 'dirty.txt'), 'x')
    const out = runSweep(['--run', 'run_x', '--remove-kept', path, '--apply'])
    has(out, `건너뜀 ${path}: 커밋 안 된 변경`)
    exists(path, out)
  })

  test('준 경로만 넘어선다', () => {
    const kept = mergedWorktree('feat-lost')
    const other = mergedWorktree('feat-other')
    rows(lostRow(kept), lostRow(other, 'ctx_other'))
    const out = runSweep(['--run', 'run_x', '--remove-kept', kept, '--apply'])
    gone(kept, out)
    has(out, `남김 ${other}: 끊긴 worker ctx_other`)
  })
})

describe('doctor 의 KEPT-LOST', () => {
  function fakeOrca(list: Row[]): void {
    const file = join(fx.tmp, 'doctor-orca')
    writeFileSync(file, `#!/usr/bin/env node
const a = process.argv.slice(2)
if (a.includes('worker-list')) console.log(JSON.stringify({ ok: true, result: { workers: ${JSON.stringify(list)}, page: { nextCursor: null } } }))
else if (a.includes('worker-show')) console.log(JSON.stringify({ ok: true, result: { dispatch: { completedAt: '2026-11-18T01:00:00.000Z' } } }))
else process.exit(1)
`)
    chmodSync(file, 0o755)
    process.env.ORCA = file
  }

  test('끊긴 지 하루가 넘은 남긴 워크트리마다 경로, dispatch, 시각과 직접 정리 명령을 낸다', () => {
    const old = process.env.ORCA
    try {
      const path = worktree('feat-lost')
      const fresh = worktree('feat-fresh')
      const gone = worktree('feat-done')
      fakeOrca([
        { ...lostRow(path), runId: 'run_x' },
        { ...lostRow(fresh, 'ctx_fresh'), runId: 'run_x' },
        { ...doneRow(gone), runId: 'run_x' },
      ])
      const since = Date.parse('2026-11-20T07:07:47Z')
      const lines = checkHeldWorktrees(null, fx.repo, since + HELD_NOTICE_MS + 1)
      const text = lines.join('\n')
      has(text, `KEPT-LOST ${path} ctx_lost 2026-11-20T07:07:47Z`)
      has(text, `cleanup sweep --repo ${fx.repo} --run run_x --remove-kept ${path} --apply`)
      lacks(text, 'ctx_new')
      // 하루가 지나지 않았으면 내지 않는다
      assert.deepEqual(checkHeldWorktrees(null, fx.repo, since + 1000), [])
    } finally {
      if (old === undefined) delete process.env.ORCA
      else process.env.ORCA = old
    }
  })

  test('반납 시각이 없으면 worker-show 의 끝난 시각을 쓴다', () => {
    const old = process.env.ORCA
    try {
      const path = worktree('feat-lost')
      fakeOrca([{ ...lostRow(path, 'ctx_lost', { resource: { worktreeId: `x::${path}` } }), runId: 'run_x' }])
      const lines = checkHeldWorktrees('run_x', fx.repo, Date.parse('2026-11-20T00:00:00Z'))
      has(lines.join('\n'), `KEPT-LOST ${path} ctx_lost 2026-11-18T01:00:00Z`)
    } finally {
      if (old === undefined) delete process.env.ORCA
      else process.env.ORCA = old
    }
  })
})
