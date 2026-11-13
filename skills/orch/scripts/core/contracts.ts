// contracts 절(config.json)의 값 판정. 머지 합치기 쪽(lib/contract-merge.ts)과 설정 검사표(config-schema.ts)가 함께 쓴다.

import { CONTRACTS_KEYS, ConfigError, section } from './config.ts'
import type { Config } from './config.ts'
import { joined } from './refresh.ts'
import { pyRegExp } from './regexp.ts'

export type ContractSettings = { command: string; paths: RegExp }

export function contractSettings(config: Config): ContractSettings | null {
  const body = section<Record<string, unknown>>(config, 'contracts', CONTRACTS_KEYS)
  if (body.merge_command === undefined && body.paths === undefined) return null
  const command = body.merge_command
  if (typeof command !== 'string' || !command.trim()) throw new ConfigError('설정 파일의 contracts.merge_command 는 비지 않은 문자열이어야 한다')
  const source = joined(body.paths, 'contracts.paths', '|')
  if (!source) throw new ConfigError('설정 파일의 contracts.paths 가 없다. merge_command 와 함께 준다')
  try {
    return { command, paths: pyRegExp(source) }
  } catch (e) {
    throw new ConfigError(`설정 파일의 contracts.paths 를 정규식으로 읽지 못했다: ${(e as Error).message}`)
  }
}
