// worker 상태 판정 한 벌이다. 한 워크트리(또는 한 dispatch)의 worker 행, PR, 앞선 커밋 수, 터미널 화면을 받아 넷 가운데 하나로 정한다.
// 사용처: cleanup-sweep.ts(일하는 중 먼저 건너뛰기, PR 없이 끝난 워크트리, 남은 프로세스 끄기), orch-doctor.ts(--run 의 WORKER-STATE 줄),
// wait-important.ts(화면이 작업 중인 worker 를 끊긴 것으로 보지 않기).
// 예전에는 스크립트마다 dispatch 상태, PR 상태, 터미널 소유를 따로 읽어, 같은 worker 를 한쪽은 끝났다고, 다른 쪽은 아니라고 봤다.
//
// 상태:
//     working     일하는 중. 치우지 않는다
//     done        끝남. 치워도 된다(워크트리, 터미널, 남은 프로세스)
//     taken_over  사용자가 넘겨받음. 코디네이터가 건드리지 않는다
//     unknown     판정 못 함. reason 에 이유를 둔다
//
// 행의 분류:
//     살아 있음   workerState 가 working, ready 이거나, dispatchStatus 가 pending, dispatched, running 이고 workerState 가
//                abandoned, failed, stopped 가 아니며 반납(released)되지 않았다
//     끝남       살아 있지 않고, dispatchStatus 가 completed, failed, canceled 이거나 workerState 가 succeeded, fenced 이거나
//                반납됐다(terminalState 나 resource.releaseState 가 released). failed 도 끝난 것으로 본다(사용자 결정 2026-10-30).
//                같은 워크트리로 다시 맡길 일이 있으면 새 워크트리로 띄운다
//     그 밖      끊긴 dispatch(dispatched 인데 workerState 가 abandoned 같은 것)다
//
// 넘겨받은 터미널: resource.ownershipState 가 user_owned 이고 그 행의 터미널 handle 이 own(호출자가 코디네이터 것으로 확인한 handle)에 없다.
// 에이전트 작업 중 화면: lib/screen.ts 의 working(작업 중)과 permission(권한 확인 창에서 기다림)이다.
//
// 판정 (위에서부터 처음 걸린 것):
//     1  행이 없다                                                    unknown     그 경로의 dispatch 를 모른다
//     2  살아 있는 행 가운데 넘겨받지 않은 것이 있다                   working     살아 있는 dispatch
//     3  살아 있는 행의 화면이 에이전트 작업 중이다                    working     user_takeover 표시지만 화면이 작업 중이다.
//                                                                                새 세션에서 띄운 worker 를 Orca 가 이렇게 적는다(실측 2026-10-29)
//     4  살아 있는 행이 있다(모두 넘겨받았고 화면이 작업 중이 아니다)  taken_over
//     5  살아 있지 않은 행의 읽은 화면이 넘겨받은 터미널이다           taken_over  끝난 dispatch 의 터미널에 사용자가 들어왔다
//     6  살아 있지 않은 행의 화면이 에이전트 작업 중이다               working     dispatch 상태와 달리 에이전트가 돌고 있다
//     7  끝나지 않은 행이 있다                                         unknown     끝나지 않은 dispatch
//     8  PR 을 보지 않았다 / 조회 실패                                 unknown
//     9  PR 이 MERGED 다                                               done
//     10 PR 이 OPEN 이다                                               working     worker 가 머지까지 맡는다
//     11 PR 이 머지 없이 CLOSED 다                                     unknown
//     12 PR 이 없고 앞선 커밋을 세지 않았거나 세지 못했다              unknown
//     13 PR 이 없고 base 보다 앞선 커밋이 0 개다                       done
//     14 PR 이 없고 앞선 커밋이 있다                                   unknown
//     화면은 screens 에 든 handle 만 본다. 없는 handle 은 화면을 읽지 못했거나 터미널이 없는 것이다.
//     5 와 6 은 화면을 읽은 터미널에만 걸린다. 닫힌 터미널의 옛 소유 표시로 끝난 worker 를 붙잡지 않는다.
//
// judge 는 조회하지 않는다. 화면이 필요한 handle 은 screenHandles 로 고르고 readScreens 로 읽어 넘긴다.

import { orcaJson } from './orca.ts'
import { readScreen, screenLines } from './screen.ts'
import type { ScreenState } from './screen.ts'

type Row = Record<string, unknown>

export type WorkerState = 'working' | 'done' | 'taken_over' | 'unknown'
export type Verdict = { state: WorkerState; reason: string }
// PR 이 없으면 'none', 조회가 실패했으면 'error' 다
export type PrFact = { state: string; number?: unknown } | 'none' | 'error'
export type Facts = {
  rows: Row[]
  // 보지 않았으면 undefined 다. PR 이 필요한 판정(8 부터)은 unknown 이 된다
  pr?: PrFact
  // base 보다 앞선 커밋 수. 세지 않았으면 undefined, 세지 못했으면 null 이다
  ahead?: number | null
  screens?: ReadonlyMap<unknown, ScreenState>
  own?: ReadonlySet<unknown>
}

export const LIVE_WORKER = new Set(['working', 'ready'])
export const LIVE_DISPATCH = new Set(['pending', 'dispatched', 'running'])
export const LOST_WORKER = new Set(['abandoned', 'failed', 'stopped'])
export const FINISHED_DISPATCH = new Set(['completed', 'failed', 'canceled'])
export const FINISHED_WORKER = new Set(['succeeded', 'fenced'])
const AGENT_BUSY = new Set<ScreenState>(['working', 'permission'])

function obj(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {}
}

function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

function handlesOf(row: Row): unknown[] {
  return [...new Set([obj(row.resource).terminalHandle, row.agentTerminalHandle].filter(given))]
}

function released(row: Row): boolean {
  return row.terminalState === 'released' || obj(row.resource).releaseState === 'released'
}

export function isLive(row: Row): boolean {
  const worker = String(row.workerState ?? '')
  if (LIVE_WORKER.has(worker)) return true
  return LIVE_DISPATCH.has(String(row.dispatchStatus ?? '')) && !LOST_WORKER.has(worker) && !released(row)
}

export function isFinished(row: Row): boolean {
  if (isLive(row)) return false
  return FINISHED_DISPATCH.has(String(row.dispatchStatus ?? '')) || FINISHED_WORKER.has(String(row.workerState ?? '')) || released(row)
}

function takenOver(row: Row, own: ReadonlySet<unknown>): boolean {
  return obj(row.resource).ownershipState === 'user_owned' && !handlesOf(row).some((h) => own.has(h))
}

function id(row: Row): string {
  return String(row.dispatchId ?? '?')
}

function ids(rows: Row[]): string {
  return rows.map(id).join(', ')
}

function mark(row: Row): string {
  const resource = obj(row.resource)
  return String(resource.retainedReason ?? resource.ownershipState ?? '')
}

// 그 행의 터미널 가운데 화면이 busy 인 handle. 없으면 undefined 다
function busyHandle(row: Row, screens: ReadonlyMap<unknown, ScreenState>): unknown {
  return handlesOf(row).find((h) => AGENT_BUSY.has(screens.get(h) as ScreenState))
}

function screenOf(row: Row, screens: ReadonlyMap<unknown, ScreenState>): string {
  const seen = handlesOf(row).filter((h) => screens.has(h))
  return seen.length ? seen.map((h) => `${String(h)} ${screens.get(h)}`).join(', ') : '못 읽음'
}

// 머리 주석의 「판정」.
export function judge(facts: Facts): Verdict {
  const { rows, pr, ahead } = facts
  const screens = facts.screens ?? new Map<unknown, ScreenState>()
  const own = facts.own ?? new Set<unknown>()
  if (rows.length === 0) return { state: 'unknown', reason: '그 경로의 dispatch 를 모른다' }

  const live = rows.filter(isLive)
  const plain = live.filter((row) => !takenOver(row, own))
  if (plain.length) return { state: 'working', reason: `살아 있는 dispatch ${ids(plain)}` }
  for (const row of live) {
    const busy = busyHandle(row, screens)
    if (busy !== undefined) {
      return { state: 'working', reason: `${mark(row)} 표시지만 화면이 작업 중이다(${id(row)}, ${String(busy)})` }
    }
  }
  if (live.length) {
    return { state: 'taken_over', reason: `사용자가 넘겨받은 터미널(${live.map((row) => `${id(row)} ${mark(row)}, 화면 ${screenOf(row, screens)}`).join('; ')})` }
  }

  const seen = rows.filter((row) => handlesOf(row).some((h) => screens.has(h)))
  const taken = seen.filter((row) => takenOver(row, own))
  if (taken.length) return { state: 'taken_over', reason: `끝난 dispatch 의 터미널을 사용자가 넘겨받았다(${taken.map((row) => `${id(row)} ${mark(row)}`).join(', ')})` }
  for (const row of seen) {
    const busy = busyHandle(row, screens)
    if (busy !== undefined) return { state: 'working', reason: `dispatch ${id(row)} 가 ${String(row.dispatchStatus ?? row.workerState)} 지만 화면이 작업 중이다(${String(busy)})` }
  }
  const open = rows.filter((row) => !isFinished(row))
  if (open.length) return { state: 'unknown', reason: `끝나지 않은 dispatch ${ids(open)}` }

  const done = `끝난 dispatch ${ids(rows)}`
  if (pr === undefined) return { state: 'unknown', reason: `${done}, PR 을 보지 않았다` }
  if (pr === 'error') return { state: 'unknown', reason: `${done}, PR 조회 실패` }
  if (pr !== 'none') {
    const number = given(pr.number) ? ` #${String(pr.number)}` : ''
    if (pr.state === 'MERGED') return { state: 'done', reason: `${done}, PR${number} MERGED` }
    if (pr.state === 'OPEN') return { state: 'working', reason: `${done}, PR${number} 이 열려 있어 worker 가 머지까지 맡는다` }
    return { state: 'unknown', reason: `${done}, PR${number} 이 머지 없이 ${pr.state}` }
  }
  if (ahead === undefined) return { state: 'unknown', reason: `${done}, PR 없음, 앞선 커밋을 세지 않았다` }
  if (ahead === null) return { state: 'unknown', reason: `${done}, PR 없음, base 보다 앞선 커밋을 세지 못했다` }
  if (ahead === 0) return { state: 'done', reason: `${done}, PR 없음, base 보다 앞선 커밋 0 개` }
  return { state: 'unknown', reason: `${done}, PR 없음, base 보다 앞선 커밋 ${ahead} 개` }
}

// 판정에 화면이 필요한 handle. 살아 있는 행 가운데 넘겨받은 것(판정 3)과, 살아 있지 않은 행 가운데 alive 에 든 터미널(판정 5, 6)이다.
// alive 를 주지 않으면 살아 있지 않은 행의 화면은 고르지 않는다.
export function screenHandles(rows: Row[], own: ReadonlySet<unknown> = new Set(), alive?: ReadonlySet<unknown>): unknown[] {
  const handles = new Set<unknown>()
  for (const row of rows) {
    if (isLive(row)) {
      if (takenOver(row, own)) for (const h of handlesOf(row)) handles.add(h)
    } else if (alive) {
      for (const h of handlesOf(row)) if (alive.has(h)) handles.add(h)
    }
  }
  return [...handles]
}

// 터미널 화면을 읽어 lib/screen.ts 의 상태로 낸다. 읽지 못한 handle 은 담지 않는다.
export function readScreens(handles: unknown[]): Map<unknown, ScreenState> {
  const screens = new Map<unknown, ScreenState>()
  for (const handle of handles) {
    if (typeof handle !== 'string' || !handle) continue
    const read = orcaJson<Row>(['terminal', 'read', '--terminal', handle, '--screen'])
    if (read.ok) screens.set(handle, readScreen(screenLines(obj(read.data))).state)
  }
  return screens
}
