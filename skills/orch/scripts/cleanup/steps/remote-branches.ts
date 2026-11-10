// 원격 브랜치 삭제:
//     지울 이름은 PR 의 head 브랜치, upstream, `branch.<b>.merge`, 로컬 이름이다. 이름마다 기준 브랜치, `release/*`,
//     다른 열린 PR 의 base 는 지우지 않는다. 원격 끝점이 머지된 PR HEAD(PR 이 없으면 로컬 브랜치 끝점)와 다르면
//     그 뒤에 커밋이 더해진 것이므로 지우지 않는다. fork 에서 온 PR 의 head 이름은 쓰지 않는다.
//
//     --remote-branches 는 로컬 브랜치와 상관없이 내 PR 의 원격 브랜치를 판정한다. 기본은 지울 것만 보이고,
//     --apply 이면 `git push origin --delete` 로 지운다. 판정한 끝점을 --force-with-lease 로 걸어, 그사이 push 된 브랜치는 지우지 않는다.
//     후보는 작성자마다 `gh pr list --state closed --author <작성자> --limit 100`(MERGED 와 CLOSED 가 함께 온다),
//     `git ls-remote --heads origin` 한 번, 열린 PR 의 base 와 head(`gh pr list --state open --limit 1000`) 한 번,
//     로컬 브랜치와 그 upstream(`git for-each-ref refs/heads/`) 한 번으로 읽는다.
//     하나라도 읽지 못하면 그 저장소의 원격 브랜치를 지우지 않고 `원격 브랜치 정리 건너뜀: <이유>` 를 내고 종료 코드를 2 로 둔다.
//     열린 PR 이 limit 과 같은 1000 개 읽혔으면 목록이 잘렸을 수 있어 읽지 못한 것과 같게 다룬다.
//     원격에 있는 이름마다 한 번 판정한다. 그 이름을 head 로 둔 PR 가운데 headRefOid 가 원격 끝점과 같은 PR 을 쓴다.
//     원격에 없는 이름은 줄을 내지 않는다. 위에서부터 처음 걸린 줄로 정한다.
//
//     3 과 4 는 워크트리와 로컬 브랜치 정리가 끝난 뒤의 목록으로 본다. 남은 브랜치는 아직 그 원격 브랜치로 push 할 수 있다.
//     dry-run 은 워크트리를 지우지 않으므로, 이번에 지울 워크트리의 원격 브랜치도 3 으로 남긴다고 낸다.
//     그 원격 브랜치는 워크트리 정리의 「원격 브랜치 삭제」 가 지운다
//
//     origin/<baseRefName> 은 저장소마다 처음에 하는 `git fetch -q --prune origin` 이 갱신한 원격 추적 브랜치다.
//     출력은 `원격 브랜치 남김 <이름>: <이유>`, `원격 브랜치를 지울 것 <이름> (#<PR> <state>)`,
//     `원격 브랜치 삭제 <이름> (#<PR> <state>)`, `원격 브랜치 삭제 실패 <이름>: <오류>` 다.
//     열린 PR 의 base 인 브랜치는 base 를 옮기지 않고 남긴다. 머지 큐의 deleteBranch 는 머지 직후에 그 브랜치를 base 로 둔
//     내 PR 의 base 를 옮기지만, 이 정리는 머지 직후가 아닌 뒤늦은 정리라 열린 PR 의 base 를 바꾸는 판단을 하지 않는다.


// --remote-branches 가 읽는 닫힌 PR 의 필드. --state closed 는 MERGED 와 CLOSED 를 함께 준다
import type { Log, Owners } from './shared.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { ghJson } from '../../lib/gh.ts'
import { git, lines } from './shared.ts'
import { hasCommit } from './prs.ts'
import { isObject } from '../../core/json.ts'

const CLOSED_FIELDS = 'number,state,headRefName,headRefOid,baseRefName,isCrossRepository,mergedAt,body'

const OPEN_PR_LIMIT = 1000

type ClosedPr = { body?: string; number: number; state: string; headRefName: string; headRefOid: string; baseRefName: string; isCrossRepository: boolean }

// `gh pr list` 의 JSON 목록. 실패하거나 목록이 아니면 이유 문자열이다
function ghList(repo: string, args: string[]): unknown[] | string {
  const done = ghJson<unknown>(args, { cwd: repo })
  if (!done.ok) return done.error
  return Array.isArray(done.data) ? done.data : `gh ${args.join(' ')} 의 출력이 목록이 아니다`
}

function isClosedPr(pr: unknown): pr is ClosedPr {
  return (
    isObject(pr) &&
    Number.isInteger(pr.number) &&
    (pr.state === 'MERGED' || pr.state === 'CLOSED') &&
    typeof pr.headRefName === 'string' &&
    pr.headRefName !== '' &&
    typeof pr.headRefOid === 'string' &&
    pr.headRefOid !== '' &&
    typeof pr.baseRefName === 'string' &&
    typeof pr.isCrossRepository === 'boolean'
  )
}

// 작성자마다 닫힌 PR 을 읽는다. 하나라도 실패하거나 형식이 다르면 이유 문자열이다
function closedPrs(repo: string, authors: string[]): ClosedPr[] | string {
  const prs: ClosedPr[] = []
  for (const author of authors) {
    const listed = ghList(repo, ['pr', 'list', '--state', 'closed', '--author', author, '--limit', '100', '--json', CLOSED_FIELDS])
    if (typeof listed === 'string') return listed
    for (const pr of listed) {
      if (!isClosedPr(pr)) return `gh pr list --author ${author} 의 PR 형식이 다르다`
      prs.push(pr)
    }
  }
  return prs
}

// 원격 브랜치 이름에서 끝점으로
function remoteHeads(repo: string): Map<string, string> | string {
  const done = git(repo, 'ls-remote', '--heads', 'origin')
  if (done.code !== 0) return `git ls-remote 실패: ${done.err}`
  const heads = new Map<string, string>()
  for (const line of lines(done.out)) {
    const [oid, ref] = line.split(/\s+/)
    if (oid && ref?.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), oid)
  }
  return heads
}

// 열린 PR 의 base 와 head 이름. 열린 PR 의 head 는 지우면 그 PR 이 닫히므로 함께 남긴다
// limit 만큼 읽혔으면 뒤가 잘렸을 수 있다. 잘린 목록으로는 열린 PR 의 base 와 head 를 지켜 주지 못한다
function openRefs(repo: string): { bases: Set<string>; heads: Set<string> } | string {
  const listed = ghList(repo, ['pr', 'list', '--state', 'open', '--limit', String(OPEN_PR_LIMIT), '--json', 'baseRefName,headRefName'])
  if (typeof listed === 'string') return listed
  if (listed.length >= OPEN_PR_LIMIT) return `열린 PR 이 ${OPEN_PR_LIMIT} 개 이상이라 목록을 다 읽었는지 알 수 없다`
  const bases = new Set<string>()
  const heads = new Set<string>()
  for (const pr of listed) {
    if (!isObject(pr) || typeof pr.baseRefName !== 'string' || typeof pr.headRefName !== 'string') return '열린 PR 목록의 형식이 다르다'
    bases.add(pr.baseRefName)
    heads.add(pr.headRefName)
  }
  return { bases, heads }
}

// 남은 로컬 브랜치가 쓰는 원격 브랜치 이름에서 남길 이유로. worktreeBranches 는 정리 뒤 남은 워크트리의 브랜치다.
// 워크트리의 브랜치는 이름 자체와 upstream 을, 워크트리 없는 로컬 브랜치는 upstream 만 본다. 읽지 못하면 이유 문자열이다
function usedRemoteNames(repo: string, worktreeBranches: Set<string>): Map<string, string> | string {
  const listed = git(repo, 'for-each-ref', '--format=%(refname:short)%00%(upstream)', 'refs/heads/')
  if (listed.code !== 0) return `로컬 브랜치를 읽지 못했다: ${listed.err}`
  const used = new Map<string, string>()
  const remote = 'refs/remotes/origin/'
  for (const line of lines(listed.out)) {
    const [branch, upstream = ''] = line.split('\0')
    const name = upstream.startsWith(remote) ? upstream.slice(remote.length) : ''
    if (worktreeBranches.has(branch)) {
      used.set(branch, '워크트리가 쓴다')
      if (name) used.set(name, '워크트리가 쓴다')
    } else if (name && !used.has(name)) {
      used.set(name, '로컬 브랜치가 쓴다')
    }
  }
  return used
}

// 원격 브랜치 하나의 판정. 지울 PR 이나 남길 이유다. 차례는 머리 주석의 「원격 브랜치 정리」 표다
function remoteVerdict(
  repo: string,
  name: string,
  tip: string,
  prs: ClosedPr[],
  base: string,
  open: { bases: Set<string>; heads: Set<string> },
  used: Map<string, string>,
): { pr: ClosedPr } | { keep: string } {
  if (prs.some((pr) => pr.isCrossRepository)) return { keep: 'fork 의 브랜치다' }
  if (name === base || name.startsWith('release/')) return { keep: '보호 브랜치다' }
  const user = used.get(name)
  if (user) return { keep: user }
  const same = prs.filter((pr) => pr.headRefOid === tip)
  const pr = same.find((p) => p.state === 'MERGED') ?? same[0]
  if (!pr) return { keep: '원격 끝점이 PR head 와 다르다' }
  if (open.bases.has(name)) return { keep: '열린 PR 의 base 다' }
  if (open.heads.has(name)) return { keep: '열린 PR 의 head 다' }
  if (pr.state === 'MERGED') return { pr }
  if (!hasCommit(repo, tip)) {
    git(repo, 'fetch', '-q', 'origin', pr.headRefName)
    if (!hasCommit(repo, tip)) return { keep: 'head 커밋을 받지 못했다' }
  }
  const target = `refs/remotes/origin/${pr.baseRefName}`
  if (!pr.baseRefName || git(repo, 'rev-parse', '--verify', '-q', target).code !== 0) return { keep: 'base 를 찾지 못했다' }
  if (git(repo, 'merge-base', '--is-ancestor', tip, target).code === 0) return { pr }
  return { keep: 'CLOSED 이고 head 가 base 에 없다' }
}

// --remote-branches. 후보를 모두 읽은 뒤에 지운다. 하나라도 읽지 못하면 아무것도 지우지 않고 false 다
// worktreeBranches 는 워크트리 정리 뒤 남은 워크트리의 브랜치다
function sweepRemoteBranches(repo: string, base: string, apply: boolean, owners: Owners, worktreeBranches: Set<string>, log: Log): boolean {
  const skipped = (why: string): boolean => {
    log(`원격 브랜치 정리 건너뜀: ${why}`)
    return false
  }
  const authors = owners()
  if (!authors) return skipped('내 PR 의 작성자를 정하지 못했다')
  const prs = closedPrs(repo, authors)
  if (typeof prs === 'string') return skipped(prs)
  const heads = remoteHeads(repo)
  if (typeof heads === 'string') return skipped(heads)
  const open = openRefs(repo)
  if (typeof open === 'string') return skipped(open)
  const used = usedRemoteNames(repo, worktreeBranches)
  if (typeof used === 'string') return skipped(used)
  const byName = new Map<string, ClosedPr[]>()
  for (const pr of prs) byName.set(pr.headRefName, [...(byName.get(pr.headRefName) ?? []), pr])
  for (const [name, group] of byName) {
    const tip = heads.get(name)
    if (tip === undefined) continue
    const verdict = remoteVerdict(repo, name, tip, group, base, open, used)
    if ('keep' in verdict) {
      log(`원격 브랜치 남김 ${name}: ${verdict.keep}`)
      continue
    }
    const tag = `(#${verdict.pr.number} ${verdict.pr.state})`
    if (!apply) {
      log(`원격 브랜치를 지울 것 ${name} ${tag}`)
      continue
    }
    // 판정한 끝점일 때만 지운다. 그사이 push 된 커밋이 있으면 거부된다
    const done = git(repo, 'push', '-q', `--force-with-lease=refs/heads/${name}:${tip}`, 'origin', '--delete', name)
    log(done.code === 0 ? `원격 브랜치 삭제 ${name} ${tag}` : `원격 브랜치 삭제 실패 ${name}: ${done.err}`)
  }
  return true
}

export async function cleanupRemoteBranches(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { repo, args, log } = ctx
  if (args.remoteBranches && !sweepRemoteBranches(repo, args.base, args.apply, state.owners, state.remaining, log)) return { code: 2 }
  return {}
}
