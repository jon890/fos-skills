// draft PR 을 ready 로 바꿔 CI 를 시작한다. 이미 ready 인 다른 PR 과 파일이 겹치거나 base 와 충돌하면 보류한다.
//
// draft PR 에서는 CI 가 돌지 않게 해 둔 저장소용이다. 오버레이가 켠 저장소에서만 쓴다.
// 겹친 PR 둘을 함께 ready 로 바꾸면, 앞 PR 이 머지된 뒤 뒤 PR 을 base 와 합쳐 CI 를 다시 돌려야 한다.
// 겹친 PR 이 먼저 머지되기를 기다렸다가 바꾸면 CI 가 한 번만 돈다.
// base 와 충돌하는 PR 은 worker 가 base 를 합친 뒤에 바꾼다. 충돌한 채로 돈 CI 는 버려진다.
//
// 사용법:
//     ci-ready.ts [--repo DIR] [--dry-run] PR [PR ...]
//
//     --repo     대상 저장소 체크아웃. 기본은 현재 디렉터리. gh 는 이 저장소의 origin 으로 호스트를 찾는다
//     --dry-run  ready 로 바꾸지 않고 판정만 낸다. 이벤트도 내지 않는다. 핸들러가 바깥에 부작용을 낼 수 있어서다
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts)
//
// PR 마다 (받은 순서대로):
//     1. OPEN 이 아니면 보류, 이미 ready 면 건너뛴다
//     2. 내 PR 이 아니면 보류한다. 작성자 목록은 config.json 의 pipeline.authors, 없으면 PR URL 호스트의 gh 현재 사용자다
//        (lib/gh.ts 의 ownAuthors). 그 목록을 정하지 못하면 조회 실패다. 다른 사람 PR 을 ready 로 바꾸지 않는다
//     3. `git fetch -q origin` 뒤 origin/<base> 를 읽는다. 실패하면 조회 실패다
//     4. PR HEAD 를 받아(lib/conflicts.ts 의 fetchPrHead) base 와 merge-tree 로 합쳐 본다(lib/git.ts 의 conflicts).
//        충돌하면 보류한다. 합쳐 보지 못하면(받을 수 없는 HEAD 같은 것) 「충돌 여부를 판정하지 못했다」 로 보류한다.
//        GitHub 의 mergeable 은 계산이 늦어 UNKNOWN 이 나오고 notify-conflicts 와 판정이 갈린 일이 있어 쓰지 않는다
//     5. 바뀐 파일이 300 개를 넘으면 직접 확인하라고 보류한다.
//        같은 base 로 가는 열린 ready PR 과 바뀐 파일이 겹치면 보류하고 겹친 PR 과 파일을 낸다. 겹침은 작성자와 관계없이 본다.
//        이번 실행에서 앞서 ready 로 바꾼 PR 도 ready 로 센다. draft PR 끼리의 겹침은 세지 않는다
//     6. before-ready 이벤트를 낸다. 거부, 실패, 시간 초과, 잠금 실패면 HOOK-* 줄에 더해 `<PR> 보류: before-ready 가 막았다` 다
//     7. `gh pr ready` 로 바꾸고 pr-ready 이벤트를 낸다. pr-ready 의 실패는 HOOK-FAIL 줄만 남기고 종료 코드에 반영하지 않는다.
//        종료 코드가 코디네이터의 ready 판정 계약이라, 이미 ready 로 바뀐 PR 을 보류로 읽게 하면 안 된다
//
// 이벤트 입력(lib/events.ts 머리 주석의 「이벤트별 필드」): pr, ready_count(같은 base 의 이미 ready 인 내 PR 수. 이번 실행에서 바꾼 PR 포함),
//     slots(config.json 의 pipeline.ready_slots, 없으면 1). base 는 PR 의 base, run 은 null 이다.
//     pr-ready 의 pr.draft 는 false 이고 ready_count 는 바꾼 그 PR 을 더한 수다.
//
// 바뀐 파일은 REST(`gh api --hostname <호스트> repos/{owner}/{repo}/pulls/{n}/files --paginate`)로 읽는다.
// `gh pr view --json files` 같은 GraphQL 조회는 PR 이 많으면 2차 한도에 걸리고 100 개에서 잘린다.
// 호스트와 저장소는 PR URL 에서 읽는다(lib/gh.ts 의 apiTarget). `gh api` 는 origin 을 보지 않고 기본 호스트로 가기 때문이다.
//
// GH 환경 변수로 gh 실행 파일을 바꾼다.
//
// 종료 코드: 0 모두 ready(이미 ready 포함), 1 보류한 PR 이 있다, 2 사용법 오류(설정 파일 오류 포함)나 조회 실패

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { ConfigError, loadConfig, PIPELINE_KEYS, section } from './lib/config.ts'
import { baseHead, fetchPrHead } from './lib/conflicts.ts'
import { fire } from './lib/events.ts'
import type { FireContext } from './lib/events.ts'
import { apiTarget, gh, ghJson, isOwnPr, ownAuthors } from './lib/gh.ts'
import { conflicts } from './lib/git.ts'

const USAGE = '사용법: ci-ready.ts [--repo DIR] [--dry-run] PR [PR ...]'
const FILES_LIMIT = 300
const VIEW_FIELDS = 'number,state,isDraft,baseRefName,url,title,author,headRefName,headRefOid,isCrossRepository'

class LookupFailed extends Error {}

type Pr = {
  number: number
  state: string
  isDraft: boolean
  baseRefName: string
  url: string
  title: string
  author: { login: string } | null
  headRefName: string
  headRefOid: string
  isCrossRepository: boolean
}
type ReadyPr = { number: number; isDraft: boolean; url: string; author: { login: string } | null }

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

function login(pr: { author: { login: string } | null }): string {
  return pr.author?.login ?? ''
}

function ghData<T>(repo: string, args: string[]): T {
  const got = ghJson<T>(args, { cwd: repo })
  if (!got.ok) throw new LookupFailed(got.error)
  return got.data
}

function target(url: string): { host: string; slug: string } {
  const found = apiTarget(url)
  if (!found) throw new LookupFailed(`PR URL 을 읽지 못했다: ${JSON.stringify(url ?? null)}`)
  return found
}

// REST 로 읽은 PR 의 바뀐 파일 집합.
function filesOf(repo: string, pr: { number: number; url: string }): Set<string> {
  const { host, slug } = target(pr.url)
  const done = gh(['api', '--hostname', host, `repos/${slug}/pulls/${pr.number}/files?per_page=100`, '--paginate', '--jq', '.[].filename'], { cwd: repo })
  if (done.code !== 0) throw new LookupFailed(`gh api 로 PR ${pr.number} 의 파일을 읽지 못했다: ${done.stderr.trim()}`)
  return new Set(done.stdout.split('\n').filter((line) => line))
}

function prInput(pr: Pr, draft: boolean): Record<string, unknown> {
  return { number: pr.number, title: pr.title ?? null, branch: pr.headRefName ?? null, head: pr.headRefOid ?? null, author: login(pr) || null, draft, url: pr.url ?? null }
}

type Verdict =
  | { verdict: 'hold' | 'already'; why: string }
  | { verdict: 'ready'; pr: Pr; files: Set<string>; readyCount: number }

class Judge {
  readonly repo: string
  // 이번 실행에서 ready 로 바꾼(--dry-run 이면 바꿀) PR. 번호에서 (base, 바뀐 파일) 로 간다
  readonly readied = new Map<number, { base: string; files: Set<string> }>()
  private readonly authors = new Map<string, string[]>()
  private readonly bases = new Map<string, string>()

  constructor(repo: string) {
    this.repo = repo
  }

  private authorsFor(host: string): string[] {
    const known = this.authors.get(host)
    if (known) return known
    const found = ownAuthors(this.repo, host)
    if (!found) throw new LookupFailed(`내 PR 의 작성자를 정하지 못했다(${host} 의 gh api user 실패). config.json 의 pipeline.authors 로 준다`)
    this.authors.set(host, found)
    return found
  }

  private baseSha(base: string): string {
    const known = this.bases.get(base)
    if (known) return known
    const head = baseHead(this.repo, base)
    if (!head.ok) throw new LookupFailed(head.error)
    this.bases.set(base, head.sha)
    return head.sha
  }

  judge(number: number): Verdict {
    const pr = ghData<Pr>(this.repo, ['pr', 'view', String(number), '--json', VIEW_FIELDS])
    if (pr.state !== 'OPEN') return { verdict: 'hold', why: `state=${pr.state ?? 'None'}` }
    if (!pr.isDraft) return { verdict: 'already', why: '이미 ready' }
    const authors = this.authorsFor(target(pr.url).host)
    if (!isOwnPr({ author: { login: login(pr) } }, authors)) return { verdict: 'hold', why: `내 PR 이 아니다(작성자 ${login(pr) || '(없음)'})` }
    const base = pr.baseRefName || ''
    const sha = this.baseSha(base)
    const fetched = fetchPrHead(this.repo, pr)
    const merged = fetched.ok ? conflicts(this.repo, sha, pr.headRefOid) : fetched
    if (!merged.ok) return { verdict: 'hold', why: `충돌 여부를 판정하지 못했다: ${merged.error}` }
    if (merged.conflict) return { verdict: 'hold', why: 'base 와 충돌한다. worker 가 base 를 합친 뒤 다시 돌린다' }
    const mine = filesOf(this.repo, pr)
    if (mine.size > FILES_LIMIT) return { verdict: 'hold', why: `바뀐 파일이 ${mine.size} 개로 ${FILES_LIMIT} 개를 넘는다. 직접 확인한다` }

    const listed = ghData<ReadyPr[]>(this.repo, ['pr', 'list', '--state', 'open', '--base', base, '--limit', '200', '--json', 'number,isDraft,url,author'])
    const ready = (Array.isArray(listed) ? listed : []).filter((row) => !row.isDraft)
    const others = new Map<number, Set<string>>(ready.map((row) => [row.number, filesOf(this.repo, row)]))
    const own = new Set(ready.filter((row) => isOwnPr({ author: { login: login(row) } }, authors)).map((row) => row.number))
    for (const [other, done] of this.readied) {
      if (done.base !== base) continue
      others.set(other, done.files)
      own.add(other)
    }
    const busy: string[] = []
    for (const other of [...others.keys()].sort((a, b) => a - b)) {
      if (other === number) continue
      const same = [...mine].filter((file) => others.get(other)?.has(file)).sort()
      if (same.length > 0) busy.push(`#${other}(${same.slice(0, 3).join(', ')}${same.length > 3 ? ' 외' : ''})`)
    }
    if (busy.length > 0) return { verdict: 'hold', why: `ready PR 과 겹친다 ${busy.join(' ')}` }
    own.delete(number)
    return { verdict: 'ready', pr, files: mine, readyCount: own.size }
  }
}

function readySlots(repo: string): number {
  const value = section<{ ready_slots?: unknown }>(loadConfig(repo), 'pipeline', PIPELINE_KEYS).ready_slots
  if (value === undefined) return 1
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ConfigError('설정 파일의 pipeline.ready_slots 는 1 이상의 정수여야 한다')
  return value
}

function parse(argv: string[]): { repo: string; dryRun: boolean; prs: number[] } | 'help' | null {
  const options = { repo: { type: 'string', default: '.' }, 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } } as const
  let parsed
  try {
    parsed = parseArgs({ args: expandArgs(argv, options), options, allowPositionals: true })
  } catch (e) {
    err(`${USAGE}\nci-ready: ${(e as Error).message}`)
    return null
  }
  if (parsed.values.help) return 'help'
  const bad = parsed.positionals.filter((value) => !/^\+?\d+$/.test(value.trim()))
  if (parsed.positionals.length === 0 || bad.length > 0) {
    err(`${USAGE}\nci-ready: ${bad.length > 0 ? `PR 번호가 아니다: ${bad.join(' ')}` : 'PR 번호가 필요하다'}`)
    return null
  }
  return { repo: resolve(parsed.values.repo), dryRun: parsed.values['dry-run'], prs: parsed.positionals.map((value) => Number(value)) }
}

async function main(argv: string[]): Promise<number> {
  const a = parse(argv)
  if (a === null) return 2
  if (a === 'help') {
    out(USAGE)
    return 0
  }
  const slots = readySlots(a.repo)
  const judge = new Judge(a.repo)
  let held = false
  for (const number of a.prs) {
    let found: Verdict
    try {
      found = judge.judge(number)
    } catch (e) {
      if (!(e instanceof LookupFailed)) throw e
      err(`${number} 조회 실패: ${e.message}`)
      return 2
    }
    if (found.verdict === 'hold') {
      held = true
      out(`${number} 보류: ${found.why}`)
      continue
    }
    if (found.verdict === 'already') {
      out(`${number} ${found.why}`)
      continue
    }
    const { pr, files, readyCount } = found
    const base = pr.baseRefName || ''
    if (a.dryRun) {
      judge.readied.set(number, { base, files })
      out(`${number} ready 로 바꿀 것`)
      continue
    }
    const ctx: FireContext = { repo: a.repo, base, run: null }
    const before = await fire('before-ready', { pr: prInput(pr, true), ready_count: readyCount, slots }, ctx)
    if (before.result !== 'pass' && before.result !== 'none') {
      held = true
      out(`${number} 보류: before-ready 가 막았다`)
      continue
    }
    const done = gh(['pr', 'ready', String(number)], { cwd: a.repo })
    if (done.code !== 0) {
      err(`${number} ready 로 바꾸지 못했다: ${done.stderr.trim()}`)
      return 2
    }
    judge.readied.set(number, { base, files })
    out(`${number} ready 로 바꿈(CI 시작)`)
    try {
      await fire('pr-ready', { pr: prInput(pr, false), ready_count: readyCount + 1, slots }, ctx)
    } catch (e) {
      // PR 은 이미 ready 다. 종료 코드를 바꾸면 코디네이터가 보류로 읽는다
      err(`ci-ready: pr-ready 를 내지 못했다: ${(e as Error)?.message ?? String(e)}`)
    }
  }
  return held ? 1 : 0
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    if (e instanceof ConfigError) {
      err(`ci-ready: ${e.message}`)
      process.exitCode = 2
    } else {
      err(`ci-ready: ${(e as Error)?.stack ?? String(e)}`)
      process.exitCode = 1
    }
  },
)
