// 사건 대기(docs/features/board-feature-items/design.md 「사건 대기」)의 설정 판정과 결과 판정. 입출력은 lib/wait-events.ts 가 맡는다.
//
// 설정: board.wait_events 는 사건 이름에서 { command, timeout_sec } 로 가는 객체다.
//   이름은 core/step-ready.ts 의 WAIT_EVENT_NAME, command 는 비지 않은 문자열, timeout_sec 은 1 이상 600 이하의 정수(기본 60)다.
//   이름 규칙이 틀리거나 다른 키가 있으면 설정 오류다.
// 결과: 셸이 스스로 끝난 0 은 끝남, 1 은 아직, 나머지는 실패다(설계 DECISION7).
import { BOARD_KEYS, ConfigError, section } from './config.ts'
import type { Config } from './config.ts'
import { isObject } from './json.ts'
import { WAIT_EVENT_NAME } from './step-ready.ts'

export type WaitEvent = { command: string; timeoutSec: number }
export const DEFAULT_WAIT_EVENT_TIMEOUT_SEC = 60
export const MAX_WAIT_EVENT_TIMEOUT_SEC = 600

export function waitEventsOf(config: Config): Record<string, WaitEvent> {
  const value = section<Record<string, unknown>>(config, 'board', BOARD_KEYS).wait_events
  if (value === undefined) return {}
  const where = '설정 파일의 board.wait_events'
  if (!isObject(value)) throw new ConfigError(`${where} 는 사건 이름에서 { command, timeout_sec } 로 가는 객체다`)
  const events: Record<string, WaitEvent> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (!WAIT_EVENT_NAME.test(name)) throw new ConfigError(`${where} 의 이름 ${JSON.stringify(name)} 은 영문 소문자나 숫자로 시작하고 영문 소문자, 숫자, 하이픈만 쓰는 32자 이하여야 한다`)
    if (!isObject(entry)) throw new ConfigError(`${where}.${name} 는 객체여야 한다`)
    const unknown = Object.keys(entry).filter((key) => key !== 'command' && key !== 'timeout_sec').sort()
    if (unknown.length) throw new ConfigError(`${where}.${name} 에 모르는 키가 있다: ${unknown.join(', ')}`)
    if (typeof entry.command !== 'string' || !entry.command.trim()) throw new ConfigError(`${where}.${name}.command 는 비지 않은 문자열이어야 한다`)
    const timeout = entry.timeout_sec ?? DEFAULT_WAIT_EVENT_TIMEOUT_SEC
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_WAIT_EVENT_TIMEOUT_SEC) {
      throw new ConfigError(`${where}.${name}.timeout_sec 는 1 이상 ${MAX_WAIT_EVENT_TIMEOUT_SEC} 이하의 정수여야 한다`)
    }
    events[name] = { command: entry.command, timeoutSec: timeout }
  }
  return events
}

// 남은 시간(설계 「남은 시간」). 마감까지 RESERVE_MS 를 남기고, 그 뒤가 MIN_LEFT_MS 보다 적으면 이번 틱에는 돌리지 않는다(null)
export const WAIT_EVENT_RESERVE_MS = 30_000
export const WAIT_EVENT_MIN_LEFT_MS = 40_000
export function waitEventLimitMs(timeoutSec: number, deadline: number | null, now: number): number | null {
  const own = timeoutSec * 1000
  if (deadline === null) return own
  if (deadline - now < WAIT_EVENT_MIN_LEFT_MS) return null
  return Math.min(own, deadline - now - WAIT_EVENT_RESERVE_MS)
}

export type GroupOutcome =
  | { kind: 'exit'; code: number }
  | { kind: 'timeout' | 'overflow' | 'spawn' | 'orphan'; reason: string }

// 실패 이유의 종류. 한 번 알림 기록에 남겨 같은 줄의 같은 종류는 다시 알리지 않는다
export type WaitFailure = 'unknown-event' | 'no-owner' | 'exit' | 'timeout' | 'overflow' | 'spawn' | 'orphan'
export type WaitVerdict = { kind: 'done' } | { kind: 'pending' } | { kind: 'failed'; failure: WaitFailure; reason: string }

export function waitVerdict(outcome: GroupOutcome): WaitVerdict {
  if (outcome.kind === 'exit') {
    if (outcome.code === 0) return { kind: 'done' }
    if (outcome.code === 1) return { kind: 'pending' }
    return { kind: 'failed', failure: 'exit', reason: `종료 코드 ${outcome.code}` }
  }
  return { kind: 'failed', failure: outcome.kind, reason: outcome.reason }
}
