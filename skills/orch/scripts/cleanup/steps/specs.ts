// 워크트리 없는 지시서 (저장소마다 리뷰 흔적 뒤에 한 번. --specs-dir 를 줬을 때):
//     워크트리가 먼저 지워지면 worktrees.ts 의 워크트리 순회가 그 지시서를 만나지 못해 쌓인다. --specs-dir 바로 아래 .md 가운데
//     spec-common.md 를 뺀 지시서마다 아래로 정한다(references/overlay.md 「orch 작업 폴더」 의 specs 줄).
//       - 그 브랜치를 쓰는 워크트리가 있거나, 열린 PR 이 있거나, PR 조회가 실패하면 남긴다
//       - 줄의 브랜치마다 PR 이 있고 모두 MERGED 면 바로 옮긴다. 같은 이름의 로컬 브랜치가 있으면 끝점이 머지된 PR 의 headRefOid 와 같아야 하고,
//         기능 PR 의 후속 검증(featureCompletionProblem)과 배포 뒤 할 일(followups.json 의 끝나지 않은 항목)이 대기가 아니어야 한다
//       - 그 밖(`브랜치:` 줄이 없거나, PR 이 없거나, 닫힌 PR 뿐이거나 섞였다)은 마지막 수정 뒤 cleanup.specs_days(기본 3)일이 지나면 옮긴다.
//         머지된 PR 이 하나라도 있으면 그 PR 의 후속 검증과 배포 뒤 할 일을 먼저 보고, 대기면 남긴다
//       - 살아 있는 dispatch 가 가리키는 지시서가 아니고 orch 루트 안이다(deleteSpecs)
//     옮기기 전 `워크트리 없는 지시서 판정 <경로>: <근거>` 한 줄을 낸다.
//     남기는 이유는 `워크트리 없는 지시서 남김 <경로>: <이유>` 로 낸다(기한 안이라 남기는 지시서는 줄 없이 남긴다)
//
import type { Args, Log, Pr, Sweep } from './shared.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { branchTip, prList } from './prs.ts'
import { branchesOf, deleteSpecs, specCandidates, specsOnBranch } from '../../lib/spec.ts'
import { dirname, join } from 'node:path'
import { featureCompletionProblem } from '../../lib/feature-evidence.ts'
import { launchesAt } from '../../lib/launched.ts'
import { readText, truthy } from './shared.ts'
import { readdirSync, statSync } from 'node:fs'
import { SWEEP_RETENTION_DAYS } from '../../core/config.ts'
import { CLEANUP_KEYS, ConfigError, loadConfig, section } from '../../lib/config.ts'
import { loadFollowups } from '../../lib/followups.ts'
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
// 지울 지시서 후보가 있을 때만 PR 본문을 읽는다. 기능 PR 의 후속 검증이 대기면 worktrees.ts 가 그 앞에서 워크트리까지 남기므로,
// 여기는 기능 PR 로 알아보지 못한 PR 의 지시서를 지키는 자리다
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

// specs.ts 파일 맨 위 설명의 「워크트리 없는 지시서」. 판정 근거는 옮기기 전 한 줄로 낸다
function sweepStaleSpecs(repo: string, args: Args, checkedOut: Set<string>, specsDir: string | null, log: Log, specsDays: number, now: number): void {
  if (!specsDir) return
  const dir: string = specsDir
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.md') && name !== 'spec-common.md').sort()
  } catch {
    return
  }
  const trash = (file: string, proof: string) => {
    log(`워크트리 없는 지시서 판정 ${file}: ${proof}`)
    deleteSpecs({ root: dirname(realPath(specsDir)), specs: [file], prBodies: [], live: args.liveSpecs, mode: { trash: args.trash }, apply: args.apply, log: (line) => log(`  ${line}`) })
  }
  const old = (file: string) => {
    try { return statSync(file).mtimeMs < now - specsDays * 86_400_000 } catch { return false }
  }
  for (const name of names) {
    const file = join(dir, name)
    const branches = [...new Set(branchesOf(readText(file) ?? ''))]
    const proofs: string[] = []
    let keep = ''
    // 열린 PR 에도 머지에도 속하지 않는다(브랜치 줄 없음, PR 없음, 닫힌 PR 뿐). 기한이 지나야 옮긴다
    let orphan = branches.length === 0 ? '`브랜치:` 줄이 없다' : ''
    let last: Pr | null = null
    for (const branch of branches) {
      if (checkedOut.has(branch)) {
        keep = `브랜치 ${branch} 의 워크트리가 남아 있다`
        break
      }
      const listed = prList(repo, branch)
      const prs = listed.prs.filter((p) => !truthy(p.isCrossRepository) && p.headRefName === branch)
      if (!listed.ok) keep = `브랜치 ${branch} 의 PR 조회 실패`
      else if (prs.some((p) => p.state === 'OPEN')) keep = `브랜치 ${branch} 에 열린 PR 이 있다`
      if (keep) break
      // PR 목록은 만든 시각 역순이라 맨 앞이 최신이다. 후속 검증은 가장 최근에 머지된 PR 기준으로 본다.
      // 옛 CLOSED PR 과 새 MERGED PR 이 섞여도 머지된 PR 의 후속 검증을 먼저 본다(머지된 PR 이 없을 때만 기한 판정으로 간다)
      const merged = prs.filter((p) => p.state === 'MERGED')
      if (merged.length === 0) {
        orphan ||= prs.length === 0 ? `브랜치 ${branch} 의 PR 이 없다` : `브랜치 ${branch} 의 PR 이 닫혔다`
        continue
      }
      if (merged.length < prs.length) orphan ||= `브랜치 ${branch} 에 닫힌 PR 이 섞였다`
      const pr = merged[0]
      // 같은 이름을 다시 쓴 로컬 브랜치가 머지된 끝점과 다르면 새 작업이다
      const tip = branchTip(repo, branch)
      if (tip && truthy(pr.headRefOid) && tip !== String(pr.headRefOid)) {
        keep = `로컬 브랜치 ${branch} 의 끝점이 머지된 PR 과 다르다`
        break
      }
      last = pr
      proofs.push(`브랜치 ${branch} PR #${pr.number} MERGED`)
    }
    if (keep) {
      log(`워크트리 없는 지시서 남김 ${file}: ${keep}`)
      continue
    }
    if (last) {
      const pending = featureCompletionProblem(repo, String(last.number), branches[0], specsDir, String(last.body ?? ''))
        ?? (loadFollowups(repo).some((f) => f.pr === Number(last!.number) && !f.done_at) ? `PR #${last.number} 의 배포 뒤 할 일이 남았다` : null)
      if (pending) {
        log(`워크트리 없는 지시서 남김 ${file}: ${pending}`)
        continue
      }
    }
    if (orphan) {
      if (old(file)) trash(file, `${[...proofs, orphan].join(', ')}, ${specsDays}일 넘게 바뀌지 않았다`)
      continue
    }
    trash(file, `${proofs.join(', ')}, 그 브랜치의 워크트리 없음`)
  }
}

export async function cleanupSpecs(ctx: StepContext, state: StepState): Promise<StepResult> {
  const config = section<Record<string, unknown>>(loadConfig(ctx.repo), 'cleanup', CLEANUP_KEYS)
  const raw = config.specs_days
  const days = raw === undefined || raw === null ? SWEEP_RETENTION_DAYS.specs_days : Number(raw)
  if (!Number.isFinite(days) || days < 0) throw new ConfigError('cleanup.specs_days 는 0 이상의 유한한 수여야 한다')
  sweepStaleSpecs(ctx.repo, ctx.args, state.remaining, state.specsDir, ctx.log, days, Date.now())
  return {}
}
