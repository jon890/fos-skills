// gh 호출의 한 벌이다. 실행 파일은 GH 환경 변수, 없으면 gh 다.
// 내 PR 판정(작성자)과 update-branch 를 부를 수 있는 경우를 이 모듈 한 곳에서 정한다.
//
// 시간 제한: 읽는 호출은 lib/proc.ts 의 기본(60초)이다. 쓰는 호출(머지, update-branch, base 옮기기)은 부르는 쪽이
// timeoutMs 로 NO_LIMIT_MS 를 준다. 옛 명령은 쓰는 호출에 시간 제한을 두지 않았고, 끊으면 GitHub 에서는 끝난 쓰기를
// 실패로 읽는다. updateBranch 는 늘 NO_LIMIT_MS 다.
//
// 호스트: `gh api` 는 origin 을 보지 않고 기본 호스트로 간다. 그래서 GitHub Enterprise 저장소에서 `api user` 를 그냥 부르면
// 다른 호스트의 사용자가 오거나 null 이 된다. 호스트는 PR URL 에서 읽어(apiTarget) GH_HOST 나 --hostname 으로 준다.
//
// 머지 큐와 상주 루프는 이 모듈에서 필수 체크 규칙을 조회하고 core/checks.ts 에서 롤업을 판단한다.

import { currentChecks, judgeChecks } from '../core/checks.ts'
import type { CiCheck } from '../core/checks.ts'
import { ConfigError, loadConfig, PIPELINE_KEYS, QUEUE_KEYS, section } from './config.ts'
import { NO_LIMIT_MS, run } from './proc.ts'
import type { RunResult } from './proc.ts'
import { budgetGh } from './gh-budget.ts'
import type { BudgetOptions } from './gh-budget.ts'
import { git, mainCheckout } from './git.ts'
import type { Visibility } from './private-words.ts'
import { parseVisibility } from './private-words.ts'

export { FAILED_CONCLUSIONS, FAILED_STATES, cancelledOnly, ciState, currentChecks, failedCheck, requiredCiState } from '../core/checks.ts'
export type { CiCheck, CiState } from '../core/checks.ts'

type GhOptions = { host?: string; cwd?: string; timeoutMs?: number; killSignal?: NodeJS.Signals; cache?: boolean; repoFromCwd?: boolean } & Pick<BudgetOptions, 'cacheKey' | 'ttlSeconds' | 'refresh'>
const contexts = new Map<string, { root: string; origin: string; expires: number }>()

export function ghBin(): string {
  return process.env.GH || 'gh'
}

export function gh(args: string[], opts: GhOptions = {}): RunResult {
  const repo = opts.cwd ?? process.cwd()
  let context = contexts.get(repo)
  if (!context || context.expires <= Date.now()) {
    context = { root: mainCheckout(repo), origin: git(repo, ['remote', 'get-url', 'origin']).stdout.trim(), expires: Date.now() + 60_000 }
    contexts.set(repo, context)
  }
  const identity = [ghBin(), context.root, context.origin, opts.host ?? process.env.GH_HOST, opts.repoFromCwd ? undefined : process.env.GH_REPO, process.env.GH_CONFIG_DIR,
    process.env.GH_TOKEN, process.env.GITHUB_TOKEN, process.env.GH_ENTERPRISE_TOKEN, process.env.GITHUB_ENTERPRISE_TOKEN,
    // 브랜치에서 PR 을 추론하는 호출은 다른 워크트리와 섞지 않는다.
    args[0] === 'pr' && ['view', 'checks'].includes(args[1]) && (!args[2] || args[2].startsWith('-')) ? repo : null]
  const env = { ...(opts.host ? { GH_HOST: opts.host } : {}), ...(opts.repoFromCwd ? { GH_REPO: undefined } : {}), ORCH_GH_BUDGET_PARENT: String(process.pid) }
  return budgetGh(args, repo, identity, () => run([ghBin(), ...args], { cwd: opts.cwd, env, timeoutMs: opts.timeoutMs, killSignal: opts.killSignal }), { passthrough: opts.cache === false, cacheKey: opts.cacheKey, ttlSeconds: opts.ttlSeconds, refresh: opts.refresh })
}

export function ghJson<T>(args: string[], opts?: GhOptions): { ok: true; data: T } | { ok: false; error: string } {
  const command = `gh ${args.join(' ')}`
  const done = gh(args, opts)
  if (done.code !== 0) return { ok: false, error: `${command} 가 종료 코드 ${done.code} 로 끝났다: ${(done.stderr || done.stdout).trim()}` }
  try {
    return { ok: true, data: JSON.parse(done.stdout) as T }
  } catch {
    return { ok: false, error: `${command} 의 출력이 JSON 이 아니다` }
  }
}

// 저장소의 공개 여부(lib/private-words.ts 의 Visibility). 읽지 못하면 unknown 이다. repo view 라 공유 캐시를 쓴다
export function ghRepoVisibility(cwd: string): Visibility {
  const got = ghJson<{ visibility?: unknown }>(['repo', 'view', '--json', 'visibility'], { cwd })
  return got.ok ? parseVisibility(got.data?.visibility) : 'unknown'
}

export function currentUser(host?: string, cwd?: string): string | null {
  const done = gh(['api', 'user', '--jq', '.login'], { host, cwd })
  const login = done.stdout.trim()
  return done.code === 0 && login ? login : null
}

// PR URL(https://<호스트>/<owner>/<repo>/pull/<번호>)의 호스트와 owner/repo. 앞 세 조각 중 빈 것이 있으면 null 이다.
export function apiTarget(url: string): { host: string; slug: string } | null {
  const at = (url || '').indexOf('://')
  const parts = (at >= 0 ? url.slice(at + 3) : url || '').split('/')
  if (parts.length < 3 || !parts.slice(0, 3).every((part) => part)) return null
  return { host: parts[0], slug: `${parts[1]}/${parts[2]}` }
}

// 「내 PR」 로 볼 작성자 목록. config.json 의 pipeline.authors 가 비지 않은 문자열 목록이면 그것이고 gh 를 부르지 않는다.
// 없거나 빈 목록이면 그 호스트의 gh 현재 사용자 하나다. 그것도 읽지 못하면 null 이다.
// 부르는 쪽은 null 을 조회 실패로 다룬다. 누가 내 PR 인지 모른 채 다른 사람 PR 에 알리거나 ready 로 바꾸지 않는다.
// authors 의 타입이 틀리면 ConfigError 다.
export function ownAuthors(repo: string, host: string, config = loadConfig(repo)): string[] | null {
  const pipeline = section<{ authors?: unknown }>(config, 'pipeline', PIPELINE_KEYS)
  const authors = pipeline.authors
  if (authors !== undefined) {
    if (!Array.isArray(authors) || !authors.every((author) => typeof author === 'string' && author)) {
      throw new ConfigError('설정 파일의 pipeline.authors 는 빈 값이 없는 문자열 목록이어야 한다')
    }
    if (authors.length > 0) return authors as string[]
  }
  const login = currentUser(host, repo)
  return login ? [login] : null
}

// GitHub 로그인은 대소문자를 가리지 않으므로 소문자로 맞춰 비교한다.
export function isOwnPr(pr: { author: { login: string } }, authors: string[]): boolean {
  const login = pr.author.login.toLowerCase()
  return authors.some((author) => author.toLowerCase() === login)
}

// base 를 합치는 유일한 경로다. 머지 차례가 온 PR(merge-turn), 뒤처진 draft(behind-draft), 상주 루프가 머지 차례 전에
// 미리 최신화하는 ready PR(refresh. loop/steps/refresh.ts 머리 주석의 「최신화」)에만 부른다.
// reason 은 호출 이유를 출력과 기록에 남기려고 받는다. draft 여부는 부르는 쪽이 gh 조회에서 받아 넘긴다.
// refresh 는 draft 를 거부한다. draft 는 CI 를 미루는 저장소가 있어 최신화해도 머지 차례를 앞당기지 못한다.
// host 를 주면 `api --hostname <host>` 로 부른다. `gh api` 는 origin 을 보지 않아 PR URL 의 호스트를 넘겨야 한다.
// expectedHead 를 주면 끝에 `-f expected_head_sha=<SHA>` 를 붙인다. 검사한 HEAD 뒤에 push 된 커밋이 있으면 GitHub 가 거부한다.
export function updateBranch(
  repo: string,
  pr: { number: number; isDraft: boolean },
  reason: 'merge-turn' | 'behind-draft' | 'refresh',
  opts: { host?: string; expectedHead?: string } = {},
): RunResult {
  if (reason === 'behind-draft' && !pr.isDraft) {
    return { code: 2, stdout: '', stderr: `거부: ${repo}#${pr.number} 는 draft 가 아니라 behind-draft 로 base 를 합치지 않는다\n`, timedOut: false }
  }
  if (reason === 'refresh' && pr.isDraft) {
    return { code: 2, stdout: '', stderr: `거부: ${repo}#${pr.number} 는 draft 라 refresh 로 base 를 합치지 않는다\n`, timedOut: false }
  }
  process.stderr.write(`update-branch ${repo}#${pr.number} 이유: ${reason}\n`)
  const args = ['api', ...(opts.host ? ['--hostname', opts.host] : []), '-X', 'PUT', `repos/${repo}/pulls/${pr.number}/update-branch`]
  if (opts.expectedHead) args.push('-f', `expected_head_sha=${opts.expectedHead}`)
  return gh(args, { timeoutMs: NO_LIMIT_MS })
}

// 필수 체크 판정 -----------------------------------------------------------------

// 저장소 규칙(repos/<owner>/<repo>/rules/branches/<base>)에서 필수 상태 체크 이름을 JSON 배열 문자열로 낸다.
// 체크 이름에는 쉼표가 들 수 있어 쉼표로 이어 내지 않는다
export const RULES_JQ =
  '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] ' + '| unique | tojson'

// RULES_JQ 의 출력을 이름 목록으로 읽는다. 배열이 아니면 Error 다
export function parseNames(text: string): string[] {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === 'string')) throw new Error(`필수 체크 이름 목록이 아니다: ${text}`)
  return parsed.filter((name) => name)
}
export type Names = { ok: true; names: string[] } | { ok: false; error: string }
type RuleChecks = { ok: true; names: string[]; planLimited?: true } | { ok: false; error: string; parseError?: unknown }

// 무료 플랜의 비공개 저장소는 규칙 API 를 읽을 수 없다(HTTP 403 과 Upgrade to GitHub Pro). 필수 체크 목록이 없는 것으로 다룬다
export function rulesPlanLimited(stderr: string): boolean {
  return stderr.includes('HTTP 403') && stderr.includes('Upgrade to GitHub Pro')
}

// base 의 저장소 규칙이 정한 필수 체크 이름. 플랜 제한은 빈 목록이다. slug 는 owner/repo 다.
// 큐는 플랜 제한을 로그에 남기고, 해석 오류는 원래 예외로 전파하므로 둘을 구분해 받는다.
export function ruleChecks(host: string, slug: string, base: string, { reportDetails = false } = {}): RuleChecks {
  const path = `repos/${slug}/rules/branches/${base}`
  const done = gh(['api', '--hostname', host, path, '--jq', RULES_JQ], { cache: false })
  if (done.code === 0) {
    try {
      const output = reportDetails ? done.stdout.replace(/\n+$/, '') : done.stdout.trim()
      return { ok: true, names: parseNames(output) }
    } catch (e) {
      const error = `gh api ${path} 의 출력을 읽지 못했다: ${(e as Error).message}`
      return reportDetails ? { ok: false, error, parseError: e } : { ok: false, error }
    }
  }
  if (rulesPlanLimited(done.stderr)) {
    return reportDetails ? { ok: true, names: [], planLimited: true } : { ok: true, names: [] }
  }
  return { ok: false, error: `gh api ${path} 가 종료 코드 ${done.code} 로 끝났다: ${(done.stderr || done.stdout).trim()}` }
}

// 필수 체크 이름. config.json 의 queue.required 가 있으면 그것(목록이면 그대로이고 이름에 쉼표가 있어도 나누지 않는다, 문자열이면 쉼표로 나눈다)이고 규칙 API 를 부르지 않는다.
// 없으면 ruleChecks 다. required 를 받는 꼴은 merge-with-finish 가 머지 큐에 넘길 때와 같고, 틀리면 ConfigError 다.
export function requiredNames(repo: string, host: string, slug: string, base: string, config = loadConfig(repo)): Names {
  const queue = section<{ required?: unknown }>(config, 'queue', QUEUE_KEYS)
  const value = queue.required
  if (value === undefined) return ruleChecks(host, slug, base)
  if (Array.isArray(value) && value.every((name) => typeof name === 'string')) {
    const names = value.filter((name) => name)
    if (names.length === 0) throw new ConfigError('설정 파일의 queue.required 는 비지 않은 문자열이어야 한다')
    return { ok: true, names }
  }
  if (typeof value !== 'string' || !value) throw new ConfigError('설정 파일의 queue.required 는 비지 않은 문자열이어야 한다')
  return { ok: true, names: value.split(',').filter((name) => name) }
}

export type CheckSnapshot = { headRefOid: string; statusCheckRollup: unknown }

// HEAD 별 공유 스냅샷. 멈추거나 머지하기 직전에는 refresh 로 재실행도 확인한다.
export function checkSnapshot(repo: string, number: string, head: string, refresh = false,
  required: readonly string[] = [], skippedMissing = false,
): ReturnType<typeof ghJson<CheckSnapshot>> {
  return ghJson<CheckSnapshot>(['pr', 'view', number, '--json', 'statusCheckRollup,headRefOid', '--jq', '.'], {
    cwd: repo, cacheKey: JSON.stringify(['checks', number, head, required, skippedMissing]), refresh,
    ttlSeconds: (result) => {
      try {
        const pr = JSON.parse(result.stdout) as CheckSnapshot
        if (pr.headRefOid !== head) return 0
        const rows = currentChecks(pr.statusCheckRollup, head)
        const checks = judgeChecks(rows, { required, skippedIsMissing: skippedMissing, allowNoChecks: false })
        return checks.none || checks.pending > 0 || checks.missing.length > 0 ? 60 : 300
      } catch { return 0 }
    },
  })
}

// 체크 이름이 같아도 다른 workflow 일 수 있다. Actions URL 의 run 으로 workflow ID 를 읽고,
// base 의 최신 완료된 push 실행이 최근에 실패했는지 본다. lib/gh-budget.ts 의 REST GET 공유 캐시를 쓴다.
// 모든 실패 체크가 같은 workflow 의 base 실패로 설명될 때만 worker 전달을 막는다. 6시간이 지난 실패나 시각이 없는 응답은 제외한다.
export const BASE_FAILURE_MAX_AGE_MS = 6 * 60 * 60 * 1000

export function baseWorkflowFailed(repo: string, host: string, slug: string, base: string, checks: readonly CiCheck[],
  read: typeof ghJson = ghJson, now = Date.now()): boolean {
  if (checks.length === 0) return false
  return checks.every((check) => {
    let url: URL
    try { url = new URL(check.url ?? '') } catch { return false }
    const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/([0-9]+)(?:\/|$)/u.exec(url.pathname)
    if (url.host !== host || !match || match[1] !== slug) return false
    const run = read<{ workflow_id?: number }>(['api', '--hostname', host, `repos/${slug}/actions/runs/${match[2]}`], { cwd: repo })
    if (!run.ok || !Number.isSafeInteger(run.data?.workflow_id) || Number(run.data.workflow_id) <= 0) return false
    const latest = read<{ workflow_runs?: { status?: string; conclusion?: string; updated_at?: string }[] }>(['api', '--hostname', host,
      `repos/${slug}/actions/workflows/${run.data.workflow_id}/runs?branch=${encodeURIComponent(base)}&event=push&status=completed&per_page=1`], { cwd: repo })
    const row = latest.ok ? latest.data?.workflow_runs?.[0] : null
    const age = now - Date.parse(row?.updated_at ?? '')
    return row?.status === 'completed' && age >= 0 && age <= BASE_FAILURE_MAX_AGE_MS &&
      ['failure', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(row.conclusion ?? '')
  })
}
