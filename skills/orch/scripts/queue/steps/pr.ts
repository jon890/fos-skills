// PR 조회, 이벤트 입력과 큐 차례 기록.

import type { FireContext } from '../../lib/events.ts'
import { checkSnapshot, currentChecks, gh } from '../../lib/gh.ts'
import type { RunResult } from '../../lib/proc.ts'
import { run } from '../../lib/proc.ts'
import { TURN_PHASES, writeTurn, writeTurnAt } from '../../lib/queue-turn.ts'
import type { StepContext } from './model.ts'
import { Stop } from './model.ts'
import type { StepState } from './model.ts'
import { chomp, nap, stop } from './runtime.ts'

// PR 하나의 필드. 호출이 실패하면 ghRetries 번까지 다시 부르고, 그래도 실패하면 빈 문자열이다
export async function field(stepContext: StepContext, state: StepState, n: string, jsonField: string, jq: string, fresh = false): Promise<string> {
  let attempt = 1
  for (;;) {
    const rollup = jsonField === 'statusCheckRollup'
    if (rollup) {
      const got = checkSnapshot(state.o.repo, n, state.p.ph, fresh)
      if (!got.ok) {
        if (attempt >= state.ghRetries) return ''
        attempt++
        await nap(stepContext, state.ghRetrySeconds)
        continue
      }
      try {
        const pr = got.data
        if (!pr.headRefOid || pr.headRefOid !== state.p.ph) stop(`${n} 체크 조회 중 HEAD 가 바뀌었다 checked=${state.p.ph} now=${pr.headRefOid || '?'}`)
        pr.statusCheckRollup = currentChecks(pr.statusCheckRollup, pr.headRefOid)
        const filtered = run(['jq', '-r', jq], { input: JSON.stringify(pr) })
        if (filtered.code === 0) return chomp(filtered.stdout)
      } catch (e) {
        if (e instanceof Stop) throw e
      }
      return ''
    }
    const done = gh(['pr', 'view', n, '--json', jsonField, '--jq', jq], { cache: false })
    if (done.code === 0) return chomp(done.stdout)
    if (attempt >= state.ghRetries) return ''
    attempt += 1
    await nap(stepContext, state.ghRetrySeconds)
  }
}

export function api(state: StepState, ...args: string[]): RunResult {
  return gh(['api', '--hostname', state.p.apiHost, ...args], { cache: false })
}

export function prEnv(state: StepState): Record<string, string> {
  const p = state.p
  return { PR: p.n, BRANCH: p.branch, OWNER: p.owner, REPO: p.repo }
}

// 이벤트 입력의 pr 객체(lib/events.ts 머리 주석의 「이벤트별 필드」)
export function prInput(state: StepState): Record<string, unknown> {
  const p = state.p
  return { number: Number(p.n), title: p.title, branch: p.branch, head: p.ph, author: p.author, draft: p.draft, url: p.url }
}

export function eventContext(state: StepState): FireContext {
  return { repo: state.repoDir, base: state.p.base, run: null }
}

// 차례 기록을 쓴다(머리 주석의 「차례 기록」). 쓰지 못해도 큐는 이어 간다. 첫 실패만 stderr 에 남긴다
export function turn(state: StepState, phase: string, pr: number | null = state.pr ? Number(state.pr.n) : null): void {
  if (!state.repoDir) return
  try {
    const turn = { pid: process.pid, prs: state.remaining, pr, phase, since: new Date().toISOString(), held: state.heldReasons }
    if (state.turnPath) writeTurnAt(state.turnPath, turn)
    else state.turnPath = writeTurn(state.repoDir, turn)
  } catch (e) {
    if (state.turnWarned) return
    state.turnWarned = true
    process.stderr.write(`경고: 머지 큐 차례 기록을 쓰지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
  }
}

// 끝난 큐의 기록을 남긴다. 지우지 않는다. 끝난 뒤 들어온 틱이 held 를 루프 로그에 옮기고 지운다(lib/queue-turn.ts)
export function endTurn(state: StepState): void {
  if (!state.turnPath) return
  state.remaining = []
  turn(state, TURN_PHASES.end, null)
}
