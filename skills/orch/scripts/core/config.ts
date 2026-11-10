import { isObject } from './json.ts'
export type Section = 'finish' | 'cleanup' | 'queue' | 'hooks' | 'pipeline' | 'heavy' | 'migrations' | 'adr' | 'board' | 'review' | 'docker' | 'routing' | 'inbox'

export type Config = Partial<Record<Section, Record<string, unknown>>>

export const SECTIONS: readonly Section[] = ['finish', 'cleanup', 'queue', 'hooks', 'pipeline', 'heavy', 'migrations', 'adr', 'board', 'review', 'docker', 'routing', 'inbox']

export class ConfigError extends Error {}

export class RemovedConfigError extends ConfigError {}

// hooks 절의 아는 키. timeouts 는 이벤트 이름에서 초로 가는 객체이고 이벤트 실행기가 읽는다.
export const HOOKS_KEYS: readonly string[] = ['timeouts']

// queue 절에서 상주 루프만 읽는 키. 자동 머지(lib/auto-merge.ts)가 읽고, merge-with-finish 의 옵션 표(lib/queue-options.ts)에는 없다
export const QUEUE_LOOP_KEYS: readonly string[] = ['auto_merge', 'auto_review']

// queue 절의 아는 키 전부. skills/orch/references/overlay.md 「마무리 설정 파일」 표의 queue 행이다.
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
  'poll_min_sec',
  'poll_max_sec',
  'ci_expected_sec',
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
  'idle_min',
  'idle_exited',
  'refresh_slots',
  'refresh_worker_paths',
]

// heavy 절의 아는 키. docs/data-schema.md 「config.json 에 더하는 절」 표의 heavy 행이다. 값은 정규식 문자열 목록이고 heavy-slot.ts 가 읽는다.
export const HEAVY_KEYS: readonly string[] = ['exclusive', 'normal', 'light', 'wait_idle']

// migrations 절의 아는 키. docs/data-schema.md 「config.json 에 더하는 절」 표의 migrations 행이다. 상주 루프의 자동 머지(lib/auto-merge.ts)가 읽는다.
export const MIGRATIONS_KEYS: readonly string[] = ['dirs', 'watch', 'before', 'blocked_after_sec']

// adr 절의 아는 키. docs/data-schema.md 「config.json 에 더하는 절」 표의 adr 행이다. reserve-migration.ts --kind adr 와 spec-lint 가 읽고, 자동 머지는 읽지 않는다.
export const ADR_KEYS: readonly string[] = ['dirs']

// board 절의 아는 키. docs/data-schema.md 「config.json 에 더하는 절」 표의 board 행이다. 값의 판정은 lib/milestones.ts 의 boardSettings 가 소유한다.
export const BOARD_KEYS: readonly string[] = ['steps', 'done_after', 'task_line']

// review 절의 아는 키. docs/data-schema.md 「config.json 에 더하는 절」 표의 review 행이다. launch-worker 가 리뷰 worker 를 띄울 때 읽는다.
export const REVIEW_KEYS: readonly string[] = ['prepare']

// PR 종료 관측값의 저장소별 읽기 규칙.
export const ROUTING_KEYS: readonly string[] = ['review_author', 'review_pattern', 'size_pattern']

// inbox 절의 아는 키. 알림 필터이고 inbox 스킬(skills/inbox/scripts/inbox.ts)이 읽는다. docs/data-schema.md 「config.json 에 더하는 절」 표의 inbox 행이다.
// enabled 는 false 로 그 저장소의 알림을 끄고, 나머지는 adapter 이름이다. adapter 를 더하면 이 목록에도 더한다
export const INBOX_KEYS: readonly string[] = ['enabled', 'dooray', 'slack']

// 옛 알림 필터 파일(<orch 루트>/config/notification.json)의 orch 루트 기준 상대 경로. 한 major 동안 inbox 가 함께 읽고 다음 major 에 지운다
export const LEGACY_INBOX_FILTER = 'config/notification.json'

// event 는 그 키가 하던 일을 옮겨 받을 핸들러의 이벤트 이름이다(<orch 루트>/hooks/<event>.ts).
export const REMOVED_CONFIG_KEYS: ReadonlyArray<{ section: Section; key: string; event: string }> = [
  { section: 'queue', key: 'before', event: 'before-merge' },
  { section: 'queue', key: 'verify_merged', event: 'verify-merged' },
  { section: 'queue', key: 'after_merged', event: 'after-queue' },
  { section: 'finish', key: 'complete_cmd', event: 'after-deploy' },
]

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
