import { LIVE_DISPATCH } from './workers.ts'
import { objectOr as obj } from './json.ts'
export type Json = Record<string, any>
export type Lost = [string, unknown]
export const LIVE_STATUSES = LIVE_DISPATCH
export const LOST_WORKER_STATES = new Set(['abandoned', 'failed', 'stopped'])
export function lostWorkers(rows: Json[], watched: Set<unknown>): Lost[] {
  const lost: Lost[] = []
  for (const w of rows) {
    if (!w.dispatchId || !watched.has(w.dispatchId)) continue
    // 정리로 터미널이 사라져도 이미 끝난 dispatch 는 끊김이 아니다
    if (w.dispatchStatus === 'completed' || w.dispatchStatus === 'abandoned') continue
    const projection = obj(w.projection)
    if (projection.outcome === 'succeeded' || projection.outcome === 'cancelled') continue
    const detail = obj(projection.stage).detail
    if (LOST_WORKER_STATES.has(String(w.workerState)) || w.dispatchStatus === 'failed' || detail === 'terminal_missing') {
      lost.push([String(w.dispatchId), detail || w.workerState])
    } else if (LIVE_STATUSES.has(String(w.dispatchStatus)) && obj(projection.liveness).verdict === 'exited') {
      // 열린 dispatch 인데 worker 프로세스가 끝났다. 보낸 답을 받을 쪽이 없다(머리 주석의 「끊긴 worker」)
      lost.push([String(w.dispatchId), 'liveness_exited'])
    }
  }
  return lost
}


export function retriedLost(rows: Json[], lost: Lost[]): Set<string> {
  const liveByTask = new Map<unknown, Set<unknown>>()
  for (const w of rows) {
    if (!w.taskId || !w.dispatchId || !LIVE_STATUSES.has(String(w.dispatchStatus))) continue
    liveByTask.set(w.taskId, new Set([...(liveByTask.get(w.taskId) ?? []), w.dispatchId]))
  }
  const taskOf = new Map(rows.map((w) => [w.dispatchId, w.taskId]))
  const retried = new Set<string>()
  for (const [dispatch] of lost) {
    const live = liveByTask.get(taskOf.get(dispatch))
    if (live && [...live].some((d) => d !== dispatch)) retried.add(dispatch)
  }
  return retried
}
export function deliberateEnd(dispatch: Json): string | null {
  const termination = dispatch.terminationReason || dispatch.termination_reason
  if (termination === 'operator_close' || termination === 'worker_report') return termination
  let failure = dispatch.lastFailure || dispatch.last_failure
  if (failure === 'abandoned') return 'abandoned'
  if (typeof failure === 'string') {
    try {
      failure = JSON.parse(failure)
    } catch {
      failure = null
    }
  }
  return obj(failure).provenance === 'worker_report' ? 'worker_report' : null
}
export function taskClosed(task: Json): boolean {
  return task.status === 'completed' || (task.status === 'failed' && String(task.result || '').toLowerCase().includes('cancel'))
}
