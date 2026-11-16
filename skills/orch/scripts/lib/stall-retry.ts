// 멈춘 worker 다시 진행시키기: 저장소에 worker-stalled 핸들러가 없을 때 상주 루프가 쓰는 코어 기본 동작이다(loop/steps/stalls.ts 의 notifyStall).
// state=error 로 멈춘 worker 에게 멈춤(since)마다 limit 번까지 「계속 진행해」 를 `orch worker send` 로 보낸다.
// limit 은 pipeline.stall_error_retries 다(기본 3, 0 이면 끈다). 상한에 닿았거나 error 가 아닌 멈춤이면 보내지 않고 false 를 돌려, 부른 쪽이 코디네이터에게 알린다.
// 횟수는 <orch 루트>/state/stall-retries.json 의 { <dispatch>: { since, tries } } 에 둔다. since 가 같으면 같은 멈춤이라 이어 세고, 바뀌면 처음부터 센다.
// 쓰는 도중에 끝나도 앞 내용이 남게 임시 파일에 쓰고 이름을 바꾼다.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isObject } from '../core/json.ts'
import { NAMES, orchDir } from './paths.ts'

export const DEFAULT_STALL_ERROR_RETRIES = 3
export const RETRY_BODY = '계속 진행해'

type Tries = Record<string, { since: string; tries: number }>

function readTries(file: string): Tries {
  if (!existsSync(file)) return {}
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isObject(data) ? (data as Tries) : {}
  } catch {
    // 깨진 기록은 처음부터 센다
    return {}
  }
}

// 보낼 차례면 횟수를 올려 쓰고 true 다. send 가 던지면 올린 횟수는 그대로 둔다(같은 멈춤을 무한히 다시 시도하지 않는다)
export function retryStalled(
  repo: string,
  stall: { dispatch: string; state: string; since: string },
  limit: number,
  send: (dispatch: string, body: string) => void,
): boolean {
  if (stall.state !== 'error' || limit <= 0) return false
  const dir = join(orchDir(repo), NAMES.state)
  const file = join(dir, 'stall-retries.json')
  const all = readTries(file)
  const before = all[stall.dispatch]
  const tries = before?.since === stall.since && Number.isInteger(before.tries) ? before.tries : 0
  if (tries >= limit) return false
  all[stall.dispatch] = { since: stall.since, tries: tries + 1 }
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(all))
  renameSync(`${file}.tmp`, file)
  send(stall.dispatch, RETRY_BODY)
  return true
}
