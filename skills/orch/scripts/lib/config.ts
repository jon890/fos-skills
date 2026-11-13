// <orch 루트>/config.json 읽기의 한 벌이다.
//
// 최상위는 절(Section)마다 객체 하나다. 지금 절(finish, cleanup, queue)의 키는 skills/orch/references/overlay.md 의
// 「마무리 설정 파일」 표가, 더하는 절(hooks, pipeline, heavy, migrations, adr, contracts, board, review)의 키는 docs/data-schema.md 의 「config.json 에 더하는 절」 이 정한다.
// 키 이름은 그 절을 읽는 명령의 옵션 이름에서 하이픈을 밑줄로 바꾼 것이다.
// docker 절의 키와 값은 skills/orch/references/overlay.md 「마무리 설정 파일」 표가 정하고 lib/docker.ts 의 dockerRules 가 읽는다.
//
// 판정:
//   - 파일이 없으면 빈 객체다
//   - JSON 이 깨졌거나, 최상위가 객체가 아니거나, 모르는 최상위 절이 있거나, 절이 객체가 아니면 ConfigError 다
//     모르는 최상위 절도 막는 것은 절 이름의 오타(queu)가 조용히 무시되지 않게 하려는 것이다
//   - section 은 known 에 없는 키가 있으면 ConfigError 다. known 은 그 절을 읽는 명령이 넘긴다.
//     hooks 절은 HOOKS_KEYS, pipeline 절은 PIPELINE_KEYS, heavy 절은 HEAVY_KEYS, migrations 절은 MIGRATIONS_KEYS, queue 절은 QUEUE_KEYS,
//     adr 절은 ADR_KEYS, contracts 절은 CONTRACTS_KEYS, board 절은 BOARD_KEYS, review 절은 REVIEW_KEYS 를 쓴다. 여러 명령이 같은 절의 다른 키를 읽으므로
//     자기가 읽는 키만 넘기면 다른 명령의 키(pipeline.enabled 같은 것)를 둔 저장소에서 사용법 오류로 멈춘다
// 명령은 ConfigError 를 사용법 오류(종료 코드 2)로 바꾼다.
// readConfigFile 은 검사 없이 읽는다(파일 없음, 깨진 JSON 과 값을 구분해 돌려준다). orch doctor 가 쓴다.
//
// REMOVED_CONFIG_KEYS 는 orch 5.2.0 에서 지운 키다. 실행 전에 거부하고 핸들러로 옮기는 명령을 알린다.

import { isObject } from '../core/json.ts'
import { SECTIONS } from '../core/config.ts'
import { ConfigError, RemovedConfigError, REMOVED_CONFIG_KEYS, section } from '../core/config.ts'
import type { Config } from '../core/config.ts'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { orchWord } from './commands.ts'
import { isFile } from './fs.ts'
import { ensure, pathOf } from './paths.ts'
import { shQuote } from './py.ts'
import { withFileLock, type LockOptions } from '../../../../extensions/work-board/bin/file-lock.ts'

// opts.file 이 없으면 <orch 루트>/config.json 이다. 상대경로 file 은 작업 디렉터리 기준이다.

export function loadConfig(repo: string, opts: { file?: string } = {}): Config {
  const file = opts.file ? resolve(opts.file) : pathOf('config', repo)
  if (!isFile(file)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new ConfigError(`설정 파일을 읽지 못했다: ${file}: ${(e as Error).message}`)
  }
  if (!isObject(parsed)) throw new ConfigError(`${file} 의 최상위는 객체여야 한다`)
  const unknown = Object.keys(parsed)
    .filter((key) => !(SECTIONS as readonly string[]).includes(key))
    .sort()
  if (unknown.length > 0) throw new ConfigError(`${file} 에 모르는 절이 있다: ${unknown.join(', ')}. ${SECTIONS.join(', ')} 중 하나다`)
  for (const [name, value] of Object.entries(parsed)) {
    if (!isObject(value)) throw new ConfigError(`${file} 의 "${name}" 절은 객체여야 한다`)
  }
  const removed = REMOVED_CONFIG_KEYS.filter(({ section, key }) => Object.hasOwn((parsed[section] ?? {}) as object, key))
  if (removed.length > 0) {
    const names = removed.map(({ section, key }) => `${section}.${key}`).join(', ')
    throw new RemovedConfigError(`orch 5.2.0 에서 삭제한 설정: ${names}. ${orchWord()} doctor migrate-hooks --repo ${shQuote(repo)} --apply 로 핸들러에 옮긴다`)
  }
  return parsed as Config
}

// 검사 없이 읽는다. 파일이 없으면 exists false, JSON 이 깨졌거나 읽지 못했으면 error 에 이유, 아니면 value 다.
// loadConfig 는 검사하며 읽어 던지지만, 설정 문제를 모두 알리는 곳(orch doctor)은 검사표(core/config-schema.ts)로 따로 본다.
export function readConfigFile(repo: string): { file: string; exists: boolean; value?: unknown; error?: string } {
  const file = pathOf('config', repo)
  if (!isFile(file)) return { file, exists: false }
  try {
    return { file, exists: true, value: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (e) {
    return { file, exists: true, error: (e as Error).message }
  }
}

// change 는 잠금 안에서 다시 읽은 값만 받는다. undefined 반환은 쓰지 않는다는 뜻이다.
// 검사표를 import 하지 않아 기존 설정 읽기는 npm 의존 없이 계속 돈다.
export function updateConfig(repo: string, change: (value: unknown, exists: boolean) => unknown, opts: LockOptions = {}): void {
  const file = pathOf('config', repo)
  withFileLock(file, lock => {
    const read = readConfigFile(repo)
    if (read.error) throw new ConfigError(`설정 파일을 읽지 못했다: ${file}: ${read.error}`)
    const next = change(read.exists ? read.value : {}, read.exists)
    if (next === undefined) return
    ensure('config', repo)
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    if (!lock.held()) throw new ConfigError(`설정 파일 잠금을 잃었다: ${file}. 다시 실행한다`)
    renameSync(temp, file)
  }, opts)
}

export { ConfigError, RemovedConfigError, CLEANUP_KEYS, DOCKER_KEYS, HOOK_EVENT_NAMES, HOOKS_KEYS, QUEUE_LOOP_KEYS, QUEUE_KEYS, PIPELINE_KEYS, HEAVY_KEYS, MIGRATIONS_KEYS, ADR_KEYS, CONTRACTS_KEYS, BOARD_KEYS, REVIEW_KEYS, ROUTING_KEYS, INBOX_KEYS, LEGACY_INBOX_FILTER, REMOVED_CONFIG_KEYS, section } from '../core/config.ts'
export type { Section, Config } from '../core/config.ts'
