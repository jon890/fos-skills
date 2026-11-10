// tick 이벤트(틱 7): Run 마다 공통 필드 run 을 그 Run 으로 낸다. 입력은 tick(틱 번호), open_prs(내 열린 PR 번호 목록. 읽지 못하면 null),
//     primary(주 Run 이면 true)다(lib/events.ts 머리 주석의 「이벤트별 필드」).

import { fire } from '../../lib/events.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { openNumbers } from './prs.ts'
import { oneLine } from './shared.ts'

export async function fireTick(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { runs, tick: n } = ctx
  const { base } = state
  const openPrNumbers = openNumbers(state.prs)
  const { report, errors } = reporter(ctx)
  // 7. tick 이벤트. Run 마다 그 Run 을 공통 필드 run 으로 낸다
  for (const [i, { run }] of runs.entries()) {
    try {
      const fired = await fire('tick', { tick: n, open_prs: openPrNumbers, primary: i === 0 }, { repo: ctx.repo, base, run })
      if (fired.result === 'fail' || fired.result === 'timeout') {
        const reason = fired.result === 'timeout' ? 'timeout' : String(fired.code ?? 'lock')
        report('hook', reason, { run, kind: 'HOOK-FAIL', text: `tick ${reason}`, logged: true })
      } else {
        report('hook', null, { run })
      }
    } catch (e) {
      report('hook', oneLine(e), { run })
    }
  }
  return { errors }
}
