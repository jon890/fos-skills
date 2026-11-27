// 보드 동기화(틱 3, 워크트리 정리 전): 보드 파일(lib/board-file.ts 의 boardPath)이 없으면 건너뛴다. 있으면 열린 PR 목록과 --repo 를 board-sync 에 준다.
// worker_done 과 이미 읽은 Orca 행에서 끝남을 모아 --worker-ends 로, 끊김 줄의 되살림을 --worker-revivals 로 넘긴다.
// 성공한 worker_done 의 끝낸 단계(`steps=2,3`)와 PR 없는 지시서인지를 --worker-steps 로 넘긴다. board-sync 가 그 dispatch 의 항목 단계를 끝낸다.
//     결정이 남았을 때의 알림은 decisions.ts 가 맡는다.

import { notifyUnmatched } from '../../lib/board-unmatched.ts'
import { scriptPath } from '../../lib/commands.ts'
import { isFile } from '../../lib/fs.ts'
import { boardPath } from '../../lib/board-file.ts'
import { runAsync, scriptCommand } from '../../lib/proc.ts'
import { context, doneSteps, noPrInstruction, payload } from '../../lib/completion.ts'
import { readFileSync } from 'node:fs'
import { todoNumbered } from '../../lib/board.ts'
import { boardItemOfDispatch, reviewPrOfDispatch, reviewPrOfItem, reviewPrsByItem, reviewOriginsByItem, isReviewItem } from '../../lib/review.ts'
import { launchHistory } from '../../lib/launch-history.ts'
import { readBoard } from '../../lib/board.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { oneLine, relay, rowsOf, SWEEP_TIMEOUT_MS } from './shared.ts'
import { lostDispatches, rowsReviewPr, workingDispatches, workerEnds, workerRevivals } from '../../core/board-workers.ts'

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
      // 끊김으로 적힌 줄도 틱마다 다시 본다. 그 사이 dispatch 가 다시 살아 있거나 성공으로 끝났으면 줄을 고친다
      const lost = lostDispatches(boardItems)
      if (watched.size || lost.size) {
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
        const revivals = workerRevivals(rows, reported, lost)
        if (Object.keys(revivals).length) args.push('--worker-revivals', JSON.stringify(revivals))
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
      const steps = workerSteps(ctx.repo, messages)
      if (Object.keys(steps).length) args.push('--worker-steps', JSON.stringify(steps))
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

// dispatch → { steps, noPr }. steps 는 worker_done 이 적은 끝낸 단계 번호(없으면 null), noPr 은 그 dispatch 의 지시서가 PR 없는 일인지다.
// 둘 다 없는 dispatch 는 넣지 않는다. 지시서를 읽지 못하면 PR 없는 일로 보지 않는다(번호 없는 보고로 모든 단계를 끝내지 않는다)
// texts 는 steps 의 번호마다 지시서 「할 일」 그 번호 줄의 글(보드 단계와 같은 꼴, 없으면 null)이다. 다시 연 항목은 단계 번호가 뒤로 밀려 글로 맞춘다
export function workerSteps(repo: string, messages: Record<string, unknown>[]): Record<string, { steps: number[] | null; noPr: boolean; texts?: (string | null)[] }> {
  const found: Record<string, { steps: number[] | null; noPr: boolean; texts?: (string | null)[] }> = {}
  let history: Map<string, { spec?: string | null }> | null = null
  for (const message of messages) {
    const dispatch = context(message)[1]
    if (!dispatch) continue
    const id = String(dispatch)
    history ??= new Map(launchHistory(repo).map((row) => [row.dispatch, row]))
    const spec = history?.get(id)?.spec
    let text = ''
    try { text = spec ? readFileSync(spec, 'utf8') : '' } catch { text = '' }
    const noPr = Boolean(text) && noPrInstruction(text)
    const steps = doneSteps(message) ?? found[id]?.steps ?? null
    const todo = text ? todoNumbered(text) : new Map<number, string>()
    if (steps || noPr) found[id] = { steps, noPr, ...(steps && todo.size > 0 ? { texts: steps.map((n) => todo.get(n) ?? null) } : {}) }
  }
  return found
}
