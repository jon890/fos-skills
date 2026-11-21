// 메인 코디네이터와 요청의 판정 한 벌이다. 값만 받아 결과를 낸다. 조회는 lib/main-coordinator.ts 와 lib/requests.ts 가 한다.
// 계약은 docs/features/orch-main-coordinator/design.md 의 「메인 판정」, 「요청 기록」 이다(ADR-035).
//
// 메인(judgeMain): 루프 등록(등록 이른 순) 가운데 그 Run 의 터미널(run-list 의 coordinator_handle 과 등록 파일의 coordinator_terminal)
//     하나라도 터미널 목록에 있고, agentIdentity 가 있고, connected 가 false 가 아니면 살아 있는 Run 이다. 첫 살아 있는 Run 이 메인이다.
//     없으면 none 이고 stale 에 등록된 Run 을 모두 담는다. main 이면 alive 에 살아 있는 등록 Run 을 모두 담는다.
// 답 대상(replyTarget): 보낸 Run 이 살아 있으면 그 Run, 아니면 보낸 저장소의 지금 메인, 그것도 없으면 보낸 Run 이다(스펙 REQ8).
// 상태 전이(nextRequestState): sent, held 는 모든 동작을 받는다. accepted 는 hold, done, fail 만 받는다. rejected, done, failed 는 끝이다.

import type { RunEntry } from './loop.ts'

export type TerminalFact = { handle: string; agent: boolean; connected: boolean }

// alive 는 살아 있는 등록 Run 전부(등록 순)다. 넘겨받기가 살아 있는 Run 의 등록을 지우지 않는 데 쓴다(스펙 DECISION24)
export type MainVerdict = { kind: 'main'; run: string; terminal: string; alive: string[] } | { kind: 'none'; stale: string[] }

export function runTerminals(entry: RunEntry, coordinators: ReadonlyMap<string, string>): string[] {
  const found = [coordinators.get(entry.run), entry.coordinator_terminal].filter((handle): handle is string => typeof handle === 'string' && handle !== '')
  return [...new Set(found)]
}

// 살아 있는 터미널 하나. 없으면 null
export function liveTerminal(handles: string[], terminals: ReadonlyMap<string, TerminalFact>): string | null {
  for (const handle of handles) {
    const fact = terminals.get(handle)
    if (fact && fact.agent && fact.connected) return handle
  }
  return null
}

export function judgeMain(entries: RunEntry[], coordinators: ReadonlyMap<string, string>, terminals: ReadonlyMap<string, TerminalFact>): MainVerdict {
  let main: { run: string; terminal: string } | null = null
  const alive: string[] = []
  for (const entry of entries) {
    const terminal = liveTerminal(runTerminals(entry, coordinators), terminals)
    if (terminal === null) continue
    alive.push(entry.run)
    main ??= { run: entry.run, terminal }
  }
  if (main) return { kind: 'main', ...main, alive }
  return { kind: 'none', stale: entries.map((entry) => entry.run) }
}

export function replyTarget(fromRun: string, fromRunAlive: boolean, fromRepoMain: string | null): string {
  if (fromRunAlive) return fromRun
  return fromRepoMain ?? fromRun
}

export const REQUEST_STATES = ['sent', 'accepted', 'held', 'rejected', 'done', 'failed'] as const
export type RequestState = (typeof REQUEST_STATES)[number]
export const REQUEST_ACTIONS = ['accept', 'hold', 'reject', 'done', 'fail'] as const
export type RequestAction = (typeof REQUEST_ACTIONS)[number]

const TARGET: Record<RequestAction, RequestState> = { accept: 'accepted', hold: 'held', reject: 'rejected', done: 'done', fail: 'failed' }
const ALLOWED: Record<RequestState, readonly RequestAction[]> = {
  sent: REQUEST_ACTIONS,
  held: REQUEST_ACTIONS,
  accepted: ['hold', 'done', 'fail'],
  rejected: [],
  done: [],
  failed: [],
}

export function isClosed(state: RequestState): boolean {
  return ALLOWED[state].length === 0
}

// 받을 수 있으면 다음 상태, 아니면 null
export function nextRequestState(current: RequestState, action: RequestAction): RequestState | null {
  return ALLOWED[current].includes(action) ? TARGET[action] : null
}

// 이유가 반드시 있어야 하는 동작(스펙 REQ6, REQ7)
export function needsReason(action: RequestAction): boolean {
  return action === 'hold' || action === 'reject' || action === 'fail'
}

// 상태마다 Orca 메시지의 kind
export function replyKind(state: RequestState): string {
  return `REQUEST-${state.toUpperCase()}`
}

// 받는 저장소 이름으로 양쪽 보드의 항목 id 를 정한다. 보드를 함께 쓰면 항목 하나로 남긴다.
export function boardIds(number: number, toName: string, sameBoard: boolean): { to: string; from: string | null } {
  const id = `req-${toName.replace(/[^A-Za-z0-9_.-]/g, '-')}-${number}`
  return { to: id, from: sameBoard ? null : id }
}

// 답 없음 알림을 보낼 때인가(스펙 REQ9)
export function ackOverdue(state: RequestState, createdAt: string, noticedAt: string | null, now: number, ackSec: number): boolean {
  if (state !== 'sent' || noticedAt) return false
  const at = Date.parse(createdAt)
  return Number.isFinite(at) && now - at >= ackSec * 1000
}
