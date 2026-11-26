// 「머지해도 되나」 를 묻는 함수(checkReadiness)와 그 값을 읽는 함수. 조건의 뜻, 순서, 범위는 core/merge-readiness.ts 의 조건 표가 소유한다.
// 여기는 core 가 달라는 값만 읽는다. 조건을 더하거나 빼지 않고 표를 따로 돌지 않는다(ADR-037).
//
// 읽는 순서는 READ_ORDER 다. 관문의 gh 호출 순서와 같다. core 가 달라는 값 가운데 이 순서로 가장 앞의 값 하나를 읽고 다시 묻는다.
// 그래서 앞 값에 따라 생기는 값(영수증, 인정 커밋, base 마이그레이션)이 지금 자리에서 읽히고, HEAD 가 다른 값을 읽으면 뒤 값을 읽지 않는다.
// gh 와 git 의 인자, cwd, 캐시 옵션은 옮기기 전 호출과 같다. 테스트의 가짜 실행기가 인자로 응답을 고른다.
// 보류 이유는 읽을 때 비공개 낱말을 위치로 바꾸고(redactLine), 나머지 이유와 알림 줄은 돌려주기 직전에 가린다(mask).

import { existsSync } from 'node:fs'
import { autoMergeConfig, prHold, watchedDirs } from '../core/auto-merge.ts'
import { currentChecks } from '../core/checks.ts'
import { integrationRules } from '../core/integration-evidence.ts'
import { acceptedCandidates, judgeReadiness } from '../core/merge-readiness.ts'
import type { Fact, FactName, Facts, Reason, ReadinessAsk, ReadinessPolicy, ReadinessSnapshot } from '../core/merge-readiness.ts'
import { readBoard } from './board.ts'
import { boardPath } from './board-file.ts'
import { loadConfig } from './config.ts'
import { acceptsVerifiedCommit } from './feature-evidence.ts'
import { checkSnapshot, gh, ghJson, ghRepoVisibility } from './gh.ts'
import { commentRows, findingsText, mask, readPrivateWords, redactLine, repoVisibility, textFindings } from './private-words.ts'
import { NO_LIMIT_MS, run, runAsync } from './proc.ts'
import type { RunResult } from './proc.ts'
import { addedPaths } from './reservations.ts'
import { judgeTrustedBotReviews, loadBotReviewSnapshot } from './review-bot.ts'
import { specTargets } from './spec-targets.ts'

export type { ConditionKind, Reason, ReasonKind, ReadinessAsk, ReadinessSnapshot } from '../core/merge-readiness.ts'
export { blocksMerge, blocksReady } from '../core/merge-readiness.ts'

// 스레드 수 명령의 기본값. dir 은 scripts 아래 진입 폴더(queue, loop)다. 옛 명령과 같은 글자를 내려고 정규화하지 않고 잇는다
export function threadsScript(dir: string): string {
  return `${dir}/../../../review-fix/scripts/review_threads.ts`
}

export function defaultThreadsCmd(dir: string): string {
  return `node '${threadsScript(dir)}' list --count "$OWNER" "$REPO" "$PR"`
}

// 판단 대상. repo 는 저장소 폴더, head 는 부르는 쪽이 고정한 HEAD 다. cross 는 다른 저장소에서 온 PR 인지다(통합 테스트 기록의 커밋 받기)
export type PrTarget = { repo: string; number: number; head: string; base: string; branch: string; host: string; slug: string; draft: boolean; cross?: boolean }

type Known = { [K in FactName]?: Fact<Facts[K]> | (() => Fact<Facts[K]> | Promise<Fact<Facts[K]>>) }
export type ReadOptions = {
  // 이미 읽은 값이나 그 값을 읽는 함수. 함수는 core 가 그 값을 달라고 할 때만 불린다
  known?: Known
  // gh 조회의 cwd. 머지 큐는 --repo 값을 그대로 넘긴다. 없으면 target.repo 다
  ghRepo?: string
  threadsCmd?: string
  required?: string[]
  allowFail?: string[]
  skippedIsMissing?: boolean
  allowNoChecks?: boolean
  retries?: number
  retrySeconds?: number
  nap?: (seconds: number) => Promise<void>
}

export type Readiness = { reasons: Reason[]; notes: string[]; summary: string; basis: string | null; snapshot: ReadinessSnapshot }

// 값을 읽는 순서. core 가 여럿을 달라고 하면 이 순서로 앞의 것부터 하나씩 읽는다
export const READ_ORDER: readonly FactName[] = [
  'checks', 'threads', 'mergeable', 'reviewRollup', 'receipts', 'body', 'integrationFiles', 'acceptedCommits',
  'files', 'baseMigrations', 'privateWords', 'holdBody', 'specHold', 'boardItems',
]

type ReadContext = { target: PrTarget; ask: ReadinessAsk; read: ReadOptions; policy: ReadinessPolicy; snapshot: ReadinessSnapshot }

const fail = (error: string, wait?: string): { ok: false; error: string; wait?: string } => (wait === undefined ? { ok: false, error } : { ok: false, error, wait })
const nap = (read: ReadOptions, seconds: number): Promise<void> => (read.nap ?? ((s: number) => new Promise((resolve) => setTimeout(resolve, s * 1000))))(seconds)
const chomp = (text: string): string => text.replace(/\n+$/, '')
const git = (...args: string[]): RunResult => run(['git', ...args], { timeoutMs: NO_LIMIT_MS })

function owner(target: PrTarget): [string, string] {
  const [o, r] = target.slug.split('/')
  return [o ?? '', r ?? '']
}

// PR 하나의 필드. 호출이 실패하면 retries 번까지 다시 부르고, 그래도 실패하면 빈 문자열이다
async function field(c: ReadContext, jsonField: string, jq: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const done = gh(['pr', 'view', String(c.target.number), '--json', jsonField, '--jq', jq], { cache: false })
    if (done.code === 0) return chomp(done.stdout)
    if (attempt >= (c.read.retries ?? 3)) return ''
    await nap(c.read, c.read.retrySeconds ?? 10)
  }
}

function api(c: ReadContext, ...args: string[]): RunResult {
  return gh(['api', '--hostname', c.target.host, ...args], { cache: false })
}

// 단일 브랜치 clone 이어도 origin/BASE 가 갱신되도록 대상 ref 를 명시한다
function fetchPrRefs(target: PrTarget): boolean {
  if (git('fetch', '-q', 'origin', `+refs/heads/${target.base}:refs/remotes/origin/${target.base}`).code !== 0) return false
  if (git('cat-file', '-e', `${target.head}^{commit}`).code !== 0) {
    git('fetch', '-q', 'origin', target.cross ? `refs/pull/${target.number}/head` : target.branch)
  }
  return git('cat-file', '-e', `${target.head}^{commit}`).code === 0
}

const READERS: { [K in FactName]: (c: ReadContext) => Fact<Facts[K]> | Promise<Fact<Facts[K]>> } = {
  // 지금 HEAD 의 체크 롤업. HEAD 별 공유 캐시(checkSnapshot)를 쓰고 fresh 면 캐시를 건너뛴다
  async checks(c) {
    const { target, read } = c
    for (let attempt = 1; ; attempt++) {
      const got = checkSnapshot(read.ghRepo ?? target.repo, String(target.number), target.head, c.ask.fresh === true, c.policy.required, c.policy.skippedIsMissing)
      if (got.ok) {
        const pr = got.data
        if (pr === null) return fail('체크 조회 실패')
        const head = pr.headRefOid || ''
        return { ok: true, value: currentChecks(pr.statusCheckRollup, head), head }
      }
      if (attempt >= (read.retries ?? 3)) return fail('체크 조회 실패')
      await nap(read, read.retrySeconds ?? 10)
    }
  },
  async threads(c) {
    const [o, r] = owner(c.target)
    const env = { PR: String(c.target.number), BRANCH: c.target.branch, OWNER: o, REPO: r, GH_HOST: c.target.host, ORCH_GH_CACHE: '0' }
    const threads = await runAsync(['bash', '-c', c.read.threadsCmd ?? ''], { env, timeoutMs: NO_LIMIT_MS })
    // 옛 명령은 스레드 명령의 stderr 를 받지 않고 그대로 흘렸다
    if (threads.stderr) process.stderr.write(threads.stderr)
    return threads.code !== 0 ? fail('스레드 조회 실패') : { ok: true, value: chomp(threads.stdout) }
  },
  // UNKNOWN 이면 20초 간격으로 네 번까지 다시 읽는다
  async mergeable(c) {
    let m = await field(c, 'mergeable', '.mergeable')
    for (let i = 0; i < 4; i++) {
      if (m !== 'UNKNOWN') break
      await nap(c.read, 20)
      m = await field(c, 'mergeable', '.mergeable')
    }
    return { ok: true, value: m }
  },
  reviewRollup(c) {
    const got = ghJson<{ statusCheckRollup: unknown; headRefOid: unknown }>(['pr', 'view', String(c.target.number), '--json', 'statusCheckRollup,headRefOid', '--jq', '.'], { cwd: c.read.ghRepo ?? c.target.repo, cache: false })
    if (!got.ok || !got.data) return fail('리뷰 판정 조회 실패')
    return { ok: true, value: got.data.statusCheckRollup, head: typeof got.data.headRefOid === 'string' ? got.data.headRefOid : '' }
  },
  // 조회 실패는 ok: false, 봇이 남긴 거절은 rejected 값이다
  receipts(c) {
    const bots = c.policy.review?.trustedBots ?? []
    const target = { host: c.target.host, slug: c.target.slug, number: String(c.target.number) }
    const snapshot = loadBotReviewSnapshot(c.target.repo, target, c.target.head)
    if (!snapshot.ok) return fail(snapshot.wait, snapshot.wait)
    const judged = judgeTrustedBotReviews(c.target.head, snapshot.data, bots)
    return { ok: true, value: judged.ok ? { receipts: judged.receipts } : { rejected: judged.wait } }
  },
  body(c) {
    const got = ghJson<{ body: unknown; headRefOid: unknown }>(['pr', 'view', String(c.target.number), '--json', 'body,headRefOid', '--jq', '.'], { cwd: c.read.ghRepo ?? c.target.repo, cache: false })
    if (!got.ok) return fail('PR 본문 또는 HEAD 조회 실패')
    return { ok: true, value: typeof got.data?.body === 'string' ? got.data.body : '', head: String(got.data?.headRefOid ?? '') }
  },
  // 바뀐 파일은 REST 로 끝까지 읽는다(gh pr view 의 files 는 100개까지다). 이름을 바꾼 파일은 옛 경로도 본다
  integrationFiles(c) {
    const [o, r] = owner(c.target)
    const files = api(c, `repos/${o}/${r}/pulls/${c.target.number}/files?per_page=100`, '--paginate', '--jq', '.[] | .filename, (.previous_filename // empty)')
    return files.code !== 0 ? fail('통합 테스트 대상 파일 조회 실패') : { ok: true, value: files.stdout.split('\n').filter(Boolean) }
  },
  // 통합 테스트 기록의 커밋은 그 뒤에 base 만 합친 merge 나 계획 폴더 삭제만 있으면 받는다
  acceptedCommits(c) {
    const accepted = acceptedCandidates(c.snapshot, c.policy).filter((commit) =>
      fetchPrRefs(c.target) && acceptsVerifiedCommit(c.target.repo, c.target.head, commit, c.target.base))
    return { ok: true, value: accepted }
  },
  files(c) {
    const read = ghJson<{ files: unknown; headRefOid: unknown }>(['pr', 'view', String(c.target.number), '--json', 'files,headRefOid', '--jq', '.'], { cwd: c.target.repo, cache: false })
    if (!read.ok) return fail('마이그레이션 파일 조회 실패')
    return { ok: true, value: addedPaths(read.data?.files), head: String(read.data?.headRefOid ?? '') }
  },
  baseMigrations(c) {
    const base = c.target.base
    if (git('fetch', '--quiet', 'origin', base).code !== 0) return fail(`마이그레이션 검사: origin/${base} fetch 실패`)
    const listed = git('ls-tree', '-r', '--name-only', `origin/${base}`, '--', ...new Set(Object.values(c.policy.migrationDirs).flat()))
    if (listed.code !== 0) return fail('base 마이그레이션 파일 조회 실패')
    return { ok: true, value: listed.stdout.trim().split('\n') }
  },
  // 공개 저장소면 PR 본문(이미 읽은 값), 일반 댓글, 리뷰 본문, 코드 줄 댓글을 본다. 댓글은 끝 페이지까지 캐시 없이 읽는다.
  // 공개 여부는 머신 폴더에 기억한다(lib/private-words.ts). 비공개면 보지 않고, 읽지 못하면 공개로 보고 본다
  privateWords(c) {
    const words = readPrivateWords()
    if (words.length === 0 || repoVisibility(c.target.repo || c.read.ghRepo || '', ghRepoVisibility) === 'private') return { ok: true, value: { findings: null, failed: [] } }
    const [o, r] = owner(c.target)
    const n = String(c.target.number)
    const body = c.snapshot.facts.body
    const found = body?.ok ? textFindings(body.value, words, 'PR 본문') : []
    const failed: string[] = []
    for (const source of [
      { label: '일반 댓글', path: `repos/${o}/${r}/issues/${n}/comments?per_page=100` },
      { label: '리뷰', path: `repos/${o}/${r}/pulls/${n}/reviews?per_page=100` },
      { label: '코드 줄 댓글', path: `repos/${o}/${r}/pulls/${n}/comments?per_page=100` },
    ]) {
      const got = api(c, source.path, '--paginate', '--jq', '.[] | [.id, (.body // "")] | @json')
      const rows = got.code === 0 ? commentRows(got.stdout) : null
      if (rows === null) {
        failed.push(source.label)
        continue
      }
      for (const row of rows) found.push(...textFindings(row.body, words, `${source.label} ${row.id}`))
    }
    return { ok: true, value: { findings: found.length > 0 ? findingsText(found) : null, failed } }
  },
  // 본문을 지금 읽는다. 열린 뒤에 본문만 고쳐 보류를 적을 수 있어서 캐시를 쓰지 않는다
  holdBody(c) {
    const got = gh(['pr', 'view', String(c.target.number), '--json', 'body', '--jq', '.body'], { cache: false })
    if (got.code !== 0) return fail('PR 본문을 읽지 못해 머지 보류 줄을 확인할 수 없다')
    const hold = prHold(got.stdout)
    const words = readPrivateWords()
    return { ok: true, value: hold === null || words.length === 0 ? hold : redactLine(hold, words, 'PR 본문', got.stdout) }
  },
  specHold(c) {
    const target = c.target.branch ? specTargets(c.target.repo).get(c.target.branch) : undefined
    const hold = target?.hold ?? null
    const words = readPrivateWords()
    return { ok: true, value: hold === null || words.length === 0 ? hold : redactLine(hold, words, '지시서', target?.text ?? '') }
  },
  // 보드 파일이 없으면 빈 목록이고, 읽지 못하면 ok: false 다
  boardItems(c) {
    const file = boardPath(c.target.repo)
    if (!existsSync(file)) return { ok: true, value: [] }
    try {
      return { ok: true, value: readBoard(file) }
    } catch (e) {
      return fail(`보드를 읽지 못했다: ${(e as Error)?.message ?? String(e)}`)
    }
  },
}

// 설정과 명령줄 값으로 판단 기준을 정한다
export function readinessPolicy(repo: string, read: ReadOptions): ReadinessPolicy {
  const config = loadConfig(repo)
  const autoMerge = autoMergeConfig(config)
  return {
    required: read.required ?? [],
    allowFail: read.allowFail ?? [],
    skippedIsMissing: read.skippedIsMissing === true,
    allowNoChecks: read.allowNoChecks === true,
    review: autoMerge.review,
    integrationRules: integrationRules(config),
    migrationDirs: config.migrations ? watchedDirs(autoMerge.dirs, autoMerge.watch) : {},
    privateWords: readPrivateWords().length > 0,
  }
}

async function readFact(name: FactName, c: ReadContext): Promise<Fact<unknown>> {
  const known = c.read.known?.[name] as Fact<unknown> | (() => Fact<unknown> | Promise<Fact<unknown>>) | undefined
  if (known !== undefined) return typeof known === 'function' ? await known() : known
  const reader = READERS[name] as ((c: ReadContext) => Fact<unknown> | Promise<Fact<unknown>>) | undefined
  // 모르는 값을 통과로 읽지 않는다
  return reader ? await reader(c) : fail(`${name} 를 읽는 방법이 없다`)
}

// PR 하나가 질문(ask)의 범위에서 막히는 이유를 모두 돌려준다. 판단은 core 의 judgeReadiness 가 한다
export async function checkReadiness(target: PrTarget, ask: ReadinessAsk, read: ReadOptions = {}): Promise<Readiness> {
  const policy = readinessPolicy(target.repo, read)
  const snapshot: ReadinessSnapshot = {
    pr: { number: target.number, head: target.head, base: target.base, branch: target.branch, draft: target.draft },
    facts: {},
  }
  const c: ReadContext = { target, ask, read, policy, snapshot }
  for (;;) {
    const judged = judgeReadiness(snapshot, policy, ask)
    if (judged.need.length > 0) {
      const name = READ_ORDER.find((one) => judged.need.includes(one)) ?? judged.need[0]
      ;(snapshot.facts as Record<string, Fact<unknown>>)[name] = await readFact(name, c)
      continue
    }
    // 이유와 알림 줄에는 PR 본문에서 옮긴 글(통합 테스트 생략 이유)이 섞인다. 출력으로 나가기 전에 비공개 낱말을 가린다
    const words = readPrivateWords()
    const reasons = words.length === 0 ? judged.reasons : judged.reasons.map((r) => ({ ...r, text: mask(r.text, words) }))
    const notes = words.length === 0 ? judged.notes : judged.notes.map((note) => mask(note, words))
    return { reasons, notes, summary: judged.summary, basis: judged.basis, snapshot }
  }
}
