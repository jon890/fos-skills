
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
