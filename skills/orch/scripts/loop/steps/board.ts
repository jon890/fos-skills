// 보드 동기화(틱 3, 워크트리 정리 전): 보드 파일(lib/board-file.ts 의 boardPath)이 없으면 건너뛴다. 있으면 열린 PR 목록과 --repo 를 board-sync 에 준다.
// worker_done 과 이미 읽은 Orca 행에서 끝남을 모아 --worker-ends 로 넘긴다.
//     결정이 남았을 때의 알림은 decisions.ts 가 맡는다.

import { notifyUnmatched } from '../../lib/board-unmatched.ts'
import { scriptPath } from '../../lib/commands.ts'
import { isFile } from '../../lib/fs.ts'
import { boardPath } from '../../lib/board-file.ts'
import { runAsync, scriptCommand } from '../../lib/proc.ts'
import { context, payload } from '../../lib/completion.ts'
import { boardItemOfDispatch, reviewPrOfDispatch, reviewPrOfItem, reviewPrsByItem, reviewOriginsByItem, isReviewItem } from '../../lib/review.ts'
import { launchHistory } from '../../lib/launch-history.ts'
import { readBoard } from '../../lib/board.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { oneLine, relay, rowsOf, SWEEP_TIMEOUT_MS } from './shared.ts'
import { rowsReviewPr, workingDispatches, workerEnds } from '../../core/board-workers.ts'

export async function syncBoard(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { prs } = state
  const { report, errors } = reporter(ctx)
  // 3. 보드 동기화. 저장소 공유 일이라 한 번이고 알림은 주 Run 에 간다
  try {
    if (isFile(boardPath(ctx.repo))) {
      const sync = process.env.BOARD_SYNC || scriptPath('board-sync')
      const args = ['--repo', ctx.repo]
      const reviews = new Set<number>()
      const byItem = reviewPrsByItem(ctx.repo)
      const boardItems = readBoard(boardPath(ctx.repo))
      const origins = reviewOriginsByItem(ctx.repo, boardItems)
      const openItems = boardItems.filter((item) => item.status !== 'done' && isReviewItem(item, origins) && (rowsReviewPr(item) ?? reviewPrOfItem(String(item.id), byItem)) !== null).map((item) => String(item.id))
      const watched = workingDispatches(boardItems)
      if (watched.size) {
        const rows = ctx.runs.flatMap((run) => {
          if (!run.run) return []
          const result = rowsOf(run.run, ctx.lookup)
          return result.ok ? result.rows : []
        })
        const reported = new Set([...ctx.completions.values()].flat().flatMap((message) => {
          const dispatch = context(message)[1]
          return dispatch ? [String(dispatch)] : []
        }))
        const ends = workerEnds(rows, reported, watched)
        if (Object.keys(ends).length) args.push('--worker-ends', JSON.stringify(ends))
      }
      const pending = new Set(openItems.flatMap((id) => /^review-pr-(\d+)$/.test(id) ? [Number(id.slice('review-pr-'.length))] : []))
      const items = new Set<string>()
      const messages = [...ctx.completions.values()].flat().filter((message) => (message.outcome ?? payload(message).outcome) === 'succeeded')
      if (openItems.length && messages.length) {
        const history = new Map(launchHistory(ctx.repo).map((row) => [row.dispatch, row]))
        const known = new Map<string, number | null>()
        for (const message of messages) {
          const dispatch = context(message)[1]
          if (!dispatch) continue
          const id = String(dispatch)
          if (!known.has(id)) known.set(id, reviewPrOfDispatch(ctx.repo, id, history))
          const pr = known.get(id)
          // worker_done 은 그 dispatch 가 맡은 항목만 닫는다. 같은 PR 의 다른 리뷰·검증 항목은 그 항목의 worker 나 대상 PR 머지로 닫는다
          if (pr == null) continue
          const item = boardItemOfDispatch(ctx.repo, id, history)
          if (item && openItems.includes(item)) items.add(item)
          else if (!item && pending.has(pr)) reviews.add(pr)
        }
      }
      if (reviews.size) args.push('--completed-reviews', JSON.stringify([...reviews]))
      if (items.size) args.push('--completed-items', JSON.stringify([...items]))
      if (prs.ok) args.push('--open-prs', JSON.stringify(prs.mine.map((pr) => ({ number: pr.number, headRefName: pr.branch, title: pr.title }))))
      const done = await runAsync(scriptCommand(sync, args), { cwd: ctx.repo, timeoutMs: SWEEP_TIMEOUT_MS })
      relay(done)
      if (done.code === 0) notifyUnmatched(ctx.repo, ctx.primary)
      report('board', done.code === 0 ? null : `종료 코드 ${done.code}`)
    } else {
      report('board', null)
    }
  } catch (e) {
    report('board', oneLine(e))
  }
  return { errors }
}
