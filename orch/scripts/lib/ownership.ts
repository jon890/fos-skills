// 워크트리 정리 전에 그 경로의 살아 있는 터미널이 사용자 소유인지 확인하는 판정 한 벌이다.
//
// 사용처: remove-worktree.ts 가 삭제 전에 blocker 를 부른다. 같은 판정의 Python 원본 terminal_ownership.py 는
// 아직 Python 인 cleanup-sweep.py 가 import 한다.
//
// 터미널 목록이나 모든 Run 의 소유 상태를 읽지 못하면 빈 셸도 닫지 않고 남긴다.
// 끝난 dispatch 의 터미널은 `worker-list` 의 `resource` 로 아래처럼 나뉜다.
//
//     owned, 이유 없음                      PR 이 MERGED 면 터미널을 닫고 dispatch 를 release 한다
//     user_owned / user_takeover            `남김: 사용자 보유 터미널` (cleanup-sweep 의 --close-own-taken-over 를 켠 때만 예외)
//     released                              `남김: 사용자 보유 터미널`
//     external / external_terminal          소유 상태가 owned 가 아니라 `터미널 소유 상태 조회 실패` 로 남긴다
//     owned / identity_unproven             owned 라 막지 않는다. Orca 의 release 는 닫지 않으므로 sweep 이 경로로 찾아 닫는다
//
// 범위 읽기: 소유 상태는 모든 Run 의 worker 행(allWorkers)에서 읽는다. 범위 없는 `worker-list` 는 부른 터미널에 Run 이
// 묶여 있으면 그 Run 만 준다(scope.source bound). 코디네이터와 그 자식 프로세스에서 부르면 늘 그렇다.
// Orca CLI 는 `ORCA_TERMINAL_HANDLE` 이 없으면 작업 디렉터리가 든 워크트리의 활성 터미널로 호출자를 정해,
// 환경 변수를 빼도 범위가 넓어지지 않는다(lib/orca.ts 머리 주석). 그래서 범위가 all 이 아니면 `run-list` 를 끝까지 따라
// Run 마다 `worker-list --run`(scope flag)을 읽어 합친다. 조회 자체가 실패할 때만 실패다.
//
// 내보내는 것:
//     LookupError    조회 실패. 옛 LOOKUP_ERRORS 에 해당한다. 아래 함수는 조회 실패를 모두 이것으로 던진다
//     allWorkers     모든 Run 의 worker 행
//     runWorkers     한 Run 의 worker 행
//     cached         함수의 결과나 LookupError 를 maxAge 초 동안 되풀이한다
//     rowHandles     한 행이 가리키는 터미널 handle
//     blocker        안전하면 빈 문자열, 남길 때는 이유

import { realPath, inside } from './fs.ts'
import { orcaBin } from './orca.ts'
import { runAsync } from './proc.ts'

// Run 마다 읽을 때 동시에 띄우는 orca 수. Run 251개 실측: 8 이면 30초, 16 이면 18초
export const JOBS = 16
// 정리 한 번 안에서 읽은 행을 다시 쓰는 시간(초). 워크트리 삭제가 길어져도 그사이 넘겨받은 터미널을 놓치지 않게 다시 읽는다
export const MAX_AGE = 60
const QUERY_TIMEOUT_MS = 30_000

export class LookupError extends Error {}

export type WorkerRow = Record<string, unknown>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 값이 없거나 빈 문자열, 0, false 면 없는 것으로 본다. 옛 Python 의 `x or {}` 와 `if not x` 판정과 같다
function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && value !== 0 && value !== false
}

async function query(args: string[]): Promise<Record<string, unknown>> {
  const done = await runAsync([orcaBin(), ...args, '--json'], { timeoutMs: QUERY_TIMEOUT_MS })
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

async function runIds(): Promise<string[]> {
  const ids: string[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  for (;;) {
    const result = await query(['orchestration', 'run-list', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])])
    if (!Array.isArray(result.runs)) throw new LookupError('Run 목록 형식 오류')
    for (const run of result.runs) {
      if (!isObject(run) || typeof run.id !== 'string') throw new LookupError('Run 행 형식 오류')
      ids.push(run.id)
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
export async function allWorkers(): Promise<WorkerRow[]> {
  const rows = await workerPages([], 'all')
  if (rows !== null) return rows
  const ids = await runIds()
  const results: WorkerRow[][] = new Array(ids.length)
  let next = 0
  let failure: unknown = null
  const lane = async () => {
    while (failure === null && next < ids.length) {
      const at = next++
      try {
        results[at] = await runWorkers(ids[at])
      } catch (e) {
        failure ??= e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(JOBS, ids.length) }, lane))
  if (failure !== null) throw failure
  return results.flat()
}

// fn 의 결과나 LookupError 를 maxAge 초 동안 되풀이한다. 여러 경로를 볼 때 모든 Run 을 경로마다 다시 읽지 않는다.
// LookupError 가 아닌 예외는 기억하지 않고 그대로 던진다.
export function cached<T>(fn: () => Promise<T>, maxAge: number = MAX_AGE): () => Promise<T> {
  let box: { at: number; value?: T; error?: LookupError } | null = null
  return async () => {
    if (box === null || (performance.now() - box.at) / 1000 > maxAge) {
      try {
        const value = await fn()
        box = { at: performance.now(), value }
      } catch (e) {
        if (!(e instanceof LookupError)) throw e
        box = { at: performance.now(), error: e }
      }
    }
    if (box.error) throw box.error
    return box.value as T
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
