import { ConfigError } from './config.ts'
import { isObject } from './json.ts'

export const DEFAULT_TICK_SEC = 300
export const MIN_DEAD_SEC = 120

export type LoopState = {
  pid: number
  run: string | null
  runs?: string[]
  repo: string
  tick_sec: number
  started_at: string
  alive_at: string
  last_tick: string | null
  ticks: number
  errors: Record<string, string | null>
  [key: string]: unknown
}

export type LoopStatus = { alive: true; state: LoopState } | { alive: false; reason: string; recheck?: true }

export type RunEntry = { run: string; specs_dir: string | null; registered_at: string; coordinator_terminal: string | null }

// 파일 이름에 쓸 Run. 머리 주석의 「<Run>」
export function runKey(run: string): string {
  return run.replace(/[^A-Za-z0-9_.-]/g, '_')
}

export function judgeLoop(state: LoopState | null, now: number, pidAlive: boolean, loopProcess: boolean | null = null): LoopStatus {
  if (!state) return { alive: false, reason: '없음' }
  const pid = Number(state.pid)
  if (!pidAlive) return { alive: false, reason: `pid ${String(state.pid)} 종료` }
  const tick = typeof state.tick_sec === 'number' && Number.isFinite(state.tick_sec) && state.tick_sec > 0 ? state.tick_sec : DEFAULT_TICK_SEC
  const at = typeof state.alive_at === 'string' ? Date.parse(state.alive_at) : Number.NaN
  if (!Number.isFinite(at) || now - at > Math.max(3 * tick, MIN_DEAD_SEC) * 1000) {
    const reason = `alive_at ${String(state.alive_at ?? '-')} 이후 응답 없음`
    return loopProcess !== false ? { alive: false, reason, recheck: true } : { alive: false, reason }
  }
  return { alive: true, state }
}

// pipeline.stall_ticks 의 키. loop/steps/shared.ts 의 StallState 와 같다(core 는 loop 를 import 하지 못한다)
export type StallTickState = 'error' | 'idle'

// pipeline.stall_ticks 의 기본값(stalls.ts 머리 주석의 「멈춤 확인」). idle 은 백그라운드 에이전트를 기다리는 정상 화면과 구분되지 않아 끈다
export const DEFAULT_STALL_TICKS: Readonly<Record<StallTickState, number>> = Object.freeze({ error: 2, idle: 0 })

export function stallTicks(value: unknown): Record<StallTickState, number> {
  if (value === undefined) return { ...DEFAULT_STALL_TICKS }
  const shape = '설정 파일의 pipeline.stall_ticks 는 {"error": 틱 수, "idle": 틱 수} 객체여야 한다'
  if (!isObject(value)) throw new ConfigError(shape)
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(DEFAULT_STALL_TICKS, key))
  if (unknown.length > 0) throw new ConfigError(`${shape}. 모르는 키: ${unknown.sort().join(', ')}`)
  const ticks = { ...DEFAULT_STALL_TICKS }
  for (const key of Object.keys(DEFAULT_STALL_TICKS) as StallTickState[]) {
    const n = value[key]
    if (n === undefined) continue
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new ConfigError(`설정 파일의 pipeline.stall_ticks.${key} 는 0 이상의 정수여야 한다: ${JSON.stringify(n)}`)
    ticks[key] = n
  }
  return ticks
}
