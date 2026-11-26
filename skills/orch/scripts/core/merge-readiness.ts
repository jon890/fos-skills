// 「머지해도 되나」 의 조건 표와 판단(설계 docs/features/merge-readiness/technical-design.md, ADR-037).
// 관문(orch queue gate), 머지 큐, 루프 자동 머지는 lib/merge-readiness.ts 의 checkReadiness 로 이 판단을 부르고 범위(light, full)만 고른다.
// 루프만 보는 조건(이미 건 HEAD, 리뷰 설정 없음)은 ask.auto 가 있을 때만 켜진다.
// 조건을 더하거나 빼거나 순서를 바꾸는 일은 아래 CONDITIONS 표에서만 한다. 값은 읽지 않는다(ADR-028). 값을 읽는 일은 lib 가 한다.
//
// 판단은 snapshot(PR 하나에 대해 읽은 값의 묶음)을 받아 이유 목록을 낸다. 판단에 필요한 값이 snapshot 에 없으면 그 이름을 need 로 돌려주고,
// lib 는 그 값을 읽어 다시 묻는다. 앞 값에 따라 필요해지는 값(영수증, 인정 커밋, base 마이그레이션)은 앞 값이 들어온 뒤에 need 로 나온다.
// 값에 읽은 시점의 HEAD 가 붙어 있고 판단 대상 HEAD 와 다르면 다른 이유를 모두 버리고 head 이유 하나만 낸다.
// 조회 실패(ok: false)는 그 값을 쓰는 조건 가운데 출력 순서가 가장 앞인 조건 자리에 lookup 이유 하나로 낸다.

import { boardHold, judgeMigrations, judgeReview, maxByModule, migrationOf } from './auto-merge.ts'
import type { Migration, ReviewConfig, ReviewNote } from './auto-merge.ts'
import type { BoardItem } from './board-details.ts'
import { prNumbers } from './board-details.ts'
import { boardWorkerRows } from './board-workers.ts'
import { judgeChecks } from './checks.ts'
import { integrationCandidates, integrationNeeds, integrationProblems } from './integration-evidence.ts'
import type { IntegrationRule } from './integration-evidence.ts'
import { reviewCheckPassed } from './review-checks.ts'

// 조건의 종류. 호출부는 이 값으로 only, skip 을 고르고 머지 큐는 이유의 종류로 보류 방식을 고른다
export type ConditionKind = 'draft' | 'ci' | 'attempted' | 'threads' | 'conflict' | 'review' | 'evidence' | 'migration' | 'private' | 'hold'
// 이유의 종류. 조건의 종류에 mergeable(충돌 판정 불가), lookup(조회 실패), head(판단 중 HEAD 변경)를 더한다
export type ReasonKind = ConditionKind | 'mergeable' | 'lookup' | 'head'
// ready 는 「준비됨을 알려도 되나」, merge 는 「지금 머지해도 되나」 단계다. merge 단계에서 막는 조건은 ready 단계 조건을 모두 포함한다
export type Stage = 'ready' | 'merge'
export type Reason = { code: string; kind: ReasonKind; stage: Stage; text: string; wait?: string }

export type Fact<T> = { ok: true; value: T; head?: string } | { ok: false; error: string; wait?: string }

// snapshot 에 들어가는 값. 뜻과 읽는 곳은 설계의 「snapshot」 표가 소유한다
export type Facts = {
  // 지금 HEAD 의 롤업 행(currentChecks 를 거친 것)
  checks: Record<string, unknown>[]
  // 스레드 명령의 출력(끝 줄바꿈을 뺀 것)
  threads: string
  // gh 의 mergeable. 읽지 못했으면 빈 문자열이다
  mergeable: string
  // 리뷰 체크를 볼 statusCheckRollup
  reviewRollup: unknown
  // 믿는 봇의 영수증 목록이나 봇이 거절한 이유
  receipts: { receipts: ReviewNote[] } | { rejected: string }
  // PR 본문(통합 테스트 기록과 비공개 낱말 검사)
  body: string
  // 통합 테스트 규칙을 볼 바뀐 파일(옛 경로 포함)
  integrationFiles: string[]
  // integrationCandidates 가 고른 커밋 가운데 지금 HEAD 로 인정되는 것
  acceptedCommits: string[]
  // 이 PR 이 더한 파일 경로(마이그레이션)
  files: string[]
  // base 의 마이그레이션 폴더 파일 경로
  baseMigrations: string[]
  // 본문, 댓글, 리뷰에서 찾은 비공개 낱말의 위치 글과 읽지 못한 곳
  privateWords: { findings: string | null; failed: string[] }
  // PR 본문의 머지 보류 이유(비공개 낱말은 위치로 바꾼 것)
  holdBody: string | null
  // 지시서의 머지 보류 이유(비공개 낱말은 위치로 바꾼 것)
  specHold: string | null
  // 보드 항목 목록
  boardItems: BoardItem[]
}
export type FactName = keyof Facts
export type FactValues = { [K in FactName]?: Fact<Facts[K]> }
export type ReadinessPr = { number: number; head: string; base: string; branch: string; draft: boolean }
export type ReadinessSnapshot = { pr: ReadinessPr; facts: FactValues }

// 설정과 명령줄에서 온 판단 기준. lib 가 채운다
export type ReadinessPolicy = {
  required: string[]
  allowFail: string[]
  allowNoChecks: boolean
  review: ReviewConfig | null
  integrationRules: IntegrationRule[]
  migrationDirs: Record<string, string[]>
  // 비공개 낱말 목록이 비지 않았는가
  privateWords: boolean
}

// 호출부마다 다른 지금 동작을 남기는 임시 값(설계 「커밋과 PR 순서」). 뒤 PR 이 하나씩 지운다
export type ReadinessCompat = {
  // draft 조건을 보지 않는다(PR5 가 지운다)
  noDraft?: boolean
  // 보드 보류를 보지 않고, 지시서 보류가 있으면 본문 보류를 내지 않는다(PR5)
  oldHolds?: boolean
  // 체크 대기 뒤라 실패한 체크만 본다(PR6)
  checksAfterWait?: boolean
  // 체크 조회 중의 HEAD 변경을 code head-checks 로 따로 낸다. 머지 큐가 다시 시도하지 않는 보류로 다룬다(PR7)
  checkHeadStop?: boolean
  // 리뷰 설정 없음(review-config)을 기능 PR 에만 건다. 기능 PR 인지는 루프가 지시서로 정해 넘긴다(PR7)
  featureOnly?: { feature: boolean }
}

export type ReadinessAsk = {
  scope: 'light' | 'full'
  // 루프가 사람 지시 없이 머지를 걸 때만 준다. attempted 는 이 HEAD 로 이미 걸었는지다
  auto?: { attempted: boolean }
  only?: ConditionKind[]
  skip?: ConditionKind[]
  stopAtFirst?: boolean
  // 체크를 HEAD 별 공유 캐시 없이 읽는다. 판단에는 쓰지 않고 lib 가 읽을 때 본다
  fresh?: boolean
  compat?: ReadinessCompat
}

export type Judged = { reasons: Reason[]; need: FactName[]; notes: string[]; summary: string; basis: string | null }

type Ctx = { pr: ReadinessPr; facts: FactValues; policy: ReadinessPolicy; ask: ReadinessAsk }
type Verdict = { reasons?: Reason[]; notes?: string[]; summary?: string[]; basis?: string }
type Condition = {
  id: string
  kind: ConditionKind
  stage: Stage
  scope: 'light' | 'full'
  // 평가 순서. stopAtFirst 로 물을 때 이 순서로 보고 첫 이유에서 멈춘다
  evaluate: number
  // 출력 순서. 이유를 이 순서로 낸다
  output: number
  active?: (ctx: Ctx) => boolean
  // 지금 snapshot 으로 정해지는 필요한 값. 앞 값이 없거나 실패면 뒤 값을 더하지 않는다
  needs: (ctx: Ctx) => FactName[]
  // 실패해도 lookup 이유를 내지 않고 판단 함수가 스스로 다루는 값
  tolerates?: FactName[]
  judge: (ctx: Ctx) => Verdict
}

function value<K extends FactName>(ctx: Ctx, name: K): Facts[K] | undefined {
  const fact = ctx.facts[name] as Fact<Facts[K]> | undefined
  return fact?.ok ? fact.value : undefined
}

// 앞 값이 들어와 성공했을 때만 뒤 값을 더한다
function chain(ctx: Ctx, names: FactName[], more: () => FactName[]): FactName[] {
  for (const name of names) {
    if (!ctx.facts[name]?.ok) return names
  }
  return [...names, ...more()]
}

function reason(cond: Condition, code: string, text: string, kind: ReasonKind = cond.kind, wait?: string): Reason {
  return wait === undefined ? { code, kind, stage: cond.stage, text } : { code, kind, stage: cond.stage, text, wait }
}

function short(head: string): string {
  return head.slice(0, 8)
}

function migrationsOf(paths: string[], dirs: Record<string, string[]>): Migration[] {
  return paths.flatMap((path) => {
    const found = migrationOf(path, dirs)
    return found ? [found] : []
  })
}

function reviewPassed(ctx: Ctx): string[] {
  const review = ctx.policy.review as ReviewConfig
  return review.checks.filter((name) => reviewCheckPassed(value(ctx, 'reviewRollup'), name))
}

// 조건 표. 순서와 문구는 설계의 「조건 표」 와 같다. 루프만 보는 두 조건은 관문과 머지 큐가 쓰지 않아 출력 순서를 끝에 둔다
export const CONDITIONS: readonly Condition[] = [
  {
    id: 'draft', kind: 'draft', stage: 'ready', scope: 'light', evaluate: 1, output: 1,
    active: (ctx) => !ctx.ask.compat?.noDraft,
    needs: () => [],
    judge(ctx) {
      return ctx.pr.draft ? { reasons: [reason(this, 'draft', 'draft PR 이다', 'draft', 'draft')] } : {}
    },
  },
  {
    id: 'ci', kind: 'ci', stage: 'ready', scope: 'light', evaluate: 2, output: 2,
    needs: () => ['checks'],
    tolerates: ['checks'],
    judge(ctx) {
      const fact = ctx.facts.checks as Fact<Facts['checks']>
      const afterWait = ctx.ask.compat?.checksAfterWait === true
      const checks = fact.ok ? judgeChecks(fact.value, ctx.policy) : null
      const reasons: Reason[] = []
      const failed = checks?.failed.length
      if (!fact.ok) reasons.push(reason(this, 'lookup', fact.error, 'lookup', fact.wait))
      else if (failed !== 0) reasons.push(reason(this, 'ci-failed', `실패한 체크 ${failed} 개`, 'ci', 'CI failed'))
      if (!afterWait) {
        const pending = checks?.pending
        const missing = checks?.missing.length
        if (pending !== 0 || missing !== 0) {
          const names = missing ? checks?.missing.join(', ') : ''
          reasons.push(reason(this, 'ci-pending', `체크가 아직 끝나지 않았다(진행 중 ${pending ?? '?'}, 나타나지 않은 필수 체크 ${names || missing?.toString() || '?'})`, 'ci', 'CI pending'))
        } else if (failed === 0 && checks?.none && !ctx.policy.allowNoChecks) {
          reasons.push(reason(this, 'ci-none', 'PR 에 CI 체크가 하나도 없다', 'ci', 'CI pending'))
        }
      }
      return { reasons, summary: [`fails=${failed ?? ''}`] }
    },
  },
  {
    id: 'attempted', kind: 'attempted', stage: 'merge', scope: 'light', evaluate: 3, output: 12,
    active: (ctx) => ctx.ask.auto !== undefined,
    needs: () => [],
    judge(ctx) {
      return ctx.ask.auto?.attempted ? { reasons: [reason(this, 'attempted', '이미 건 HEAD', 'attempted', '이미 건 HEAD')] } : {}
    },
  },
  {
    id: 'hold-spec', kind: 'hold', stage: 'merge', scope: 'light', evaluate: 4, output: 9,
    needs: () => ['specHold'],
    judge(ctx) {
      const hold = value(ctx, 'specHold')
      return hold ? { reasons: [reason(this, 'hold-spec', hold, 'hold', `지시서 보류: ${hold}`)] } : {}
    },
  },
  {
    id: 'hold-board', kind: 'hold', stage: 'merge', scope: 'light', evaluate: 5, output: 11,
    active: (ctx) => !ctx.ask.compat?.oldHolds,
    needs: () => ['boardItems'],
    judge(ctx) {
      const items = value(ctx, 'boardItems') ?? []
      const ids = new Set(matchBoardItems(items, String(ctx.pr.number), ctx.pr.branch, null)?.ids ?? [])
      for (const item of items) {
        const found = ids.has(boardId(item)) ? boardHold(item) : null
        if (found !== null) return { reasons: [reason(this, 'hold-board', `보드 보류: ${found}`, 'hold', `보드 보류: ${found}`)] }
      }
      return {}
    },
  },
  {
    id: 'threads', kind: 'threads', stage: 'ready', scope: 'light', evaluate: 6, output: 3,
    needs: () => ['threads'],
    judge(ctx) {
      const count = value(ctx, 'threads') as string
      const reasons = count === '0' ? [] : [reason(this, 'threads', `미해결 리뷰 스레드 ${count} 개`, 'threads', `미해결 스레드 ${count}`)]
      return { reasons, summary: [`threads=${count}`] }
    },
  },
  {
    id: 'hold-body', kind: 'hold', stage: 'merge', scope: 'light', evaluate: 7, output: 10,
    // 지금은 지시서 보류가 있으면 본문 보류를 내지 않는다. 그래도 본문은 읽고, 읽지 못하면 멈춘다
    needs: (ctx) => (ctx.ask.compat?.oldHolds ? ['holdBody', 'specHold'] : ['holdBody']),
    judge(ctx) {
      if (ctx.ask.compat?.oldHolds && value(ctx, 'specHold')) return {}
      const hold = value(ctx, 'holdBody')
      return hold ? { reasons: [reason(this, 'hold-body', hold, 'hold', `PR 본문 보류: ${hold}`)] } : {}
    },
  },
  {
    // 리뷰 설정이 없으면 루프가 스스로 걸지 않는다. PR7 전까지는 기능 PR 에만 건다(compat featureOnly)
    id: 'review-config', kind: 'review', stage: 'merge', scope: 'light', evaluate: 8, output: 13,
    active: (ctx) => ctx.ask.auto !== undefined && ctx.policy.review === null && (ctx.ask.compat?.featureOnly?.feature ?? true),
    needs: () => [],
    judge() {
      const text = '기능 자동 머지는 queue.auto_review 의 trusted_bots 나 review_checks 가 필요하다'
      return { reasons: [reason(this, 'review-config', text, 'review', text)] }
    },
  },
  {
    id: 'review', kind: 'review', stage: 'ready', scope: 'light', evaluate: 9, output: 5,
    active: (ctx) => ctx.policy.review !== null,
    needs: (ctx) => chain(ctx, ['reviewRollup'], () => (ctx.policy.review?.trustedBots && reviewPassed(ctx).length === 0 ? ['receipts'] : [])),
    judge(ctx) {
      const review = ctx.policy.review as ReviewConfig
      const passedChecks = reviewPassed(ctx)
      const got = value(ctx, 'receipts')
      if (got && 'rejected' in got) return { reasons: [reason(this, 'review-wait', got.rejected, 'review', got.rejected)] }
      const judged = judgeReview({ receipts: got?.receipts ?? [], passedChecks }, review)
      if (judged.ok) return { basis: judged.basis.join('; ') }
      const sources = [
        ...(review.trustedBots ? ['현재 HEAD 를 확인한 봇 영수증'] : []),
        ...(review.checks.length > 0 ? [`리뷰 체크(${review.checks.join(', ')}) 성공`] : []),
      ]
      const text = `HEAD ${short(ctx.pr.head)} 에 ${sources.join('이나 ')}이 없다`
      return { reasons: [reason(this, 'review-missing', text, 'review', text)] }
    },
  },
  {
    id: 'migration', kind: 'migration', stage: 'ready', scope: 'light', evaluate: 10, output: 7,
    active: (ctx) => Object.keys(ctx.policy.migrationDirs).length > 0,
    needs: (ctx) => chain(ctx, ['files'], () => (migrationsOf(value(ctx, 'files') ?? [], ctx.policy.migrationDirs).length > 0 ? ['baseMigrations'] : [])),
    judge(ctx) {
      const dirs = ctx.policy.migrationDirs
      const mine = migrationsOf(value(ctx, 'files') ?? [], dirs)
      if (mine.length === 0) return {}
      const base = maxByModule(value(ctx, 'baseMigrations') ?? [], dirs)
      return {
        reasons: judgeMigrations(ctx.pr.number, mine, base, []).clashes.map((clash) => reason(this, 'migration',
          `${clash.module} ${clash.label}: ${clash.reason}. 기존 예약 인자로 orch queue reserve ... --again 을 실행해 새 번호를 받고 파일을 고친다`)),
      }
    },
  },
  {
    id: 'conflict', kind: 'conflict', stage: 'ready', scope: 'full', evaluate: 11, output: 4,
    needs: () => ['mergeable'],
    judge(ctx) {
      const m = value(ctx, 'mergeable') ?? ''
      const reasons = m === 'CONFLICTING' ? [reason(this, 'conflict', `base(${ctx.pr.base}) 와 충돌한다(mergeable=CONFLICTING)`)]
        : m !== 'MERGEABLE' ? [reason(this, 'mergeable', `mergeable=${m || '조회 실패'}`, 'mergeable')] : []
      return { reasons, summary: [`mergeable=${m}`] }
    },
  },
  {
    id: 'evidence', kind: 'evidence', stage: 'ready', scope: 'full', evaluate: 12, output: 6,
    // 본문은 규칙이 없어도 읽는다. 읽는 사이 HEAD 가 바뀌었는지도 이 값으로 본다
    needs: (ctx) => chain(ctx, ['body'], () => {
      const rules = ctx.policy.integrationRules
      if (rules.length === 0) return []
      return chain(ctx, ['integrationFiles'], () => (evidenceCandidates(ctx).length > 0 ? ['acceptedCommits'] : []))
    }),
    judge(ctx) {
      const rules = ctx.policy.integrationRules
      if (rules.length === 0) return {}
      const accepted = new Set(value(ctx, 'acceptedCommits') ?? [])
      const needs = integrationNeeds(value(ctx, 'integrationFiles') ?? [], rules)
      const judged = integrationProblems(value(ctx, 'body') ?? '', ctx.pr.head, needs, (commit) => accepted.has(commit))
      return { reasons: judged.reasons.map((text) => reason(this, 'evidence', text)), notes: judged.notes }
    },
  },
  {
    id: 'private', kind: 'private', stage: 'ready', scope: 'full', evaluate: 13, output: 8,
    active: (ctx) => ctx.policy.privateWords,
    // 본문은 있으면 함께 본다. 읽지 못했으면 댓글만 본다(본문의 조회 실패는 evidence 자리에 한 번 낸다)
    needs: () => ['body', 'privateWords'],
    tolerates: ['body'],
    judge(ctx) {
      const found = value(ctx, 'privateWords') as Facts['privateWords']
      const reasons: Reason[] = []
      if (found.findings !== null) reasons.push(reason(this, 'private', `비공개 낱말 목록의 낱말이 있다(값은 보이지 않는다): ${found.findings}. 그 글을 고친 뒤 다시 건다`))
      if (found.failed.length > 0) reasons.push(reason(this, 'lookup', `비공개 낱말 검사: ${found.failed.join(', ')} 조회 실패`, 'lookup'))
      return { reasons }
    },
  },
]

function evidenceCandidates(ctx: Ctx): string[] {
  const needs = integrationNeeds(value(ctx, 'integrationFiles') ?? [], ctx.policy.integrationRules)
  return integrationCandidates(value(ctx, 'body') ?? '', ctx.pr.head, needs)
}

// acceptedCommits 를 읽을 때 확인할 커밋. lib 가 이 커밋만 git 으로 확인한다
export function acceptedCandidates(snapshot: ReadinessSnapshot, policy: ReadinessPolicy): string[] {
  return evidenceCandidates({ pr: snapshot.pr, facts: snapshot.facts, policy, ask: { scope: 'full' } })
}

// 값마다 HEAD 가 바뀌었을 때의 문구. 지금 문구를 값마다 그대로 둔다. 하나로 모으는 일은 PR7 이 한다
function headText(name: FactName, pr: ReadinessPr, now: string): string {
  if (name === 'checks') return `체크 조회 중 HEAD 가 바뀌었다 checked=${pr.head} now=${now || '?'}`
  if (name === 'reviewRollup') return '리뷰 조회 중 HEAD 가 바뀌었다'
  if (name === 'files') return '마이그레이션 검사 중 HEAD 가 바뀌었다'
  if (name === 'body') return `검사 뒤 HEAD 가 바뀌었다 checked=${short(pr.head)} now=${short(now)}`
  return `검사 중 HEAD 가 바뀌었다 checked=${short(pr.head)} now=${short(now)}`
}

// 읽은 HEAD 가 판단 대상과 다른 값. 없으면 null
export function changedHead(snapshot: ReadinessSnapshot, ask: ReadinessAsk = { scope: 'full' }): Reason | null {
  for (const [name, fact] of Object.entries(snapshot.facts) as [FactName, Fact<unknown> | undefined][]) {
    if (!fact?.ok || fact.head === undefined || fact.head === snapshot.pr.head) continue
    const code = name === 'checks' && ask.compat?.checkHeadStop ? 'head-checks' : 'head'
    return { code, kind: 'head', stage: 'ready', text: headText(name, snapshot.pr, fact.head), wait: 'HEAD 가 바뀌었다' }
  }
  return null
}

function inAsk(cond: Condition, ctx: Ctx): boolean {
  const { ask } = ctx
  if (ask.scope === 'light' && cond.scope === 'full') return false
  if (ask.only && !ask.only.includes(cond.kind)) return false
  if (ask.skip?.includes(cond.kind)) return false
  return cond.active ? cond.active(ctx) : true
}

// 조건 표를 돈다. need 가 비지 않으면 그 값을 읽어 다시 묻는다
export function judgeReadiness(snapshot: ReadinessSnapshot, policy: ReadinessPolicy, ask: ReadinessAsk): Judged {
  const ctx: Ctx = { pr: snapshot.pr, facts: snapshot.facts, policy, ask }
  const head = changedHead(snapshot, ask)
  if (head) return { reasons: [head], need: [], notes: [], summary: '', basis: null }
  const conditions = CONDITIONS.filter((cond) => inAsk(cond, ctx)).sort((a, b) => a.evaluate - b.evaluate)
  const need: FactName[] = []
  const found: { output: number; reason: Reason }[] = []
  const lookups = new Map<FactName, { output: number; reason: Reason }>()
  const notes: { output: number; note: string }[] = []
  const summary: { output: number; fact: string }[] = []
  let basis: string | null = null
  for (const cond of conditions) {
    const wanted = cond.needs(ctx)
    const missing = wanted.filter((name) => ctx.facts[name] === undefined)
    if (missing.length > 0) {
      for (const name of missing) if (!need.includes(name)) need.push(name)
      if (ask.stopAtFirst) break
      continue
    }
    const failed = wanted.filter((name) => ctx.facts[name]?.ok === false && !cond.tolerates?.includes(name))
    if (failed.length > 0) {
      for (const name of failed) {
        const fact = ctx.facts[name] as { ok: false; error: string; wait?: string }
        const before = lookups.get(name)
        if (!before || before.output > cond.output) lookups.set(name, { output: cond.output, reason: reason(cond, 'lookup', fact.error, 'lookup', fact.wait) })
      }
      if (ask.stopAtFirst) break
      continue
    }
    const verdict = cond.judge(ctx)
    for (const r of verdict.reasons ?? []) found.push({ output: cond.output, reason: r })
    for (const note of verdict.notes ?? []) notes.push({ output: cond.output, note })
    for (const fact of verdict.summary ?? []) summary.push({ output: cond.output, fact })
    if (verdict.basis !== undefined) basis = verdict.basis
    if (ask.stopAtFirst && (verdict.reasons?.length ?? 0) > 0) break
  }
  for (const { output, reason: r } of lookups.values()) found.push({ output, reason: r })
  // 같은 조건 안에서는 판단 함수가 낸 순서다(체크 조회 실패는 진행 중 줄 앞, 비공개 낱말의 댓글 조회 실패는 찾은 위치 뒤)
  const byOutput = <T extends { output: number }>(rows: T[]): T[] => rows.map((row, i) => ({ row, i })).sort((a, b) => a.row.output - b.row.output || a.i - b.i).map(({ row }) => row)
  const reasons = byOutput(found).map((row) => row.reason)
  return {
    reasons,
    need,
    notes: byOutput(notes).map((row) => row.note),
    summary: byOutput(summary).map((row) => row.fact).join(' '),
    basis,
  }
}

// ready 단계 이유가 있으면 「준비됨」 을 알리지 않는다
export function blocksReady(readiness: { reasons: Reason[] }): boolean {
  return readiness.reasons.some((r) => r.stage === 'ready')
}

// 이유가 하나라도 있으면 지금 머지하지 않는다
export function blocksMerge(readiness: { reasons: Reason[] }): boolean {
  return readiness.reasons.length > 0
}

// rows 는 브랜치로 찾은 항목 가운데 worker 줄로 찾은 것의 항목 id → 그 줄의 워크트리다. 줄로 찾은 항목이 없으면 이 칸이 없다
export type BoardMatch = { by: 'pr' | 'branch'; ids: string[]; rows?: Record<string, string> }

function boardId(item: BoardItem): string {
  return typeof item.id === 'string' ? item.id : JSON.stringify(item.id)
}

// 그 PR 의 보드 항목. 규칙은 lib/board.ts 의 findBoardItems 머리 주석이 설명한다. 이미 읽은 항목 목록을 받는다
export function matchBoardItems(all: readonly BoardItem[], pr: string, branch: string, worktree: string | null): BoardMatch | null {
  const items = all.filter((i) => typeof i === 'object' && i !== null && !Array.isArray(i) && Boolean(i.id))
  // pr 칸에 들었거나 구현·후속 줄의 pr 이 그 PR 인 항목(리뷰·검증 줄의 pr 은 대상 PR 이라 보지 않는다). 줄만 저장된 부분 실패 뒤 다시 돌려도 찾는다
  const byPr = items.filter((i) => prNumbers(i.pr).has(pr) || boardWorkerRows(i).some((one) => (one.role === 'impl' || one.role === 'follow') && prNumbers(one.pr).has(pr)))
  if (byPr.length > 0) return { by: 'pr', ids: byPr.map(boardId) }
  const open = (i: BoardItem) => i.status !== 'done' && !prNumbers(i['merged-pr']).has(pr)
  const byBranch = items.filter(
    (i) =>
      prNumbers(i.pr).size === 0 &&
      open(i) &&
      ((branch && i.branch === branch) || (worktree && i.worktree === worktree)),
  )
  // 일치하는 구현·후속 줄(pr 이 빔)이 있으면 그 줄의 워크트리를 rows 에 담는다. 항목을 대표 칸으로 찾았어도 같다
  const rows: Record<string, string> = {}
  const rowOf = (i: BoardItem) => boardWorkerRows(i)
    .filter((one) => (one.role === 'impl' || one.role === 'follow') && prNumbers(one.pr).size === 0 &&
      ((branch && one.branch === branch) || (worktree && one.worktree === worktree)))
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''))).at(-1)
  const byRow = items.filter((i) => open(i) && !byBranch.includes(i) && rowOf(i) !== undefined)
  for (const i of [...byBranch, ...byRow]) {
    const row = rowOf(i)
    if (row) rows[boardId(i)] = row.worktree
  }
  const ids = [...byBranch, ...byRow].map(boardId)
  return ids.length > 0 ? { by: 'branch', ids, ...(Object.keys(rows).length > 0 ? { rows } : {}) } : null
}
