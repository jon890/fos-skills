// 현재 HEAD 를 처음 본 시각을 기록한다. 주기가 지나면 GitHub 에서 HEAD 와 봇 상태를 새로 확인한다.
// 봇의 마지막 리뷰를 지금 HEAD 에도 인정하면(P1·P2 없음) 다시 요청하지 않는다. P1·P2 를 고친 push 에만 재리뷰를 부른다.
// 로컬 기록과 댓글의 표지는 요청 뒤 루프가 재시작하거나 응답을 잃어도 같은 HEAD 에 다시 달지 않게 한다.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_REVIEW_REQUEST_AFTER_SEC } from '../../core/auto-merge.ts'
import { gh } from '../../lib/gh.ts'
import { withOwnerLock } from '../../lib/owner-lock.ts'
import { makeParent, pathOf } from '../../lib/paths.ts'
import { botReviewRunning, hasCurrentBotReceipt, judgeTrustedBotReviews, loadBotReviewSnapshot } from '../../lib/review-bot.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { log, oneLine } from './shared.ts'

type Observation = { head: string; since: number; requested: string[] }

function readObservations(file: string): Record<string, Observation> {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
}

// 관문과 같은 전체 봇 판단이 앞 리뷰를 인정하는가. 한 봇이라도 막으면 인정하지 않는다(PR 651 리뷰)
function acceptedEarlier(head: string, data: Parameters<typeof judgeTrustedBotReviews>[1], bots: Parameters<typeof judgeTrustedBotReviews>[2]): boolean {
  const judged = judgeTrustedBotReviews(head, data, bots)
  return judged.ok && judged.receipts.length > 0
}

export function requestMissingBotReviews(ctx: StepContext, state: StepState, now = Date.now()): StepResult {
  const { prs } = state
  const review = ctx.autoMerge.review
  const bots = review?.trustedBots
  const command = bots?.find((bot) => bot.requestComment)?.requestComment
  if (!prs.ok || !bots || !command) return {}
  const delay = (review.requestAfterSec ?? DEFAULT_REVIEW_REQUEST_AFTER_SEC) * 1000
  const { report, errors } = reporter(ctx)
  const file = join(pathOf('state', ctx.repo), 'review-requests.json')
  const failures: string[] = []
  try {
    makeParent(file, ctx.repo)
    withOwnerLock(`${file}.lock`, () => {
      const records = readObservations(file)
      const open = new Set(prs.mine.map((pr) => String(pr.number)))
      for (const number of Object.keys(records)) if (!open.has(number)) delete records[number]
      for (const pr of prs.mine) {
        const previous = records[pr.number]
        if (!/^[0-9a-f]{40}$/.test(pr.head)) continue
        if (pr.draft || previous?.head !== pr.head) {
          records[pr.number] = { head: pr.head, since: now, requested: previous?.requested ?? [] }
          continue
        }
        if (previous.requested.includes(pr.head) || now - previous.since < delay) continue

        const snapshot = loadBotReviewSnapshot(ctx.repo, pr, pr.head)
        if (!snapshot.ok) {
          failures.push(`#${pr.number} ${snapshot.wait}`)
          continue
        }
        // 앞 커밋의 리뷰를 인정하면(P1·P2 없음. 스펙 DECISION15) 다시 요청하지 않는다
        if (!snapshot.ready || bots.some((bot) => hasCurrentBotReceipt(pr.head, snapshot.data, bot) ||
          botReviewRunning(pr.head, snapshot.data, bot)) || acceptedEarlier(pr.head, snapshot.data, bots)) {
          previous.since = now
          continue
        }
        const marker = `<!-- orch-bot-review-request:${pr.head} -->`
        if (!snapshot.data.comments.some((comment) => comment.body.split(/\r?\n/).includes(marker))) {
          const done = gh(['api', '--hostname', pr.host, '-X', 'POST', `repos/${pr.slug}/issues/${pr.number}/comments`,
            '-f', `body=${command}\n\n${marker}`], { cwd: ctx.repo, cache: false })
          if (done.code !== 0) {
            failures.push(`#${pr.number} 리뷰 요청 댓글 등록 실패: ${oneLine(done.stderr || done.stdout)}`)
            continue
          }
          log(`BOT-REVIEW-REQUEST #${pr.number} ${pr.head.slice(0, 8)}`)
        }
        previous.requested.push(pr.head)
      }
      writeFileSync(`${file}.tmp`, `${JSON.stringify(records, null, 2)}\n`)
      renameSync(`${file}.tmp`, file)
    })
  } catch (e) {
    failures.push(oneLine(e))
  }
  report('review-request', failures.join(' | ') || null)
  return { errors }
}
