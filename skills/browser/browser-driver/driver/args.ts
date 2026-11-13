// 명령 인자 중 옵션을 떼어 내고 검증한다. 백엔드는 정규화된 위치 인자만 받는다.

import { UsageError } from './errors.ts'
import { isDigit, parsePyFloat, PyFloat } from './pylike.ts'

export const BUTTONS = ['left', 'middle', 'right']

function number(text: string, what: string): number {
  try {
    return parsePyFloat(text)
  } catch {
    throw new UsageError(`숫자여야 한다 (${what}): ${text}`)
  }
}

// `flag 값` 쌍을 args 에서 떼어 내고 [나머지, 값 또는 null] 을 낸다. 처음 나온 flag 만 본다
export function splitOption(args: string[], flag: string): [string[], string | null] {
  const rest = [...args]
  const i = rest.indexOf(flag)
  if (i < 0) return [rest, null]
  if (i + 1 >= rest.length) throw new UsageError(`${flag} 에 값이 없다`)
  const value = rest[i + 1]
  rest.splice(i, 2)
  return [rest, value]
}

// `js <handle> <expression> [--timeout <ms>]` → [handle, expression, timeout_ms 또는 null]
export function parseJsArgs(args: string[]): [string, string, bigint | null] {
  const [rest, raw] = splitOption(args, '--timeout')
  let timeout: bigint | null = null
  if (raw !== null) {
    // int(float(raw)): 0 쪽으로 자르고, inf 와 nan 은 Python 도 처리하지 못한 오류로 끝난다
    const value = number(raw, '--timeout')
    if (!Number.isFinite(value)) throw new Error(`cannot convert float ${value} to integer`)
    timeout = BigInt(Math.trunc(value))
    if (timeout <= 0n) throw new UsageError(`--timeout 은 1 이상의 밀리초여야 한다: ${raw}`)
  }
  if (rest.length !== 2) throw new UsageError('인자가 모자라거나 남는다. js <handle> <expression> [--timeout <ms>]')
  return [rest[0], rest[1], timeout]
}

// `shot <handle> [path] [--size WxH]` → [handle, path 또는 생략, [너비, 높이] 또는 생략]. 크기는 CSS 픽셀이다
export function parseShotArgs(args: string[]): any[] {
  const [rest, raw] = splitOption(args, '--size')
  if (raw === null) return rest
  if (rest.length < 1 || rest.length > 2) throw new UsageError('인자가 모자라거나 남는다. shot <handle> [path] [--size WxH]')
  const m = /^(\d+)x(\d+)$/i.exec(raw)
  const [w, h] = m ? [Number(m[1]), Number(m[2])] : [0, 0]
  if (w < 1 || h < 1 || w > 16384 || h > 16384) throw new UsageError(`--size 는 WxH 꼴의 1 이상 16384 이하 픽셀이어야 한다 (예: 1280x800): ${raw}`)
  return [rest[0], rest.length > 1 ? rest[1] : undefined, [w, h]]
}

// `<handle> <x> <y> ...` 를 [handle, 좌표..., button] 로 정규화한다. 좌표는 CSS 픽셀이다
export function parsePointerArgs(cmd: string, args: string[], points: number, allowButton: boolean): [string, ...unknown[]] {
  const [rest, button] = allowButton ? splitOption(args, '--button') : ([[...args], null] as [string[], null])
  const need = 1 + 2 * points
  if (rest.length !== need) throw new UsageError(`인자가 모자라거나 남는다. 핸들 뒤에 좌표 ${2 * points}개가 필요하다 (${cmd})`)
  const coords = rest.slice(1).map((v) => new PyFloat(number(v, '좌표')))
  const chosen = button ?? 'left'
  if (!BUTTONS.includes(chosen)) throw new UsageError(`--button 은 ${BUTTONS.join(', ')} 중 하나여야 한다: ${chosen}`)
  return [rest[0], ...coords, chosen]
}

// `reset [profile] [--space-id <id>]` → [profile 또는 "", space_id 또는 null]
//
// 공간 id 는 이름과 프로필을 거치지 않고 공간 하나를 고른다. 프로필과 함께 줄 수 없다.
export function parseResetArgs(args: string[]): [string, string | null] {
  const [rest, raw] = splitOption(args, '--space-id')
  if (rest.length > 1) throw new UsageError('인자가 남는다. reset [profile] [--space-id <id>]')
  let spaceId: string | null = null
  if (raw !== null) {
    if (!isDigit(raw)) throw new UsageError(`--space-id 는 spaces 가 낸 숫자 id 여야 한다: ${raw}`)
    if (rest.length > 0) throw new UsageError('--space-id 와 프로필은 함께 줄 수 없다. id 가 공간을 정한다')
    spaceId = raw
  }
  return [rest.length > 0 ? rest[0] : '', spaceId]
}
