import type { ReviewNote, TrustedReviewBot } from '../core/auto-merge.ts'
import { isObject } from '../core/json.ts'
import { ghJson } from './gh.ts'

export type ReviewTarget = { host: string; slug: string; number: string | number }
type Actor = { __typename: string; login: string } | null
type Comment = { author: Actor; body: string; createdAt: string }
type Review = { author: Actor; body: string; submittedAt: string | null; state: string; commit: { oid: string } | null }
type Thread = { isResolved: boolean; comments: { nodes: Pick<Comment, 'author' | 'createdAt'>[] } }
export type BotReviewData = { comments: Comment[]; reviews: Review[]; reviewThreads: Thread[] }
type Connection = keyof BotReviewData
type TrustedReview = { ok: true; receipts: ReviewNote[] } | { ok: false; wait: string }

const CONNECTIONS = ['comments', 'reviews', 'reviewThreads'] as const
const REVIEW_LOOKUP_FAILURE = '믿는 리뷰 봇의 댓글, 리뷰 또는 줄 댓글 스레드를 읽지 못했다'
const QUERY = `
query($owner:String!, $repo:String!, $number:Int!,
    $readComments:Boolean!, $readReviews:Boolean!, $readThreads:Boolean!,
    $commentsAfter:String, $reviewsAfter:String, $threadsAfter:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      headRefOid
      comments(first:50, after:$commentsAfter) @include(if:$readComments) {
        pageInfo { hasNextPage endCursor }
        nodes { author { __typename login } body createdAt }
      }
      reviews(first:50, after:$reviewsAfter) @include(if:$readReviews) {
        pageInfo { hasNextPage endCursor }
        nodes { author { __typename login } body submittedAt state commit { oid } }
      }
      reviewThreads(first:50, after:$threadsAfter) @include(if:$readThreads) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first:1) { nodes { author { __typename login } createdAt } } }
      }
    }
  }
}`

// gh pr view 는 봇 login 에서 [bot] 을 빼고 계정 종류도 내보내지 않는다.
// GraphQL 에서 계정 종류와 줄 댓글의 해결 여부를 읽고, 모든 페이지를 다 읽어야 판정한다.
export function loadTrustedBotReviews(repo: string, target: ReviewTarget, head: string, bots: readonly TrustedReviewBot[]): TrustedReview {
  const [owner, name] = target.slug.split('/')
  const args = ['api', 'graphql', '--hostname', target.host, '-f', `query=${QUERY}`,
    '-f', `owner=${owner}`, '-f', `repo=${name}`, '-F', `number=${target.number}`]
  const rows: Record<Connection, unknown[]> = { comments: [], reviews: [], reviewThreads: [] }
  const cursors = new Map<Connection, string | null>(CONNECTIONS.map((key) => [key, null]))
  while (cursors.size > 0) {
    const pageArgs = [...args,
      '-F', `readComments=${cursors.has('comments')}`, '-F', `readReviews=${cursors.has('reviews')}`,
      '-F', `readThreads=${cursors.has('reviewThreads')}`]
    for (const [key, field] of [['comments', 'commentsAfter'], ['reviews', 'reviewsAfter'], ['reviewThreads', 'threadsAfter']] as const) {
      const cursor = cursors.get(key)
      if (cursor) pageArgs.push('-f', `${field}=${cursor}`)
    }
    const got = ghJson<{ data?: { repository?: { pullRequest?: Record<string, unknown> } } }>(pageArgs, { cwd: repo, cache: false })
    const pr = got.ok ? got.data?.data?.repository?.pullRequest : undefined
    if (!pr) return { ok: false, wait: REVIEW_LOOKUP_FAILURE }
    if (pr.headRefOid !== head) return { ok: false, wait: '믿는 리뷰 봇의 결과를 조회하는 동안 PR HEAD 가 바뀌었다' }
    for (const [key, previous] of cursors) {
      const page = pr[key]
      if (!isObject(page) || !Array.isArray(page.nodes) || !page.nodes.every(isObject) || !isObject(page.pageInfo)) {
        return { ok: false, wait: REVIEW_LOOKUP_FAILURE }
      }
      const { hasNextPage, endCursor } = page.pageInfo
      if (hasNextPage === true && typeof endCursor === 'string' && endCursor && endCursor !== previous) cursors.set(key, endCursor)
      else if (hasNextPage === false) cursors.delete(key)
      else return { ok: false, wait: REVIEW_LOOKUP_FAILURE }
      rows[key].push(...page.nodes)
    }
  }
  return judgeTrustedBotReviews(head, rows as BotReviewData, bots)
}

function fromBot(author: Actor, bot: TrustedReviewBot): boolean {
  return author?.__typename === 'Bot' && author.login.toLowerCase() === bot.login
}

function receiptCommit(body: string, bot: TrustedReviewBot): string | null {
  if (!body.split(/\r?\n/).some((line) => line.trim() === bot.receiptMarker)) return null
  const commits = new Set(Array.from(body.matchAll(bot.reviewedCommit), (match) => match[1]?.toLowerCase()))
  const [commit] = commits
  return commits.size === 1 && commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit : null
}

export function judgeTrustedBotReviews(head: string, data: BotReviewData, bots: readonly TrustedReviewBot[]): TrustedReview {
  const receipts: ReviewNote[] = []
  for (const bot of bots) {
    let latestFinding = -Infinity
    const foundAt = (at: string | null) => {
      const time = Date.parse(at ?? '')
      latestFinding = Math.max(latestFinding, Number.isFinite(time) ? time : Infinity)
    }
    const candidate: ReviewNote[] = []
    const addReceipt = (commit: string | null, at: string | null) => {
      if (commit && head.toLowerCase().startsWith(commit) && at && Number.isFinite(Date.parse(at))) {
        candidate.push({ body: '', at, commit: head, receiptBot: bot.login })
      }
    }
    for (const thread of data.reviewThreads) {
      const first = thread.comments.nodes[0]
      if (!first || !fromBot(first.author, bot)) continue
      if (!thread.isResolved) return { ok: false, wait: `${bot.login} 봇의 미해결 줄 댓글 스레드가 있다` }
      foundAt(first.createdAt)
    }
    for (const review of data.reviews) {
      if (!fromBot(review.author, bot) || review.state === 'PENDING' || review.state === 'DISMISSED') continue
      const commit = receiptCommit(review.body, bot)
      const matchesReview = commit && review.commit?.oid.toLowerCase().startsWith(commit)
      if (review.state === 'CHANGES_REQUESTED' || (review.state === 'COMMENTED' && !matchesReview)) {
        foundAt(review.submittedAt)
      } else if (matchesReview) {
        addReceipt(commit, review.submittedAt)
      }
    }
    for (const comment of data.comments) {
      if (fromBot(comment.author, bot)) addReceipt(receiptCommit(comment.body, bot), comment.createdAt)
    }
    const current = candidate.filter((receipt) => Date.parse(receipt.at) > latestFinding)
    if (latestFinding > -Infinity && current.length === 0) {
      return { ok: false, wait: `${bot.login} 봇이 지적을 남겼다. 지적을 해결한 뒤 현재 HEAD 의 영수증을 다시 받아야 한다` }
    }
    receipts.push(...current)
  }
  return { ok: true, receipts }
}
