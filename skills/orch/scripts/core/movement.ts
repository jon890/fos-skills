import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { LIVE_DISPATCH } from './workers.ts'
import { objectOr as obj } from './json.ts'

export type Json = Record<string, unknown>

export const DEFAULT_IDLE_MIN = 30

export type MovementSettings = { idleMin: number; exited: boolean }

export type ScreenMark = { hash: string; changedAt: number; background?: string }

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

// 화면 끝 줄의 hash. 줄 끝 공백과 빈 줄은 lib/screen.ts 의 screenTail 이 이미 뺐다
export function tailHash(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}

// 앞 틱의 기록과 이번 화면으로 새 기록을 낸다. 처음 본 화면은 지금 바뀐 것으로 본다. 루프가 막 뜬 때 오래된 화면을 멈춤으로 알리지 않는다.
// background 는 이번 화면의 백그라운드 작업 표시다. 바뀐 시각과 무관하게 늘 이번 값으로 둔다
export function markScreen(previous: ScreenMark | undefined, hash: string, now: number, background: string | null = null): ScreenMark {
  const changedAt = previous && previous.hash === hash ? previous.changedAt : now
  return background ? { hash, changedAt, background } : { hash, changedAt }
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
  if (input.screen?.background) return { ...verdict, waiting: `백그라운드 작업을 기다린다(${input.screen.background})` }
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

export function liveWorkerOn(item: { worktree: string | null; branch: string | null }, live: ReadonlySet<string>, branches: ReadonlyMap<string, string>): boolean {
  const names = new Set([...live].map(value => basename(value)))
  const byBranch = item.branch ? branches.get(item.branch) : undefined
  return !!((item.worktree && names.has(basename(item.worktree))) || (byBranch && live.has(byBranch)))
}

// 머리 주석의 「멈춘 단계」. live 는 살아 있는 dispatch 의 워크트리 경로, branches 는 {브랜치: 워크트리 경로},
// recent 는 워크트리 경로가 idleMin 분 안에 바뀌었는지 묻는 함수다
export function stalledStages(items: Json[], live: ReadonlySet<string>, branches: ReadonlyMap<string, string>, recent: (path: string) => boolean): StageVerdict[] {
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
    if (liveWorkerOn({ worktree, branch }, live, branches)) continue
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
    if (typeof e.hash !== 'string' || typeof e.changedAt !== 'number') continue
    screens[k] = typeof e.background === 'string' && e.background ? { hash: e.hash, changedAt: e.changedAt, background: e.background } : { hash: e.hash, changedAt: e.changedAt }
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

// 사람과 코디네이터가 읽는 판정 줄(탭으로 나눈다). 꼴은 stalled-workers.ts 머리 주석의 「출력」 이 소유한다
export function workerLine(v: WorkerVerdict): string {
  const mark = v.reason ? 'STALLED' : 'MOVING'
  return [mark, v.dispatch, v.reason ?? '-', v.idleMin ?? '-', v.worktree ? basename(v.worktree) : '-', v.run].join('\t')
}

export function stageLine(s: StageVerdict): string {
  return ['STAGE', s.id, s.worktree ?? s.branch ?? '-', s.step].join('\t')
}
