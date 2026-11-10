// PR 찾기 (브랜치마다):
//     로컬 브랜치 이름과 PR 의 head 브랜치 이름이 다르면(`<user>/<접두>-<주제>` 와 `<접두>/<주제>`) 이름 하나로는 못 찾는다.
//     아래 순서로 `gh pr list --head` 를 부르고 처음 나온 PR 을 쓴다. fork 에서 온 PR 은 건너뛴다.
//       1. 브랜치의 upstream 에서 읽은 원격 브랜치 이름
//       2. `git config branch.<b>.merge`
//       3. 로컬 브랜치 이름
//       4. 이름 변형(사용자 접두 제거, 첫 하이픈을 슬래시로). 지시서의 브랜치 이름으로 만들지 않은 옛 워크트리용이다
//     어느 이름으로 찾았든 브랜치 끝 커밋이 PR HEAD 와 같거나 그 조상일 때만 그 PR 을 쓴다.
//     base 위 커밋이 0 개인 브랜치는 끝 커밋이 PR HEAD 와 정확히 같을 때만 쓴다.
//     단, 머지 큐의 update-branch 뒤 merge commit 으로 머지돼 base 위 커밋이 0 개가 된 브랜치는 끝 커밋이
//     `gh pr view --json commits` 의 커밋 목록에 있을 때 그 PR 의 브랜치로 본다. 막 만든 브랜치의 끝 커밋은
//     base 의 옛 커밋이라 목록에 없고, 목록을 읽지 못해도 인정하지 않는다.
//     예전에 머지된 PR 과 이름만 같은 새 브랜치를 「머지됨」 으로 읽어 일하는 워크트리를 지우지 않으려는 것이다.
//     이름은 맞는데 이 검사에 걸린 PR 만 있으면 「이름만 같은 PR」 로 보고 PR 없음과 같이 다룬다.
//     조회 결과는 JSON 으로 읽는다. 빈 목록이면 「PR 없음」 이고, JSON 이 아니거나 필드가 없으면 「조회 실패」 다.
//     둘 다 머지로 읽지 않는다. PR HEAD 가 로컬에 없으면(머지 큐의 update-branch 로 앞서 간 경우) `refs/pull/<번호>/head` 를 받아 온다.
//     조회 필드의 title, isDraft, url 은 before-cleanup 의 pr 입력을 채우는 데만 쓰고 판정에는 쓰지 않는다.
//     author 는 그 입력과, CLOSED PR 이 내 PR 인지 가리는 데 쓴다(prs.ts 파일 맨 위 설명의 「내 PR」).
//
// 내 PR:
//     lib/gh.ts 의 ownAuthors 와 isOwnPr 로 가린다. 작성자는 config.json 의 pipeline.authors, 없으면 그 호스트의 gh 현재 사용자다.
//     호스트는 `gh repo view --json url` 의 URL 을 apiTarget 으로 읽는다.
//     목록은 --remote-branches 를 받았거나, 이 Run 의 끝난 worker 가 있는 CLOSED PR 을 처음 만났을 때 저장소마다 한 번 읽는다.
//     무조건 읽으면 pipeline.authors 가 없는 저장소의 모든 정리가 gh 현재 사용자를 조회하고, 그 조회가 실패하면 2 로 끝난다.
//     읽지 못하면(null 이거나 ConfigError) 그 저장소에서 원격 브랜치 정리와 CLOSED PR 의 터미널 정리를 하지 않고
//     stderr 에 이유를 내고 종료 코드를 2 로 둔다. 누가 내 PR 인지 모른 채 지우거나 닫지 않는다.
//
import { BY_PR, git, lines, truthy } from './shared.ts'
import { ConfigError } from '../../lib/config.ts'
import type { Log, Owners, Pr } from './shared.ts'
import { PrLookup, cachedMerged, rememberMerged } from '../../lib/pr-lookup.ts'
import { apiTarget, gh, ghJson, isOwnPr, ownAuthors } from '../../lib/gh.ts'
import { isObject } from '../../core/json.ts'

const MAX_VARIANTS = 4

// title, isDraft, url 은 before-cleanup 의 pr 입력용이다. author 는 그 입력과 CLOSED PR 의 내 PR 판정에 쓴다
const PR_FIELDS = 'number,state,headRefOid,headRefName,isCrossRepository,title,author,isDraft,url,body'

// 저장소마다 PR 조회를 묶는다(lib/pr-lookup.ts). 한 실행 안에서 같은 저장소는 같은 것을 쓴다
const lookups = new Map<string, PrLookup>()

export function lookupOf(repo: string): PrLookup {
  let found = lookups.get(repo)
  if (!found) {
    found = new PrLookup(repo, PR_FIELDS)
    lookups.set(repo, found)
  }
  return found
}

// 그 이름을 head 로 둔 PR 목록. 빈 목록은 ok 와 [] 다.
// JSON 이 아니거나 목록이 아니거나 state 가 모르는 값이면 ok 가 false 다. `null` 같은 문자열이 PR 로 읽히지 않게 한다.
export function prList(repo: string, head: string): { ok: boolean; prs: Pr[] } {
  return lookupOf(repo).list(head)
}

// 로컬 브랜치 `<user>/<접두>-<주제>` 에 대응할 법한 PR head 이름. `<접두>/<주제>` 가 대표적이다.
function nameVariants(branch: string): string[] {
  const slash = branch.indexOf('/')
  const rest = slash >= 0 ? branch.slice(slash + 1) : branch
  const names = rest !== branch ? [rest] : []
  let pos = -1
  const more = MAX_VARIANTS - names.length
  for (let i = 0; i < more; i++) {
    pos = rest.indexOf('-', pos + 1)
    if (pos <= 0) break
    names.push(`${rest.slice(0, pos)}/${rest.slice(pos + 1)}`)
  }
  return names
}

// [PR head 이름, 이름이 확실한지]. upstream, branch.<b>.merge, 로컬 이름이 확실하고 변형은 확인이 필요하다.
export function prCandidates(repo: string, branch: string): [string, boolean][] {
  const names: [string, boolean][] = []
  const remote = git(repo, 'config', '--get', `branch.${branch}.remote`).out
  const upstream = git(repo, 'for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`).out
  const prefix = `refs/remotes/${remote || 'origin'}/`
  if (upstream.startsWith(prefix)) names.push([upstream.slice(prefix.length), true])
  const merge = git(repo, 'config', '--get', `branch.${branch}.merge`).out
  if (merge.startsWith('refs/heads/')) names.push([merge.slice('refs/heads/'.length), true])
  names.push([branch, true])
  for (const name of nameVariants(branch)) names.push([name, false])
  const seen = new Set<string>()
  return names.filter(([name]) => {
    if (!name || seen.has(name)) return false
    seen.add(name)
    return true
  })
}

// PR HEAD 가 로컬에 없으면 `refs/pull/<번호>/head` 로 받아 온다. 머지 큐의 update-branch 로 앞서 간 HEAD 가 그런 경우다.
function ensureCommit(repo: string, pr: Pr): void {
  const head = pr.headRefOid
  if (!truthy(head) || git(repo, 'cat-file', '-e', `${String(head)}^{commit}`).code === 0) return
  git(repo, 'fetch', '-q', 'origin', `refs/pull/${pr.number}/head`)
}

// `gh pr view --json commits` 가 돌려주는 PR 의 커밋 해시 집합. 조회가 실패하거나 모양이 다르면 null 이다.
// update-branch 로 합친 머지 커밋도 목록에 든다. gh 는 커밋을 앞쪽 100 개까지만 준다.
function prCommitOids(repo: string, pr: Pr): Set<string> | null {
  const done = gh(['pr', 'view', String(pr.number), '--json', 'commits'], { cwd: repo })
  if (done.code !== 0) return null
  let data: unknown
  try {
    data = JSON.parse(done.stdout)
  } catch {
    return null
  }
  if (!isObject(data) || !Array.isArray(data.commits)) return null
  const oids = new Set<string>()
  for (const commit of data.commits) if (isObject(commit) && typeof commit.oid === 'string') oids.add(commit.oid)
  return oids
}

// 그 PR 이 이 브랜치의 것인지. 끝 커밋이 PR HEAD 와 같거나 그 조상이어야 한다.
//
// base 위 커밋이 0 개면 막 만든 브랜치일 수 있다. 그 끝 커밋은 옛 PR HEAD 의 조상(base 의 옛 커밋)이기도 하므로
// PR HEAD 와 정확히 같을 때만 인정하는 것이 기본이다. 다만 머지 큐의 update-branch 로 PR HEAD 가 앞서 가고
// 저장소가 merge commit 으로 머지하면, 머지 뒤 브랜치의 커밋이 모두 base 에 들어가 0 개이면서 끝 커밋이 PR HEAD 와 다르다.
// 이때는 끝 커밋이 그 PR 의 커밋 목록에 있을 때만 인정한다. 막 만든 브랜치의 끝 커밋은 base 의 옛 커밋이라 목록에 없다.
// 목록을 읽지 못하면 인정하지 않는다.
function belongsTo(repo: string, ref: string, base: string, pr: Pr): boolean {
  const head = pr.headRefOid
  if (!truthy(head)) return false
  const tip = git(repo, 'rev-parse', '--verify', '-q', `${ref}^{commit}`)
  if (tip.code !== 0) return false
  if (tip.out === head) return true
  const count = git(repo, 'rev-list', '--count', `origin/${base}..${ref}`)
  if (count.code !== 0) return false
  if (count.out === '' || count.out === '0') return (prCommitOids(repo, pr) ?? new Set()).has(tip.out)
  return git(repo, 'merge-base', '--is-ancestor', ref, String(head)).code === 0
}

export function branchTip(repo: string, branch: string): string {
  const tip = git(repo, 'rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`)
  return tip.code === 0 ? tip.out : ''
}

// 그 브랜치의 PR. 조회 실패가 있었는지(failed), 이름만 같은 PR 이 있었는지(foreign)도 낸다.
// 끝 커밋이 그대로인 브랜치의 MERGED PR 은 남긴 것을 쓰고 gh 를 부르지 않는다(lib/pr-lookup.ts 의 cachedMerged)
function findPr(repo: string, branch: string, base: string): { pr: Pr | null; failed: boolean; foreign: boolean } {
  const tip = branchTip(repo, branch)
  const cached = tip ? cachedMerged(repo, branch, tip) : null
  if (cached) return { pr: cached, failed: false, foreign: false }
  let failed = false
  let foreign = false
  for (const [name] of prCandidates(repo, branch)) {
    const listed = prList(repo, name)
    if (!listed.ok) {
      failed = true
      continue
    }
    for (const pr of listed.prs) {
      if (truthy(pr.isCrossRepository)) continue
      ensureCommit(repo, pr)
      if (belongsTo(repo, `refs/heads/${branch}`, base, pr)) {
        if (pr.state === 'MERGED') rememberMerged(repo, branch, tip, pr)
        return { pr, failed, foreign }
      }
      foreign = true
    }
  }
  return { pr: null, failed, foreign }
}

// 이번 실행에서 PR 을 찾을 브랜치들의 이름을 한 번에 읽어 둔다. 끝 커밋이 그대로인 MERGED 브랜치는 뺀다
export function prefetchPrs(repo: string, branches: Iterable<string>): void {
  const names: string[] = []
  for (const branch of branches) {
    const tip = branchTip(repo, branch)
    if (!tip || cachedMerged(repo, branch, tip)) continue
    for (const [name] of prCandidates(repo, branch)) names.push(name)
  }
  lookupOf(repo).prefetch(names)
}

// noPr: PR 이 없어서 정리하지 않은 것(조회 실패는 아니다). 「PR 없이 끝난 워크트리」 판정의 대상이다
type Merged = { ok: boolean; mergedHead: string | null; why: string; pr: Pr | null; noPr?: boolean }

export function merged(repo: string, branch: string, base: string): Merged {
  const { pr, failed, foreign } = findPr(repo, branch, base)
  if (pr && pr.state === 'MERGED') {
    return { ok: true, mergedHead: truthy(pr.headRefOid) ? String(pr.headRefOid) : null, why: BY_PR, pr }
  }
  const state = pr ? pr.state : failed ? '조회 실패' : foreign ? '이름만 같은 PR(이 브랜치의 커밋이 아니다)' : '없음'
  const track = git(repo, 'for-each-ref', '--format=%(upstream:track)', `refs/heads/${branch}`).out
  if (track !== '[gone]') return { ok: false, mergedHead: null, why: `PR ${state}, upstream 이 남아 있다`, pr, noPr: !pr && !failed }
  const cherry = git(repo, 'cherry', `origin/${base}`, branch)
  if (cherry.code !== 0) return { ok: false, mergedHead: null, why: 'git cherry 실패', pr }
  const plus = lines(cherry.out).filter((line) => line.startsWith('+')).length
  if (plus) return { ok: false, mergedHead: null, why: `upstream gone 이지만 base 에 없는 커밋 ${plus} 개`, pr }
  return { ok: true, mergedHead: null, why: 'upstream gone, base 에 없는 커밋 0 개', pr }
}

// 원격에도 머지된 PR HEAD 에도 없는 커밋 수. cherry 로 판정했으면 이미 base 에 있으므로 0 이다. 확인하지 못하면 -1 이다.
export function unpushed(repo: string, ref: string, mergedHead: string | null, byCherry: boolean): number {
  if (byCherry) return 0
  const args = ['rev-list', ref, '--not', '--remotes']
  if (mergedHead && git(repo, 'cat-file', '-e', `${mergedHead}^{commit}`).code === 0) args.push(mergedHead)
  const done = git(repo, ...args)
  return done.code === 0 ? lines(done.out).length : -1
}

export function protectedReason(repo: string, branch: string, base: string): string | null {
  if (branch === base || branch.startsWith('release/')) return '기준 브랜치나 release 브랜치'
  // 열린 PR 의 base 목록을 저장소마다 한 번 읽는다. 읽지 못했거나 잘렸으면 이 이름만 따로 묻는다
  const bases = lookupOf(repo).openBases()
  if (bases) return bases.has(branch) ? '다른 열린 PR 의 base 이거나 조회 실패' : null
  const done = gh(['pr', 'list', '--state', 'open', '--base', branch, '--json', 'number', '--jq', 'length'], { cwd: repo })
  if (done.code !== 0 || (done.stdout.trim() !== '' && done.stdout.trim() !== '0')) return '다른 열린 PR 의 base 이거나 조회 실패'
  return null
}

type RemotePlan = { names: string[]; expect: string | null }

// 지울 원격 브랜치 이름과, 그 끝점이 가져야 할 커밋. 로컬 브랜치를 지우기 전에 만든다.
export function remotePlan(repo: string, branch: string, pr: Pr | null): RemotePlan {
  const names = prCandidates(repo, branch)
    .filter(([, exact]) => exact)
    .map(([name]) => name)
  if (pr && !truthy(pr.isCrossRepository) && truthy(pr.headRefName)) names.unshift(String(pr.headRefName))
  const expect =
    pr && pr.state === 'MERGED' ? (truthy(pr.headRefOid) ? String(pr.headRefOid) : null) : git(repo, 'rev-parse', `refs/heads/${branch}`).out
  return { names: [...new Set(names)], expect }
}

export function deleteRemote(repo: string, plan: RemotePlan, base: string, apply: boolean, log: Log): void {
  for (const name of plan.names) {
    const reason = protectedReason(repo, name, base)
    if (reason) {
      log(`  원격 브랜치 남김 ${name}: ${reason}`)
      continue
    }
    const listed = git(repo, 'ls-remote', '--heads', 'origin', `refs/heads/${name}`)
    if (listed.code !== 0) {
      log(`  원격 브랜치 확인 실패 ${name}`)
      continue
    }
    if (!listed.out) {
      log(`  원격 브랜치 이미 없음 ${name}`)
      continue
    }
    const tip = listed.out.split(/\s+/)[0]
    if (plan.expect && tip !== plan.expect) {
      log(`  원격 브랜치 남김 ${name}: 끝점이 머지된 커밋과 다르다`)
      continue
    }
    if (apply) {
      const done = git(repo, 'push', '-q', 'origin', '--delete', name)
      log(done.code === 0 ? `  원격 브랜치 삭제 ${name}` : `  원격 브랜치 삭제 실패 ${name}: ${done.err}`)
    } else {
      log(`  원격 브랜치를 지울 것 ${name}`)
    }
  }
}

// 작성자 목록을 저장소마다 처음 쓸 때 한 번 읽는다. prs.ts 파일 맨 위 설명의 「내 PR」 이 정한다.
// 읽지 못하면(null 이거나 ConfigError) onFail 을 한 번 부르고, 그 뒤로도 null 을 돌려준다
export function ownersOf(repo: string, onFail: (why: string) => void): Owners {
  let read = false
  let found: string[] | null = null
  return () => {
    if (read) return found
    read = true
    try {
      const view = ghJson<unknown>(['repo', 'view', '--json', 'url'], { cwd: repo })
      const url = view.ok && isObject(view.data) && typeof view.data.url === 'string' ? view.data.url : ''
      const host = apiTarget(url)?.host
      if (!view.ok) onFail(view.error)
      else if (!host) onFail(`gh repo view 의 URL 을 읽지 못했다: ${JSON.stringify(url)}`)
      else {
        found = ownAuthors(repo, host)
        if (!found) onFail(`${host} 의 gh api user 실패. config.json 의 pipeline.authors 로 준다`)
      }
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e
      onFail(e.message)
    }
    return found
  }
}

// 작성자를 읽지 못한 PR 은 내 PR 로 보지 않는다
export function ownPr(pr: Pr, authors: string[]): boolean {
  const login = isObject(pr.author) && typeof pr.author.login === 'string' ? pr.author.login : ''
  return login !== '' && isOwnPr({ author: { login } }, authors)
}

export function hasCommit(repo: string, oid: string): boolean {
  return git(repo, 'cat-file', '-e', `${oid}^{commit}`).code === 0
}
