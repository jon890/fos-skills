import { ADR_KEYS, ConfigError, section } from './config.ts'
import type { Config } from './config.ts'
import { isObject } from './json.ts'

// orch 설정의 adr.dirs. 모듈 이름에서 저장소 루트 기준 폴더로 간다. 값이 틀리면 ConfigError 다
export function adrDirs(config: Config): Record<string, string> {
  const adr = section<Record<string, unknown>>(config, 'adr', ADR_KEYS)
  if (adr.dirs === undefined) return {}
  if (!isObject(adr.dirs)) throw new ConfigError('설정 파일의 adr.dirs 는 객체여야 한다')
  const dirs: Record<string, string> = {}
  for (const [module, value] of Object.entries(adr.dirs)) {
    const dir = typeof value === 'string' ? value.replace(/\/+$/, '') : ''
    if (!dir) throw new ConfigError(`설정 파일의 adr.dirs.${module} 는 저장소 루트 기준 폴더여야 한다: ${JSON.stringify(value)}`)
    dirs[module] = dir
  }
  return dirs
}
