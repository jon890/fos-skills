import { lostWorkers, LOST_WORKER_STATES, type Json } from './lost-workers.ts'
export type WorkerRole = 'impl' | 'follow' | 'review' | 'verify'
export type WorkerRow = {
  role: WorkerRole; dispatch: string | null; worktree: string; branch: string | null
  pr: number | null; stages?: string; status: 'working' | 'done' | 'lost'; at: string; endedAt: string | null
}

export function boardWorkerRows(item: Record<string, unknown>): WorkerRow[] {
  return Array.isArray(item.workers) ? item.workers.filter((row): row is WorkerRow =>
    row !== null && typeof row === 'object' && !Array.isArray(row) && typeof row.worktree === 'string') : []
}

export function hasWorkRows(item: Record<string, unknown>): boolean | null {
  return Array.isArray(item.workers) ? boardWorkerRows(item).some((row) => row.role === 'impl' || row.role === 'follow') : null
}

export function rowsReviewPr(item: Record<string, unknown>): number | null {
  const pr = boardWorkerRows(item).filter((row) => row.role === 'review' || row.role === 'verify').sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''))).at(-1)?.pr
  return typeof pr === 'number' && Number.isInteger(pr) && pr > 0 ? pr : null
}

export function workingDispatches(items: Record<string, unknown>[]): Set<string> {
  return new Set(items.flatMap((item) => boardWorkerRows(item).flatMap((row) => row.status === 'working' && typeof row.dispatch === 'string' && row.dispatch.trim() ? [row.dispatch] : [])))
}

export function workerEnds(rows: Json[], reported: ReadonlySet<string>, watched: ReadonlySet<string>): Record<string, 'done' | 'lost'> {
  const ends: Record<string, 'done' | 'lost'> = {}
  for (const row of rows) {
    const id = String(row.dispatchId ?? '')
    if (!watched.has(id)) continue
    if (reported.has(id) || row.projection?.outcome === 'succeeded') ends[id] = 'done'
    else if (['failed', 'abandoned', 'completed'].includes(row.dispatchStatus) ||
      LOST_WORKER_STATES.has(row.workerState) || ['cancelled', 'failed'].includes(row.projection?.outcome)) ends[id] = 'lost'
  }
  for (const [id] of lostWorkers(rows, new Set(watched))) if (ends[id] !== 'done') ends[id] = 'lost'
  for (const id of reported) if (watched.has(id)) ends[id] = 'done'
  return ends
}
