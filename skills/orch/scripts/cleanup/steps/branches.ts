import type { Args, Log } from './shared.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { deleteRemote, merged, protectedReason, remotePlan, unpushed } from './prs.ts'
import { git, lines } from './shared.ts'

function sweepBranches(repo: string, args: Args, checkedOut: Set<string>, log: Log): void {
  const listed = git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
  if (listed.code !== 0) return
  for (const branch of lines(listed.out)) {
    if (checkedOut.has(branch) || protectedReason(repo, branch, args.base)) continue
    const m = merged(repo, branch, args.base)
    if (!m.ok) continue
    const lost = unpushed(repo, branch, m.mergedHead, m.mergedHead === null)
    if (lost) {
      log(`건너뜀 브랜치 ${branch}: 원격에 없는 커밋 ${lost > 0 ? lost : '확인 실패'}`)
      continue
    }
    const plan = remotePlan(repo, branch, m.pr)
    if (args.apply) {
      const done = git(repo, 'branch', '-D', branch)
      log(done.code === 0 ? `브랜치 삭제 ${branch} (${m.why})` : `브랜치 삭제 실패 ${branch}: ${done.err}`)
    } else {
      log(`브랜치를 지울 것 ${branch} (${m.why})`)
    }
    deleteRemote(repo, plan, args.base, args.apply, log)
  }
}

export async function cleanupBranches(ctx: StepContext, state: StepState): Promise<StepResult> {
  sweepBranches(ctx.repo, ctx.args, state.remaining, ctx.log)
  return {}
}
