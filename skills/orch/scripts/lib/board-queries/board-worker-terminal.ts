import { ACTIVE_STATE, LIVE_STATES, lookupWorkerTerminals } from '../worker-terminal.ts'

// 보드의 빠른 터미널 조회. 해제된 터미널까지 보는 첫 조회는 승인 모듈이 맡는다.
export async function isLiveWorkerTerminal(handle: string): Promise<boolean | null> {
  const result = await lookupWorkerTerminals([handle], { states: [ACTIVE_STATE, ...LIVE_STATES] })
  return result.ok ? result.found.has(handle) : null
}
