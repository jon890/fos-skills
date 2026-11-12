// 설정 파일(<orch 루트>/config.json)의 키 검사표. 아는 키마다 값 검사를 두고, 파일 전체의 문제를 모은다.
//
// 부르는 곳은 둘이다. orch doctor 의 설정 검사(doctor/orch-doctor.ts)와 `orch config`(config/orch-config.ts, 다음 PR)다.
// zod 는 이 파일만 import 한다(docs/features/orch-config-cli/design.md 「zod 와 의존 설치」). 그래서 의존 설치가 실패한 머신에서도
// 다른 명령은 돈다. 이 파일은 파일을 읽지 않고 오류를 던지지 않는다. 틀린 곳은 모두 Problem 으로 돌려준다.
//
// 기준: 「그 키를 읽는 모든 곳이 오류 없이 뜻대로 쓰는 값」. 키별 기준과 근거는 design.md 「키별 검사 기준」 이 소유한다.
//   읽는 쪽이 조용히 무시하거나 뜻과 다르게 도는 값(0 이하의 대기 시간, Node 타이머 상한 초과)도 받지 않는다.
//   읽는 쪽과 어긋나지 않는지는 skills/orch/tests/config-schema-readers.spec.ts 가 본다.
//
// 내보내는 것
//   Problem          { path, reason, kind }. kind 는 structure(최상위·절의 꼴), unknown(모르는 절·키·이름), removed(옛 설정 칸),
//                    value(키별 검사), pair(짝 규칙)다
//   KEYS             절에서 키에서 검사로. 검사는 zod 스키마이거나 기존 core 판정이다
//   PAIRS            절마다 짝 규칙. 키 하나라도 자기 검사에서 틀렸으면 그 규칙은 건너뛴다
//   problems(raw)    파일 전체의 문제. 차례는 최상위, 절 이름, 절의 꼴, 옛 칸, 모르는 키, 키별 검사, 짝 규칙이다.
//                    키와 규칙은 서로 독립으로 돈다(한 키가 틀려도 다른 키와 규칙은 돈다)
//   knownPath(names) 경로가 아는 이름인지. known, unknown, removed
//   RESTART_KEYS     바꾸면 상주 루프를 다시 띄워야 반영되는 키
//
// 거절 이유는 zod 의 한국어 로케일(z.locales.ko())을 파싱마다 넘겨 만든다. 전역 z.config 는 부르지 않는다.
//
// core 경계: core 안의 상대 모듈, node:path, node:crypto 와 이 파일의 zod 만 import 한다(skills/orch/tests/core-boundary.spec.ts).

import * as z from 'zod'
import { autoMergeConfig, REVIEW_CONFIG_KEYS, unknownConditionsText } from './auto-merge.ts'
import { autoAdvanceOf } from './auto-advance.ts'
import {
  DOCKER_KEYS,
  HEAVY_KEYS,
  HOOK_EVENT_NAMES,
  MIGRATIONS_KEYS,
  REMOVED_CONFIG_KEYS,
  SECTIONS,
} from './config.ts'
import type { Config, Section } from './config.ts'
import { contractSettings } from './contracts.ts'
import { dockerRules } from './docker.ts'
import { compileHeavy } from './heavy.ts'
import { isObject } from './json.ts'
import { stallTicks } from './loop.ts'
import { boardSettingsFromConfig } from './milestones.ts'
import { groupMap } from './overlap.ts'
import { joined } from './refresh.ts'
import { pyRegExp } from './regexp.ts'
import { adrDirs } from './reservations.ts'

export type ProblemKind = 'structure' | 'unknown' | 'removed' | 'value' | 'pair'
export type Problem = { path: string; reason: string; kind: ProblemKind }

export type Check =
  | { kind: 'zod'; schema: z.ZodType }
  | { kind: 'core'; check: (value: unknown) => Problem[]; names?: readonly string[] | 'free' }

export type Pair = { keys: readonly string[]; check: (body: Record<string, unknown>) => string | null }

// Node 타이머의 최대 지연(초). 넘으면 1ms 로 바뀐다
export const TIMER_MAX_SEC = 2147483

// 바꾸면 상주 루프를 다시 띄워야 반영되는 키
export const RESTART_KEYS: readonly string[] = ['pipeline.tick_sec', 'finish.run', 'finish.specs_dir']

const KO = { error: z.locales.ko().localeError }

// ---- 값 조각 ---------------------------------------------------------------------------------------------

const isString = (value: unknown): value is string => typeof value === 'string'
const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== ''
const isNonEmptyList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(isNonEmpty)

// 읽는 쪽이 받는 꼴을 직접 적는 검사. zod 의 이유 문구로는 뜻이 안 닿는 꼴(문자열이나 목록, 정규식)에 쓴다
function leaf(accept: (value: unknown) => boolean, message: string): z.ZodType {
  return z.unknown().refine(accept, { error: message })
}

function validRegExp(source: string): string | null {
  try {
    pyRegExp(source)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

function groupCountOf(source: RegExp): number {
  return (new RegExp(`(?:${source.source})|`).exec('') as RegExpExecArray).length - 1
}

// 비지 않은 문자열이나 비지 않은 문자열만 든 비지 않은 목록. 목록은 glue 로 이어 정규식으로 읽는 키가 있다
const stringOrList = (name: string) => leaf((value) => isNonEmpty(value) || isNonEmptyList(value), `${name} 는 비지 않은 문자열이나 그 목록이어야 한다`)

// 문자열이나 목록을 glue 로 이어 파이썬 정규식으로 읽을 수 있는 값
function regexpSource(name: string, glue: string) {
  return leaf((value) => {
    if (!(isNonEmpty(value) || isNonEmptyList(value))) return false
    return validRegExp(joined(value, name, glue)) === null
  }, `${name} 는 비지 않은 문자열이나 그 목록이고 정규식으로 읽혀야 한다`)
}

const timer = z.number().positive().max(TIMER_MAX_SEC)
const wholeSec = z.number().int().min(1).max(TIMER_MAX_SEC)
const bool = z.boolean()
const text = z.string()
const textOrNull = z.string().nullable()
const nonEmptyText = z.string().min(1)
const stringList = z.array(nonEmptyText)

// 수나 Number() 가 읽는 문자열. null 은 「없음」 이다
function numberLike(name: string, min: 'positive' | 'nonnegative', max?: number): z.ZodType {
  const ok = (n: number) => Number.isFinite(n) && (min === 'positive' ? n > 0 : n >= 0) && (max === undefined || n <= max)
  const word = min === 'positive' ? '양수' : '0 이상의 수'
  return leaf((value) => {
    if (value === null) return true
    if (typeof value === 'number') return ok(value)
    return typeof value === 'string' && value.trim() !== '' && ok(Number(value))
  }, `${name} 는 null 이거나 ${word}(수 그대로나 그렇게 읽히는 문자열)여야 한다${max === undefined ? '' : `. ${max} 이하`}`)
}

// 캡처 묶음이 minGroups 개 이상인 정규식. finish 의 업무 번호 정규식은 파이썬 꼴(pyRegExp)이고 null 과 빈 문자열이 「없음」 이다.
// routing 의 정규식은 JS 정규식(m 플래그)이다
function capturePattern(name: string, minGroups: number, mode: 'py-or-none' | 'js'): z.ZodType {
  return leaf((value) => {
    if (mode === 'py-or-none' && (value === null || value === '')) return true
    if (typeof value !== 'string' || value === '') return false
    try {
      return groupCountOf(mode === 'js' ? new RegExp(value, 'm') : pyRegExp(value)) >= minGroups
    } catch {
      return false
    }
  }, `${name} 는 정규식이어야 하고 캡처 묶음이 ${minGroups}개 이상이어야 한다${mode === 'py-or-none' ? '(null 이나 빈 문자열은 쓰지 않는다는 뜻이다)' : ''}`)
}

// ---- 기존 core 판정을 키 하나에 거는 꼴 -----------------------------------------------------------------------

function asProblem(path: string, e: unknown): Problem[] {
  return [{ path, reason: e instanceof Error ? e.message : String(e), kind: 'value' }]
}

// config 를 받는 core 판정을 그 키 하나만 담은 설정으로 부른다. 판정이 절의 모르는 키를 먼저 막거나 첫 오류만 던져도 다른 키에 가리지 않는다
function viaConfig(name: Section, key: string, judge: (config: Config) => unknown, names?: readonly string[] | 'free', fill: Record<string, unknown> = {}): Check {
  const path = `${name}.${key}`
  return {
    kind: 'core',
    names,
    check: (value) => {
      try {
        judge({ [name]: { ...fill, [key]: value } } as Config)
        return []
      } catch (e) {
        return asProblem(path, e)
      }
    },
  }
}

const REVIEW_ENTRY: Check = {
  kind: 'core',
  names: REVIEW_CONFIG_KEYS,
  check: (value) => {
    try {
      const unknown = autoMergeConfig({ queue: { auto_review: value } }).review?.unknown ?? []
      if (unknown.length === 0) return []
      // 모르는 조건은 루프가 멈추지 않게 ConfigError 가 아닌 목록으로 돌아온다. 경로는 그 목록의 키다
      const reason = unknownConditionsText(unknown).replace(/^queue\.auto_review\.require 에 /, '')
      return [{ path: 'queue.auto_review.require', reason, kind: 'value' }]
    } catch (e) {
      return asProblem('queue.auto_review', e)
    }
  },
}

function zodCheck(schema: z.ZodType): Check {
  return { kind: 'zod', schema }
}

// ---- 키별 검사 --------------------------------------------------------------------------------------------

const eventTimeouts = z.strictObject(Object.fromEntries(HOOK_EVENT_NAMES.map((name) => [name, timer.optional()])))

const unitGroups = leaf((value) => {
  if (!Array.isArray(value) || value.length === 0) return false
  if (!value.every((group) => Array.isArray(group) && group.length >= 2 && group.every((member) => isNonEmpty(member) && !member.includes(',')))) return false
  try {
    groupMap(value as string[][])
    return true
  } catch {
    return false
  }
}, 'queue.unit_groups 는 단위 이름이 둘 이상인 문자열 목록의 목록이어야 하고 한 단위가 두 묶음에 들 수 없다')

const requiredChecks = leaf((value) => {
  if (typeof value === 'string') return value.split(',').some((piece) => piece) && !/["\\]/.test(value)
  return isNonEmptyList(value) && !value.some((name) => /["\\]/.test(name))
}, 'queue.required 는 쉼표로 이은 체크 이름이나 체크 이름 목록이어야 한다. 이름에 따옴표와 역슬래시를 넣을 수 없다')

const inboxAdapter = z.record(z.string(), z.array(z.union([z.string(), z.number()])))

export const KEYS: Readonly<Record<Section, Readonly<Record<string, Check>>>> = {
  hooks: { timeouts: zodCheck(eventTimeouts) },
  queue: {
    required: zodCheck(requiredChecks),
    verify_merged_when: zodCheck(z.enum(['overlap', 'code', 'always'])),
    docs_glob: zodCheck(stringOrList('queue.docs_glob')),
    method: zodCheck(z.enum(['merge', 'squash', 'rebase'])),
    up_to_date_when: zodCheck(z.enum(['always', 'overlap'])),
    shared_paths: zodCheck(regexpSource('queue.shared_paths', '|')),
    unit_prefix: zodCheck(nonEmptyText),
    skipped_is_missing: zodCheck(bool),
    update_docs_on_overlap: zodCheck(bool),
    require_up_to_date: zodCheck(bool),
    sweep_args: zodCheck(stringList),
    unit_groups: zodCheck(unitGroups),
    poll_min_sec: zodCheck(wholeSec),
    poll_max_sec: zodCheck(wholeSec),
    ci_expected_sec: zodCheck(wholeSec),
    auto_merge: zodCheck(bool),
    auto_review: REVIEW_ENTRY,
  },
  pipeline: {
    enabled: zodCheck(bool),
    tick_sec: zodCheck(timer),
    digest_sec: zodCheck(timer),
    ready_slots: zodCheck(z.number().int().min(1)),
    docs_merge: zodCheck(bool),
    after_queue_interval_sec: zodCheck(z.number().min(0)),
    ci_missing_after_sec: zodCheck(z.number().min(0)),
    update_behind_drafts: zodCheck(bool),
    authors: zodCheck(stringList),
    stall_ticks: { kind: 'core', names: ['error', 'idle'], check: (value) => {
      try {
        stallTicks(value)
        return []
      } catch (e) {
        return asProblem('pipeline.stall_ticks', e)
      }
    } },
    idle_min: zodCheck(z.number().min(0)),
    idle_exited: zodCheck(bool),
    refresh_slots: zodCheck(z.number().int().min(0)),
    refresh_worker_paths: zodCheck(regexpSource('pipeline.refresh_worker_paths', '|')),
  },
  heavy: Object.fromEntries(
    HEAVY_KEYS.map((key) => [
      key,
      {
        kind: 'core',
        check: (value: unknown) => {
          try {
            compileHeavy({ [key]: value })
            return []
          } catch (e) {
            return asProblem(`heavy.${key}`, e)
          }
        },
      } satisfies Check,
    ]),
  ),
  migrations: Object.fromEntries(
    MIGRATIONS_KEYS.map((key) => [key, viaConfig('migrations', key, autoMergeConfig, key === 'blocked_after_sec' ? undefined : 'free')]),
  ),
  adr: { dirs: viaConfig('adr', 'dirs', adrDirs, 'free') },
  contracts: {
    // 두 키는 함께 있어야 판정한다. 키별 검사는 짝 키에 통과하는 값을 채워 부르고, 짝은 짝 규칙이 본다
    merge_command: viaConfig('contracts', 'merge_command', contractSettings, undefined, { paths: 'x' }),
    paths: viaConfig('contracts', 'paths', contractSettings, undefined, { merge_command: 'x' }),
  },
  board: {
    steps: viaConfig('board', 'steps', boardSettingsFromConfig),
    done_after: viaConfig('board', 'done_after', boardSettingsFromConfig),
    task_line: viaConfig('board', 'task_line', boardSettingsFromConfig),
    auto_advance: viaConfig('board', 'auto_advance', autoAdvanceOf),
  },
  review: { prepare: zodCheck(text) },
  routing: {
    review_author: zodCheck(nonEmptyText),
    review_pattern: zodCheck(capturePattern('routing.review_pattern', 5, 'js')),
    size_pattern: zodCheck(capturePattern('routing.size_pattern', 1, 'js')),
  },
  docker: Object.fromEntries(DOCKER_KEYS.map((key) => [key, viaConfig('docker', key, dockerRules)])),
  finish: {
    repo: zodCheck(textOrNull),
    gh_host: zodCheck(textOrNull),
    base_branch: zodCheck(textOrNull),
    board_id: zodCheck(textOrNull),
    board_bin: zodCheck(textOrNull),
    pid_file: zodCheck(textOrNull),
    run: zodCheck(textOrNull),
    deploy_workflow: zodCheck(textOrNull),
    deploy_branch: zodCheck(textOrNull),
    task_pattern: zodCheck(capturePattern('finish.task_pattern', 1, 'py-or-none')),
    spec_task_pattern: zodCheck(capturePattern('finish.spec_task_pattern', 1, 'py-or-none')),
    specs_dir: zodCheck(text),
    board: zodCheck(text),
    sweep_arg: zodCheck(z.array(z.string())),
    complete: zodCheck(bool),
    intermediate: zodCheck(bool),
    merge_timeout: zodCheck(numberLike('finish.merge_timeout', 'positive')),
    deploy_timeout: zodCheck(numberLike('finish.deploy_timeout', 'positive')),
    poll_interval: zodCheck(numberLike('finish.poll_interval', 'positive', TIMER_MAX_SEC)),
    worker_done_timeout: zodCheck(numberLike('finish.worker_done_timeout', 'nonnegative')),
  },
  cleanup: {
    repo: zodCheck(textOrNull),
    gh_host: zodCheck(textOrNull),
    run: zodCheck(textOrNull),
    orch_dir: zodCheck(textOrNull),
    previews: zodCheck(textOrNull),
    trash: zodCheck(textOrNull),
    board: zodCheck(textOrNull),
    data_ext: zodCheck(textOrNull),
    queue_days: zodCheck(numberLike('cleanup.queue_days', 'nonnegative')),
    folder_days: zodCheck(numberLike('cleanup.folder_days', 'nonnegative')),
    data_days: zodCheck(numberLike('cleanup.data_days', 'nonnegative')),
    apply: zodCheck(bool),
  },
  inbox: {
    enabled: zodCheck(bool),
    dooray: zodCheck(inboxAdapter),
    slack: zodCheck(inboxAdapter),
  },
}

// ---- 짝 규칙 ----------------------------------------------------------------------------------------------

const present = (body: Record<string, unknown>, key: string) => body[key] !== undefined
const filled = (body: Record<string, unknown>, key: string) => typeof body[key] === 'string' && body[key] !== ''

export const PAIRS: Readonly<Partial<Record<Section, readonly Pair[]>>> = {
  contracts: [
    {
      keys: ['merge_command', 'paths'],
      check: (body) => (present(body, 'merge_command') === present(body, 'paths') ? null : 'merge_command 와 paths 는 둘 다 있거나 둘 다 없어야 한다'),
    },
  ],
  finish: [
    {
      keys: ['deploy_workflow', 'deploy_branch'],
      check: (body) => (filled(body, 'deploy_workflow') === filled(body, 'deploy_branch') ? null : 'deploy_workflow 와 deploy_branch 는 둘 다 채우거나 둘 다 비워야 한다'),
    },
    {
      keys: ['complete', 'intermediate'],
      check: (body) => (body.complete === true && body.intermediate === true ? 'complete 와 intermediate 는 함께 true 일 수 없다' : null),
    },
  ],
  queue: [
    {
      keys: ['up_to_date_when', 'require_up_to_date'],
      check: (body) => (body.up_to_date_when === 'overlap' && body.require_up_to_date !== true ? 'up_to_date_when 이 overlap 이면 require_up_to_date 가 true 여야 한다' : null),
    },
    {
      keys: ['shared_paths', 'unit_groups', 'up_to_date_when'],
      check: (body) =>
        (present(body, 'shared_paths') || present(body, 'unit_groups')) && (body.up_to_date_when ?? 'always') !== 'overlap'
          ? 'shared_paths 와 unit_groups 는 up_to_date_when 이 overlap 일 때만 둘 수 있다'
          : null,
    },
    {
      keys: ['update_docs_on_overlap', 'docs_glob'],
      check: (body) => (body.update_docs_on_overlap === true && !present(body, 'docs_glob') ? 'update_docs_on_overlap 이 true 이면 docs_glob 이 있어야 한다' : null),
    },
    {
      keys: ['poll_min_sec', 'poll_max_sec'],
      check: (body) => {
        const min = (body.poll_min_sec as number | undefined) ?? 60
        const max = (body.poll_max_sec as number | undefined) ?? 300
        return min > max ? `poll_min_sec(${min}) 가 poll_max_sec(${max}) 보다 클 수 없다. 한쪽을 빼면 기본값 60, 300 과 비교한다` : null
      },
    },
  ],
}

// ---- 문제 모으기 ------------------------------------------------------------------------------------------

function pathText(segments: readonly PropertyKey[]): string {
  return segments.reduce<string>((text, segment) => (typeof segment === 'number' ? `${text}[${segment}]` : text ? `${text}.${String(segment)}` : String(segment)), '')
}

function zodProblems(prefix: string, schema: z.ZodType, value: unknown): Problem[] {
  const result = schema.safeParse(value, KO)
  if (result.success) return []
  const found: Problem[] = []
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) found.push({ path: pathText([...prefix.split('.'), ...issue.path, key]), reason: '모르는 키다', kind: 'unknown' })
    } else {
      found.push({ path: pathText([...prefix.split('.'), ...issue.path]), reason: issue.message, kind: 'value' })
    }
  }
  return found
}

function checkKey(name: Section, key: string, value: unknown): Problem[] {
  const entry = KEYS[name][key]
  if (entry.kind === 'zod') return zodProblems(`${name}.${key}`, entry.schema, value)
  return entry.check(value)
}

const REMOVED_REASON = 'orch 5.2.0 에서 지운 설정이다. orch doctor migrate-hooks --apply 로 핸들러에 옮긴다'

const isSection = (name: string): name is Section => (SECTIONS as readonly string[]).includes(name)

export function problems(raw: unknown): Problem[] {
  if (!isObject(raw)) return [{ path: 'config.json', reason: '최상위는 객체여야 한다', kind: 'structure' }]
  const found: Problem[] = []
  for (const name of Object.keys(raw)) {
    if (!isSection(name)) found.push({ path: name, reason: `모르는 절이다. ${SECTIONS.join(', ')} 중 하나다`, kind: 'unknown' })
  }
  for (const name of SECTIONS) {
    if (!Object.hasOwn(raw, name)) continue
    const body = raw[name]
    if (!isObject(body)) {
      found.push({ path: name, reason: '절은 객체여야 한다', kind: 'structure' })
      continue
    }
    const removed = REMOVED_CONFIG_KEYS.filter((entry) => entry.section === name && Object.hasOwn(body, entry.key)).map((entry) => entry.key)
    for (const key of removed) found.push({ path: `${name}.${key}`, reason: REMOVED_REASON, kind: 'removed' })
    const failed = new Set<string>()
    for (const key of Object.keys(body)) {
      if (removed.includes(key)) continue
      if (!Object.hasOwn(KEYS[name], key)) {
        found.push({ path: `${name}.${key}`, reason: '모르는 키다', kind: 'unknown' })
        continue
      }
      const own = checkKey(name, key, body[key])
      if (own.length > 0) failed.add(key)
      found.push(...own)
    }
    for (const pair of PAIRS[name] ?? []) {
      if (pair.keys.some((key) => failed.has(key))) continue
      const reason = pair.check(body)
      if (reason) found.push({ path: `${name}.${pair.keys[0]}`, reason, kind: 'pair' })
    }
  }
  return found
}

// ---- 경로 판정 --------------------------------------------------------------------------------------------

type ZodDef = { type: string; shape?: Record<string, z.ZodType>; innerType?: z.ZodType; element?: z.ZodType }

function defOf(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def
}

function inZod(schema: z.ZodType, names: readonly string[]): boolean {
  if (names.length === 0) return true
  const def = defOf(schema)
  if (def.type === 'optional' || def.type === 'nullable') return inZod(def.innerType as z.ZodType, names)
  if (def.type === 'record') return true
  if (def.type === 'object') {
    const next = def.shape?.[names[0]]
    return next !== undefined && inZod(next, names.slice(1))
  }
  if (def.type === 'array') return /^\d+$/.test(names[0]) && inZod(def.element as z.ZodType, names.slice(1))
  return false
}

export function knownPath(names: readonly string[]): 'known' | 'unknown' | 'removed' {
  if (names.length === 0) return 'known'
  if (REMOVED_CONFIG_KEYS.some((entry) => entry.section === names[0] && entry.key === names[1])) return 'removed'
  if (!isSection(names[0])) return 'unknown'
  if (names.length === 1) return 'known'
  if (!Object.hasOwn(KEYS[names[0]], names[1])) return 'unknown'
  const entry = KEYS[names[0]][names[1]]
  const rest = names.slice(2)
  if (entry.kind === 'zod') return inZod(entry.schema, rest) ? 'known' : 'unknown'
  if (rest.length === 0 || entry.names === 'free') return 'known'
  return entry.names !== undefined && rest.length === 1 && entry.names.includes(rest[0]) ? 'known' : 'unknown'
}
