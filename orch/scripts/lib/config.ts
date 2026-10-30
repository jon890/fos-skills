// <orch 루트>/config.json 읽기의 한 벌이다.
//
// 최상위는 절(Section)마다 객체 하나다. 지금 절(finish, cleanup, queue)의 키는 orch/references/overlay.md 의
// 「마무리 설정 파일」 표가, 더하는 절(hooks, pipeline, heavy, migrations, board)의 키는 docs/data-schema.md 의 「config.json 에 더하는 절」 이 정한다.
// 키 이름은 그 절을 읽는 명령의 옵션 이름에서 하이픈을 밑줄로 바꾼 것이다.
//
// 판정:
//   - 파일이 없으면 빈 객체다
//   - JSON 이 깨졌거나, 최상위가 객체가 아니거나, 모르는 최상위 절이 있거나, 절이 객체가 아니면 ConfigError 다
//     모르는 최상위 절도 막는 것은 절 이름의 오타(queu)가 조용히 무시되지 않게 하려는 것이다
//   - section 은 known 에 없는 키가 있으면 ConfigError 다. known 은 그 절을 읽는 명령이 넘긴다.
//     hooks 절은 HOOKS_KEYS, pipeline 절은 PIPELINE_KEYS, heavy 절은 HEAVY_KEYS, migrations 절은 MIGRATIONS_KEYS, queue 절은 QUEUE_KEYS,
//     board 절은 BOARD_KEYS 를 쓴다. 여러 명령이 같은 절의 다른 키를 읽으므로
//     자기가 읽는 키만 넘기면 다른 명령의 키(pipeline.enabled 같은 것)를 둔 저장소에서 사용법 오류로 멈춘다
// 명령은 ConfigError 를 사용법 오류(종료 코드 2)로 바꾼다.
//
// REMOVED_CONFIG_KEYS 는 orch 5.2.0 에서 지운 키다. 실행 전에 거부하고 핸들러로 옮기는 명령을 알린다.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isFile } from './fs.ts'
import { pathOf } from './paths.ts'

export type Section = 'finish' | 'cleanup' | 'queue' | 'hooks' | 'pipeline' | 'heavy' | 'migrations' | 'board'
export type Config = Partial<Record<Section, Record<string, unknown>>>

const SECTIONS: readonly Section[] = ['finish', 'cleanup', 'queue', 'hooks', 'pipeline', 'heavy', 'migrations', 'board']

export class ConfigError extends Error {}

export class RemovedConfigError extends ConfigError {}

// hooks 절의 아는 키. timeouts 는 이벤트 이름에서 초로 가는 객체이고 이벤트 실행기가 읽는다.
export const HOOKS_KEYS: readonly string[] = ['timeouts']

// queue 절에서 상주 루프만 읽는 키. 자동 머지(lib/auto-merge.ts)가 읽고, merge-with-finish 의 옵션 표(lib/queue-options.ts)에는 없다
export const QUEUE_LOOP_KEYS: readonly string[] = ['auto_merge', 'auto_review']

// queue 절의 아는 키 전부. orch/references/overlay.md 「마무리 설정 파일」 표의 queue 행이다.
// merge-with-finish 가 머지 큐 옵션으로 바꾸고, orch-loop 가 필수 체크 판정에 required 와 skipped_is_missing 을, 자동 머지에 QUEUE_LOOP_KEYS 를 읽는다
export const QUEUE_KEYS: readonly string[] = [
  'required',
  'verify_merged_when',
  'docs_glob',
  'method',
  'up_to_date_when',
  'shared_paths',
  'unit_prefix',
  'skipped_is_missing',
  'update_docs_on_overlap',
  'require_up_to_date',
  'sweep_args',
  'unit_groups',
  ...QUEUE_LOOP_KEYS,
]

// pipeline 절의 아는 키 전부. docs/data-schema.md 「config.json 에 더하는 절」 표의 pipeline 행이다.
export const PIPELINE_KEYS: readonly string[] = [
  'enabled',
  'tick_sec',
  'ready_slots',
  'docs_merge',
  'after_queue_interval_sec',
  'ci_missing_after_sec',
  'update_behind_drafts',
  'authors',
  'stall_ticks',
]

// heavy 절의 아는 키. docs/data-schema.md 「config.json 에 더하는 절」 표의 heavy 행이다. 값은 정규식 문자열 목록이고 heavy-slot.ts 가 읽는다.
export const HEAVY_KEYS: readonly string[] = ['exclusive', 'normal', 'light', 'wait_idle']

// migrations 절의 아는 키. docs/data-schema.md 「config.json 에 더하는 절」 표의 migrations 행이다. 상주 루프의 자동 머지(lib/auto-merge.ts)가 읽는다.
export const MIGRATIONS_KEYS: readonly string[] = ['dirs', 'before', 'blocked_after_sec']

// board 절의 아는 키. docs/data-schema.md 「config.json 에 더하는 절」 표의 board 행이다. 값의 판정은 lib/milestones.ts 의 boardSettings 가 소유한다.
export const BOARD_KEYS: readonly string[] = ['steps', 'done_after', 'task_line']

// event 는 그 키가 하던 일을 옮겨 받을 핸들러의 이벤트 이름이다(<orch 루트>/hooks/<event>.ts).
export const REMOVED_CONFIG_KEYS: ReadonlyArray<{ section: Section; key: string; event: string }> = [
  { section: 'queue', key: 'before', event: 'before-merge' },
  { section: 'queue', key: 'verify_merged', event: 'verify-merged' },
  { section: 'queue', key: 'after_merged', event: 'after-queue' },
  { section: 'finish', key: 'complete_cmd', event: 'after-deploy' },
]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
    throw new RemovedConfigError(`orch 5.2.0 에서 삭제한 설정: ${names}. bin/orch.ts migrate-orch-dir --repo ${repo} --hooks --apply 로 핸들러에 옮긴다`)
  }
  return parsed as Config
}

// 절 하나를 꺼낸다. 절이 없으면 빈 객체다. 값의 타입은 부르는 쪽이 검사한다.
export function section<T>(config: Config, name: Section, known: readonly string[]): T {
  const body = config[name] ?? {}
  if (!isObject(body)) throw new ConfigError(`설정 파일의 "${name}" 절은 객체여야 한다`)
  const unknown = Object.keys(body)
    .filter((key) => !known.includes(key))
    .sort()
  if (unknown.length > 0) throw new ConfigError(`설정 파일의 ${name} 절에 모르는 키가 있다: ${unknown.join(', ')}`)
  return body as T
}
