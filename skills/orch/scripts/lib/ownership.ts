// 워크트리 정리 전에 그 경로의 살아 있는 터미널이 사용자 소유인지 확인하는 판정 한 벌이다.
//
// 사용처: remove-worktree.ts 와 cleanup-sweep.ts 가 삭제 전에 blocker 를 부른다. cleanup-sweep.ts 는 allWorkers 를 cached 로 감싸
// 소유 확인과 다른 Run 판정에 함께 쓴다.
//
// 터미널 목록이나 모든 Run 의 소유 상태를 읽지 못하면 빈 셸도 닫지 않고 남긴다.
// 끝난 dispatch 의 터미널은 `worker-list` 의 `resource` 로 아래처럼 나뉜다.
//
//     owned, 이유 없음                      PR 이 MERGED 면 터미널을 닫고 dispatch 를 release 한다
//     user_owned / user_takeover            `남김: 사용자 보유 터미널` (예외: cleanup-sweep 이 launch-worker 의 기록으로 코디네이터가
//                                           띄운 끝난 터미널로 가린 것, --close-own-taken-over 를 켠 때. 둘 다 호출자가 ignore 로 넘긴다)
//     released                              `남김: 사용자 보유 터미널`
//     external / external_terminal          소유 상태가 owned 가 아니라 `터미널 소유 상태 조회 실패` 로 남긴다
//     owned / identity_unproven             owned 라 막지 않는다. Orca 의 release 는 닫지 않으므로 sweep 이 경로로 찾아 닫는다
//
// 범위 읽기: `run-list` 를 끝까지 따라 Run 마다 `worker-list --run` 을 읽는다. 먼저 Run 목록을 읽어야
// 호출 터미널의 바인딩 유무와 관계없이 끝난 Run 의 머신 캐시를 쓸 수 있다(worker-run-cache.ts).
// run-list 를 읽을 수 없는 옛 Orca 에서는 scope.source 가 all 인 완전한 목록만 대신 쓴다.
// 범위 없는 worker-list 는 호출 터미널이나 작업 디렉터리에 묶인 Run 만 줄 수 있다(lib/orca.ts).
//
// 내보내는 것:
//     LookupError    조회 실패. 옛 LOOKUP_ERRORS 에 해당한다. 아래 함수는 조회 실패를 모두 이것으로 던진다
//     allWorkers     모든 Run 의 worker 행
//     runWorkers     한 Run 의 worker 행
//     workerSnapshot 실행 단위 전체 목록과 삭제 직전 경로별 새 조회
//     cached         성공한 결과를 maxAge 초 동안 되풀이한다. 실패 뒤에는 다음 호출이 다시 조회한다
//     rowHandles     한 행이 가리키는 터미널 handle
//     blocker        안전하면 빈 문자열, 남길 때는 이유

import { isObject } from '../core/json.ts'
import { realPath, inside } from './fs.ts'
import { orcaBin, withFull } from './orca.ts'
import { runAsync } from './proc.ts'
import { WorkerRunCache, type RunInfo } from './worker-run-cache.ts'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

// Run 마다 읽을 때 동시에 띄우는 orca 수. Run 251개 실측: 8 이면 30초, 16 이면 18초

export const JOBS = 16
// 성공한 목록은 정리 실행 동안 유지한다. 삭제 직전 forWorktree 가 해당 경로와 변경된 Run 을 새로 읽으므로
// 기다리는 사이 터미널을 사용자가 넘겨받아도 옛 소유 상태로 닫지 않는다. 조회 실패는 다음 호출이 다시 시도한다.
export const MAX_AGE = Infinity
const QUERY_TIMEOUT_MS = 30_000

export class LookupError extends Error {}

export type WorkerRow = Record<string, unknown>

// 값이 없거나 빈 문자열, 0, false 면 없는 것으로 본다. 옛 Python 의 `x or {}` 와 `if not x` 판정과 같다
function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && value !== 0 && value !== false
}

async function query(args: string[]): Promise<Record<string, unknown>> {
  const done = await runAsync([orcaBin(), ...withFull(args), '--json'], { timeoutMs: QUERY_TIMEOUT_MS })
  let data: unknown
  try {
    data = JSON.parse(done.stdout)
  } catch {
    throw new LookupError(`Orca 조회 실패: orca ${args.join(' ')} 의 출력이 JSON 이 아니다`)
  }
  if (done.code !== 0 || !isObject(data) || data.ok === false || !isObject(data.result)) {
    throw new LookupError(`Orca 조회 실패: orca ${args.join(' ')}`)
  }
  return data.result
}

// resource 가 없으면 빈 객체다. 객체가 아닌 값이 들어 있으면 형식 오류다
function resourceOf(row: WorkerRow): Record<string, unknown> {
  const resource = row.resource
  if (!given(resource)) return {}
  if (!isObject(resource)) throw new LookupError('worker 행의 resource 형식 오류')
  return resource
}

// worker-list 를 끝까지 읽은 행 목록. 첫 페이지의 scope.source 가 scope 가 아니면 null 이다.
async function workerPages(args: string[], scope: string): Promise<WorkerRow[] | null> {
  const rows: WorkerRow[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  for (;;) {
    const result = await query(['orchestration', 'worker-list', '--limit', '100', ...args, ...(cursor ? ['--cursor', cursor] : [])])
    if (!cursor) {
      const info = given(result.scope) ? result.scope : {}
      if (!isObject(info)) throw new LookupError('worker 목록의 scope 형식 오류')
      if (info.source !== scope) return null
    }
    if (!Array.isArray(result.workers)) throw new LookupError('worker 목록 형식 오류')
    for (const row of result.workers) {
      if (!isObject(row)) throw new LookupError('worker 행 형식 오류')
      rows.push(row)
    }
    const page = given(result.page) ? result.page : {}
    if (!isObject(page)) throw new LookupError('worker 목록의 page 형식 오류')
    const next = page.nextCursor
    if (!given(next) && !given(page.hasMore)) return rows
    if (typeof next !== 'string' || !next || seen.has(next)) throw new LookupError('다음 페이지 확인 실패')
    seen.add(next)
    cursor = next
  }
}

// 그 Run 의 worker 행 전부.
export async function runWorkers(run: string): Promise<WorkerRow[]> {
  const rows = await workerPages(['--run', run], 'flag')
  if (rows === null) throw new LookupError('--run 범위가 아니다')
  return rows
}

export async function workerRuns(): Promise<RunInfo[]> {
  const ids: RunInfo[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  for (;;) {
    const result = await query(['orchestration', 'run-list', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])])
    if (!Array.isArray(result.runs)) throw new LookupError('Run 목록 형식 오류')
    for (const run of result.runs) {
      if (!isObject(run) || typeof run.id !== 'string') throw new LookupError('Run 행 형식 오류')
      ids.push({ id: run.id, updated_at: run.updated_at })
    }
    const next = result.nextCursor
    if (!given(next)) return ids
    if (typeof next !== 'string' || seen.has(next)) throw new LookupError('다음 Run 페이지 확인 실패')
    seen.add(next)
    cursor = next
  }
}

// 모든 Run 의 worker 행. 읽지 못하면 LookupError 를 던진다.
// Run 마다 읽을 때 JOBS 개까지 동시에 띄운다. 한 Run 이라도 실패하면 새로 띄우지 않고, 띄운 것이 끝난 뒤 그 실패를 던진다.
export async function allWorkers(
  onRuns?: (runs: RunInfo[]) => void,
  known: ReadonlyMap<string, WorkerRow[]> = new Map(),
): Promise<WorkerRow[]> {
  let ids: RunInfo[]
  try {
    ids = await workerRuns()
  } catch (error) {
    if (!(error instanceof LookupError)) throw error
    // 옛 Orca 에서 run-list 를 못 읽어도 명시적으로 all 인 완전한 응답은 사용할 수 있다.
    const rows = await workerPages([], 'all')
    if (rows !== null) return rows
    throw error
  }
  onRuns?.(ids)
  const terminals = (await query(['terminal', 'list'])).terminals
  if (!Array.isArray(terminals)) throw new LookupError('터미널 목록 형식 오류')
  const live = new Set(terminals.map((t) => isObject(t) ? t.handle : undefined))
  const cache = new WorkerRunCache()
  return readRuns(ids, async (run) => {
    const remembered = known.get(run.id) ?? cache.read(run, live)
    const workers = remembered ?? await runWorkers(run.id)
    if (remembered === null) cache.remember(run, workers)
    return workers
  })
}

async function readRuns(ids: RunInfo[], read: (run: RunInfo) => Promise<WorkerRow[]>): Promise<WorkerRow[]> {
  const results: WorkerRow[][] = new Array(ids.length)
  let next = 0
  let failure: unknown = null
  const lane = async () => {
    while (failure === null && next < ids.length) {
      const at = next++
      try {
        results[at] = await read(ids[at])
      } catch (e) {
        failure ??= e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(JOBS, ids.length) }, lane))
  if (failure !== null) throw failure
  return results.flat()
}

// 정리 실행 하나가 공유하는 스냅샷. 진행 중인 조회도 공유하며 시간이 지나도 전체 목록을 다시 읽지 않는다.
// 삭제 직전에는 해당 경로의 Run 과 스냅샷 뒤 바뀌거나 새로 생긴 Run 만 다시 읽는다.
export function workerSnapshot(file?: string): {
  all: () => Promise<WorkerRow[]>
  runIds: () => Promise<string[] | null>
  seedRun: (run: string, rows: WorkerRow[]) => void
  forWorktree: (path: string) => Promise<WorkerRow[]>
} {
  let runs: RunInfo[] = []
  let listed = false
  const known = new Map<string, WorkerRow[]>()
  const save = (value: unknown) => {
    if (!file) return
    writeFileSync(`${file}.tmp`, JSON.stringify(value))
    renameSync(`${file}.tmp`, file)
  }
  const all = cached(async () => {
    if (file) {
      let value: unknown
      try {
        value = JSON.parse(readFileSync(file, 'utf8'))
      } catch { /* 이번 틱의 다른 정리에서 아직 쓰지 않았다 */ }
      if (isObject(value)) {
        if (typeof value.error === 'string') throw new LookupError(value.error)
        if (Array.isArray(value.runs) && value.runs.every((r: unknown) => isObject(r) && typeof r.id === 'string') &&
          Array.isArray(value.rows) && value.rows.every(isObject) && typeof value.listed === 'boolean') {
          runs = value.runs
          listed = value.listed
          return value.rows as WorkerRow[]
        }
      }
    }
    let rows: WorkerRow[]
    try {
      rows = await allWorkers((ids) => { runs = ids; listed = true }, known)
    } catch (e) {
      // 다른 Run 이 같은 틱에 다시 실패한 전체 조회를 반복하지 않는다. 다음 틱은 새 파일로 재시도한다.
      if (e instanceof LookupError) save({ error: e.message })
      throw e
    }
    save({ runs, rows, listed })
    return rows
  })
  return {
    all,
    async runIds() { await all(); return listed ? runs.map((run) => run.id) : null },
    // all() 을 부르기 전에 이미 읽은 자기 Run 을 넣는다. 이 행은 뒤에 읽는 Run 갱신 시각보다 오래될 수 있다.
    // forWorktree 는 갱신 시각이 같아도 경로·handle 로 관련 Run 을 골라 다시 읽으므로 삭제 전 확인은 생략되지 않는다.
    seedRun: (run, rows) => { known.set(run, rows.map((row) => ({ ...row, runId: run }))) },
    async forWorktree(path) {
      const rows = await all()
      const target = realPath(path)
      const terminals = (await query(['terminal', 'list'])).terminals
      if (!Array.isArray(terminals)) throw new LookupError('터미널 목록 형식 오류')
      const handles = new Set(terminals.filter((t) => isObject(t) && typeof t.worktreePath === 'string' &&
        inside(realPath(t.worktreePath), target)).map((t) => t.handle))
      const relevant = new Set(rows.filter((row) => {
        if ([...rowHandles(row)].some((handle) => handles.has(handle))) return true
        const projection = isObject(row.projection) ? row.projection : {}
        const workspace = isObject(projection.workspace) ? projection.workspace : {}
        const id = resourceOf(row).worktreeId ?? workspace.id
        return typeof id === 'string' && id.includes('::') && inside(realPath(id.slice(id.indexOf('::') + 2)), target)
      }).map((row) => row.runId))
      const previous = new Map(runs.map((run) => [run.id, run.updated_at]))
      let current: RunInfo[]
      try { current = await workerRuns() }
      catch (e) {
        if (!(e instanceof LookupError)) throw e
        // run-list 가 없는 옛 Orca 도 삭제 전에는 all 범위의 새 응답을 확인해야 한다.
        const fresh = await workerPages([], 'all')
        if (fresh === null) throw e
        return fresh
      }
      const selected = current.filter((run) => known.has(run.id) || relevant.has(run.id) || !previous.has(run.id) ||
        !run.updated_at || previous.get(run.id) !== run.updated_at)
      return readRuns(selected, (run) => runWorkers(run.id))
    },
  }
}

// 성공한 결과만 maxAge 초 동안 재사용한다. 기본값은 실행 단위라 만료하지 않는다.
// 진행 중인 호출은 공유하지만 실패는 저장하지 않아 다음 호출이 다시 조회한다.
export function cached<T>(fn: () => Promise<T>, maxAge: number = MAX_AGE): () => Promise<T> {
  let pending: Promise<T> | null = null
  let box: { at: number; value: T } | null = null
  return async () => {
    if (box !== null && (performance.now() - box.at) / 1000 <= maxAge) return box.value
    return pending ??= fn().then((value) => {
      box = { at: performance.now(), value }
      return value
    }).finally(() => { pending = null })
  }
}

// 그 행이 가리키는 터미널 handle. resource 와 agent 의 handle 이 다르면 둘 다다.
export function rowHandles(row: WorkerRow): Set<unknown> {
  return new Set([resourceOf(row).terminalHandle, row.agentTerminalHandle].filter(given))
}

// 안전하면 빈 문자열, 사용자 보유 또는 조회 실패면 남길 이유를 돌려준다.
// ignore 에 든 handle 은 호출자가 닫아도 된다고 판정한 터미널이라 소유 상태를 보지 않는다.
// workers 는 모든 Run 의 worker 행을 돌려주는 함수다. 여러 경로를 볼 때는 cached(allWorkers) 를 넘긴다.
export async function blocker(
  worktree: string,
  ignore: ReadonlySet<unknown> = new Set(),
  workers: () => Promise<WorkerRow[]> = allWorkers,
): Promise<string> {
  try {
    const target = realPath(worktree)
    const terminals = (await query(['terminal', 'list'])).terminals
    if (!Array.isArray(terminals)) throw new LookupError('터미널 목록 형식 오류')
    const handles = new Set<unknown>()
    for (const terminal of terminals) {
      if (!isObject(terminal)) throw new LookupError('터미널 행 형식 오류')
      const path = terminal.worktreePath
      if (!given(path)) continue
      if (typeof path !== 'string') throw new LookupError('터미널 경로 형식 오류')
      if (!('handle' in terminal)) throw new LookupError('터미널 handle 누락')
      if (inside(realPath(path), target)) handles.add(terminal.handle)
    }
    if (handles.size === 0) return ''
    for (const row of await workers()) {
      if (![...rowHandles(row)].some((handle) => handles.has(handle) && !ignore.has(handle))) continue
      const state = resourceOf(row).ownershipState
      if (state === 'user_owned' || state === 'released') return '사용자 보유 터미널'
      if (state !== 'owned') throw new LookupError('터미널 소유 상태 누락')
    }
    return ''
  } catch (e) {
    if (e instanceof LookupError) return '터미널 소유 상태 조회 실패'
    throw e
  }
}
