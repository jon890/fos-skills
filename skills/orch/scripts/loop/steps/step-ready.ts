// 6-2. 다음 단계 알림. movement 설정과 무관하게 돌며 전송 성공만 step-ready.json 에 기록한다.
// 한도 알림의 새 전이는 보드 유무·자동 진행 설정과 관계없이 머신 파일에 남긴다.
import { existsSync } from 'node:fs'
import { readyNotices } from '../../core/step-ready.ts'
import { boardPath } from '../../lib/board-file.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import { boardReadySteps, liveSteps, readReadyNotices, writeReadyNotices } from '../../lib/step-ready.ts'
import { recordWorkerLimited, workerLimitedAt } from '../../lib/worker-limited.ts'
import { missingRowKeys, worktreePaths } from '../../lib/workers.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { log, oneLine, rowsOf, stallEntries } from './shared.ts'

export async function notifyStepReady(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { report, errors } = reporter(ctx)
  try {
    const now = Date.now()
    const before = stallEntries(ctx.loaded?.stalls)
    if (Object.entries(state.stalls ?? {}).some(([id, row]) => row.limitedNotified && !before[id]?.limitedNotified)) recordWorkerLimited(now)
    if (!ctx.autoAdvance || !existsSync(boardPath(ctx.repo))) { report('step-ready', null); return { errors } }
    const rows: Record<string, unknown>[] = []
    let known = ctx.runs.some(row => row.run !== null)
    for (const { run } of ctx.runs) {
      const got = rowsOf(run ?? '', ctx.lookup)
      if (!got.ok || got.shapeOk === false || got.rows.some(row => missingRowKeys(row).length > 0)) known = false
      else rows.push(...got.rows)
    }
    ctx.lookup.paths ??= worktreePaths(ctx.repo)
    const prs = state.prs.ok && state.prs.mine.every(pr => pr.branch.trim()) ? state.prs.mine.map(pr => ({ number: String(pr.number), branch: pr.branch })) : null
    const steps = boardReadySteps(ctx.repo, known ? liveSteps(rows) : null, ctx.lookup.paths, prs)
    const result = readyNotices(readReadyNotices(ctx.repo), steps, now, workerLimitedAt())
    const failed: string[] = []
    for (const { id, notice } of result.fire) {
      const subject = `STEP-READY ${id} ${notice.mark} ${notice.step}`
      try {
        sendNotice('STEP-READY', null, `${id} ${notice.step}`, ctx.primary, ctx.repo, false, { subject })
        result.records[id] = notice
        log(subject)
      } catch (error) { failed.push(oneLine(error)) }
    }
    writeReadyNotices(ctx.repo, result.records)
    report('step-ready', failed.length ? failed.join('; ') : null)
  } catch (error) { report('step-ready', oneLine(error)) }
  return { errors }
}
