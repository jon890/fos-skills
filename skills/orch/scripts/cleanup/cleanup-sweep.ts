// 정리 단계를 순서대로 실행하고 저장소별 결과를 모은다. 기본은 dry-run 이다.
import type { Args, Log, Terminal } from './shared.ts'
import { ConfigError } from '../lib/config.ts'
import { RepoError, err } from './shared.ts'
import type { Runner } from '../lib/proc.ts'
import type { StepContext, StepState } from './steps/context.ts'
import type { WorkerRow } from '../lib/ownership.ts'
import { cleanupBranches } from './steps/branches.ts'
import { cleanupDocker } from './steps/docker.ts'
import { cleanupRemoteBranches } from './steps/remote-branches.ts'
import { cleanupReviews } from './steps/reviews.ts'
import { cleanupSpecs } from './steps/specs.ts'
import { cleanupState } from './steps/state.ts'
import { cleanupWorktrees } from './steps/worktrees.ts'
import { fire } from '../lib/events.ts'
import { prepare } from './steps/prepare.ts'
import { prepareSession } from './cli.ts'
import { withRun } from '../lib/proc.ts'

export type { Host } from './processes.ts'
export { waitFree, stopHolders } from './processes.ts'
export type { SweepContext } from './output.ts'
export { sweepLine } from './output.ts'

async function sweepRepo(repo: string, args: Args, workers: WorkerRow[], terminals: Terminal[], log: Log): Promise<number> {
  const ctx: StepContext = { repo, args, workers, terminals, log }
  const state: StepState = { report: { removed: [], skipped: [] }, listed: [], remaining: new Set(), specsDir: null, owners: () => null, code: 0 }
  Object.assign(state, await prepare(ctx, state))
  Object.assign(state, await cleanupWorktrees(ctx, state))
  Object.assign(state, await cleanupBranches(ctx, state))
  Object.assign(state, await cleanupReviews(ctx, state))
  Object.assign(state, await cleanupSpecs(ctx, state))
  Object.assign(state, await cleanupRemoteBranches(ctx, state))
  Object.assign(state, await cleanupState(ctx, state))
  Object.assign(state, await cleanupDocker(ctx, state))
  if (!ctx.args.apply) return state.code
  try {
    // 실패와 시간 초과는 HOOK-FAIL 줄만 남긴다. 정리의 2 는 사용법 오류와 저장소 조회 실패를 뜻한다.
    await fire('after-cleanup', { removed: state.report.removed, skipped: state.report.skipped }, { repo, base: ctx.args.base, run: args.run, out: log })
  } catch (e) {
    process.stderr.write(`cleanup-sweep: after-cleanup 을 내지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
  }
  return state.code
}

export function main(argv: string[], runner?: Runner): Promise<number> {
  return runner ? withRun(runner, () => executeMain(argv)) : executeMain(argv)
}

async function executeMain(argv: string[]): Promise<number> {
  const session = await prepareSession(argv)
  if ('code' in session) return session.code
  const { repos, args, workers, terminals, log, brief, tally } = session
  let code = 0
  for (const repo of repos) {
    try {
      if ((await sweepRepo(repo, args, workers, terminals, log)) !== 0) code = 2
    } catch (e) {
      if (!(e instanceof RepoError || e instanceof ConfigError)) throw e
      err(`cleanup-sweep: ${e.message}`)
      code = 2
    }
  }
  if (brief) process.stdout.write(`${args.apply ? 'SWEEP' : 'SWEEP-DRY'} ${tally.removed} ${tally.kept}\n`)
  return code
}

export function reportError(e: unknown): void {
  err(`cleanup-sweep: ${(e as Error)?.stack ?? String(e)}`)
  process.exitCode = 1
}
if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    reportError,
  )
}
