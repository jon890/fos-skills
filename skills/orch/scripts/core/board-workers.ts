import { lostWorkers, LIVE_STATUSES, LOST_WORKER_STATES, type Json } from './lost-workers.ts'
export type WorkerRole = 'impl' | 'follow' | 'review' | 'verify'
export type WorkerRow = {
  role: WorkerRole; dispatch: string | null; worktree: string; branch: string | null
  pr: number | null; stages?: string; 'feature-steps'?: string; 'feature-report'?: 'pending' | 'done'; status: 'working' | 'done' | 'lost'; at: string; endedAt: string | null
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

// 끊김으로 적힌 줄의 dispatch. 틱마다 Orca 행을 다시 보고 되살릴지 정하는 대상이다
export function lostDispatches(items: Record<string, unknown>[]): Set<string> {
  return new Set(items.flatMap((item) => boardWorkerRows(item).flatMap((row) => row.status === 'lost' && typeof row.dispatch === 'string' && row.dispatch.trim() ? [row.dispatch] : [])))
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

// 끊김으로 적힌 줄을 이번에 본 Orca 행으로 다시 판정한다. 한 번 본 순간 상태(liveness exited 등)가 끝난 뒤 지나가도 줄이 끊김으로 굳지 않게 한다.
//   done    같은 dispatch 가 worker_done 을 보냈거나 outcome 이 succeeded 다
//   working 같은 dispatch 가 아직 열려 있고(pending·dispatched·running) workerEnds 가 끝으로 보지 않는다
// 그 밖(행이 없거나 지금도 끝난 상태)은 넣지 않아 줄을 그대로 둔다. 진짜 끊긴 worker 는 workerEnds 가 계속 lost 로 보므로 되살아나지 않는다
export function workerRevivals(rows: Json[], reported: ReadonlySet<string>, lost: ReadonlySet<string>): Record<string, 'working' | 'done'> {
  const ends = workerEnds(rows, reported, lost)
  const revivals: Record<string, 'working' | 'done'> = {}
  for (const row of rows) {
    const id = String(row.dispatchId ?? '')
    if (!lost.has(id)) continue
    if (ends[id] === 'done') revivals[id] = 'done'
    else if (ends[id] === undefined && LIVE_STATUSES.has(String(row.dispatchStatus))) revivals[id] = 'working'
  }
  for (const id of reported) if (lost.has(id)) revivals[id] = 'done'
  return revivals
}
