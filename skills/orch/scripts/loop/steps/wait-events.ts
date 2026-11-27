// 사건 대기(느린 틱, 보드 동기화 뒤). 규칙은 lib/wait-events.ts 머리 주석이 소유한다.
// 느린 틱이면 이 틱 자식이 끊기는 시각(시작 + lib/loop.ts 의 slowTickLimitMs)을 마감으로 넘긴다. 한 틱에 모두 도는 틱은 마감이 없다.
// 알림은 주 Run 에 바로 보낸다. 줄을 끝낸 뒤의 전송 실패와 보드 읽기 실패는 오류 줄 wait-events@<주 Run> 에 남긴다.
import { checkWaitEvents } from '../../lib/wait-events.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import { slowTickLimitMs } from '../../lib/loop.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { log, oneLine } from './shared.ts'

export async function checkWaitEventLines(ctx: StepContext, _state: StepState): Promise<StepResult> {
  const { report, errors } = reporter(ctx)
  try {
    const started = Date.now() - process.uptime() * 1000
    const deadline = ctx.kind === 'slow' && ctx.slowSec !== null ? started + slowTickLimitMs(ctx.slowSec) : null
    const result = await checkWaitEvents(ctx.repo, {
      deadline,
      log,
      notify: (kind, text) => sendNotice(kind, null, text, ctx.primary, ctx.repo, false, { subject: `${kind} ${text}` }),
    })
    // 새 오류 칸을 매 틱 더하지 않고, 실패했거나 앞 틱의 실패를 풀 때만 쓴다
    if (result.failed.length || Object.keys(ctx.previous).some((key) => key === 'wait-events' || key.startsWith('wait-events@'))) {
      report('wait-events', result.failed.length ? result.failed.join('; ') : null)
    }
  } catch (e) { report('wait-events', oneLine(e)) }
  return { errors }
}
