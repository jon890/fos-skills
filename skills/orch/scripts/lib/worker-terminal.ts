// worker-list 를 페이지 끝까지 읽고 scope 가 all 이 아니면 모든 Run 을 읽는다.
// hook 은 active 뒤 기억과 terminal show 를 거쳐 LIVE_STATES 를 읽는다. approval 은 released 도 읽으며 지름길을 쓰지 않는다.
// Run 별 조회는 상태로 고르지 않는다. runAsync 와 기한을 쓰며 실패하면 판정 불가로 돌려준다.
import { WorkerRunCache, type RunInfo } from './worker-run-cache.ts'
import { orcaBin, withFull } from './orca.ts'
import { runAsync, type RunResult } from './proc.ts'
export const ACTIVE_STATE = 'active'
export const LIVE_STATES = ['reclaimable', 'release_unknown', 'release_pending', 'retained'] as const
export const APPROVAL_STATES = [ACTIVE_STATE, ...LIVE_STATES, 'released'] as const
export type WorkerHit = { handle: string; dispatchId: string | null; run: string | null }
export type LookupStats = { queries: number; completed: number; lastQuery: string; runTotal: number; runsRead: number }
export type LookupFailure = { ok: false; error: string; timeout: boolean; stats: LookupStats }
export type LookupOptions = { states: readonly string[]; deadline?: number; cache?: WorkerRunCache }
type WorkerPage = { workers: Record<string, unknown>[]; scope: unknown; next: string | null }
const PAGE_LIMIT = '100'
const RUN_CONCURRENCY = 16
const TIMEOUT = Symbol('timeout')
class QueryError extends Error {
  readonly timeout: boolean
  constructor(message: string, timeout = false) { super(message); this.timeout = timeout }
}
class Scanner {
  deadline: number
  cache: WorkerRunCache
  queries = 0
  completed = 0
  lastQuery = '-'
  runTotal = 0
  runsRead = 0
  constructor(options: { deadline?: number; cache?: WorkerRunCache }) {
    this.deadline = options.deadline ?? Date.now() + 30_000
    this.cache = options.cache ?? new WorkerRunCache()
  }
  stats(): LookupStats { return { queries: this.queries, completed: this.completed, lastQuery: this.lastQuery, runTotal: this.runTotal, runsRead: this.runsRead } }
  failure(error: unknown): LookupFailure { return { ok: false, error: error instanceof Error ? error.message : String(error), timeout: error instanceof QueryError && error.timeout, stats: this.stats() } }
  async orcaResult(args: string[]): Promise<Record<string, unknown>> {
    const left = this.deadline - Date.now()
    if (left <= 0) throw new QueryError('시간 초과', true)
    const label = `orca ${args.join(' ')}`
    this.queries++
    this.lastQuery = label
    let timer: NodeJS.Timeout | undefined
    // runAsync 는 시간을 넘긴 자식이 TERM 을 무시하면 KILL 까지 10초를 더 기다린다. 마감 시각에 따로 끊는다.
    const limit = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), left)
    })
    let done: RunResult | typeof TIMEOUT
    try {
      done = await Promise.race([runAsync([orcaBin(), ...withFull(args), '--json'], { timeoutMs: left }), limit])
    } finally {
      clearTimeout(timer)
    }
    if (done === TIMEOUT || done.timedOut) throw new QueryError('시간 초과', true)
    this.completed++
    if (done.code !== 0) throw new QueryError(`${label} 가 종료 코드 ${done.code} 로 끝났다`)
    let envelope: unknown
    try {
      envelope = JSON.parse(done.stdout)
    } catch {
      throw new QueryError(`${label} 의 출력이 JSON 이 아니다`)
    }
    const result = (envelope as { result?: unknown } | null)?.result
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      throw new QueryError(`${label} 의 응답에 result 객체가 없다`)
    }
    return result as Record<string, unknown>
  }

  nextCursor(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null
  }

  async workerPage(args: string[]): Promise<WorkerPage> {
    const result = await this.orcaResult(['orchestration', 'worker-list', ...args])
    if (!Array.isArray(result.workers)) throw new QueryError('worker-list 응답의 result.workers 가 배열이 아니다')
    const page = result.page as { nextCursor?: unknown } | undefined
    return {
      workers: result.workers.filter((w): w is Record<string, unknown> => typeof w === 'object' && w !== null),
      scope: (result.scope as { source?: unknown } | undefined)?.source,
      next: this.nextCursor(page?.nextCursor),
    }
  }

  // worker-list 를 page.nextCursor 끝까지 읽는다. 대상을 찾으면 found 에 넣고, 모두 찾았거나 stop() 이 참이면 멈춘다.
  async scanWorkers(
    base: string[],
    wanted: Set<string>,
    found: Map<string, WorkerHit>,
    stop: () => boolean = () => false,
    collected?: Record<string, unknown>[],
  ): Promise<unknown> {
    let cursor: string | null = null
    let scope: unknown
    let first = true
    do {
      if (stop()) return scope
      const page = await this.workerPage([...base, '--limit', PAGE_LIMIT, ...(cursor ? ['--cursor', cursor] : [])])
      collected?.push(...page.workers)
      if (first) scope = page.scope
      first = false
      for (const w of page.workers) {
        const handle = w.agentTerminalHandle
        if (typeof handle === 'string' && wanted.has(handle) && !found.has(handle)) {
          found.set(handle, { handle, dispatchId: typeof w.dispatchId === 'string' ? w.dispatchId : null, run: typeof w.runId === 'string' ? w.runId : null })
        }
        const resourceHandle = (w.resource as { terminalHandle?: unknown } | undefined)?.terminalHandle
        if (typeof resourceHandle === 'string' && wanted.has(resourceHandle) && !found.has(resourceHandle)) {
          found.set(resourceHandle, { handle: resourceHandle, dispatchId: typeof w.dispatchId === 'string' ? w.dispatchId : null, run: typeof w.runId === 'string' ? w.runId : null })
        }
      }
      if ([...wanted].every((h) => found.has(h))) return scope
      cursor = page.next
    } while (cursor)
    return scope
  }

  // run-list 를 result.nextCursor 끝까지 읽고 updated_at 이 최근인 순서로 Run id 를 낸다.
  async runIds(): Promise<RunInfo[]> {
    const runs: RunInfo[] = []
    let cursor: string | null = null
    do {
      const result = await this.orcaResult(['orchestration', 'run-list', '--limit', PAGE_LIMIT, ...(cursor ? ['--cursor', cursor] : [])])
      if (!Array.isArray(result.runs)) throw new QueryError('run-list 응답의 result.runs 가 배열이 아니다')
      for (const r of result.runs as { id?: unknown; updated_at?: unknown }[]) {
        if (typeof r?.id === 'string') runs.push({ id: r.id, updated_at: r.updated_at })
      }
      this.runTotal = runs.length
      cursor = this.nextCursor(result.nextCursor)
    } while (cursor)
    return runs.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
  }

  // Run 마다 worker-list --run 을 동시 RUN_CONCURRENCY 개까지 부른다. 대상을 모두 찾거나 하나라도 실패하면 바로 돌아온다.
  scanRuns(ids: RunInfo[], wanted: Set<string>, found: Map<string, WorkerHit>): Promise<void> {
    this.runTotal = ids.length
    const cache = this.cache
    return new Promise((resolve, reject) => {
      let next = 0
      let running = 0
      let settled = false
      const allFound = () => [...wanted].every((h) => found.has(h))
      const launch = () => {
        if (settled) return
        if (allFound() || (next >= ids.length && running === 0)) {
          settled = true
          resolve()
          return
        }
        while (running < RUN_CONCURRENCY && next < ids.length) {
          const run = ids[next++]
          if (cache.read(run, wanted) !== null) {
            this.runsRead++
            continue
          }
          running++
          const rows: Record<string, unknown>[] = []
          this.scanWorkers(['--run', run.id], wanted, found, () => settled || allFound(), rows).then(
            () => {
              running--
              this.runsRead++
              if (!settled && !allFound()) cache.remember(run, rows)
              launch()
            },
            (err: unknown) => {
              if (settled) return
              settled = true
              reject(err)
            },
          )
        }
        if (next >= ids.length && running === 0) {
          settled = true
          resolve()
        }
      }
      launch()
    })
  }


}
export async function activeWorkers(handles: string[], options: { deadline?: number } = {}) {
  const scan = new Scanner(options)
  const found = new Map<string, WorkerHit>()
  try {
    const scope = handles.length ? await scan.scanWorkers(['--terminal-state', ACTIVE_STATE], new Set(handles), found) : 'all'
    return { ok: true as const, found, scope: String(scope ?? ''), stats: scan.stats() }
  } catch (error) { return scan.failure(error) }
}
export async function remainingWorkers(handles: string[], scope: string, options: LookupOptions) {
  const scan = new Scanner(options)
  const found = new Map<string, WorkerHit>()
  if (!handles.length) return { ok: true as const, found, stats: scan.stats() }
  const wanted = new Set(handles)
  const allFound = () => handles.every(h => found.has(h))
  try {
    await Promise.all(options.states.filter(s => s !== ACTIVE_STATE).map(state => scan.scanWorkers(['--terminal-state', state], wanted, found, allFound)))
    const left = handles.filter(h => !found.has(h))
    if (left.length && scope !== 'all') await scan.scanRuns(await scan.runIds(), new Set(left), found)
    return { ok: true as const, found, stats: scan.stats() }
  } catch (error) { return scan.failure(error) }
}
export async function lookupWorkerTerminals(handles: string[], options: LookupOptions) {
  const deadline = options.deadline ?? Date.now() + 30_000
  const active = await activeWorkers(handles, { deadline })
  if (!active.ok) return active
  const rest = await remainingWorkers(handles.filter(h => !active.found.has(h)), active.scope, { ...options, deadline })
  if (!rest.ok) return rest
  return { ok: true as const, found: new Map([...active.found, ...rest.found]) }
}
