import type { ReviewNote, TrustedReviewBot } from '../core/auto-merge.ts'
import { isObject } from '../core/json.ts'
import { ghJson } from './gh.ts'

export type ReviewTarget = { host: string; slug: string; number: string | number }
type Actor = { __typename: string; login: string } | null
type Comment = { author: Actor; body: string; createdAt: string }
type Review = { author: Actor; body: string; submittedAt: string | null; state: string; commit: { oid: string } | null }
type Thread = { isResolved: boolean; comments: { nodes: (Pick<Comment, 'author' | 'createdAt'> & { body?: string })[] } }
export type BotReviewData = { comments: Comment[]; reviews: Review[]; reviewThreads: Thread[] }
type Connection = keyof BotReviewData
type TrustedReview = { ok: true; receipts: ReviewNote[] } | { ok: false; wait: string }
type BotReviewSnapshot = { ok: true; data: BotReviewData; ready: boolean } | { ok: false; wait: string }

const CONNECTIONS = ['comments', 'reviews', 'reviewThreads'] as const
const REVIEW_LOOKUP_FAILURE = '믿는 리뷰 봇의 댓글, 리뷰 또는 줄 댓글 스레드를 읽지 못했다'
const QUERY = `
query($owner:String!, $repo:String!, $number:Int!,
    $readComments:Boolean!, $readReviews:Boolean!, $readThreads:Boolean!,
    $commentsAfter:String, $reviewsAfter:String, $threadsAfter:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      headRefOid
      state
      isDraft
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
        nodes { isResolved comments(first:1) { nodes { author { __typename login } createdAt body } } }
      }
    }
  }
}`

// gh pr view 는 봇 login 에서 [bot] 을 빼고 계정 종류도 내보내지 않는다.
// GraphQL 에서 계정 종류와 줄 댓글의 해결 여부를 읽고, 모든 페이지를 다 읽어야 판정한다.
export function loadTrustedBotReviews(repo: string, target: ReviewTarget, head: string, bots: readonly TrustedReviewBot[]): TrustedReview {
  const snapshot = loadBotReviewSnapshot(repo, target, head)
  return snapshot.ok ? judgeTrustedBotReviews(head, snapshot.data, bots) : snapshot
}

export function loadBotReviewSnapshot(repo: string, target: ReviewTarget, head: string): BotReviewSnapshot {
  const [owner, name] = target.slug.split('/')
  const args = ['api', 'graphql', '--hostname', target.host, '-f', `query=${QUERY}`,
    '-f', `owner=${owner}`, '-f', `repo=${name}`, '-F', `number=${target.number}`]
  const rows: Record<Connection, unknown[]> = { comments: [], reviews: [], reviewThreads: [] }
  const cursors = new Map<Connection, string | null>(CONNECTIONS.map((key) => [key, null]))
  let ready = true
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
    ready &&= pr.state === 'OPEN' && pr.isDraft === false
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
  return { ok: true, data: rows as BotReviewData, ready }
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

export function hasCurrentBotReceipt(head: string, data: BotReviewData, bot: TrustedReviewBot): boolean {
  const matches = (body: string): boolean => {
    const commit = receiptCommit(body, bot)
    return commit !== null && head.startsWith(commit)
  }
  return data.comments.some((comment) => fromBot(comment.author, bot) && matches(comment.body)) ||
    data.reviews.some((review) => fromBot(review.author, bot) && review.state !== 'PENDING' &&
      review.state !== 'DISMISSED' && review.state !== 'CHANGES_REQUESTED' &&
      review.commit?.oid.toLowerCase() === head && matches(review.body))
}

// Codex 는 한 PR 의 요약 댓글을 갱신한다. 같은 head 의 코드 리뷰 상태만 읽는다.
export function botReviewRunning(head: string, data: BotReviewData, bot: TrustedReviewBot): boolean {
  if (data.reviews.some((review) => fromBot(review.author, bot) && review.state === 'PENDING' && review.commit?.oid === head)) return true
  if (bot.login !== 'chatgpt-codex-connector') return false
  return data.comments.some((comment) => {
    if (!fromBot(comment.author, bot)) return false
    const state = /^<!-- codex-review-state:v1 (.+) -->$/m.exec(comment.body)?.[1]
    if (!state) return false
    try {
      const review = JSON.parse(state)?.code_review
      return review?.commit_sha === head && ['in_progress', 'running', 'pending', 'queued'].includes(review.status)
    } catch {
      return false
    }
  })
}

// 줄 댓글 첫 줄의 등급 배지(![P1 Badge]). 읽지 못하면 null 이다
const BADGE = /!\[P(\d) Badge\]/

// P0·P1·P2 이거나 배지를 읽지 못한 지적은 막는 지적이다(안전한 쪽. 코디네이터 2026-11-26)
function blockingThread(body: string | undefined): boolean {
  const level = BADGE.exec(body ?? '')?.[1]
  return level === undefined || Number(level) <= 2
}

// 봇마다 마지막으로 끝난 리뷰(영수증)를 인정할지 본다(스펙 docs/features/merge-readiness/spec.md 의 DECISION15).
//   - 봇이 연 줄 댓글 스레드가 하나라도 미해결이면 기다린다.
//   - 영수증은 봇의 댓글이나 리뷰에 든 receipt_marker 와 리뷰한 커밋이다. 커밋이 지금 HEAD 가 아니어도 된다.
//   - 마지막 영수증 R 과 같은 시각이거나 그 뒤에 남은 봇의 지적을 본다(Codex 는 리뷰와 줄 댓글을 같은 시각에 단다). R 앞의 지적은 R 이 다시 본 것이다.
//     줄 댓글은 첫 줄 배지로 등급을 읽고, 리뷰 본문의 지적(CHANGES_REQUESTED, 영수증이 맞지 않는 COMMENTED)과 시각을 읽지 못한 지적은 막는 지적으로 본다.
//     막는 지적이 없으면 R 을 지금 HEAD 의 리뷰로 인정한다. 있으면 고친 커밋에서 다시 리뷰받을 때까지 기다린다.
//   - R 이 지금 HEAD 가 아닌데 지금 HEAD 에서 봇 리뷰가 도는 중이면 그 결과를 기다린다.
//   - 배지는 작성자가 Bot 이고 trusted_bots 의 login 인 글만 읽는다. 누구나 쓸 수 있는 글로 통과시키지 않는다(사용자 2026-11-24).
export function judgeTrustedBotReviews(head: string, data: BotReviewData, bots: readonly TrustedReviewBot[]): TrustedReview {
  const receipts: ReviewNote[] = []
  const headOid = head.toLowerCase()
  const time = (at: string | null | undefined) => {
    const parsed = Date.parse(at ?? '')
    return Number.isFinite(parsed) ? parsed : Infinity
  }
  for (const bot of bots) {
    const findings: { at: number; blocking: boolean }[] = []
    const candidate: (ReviewNote & { time: number })[] = []
    // reviewed 는 GitHub 가 기록한 리뷰의 커밋이다. 리뷰 영수증은 그 커밋이 지금 HEAD 와 같을 때만 지금 HEAD 의 것이다
    const addReceipt = (commit: string | null, at: string | null, reviewed?: string) => {
      if (commit && at && Number.isFinite(Date.parse(at))) {
        const onHead = reviewed === undefined ? headOid.startsWith(commit) : reviewed === headOid
        candidate.push({ body: '', at, commit: onHead ? head : (reviewed ?? commit), receiptBot: bot.login, time: Date.parse(at), ...(onHead ? {} : { earlier: true }) })
      }
    }
    for (const thread of data.reviewThreads) {
      const first = thread.comments.nodes[0]
      if (!first || !fromBot(first.author, bot)) continue
      if (!thread.isResolved) return { ok: false, wait: `${bot.login} 봇의 미해결 줄 댓글 스레드가 있다` }
      findings.push({ at: time(first.createdAt), blocking: blockingThread(first.body) })
    }
    for (const review of data.reviews) {
      if (!fromBot(review.author, bot) || review.state === 'PENDING' || review.state === 'DISMISSED') continue
      const commit = receiptCommit(review.body, bot)
      const reviewOid = review.commit?.oid.toLowerCase()
      const matchesReview = commit && reviewOid?.startsWith(commit)
      if (review.state === 'CHANGES_REQUESTED' || (review.state === 'COMMENTED' && !matchesReview)) {
        findings.push({ at: time(review.submittedAt), blocking: true })
      } else if (matchesReview) {
        addReceipt(commit, review.submittedAt, reviewOid)
      }
    }
    for (const comment of data.comments) {
      if (fromBot(comment.author, bot)) addReceipt(receiptCommit(comment.body, bot), comment.createdAt)
    }
    // 같은 시각이면 지금 HEAD 의 영수증을 마지막으로 본다
    candidate.sort((a, b) => a.time - b.time || Number(!a.earlier) - Number(!b.earlier))
    const last = candidate.at(-1)
    if (!last) {
      if (findings.length > 0) return { ok: false, wait: `${bot.login} 봇이 지적을 남겼다. 지적을 해결한 뒤 현재 HEAD 의 영수증을 다시 받아야 한다` }
      continue
    }
    if (findings.some((one) => one.blocking && one.at >= last.time)) {
      return { ok: false, wait: `${bot.login} 봇이 P1·P2 지적을 남겼다. 고친 커밋에서 현재 HEAD 의 영수증을 다시 받아야 한다` }
    }
    if (last.earlier && botReviewRunning(head, data, bot)) {
      return { ok: false, wait: `${bot.login} 봇이 현재 HEAD 를 리뷰하는 중이다` }
    }
    const { time: _time, ...note } = last
    receipts.push(note)
  }
  return { ok: true, receipts }
}
