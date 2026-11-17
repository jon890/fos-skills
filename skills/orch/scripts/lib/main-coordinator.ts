// 저장소의 메인 코디네이터를 Orca 에서 읽어 정한다. 판정은 core/main-coordinator.ts 의 judgeMain 이 소유한다(ADR-035).
//
// findMain(repo):
//     등록이 없으면 조회하지 않고 none 이다.
//     있으면 `orca orchestration run-list` 를 nextCursor 끝까지 읽어 Run 마다 coordinator_handle 을 얻고,
//     `orca terminal list --limit 10000` 으로 터미널마다 agentIdentity 와 connected 를 얻는다.
//     조회가 하나라도 실패하거나 형식이 다르면 unknown 과 이유다. 부르는 쪽은 unknown 이면 넘겨받지 않는다.
// runAlive(run): 그 Run 의 coordinator_handle 터미널에서 에이전트가 실행 중인가. 읽지 못하면 null.
// 사용처: loop/lifecycle.ts(loop start), loop/takeover.ts, lib/requests.ts(받는 메인과 답 대상), status/orch-status.ts.

import { judgeMain, liveTerminal } from '../core/main-coordinator.ts'
import type { MainVerdict, TerminalFact } from '../core/main-coordinator.ts'
import { registeredRuns } from './loop.ts'
import { orcaJson } from './orca.ts'

type Json = Record<string, unknown>
export type MainResult = MainVerdict | { kind: 'unknown'; error: string }

const PAGE_LIMIT = '100'

export function runCoordinators(): Map<string, string> | string {
  const found = new Map<string, string>()
  const seen = new Set<string>()
  let cursor: string | null = null
  for (;;) {
    const got: { ok: true; data: Json } | { ok: false; error: string } = orcaJson<Json>(['orchestration', 'run-list', '--limit', PAGE_LIMIT, ...(cursor ? ['--cursor', cursor] : [])])
    if (!got.ok) return got.error
    const runs = got.data?.runs
    if (!Array.isArray(runs)) return 'run-list 의 runs 가 배열이 아니다'
    for (const row of runs as Json[]) {
      if (typeof row?.id === 'string' && typeof row.coordinator_handle === 'string' && row.coordinator_handle) found.set(row.id, row.coordinator_handle)
    }
    const next = got.data?.nextCursor
    if (next === undefined || next === null || next === '') return found
    if (typeof next !== 'string' || seen.has(next)) return 'run-list 의 cursor 가 문자열이 아니거나 반복된다'
    seen.add(next)
    cursor = next
  }
}

export function terminalFacts(): Map<string, TerminalFact> | string {
  const got = orcaJson<{ terminals?: Json[]; truncated?: boolean }>(['terminal', 'list', '--limit', '10000'])
  if (!got.ok) return got.error
  if (!Array.isArray(got.data?.terminals) || got.data.truncated) return '터미널 목록이 잘렸거나 형식이 잘못됐다'
  const facts = new Map<string, TerminalFact>()
  for (const row of got.data.terminals) {
    if (typeof row?.handle !== 'string') continue
    const agent = row.agentIdentity !== undefined && row.agentIdentity !== null && row.agentIdentity !== ''
    facts.set(row.handle, { handle: row.handle, agent, connected: row.connected !== false && row.status !== 'exited' })
  }
  return facts
}

export function findMain(repo: string): MainResult {
  const entries = registeredRuns(repo)
  if (entries.length === 0) return { kind: 'none', stale: [] }
  const coordinators = runCoordinators()
  if (typeof coordinators === 'string') return { kind: 'unknown', error: coordinators }
  const terminals = terminalFacts()
  if (typeof terminals === 'string') return { kind: 'unknown', error: terminals }
  return judgeMain(entries, coordinators, terminals)
}

export function runAlive(run: string): boolean | null {
  const coordinators = runCoordinators()
  if (typeof coordinators === 'string') return null
  const terminals = terminalFacts()
  if (typeof terminals === 'string') return null
  const handle = coordinators.get(run)
  return handle ? liveTerminal([handle], terminals) !== null : false
}
