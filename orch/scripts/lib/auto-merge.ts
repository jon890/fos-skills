// 상주 루프의 자동 머지(orch-loop.ts 머리 주석의 「자동 머지」)가 쓰는 판정의 한 벌이다. 근거는 docs/adr/016-orch-auto-merge.md 다.
//
// 함수는 gh, git, 파일 시스템을 부르지 않는다. 입력은 부르는 쪽이 이미 읽은 값(경로 목록, 리뷰 본문, 보드 항목)이다.
// 테스트가 가짜 프로세스 없이 경계 값을 볼 수 있게 하려는 것이다.
//
// 판정:
//   - autoMergeConfig  queue.auto_merge, queue.auto_review, migrations.* 를 읽는다. 키 뜻은 docs/data-schema.md 「config.json 에 더하는 절」 이 소유한다.
//                      값이 잘못됐으면 ConfigError 다. 정규식을 읽지 못한 것도 ConfigError 로 바꿔 명령이 종료 코드 2 로 끝나게 한다
//   - specHold         지시서의 첫 `머지 보류:` 줄의 이유. 줄 꼴은 lib/spec.ts 의 BRANCH_LINE 과 같다(목록 기호, 굵은 글씨)
//   - boardHold        보드 항목의 next 와 details 가운데 끝나지 않은 줄이 `머지 보류` 로 시작하면 그 줄. 옛 문자열 줄은 끝나지 않은 줄이다
//   - reviewVerdict    리뷰와 댓글을 늦은 것부터 보고 pass 나 block 에 맞는 첫 본문으로 정한다. 둘 다 맞으면 block 이다
//   - migrationOf      모듈 폴더 아래 Flyway 버전 마이그레이션(`V<버전>__<설명>`). 버전은 `.` 과 `_` 로 나눈 숫자 목록이다.
//                      반복 마이그레이션(`R__`)과 되돌리기(`U`)는 번호를 차지하지 않아 세지 않는다
//   - judgeMigrations  base 최고 이하이거나 다른 열린 PR 과 같은 번호는 clash, 같은 모듈에 더 낮은 번호를 더한 다른 열린 PR 은 lower 다
//   - beforeCommand    마이그레이션 모듈의 머지 전 명령(migrations.before)을 ` && ` 로 잇는다
//   - queueOrder       준비를 처음 본 순서에서 같은 모듈 마이그레이션 PR 의 자리만 번호 순으로 바꾸고, 모듈을 함께 가진 PR 을 묶음(--chain)으로 만든다
//   - sweepArgs        queue.sweep_args 의 --run 을 큐의 Run 으로 맞춘다. merge-with-finish 는 설정의 --run 과 --run 옵션이 다르면 사용법 오류다

import { ConfigError, MIGRATIONS_KEYS, QUEUE_KEYS, section } from './config.ts'
import { detailText } from './board.ts'
import { pyRegExp } from './py.ts'
import { LINE_BREAK } from './spec.ts'
import type { Config } from './config.ts'
import type { BoardDetail, BoardItem } from './board.ts'

export type ReviewRule = { pass: RegExp; block: RegExp }
export type AutoMergeConfig = {
  enabled: boolean
  review: ReviewRule | null
  dirs: Record<string, string>
  before: Record<string, string> | null
  blockedAfterSec: number
}

const BLOCKED_AFTER_SEC = 3600
const REVIEW_KEYS = ['pass', 'block'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 값이 모두 비지 않은 문자열인 객체. 아니면 ConfigError
function stringMap(value: unknown, name: string): Record<string, string> {
  if (!isObject(value)) throw new ConfigError(`설정 파일의 ${name} 는 객체여야 한다`)
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' || !item) throw new ConfigError(`설정 파일의 ${name}.${key} 는 비지 않은 문자열이어야 한다`)
  }
  return { ...(value as Record<string, string>) }
}

function reviewRule(value: unknown): ReviewRule {
  const name = 'queue.auto_review'
  if (!isObject(value)) throw new ConfigError(`설정 파일의 ${name} 는 {"pass": 정규식, "block": 정규식} 객체여야 한다`)
  const unknown = Object.keys(value)
    .filter((key) => !(REVIEW_KEYS as readonly string[]).includes(key))
    .sort()
  if (unknown.length > 0) throw new ConfigError(`설정 파일의 ${name} 에 모르는 키가 있다: ${unknown.join(', ')}`)
  const rule: Partial<ReviewRule> = {}
  for (const key of REVIEW_KEYS) {
    const source = value[key]
    if (typeof source !== 'string' || !source) throw new ConfigError(`설정 파일의 ${name}.${key} 는 비지 않은 문자열이어야 한다`)
    try {
      rule[key] = pyRegExp(source)
    } catch (e) {
      throw new ConfigError(`설정 파일의 ${name}.${key} 를 정규식으로 읽지 못했다: ${(e as Error).message}`)
    }
  }
  return rule as ReviewRule
}

export function autoMergeConfig(config: Config): AutoMergeConfig {
  const queue = section<Record<string, unknown>>(config, 'queue', QUEUE_KEYS)
  const migrations = section<Record<string, unknown>>(config, 'migrations', MIGRATIONS_KEYS)

  const enabled = queue.auto_merge ?? false
  if (typeof enabled !== 'boolean') throw new ConfigError('설정 파일의 queue.auto_merge 는 true 나 false 여야 한다')

  const review = queue.auto_review === undefined ? null : reviewRule(queue.auto_review)

  const dirs: Record<string, string> = {}
  if (migrations.dirs !== undefined) {
    for (const [module, dir] of Object.entries(stringMap(migrations.dirs, 'migrations.dirs'))) {
      const trimmed = dir.replace(/\/+$/, '')
      if (!trimmed) throw new ConfigError(`설정 파일의 migrations.dirs.${module} 는 저장소 루트 기준 폴더여야 한다: ${JSON.stringify(dir)}`)
      dirs[module] = trimmed
    }
  }

  const before = migrations.before === undefined ? null : stringMap(migrations.before, 'migrations.before')

  const blockedAfterSec = migrations.blocked_after_sec ?? BLOCKED_AFTER_SEC
  if (typeof blockedAfterSec !== 'number' || !Number.isFinite(blockedAfterSec) || blockedAfterSec <= 0) {
    throw new ConfigError('설정 파일의 migrations.blocked_after_sec 는 양수여야 한다')
  }

  return { enabled, review, dirs, before, blockedAfterSec }
}

// 줄 머리의 `머지 보류: 이유`. 목록 기호(-, *)와 굵은 글씨(**머지 보류:**, **머지 보류**:)를 모두 받는다.
// g 플래그를 두지 않는다. lastIndex 가 남으면 같은 줄을 두 번 검사할 때 결과가 달라진다
export const HOLD_LINE: RegExp = /^\s*(?:[-*]\s+)?(?:\*\*)?머지 보류(?:\*\*)?:(?:\*\*)?\s*(.*)$/

// 보드 단계 줄의 머리. 번호(`2.`, `2)`, `2`)가 앞에 붙어도 된다
const BOARD_HOLD = /^\s*(?:\d+[.)]?\s+)?머지 보류/

export function specHold(text: string): string | null {
  for (const line of text.split(LINE_BREAK)) {
    const m = HOLD_LINE.exec(line)
    if (m) return m[1].trim() || '이유 없음'
  }
  return null
}

// next 와 details 의 끝나지 않은 줄. 목록이 아닌 문자열(옛 형식)은 줄마다 끝나지 않은 줄이다
function openLines(field: unknown): string[] {
  if (typeof field === 'string') return field.split(/\r?\n/)
  if (!Array.isArray(field)) return []
  const found: string[] = []
  for (const entry of field as unknown[]) {
    if (typeof entry === 'string') found.push(entry)
    else if (isObject(entry) && typeof entry.text === 'string' && entry.done !== true) found.push(detailText(entry as BoardDetail))
  }
  return found
}

export function boardHold(item: BoardItem): string | null {
  for (const line of [...openLines(item.next), ...openLines(item.details)]) {
    if (BOARD_HOLD.test(line)) return line
  }
  return null
}

export type ReviewNote = { body: string; at: string }

export function reviewVerdict(notes: ReviewNote[], rule: ReviewRule): 'pass' | 'block' | 'none' {
  // 시각을 읽지 못한 본문은 가장 이른 것으로 본다. 시각이 같으면 목록에서 뒤에 있는 것을 늦은 것으로 본다
  const time = (at: string) => {
    const t = Date.parse(at)
    return Number.isNaN(t) ? -Infinity : t
  }
  const latest = notes
    .map((note, index) => ({ note, index, t: time(note.at) }))
    .sort((a, b) => (a.t === b.t ? b.index - a.index : b.t - a.t))
  for (const { note } of latest) {
    if (rule.block.test(note.body)) return 'block'
    if (rule.pass.test(note.body)) return 'pass'
  }
  return 'none'
}

export type Migration = { module: string; version: number[]; label: string; path: string }

const VERSIONED = /^V(\d+(?:[._]\d+)*)__/

// 폴더가 겹치면(db 와 db/api) 가장 깊은 폴더의 모듈로 본다
export function migrationOf(path: string, dirs: Record<string, string>): Migration | null {
  let module: string | null = null
  let depth = -1
  for (const [name, raw] of Object.entries(dirs)) {
    const dir = raw.replace(/\/+$/, '')
    if (dir && path.startsWith(`${dir}/`) && dir.length > depth) {
      module = name
      depth = dir.length
    }
  }
  if (module === null) return null
  const m = VERSIONED.exec(path.slice(path.lastIndexOf('/') + 1))
  if (!m) return null
  return { module, version: m[1].split(/[._]/).map(Number), label: `V${m[1]}`, path }
}

export function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function maxByModule(paths: string[], dirs: Record<string, string>): Map<string, Migration> {
  const max = new Map<string, Migration>()
  for (const path of paths) {
    const found = migrationOf(path, dirs)
    if (!found) continue
    const current = max.get(found.module)
    if (!current || compareVersion(found.version, current.version) > 0) max.set(found.module, found)
  }
  return max
}

export type OpenMigrations = { pr: number; migrations: Migration[] }
export type MigrationJudgement = {
  clashes: { module: string; label: string; reason: string }[]
  lower: { pr: number; module: string; label: string; mine: string }[]
}

// 이 PR 의 마이그레이션마다 본다. base 최고 이하면 그 이유 하나만 낸다. 다른 PR 과 같은 번호여도 base 를 넘기는 번호로 다시 정해야 하는 것은 같다
export function judgeMigrations(pr: number, mine: Migration[], baseMax: Map<string, Migration>, others: OpenMigrations[]): MigrationJudgement {
  const judgement: MigrationJudgement = { clashes: [], lower: [] }
  const rest = others.filter((other) => other.pr !== pr)
  for (const m of mine) {
    const base = baseMax.get(m.module)
    if (base && compareVersion(m.version, base.version) <= 0) {
      judgement.clashes.push({ module: m.module, label: m.label, reason: `base 최고 ${base.label} 이하` })
    } else {
      for (const other of rest) {
        if (other.migrations.some((o) => o.module === m.module && compareVersion(o.version, m.version) === 0)) {
          judgement.clashes.push({ module: m.module, label: m.label, reason: `#${other.pr} 과 같은 번호` })
        }
      }
    }
    for (const other of rest) {
      for (const o of other.migrations) {
        if (o.module !== m.module || compareVersion(o.version, m.version) >= 0) continue
        if (base && compareVersion(o.version, base.version) <= 0) continue
        judgement.lower.push({ pr: other.pr, module: m.module, label: o.label, mine: m.label })
      }
    }
  }
  return judgement
}

// before 의 `*` 는 규칙이 없는 나머지 모듈의 명령이고 `{module}` 이 모듈 이름으로 바뀐다
export function beforeCommand(
  modules: string[],
  before: Record<string, string> | null,
): { ok: true; command: string | null } | { ok: false; module: string } {
  if (before === null || modules.length === 0) return { ok: true, command: null }
  const commands: string[] = []
  for (const module of [...new Set(modules)].sort()) {
    if (Object.hasOwn(before, module)) commands.push(before[module])
    else if (Object.hasOwn(before, '*')) commands.push(before['*'].replaceAll('{module}', module))
    else return { ok: false, module }
  }
  return { ok: true, command: commands.join(' && ') }
}

export type QueueItem = { pr: number; readyAt: string; migrations: Migration[] }

// 모듈마다 그 PR 의 가장 낮은 버전
function lowestByModule(item: QueueItem): Map<string, number[]> {
  const lowest = new Map<string, number[]>()
  for (const m of item.migrations) {
    const current = lowest.get(m.module)
    if (!current || compareVersion(m.version, current) < 0) lowest.set(m.module, m.version)
  }
  return lowest
}

// 순서는 준비 순(readyAt, 같으면 PR 번호)에서 모듈 이름 순으로 모듈마다 그 모듈 PR 이 앉은 자리를 가장 낮은 버전 순으로 다시 채운다.
// 모듈 둘 이상에 걸친 PR 때문에 뒤 모듈의 재배치가 앞 모듈의 순서를 깨면, 모든 모듈의 버전이 오름차순인 가장 긴 앞부분만 남긴다.
// 나머지는 다음 틱에 다시 본다. 번호 순서를 어기고 거는 것보다 늦게 거는 쪽이 되돌리기 쉽다.
// 묶음은 남은 PR 가운데 모듈을 함께 가진 PR 을 이은 것이다. 머지 큐가 PR 하나를 묶음 하나에만 들게 하므로 모듈 둘에 걸친 PR 은 두 묶음을 합친다.
// 빠진 PR 을 거쳐서만 이어지는 PR 은 묶지 않는다. 둘 이상인 묶음만 order 순서로 낸다
export function queueOrder(items: QueueItem[]): { order: number[]; chains: number[][] } {
  const time = (at: string) => {
    const t = Date.parse(at)
    return Number.isNaN(t) ? Infinity : t
  }
  const byPr = new Map(items.map((item) => [item.pr, lowestByModule(item)]))
  const lowest = (pr: number): Map<string, number[]> => byPr.get(pr) ?? new Map()
  const order = [...items]
    .sort((a, b) => {
      const ta = time(a.readyAt)
      const tb = time(b.readyAt)
      return ta === tb ? a.pr - b.pr : ta - tb
    })
    .map((item) => item.pr)
  const modules = [...new Set(items.flatMap((item) => item.migrations.map((m) => m.module)))].sort()
  for (const module of modules) {
    const seats: number[] = []
    for (let i = 0; i < order.length; i++) if (lowest(order[i]).has(module)) seats.push(i)
    const version = (pr: number) => lowest(pr).get(module) ?? []
    const sorted = seats.map((i) => order[i]).sort((a, b) => compareVersion(version(a), version(b)))
    seats.forEach((seat, k) => {
      order[seat] = sorted[k]
    })
  }

  const last = new Map<string, number[]>()
  let kept = 0
  for (; kept < order.length; kept++) {
    const versions = [...lowest(order[kept])]
    if (versions.some(([module, version]) => compareVersion(version, last.get(module) ?? []) < 0)) break
    for (const [module, version] of versions) last.set(module, version)
  }
  order.length = kept

  // 모듈마다 처음 본 PR 의 묶음에 뒤 PR 의 묶음을 합친다
  const parent = new Map<number, number>()
  const root = (pr: number): number => {
    let at = pr
    for (let up = parent.get(at); up !== undefined && up !== at; up = parent.get(at)) at = up
    return at
  }
  const owner = new Map<string, number>()
  for (const pr of order) {
    for (const module of lowest(pr).keys()) {
      const first = owner.get(module)
      if (first === undefined) owner.set(module, pr)
      else if (root(pr) !== root(first)) parent.set(root(pr), root(first))
    }
  }
  const members = new Map<number, number[]>()
  for (const pr of order) members.set(root(pr), [...(members.get(root(pr)) ?? []), pr])
  const chains = [...members.values()].filter((chain) => chain.length >= 2)
  return { order, chains }
}

export function sweepArgs(configured: unknown, run: string): string[] | null {
  if (!Array.isArray(configured) || !configured.every((arg) => typeof arg === 'string')) return null
  const args = [...(configured as string[])]
  let found = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--run') continue
    found = true
    if (i + 1 < args.length) args[i + 1] = run
    else args.push(run)
    i += 1
  }
  if (!found) args.push('--run', run)
  return args
}
