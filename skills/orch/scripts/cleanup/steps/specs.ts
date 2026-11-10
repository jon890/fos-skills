// 워크트리 없는 지시서 (저장소마다 리뷰 흔적 뒤에 한 번. --specs-dir 를 줬을 때):
//     워크트리가 먼저 지워지면 worktrees.ts 의 워크트리 순회가 그 지시서를 만나지 못해 쌓인다. --specs-dir 바로 아래 .md 가운데
//     `브랜치:` 줄이 있는 지시서마다 아래를 모두 채우면 --trash 로 옮긴다.
//       - 줄의 브랜치마다 PR 이 있고 모두 MERGED 다(OPEN 이 하나라도 있거나 조회가 실패하면 남긴다)
//       - 그 브랜치를 쓰는 워크트리가 없다. 같은 이름의 로컬 브랜치가 있으면 끝점이 머지된 PR 의 headRefOid 와 같다
//       - 기능 PR 의 후속 검증이 대기가 아니다(featureCompletionProblem)
//       - 살아 있는 dispatch 가 가리키는 지시서가 아니고 orch 루트 안이다(deleteSpecs)
//     옮기기 전 `워크트리 없는 지시서 판정 <경로>: 브랜치 <b> PR #<N> MERGED, 그 브랜치의 워크트리 없음` 한 줄을 낸다.
//     남기는 이유는 `워크트리 없는 지시서 남김 <경로>: <이유>` 로 낸다(PR 이 없는 지시서는 줄 없이 남긴다)
//
import type { Args, Log, Pr, Sweep } from './shared.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { branchTip, prList } from './prs.ts'
import { branchesOf, deleteSpecs, specCandidates, specsOnBranch } from '../../lib/spec.ts'
import { dirname, join } from 'node:path'
import { featureCompletionProblem } from '../../lib/feature-evidence.ts'
import { launchesAt } from '../../lib/launched.ts'
import { readText, truthy } from './shared.ts'
import { readdirSync } from 'node:fs'
import { realPath } from '../../lib/fs.ts'

// 지시서와 PR 본문 파일을 지운다. live 는 살아 있는 dispatch 의 지시서 실경로 집합이고 null 이면 둘 다 남긴다.
// root 는 지시서 폴더 실경로의 부모다. 지시서와 PR 본문은 그 아래에 있어 lib/spec.ts 의 「orch 루트 밖」 에 걸리지 않는다.
export function deleteSpecFiles(specsDir: string | null, name: string, apply: boolean, log: Log, live: Set<string> | null, branch: string, pr: Pr | null): void {
  if (!specsDir) return
  const prNumber = pr && truthy(pr.number) ? pr.number : undefined
  const { specs: named, prBodies } = specCandidates({ specsDir, name, branch, prNumber })
  const specs = [...new Set([...named, ...specsOnBranch(specsDir, branch)])]
  deleteSpecs({ root: dirname(realPath(specsDir)), specs, prBodies, live, mode: 'delete', apply, log: (line) => log(`  ${line}`) })
}

// 그 워크트리에 launch-worker 가 준 지시서(lib/launched.ts 의 기록)를 휴지통으로 옮긴다. 이름 규칙에 기대지 않는다.
// live 에 든 지시서(살아 있는 dispatch 가 쓴다)와 orch 루트 밖의 지시서는 남긴다. 지시서 폴더를 받지 않았으면 하지 않는다
export function trashLaunchedSpecs(repo: string, specsDir: string | null, path: string, apply: boolean, log: Log, live: Set<string> | null, trash: string): void {
  if (!specsDir) return
  const specs = [...new Set(launchesAt(repo, path).flatMap((launch) => (launch.spec ? [launch.spec] : [])))]
  if (specs.length === 0) return
  deleteSpecs({ root: dirname(realPath(specsDir)), specs, prBodies: [], live, mode: { trash }, apply, log: (line) => log(`  ${line}`) })
}

// 기능 PR 의 후속 검증이 끝나지 않았으면 지시서를 남긴다. 남기면 true 다.
// 지울 지시서 후보가 있을 때만 PR 본문을 읽는다. 워크트리와 브랜치는 후속 검증과 상관없이 지운다
export function specsKept(s: Sweep, path: string, name: string, branch: string, pr: Pr | null): boolean {
  const { repo, specsDir, log } = s
  if (!specsDir || pr?.state !== 'MERGED') return false
  const { specs: named, prBodies } = specCandidates({ specsDir, name, branch, prNumber: pr.number })
  const launched = launchesAt(repo, path).flatMap((launch) => (launch.spec ? [launch.spec] : []))
  if (named.length + prBodies.length + launched.length + specsOnBranch(specsDir, branch).length === 0) return false
  const pending = featureCompletionProblem(repo, String(pr.number), branch, specsDir, String(pr.body ?? ''))
  if (pending) log(`  지시서 남김: ${pending}`)
  return pending !== null
}

// specs.ts 파일 맨 위 설명의 「워크트리 없는 지시서」. --specs-dir 폴더 바로 아래 지시서의 `브랜치:` PR 이 모두 MERGED 이고 그 브랜치를 쓰는
// 워크트리가 없으면 휴지통으로 옮긴다. 워크트리가 먼저 지워진 지시서는 워크트리 순회가 만나지 못해 쌓이기 때문이다.
// 살아 있는 dispatch 가 쓰는 지시서와 기능 후속 검증이 남은 지시서는 남긴다. 판정 근거는 옮기기 전 한 줄로 낸다
function sweepStaleSpecs(repo: string, args: Args, checkedOut: Set<string>, specsDir: string | null, log: Log): void {
  if (!specsDir) return
  const dir: string = specsDir
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort()
  } catch {
    return
  }
  for (const name of names) {
    const file = join(dir, name)
    const branches = [...new Set(branchesOf(readText(file) ?? ''))]
    if (branches.length === 0) continue
    const proofs: string[] = []
    let keep = ''
    let last: Pr | null = null
    for (const branch of branches) {
      if (checkedOut.has(branch)) {
        keep = `브랜치 ${branch} 의 워크트리가 남아 있다`
        break
      }
      const listed = prList(repo, branch)
      const prs = listed.prs.filter((p) => !truthy(p.isCrossRepository) && p.headRefName === branch)
      if (!listed.ok) keep = `브랜치 ${branch} 의 PR 조회 실패`
      else if (prs.length === 0) keep = `브랜치 ${branch} 의 PR 이 없다`
      else if (prs.some((p) => p.state !== 'MERGED')) keep = `브랜치 ${branch} 에 머지되지 않은 PR 이 있다`
      if (keep) break
      // PR 목록은 만든 시각 역순이라 맨 앞이 최신이다. 후속 검증은 최신 PR 기준으로 본다
      const pr = prs[0]
      // 같은 이름을 다시 쓴 로컬 브랜치가 머지된 끝점과 다르면 새 작업이다
      const tip = branchTip(repo, branch)
      if (tip && truthy(pr.headRefOid) && tip !== String(pr.headRefOid)) {
        keep = `로컬 브랜치 ${branch} 의 끝점이 머지된 PR 과 다르다`
        break
      }
      last = pr
      proofs.push(`브랜치 ${branch} PR #${pr.number} MERGED`)
    }
    if (keep || !last) {
      if (keep && !keep.endsWith('PR 이 없다')) log(`워크트리 없는 지시서 남김 ${file}: ${keep}`)
      continue
    }
    const pending = featureCompletionProblem(repo, String(last.number), branches[0], specsDir, String(last.body ?? ''))
    if (pending) {
      log(`워크트리 없는 지시서 남김 ${file}: ${pending}`)
      continue
    }
    log(`워크트리 없는 지시서 판정 ${file}: ${proofs.join(', ')}, 그 브랜치의 워크트리 없음`)
    deleteSpecs({ root: dirname(realPath(specsDir)), specs: [file], prBodies: [], live: args.liveSpecs, mode: { trash: args.trash }, apply: args.apply, log: (line) => log(`  ${line}`) })
  }
}

export async function cleanupSpecs(ctx: StepContext, state: StepState): Promise<StepResult> {
  sweepStaleSpecs(ctx.repo, ctx.args, state.remaining, state.specsDir, ctx.log)
  return {}
}
