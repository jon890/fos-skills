// 단계 파일과 lifecycle.ts 가 함께 쓰는 로그, 타입, worker 찾기다.
//
// 알림의 Run: Run 에 묶인 일(질문, 그 Run 의 정리, 그 Run 의 tick 핸들러)의 알림은 그 Run 메일함으로 쓴다.
//     PR 에 붙는 알림(CI-FAILED, CONFLICT-ORPHAN)은 그 PR 워크트리의 worker 를 띄운 Run(아래 「worker 찾기」)에, 주인을 모르면 주 Run 에 쓴다.
//     AUTO-MERGE, AUTO-MERGE-END 는 루프가 건 큐의 Run(state/auto-merge.json 의 queue.run)에, AUTO-MERGE-NO-REVIEW, MIGRATION-CLASH, MIGRATION-BLOCKED 는
//     그 PR 지시서의 Run 에 쓴다(auto-merge.ts 머리 주석의 「자동 머지」).
//     공유 일(열린 PR 조회, 보드, CI 규칙, 자동 머지, 충돌 처리, 최신화)의 WATCH-ERROR, 보드 결정의 DECISION-PENDING, 부모의 WATCH-ERROR tick 은 주 Run 에 쓴다.
//     Run 없는 한 칸이면 loop.log 에만 남긴다.
//
// worker 찾기: 맡은 Run 마다 worker-list --run 을 읽어(한 틱에 Run 마다 한 번) 그 워크트리의 worker 를 찾는다. 살아 있는 dispatch 가
//     있는 Run 을 먼저 고르고, 없으면 처음 찾은 Run 이다. 살아 있는 dispatch 를 못 찾았고 읽지 못한 Run 이 있으면 읽지 못한 것으로 본다.
//     ci-passed 와 ci-failed 핸들러의 run 도 그 Run 이다(모르면 주 Run).
//
// 로그: 모든 줄을 state/loop.log 에 붙이고 stdout 에도 쓴다. 붙이기 전에 1MB 를 넘으면 loop.log.1 로 돌린다.
//     --start 의 자식은 stdio 를 버린다. 파일 서술자를 자식에 넘기지 않는 것은 돌린 뒤에도 자식이 loop.log.1 에 쓰게 되기 때문이다.
//     틱 자식은 stdout 에만 쓴다. 부모가 그 줄을 loop.log 로 옮기므로 두 번 쓰이지 않는다.
//     잡지 않은 예외와 거부된 promise 는 스택을 로그에 남기고 1 로 끝난다.

import { appendFileSync, renameSync, statSync } from 'node:fs'
import { isObject } from '../../core/json.ts'
import { emit } from '../../lib/output.ts'
import type { RunResult } from '../../lib/proc.ts'
import { LIVE_DISPATCH, workerFor, workerRows } from '../../lib/workers.ts'

const LOG_LIMIT = 1_048_576

// finish-pr 이 정리 명령에 주는 시간 제한과 같다
export const SWEEP_TIMEOUT_MS = 600_000

export type CiEntry = { head: string; state: 'passed' | 'failed' | 'pending' }

export type StallState = 'error' | 'idle'

export type Stall = { run: string; terminal: string; state: StallState | 'limited'; hash: string; errors: number; since: string; ticks: number; fired: boolean; limitedNotified?: boolean }

// 틱 자식은 stdout 에만 쓴다(머리 주석의 「로그」)
let logFile: string | null = null

export function log(line: string): void {
  if (logFile) {
    try {
      try {
        if (statSync(logFile).size > LOG_LIMIT) renameSync(logFile, `${logFile}.1`)
      } catch {
        // 아직 없다
      }
      appendFileSync(logFile, `${line}\n`)
    } catch (e) {
      process.stderr.write(`orch-loop: ${logFile} 에 쓰지 못했다: ${(e as Error).message}\n`)
    }
  }
  // 짧은 출력(진입점의 orch loop …)이면 LOOP-* 같은 판정 줄만 낸다. 로그 파일은 늘 전부다
  emit(line)
}

export function oneLine(value: unknown): string {
  return String((value as Error)?.message ?? value).replace(/\r?\n|\r/g, ' ')
}

export function iso(): string {
  return new Date().toISOString()
}

export function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== '')
}

// 내 열린 PR 의 행. CI 감시가 쓰는 필드를 함께 읽는다
export type OwnPr = {
  number: number
  title: string | null
  branch: string
  head: string
  author: string
  draft: boolean
  base: string
  url: string
  host: string
  slug: string
  rollup: unknown
}

export type Prs = { ok: true; mine: OwnPr[] } | { ok: false; error: string }

// loop.json 의 ci 에서 형식이 맞는 항목만 남긴다
export function ciEntries(value: unknown): Record<string, CiEntry> {
  const entries: Record<string, CiEntry> = {}
  if (!isObject(value)) return entries
  for (const [number, entry] of Object.entries(value)) {
    if (isObject(entry) && typeof entry.head === 'string' && (entry.state === 'passed' || entry.state === 'failed' || entry.state === 'pending')) {
      entries[number] = { head: entry.head, state: entry.state }
    }
  }
  return entries
}

// 이번 틱이 맡는 Run. 앞이 주 Run 이다. 등록된 Run 이 없으면 --run(또는 finish.run) 하나이거나, 그것도 없으면 Run 없는 한 칸이다
export type TickRun = { run: string | null; specsDir: string | null }

// 틱 안에서 한 번만 읽는 워크트리 목록과 Run 마다의 worker 행. runs 는 이번 틱이 맡는 Run 이다
export type Lookup = { runs: TickRun[]; paths?: Map<string, string>; rows: Map<string, ReturnType<typeof workerRows>> }

type Owner = { run: string | null; row: Record<string, unknown> }

// 그 워크트리의 worker 와 그 worker 를 띄운 Run. 맡은 Run 을 차례로 보고, 살아 있는 dispatch 가 있는 Run 을 먼저 고른다.
// worker 가 없으면 found 가 null 이다. 살아 있는 dispatch 를 찾지 못했고 읽지 못한 Run 이 있으면 ok 가 false 다
export function ownerOf(path: string, lookup: Lookup): { ok: true; found: Owner | null } | { ok: false; error: string } {
  let error: string | null = null
  let ended: Owner | null = null
  for (const { run } of lookup.runs) {
    const rows = rowsOf(run ?? '', lookup)
    if (!rows.ok) {
      error ??= rows.error
      continue
    }
    const row = workerFor(rows.rows, path)
    if (!row) continue
    if (LIVE_DISPATCH.has(String(row.dispatchStatus))) return { ok: true, found: { run, row } }
    ended ??= { run, row }
  }
  // 읽지 못한 Run 에 살아 있는 worker 가 있을 수 있다. 끝난 worker 를 고르지 않고 읽지 못한 것으로 본다
  if (error !== null) return { ok: false, error }
  return { ok: true, found: ended }
}

export function primaryRun(lookup: Lookup): string | null {
  return lookup.runs[0]?.run ?? null
}

// 미답변 질문을 보낸 worker 의 dispatch 와 터미널. null 은 그 Run 의 질문을 읽지 못한 것이다
export type Waiting = { dispatches: Set<string>; terminals: Set<string> } | null

// loop.json 의 stalls 에서 형식이 맞는 항목만 남긴다
export function stallEntries(value: unknown): Record<string, Stall> {
  const entries: Record<string, Stall> = {}
  if (!isObject(value)) return entries
  for (const [dispatch, e] of Object.entries(value)) {
    if (!isObject(e) || (e.state !== 'error' && e.state !== 'idle' && e.state !== 'limited')) continue
    if (typeof e.run !== 'string' || typeof e.terminal !== 'string' || typeof e.hash !== 'string' || typeof e.since !== 'string') continue
    if (typeof e.ticks !== 'number' || !Number.isInteger(e.ticks) || e.ticks < 0 || typeof e.fired !== 'boolean') continue
    // errors 가 없는 항목은 오류 줄 수를 모른다. 0 으로 두어 다음 hash 변화에서 다시 센다
    const errors = typeof e.errors === 'number' && Number.isInteger(e.errors) && e.errors >= 0 ? e.errors : 0
    entries[dispatch] = { run: e.run, terminal: e.terminal, state: e.state, hash: e.hash, errors, since: e.since, ticks: e.ticks, fired: e.fired, ...(e.limitedNotified === true ? { limitedNotified: true } : {}) }
  }
  return entries
}

export function rowsOf(run: string, lookup: Lookup): ReturnType<typeof workerRows> {
  let rows = lookup.rows.get(run)
  if (!rows) {
    rows = workerRows(run)
    lookup.rows.set(run, rows)
  }
  return rows
}

export function relay(done: RunResult): void {
  for (const line of [...lines(done.stdout), ...lines(done.stderr)]) log(line)
}

// --foreground 의 부모만 로그 파일을 정한다(lifecycle.ts 의 foreground)
export function setLogFile(file: string): void {
  logFile = file
}
