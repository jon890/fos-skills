// heavy 절(config.json)의 값 판정. heavy-slot.ts 와 설정 검사표(config-schema.ts)가 함께 쓴다.

import { ConfigError, HEAVY_KEYS } from './config.ts'

export type Heavy = Record<'exclusive' | 'normal' | 'light' | 'wait_idle', RegExp[]>

// heavy 절을 정규식으로 바꾼다. 값이 문자열 목록이 아니면 ConfigError 다. 정규식이 틀리면 badRegex 가 만든 오류를 던진다(기본은 ConfigError.
// heavy-slot.ts 는 종료 코드 2 로 가려 잡는 Usage 를 만들어 넘긴다).
export function compileHeavy(body: Record<string, unknown>, badRegex: (message: string) => Error = (message) => new ConfigError(message)): Heavy {
  const heavy: Heavy = { exclusive: [], normal: [], light: [], wait_idle: [] }
  for (const key of HEAVY_KEYS as readonly (keyof Heavy)[]) {
    const value = body[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw new ConfigError(`설정 파일의 heavy.${key} 는 정규식 문자열 목록이어야 한다`)
    }
    heavy[key] = value.map((source: string) => {
      try {
        return new RegExp(source)
      } catch (e) {
        throw badRegex(`heavy.${key} 의 정규식이 틀렸다: ${source}: ${(e as Error).message}`)
      }
    })
  }
  return heavy
}
