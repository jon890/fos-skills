// 자동 머지와 gate 가 같은 리뷰 범위와 조건을 쓴다.
import { isObject } from '../core/json.ts'
import { judgeReview, reviewScope } from './auto-merge.ts'
import type { ChainCommit, ReviewConfig, ReviewNote, ReviewJudgement } from './auto-merge.ts'
import { git } from './git.ts'

const REVIEW_CHAIN_LIMIT = 50

function reviewNotes(rows: unknown, at: string): ReviewNote[] {
  if (!Array.isArray(rows)) return []
  return rows.filter(isObject).map((row) => {
    const commit = isObject(row.commit) && typeof row.commit.oid === 'string' && row.commit.oid ? row.commit.oid : null
    return { body: typeof row.body === 'string' ? row.body : '', at: typeof row[at] === 'string' ? row[at] as string : '', commit }
  })
}

// 기능 PR 이면 저장소의 require 와 상관없이 verdict-on-head 를 더한다. 저장소가 queue.auto_review.feature_head 를 false 로 두면 더하지 않는다
export function featureReviewRule(review: ReviewConfig, feature: boolean): ReviewConfig {
  if (!feature || review.featureHead === false) return review
  return { ...review, require: [...new Set(['verdict-on-head' as const, ...review.require])] }
}

export function judgePrReview(repo: string, pr: { head: string; branch: string; base: string }, data: { reviews?: unknown; comments?: unknown }, review: ReviewConfig, feature: boolean): ReviewJudgement {
  git(repo, ['fetch', '--quiet', 'origin', pr.branch, pr.base])
  const listed = git(repo, ['log', '--first-parent', `--max-count=${REVIEW_CHAIN_LIMIT}`, '--format=%H%x09%P%x09%cI', pr.head, '--'])
  const chain: ChainCommit[] = listed.code === 0 ? listed.stdout.trim().split('\n').filter(Boolean).map((row) => {
    const [oid, parents, at] = row.split('\t')
    return { oid, parents: parents ? parents.split(' ') : [], at: at ?? '' }
  }) : []
  const scope = reviewScope(pr.head, chain, (oid) => git(repo, ['merge-base', '--is-ancestor', oid, `origin/${pr.base}`]).code === 0)
  const rule = featureReviewRule(review, feature)
  return judgeReview({ notes: [...reviewNotes(data.reviews, 'submittedAt'), ...reviewNotes(data.comments, 'createdAt')], scope, chain }, rule)
}
