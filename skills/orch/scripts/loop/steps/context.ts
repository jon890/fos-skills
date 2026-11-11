// 루프 설정을 읽고, 틱의 단계가 주고받는 값(StepContext, StepState, StepResult)을 정한다.
// 단계는 StepContext 와 StepState 를 받아 바꿀 값만 StepResult 로 돌려주고, orch-loop.ts 의 tick 이 차례로 합친다.
//
// 틱의 Run: 틱 자식은 등록을 다시 읽는다. 등록이 없으면 --run(또는 finish.run) 하나를, 그것도 없으면 Run 없는 한 칸을 맡는다.
//
// 설정: pipeline.tick_sec(양수, 기본 300), pipeline.digest_sec(양수, 기본 1800), pipeline.stall_ticks({"error": 0 이상의 정수, "idle": 0 이상의 정수}. stalls.ts 머리 주석의 「멈춤 확인」),
//     pipeline.idle_min, pipeline.idle_exited(movement.ts 머리 주석의 「움직임 확인」. lib/movement.ts 의 movementSettings 가 읽는다), finish.run, finish.specs_dir, queue.required, queue.skipped_is_missing(true 나 false),
//     queue.auto_merge, queue.auto_review, migrations.dirs, migrations.before, migrations.blocked_after_sec(lib/auto-merge.ts 의 autoMergeConfig 가 읽는다.
//     auto-merge.ts 머리 주석의 「자동 머지」), queue.sweep_args(자동 머지가 큐에 --sweep-arg 로 넘긴다),
//     pipeline.refresh_slots, pipeline.refresh_worker_paths 와 머지 큐의 최신화 키(lib/refresh.ts 의 refreshSettings 가 읽는다. refresh.ts 머리 주석의 「최신화」).
//     finish 절은 lib/finish-options.ts 의 FINISH_KEYS 로, queue 절은 lib/config.ts 의 QUEUE_KEYS 로 읽는다.
//     pipeline.enabled 는 읽지 않는다. 이 루프가 하는 일은 모두 그 값과 무관하게 돈다.

import { autoAdvanceOf } from '../../core/auto-advance.ts'
import { isObject } from '../../core/json.ts'
import { autoMergeConfig } from '../../lib/auto-merge.ts'
import type { AutoMergeConfig } from '../../lib/auto-merge.ts'
import { ConfigError, loadConfig, PIPELINE_KEYS, QUEUE_KEYS, section } from '../../lib/config.ts'
import type { Found } from '../../lib/conflicts.ts'
import { FINISH_KEYS } from '../../lib/finish-options.ts'
import { readLoop, registeredRuns } from '../../lib/loop.ts'
import type { LoopState } from '../../lib/loop.ts'
import { movementSettings } from '../../lib/movement.ts'
import type { MovementSettings } from '../../lib/movement.ts'
import { DEFAULT_DIGEST_SEC } from '../../lib/notice-digest.ts'
import { poll } from '../../lib/questions.ts'
import { refreshSettings } from '../../lib/refresh.ts'
import type { RefreshSettings } from '../../lib/refresh.ts'
import type { CiEntry, Lookup, Prs, Stall, StallState, TickRun, Waiting } from './shared.ts'

const DEFAULT_TICK_SEC = 300

// pipeline.stall_ticks 의 기본값(stalls.ts 머리 주석의 「멈춤 확인」). idle 은 백그라운드 에이전트를 기다리는 정상 화면과 구분되지 않아 끈다
const DEFAULT_STALL_TICKS: Readonly<Record<StallState, number>> = Object.freeze({ error: 2, idle: 0 })

export type Context = {
  repo: string
  run: string | null
  specsDir: string | null
  tickSec: number
  // pipeline.digest_sec. 모아 보내는 알림의 주기(초, lib/notice-digest.ts)
  digestSec: number
  skippedIsMissing: boolean
  stallTicks: Record<StallState, number>
  // pipeline.idle_min, pipeline.idle_exited(movement.ts 머리 주석의 「움직임 확인」)
  autoAdvance: boolean
  movement: MovementSettings
  autoMerge: AutoMergeConfig
  // pipeline.refresh_slots 와 머지 큐의 최신화 기준(refresh.ts 머리 주석의 「최신화」, lib/refresh.ts 의 refreshSettings)
  refresh: RefreshSettings
  // config 의 queue.sweep_args 그대로. 자동 머지가 lib/auto-merge.ts 의 sweepArgs 로 큐의 Run 에 맞춘다
  sweepArgs: unknown
}

export type TickResult = {
  tick_at: string
  errors: Record<string, string | null>
  open_prs: number[] | null
  ci?: Record<string, CiEntry>
  stalls?: Record<string, Stall>
}

function optionalString(value: unknown, key: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new ConfigError(`설정 파일의 ${key} 는 문자열이어야 한다`)
  return value
}

function stallTicks(value: unknown): Record<StallState, number> {
  if (value === undefined) return { ...DEFAULT_STALL_TICKS }
  const shape = '설정 파일의 pipeline.stall_ticks 는 {"error": 틱 수, "idle": 틱 수} 객체여야 한다'
  if (!isObject(value)) throw new ConfigError(shape)
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(DEFAULT_STALL_TICKS, key))
  if (unknown.length > 0) throw new ConfigError(`${shape}. 모르는 키: ${unknown.sort().join(', ')}`)
  const ticks = { ...DEFAULT_STALL_TICKS }
  for (const key of Object.keys(DEFAULT_STALL_TICKS) as StallState[]) {
    const n = value[key]
    if (n === undefined) continue
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new ConfigError(`설정 파일의 pipeline.stall_ticks.${key} 는 0 이상의 정수여야 한다: ${JSON.stringify(n)}`)
    ticks[key] = n
  }
  return ticks
}

export function context(repo: string, run: string | undefined, specsDir: string | undefined): Context {
  const config = loadConfig(repo)
  const pipeline = section<{ tick_sec?: unknown; stall_ticks?: unknown; digest_sec?: unknown }>(config, 'pipeline', PIPELINE_KEYS)
  const finish = section<{ run?: unknown; specs_dir?: unknown }>(config, 'finish', FINISH_KEYS)
  const queue = section<{ skipped_is_missing?: unknown; sweep_args?: unknown }>(config, 'queue', QUEUE_KEYS)
  const skipped = queue.skipped_is_missing ?? false
  if (typeof skipped !== 'boolean') throw new ConfigError('설정 파일의 queue.skipped_is_missing 은 true 나 false 여야 한다')
  const tickSec = pipeline.tick_sec ?? DEFAULT_TICK_SEC
  if (typeof tickSec !== 'number' || !Number.isFinite(tickSec) || tickSec <= 0) {
    throw new ConfigError(`설정 파일의 pipeline.tick_sec 은 양수여야 한다: ${JSON.stringify(tickSec)}`)
  }
  const digestSec = pipeline.digest_sec ?? DEFAULT_DIGEST_SEC
  if (typeof digestSec !== 'number' || !Number.isFinite(digestSec) || digestSec <= 0) {
    throw new ConfigError(`설정 파일의 pipeline.digest_sec 은 양수여야 한다: ${JSON.stringify(digestSec)}`)
  }
  return {
    repo,
    digestSec,
    run: run || optionalString(finish.run, 'finish.run'),
    specsDir: specsDir || optionalString(finish.specs_dir, 'finish.specs_dir'),
    tickSec,
    skippedIsMissing: skipped,
    stallTicks: stallTicks(pipeline.stall_ticks),
    autoAdvance: autoAdvanceOf(config),
    movement: movementSettings(repo),
    autoMerge: autoMergeConfig(config),
    refresh: refreshSettings(config),
    sweepArgs: queue.sweep_args,
  }
}

function tickRuns(ctx: Context): TickRun[] {
  const entries = registeredRuns(ctx.repo)
  if (entries.length === 0) return [{ run: ctx.run, specsDir: ctx.specsDir }]
  return entries.map((entry) => ({ run: entry.run, specsDir: entry.specs_dir }))
}

// 단계가 함께 읽는 값. 설정에 이번 틱의 번호와 맡은 Run, 앞 틱의 loop.json 을 더한다
export type StepContext = Context & {
  // 틱 번호. 1 부터다
  tick: number
  // 이번 틱이 맡는 Run. 앞이 주 Run 이다
  runs: TickRun[]
  primary: string | null
  // 앞 틱까지의 loop.json. 틱 자식은 읽기만 한다
  loaded: LoopState | null
  // 앞 틱의 errors. 같은 이유를 다시 알리지 않는 데 쓴다(errors.ts)
  previous: Record<string, unknown>
  // 틱 안에서 한 번만 읽는 워크트리 목록과 Run 마다의 worker 행. CI 감시부터 최신화까지 함께 쓴다
  lookup: Lookup
  // 질문 확인과 완료 보고가 함께 쓰는 이번 틱의 worker_done 목록.
  completions: Map<string, Record<string, any>[]>
}

// Run 의 닫히지 않은 미답변 질문
export type Pending = ReturnType<typeof poll>['pending']

// 단계가 다음 단계에 넘기는 값과 결과 줄에 담을 값
export type StepState = {
  // 출처마다의 오류 이유. 결과 줄의 errors 다(errors.ts)
  errors: Record<string, string | null>
  // 질문 확인이 낸다. Run 마다 미답변 질문을 보낸 worker 다. null 은 그 Run 의 질문을 읽지 못한 것이다
  waiting: Map<string, Waiting>
  // 질문 확인이 낸다. 질문을 읽지 못한 Run 은 없다
  pending: Map<string, Pending>
  // 열린 PR 조회가 낸다
  prs: Prs
  // CI 감시가 낸다. 열린 PR 을 읽지 못했거나 감시가 실패한 틱은 없다. 그때는 부모가 이전 값을 둔다
  ci?: Record<string, CiEntry>
  // CI 감시가 규칙을 읽지 못해 이전 판정을 옮긴 PR
  ciStale: Set<number>
  // 멈춤 확인이 읽은 기준 브랜치. tick 이벤트가 함께 쓴다
  base: string
  // 멈춤 확인이 낸다. 실패한 틱은 없다. 그때는 부모가 이전 값을 둔다
  stalls?: Record<string, Stall>
  // 멈춤 확인이 읽은 dispatch 마다의 화면 끝 줄. 움직임 확인이 쓴다
  tails: Map<string, string[]>
  // 충돌 처리가 낸다. 최신화가 쓴다. found 가 null 이면 충돌 찾기를 하지 않았거나 실패했다
  conflictBase: string
  found: Found | null
}

// 단계가 바꿀 값. errors 는 그 단계가 기록한 오류 이유다
export type StepResult = Partial<StepState>

export function stepContext(config: Context, n: number): StepContext {
  const loaded = readLoop(config.repo)
  const before = loaded?.errors
  const previous = isObject(before) ? before : {}
  const runs = tickRuns(config)
  return { ...config, tick: n, runs, primary: runs[0].run, loaded, previous, lookup: { runs, rows: new Map() }, completions: new Map() }
}

export function initialState(): StepState {
  return { errors: {}, waiting: new Map(), pending: new Map(), prs: { ok: false, error: '열린 PR 을 아직 읽지 않았다' }, ciStale: new Set(), base: '', tails: new Map(), conflictBase: '', found: null }
}
