// 상주 루프의 자동 머지(loop/steps/auto-merge.ts 머리 주석의 「자동 머지」)가 쓰는 판정의 한 벌이다. 근거는 docs/adr/016-orch-auto-merge.md 다.
//
// 함수는 gh, git, 파일 시스템을 부르지 않는다. 입력은 부르는 쪽이 이미 읽은 값(경로 목록, 리뷰 본문, 보드 항목)이다.
// 테스트가 가짜 프로세스 없이 경계 값을 볼 수 있게 하려는 것이다.
//
// 판정:
//   - autoMergeConfig  queue.auto_merge, queue.auto_review, migrations.* 를 읽는다. 키 뜻은 docs/data-schema.md 「config.json 에 더하는 절」 이 소유한다.
//                      값이 잘못됐으면 ConfigError 다. 정규식을 읽지 못한 것도 ConfigError 로 바꿔 명령이 종료 코드 2 로 끝나게 한다.
//                      queue.auto_review.require 의 모르는 조건 이름만은 ConfigError 가 아니라 review.unknown 에 둔다.
//                      루프가 멈추지 않고 PR 만 걸지 않으며, orch-doctor 가 INVALID-CONFIG 로 알린다
//   - specHold         지시서의 첫 `머지 보류:` 줄의 이유. 줄 꼴은 lib/spec.ts 의 BRANCH_LINE 과 같다(목록 기호, 굵은 글씨)
//   - prHold           PR 본문의 첫 `머지 보류:` 줄의 이유. 줄 꼴과 이유 규칙은 specHold 와 같고 본문 어디에 있어도 줄 머리면 읽는다.
//                      worker 가 PR 을 연 뒤 본문에만 적은 보류도 자동 머지·gate·merge 가 지시서 보류와 같게 지키게 하려는 것이다
//   - boardHold        보드 항목의 next 와 details 가운데 끝나지 않은 줄이 `머지 보류` 로 시작하면 그 줄. 옛 문자열 줄은 끝나지 않은 줄이다
//   - judgeReview      지금 HEAD 의 독립 리뷰가 있는지 본다. 리뷰 댓글의 문구로는 정하지 않는다(사용자 결정 2026-11-24. 누가 쓴 댓글이든
//                      문구만 있으면 통과하는 가짜 통과를 막으려는 것이다). 아래 가운데 하나가 있으면 통과다
//                        봇 영수증   queue.auto_review.trusted_bots 의 봇이 지금 HEAD 를 확인한 영수증. 봇의 마지막 리뷰에 P1·P2 지적이 없으면
//                                    앞 커밋의 영수증도 인정한다(스펙 DECISION15, lib/review-bot.ts 의 judgeTrustedBotReviews)
//                        리뷰 체크   queue.auto_review.review_checks 의 CI 체크가 지금 HEAD 에서 success 다(core/review-checks.ts).
//                                    롤업이 지금 HEAD 의 체크만 담고 등급을 알 수 없어 앞 커밋의 결과는 인정하지 않는다. push 마다 CI 로 다시 돈다
//                      리뷰 체크를 먼저 보고, success 면 봇 영수증을 조회하지 않는다(봇 조회 실패로 막지 않는다. core/merge-readiness.ts 의 review 조건).
//                      둘 다 없으면 `리뷰 대기` 이고 missing 이다. 통과하면 근거를 `봇 영수증 <봇>(커밋 <앞 8자리>, <시각>)` 이나
//                      `리뷰 체크 <이름> success` 로 낸다
//                      옛 문구 판정 키(pass, block, require, feature_head, fixed_after_block, fallback)는 읽지 않고 ignoredReviewKeys 에 둔다.
//                      orch-doctor 가 지우라고 알린다. trusted_bots 와 review_checks 가 모두 없으면 리뷰 설정이 없는 것(review null)과 같다
//   - migrationOf      모듈 폴더 아래 Flyway 버전 마이그레이션(`V<버전>__<설명>`). 버전은 `.` 과 `_` 로 나눈 숫자 목록이다.
//                      반복 마이그레이션(`R__`)과 되돌리기(`U`)는 번호를 차지하지 않아 세지 않는다
//   - judgeMigrations  base 최고 이하이거나 다른 열린 PR 이나 다른 브랜치의 예약(docs/adr/017-orch-migration-reserve.md)과 같은 번호는 clash 다.
//                      base 최고 이하면 그 이유 하나만 낸다. 같은 모듈에 base 최고보다 크고 이 PR 보다 낮은 번호를 더한 다른 열린 PR 과
//                      예약은 lower 다. lower 항목은 열린 PR 이면 pr 에 번호, 예약이면 pr 이 null 이고 branch 에 예약한 브랜치를 둔다
//   - reservedFor      judgeMigrations 에 넘길 예약. 대상 PR 자기 브랜치의 예약과, 예약한 브랜치의 열린 PR 이 같은 (모듈, 번호)를
//                      이미 더한 예약은 뺀다. 그 PR 의 파일로 이미 세므로 같은 번호를 두 번 세지 않으려는 것이다
//   - beforeCommand    마이그레이션 모듈의 머지 전 명령(migrations.before)을 ` && ` 로 잇는다
//   - queueOrder       준비를 처음 본 순서에서 같은 모듈 마이그레이션 PR 의 자리만 번호 순으로 바꾸고, 모듈을 함께 가진 PR 을 묶음(--chain)으로 만든다
//   - sweepArgs        queue.sweep_args 의 --run 을 큐의 Run 으로 맞춘다. merge-with-finish 는 설정의 --run 과 --run 옵션이 다르면 사용법 오류다

import { isObject } from './json.ts'
import { ConfigError, MIGRATIONS_KEYS, QUEUE_KEYS, section } from './config.ts'
import { detailText } from './board.ts'
import { LINE_BREAK } from './text.ts'
import type { Config } from './config.ts'
import type { BoardDetail, BoardItem } from './board.ts'

export type TrustedReviewBot = { login: string; receiptMarker: string; reviewedCommit: RegExp; requestComment?: string }
// trustedBots 와 checks 가운데 하나 이상이 있다. 둘 다 없으면 autoMergeConfig 의 review 는 null 이다
export type ReviewConfig = { checks: string[]; trustedBots?: TrustedReviewBot[]; requestAfterSec?: number }
export type AutoMergeConfig = {
  enabled: boolean
  review: ReviewConfig | null
  // queue.auto_review 에 남은 옛 문구 판정 키. 읽지 않는다
  ignoredReviewKeys: string[]
  // 예약 파일을 만들 폴더다. watch 에만 든 경로에는 reserve-migration 이 쓰지 않는다.
  dirs: Record<string, string>
  // 모듈별 추가 감시 폴더다. dirs 와 합쳐 Flyway 번호 충돌과 순서를 판정한다.
  watch: Record<string, string[]>
  before: Record<string, string> | null
  blockedAfterSec: number
}

const BLOCKED_AFTER_SEC = 3600
export const REVIEW_CONFIG_KEYS: readonly string[] = ['trusted_bots', 'request_after_sec', 'review_checks']
// 리뷰 댓글 문구로 판정하던 옛 키. 있어도 읽지 않고 orch-doctor 가 알린다(머리 주석의 「judgeReview」)
export const LEGACY_REVIEW_KEYS: readonly string[] = ['pass', 'block', 'require', 'feature_head', 'fixed_after_block', 'fallback']
export const DEFAULT_REVIEW_REQUEST_AFTER_SEC = 180

// 값이 모두 비지 않은 문자열인 객체. 아니면 ConfigError
function stringMap(value: unknown, name: string): Record<string, string> {
  if (!isObject(value)) throw new ConfigError(`설정 파일의 ${name} 는 객체여야 한다`)
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' || !item) throw new ConfigError(`설정 파일의 ${name}.${key} 는 비지 않은 문자열이어야 한다`)
  }
  return { ...(value as Record<string, string>) }
}

function trimmedDir(value: string, name: string): string {
  const trimmed = value.replace(/\/+$/, '')
  if (!trimmed) throw new ConfigError(`설정 파일의 ${name} 는 저장소 루트 기준 폴더여야 한다: ${JSON.stringify(value)}`)
  return trimmed
}

function watchMap(value: unknown): Record<string, string[]> {
  if (!isObject(value)) throw new ConfigError('설정 파일의 migrations.watch 는 객체여야 한다')
  const watch: Record<string, string[]> = {}
  for (const [module, dirs] of Object.entries(value)) {
    if (!Array.isArray(dirs) || dirs.some((dir) => typeof dir !== 'string' || !dir)) {
      throw new ConfigError(`설정 파일의 migrations.watch.${module} 는 비지 않은 문자열 목록이어야 한다`)
    }
    watch[module] = dirs.map((dir) => trimmedDir(dir, `migrations.watch.${module}`))
  }
  return watch
}

function trustedReviewBots(value: unknown): TrustedReviewBot[] {
  const key = 'queue.auto_review.trusted_bots'
  if (!Array.isArray(value) || value.length === 0) throw new ConfigError(`설정 파일의 ${key} 는 비지 않은 목록이어야 한다`)
  const logins = new Set<string>()
  return value.map((entry: unknown) => {
    if (!isObject(entry) || Object.keys(entry).some((field) => !['login', 'receipt_marker', 'reviewed_commit', 'request_comment'].includes(field))) {
      throw new ConfigError(`설정 파일의 ${key} 항목에는 login, receipt_marker, reviewed_commit, request_comment 를 쓴다`)
    }
    const { login, receipt_marker: marker, reviewed_commit: commit } = entry
    if (typeof login !== 'string' || !/^[a-z0-9-]+(?:\[bot\])?$/i.test(login)) {
      throw new ConfigError(`설정 파일의 ${key} 항목의 login 은 GitHub 봇 계정 이름이어야 한다`)
    }
    const normalized = login.toLowerCase().replace(/\[bot\]$/, '')
    if (logins.has(normalized)) throw new ConfigError(`설정 파일의 ${key} 에 같은 봇 계정이 두 번 있다`)
    logins.add(normalized)
    if (typeof marker !== 'string' || !marker.trim() || /[\r\n]/.test(marker)) {
      throw new ConfigError(`설정 파일의 ${key} 항목의 receipt_marker 는 비지 않은 한 줄이어야 한다`)
    }
    if (typeof commit !== 'string' || !commit.trim()) {
      throw new ConfigError(`설정 파일의 ${key} 항목의 reviewed_commit 은 첫 번째 캡처 그룹으로 커밋을 읽는 정규식이어야 한다`)
    }
    let reviewedCommit: RegExp
    try {
      reviewedCommit = new RegExp(commit, 'gm')
    } catch {
      throw new ConfigError(`설정 파일의 ${key} 항목의 reviewed_commit 을 정규식으로 읽지 못했다`)
    }
    // 빈 패턴과 번갈아 검사하면 정규식이 캡처 그룹을 제공하는지 확인할 수 있다.
    if (new RegExp(`(?:${commit})|`).exec('')?.length === 1) {
      throw new ConfigError(`설정 파일의 ${key} 항목의 reviewed_commit 에 커밋을 읽을 캡처 그룹이 필요하다`)
    }
    const requestComment = entry.request_comment
    if (requestComment !== undefined && (typeof requestComment !== 'string' || !requestComment.trim() || /[\r\n]/.test(requestComment))) {
      throw new ConfigError(`설정 파일의 ${key} 항목의 request_comment 는 비지 않은 한 줄이어야 한다`)
    }
    return { login: normalized, receiptMarker: marker.trim(), reviewedCommit, ...(requestComment === undefined ? {} : { requestComment: requestComment.trim() }) }
  })
}

function reviewChecks(value: unknown): string[] {
  const key = 'queue.auto_review.review_checks'
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new ConfigError(`설정 파일의 ${key} 는 체크 이름(비지 않은 문자열)의 비지 않은 목록이어야 한다`)
  }
  return [...new Set((value as string[]).map((item) => item.trim()))]
}

function reviewRule(value: unknown): { review: ReviewConfig | null; ignored: string[] } {
  const name = 'queue.auto_review'
  if (!isObject(value)) throw new ConfigError(`설정 파일의 ${name} 는 {"trusted_bots": [...]} 나 {"review_checks": [...]} 객체여야 한다`)
  const unknown = Object.keys(value)
    .filter((key) => !REVIEW_CONFIG_KEYS.includes(key) && !LEGACY_REVIEW_KEYS.includes(key))
    .sort()
  if (unknown.length > 0) throw new ConfigError(`설정 파일의 ${name} 에 모르는 키가 있다: ${unknown.join(', ')}`)
  const ignored = Object.keys(value).filter((key) => LEGACY_REVIEW_KEYS.includes(key)).sort()
  const requestAfterSec = value.request_after_sec
  if (requestAfterSec !== undefined && (typeof requestAfterSec !== 'number' || !Number.isFinite(requestAfterSec) || requestAfterSec <= 0)) {
    throw new ConfigError(`설정 파일의 ${name}.request_after_sec 는 양수여야 한다`)
  }
  const trustedBots = value.trusted_bots === undefined ? undefined : trustedReviewBots(value.trusted_bots)
  const checks = reviewChecks(value.review_checks)
  if (!trustedBots && checks.length === 0) return { review: null, ignored }
  return {
    review: { checks, ...(trustedBots ? { trustedBots, requestAfterSec: requestAfterSec ?? DEFAULT_REVIEW_REQUEST_AFTER_SEC } : {}) },
    ignored,
  }
}

export function autoMergeConfig(config: Config): AutoMergeConfig {
  const queue = section<Record<string, unknown>>(config, 'queue', QUEUE_KEYS)
  const migrations = section<Record<string, unknown>>(config, 'migrations', MIGRATIONS_KEYS)

  const enabled = queue.auto_merge ?? false
  if (typeof enabled !== 'boolean') throw new ConfigError('설정 파일의 queue.auto_merge 는 true 나 false 여야 한다')

  const { review, ignored: ignoredReviewKeys } = queue.auto_review === undefined ? { review: null, ignored: [] } : reviewRule(queue.auto_review)

  const dirs: Record<string, string> = {}
  if (migrations.dirs !== undefined) {
    for (const [module, dir] of Object.entries(stringMap(migrations.dirs, 'migrations.dirs'))) {
      dirs[module] = trimmedDir(dir, `migrations.dirs.${module}`)
    }
  }
  const watch = migrations.watch === undefined ? {} : watchMap(migrations.watch)

  const before = migrations.before === undefined ? null : stringMap(migrations.before, 'migrations.before')

  const blockedAfterSec = migrations.blocked_after_sec ?? BLOCKED_AFTER_SEC
  if (typeof blockedAfterSec !== 'number' || !Number.isFinite(blockedAfterSec) || blockedAfterSec <= 0) {
    throw new ConfigError('설정 파일의 migrations.blocked_after_sec 는 양수여야 한다')
  }

  return { enabled, review, ignoredReviewKeys, dirs, watch, before, blockedAfterSec }
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

// PR 본문의 보류(머리 주석의 「prHold」). 지시서와 같은 줄 꼴이라 같은 규칙으로 읽는다
export function prHold(body: string): string | null {
  return specHold(body)
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

// 봇 영수증(lib/review-bot.ts). commit 은 영수증이 확인한 커밋, receiptBot 은 봇 계정이다
// earlier 는 지금 HEAD 앞 커밋의 영수증을 인정한 것이다(P1·P2 없음. lib/review-bot.ts 의 judgeTrustedBotReviews)
export type ReviewNote = { body: string; at: string; commit?: string | null; id?: string; receiptBot?: string; earlier?: boolean }

// missing 은 영수증도 리뷰 체크 성공도 없어 멈췄다는 뜻이다. 루프가 AUTO-MERGE-NO-REVIEW 로 알린다
export type ReviewJudgement =
  | { ok: true; basis: string[] }
  | { ok: false; wait: string; missing: boolean }

export const REVIEW_WAIT = '리뷰 대기'

// 머리 주석의 「judgeReview」. passedChecks 는 지금 HEAD 에서 success 인 review_checks 의 이름이다
export function judgeReview(input: { receipts: ReviewNote[]; passedChecks: string[] }, config: ReviewConfig): ReviewJudgement {
  const basis = [
    ...input.receipts.map((note) => `봇 영수증 ${note.receiptBot ?? '?'}(커밋 ${(note.commit ?? '').slice(0, 8)}, ${note.at || '시각 없음'}${note.earlier ? ', 앞 리뷰 인정(P1·P2 없음)' : ''})`),
    ...config.checks.filter((name) => input.passedChecks.includes(name)).map((name) => `리뷰 체크 ${name} success`),
  ]
  return basis.length > 0 ? { ok: true, basis } : { ok: false, wait: REVIEW_WAIT, missing: true }
}

export type Migration = { module: string; version: number[]; label: string; path: string }
export type MigrationDirs = Record<string, string | string[]>

const VERSIONED = /^V(\d+(?:[._]\d+)*)__/

// 폴더가 겹치면(db 와 db/api) 가장 깊은 폴더의 모듈로 본다
export function migrationOf(path: string, dirs: MigrationDirs): Migration | null {
  let module: string | null = null
  let depth = -1
  for (const [name, raw] of Object.entries(dirs)) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      const dir = value.replace(/\/+$/, '')
      if (dir && path.startsWith(`${dir}/`) && dir.length > depth) {
        module = name
        depth = dir.length
      }
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

export function maxByModule(paths: string[], dirs: MigrationDirs): Map<string, Migration> {
  const max = new Map<string, Migration>()
  for (const path of paths) {
    const found = migrationOf(path, dirs)
    if (!found) continue
    const current = max.get(found.module)
    if (!current || compareVersion(found.version, current.version) > 0) max.set(found.module, found)
  }
  return max
}

// 예약 폴더와 감시 전용 폴더를 모듈별로 합친다. 같은 경로는 한 번만 읽는다.
export function watchedDirs(dirs: Record<string, string>, watch: Record<string, string[]>): Record<string, string[]> {
  const all = new Map<string, string[]>()
  for (const [module, dir] of Object.entries(dirs)) all.set(module, [dir])
  for (const [module, entries] of Object.entries(watch)) {
    const current = all.get(module) ?? []
    all.set(module, [...new Set([...current, ...entries])])
  }
  return Object.fromEntries(all)
}

export type OpenMigrations = { pr: number; migrations: Migration[] }
// PR 이 아직 없을 수 있는 다른 브랜치의 예약. migrations 의 path 는 예약이 정한 파일 경로다
export type ReservedMigrations = { branch: string; migrations: Migration[] }
export type MigrationJudgement = {
  clashes: { module: string; label: string; reason: string }[]
  // 열린 PR 이면 branch 가 null, 예약이면 pr 이 null 이다
  lower: { pr: number | null; branch: string | null; module: string; label: string; mine: string }[]
}

function sameVersion(a: Migration, b: Migration): boolean {
  return a.module === b.module && compareVersion(a.version, b.version) === 0
}

// 이 PR 의 마이그레이션마다 본다. base 최고 이하면 그 이유 하나만 낸다. 다른 PR 이나 예약과 같은 번호여도 base 를 넘기는 번호로 다시 정해야 하는 것은 같다
export function judgeMigrations(
  pr: number,
  mine: Migration[],
  baseMax: Map<string, Migration>,
  others: OpenMigrations[],
  reserved: ReservedMigrations[] = [],
): MigrationJudgement {
  const judgement: MigrationJudgement = { clashes: [], lower: [] }
  const rest = others.filter((other) => other.pr !== pr)
  const holders = [
    ...rest.map((other) => ({ pr: other.pr, branch: null, migrations: other.migrations })),
    ...reserved.map((r) => ({ pr: null, branch: r.branch, migrations: r.migrations })),
  ]
  for (const m of mine) {
    const base = baseMax.get(m.module)
    if (base && compareVersion(m.version, base.version) <= 0) {
      judgement.clashes.push({ module: m.module, label: m.label, reason: `base 최고 ${base.label} 이하` })
    } else {
      for (const holder of holders) {
        if (!holder.migrations.some((o) => sameVersion(o, m))) continue
        const reason = holder.pr === null ? `${holder.branch} 의 예약과 같은 번호` : `#${holder.pr} 과 같은 번호`
        judgement.clashes.push({ module: m.module, label: m.label, reason })
      }
    }
    for (const holder of holders) {
      for (const o of holder.migrations) {
        if (o.module !== m.module || compareVersion(o.version, m.version) >= 0) continue
        if (base && compareVersion(o.version, base.version) <= 0) continue
        judgement.lower.push({ pr: holder.pr, branch: holder.branch, module: m.module, label: o.label, mine: m.label })
      }
    }
  }
  return judgement
}

// openByBranch 는 열린 PR 의 브랜치마다 그 PR 들이 더한 마이그레이션이다. base 를 가리지 않는다. 예약도 base 에 묶이지 않기 때문이다
export function reservedFor(branch: string, reserved: ReservedMigrations[], openByBranch: Map<string, Migration[]>): ReservedMigrations[] {
  const kept: ReservedMigrations[] = []
  for (const r of reserved) {
    if (r.branch === branch) continue
    const opened = openByBranch.get(r.branch) ?? []
    const migrations = r.migrations.filter((m) => !opened.some((o) => sameVersion(o, m)))
    if (migrations.length > 0) kept.push({ branch: r.branch, migrations })
  }
  return kept
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
