// 설정의 queue 절에서 명령줄에 없는 머지 큐 옵션을 만든다. 머지 큐 래퍼(merge-with-finish.ts)와 `orch queue gate` 가 함께 쓴다.
// 키와 옵션의 대응은 lib/queue-options.ts 가 소유하고, 여기는 값을 옵션 인자로 바꾸는 규칙만 갖는다.

import { ConfigError, QUEUE_KEYS, section } from './config.ts'
import type { Config } from './config.ts'
import { QUEUE_FLAGS, QUEUE_GROUPS, QUEUE_NUMBERS, QUEUE_REPEATED, QUEUE_VALUE_OPTIONS, QUEUE_VALUES } from './queue-options.ts'

// 문자열 목록도 받는 queue 키와 목록을 잇는 구분자. 키와 옵션의 대응은 lib/queue-options.ts 의 QUEUE_VALUES 들이다
const QUEUE_LISTS: Readonly<Record<string, string>> = { docs_glob: ',', shared_paths: '|' }

// 머지 큐 인자 가운데 명령줄에 준 옵션 이름. 값 자리는 세지 않는다
function givenOptions(queue: string[]): Set<string> {
  const given = new Set<string>()
  let skip = false
  for (const arg of queue) {
    if (skip) skip = false
    else if (arg.startsWith('-')) {
      given.add(arg)
      skip = QUEUE_VALUE_OPTIONS.includes(arg)
    }
  }
  return given
}

export function queueDefaults(path: string, queue: string[], config: Config): string[] {
  const body = section<Record<string, unknown>>(config, 'queue', QUEUE_KEYS)
  const given = givenOptions(queue)
  const extra: string[] = []
  for (const [key, option] of Object.entries(QUEUE_VALUES)) {
    if (!(key in body) || given.has(option)) continue
    let value = body[key]
    // 필수 체크 이름에는 쉼표가 들 수 있어 목록은 이름마다 --required-check 로 넘긴다
    if (key === 'required' && Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v)) {
      if (!given.has('--required-check')) for (const name of value as string[]) extra.push('--required-check', name)
      continue
    }
    if (Array.isArray(value) && key in QUEUE_LISTS && value.every((v) => typeof v === 'string')) value = value.join(QUEUE_LISTS[key])
    if (QUEUE_NUMBERS.includes(key)) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ConfigError(`${path} 의 queue.${key} 는 1 이상의 정수(초)여야 한다`)
      extra.push(option, String(value))
      continue
    }
    if (typeof value !== 'string' || !value) throw new ConfigError(`${path} 의 queue.${key} 는 비지 않은 문자열이어야 한다`)
    extra.push(option, value)
  }
  for (const [key, option] of Object.entries(QUEUE_FLAGS)) {
    if (!(key in body) || given.has(option)) continue
    if (typeof body[key] !== 'boolean') throw new ConfigError(`${path} 의 queue.${key} 는 true 나 false 여야 한다`)
    if (body[key]) extra.push(option)
  }
  for (const [key, option] of Object.entries(QUEUE_REPEATED)) {
    if (!(key in body)) continue
    const values = body[key]
    if (!Array.isArray(values) || !values.every((v) => typeof v === 'string' && v)) {
      throw new ConfigError(`${path} 의 queue.${key} 는 비지 않은 문자열 목록이어야 한다`)
    }
    if (!given.has(option)) for (const value of values as string[]) extra.push(option, value)
  }
  for (const [key, option] of Object.entries(QUEUE_GROUPS)) {
    if (!(key in body)) continue
    const groups = body[key]
    const ok =
      Array.isArray(groups) &&
      groups.length > 0 &&
      groups.every((g) => Array.isArray(g) && g.length >= 2 && g.every((m) => typeof m === 'string' && m && !m.includes(',')))
    if (!ok) throw new ConfigError(`${path} 의 queue.${key} 는 단위 이름이 둘 이상인 문자열 목록의 목록이어야 한다`)
    if (!given.has(option)) for (const members of groups as string[][]) extra.push(option, members.join(','))
  }
  return extra
}

