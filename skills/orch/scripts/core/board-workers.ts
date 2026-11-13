export type WorkerRole = 'impl' | 'follow' | 'review' | 'verify'
export type WorkerRow = {
  role: WorkerRole; dispatch: string | null; worktree: string; branch: string | null
  pr: number | null; status: 'working' | 'done' | 'lost'; at: string; endedAt: string | null
}

export function boardWorkerRows(item: Record<string, unknown>): WorkerRow[] {
  return Array.isArray(item.workers) ? item.workers.filter((row): row is WorkerRow =>
    row !== null && typeof row === 'object' && !Array.isArray(row) && typeof row.worktree === 'string') : []
}
