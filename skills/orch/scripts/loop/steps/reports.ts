// 모아 보내기와 완료 보고·끊긴 worker 확인(틱 12): Run 마다 모아 둔 알림을 DIGEST 로 보내고(lib/notice-digest.ts 의 flushDigest) 완료 보고와 끊긴 worker 를 차례로 확인한다.
//     완료 보고·끊김은 loop/completion-watch.ts 와 lib/lost-workers.ts 가 확인하며 메시지는 소비하지 않는다.
//     확인이 실패하면 errors 의 done@<Run>, lost@<Run> 에 이유를 둔다. 같은 틱에 그 Run 의 질문 확인도 실패했으면 로그에만 쓰고 비워 둔다. Orca 가 꺼진 틱에 같은 원인으로 두 번 깨우지 않는다.

import { defaultBase } from '../../lib/git.ts'
import { watchLost } from '../../lib/lost-workers.ts'
import { flushDigest } from '../../lib/notice-digest.ts'
import { watchCompletions } from '../completion-watch.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { log, oneLine } from './shared.ts'

export async function checkReports(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { runs } = ctx
  const { waiting } = state
  const { report, errors } = reporter(ctx)
  for (const { run } of runs) {
    if (!run) continue
    try { flushDigest(ctx.repo, run, ctx.digestSec) } catch (e) { log(`orch-loop: DIGEST 를 보내지 못했다: ${oneLine(e)}`) }
    for (const [source, action] of [['done', watchCompletions], ['lost', watchLost]] as const) {
      try { await action(ctx.repo, run, defaultBase(ctx.repo) ?? ''); report(source, null, { run }) }
      catch (e) {
        // 질문 조회가 같은 틱에 실패했으면 그 알림 하나로 둔다. 감시 자체는 독립적으로 실행한다.
        if (waiting.get(run) === null) {
          log(`WATCH-ERROR ${source}: ${oneLine(e)}`)
          report(source, null, { run })
        } else report(source, oneLine(e), { run })
      }
    }
  }
  return { errors }
}
