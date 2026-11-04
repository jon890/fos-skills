// 움직임으로 멈춘 worker 와 worker 없이 멈춘 보드 단계를 찾는 한 벌이다.
// 사용처: stalled-workers.ts(코디네이터가 부르는 조회), orch-loop.ts(틱의 「움직임 확인」), work-board/bin/worker-marks.ts(보드 worker 줄의 멈춤 표시).
// 판정 함수는 조회하지 않는다.
// 화면 상태로 보는 멈춤(lib/screen.ts, orch-loop.ts 의 「멈춤 확인」)과 따로 돈다. Orca 의 structured worker 는 화면이 대화 기록 꼴이라
// 입력란을 찾지 못해 화면 상태가 늘 unknown 이다. 그래서 상태가 아니라 무엇이 바뀌었는지로 본다.
//
// 움직임(movedAt): 열린 dispatch 의 워크트리에서 아래 가운데 가장 늦은 시각(ms)이다.
//   - 워크트리 파일의 마지막 수정 시각(latestMtime). SKIP_DIRS 의 폴더는 들어가지 않고, 파일을 MTIME_BUDGET 개까지만 본다
//   - 브랜치의 마지막 커밋 시각(lastCommitMs. git log -1 --format=%ct)
//   - 터미널 화면 끝 줄(lib/screen.ts 의 screenTail)이 마지막으로 바뀐 시각(screen.changedAt). 화면 hash 를 틱마다 적어 두는
//     orch-loop 만 이 값을 안다. stalled-workers 는 루프가 적은 값(movement.json 의 screens)을 읽기만 한다
// 멈춤 판정(judgeWorker. 위에서부터 처음 걸린 것):
//   1. Orca 의 liveness(projection.liveness.verdict)가 exited 이고 settings.exited 가 true 면 exited. 프로세스가 끝났는데 dispatch 가 열려 있다
//   2. 부르는 쪽이 기다리는 이유(waiting)를 주면 멈춤이 아니다. 루프는 그 Run 의 질문을 읽지 못한 것, 그 dispatch 가 보낸 미답변 질문,
//      그 워크트리 브랜치의 열린 PR 의 CI 가 통과한 것(머지를 기다린다)을 준다. 뒤의 둘은 코디네이터의 차례다
//   3. settings.idleMin 이 0 이면 보지 않는다. 멈춘 단계도 보지 않는다
//   4. 움직임을 하나도 모르면(워크트리가 없고 화면 기록도 없다) 멈춤이 아니다. 모르는 것을 멈춤으로 알리지 않는다
//   5. 움직임에서 idleMin 분이 지났으면 idle
// 멈춘 단계(stalledStages): 보드 항목 가운데 아래를 모두 만족하는 것이다. 단계는 details 에서 done 이 아닌 첫 줄이다.
//   - status 가 doing 이다. todo, wait, done, decide, goal 은 보지 않는다(wait 는 일부러 기다리는 항목이다)
//   - 끝나지 않은 단계가 있다
//   - worktree 나 branch 칸이 있다. 둘 다 없는 항목은 worker 를 띄운 적이 없는, 코디네이터나 사용자가 맡은 일이다
//   - 그 worktree(이름이나 경로의 끝 이름)나 branch 의 워크트리에 살아 있는 dispatch 가 없다
//   - 그 워크트리 폴더가 있으면 그 파일이 idleMin 분 안에 바뀌지 않았다. 맡은 Run 밖의 worker 가 일하는 중일 수 있다
// 알림 기록(idleNotices, stageNotices): 같은 멈춤을 틱마다 다시 알리지 않으려는 것이다.
//   worker 는 알린 때의 reason 과 movedAt 을 둔다. reason 이 바뀌거나 그 뒤에 움직였다 다시 멈추면 다시 알린다.
//   단계는 처음 본 시각(since)과 단계 글을 둔다. 같은 단계가 idleMin 분 넘게 이어지면 한 번 알리고, 단계 글이 바뀌면 새로 센다.
//   지금 멈추지 않은 것의 기록은 지운다.
// 조회(collectWorkers, collectStages)는 worker 목록, 워크트리 파일, git, 보드를 읽어 판정 함수에 넘긴다. 쓰지 않는다.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readBoard } from './board.ts'
import { ConfigError, loadConfig, PIPELINE_KEYS, section } from './config.ts'
import { git } from './git.ts'
import { boardPath } from './paths.ts'
import { LIVE_DISPATCH, worktreePaths } from './workers.ts'
import type { workerRows } from './workers.ts'

type Json = Record<string, unknown>

export const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'build', 'dist', 'out', '.gradle', '.omc', '.orch', '.venv', '__pycache__', 'target'])
// 큰 워크트리에서 틱이 길어지지 않게 보는 파일 수의 상한이다. 넘으면 그때까지 본 가장 늦은 시각을 쓴다
export const MTIME_BUDGET = 4000
export const DEFAULT_IDLE_MIN = 30

export type MovementSettings = { idleMin: number; exited: boolean }
export type ScreenMark = { hash: string; changedAt: number }
export type WorkerVerdict = {
  run: string
  dispatch: string
  terminal: string
  worktree: string | null
  liveness: string | null
  movedAt: number | null
  idleMin: number | null
  reason: 'idle' | 'exited' | null
  // 멈춤으로 보지 않은 이유. 없으면 null
  waiting: string | null
}
export type StageVerdict = { id: string; step: string; worktree: string | null; branch: string | null }
export type IdleRecord = { run: string; reason: 'idle' | 'exited'; movedAt: number | null }
export type StageRecord = { step: string; since: number; fired: boolean }

function obj(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {}
}

// config.json 의 pipeline.idle_min(0 이상의 수, 기본 30. 0 이면 idle 을 보지 않는다)과 pipeline.idle_exited(참거짓, 기본 true).
// 값이 틀리면 ConfigError 다
export function movementSettings(repo: string): MovementSettings {
  const body = section<Json>(loadConfig(repo), 'pipeline', PIPELINE_KEYS)
  const idle = body.idle_min ?? DEFAULT_IDLE_MIN
  if (typeof idle !== 'number' || !Number.isFinite(idle) || idle < 0) throw new ConfigError('설정 파일의 pipeline.idle_min 은 0 이상의 수다')
  const exited = body.idle_exited ?? true
  if (typeof exited !== 'boolean') throw new ConfigError('설정 파일의 pipeline.idle_exited 는 true 나 false 다')
  return { idleMin: idle, exited }
}

// worker-list 행의 워크트리 경로. resource.worktreeId 의 `::` 뒤다. 없으면 null
export function worktreeOf(row: Json): string | null {
  const id = String(obj(row.resource).worktreeId ?? '')
  return id.includes('::') ? id.slice(id.indexOf('::') + 2) : null
}

// worker-list 행의 Orca liveness 판정(projection.liveness.verdict). 없으면 null
export function livenessOf(row: Json): string | null {
  const verdict = obj(obj(obj(row.projection).liveness)).verdict
  return typeof verdict === 'string' && verdict ? verdict : null
}

// 워크트리 파일의 가장 늦은 수정 시각(ms). 폴더가 없거나 읽지 못하면 null
export function latestMtime(path: string, budget = MTIME_BUDGET): number | null {
  let newest: number | null = null
  let seen = 0
  const stack = [path]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      if (dir === path) return null
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      seen += 1
      if (seen > budget) return newest
      try {
        const ms = statSync(join(dir, entry.name)).mtimeMs
        if (newest === null || ms > newest) newest = ms
      } catch {
        // 지워진 파일은 건너뛴다
      }
    }
  }
  return newest
}

// 워크트리 브랜치의 마지막 커밋 시각(ms). 읽지 못하면 null
export function lastCommitMs(path: string): number | null {
  const done = git(path, ['log', '-1', '--format=%ct'])
  const sec = Number(done.stdout.trim())
  return done.code === 0 && Number.isFinite(sec) && sec > 0 ? sec * 1000 : null
}

// 화면 끝 줄의 hash. 줄 끝 공백과 빈 줄은 lib/screen.ts 의 screenTail 이 이미 뺐다
export function tailHash(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}

// 앞 틱의 기록과 이번 화면으로 새 기록을 낸다. 처음 본 화면은 지금 바뀐 것으로 본다. 루프가 막 뜬 때 오래된 화면을 멈춤으로 알리지 않는다
export function markScreen(previous: ScreenMark | undefined, hash: string, now: number): ScreenMark {
  return previous && previous.hash === hash ? previous : { hash, changedAt: now }
}

// 머리 주석의 「멈춤 판정」
export function judgeWorker(input: {
  run: string
  row: Json
  now: number
  settings: MovementSettings
  mtime: number | null
  commit: number | null
  screen?: ScreenMark
  waiting?: string | null
}): WorkerVerdict {
  const { row, now, settings } = input
  const moves = [input.mtime, input.commit, input.screen?.changedAt ?? null].filter((v): v is number => typeof v === 'number')
  const movedAt = moves.length > 0 ? Math.max(...moves) : null
  const idleMin = movedAt === null ? null : Math.max(0, Math.floor((now - movedAt) / 60_000))
  const liveness = livenessOf(row)
  const verdict: WorkerVerdict = {
    run: input.run,
    dispatch: String(row.dispatchId ?? ''),
    terminal: String(row.agentTerminalHandle ?? ''),
    worktree: worktreeOf(row),
    liveness,
    movedAt,
    idleMin,
    reason: null,
    waiting: null,
  }
  if (settings.exited && liveness === 'exited') return { ...verdict, reason: 'exited' }
  if (input.waiting) return { ...verdict, waiting: input.waiting }
  if (settings.idleMin === 0 || movedAt === null) return verdict
  return now - movedAt >= settings.idleMin * 60_000 ? { ...verdict, reason: 'idle' } : verdict
}

// 열린 dispatch 행만 고른다
export function openRows(rows: Json[]): Json[] {
  return rows.filter((row) => row.dispatchId && LIVE_DISPATCH.has(String(row.dispatchStatus)))
}

// 보드 항목의 끝나지 않은 첫 단계 글. 없으면 null
export function pendingStep(item: Json): string | null {
  const details = Array.isArray(item.details) ? item.details : []
  for (const detail of details) {
    const d = obj(detail)
    if (d.done === true) continue
    const text = typeof d.text === 'string' ? d.text.trim() : ''
    if (text) return text
  }
  return null
}

// 머리 주석의 「멈춘 단계」. live 는 살아 있는 dispatch 의 워크트리 경로, branches 는 {브랜치: 워크트리 경로},
// recent 는 워크트리 경로가 idleMin 분 안에 바뀌었는지 묻는 함수다
export function stalledStages(items: Json[], live: ReadonlySet<string>, branches: ReadonlyMap<string, string>, recent: (path: string) => boolean): StageVerdict[] {
  const liveNames = new Set([...live].map((path) => basename(path)))
  const pathsByName = new Map([...branches.values()].map((path) => [basename(path), path]))
  const found: StageVerdict[] = []
  for (const item of items) {
    if (item.status !== 'doing' || typeof item.id !== 'string') continue
    const step = pendingStep(item)
    if (step === null) continue
    const worktree = typeof item.worktree === 'string' && item.worktree.trim() ? item.worktree.trim() : null
    const branch = typeof item.branch === 'string' && item.branch.trim() ? item.branch.trim() : null
    if (!worktree && !branch) continue
    const name = worktree ? basename(worktree) : null
    const byBranch = branch ? (branches.get(branch) ?? null) : null
    if ((name && liveNames.has(name)) || (byBranch && live.has(byBranch))) continue
    const path = byBranch ?? (name ? (pathsByName.get(name) ?? null) : null)
    if (path && recent(path)) continue
    found.push({ id: item.id, step, worktree, branch })
  }
  return found
}

// worker 알림 기록. read 는 이번 틱에 worker 목록을 읽은 Run 이다. 읽지 못한 Run 의 앞 기록은 그대로 둔다
export function idleNotices(
  previous: Record<string, IdleRecord>,
  verdicts: WorkerVerdict[],
  read: ReadonlySet<string>,
): { records: Record<string, IdleRecord>; fire: WorkerVerdict[] } {
  const records: Record<string, IdleRecord> = {}
  for (const [dispatch, record] of Object.entries(previous)) if (!read.has(record.run)) records[dispatch] = record
  const fire: WorkerVerdict[] = []
  for (const v of verdicts) {
    if (v.reason === null) continue
    const before = previous[v.dispatch]
    const moved = before !== undefined && v.movedAt !== null && (before.movedAt === null || v.movedAt > before.movedAt)
    if (!before || before.reason !== v.reason || moved) fire.push(v)
    records[v.dispatch] = { run: v.run, reason: v.reason, movedAt: v.movedAt }
  }
  return { records, fire }
}

// 단계 알림 기록
export function stageNotices(
  previous: Record<string, StageRecord>,
  stages: StageVerdict[],
  now: number,
  idleMin: number,
): { records: Record<string, StageRecord>; fire: Array<StageVerdict & { minutes: number }> } {
  const records: Record<string, StageRecord> = {}
  const fire: Array<StageVerdict & { minutes: number }> = []
  for (const stage of stages) {
    const before = previous[stage.id]
    const record = before && before.step === stage.step ? { ...before } : { step: stage.step, since: now, fired: false }
    if (!record.fired && now - record.since >= idleMin * 60_000) {
      fire.push({ ...stage, minutes: Math.floor((now - record.since) / 60_000) })
      record.fired = true
    }
    records[stage.id] = record
  }
  return { records, fire }
}

// movement.json 의 형식이 맞는 항목만 남긴다
export function readRecords(value: unknown): {
  screens: Record<string, ScreenMark>
  workers: Record<string, IdleRecord>
  stages: Record<string, StageRecord>
} {
  const body = obj(value)
  const screens: Record<string, ScreenMark> = {}
  for (const [k, v] of Object.entries(obj(body.screens))) {
    const e = obj(v)
    if (typeof e.hash === 'string' && typeof e.changedAt === 'number') screens[k] = { hash: e.hash, changedAt: e.changedAt }
  }
  const workers: Record<string, IdleRecord> = {}
  for (const [k, v] of Object.entries(obj(body.workers))) {
    const e = obj(v)
    if (typeof e.run !== 'string' || (e.reason !== 'idle' && e.reason !== 'exited')) continue
    workers[k] = { run: e.run, reason: e.reason, movedAt: typeof e.movedAt === 'number' ? e.movedAt : null }
  }
  const stages: Record<string, StageRecord> = {}
  for (const [k, v] of Object.entries(obj(body.stages))) {
    const e = obj(v)
    if (typeof e.step === 'string' && typeof e.since === 'number' && typeof e.fired === 'boolean') stages[k] = { step: e.step, since: e.since, fired: e.fired }
  }
  return { screens, workers, stages }
}

// Run 마다 열린 dispatch 를 판정한다. rowsOf 는 Run 의 worker 목록을 낸다(루프는 틱 안에서 한 번 읽은 값을 준다).
// screens 는 dispatch 마다의 화면 기록, waiting 은 그 dispatch 를 멈춤으로 보지 않을 이유다. live 는 열린 dispatch 의 워크트리 경로다
export function collectWorkers(input: {
  runs: string[]
  rowsOf: (run: string) => ReturnType<typeof workerRows>
  settings: MovementSettings
  now: number
  screens?: Readonly<Record<string, ScreenMark>>
  waiting?: (run: string, row: Json, worktree: string | null) => string | null
}): { verdicts: WorkerVerdict[]; read: Set<string>; errors: Map<string, string>; live: Set<string> } {
  const verdicts: WorkerVerdict[] = []
  const read = new Set<string>()
  const errors = new Map<string, string>()
  const live = new Set<string>()
  for (const run of input.runs) {
    const rows = input.rowsOf(run)
    if (!rows.ok) {
      errors.set(run, rows.error)
      continue
    }
    read.add(run)
    for (const row of openRows(rows.rows)) {
      const path = worktreeOf(row)
      const exists = path !== null && existsSync(path)
      if (path && exists) live.add(path)
      const dispatch = String(row.dispatchId)
      verdicts.push(
        judgeWorker({
          run,
          row,
          now: input.now,
          settings: input.settings,
          mtime: exists ? latestMtime(path as string) : null,
          commit: exists ? lastCommitMs(path as string) : null,
          screen: input.screens?.[dispatch],
          waiting: input.waiting?.(run, row, path) ?? null,
        }),
      )
    }
  }
  return { verdicts, read, errors, live }
}

// 보드의 멈춘 단계. idleMin 이 0 이거나 보드 파일이 없으면 빈 목록이고, 읽지 못하면 Error 다
export function collectStages(repo: string, live: ReadonlySet<string>, settings: MovementSettings, now: number): StageVerdict[] {
  const file = boardPath(repo)
  if (settings.idleMin === 0 || !existsSync(file)) return []
  const items = readBoard(file) as Json[]
  const recent = (path: string) => {
    const ms = latestMtime(path)
    return ms !== null && now - ms < settings.idleMin * 60_000
  }
  return stalledStages(items, live, worktreePaths(repo), recent)
}
