// 리뷰 흔적 (저장소마다 워크트리와 로컬 브랜치 정리 뒤에 한 번. --run 이 없어도 한다):
//     리뷰 worker 는 PR 을 열지 않아 위 「PR 찾기」 로는 그 브랜치를 찾지 못한다. 이름과 지시서 줄로 PR 번호를 읽는다(lib/review.ts).
//     후보는 리뷰 브랜치(`pr-<N>`, `review/pr-<N>[-<꼬리>]`)와, --specs-dir 를 줬으면 그 폴더 바로 아래의 리뷰 지시서
//     (`spec-review-pr-<N>[-<꼬리>].md` 이거나 본문에 `리뷰 PR: #<N>` 줄이 있는 것)다.
//     남은 워크트리가 쓰는 브랜치는 후보가 아니다. detached 워크트리는 그것을 만든 브랜치(lib/review.ts 의 originBranch)를 쓰는 것으로 본다.
//     PR 번호마다 `gh pr view <N> --json state,headRefOid` 를 한 번 읽고, 아래를 모두 채우면 그 번호의 후보를 지운다.
//       - state 가 MERGED 나 CLOSED 다. OPEN 이면 줄 없이 남긴다
//       - 그 리뷰 dispatch 가 끝났다. --run 과 상관없이 모든 Run 의 살아 있는 dispatch 지시서(lib/spec.ts 의 allLiveSpecPaths) 가운데
//         같은 번호의 리뷰 지시서가 없다. 후보가 있을 때만 이 목록을 읽는다. 목록을 읽지 못하면 그 번호를 남긴다(lib/review.ts 의 reviewKeepReason)
//     브랜치는 아래를 모두 채울 때만 `git branch -D` 로 지운다.
//       - 기준 브랜치, `release/*`, 다른 열린 PR 의 base 가 아니다(위 「실행 순서」 의 보호와 같다)
//       - 그 브랜치 이름(upstream, `branch.<b>.merge`, 로컬 이름)을 head 로 둔 열린 PR 이 없다. 조회가 실패하면 남긴다
//       - 끝 커밋이 origin/<기준> 이나 PR headRefOid(로컬에 없으면 `refs/pull/<N>/head` 를 받는다)의 조상이다
//     리뷰 브랜치는 PR head 의 사본이거나 기준 브랜치에서 갓 만든 것이라, 그 밖의 커밋이 있으면 누군가의 작업이다.
//     지시서는 deleteSpecs 로 지운다. 원격 브랜치는 건드리지 않는다.
//     출력은 `리뷰 브랜치를 지울 것 <브랜치> (#<N> <state>)`, `리뷰 브랜치 삭제 <브랜치> (#<N> <state>)`, `리뷰 브랜치 남김 <브랜치>: <이유>`,
//     `리뷰 흔적 남김 #<N>: <이유>` 와 deleteSpecs 의 줄이다.
//
// 워크트리 없는 지시서 (저장소마다 리뷰 흔적 뒤에 한 번. --specs-dir 를 줬을 때):
//     워크트리가 먼저 지워지면 위 워크트리 순회가 그 지시서를 만나지 못해 쌓인다. --specs-dir 바로 아래 .md 가운데
//     `브랜치:` 줄이 있는 지시서마다 아래를 모두 채우면 --trash 로 옮긴다.
//       - 줄의 브랜치마다 PR 이 있고 모두 MERGED 다(OPEN 이 하나라도 있거나 조회가 실패하면 남긴다)
//       - 그 브랜치를 쓰는 워크트리가 없다. 같은 이름의 로컬 브랜치가 있으면 끝점이 머지된 PR 의 headRefOid 와 같다
//       - 기능 PR 의 후속 검증이 대기가 아니다(featureCompletionProblem)
//       - 살아 있는 dispatch 가 가리키는 지시서가 아니고 orch 루트 안이다(deleteSpecs)
//     옮기기 전 `워크트리 없는 지시서 판정 <경로>: 브랜치 <b> PR #<N> MERGED, 그 브랜치의 워크트리 없음` 한 줄을 낸다.
//     남기는 이유는 `워크트리 없는 지시서 남김 <경로>: <이유>` 로 낸다(PR 이 없는 지시서는 줄 없이 남긴다)


// 리뷰 브랜치를 남길 이유. 끝 커밋이 기준 브랜치나 PR head 의 조상이면 null 이다(머리 주석의 「리뷰 흔적」)
import type { Args, Log } from './shared.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { allLiveSpecPaths, deleteSpecs } from '../../lib/spec.ts'
import { dirname, join } from 'node:path'
import { git, lines, readText, worktrees } from './shared.ts'
import { hasCommit, prCandidates, prList, protectedReason } from './prs.ts'
import { liveReviewPrs, originBranch, reviewKeepReason, reviewPrOf, reviewPrOfBranch, reviewPrState } from '../../lib/review.ts'
import { readdirSync } from 'node:fs'
import { realPath } from '../../lib/fs.ts'

function reviewBranchKept(repo: string, branch: string, base: string, n: number, head: string): string | null {
  const tip = git(repo, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`)
  if (tip.code !== 0) return '끝 커밋을 읽지 못했다'
  if (git(repo, 'merge-base', '--is-ancestor', tip.out, `origin/${base}`).code === 0) return null
  if (head) {
    if (!hasCommit(repo, head)) git(repo, 'fetch', '-q', 'origin', `refs/pull/${n}/head`)
    if (hasCommit(repo, head) && git(repo, 'merge-base', '--is-ancestor', tip.out, head).code === 0) return null
  }
  return '기준 브랜치에도 PR head 에도 없는 커밋이 있다'
}

// 리뷰 브랜치 자체를 지키는 이유. 기준이나 release 브랜치, 다른 열린 PR 의 base, 그 브랜치를 head 로 둔 열린 PR 이 있으면 남긴다
function reviewBranchGuard(repo: string, branch: string, base: string): string | null {
  const guarded = protectedReason(repo, branch, base)
  if (guarded) return guarded
  for (const [name] of prCandidates(repo, branch).filter(([, exact]) => exact)) {
    const listed = prList(repo, name)
    if (!listed.ok) return '그 브랜치의 PR 을 읽지 못했다'
    const open = listed.prs.find((pr) => pr.state === 'OPEN')
    if (open) return `그 브랜치를 head 로 둔 열린 PR #${open.number} 가 있다`
  }
  return null
}

// 리뷰 worker 의 브랜치와 지시서를 PR 이 닫히고 그 dispatch 가 끝난 뒤 지운다(머리 주석의 「리뷰 흔적」)
function sweepReviews(repo: string, args: Args, checkedOut: Set<string>, specsDir: string | null, log: Log): void {
  const listed = git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
  if (listed.code !== 0) return
  const used = new Set(checkedOut)
  for (const [path, branch] of worktrees(repo)) {
    const origin = branch ? null : originBranch(path)
    if (origin) used.add(origin)
  }
  const found = new Map<number, { branches: string[]; specs: string[] }>()
  const entry = (n: number) => found.get(n) ?? found.set(n, { branches: [], specs: [] }).get(n)!
  for (const branch of lines(listed.out)) {
    const n = reviewPrOfBranch(branch)
    if (n !== null && !used.has(branch)) entry(n).branches.push(branch)
  }
  if (specsDir) {
    let names: string[] = []
    try {
      names = readdirSync(specsDir).filter((name) => name.endsWith('.md')).sort()
    } catch {
      // 폴더가 없으면 지시서 후보가 없다
    }
    for (const name of names) {
      const n = reviewPrOf(name, readText(join(specsDir, name)))
      if (n !== null) entry(n).specs.push(join(specsDir, name))
    }
  }
  if (found.size === 0) return
  // --run 과 상관없이 모든 Run 의 살아 있는 지시서를 본다. 다른 Run 의 리뷰를 지우지 않으려는 것이다
  const livePaths = allLiveSpecPaths()
  const live = liveReviewPrs(livePaths)
  for (const [n, { branches, specs }] of [...found].sort(([a], [b]) => a - b)) {
    const pr = reviewPrState(repo, n)
    const keep = reviewKeepReason(pr, n, live)
    if (keep === 'PR 이 열려 있다') continue
    if (keep || pr === null) {
      log(`리뷰 흔적 남김 #${n}: ${keep}`)
      continue
    }
    for (const branch of branches) {
      const kept = reviewBranchGuard(repo, branch, args.base) ?? reviewBranchKept(repo, branch, args.base, n, pr.head)
      if (kept) {
        log(`리뷰 브랜치 남김 ${branch}: ${kept}`)
      } else if (!args.apply) {
        log(`리뷰 브랜치를 지울 것 ${branch} (#${n} ${pr.state})`)
      } else {
        const done = git(repo, 'branch', '-D', branch)
        log(done.code === 0 ? `리뷰 브랜치 삭제 ${branch} (#${n} ${pr.state})` : `리뷰 브랜치 삭제 실패 ${branch}: ${done.err}`)
      }
    }
    if (specs.length > 0 && specsDir) {
      deleteSpecs({ root: dirname(realPath(specsDir)), specs, prBodies: [], live: livePaths, mode: 'delete', apply: args.apply, log: (line) => log(`  ${line}`) })
    }
  }
}

export async function cleanupReviews(ctx: StepContext, state: StepState): Promise<StepResult> {
  sweepReviews(ctx.repo, ctx.args, state.remaining, state.specsDir, ctx.log)
  return {}
}
