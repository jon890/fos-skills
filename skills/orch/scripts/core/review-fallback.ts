// 리뷰 봇이 실행 장애로 실패했을 때 루프가 거는 대체 리뷰의 판정과 지시서 채우기다. 읽기, 기록, 띄우기는 loop/steps/review-fallback.ts 가 한다.
//
// 장애(reviewOutage): 지금 HEAD 의 롤업에서 이름이 check 인 체크 실행이 실패로 끝났고, 시작(startedAt)부터 끝(completedAt)까지
//     failWithinSec 초 안이면 장애다. 모델을 부르지 않고 몇 초 만에 끝난 실패(인증, 사용량 한도, 봇 설정 오류)를 가려낸다.
//     리뷰를 마친 뒤 지적이 있어 실패로 끝난 것은 보통 몇 분이 걸려 기준을 넘는다. 시각이 없거나 읽지 못하면 장애로 보지 않는다.
//     같은 이름이 여럿이면 가장 늦게 시작한 것만 본다(lib/gh.ts 의 currentChecks 와 같다. 다시 돌린 실행이 앞 실패를 가린다).
//
// 도는 중(reviewRunning): 같은 규칙으로 고른 마지막 실행이 아직 끝나지 않았다(CheckRun 의 conclusion 이 비었고 status 가 COMPLETED 가 아니거나 StatusContext 의 state 가
//     PENDING, EXPECTED). 체크가 없으면 도는 중이 아니다. 최신화가 이 동안 HEAD 를 옮기지 않게 한다(loop/steps/refresh.ts 머리 주석의 「최신화」).
//     리뷰 봇은 Ready 때만 돌아, 끝나기 전에 HEAD 가 바뀌면 새 HEAD 에는 리뷰 체크가 없어 장애를 판정하지 못한다.
//
// 판정 있음(verdictSince): since 이후에 달린 본문 가운데 pass 나 block 문구가 든 것이 있다. 대체 리뷰 worker 가 단 판정을 찾는다.
//
// 지시서(fallbackSpec): `orch spec review` 가 만든 리뷰 지시서에서 코디네이터가 채울 자리 둘을 채우고, 「완료 기준」 앞에
//     「판정 댓글」 절을 넣는다. 그 절은 리뷰를 등록한 뒤 첫 줄이 pass_text 나 block_text 인 댓글을 하나 더 달게 한다.
//     자동 머지(core/auto-merge.ts 의 judgeReview)가 그 댓글을 리뷰 판정으로 읽는다. 지금 코디네이터가 독립 리뷰 뒤 다는 판정 댓글과 같은 모양이다.
//     허락 줄에 판정 댓글 하나를 허락하는 문장을 덧붙인다. 설정(queue.auto_review.fallback)을 둔 것이 그 허락이다.

import { verdicts } from './auto-merge.ts'
import type { ReviewFallback, ReviewNote, ReviewRule } from './auto-merge.ts'

export type Outage = { check: string; sec: number; url: string | null }

function field(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' ? value : null
}

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR'])

const started = (row: Record<string, unknown>) => Date.parse(field(row, 'startedAt') ?? '')

// 이름이 check 인 체크 가운데 가장 늦게 시작한 것. 없으면 null 이다. StatusContext 는 이름이 context 에 있다
function latestRun(rollup: unknown, check: string): Record<string, unknown> | null {
  if (!Array.isArray(rollup)) return null
  const rows = rollup.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && (field(row as Record<string, unknown>, 'name') ?? field(row as Record<string, unknown>, 'context')) === check)
  return rows.reduce<Record<string, unknown> | null>((best, row) => (best === null || started(row) > started(best) ? row : best), null)
}

// 머리 주석의 「장애」. 장애가 아니면 null 이다
export function reviewOutage(rollup: unknown, check: string, failWithinSec: number): Outage | null {
  const latest = latestRun(rollup, check)
  if (!latest || !FAILED.has(field(latest, 'conclusion') ?? '')) return null
  const sec = (Date.parse(field(latest, 'completedAt') ?? '') - started(latest)) / 1000
  if (!Number.isFinite(sec) || sec < 0 || sec > failWithinSec) return null
  return { check, sec: Math.round(sec), url: field(latest, 'detailsUrl') }
}

// 머리 주석의 「도는 중」
export function reviewRunning(rollup: unknown, check: string): boolean {
  const latest = latestRun(rollup, check)
  if (!latest) return false
  const state = field(latest, 'state')
  if (state !== null) return state === 'PENDING' || state === 'EXPECTED'
  return !field(latest, 'conclusion') && field(latest, 'status') !== 'COMPLETED'
}

// 머리 주석의 「판정 있음」. 시각을 읽지 못한 본문은 세지 않는다
export function verdictSince(notes: ReviewNote[], since: string, rule: ReviewRule): boolean {
  const from = Date.parse(since)
  if (Number.isNaN(from)) return false
  return verdicts(notes, rule).some((v) => {
    const at = Date.parse(v.note.at)
    return !Number.isNaN(at) && at >= from
  })
}

const PLACEHOLDER = /\{\{채울 것:[^}]*\}\}/

// 머리 주석의 「지시서」. 자리나 절을 찾지 못하면 Error 다. 틀이 바뀐 것을 모른 채 판정 댓글 없는 리뷰를 띄우지 않으려는 것이다
export function fallbackSpec(text: string, opts: { pr: number; head: string; outage: Outage; fallback: ReviewFallback }): string {
  const { pr, head, outage, fallback } = opts
  const background = `리뷰 봇 \`${outage.check}\` 이 HEAD ${head.slice(0, 8)} 에서 시작 ${outage.sec}초 만에 실패했다(실행 장애로 본다${outage.url ? `, ${outage.url}` : ''}). 상주 루프가 그 대신 띄운 리뷰다`
  const focus = '변경 전체. 리뷰 봇이 이 HEAD 를 보지 못했으므로 범위를 좁히지 않는다'
  let out = text
  for (const fill of [background, focus]) {
    if (!PLACEHOLDER.test(out)) throw new Error('리뷰 지시서에 채울 자리가 둘 없다')
    out = out.replace(PLACEHOLDER, fill)
  }
  const permit = /^(허락: .*)$/m
  if (!permit.test(out)) throw new Error('리뷰 지시서에 허락 줄이 없다')
  out = out.replace(permit, `$1 PR #${pr} 에 판정 댓글 하나를 다는 것도 허락했다(설정 queue.auto_review.fallback).`)
  const done = out.search(/^## 완료 기준/m)
  if (done < 0) throw new Error('리뷰 지시서에 「완료 기준」 절이 없다')
  const section = [
    '## 판정 댓글',
    '',
    `리뷰를 등록한 뒤 PR #${pr} 에 댓글 하나를 더 단다. 첫 줄은 차단(P1, P2)이 0건이면 \`${fallback.passText}\`, 1건 이상이면 \`${fallback.blockText}\` 이고 다른 말을 붙이지 않는다.`,
    '둘째 줄부터 차단과 권장 건수, 등록한 리뷰 링크를 적는다. 상주 루프의 자동 머지가 이 댓글을 리뷰 판정으로 읽는다.',
    '',
  ].join('\n')
  return `${out.slice(0, done)}${section}\n${out.slice(done)}`
}
