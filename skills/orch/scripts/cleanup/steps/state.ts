// 워크트리와 브랜치 정리 뒤, 기한이 지난 큐 로그와 상태 파일을 휴지통으로 옮긴다.
// 루프도 cleanup sweep 을 부른다. 조회에 실패하거나 아직 쓰는 파일은 다음 정리까지 남긴다.

import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { SWEEP_RETENTION_DAYS } from '../../core/config.ts'
import { isObject } from '../../core/json.ts'
import { CLEANUP_KEYS, ConfigError, loadConfig, section } from '../../lib/config.ts'
import { realPath } from '../../lib/fs.ts'
import { dataCandidates, handoffCandidates, moveRetained, reasonText } from '../../lib/folder-retention.ts'
import type { RetentionCandidate } from '../../lib/folder-retention.ts'
import { boardPath } from '../../lib/board-file.ts'
import { readLaunch } from '../../lib/launched.ts'
import { LookupError } from '../../lib/ownership.ts'
import { orchDir, pathOf } from '../../lib/paths.ts'
import { claimFile } from '../../lib/pr-claim.ts'
import { pruneMerged } from '../../lib/pr-lookup.ts'
import { pidFileAlive } from '../../lib/process.ts'
import { closedPr, RETENTION_DAY_MS, lsofOpenedBy, oldFiles, QUEUE_DAYS, queueLogCandidates, trashRetainedFile } from '../../lib/queue-logs.ts'
import { isFinished } from '../../lib/worker-state.ts'
import { migrateLegacyNotices } from '../legacy-notices.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { lookupOf, prCandidates } from './prs.ts'
import { git, lines } from './shared.ts'

function days(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key]
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN
  if (!Number.isFinite(parsed) || parsed < 0) throw new ConfigError(`cleanup.${key} 는 0 이상의 유한한 수여야 한다`)
  return parsed
}

// 현재 큐의 종료 알림이 아직 로그를 읽을 수 있다. 기록을 읽지 못한 경우에는 로그 폴더 전체를 남긴다.
function activeAutoLog(stateDir: string): string | null | undefined {
  try {
    const state: unknown = JSON.parse(readFileSync(join(stateDir, 'auto-merge.json'), 'utf8'))
    if (!isObject(state)) return undefined
    if (state.queue === null || state.queue === undefined) return null
    return isObject(state.queue) && typeof state.queue.log === 'string' && state.queue.log ? resolve(state.queue.log) : undefined
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
  }
}

async function launchCandidates(ctx: StepContext, state: StepState, dir: string, cutoff: number): Promise<string[]> {
  const files = oldFiles(dir, /^[\w-][\w.-]*\.json$/, cutoff)
  if (!files.length) return []
  const { args, repo } = ctx
  try {
    const workers = await args.allWorkers()
    const finished = new Set(workers.filter(isFinished).map((row) => row.dispatchId))
    const unfinished = new Set(workers.filter((row) => !isFinished(row)).map((row) => row.dispatchId))
    const eligible = files.filter(({ name }) => finished.has(name.slice(0, -5)) && !unfinished.has(name.slice(0, -5)))
    if (!eligible.length) return []
    const openHeads = lookupOf(repo).openHeads()
    if (!openHeads) return []
    const worktrees = new Set(state.listed.map(([worktree]) => realPath(worktree)))
    const openByBranch = new Map<string, boolean>()
    return eligible.flatMap(({ file, name }) => {
      const launch = readLaunch(repo, name.slice(0, -5))
      // 재개와 지시서 정리는 워크트리가 남아 있는 동안 띄우기 기록을 읽는다.
      if (!launch || worktrees.has(realPath(launch.worktree))) return []
      const branch = launch.branch
      if (!branch) return []
      if (!openByBranch.has(branch)) {
        openByBranch.set(branch, openHeads.size > 0 && prCandidates(repo, branch).some(([head]) => openHeads.has(head)))
      }
      return openByBranch.get(branch) ? [] : [file]
    })
  } catch (e) {
    if (!(e instanceof LookupError)) throw e
    return []
  }
}

function finishCandidates(repo: string, base: string, state: StepState, dir: string, cutoff: number): string[] {
  const oldMarks = oldFiles(dir, /^[1-9]\d*$/, cutoff)
  if (!oldMarks.length) return []
  const branches = new Set(state.listed.map(([, branch]) => branch).filter((branch) => branch && branch !== base).flatMap((branch) => prCandidates(repo, branch).map(([head]) => head)))
  const prs = lookupOf(repo).details(oldMarks.map(({ name }) => Number(name)), branches.size > 0)
  return oldMarks.flatMap(({ file, name }) => {
    const pr = prs.get(Number(name))
    if (!pr || !closedPr(pr.state)) return []
    // 워크트리가 남아 있으면 정리가 다음에도 이 표시를 보고 마무리 누락을 판정한다.
    if (branches.size && (!pr.head || branches.has(pr.head))) return []
    if (pidFileAlive(join(pathOf('queue', repo), `finish-${name}.pid`)) || existsSync(claimFile(repo, 'finish', name))) return []
    return [file]
  })
}

function directory(dir: string): boolean {
  try { return lstatSync(dir).isDirectory() } catch { return false }
}

// 옮길 것을 알리거나(미리 보기) 휴지통으로 옮긴다. label 은 로그의 대상 이름(주격), object 는 목적격, folder 는 휴지통 안의 폴더다.
// 줄 꼴은 짧은 출력 규칙(output.ts 의 sweepLine)과 맞춘다
function trashRetained(ctx: StepContext, candidates: RetentionCandidate[], label: string, object: string, folder: string, days: number): void {
  const { args, log } = ctx
  for (const candidate of candidates) {
    const why = reasonText(candidate, days)
    if (!args.apply) {
      log(`${object} 휴지통으로 옮길 것 ${candidate.path}: ${why}`)
      continue
    }
    try {
      log(`${label} 옮김 ${candidate.path} -> ${moveRetained(candidate, args.trash, folder)}: ${why}`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`${object} 남긴다 ${candidate.path}: ${(e as Error).message}`)
    }
  }
}

// handoff 의 끝난 산출물(references/overlay.md 「orch 작업 폴더」). 판정은 lib/folder-retention.ts 가 소유한다
function sweepHandoff(ctx: StepContext, state: StepState, now: number, handoffDays: number): void {
  const { repo, log } = ctx
  const dir = join(orchDir(repo), 'handoff')
  // handoff 가 없으면 GitHub 를 부르지 않는다
  if (!directory(dir)) return
  const lookup = lookupOf(repo)
  const worktrees = new Set(state.listed.map(([worktree]) => basename(worktree)))
  try {
    const candidates = handoffCandidates(dir, { now, days: handoffDays, worktrees, prStates: (numbers) => lookup.states(numbers) })
    trashRetained(ctx, candidates, 'handoff 산출물', 'handoff 산출물을', 'handoff', handoffDays)
  } catch (e) {
    if (!(e instanceof LookupError)) throw e
    log(`handoff 산출물은 남긴다: ${e.message}`)
  }
}

// data/<보드 항목 id>/ 는 그 보드 항목이 지워지면 옮긴다. 보드를 읽지 못하면 남긴다
function sweepData(ctx: StepContext, now: number, handoffDays: number): void {
  const { repo, log } = ctx
  const dir = join(orchDir(repo), 'data')
  if (!directory(dir)) return
  let boardIds: Set<string> | null = null
  try {
    const board: unknown = JSON.parse(readFileSync(boardPath(repo), 'utf8'))
    const items = isObject(board) && Array.isArray(board.items) ? board.items : null
    if (items) boardIds = new Set(items.flatMap((item) => (isObject(item) && typeof item.id === 'string' ? [item.id] : [])))
  } catch (e) {
    log(`data 폴더는 남긴다: 보드를 읽지 못했다 (${(e as Error).message})`)
  }
  trashRetained(ctx, dataCandidates(dir, { now, days: handoffDays, boardIds }), 'data 자료', 'data 자료를', 'data', handoffDays)
}

async function sweepRetention(ctx: StepContext, state: StepState): Promise<void> {
  const { repo, args, log } = ctx
  const config = section<Record<string, unknown>>(loadConfig(repo), 'cleanup', CLEANUP_KEYS)
  const queueDays = days(config, 'queue_days', QUEUE_DAYS)
  const stateDays = days(config, 'state_days', SWEEP_RETENTION_DAYS.state_days)
  const ghDays = days(config, 'gh_log_days', SWEEP_RETENTION_DAYS.gh_log_days)
  const now = Date.now()
  const stateDir = pathOf('state', repo)
  const host = { now: () => now, openedBy: lsofOpenedBy, prStates: (numbers: number[]) => lookupOf(repo).states(numbers) }
  const trash = (file: string, subdir: string) => trashRetainedFile(file, subdir, args.trash, args.apply, log)

  for (const file of queueLogCandidates({ dir: pathOf('queue', repo), host, days: queueDays })) trash(file, 'queue')
  const handoffDays = days(config, 'handoff_days', SWEEP_RETENTION_DAYS.handoff_days)
  sweepHandoff(ctx, state, now, handoffDays)
  sweepData(ctx, now, handoffDays)
  if (!directory(stateDir)) return
  const cutoff = now - stateDays * RETENTION_DAY_MS
  const active = activeAutoLog(stateDir)
  if (active !== undefined) {
    for (const file of queueLogCandidates({ dir: join(stateDir, 'auto-merge'), host, days: stateDays, kind: 'auto-merge' })) {
      if (resolve(file) !== active) trash(file, 'state/auto-merge')
    }
  }
  for (const file of await launchCandidates(ctx, state, join(stateDir, 'launched-workers'), cutoff)) trash(file, 'state/launched-workers')
  for (const file of finishCandidates(repo, args.base, state, join(stateDir, 'finish-started'), cutoff)) trash(file, 'state/finish-started')
  const ghDir = join(stateDir, 'gh')
  if (directory(ghDir)) {
    for (const { file, name } of oldFiles(join(ghDir, 'logs'), /^\d{4}-\d\d-\d\d\.jsonl$/, now - ghDays * RETENTION_DAY_MS)) {
      if (name !== `${new Date(now).toISOString().slice(0, 10)}.jsonl`) trash(file, 'state/gh/logs')
    }
  }
}

export async function cleanupState(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { repo, args, log } = ctx
  await sweepRetention(ctx, state)
  migrateLegacyNotices(repo, args.trash, args.apply, log)
  pruneMerged(repo, new Set(lines(git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').out)))
  return {}
}
