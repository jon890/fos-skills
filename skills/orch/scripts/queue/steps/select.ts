// 차례 선택, 보류와 앞지르기.

import { ConfigError } from '../../lib/config.ts'
import { TURN_PHASES } from '../../lib/queue-turn.ts'
import { notifyConflict, tellHeld } from './finish.ts'
import { processPr } from './merge.ts'
import type { Attempt, Mode, SelectionResult, StepContext, StepResult } from './model.ts'
import { Conflict, Deferred, HeadChanged, NotReady, Stop, WorkerFix } from './model.ts'
import type { StepState } from './model.ts'
import { turn } from './pr.ts'
import { log, out } from './runtime.ts'
import { dropCopy } from './setup.ts'

// 묶음 안에서 n 보다 앞에 있고 머지되지 않고 빠진 PR. 없으면 null
export function droppedBefore(state: StepState, n: string): string | null {
  const chain = state.o.chains.find((c) => c.includes(n))
  if (!chain) return null
  return chain.slice(0, chain.indexOf(n)).find((m) => state.held.includes(m)) ?? null
}

// PR 하나를 처리하고 결과를 낸다. 보류와 충돌의 줄(STOP, CONFLICT)은 여기서 찍는다
export async function attempt(stepContext: StepContext, state: StepState, item: string, mode: Mode): Promise<StepResult<Attempt>> {
  const n = item.split(':')[0]
  state.mode = mode
  try {
    await processPr(stepContext, state, item)
    return { kind: 'merged', changes: {} }
  } catch (e) {
    // 설정 오류는 그 PR 의 보류가 아니라 사용법 오류다. 보류를 이어 가는 기본에서도 큐를 멈춘다
    if (e instanceof ConfigError) return { kind: 'config', error: e, changes: {} }
    if (e instanceof Deferred) return { kind: 'deferred', deferred: e, changes: {} }
    if (e instanceof NotReady) return { kind: 'not-ready', reason: e.message, changes: {} }
    if (e instanceof Conflict) {
      out(`CONFLICT ${e.message}`)
      state.conflicted.push(n)
      notifyConflict(state, n, e.message)
      return { kind: 'held', reason: e.message, changes: {} }
    }
    if (e instanceof Stop) {
      out(`STOP ${e.message}`)
      if (e instanceof WorkerFix) await tellHeld(state, n, e.why)
      return { kind: 'held', reason: e instanceof WorkerFix ? `${e.message}: ${e.why}` : e.message,
        changes: {}, retryable: e instanceof HeadChanged || (e instanceof WorkerFix && e.retryable) }
    }
    // 예상 못 한 오류도 그 PR 의 보류로 다룬다
    process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`)
    out(`STOP ${n} 예상 못 한 오류`)
    return { kind: 'held', reason: `${n} 예상 못 한 오류`, changes: {} }
  } finally {
    dropCopy(state)
    state.mode = 'normal'
  }
}

// 그 차례 PR 의 update-branch 뒤 대기를 미뤄도 되는가(머리 주석의 「앞지르기」). 뒤에 앞지를 후보가 있어야 한다
export function canDefer(state: StepState, i: number, handled: Set<number>): boolean {
  const o = state.o
  if (!(o.upToDate && o.upToDateWhen === 'overlap' && o.continueOnHold)) return false
  return o.items.some((item, j) => j > i && !handled.has(j) && !inChain(state, item.split(':')[0]))
}

export function inChain(state: StepState, n: string): boolean {
  return state.o.chains.some((chain) => chain.includes(n))
}

// 미룬 차례 PR 뒤의 PR 가운데 기다리지 않고 머지할 수 있는 것을 머지한다(머리 주석의 「앞지르기」). 설정 오류면 그 결과를 낸다
export async function overtake(stepContext: StepContext, state: StepState, i: number, deferred: Deferred, handled: Set<number>): Promise<StepResult<Attempt> | null> {
  const o = state.o
  log(`${deferred.n} 이 update-branch 뒤 체크를 기다리는 동안 겹치지 않고 준비된 뒤 PR 을 먼저 머지한다`)
  state.against = { n: deferred.n, files: deferred.files }
  try {
    for (const [j, item] of o.items.entries()) {
      if (j <= i || handled.has(j)) continue
      const m = item.split(':')[0]
      if (inChain(state, m)) continue
      state.remaining = left(state, i, handled)
      turn(state, TURN_PHASES.overtake, Number(m))
      const result = await attempt(stepContext, state, item, 'quick')
      Object.assign(state, result.changes)
      if (result.kind === 'not-ready') {
        log(`${m} 앞지르지 않는다: ${result.reason}`)
        continue
      }
      if (result.kind === 'config') return result
      handled.add(j)
      if (result.kind === 'merged') log(`${m} 차례 PR ${deferred.n} 보다 먼저 머지했다`)
      else if (result.kind === 'held') {
        hold(state, m, result.reason)
        if (result.retryable) state.retryItems.add(item)
        log(state.conflicted.includes(m) ? `${m} 충돌. 큐에서 빼고 다음 PR 로 간다` : `${m} 보류. 다음 PR 로 간다`)
      }
    }
  } finally {
    state.against = null
  }
  return null
}

// 차례 기록의 prs. i 부터 끝까지에서 이미 처리한 PR 을 뺀다
export function left(state: StepState, i: number, handled: Set<number>): number[] {
  return state.o.items.flatMap((item, j) => (j >= i && !handled.has(j) ? [Number(item.split(':')[0])] : []))
}

export function hold(state: StepState, n: string, reason: string): void {
  state.held.push(n)
  state.heldReasons.push({ pr: Number(n), reason })
}

// 차례 선택과 보류 재판정을 끝내고, 마무리할 방법을 진입 파일에 돌려준다.
export async function selectQueue(stepContext: StepContext, state: StepState): Promise<SelectionResult> {
  const o = state.o
  // 앞지르기로 이미 처리한 자리
  const handled = new Set<number>()
  for (const [i, item] of o.items.entries()) {
    if (handled.has(i)) continue
    const n = item.split(':')[0]
    state.remaining = left(state, i, handled)
    state.pr = null
    turn(state, TURN_PHASES.start, Number(n))
    const before = droppedBefore(state, n)
    if (before !== null) {
      out(`SKIP ${n} 묶음의 앞 PR ${before} 가 머지되지 않았다`)
      state.held.push(n)
      state.heldReasons.push({ pr: Number(n), reason: `묶음의 앞 PR ${before} 가 머지되지 않았다` })
      continue
    }
    let result = await attempt(stepContext, state, item, canDefer(state, i, handled) ? 'defer' : 'normal')
    Object.assign(state, result.changes)
    if (result.kind === 'deferred') {
      const stopped = await overtake(stepContext, state, i, result.deferred, handled)
      if (stopped) result = stopped
      else {
        state.remaining = left(state, i, handled)
        log(`${n} 차례로 돌아와 체크를 기다린다`)
        result = await attempt(stepContext, state, item, 'normal')
        Object.assign(state, result.changes)
      }
    }
    if (result.kind === 'config') return { ...result, changes: queueChanges(state) }
    if (result.kind !== 'held') continue
    hold(state, n, result.reason)
    if (result.retryable) state.retryItems.add(item)
    if (state.conflicted.includes(n)) {
      log(`${n} 충돌. 큐에서 빼고 다음 PR 로 간다`)
      continue
    }
    if (!o.continueOnHold) {
      return { kind: 'held', changes: queueChanges(state) }
    }
    log(`${n} 보류. 다음 PR 로 간다`)
  }
  // 다른 PR 을 처리하는 동안 worker 가 고친 보류만 정리 전에 한 번 다시 판정한다.
  state.rechecking = true
  for (const item of state.retryItems) {
    const n = item.split(':')[0]
    state.recheckWaited = 0
    state.remaining = [...state.retryItems].map((entry) => Number(entry.split(':')[0]))
    turn(state, TURN_PHASES.start, Number(n))
    log(`${n} 보류 사유를 다시 판정한다(CI 대기 최대 ${Math.min(5, Number(o.checkTimeout))}분)`)
    const result = await attempt(stepContext, state, item, 'normal')
    Object.assign(state, result.changes)
    if (result.kind === 'config') return { ...result, changes: queueChanges(state) }
    if (result.kind === 'merged') {
      state.held = state.held.filter((held) => held !== n)
      state.heldReasons = state.heldReasons.filter((held) => held.pr !== Number(n))
    } else if (result.kind === 'held') {
      state.heldReasons = state.heldReasons.map((held) => held.pr === Number(n) ? { pr: held.pr, reason: result.reason } : held)
    }
    state.retryItems.delete(item)
  }
  state.rechecking = false
  state.remaining = []
  return { kind: 'done', changes: queueChanges(state) }
}

function queueChanges(state: StepState): Partial<StepState> {
  const { merged, held, conflicted, sweepBase, afterFailed, notifyFailed, heldReasons, retryItems } = state
  return { merged, held, conflicted, sweepBase, afterFailed, notifyFailed, heldReasons, retryItems }
}
