// 옛 wait 의 끊김 판정을 루프에서 재사용한다. 일부러 끝낸 작업과 작업 중인 화면은 알리지 않는다.

import { objectOr } from '../core/json.ts'
import { lostWorkers, retriedLost, deliberateEnd, taskClosed } from '../core/lost-workers.ts'
import type { Json, Lost } from '../core/lost-workers.ts'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { orcaJson } from './orca.ts'
import { workerRows } from './workers.ts'
import { judge, readScreens, screenHandles } from './worker-state.ts'
import { makeParent, pathOf } from './paths.ts'
import { fire } from './events.ts'
import { notifyRun } from './run-notice.ts'

const err = (line: string) => console.error(line)
function orcaResult(args: string[]): Json | null {
  const got = orcaJson<Json>(['orchestration', ...args])
  if (!got.ok) throw new Error(got.error)
  return got.data
}

function latestDispatch(taskId: unknown): Json {
  return objectOr(orcaResult(['dispatch-show', '--task', String(taskId)])?.dispatch)
}

function loadState(file: string): Json {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return objectOr(data)
  } catch {
    return {}
  }
}

function loadReported(file: string, runId: string): Json {
  return objectOr(loadState(file)[runId])
}

function saveReported(file: string, runId: string, kinds: Record<string, string>, repo: string): boolean {
  if (Object.keys(kinds).length === 0) return true
  const data = loadState(file)
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const entry = objectOr(data[runId])
  data[runId] = entry
  for (const [dispatch, kind] of Object.entries(kinds)) {
    if (kind === 'handled' || !Object.hasOwn(entry, dispatch)) entry[dispatch] = `${kind} ${now}`
  }
  try {
    makeParent(file, repo)
    // 쓰는 도중에 끊겨도 앞 내용이 깨지지 않게 옆 파일에 쓰고 바꾼다
    const tmp = join(dirname(file), `${basename(file)}.${process.pid}.tmp`)
    writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`)
    renameSync(tmp, file)
    return true
  } catch (e) {
    err(`wait-important: 판정한 dispatch 를 ${file} 에 적지 못했다: ${(e as Error).message}`)
    return false
  }
}

function unhandledLost(runId: string, rows: Json[], ignore: Set<unknown>): { found: Lost[]; deliberate: Record<string, string> } {
  const lost = lostWorkers(rows, new Set(rows.map((w) => w.dispatchId))).filter(([d]) => !ignore.has(d))
  const retried = retriedLost(rows, lost)
  const candidates = lost.filter(([d]) => !retried.has(d))
  if (candidates.length === 0) return { found: [], deliberate: {} }
  const tasks = orcaResult(['task-list', '--run', runId])?.tasks
  if (!Array.isArray(tasks)) return { found: [], deliberate: {} }
  const byTask = new Map(tasks.map(value => objectOr(value)).map((t) => [t.id, t]))
  const taskOf = new Map(rows.map((w) => [w.dispatchId, w.taskId]))
  const found: Lost[] = []
  const deliberate: Record<string, string> = {}
  const latestOf = new Map<unknown, Json>()
  for (const [dispatch, stage] of candidates) {
    const taskId = taskOf.get(dispatch)
    const task = byTask.get(taskId)
    if (!task || taskClosed(task)) continue
    if (!latestOf.has(taskId)) latestOf.set(taskId, latestDispatch(taskId))
    const latest = latestOf.get(taskId) ?? {}
    if (latest.id !== dispatch) continue
    const reason = deliberateEnd(latest)
    if (reason) deliberate[dispatch] = reason
    else found.push([dispatch, stage])
  }
  return { found, deliberate }
}

function dropWorking(rows: Json[], lost: Lost[]): Lost[] {
  const byDispatch = new Map(rows.map((w) => [w.dispatchId, w]))
  return lost.filter(([dispatch, stage]) => {
    const row = byDispatch.get(dispatch)
    if (!row) return true
    const handles = new Set([row.agentTerminalHandle, objectOr(row.resource).terminalHandle].filter(Boolean))
    // 프로세스가 끝난 열린 dispatch 는 행만으로는 살아 있어 judge 가 늘 working 이다. 화면만 본다
    if (stage === 'liveness_exited') {
      const screens = readScreens([...handles])
      const busy = [...screens].find(([, state]) => state === 'working' || state === 'permission')
      if (!busy) return true
      err(`wait-important: ${dispatch} 는 ${String(stage)} 로 보이지만 끊긴 것으로 보지 않는다: 화면이 작업 중이다(${String(busy[0])} ${busy[1]})`)
      return false
    }
    const verdict = judge({ rows: [row], screens: readScreens(screenHandles([row], new Set(), handles)) })
    if (verdict.state !== 'working') return true
    err(`wait-important: ${dispatch} 는 ${String(stage)} 로 보이지만 끊긴 것으로 보지 않는다: ${verdict.reason}`)
    return false
  })
}

export async function watchLost(repo: string, run: string, base: string, workers?: ReturnType<typeof workerRows>): Promise<void> {
  const file = join(pathOf('state', repo), 'wait-important-lost.json')
  const got = workers ?? workerRows(run)
  if (!got.ok) throw new Error(got.error)
  const reported = loadReported(file, run)
  const found = unhandledLost(run, got.rows, new Set(Object.keys(reported)))
  const lost = dropWorking(got.rows, found.found)
  if (!saveReported(file, run, found.deliberate, repo)) throw new Error('끊김 기록 저장 실패')
  for (const [dispatch, stage] of lost) {
    const sent = notifyRun(run, 'WORKER-LOST', `${dispatch} stage=${String(stage)}`)
    if (!sent.ok) throw new Error(`NOTICE-FAIL WORKER-LOST ${sent.error}`)
    const row = got.rows.find(row => row.dispatchId === dispatch) ?? {}
    // 이벤트 설정 오류가 이미 전송한 메시지의 중복 전송으로 이어지지 않게 먼저 기록한다.
    if (!saveReported(file, run, { [dispatch]: 'lost' }, repo)) throw new Error(`끊김 기록 저장 실패: ${dispatch}`)
    try {
      await fire('worker-lost', { worker: { task: row.taskId ?? null, dispatch, terminal: row.agentTerminalHandle ?? null, worktree: null, spec: null }, stage }, { repo, run, base })
    } catch (error) { err(`worker-lost 이벤트 실패: ${String(error)}`) }

  }
}

export { LIVE_STATUSES, LOST_WORKER_STATES, lostWorkers, retriedLost, deliberateEnd, taskClosed } from '../core/lost-workers.ts'
export type { Json, Lost } from '../core/lost-workers.ts'
