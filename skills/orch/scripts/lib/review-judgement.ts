// 자동 머지와 gate 가 같은 리뷰 판정을 쓴다. 판정 규칙은 core/auto-merge.ts 머리 주석의 「judgeReview」 가 소유한다.
import { judgeReview } from './auto-merge.ts'
import type { ReviewConfig, ReviewJudgement, ReviewNote } from './auto-merge.ts'
import { reviewCheckPassed } from '../core/review-checks.ts'
import { loadTrustedBotReviews } from './review-bot.ts'
import type { ReviewTarget } from './review-bot.ts'

// data.statusCheckRollup 은 gh pr view --json statusCheckRollup 의 값이다. 그 PR 의 지금 HEAD 체크다
export function judgePrReview(repo: string, pr: { head: string; target?: ReviewTarget }, data: { statusCheckRollup?: unknown }, review: ReviewConfig): ReviewJudgement {
  // 리뷰 체크를 먼저 본다. 둘 중 하나면 통과라 리뷰 체크가 success 면 봇 조회의 실패나 지적과 상관없이 통과한다(PR 619 리뷰).
  // 봇이 연 미해결 줄 댓글은 관문의 미해결 리뷰 스레드 검사가 따로 막는다
  const passedChecks = review.checks.filter((name) => reviewCheckPassed(data.statusCheckRollup, name))
  let receipts: ReviewNote[] = []
  if (review.trustedBots && passedChecks.length === 0) {
    if (!pr.target) return { ok: false, wait: '믿는 리뷰 봇의 결과를 조회할 PR 정보가 없다', missing: false }
    const trusted = loadTrustedBotReviews(repo, pr.target, pr.head, review.trustedBots)
    if (!trusted.ok) return { ok: false, wait: trusted.wait, missing: false }
    receipts = trusted.receipts
  }
  const judged = judgeReview({ receipts, passedChecks }, review)
  if (judged.ok) return judged
  const sources = [
    ...(review.trustedBots ? ['현재 HEAD 를 확인한 봇 영수증'] : []),
    ...(review.checks.length > 0 ? [`리뷰 체크(${review.checks.join(', ')}) 성공`] : []),
  ]
  return { ...judged, wait: `HEAD ${pr.head.slice(0, 8)} 에 ${sources.join('이나 ')}이 없다` }
}
