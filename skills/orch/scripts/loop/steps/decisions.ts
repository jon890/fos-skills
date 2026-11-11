// 사용자 결정 알림(틱 3 뒤): Run 마다, 그 Run 의 질문 조회에 성공한 틱에만 돈다.
//     새 사용자 결정 질문과 보드의 남은 decide 줄은 lib/decisions.ts 가 DECISION-PENDING 과 decision-pending 을 낸다.
//     기본 핸들러가 --start 로 등록한 현재 코디네이터에게 묻기를 요청한다. 같은 결정은 해결될 때까지 다시 깨우지 않는다.

import { notifyDecisions } from '../../lib/decisions.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { oneLine, rowsOf } from './shared.ts'

export async function notifyPendingDecisions(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { runs, primary } = ctx
  const pendingDecisions = state.pending
  const { report, errors } = reporter(ctx)
  // 결정은 질문 조회 성공 뒤에만 처리한다. 완료·끊김 감시는 아래에서 별도로 돈다.
  for (const { run } of runs) {
    if (!run || !pendingDecisions.has(run)) continue
    try {
      await notifyDecisions(ctx.repo, run, pendingDecisions.get(run)!, run === primary, Date.now(), rowsOf(run, ctx.lookup))
      report('decisions', null, { run })
    } catch (e) {
      report('decisions', oneLine(e), { run })
    }
  }
  return { errors }
}
