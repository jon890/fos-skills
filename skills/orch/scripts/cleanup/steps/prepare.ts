// routing 기록 (--apply일 때, --run과 무관):
//     최근 띄우기 이력의 브랜치에서 머지 없이 닫힌 PR과 마무리 표시가 없는 머지 PR만 기록한다.
//     마무리가 worker 종료를 기다리는 동안에는 finish-pr이 기록하도록 맡긴다. 기록 실패는 정리를 막지 않는다.
//     ORCA_USAGE_DIR로 토큰 사용량 폴더를 바꾼다. 기록 형식과 수집은 lib/routing-log.ts가 소유한다.
//
// 기준 브랜치 따라가기 (저장소마다 맨 처음):
//     기본 체크아웃이 기준 브랜치에 있고 origin/<기준> 의 조상이면 `git merge --ff-only` 로 맞춘다.
//     로컬에만 있는 커밋이 있거나 다른 브랜치가 체크아웃돼 있으면 건드리지 않고 이유를 낸다.
//     기준 브랜치가 뒤처지면 그 위에서 계획한 worker 가 옛 코드를 본다.
//
import type { Args, Log, Report } from './shared.ts'
import { RepoError, err, git, lines, worktrees } from './shared.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { defaultBase } from '../../lib/git.ts'
import { isAbsolute, join } from 'node:path'
import { isLive } from '../../lib/worker-state.ts'
import { ownersOf, prefetchPrs } from './prs.ts'
import { requireMigrated } from '../../lib/paths.ts'
import { sweepRouting } from '../../lib/routing-log.ts'
import { workersAt } from './terminals.ts'

// 기본 체크아웃이 기준 브랜치에 있으면 origin/<기준> 으로 fast-forward 한다.
function followBase(repo: string, base: string, apply: boolean, log: Log): void {
  const current = git(repo, 'branch', '--show-current').out
  if (current !== base) return
  const head = git(repo, 'rev-parse', 'HEAD')
  const remote = git(repo, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`)
  if (head.code || remote.code || head.out === remote.out) return
  const range = `${head.out.slice(0, 8)}..${remote.out.slice(0, 8)}`
  if (git(repo, 'merge-base', '--is-ancestor', head.out, remote.out).code !== 0) {
    log(`기준 브랜치를 맞추지 않는다: ${base} 에 origin/${base} 에 없는 커밋이 있다`)
    return
  }
  if (!apply) {
    log(`기준 브랜치를 fast-forward 할 것 ${base} ${range}`)
    return
  }
  const done = git(repo, 'merge', '--ff-only', '-q', `origin/${base}`)
  log(done.code === 0 ? `기준 브랜치 fast-forward ${base} ${range}` : `기준 브랜치 fast-forward 실패 ${base}: ${done.err}`)
}

export async function prepare(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { repo, workers, log } = ctx
  const given = ctx.args
  const base = given.base || (defaultBase(repo) ?? 'main')
  const args: Args = { ...given, base }
  ctx.args = args
  if (!args.specsDir && !requireMigrated(repo, 'cleanup-sweep', '지시서 폴더를 --specs-dir 로 직접 준다')) {
    throw new RepoError(`${repo}: orch 작업 폴더를 옮기기 전이라 건너뛴다`)
  }
  const specsDir = args.specsDir ? (isAbsolute(args.specsDir) ? args.specsDir : join(repo, args.specsDir)) : null
  git(repo, 'fetch', '-q', '--prune', 'origin')
  log(`cleanup-sweep ${args.apply ? 'apply' : 'dry-run'}: ${repo} (base ${base})`)
  followBase(repo, base, args.apply, log)
  // 폴더가 이미 없는 워크트리 등록을 먼저 지운다. 남으면 그 브랜치 삭제가 `used by worktree` 로 거절된다
  // -v 의 목록은 stderr 로 나온다
  const pruned = git(repo, 'worktree', 'prune', '-v', ...(args.apply ? [] : ['-n'])).err
  for (const line of lines(pruned)) log(`prune: ${line}`)
  const report: Report = { removed: [], skipped: [] }
  const owners = ownersOf(repo, (why) => {
    err(`cleanup-sweep: ${repo}: 내 PR 의 작성자를 정하지 못해 원격 브랜치 정리와 CLOSED PR 의 터미널 정리를 하지 않는다: ${why}`)
    state.code = 2
  })
  if (args.apply) await sweepRouting(repo)
  const listed = worktrees(repo)
  // PR 을 찾을 브랜치(살아 있는 worker 의 워크트리를 뺀 것과 워크트리 없는 로컬 브랜치)의 이름을 한 번에 읽어 둔다(lib/pr-lookup.ts)
  const locals = lines(git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').out)
  const checkedOut = new Set([...listed.map(([, branch]) => branch), git(repo, 'branch', '--show-current').out])
  prefetchPrs(repo, [
    ...listed.filter(([path, branch]) => branch && !workersAt(workers, path).some(isLive)).map(([, branch]) => branch),
    ...locals.filter((branch) => !checkedOut.has(branch) && branch !== base && !branch.startsWith('release/')),
  ])
  return { report, listed, specsDir, owners }
}
