// 머지 뒤 이벤트, worker 알림과 정리 넘기기.

import { scriptPath } from '../../lib/commands.ts'
import { ConfigError } from '../../lib/config.ts'
import type { FireContext } from '../../lib/events.ts'
import { fire } from '../../lib/events.ts'
import { shortEnv } from '../../lib/output.ts'
import { NO_LIMIT_MS, runInherit, scriptCommand } from '../../lib/proc.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import { tellBranchWorker } from '../../lib/tell-worker.ts'
import type { StepContext, StepResult } from './model.ts'
import type { StepState } from './model.ts'
import { failLabel, failed, log, out } from './runtime.ts'

// 머지 뒤 이벤트 결과와 최종 상태 조각을 진입 파일에 넘긴다.
export async function afterQueue(stepContext: StepContext, state: StepState): Promise<StepResult<{ kind: 'done' | 'failed' } | { kind: 'config'; error: ConfigError }>> {
  const changes = () => ({ merged: state.merged, afterFailed: state.afterFailed })
  try {
    await runAfterMerged(stepContext, state)
    return { kind: state.afterFailed ? 'failed' : 'done', changes: changes() }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return { kind: 'config', error, changes: changes() }
  }
}

// 이번 실행에서 머지한 PR 이 있으면 after-queue 를 한 번 낸다
async function runAfterMerged(stepContext: StepContext, state: StepState): Promise<void> {
  if (!(state.merged.length > 0 && state.hooks.has('after-queue'))) return
  const merged = state.merged.map(([n]) => n)
  const code = state.merged.filter(([, kind]) => kind === 'code').map(([n]) => n)
  const mergedPrs = merged.join(' ')
  const codePrs = code.join(' ')
  log(`머지 뒤 명령(머지 ${mergedPrs}, 코드 ${codePrs || '없음'}): hooks/after-queue.ts`)
  const input = { merged_prs: merged.map(Number), code_prs: code.map(Number), held_prs: state.held.map(Number) }
  const ctx: FireContext = { repo: state.repoDir, base: state.sweepBase, run: null }
  state.merged = []
  let label: string | null = null
  try {
    const done = await fire('after-queue', input, ctx)
    if (failed(done)) label = failLabel(done)
  } catch (e) {
    // 설정 오류는 사용법 오류로 올린다. 그 밖의 오류는 머지 결과를 바꾸지 않고 실패로 남긴다
    if (e instanceof ConfigError) throw e
    process.stderr.write(`after-queue 를 내지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
    out('HOOK-FAIL after-queue error')
    label = 'error'
  }
  if (label !== null) {
    out(`AFTER-MERGED-FAILED ${label}`)
    state.afterFailed = true
  }
}

// 머지가 끝난 뒤 cleanup-sweep --apply 로 정리한다. 실패해도 머지 결과는 그대로라 경고만 찍는다
export async function sweep(stepContext: StepContext, state: StepState): Promise<StepResult<{ kind: 'done' | 'warning' }>> {
  const sweep = process.env.CLEANUP_SWEEP ?? scriptPath('cleanup-sweep')
  // 정리의 출력은 이 큐의 출력에 그대로 이어진다. 짧은 출력이면 정리도 짧은 출력이다
  const done = await runInherit(
    scriptCommand(sweep, ['--repo', process.cwd(), '--base', state.sweepBase || 'main', '--apply', ...state.o.sweepArgs]),
    { timeoutMs: NO_LIMIT_MS, env: shortEnv() },
  )
  if (done.code !== 0) out('경고: cleanup-sweep.ts 가 실패했다. 머지 결과는 그대로다')
  return { kind: done.code === 0 ? 'done' : 'warning', changes: {} }
}

// 큐 도중의 설정 오류로 멈춘다. 종료 코드 2 다. 이번 실행에서 머지한 PR 이 있으면 그 전에 after-queue 만 돌린다.
// 옛 명령은 보류로 멈춘 자리에서도 앞에서 머지한 PR 의 머지 뒤 명령을 돌리고 정리는 부르지 않았다. 그 규칙을 따른다
export async function stopOnConfig(stepContext: StepContext, state: StepState, e: ConfigError): Promise<number> {
  process.stderr.write(`${e.message}\n`)
  if (state.merged.length === 0) return 2
  try {
    await runAfterMerged(stepContext, state)
  } catch (again) {
    if (!(again instanceof ConfigError)) throw again
    process.stderr.write(`${again.message}\n`)
    out('AFTER-MERGED-FAILED error')
  }
  return 2
}

// 충돌로 뺀 PR 을 상주 루프의 알림 파일에 쓴다. 쓰지 못해도 큐는 이어 간다
export function notifyConflict(stepContext: StepContext, state: StepState, n: string, reason: string): void {
  const sweep = state.o.sweepArgs
  const at = sweep.indexOf('--run')
  const run = at >= 0 && at + 1 < sweep.length ? sweep[at + 1] : null
  try {
    sendNotice('QUEUE-CONFLICT', Number(n), reason, run)
  } catch (e) {
    process.stderr.write(`경고: QUEUE-CONFLICT 알림을 쓰지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
  }
}

// 보류한 PR 의 살아 있는 worker 에게 이유를 보낸다(머리 주석의 「보류」). Run 을 모르거나 worker 가 없으면 로그만 남긴다
export async function tellHeld(stepContext: StepContext, state: StepState, n: string, why: string): Promise<void> {
  const sweep = state.o.sweepArgs
  const at = sweep.indexOf('--run')
  const run = at >= 0 && at + 1 < sweep.length ? sweep[at + 1] : null
  const branch = state.pr?.branch ?? ''
  if (!run || !branch) {
    log(`${n} worker 에게 알리지 않는다(${run ? '브랜치 모름' : 'Run 모름'})`)
    return
  }
  const body = `PR #${n} 을 머지 큐에서 뺐다: ${why}. 고쳐 push 한 뒤 status 로 알린다.`
  const told = await tellBranchWorker(state.repoDir, branch, run, body)
  log(`${n} ${'sent' in told ? `${told.sent} 에 보류 이유를 보냈다` : `worker 에게 알리지 않았다: ${told.skipped}`}`)
}
