// 질문 확인(틱 1): Run 마다, Run id 가 있을 때만. lib/questions.ts 의 poll(재알림 600초)을 부르고
//     알릴 줄마다 QUESTION 이나 REMINDER 줄을 로그에 쓴다. 기술 질문의 REMINDER 는 worker-question 이벤트를 내고, Run 메시지는 미답변 질문 묶음의 UNANSWERED 가 맡는다.
//     사용자 결정 재알림은 로그만 남기고 decision-pending 의 중복 억제를 따른다.
//     새 질문(QUESTION)은 루프가 별도 메시지로 보내지 않는다. Orca 가 원래 question 메시지로 코디네이터를 깨운다
//     닫힌 질문(lib/questions.ts 의 「닫힌 질문」)의 REMINDER 는 내지 않고, 처음 닫힌 것으로 판정한 틱에 `REMINDER-SKIP <id>: <근거>` 를 로그에 한 번 쓴다
//     미답변 질문을 보낸 worker(waiting)와 닫히지 않은 미답변 질문(pending)을 뒤 단계에 넘긴다. 질문을 읽지 못한 Run 은 waiting 이 null 이고 pending 이 없다.

import { join } from 'node:path'
import { senderOf } from '../../core/message-fields.ts'
import { context as questionContext } from '../../lib/completion.ts'
import { isUserDecision } from '../../lib/decisions.ts'
import { pathOf } from '../../lib/paths.ts'
import { closedReason, notifyQuestion, poll, pruneSharedClosed, readClosed, shareClosedQuestion, writeClosed } from '../../lib/questions.ts'
import type { ClosedLookup } from '../../lib/questions.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { log, oneLine } from './shared.ts'
import type { Waiting } from './shared.ts'

export const REMIND_AFTER_SEC = 600

function askers(pending: Record<string, unknown>[]): Waiting {
  const dispatches = new Set<string>()
  const terminals = new Set<string>()
  for (const message of pending) {
    const dispatch = questionContext(message)[1]
    if (dispatch) dispatches.add(String(dispatch))
    if (senderOf(message)) terminals.add(senderOf(message))
  }
  return { dispatches, terminals }
}

export async function checkQuestions(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { runs } = ctx
  const { report, errors } = reporter(ctx)
  // 1. 질문 확인. Run 마다. 미답변 질문을 보낸 worker 는 멈춤 확인이 idle 로 보지 않는다
  // 닫힌 질문(끝난 dispatch 의 질문이고 그 PR 이 머지되거나 닫혔다)은 재알림하지 않는다(lib/questions.ts 의 「닫힌 질문」)
  const waiting = new Map<string, Waiting>()
  const pendingDecisions = new Map<string, ReturnType<typeof poll>['pending']>()
  const closedFile = join(pathOf('state', ctx.repo), 'questions-closed.json')
  const closed = readClosed(closedFile)
  const share = (run: string, id: string, reason: string) => {
    try {
      shareClosedQuestion(run, id, reason)
    } catch (e) {
      log(`orch-loop: 공유 닫힌 질문 기록을 쓰지 못했다: ${oneLine(e)}`)
    }
  }
  let closedChanged = false
  for (const { run } of runs) {
    if (!run) {
      report('questions', null, { run })
      continue
    }
    let notices: ReturnType<typeof poll>['notices'] = []
    try {
      for (const [id, reason] of Object.entries(closed[run] ?? {})) share(run, id, reason)
      const polled = poll(run, join(pathOf('state', ctx.repo), 'questions-seen.json'), Date.now() / 1000, REMIND_AFTER_SEC, ctx.repo)
      notices = polled.notices
      pendingDecisions.set(run, polled.pending)
      waiting.set(run, askers(polled.pending))
      report('questions', null, { run })
      // 미답변 목록에서 빠진 질문의 기록은 지운다
      const pendingIds = new Set(polled.pending.map((m) => String(m.id)))
      for (const id of Object.keys(closed[run] ?? {})) {
        if (!pendingIds.has(id)) {
          delete closed[run][id]
          closedChanged = true
        }
      }
    } catch (e) {
      waiting.set(run, null)
      report('questions', oneLine(e), { run })
    }
    const lookup: ClosedLookup = {}
    for (const notice of notices) {
      if (notice.reminder) {
        const id = String(notice.message.id)
        if (closed[run]?.[id]) continue
        const reason = closedReason(notice.message, run, ctx.repo, lookup)
        if (reason) {
          share(run, id, reason)
          ;(closed[run] ??= {})[id] = reason
          closedChanged = true
          log(`REMINDER-SKIP ${id}: ${reason}`)
          continue
        }
      }
      log(notice.line)
      // 사용자 결정은 decision-pending 만 깨운다. 600초 재알림이 중복 억제를 우회하지 않게 한다.
      if (notice.reminder && isUserDecision(notice.message)) continue
      await notifyQuestion(notice, ctx.repo, run, 'orch-loop')
    }
    const pending = pendingDecisions.get(run)
    if (pending) {
      const open = pending.filter((message) => !closed[run]?.[String(message.id)])
      pendingDecisions.set(run, open)
      waiting.set(run, askers(open))
    }
  }
  try {
    pruneSharedClosed()
  } catch (e) {
    log(`orch-loop: 오래된 공유 닫힌 질문 기록을 지우지 못했다: ${oneLine(e)}`)
  }
  if (closedChanged) {
    try {
      writeClosed(closedFile, closed, ctx.repo)
    } catch (e) {
      log(`orch-loop: 닫힌 질문 기록을 쓰지 못했다: ${oneLine(e)}`)
    }
  }
  return { errors, waiting, pending: pendingDecisions }
}
