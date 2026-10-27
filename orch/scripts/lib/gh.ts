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
// 필수 체크 판정: 규칙 조회(RULES_JQ, ruleChecks)와 실패 판정(FAILED_CONCLUSIONS, FAILED_STATES)은 머지 큐(merge_queue.ts)와
// 상주 루프(orch-loop.ts)가 함께 쓴다. 머지 큐가 통과로 보는 PR 을 루프가 실패로 알리면 코디네이터가 어느 쪽을 믿을지 모른다.

import { ConfigError, loadConfig, PIPELINE_KEYS, QUEUE_KEYS, section } from './config.ts'
import { NO_LIMIT_MS, run } from './proc.ts'
import type { RunResult } from './proc.ts'

type GhOptions = { host?: string; cwd?: string; timeoutMs?: number }

export function ghBin(): string {
  return process.env.GH || 'gh'
}

export function gh(args: string[], opts: GhOptions = {}): RunResult {
  return run([ghBin(), ...args], { cwd: opts.cwd, env: opts.host ? { GH_HOST: opts.host } : undefined, timeoutMs: opts.timeoutMs })
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

export function currentUser(host?: string): string | null {
  const done = gh(['api', 'user', '--jq', '.login'], { host })
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
export function ownAuthors(repo: string, host: string): string[] | null {
  const pipeline = section<{ authors?: unknown }>(loadConfig(repo), 'pipeline', PIPELINE_KEYS)
  const authors = pipeline.authors
  if (authors !== undefined) {
    if (!Array.isArray(authors) || !authors.every((author) => typeof author === 'string' && author)) {
      throw new ConfigError('설정 파일의 pipeline.authors 는 빈 값이 없는 문자열 목록이어야 한다')
    }
    if (authors.length > 0) return authors as string[]
  }
  const login = currentUser(host)
  return login ? [login] : null
}

// GitHub 로그인은 대소문자를 가리지 않으므로 소문자로 맞춰 비교한다.
export function isOwnPr(pr: { author: { login: string } }, authors: string[]): boolean {
  const login = pr.author.login.toLowerCase()
  return authors.some((author) => author.toLowerCase() === login)
}

// base 를 합치는 유일한 경로다. 머지 차례가 온 PR(merge-turn)과 뒤처진 draft(behind-draft)에만 부른다.
// reason 은 호출 이유를 출력과 기록에 남기려고 받는다. draft 여부는 부르는 쪽이 gh 조회에서 받아 넘긴다.
// host 를 주면 `api --hostname <host>` 로 부른다. `gh api` 는 origin 을 보지 않아 PR URL 의 호스트를 넘겨야 한다.
// expectedHead 를 주면 끝에 `-f expected_head_sha=<SHA>` 를 붙인다. 검사한 HEAD 뒤에 push 된 커밋이 있으면 GitHub 가 거부한다.
export function updateBranch(
  repo: string,
  pr: { number: number; isDraft: boolean },
  reason: 'merge-turn' | 'behind-draft',
  opts: { host?: string; expectedHead?: string } = {},
): RunResult {
  if (reason === 'behind-draft' && !pr.isDraft) {
    return { code: 2, stdout: '', stderr: `거부: ${repo}#${pr.number} 는 draft 가 아니라 behind-draft 로 base 를 합치지 않는다\n`, timedOut: false }
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
// 실패로 보는 체크 실행의 결론과 커밋 상태의 상태. 롤업의 값은 GraphQL enum 이라 머지 큐의 jq test(정규식)와 같은 집합이다
export const FAILED_CONCLUSIONS: readonly string[] = ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']
export const FAILED_STATES: readonly string[] = ['FAILURE', 'ERROR']

export type Names = { ok: true; names: string[] } | { ok: false; error: string }
export type CiCheck = { name: string; status: string | null; conclusion: string | null; url: string | null }
export type CiState = { state: 'passed' | 'failed' | 'pending'; checks: CiCheck[] }

// 무료 플랜의 비공개 저장소는 규칙 API 를 읽을 수 없다(HTTP 403 과 Upgrade to GitHub Pro). 필수 체크 목록이 없는 것으로 다룬다
export function rulesPlanLimited(stderr: string): boolean {
  return stderr.includes('HTTP 403') && stderr.includes('Upgrade to GitHub Pro')
}

// base 의 저장소 규칙이 정한 필수 체크 이름. 플랜 제한은 빈 목록이다. slug 는 owner/repo 다.
export function ruleChecks(host: string, slug: string, base: string): Names {
  const path = `repos/${slug}/rules/branches/${base}`
  const done = gh(['api', '--hostname', host, path, '--jq', RULES_JQ])
  if (done.code === 0) {
    try {
      return { ok: true, names: parseNames(done.stdout.trim()) }
    } catch (e) {
      return { ok: false, error: `gh api ${path} 의 출력을 읽지 못했다: ${(e as Error).message}` }
    }
  }
  if (rulesPlanLimited(done.stderr)) return { ok: true, names: [] }
  return { ok: false, error: `gh api ${path} 가 종료 코드 ${done.code} 로 끝났다: ${(done.stderr || done.stdout).trim()}` }
}

// 필수 체크 이름. config.json 의 queue.required 가 있으면 그것(목록이면 그대로이고 이름에 쉼표가 있어도 나누지 않는다, 문자열이면 쉼표로 나눈다)이고 규칙 API 를 부르지 않는다.
// 없으면 ruleChecks 다. required 를 받는 꼴은 merge-with-finish 가 머지 큐에 넘길 때와 같고, 틀리면 ConfigError 다.
export function requiredNames(repo: string, host: string, slug: string, base: string): Names {
  const queue = section<{ required?: unknown }>(loadConfig(repo), 'queue', QUEUE_KEYS)
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

function field(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' ? value : null
}

// 롤업 행의 이름. 체크 실행은 name, 커밋 상태는 context 다(머지 큐의 `.name // .context`)
function checkName(row: Record<string, unknown>): string {
  return field(row, 'name') ?? field(row, 'context') ?? ''
}

function failedRow(row: Record<string, unknown>): boolean {
  return FAILED_CONCLUSIONS.includes(field(row, 'conclusion') ?? '') || FAILED_STATES.includes(field(row, 'state') ?? '')
}

// 머지 큐의 PENDING 과 같다. 체크 실행은 status 가 COMPLETED 가 아니면, 커밋 상태는 state 가 PENDING 이나 EXPECTED 면 아직이다
function pendingRow(row: Record<string, unknown>): boolean {
  const state = field(row, 'state')
  return (field(row, 'status') ?? 'COMPLETED') !== 'COMPLETED' || state === 'PENDING' || state === 'EXPECTED'
}

// ciState 가 낸 체크가 실패인가. status 는 체크 실행의 status 나 커밋 상태의 state 다. 체크 실행의 status 에는 FAILURE, ERROR 가 없다
export function failedCheck(check: CiCheck): boolean {
  return FAILED_CONCLUSIONS.includes(check.conclusion ?? '') || FAILED_STATES.includes(check.status ?? '')
}

// PR 의 statusCheckRollup 으로 CI 상태를 정한다. 머지 큐의 기본 판정(--allow-fail 없음)과 같다.
//   failed   롤업의 체크 하나라도 실패다(FAILED_CONCLUSIONS, FAILED_STATES). 필수 체크가 아니어도 실패다(머지 큐의 waitChecks 가 멈춘다)
//   passed   실패가 없고, 필수 체크가 모두 나타났고, 롤업의 체크가 모두 끝났다. 필수가 아닌 체크가 아직 돌면 머지 큐도 기다리므로 pending 이다
//   pending  그 밖. 체크가 하나도 없을 때도 pending 이다. 머지 큐는 「지금 있는 체크만 기다린다」 로 바로 넘어가지만, 루프는 체크가
//            붙기 전에 ci-passed 를 내지 않는다
// required 가 비면(규칙 없음, 플랜 제한) 나타난 체크 전부로 판정하는 것과 같다.
// skippedIsMissing 이면 결론이 SKIPPED 인 체크를 나타나지 않은 것으로 본다(머지 큐의 --skipped-is-missing).
// checks 는 롤업에 나타난 체크 전부다. 실패한 것은 failedCheck 로 고른다.
export function ciState(rollup: unknown, required: readonly string[], skippedIsMissing: boolean): CiState {
  const rows = (Array.isArray(rollup) ? rollup : []).filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row),
  )
  const seen = rows.filter((row) => !(skippedIsMissing && field(row, 'conclusion') === 'SKIPPED'))
  const checks = seen.map((row) => ({
    name: checkName(row),
    status: field(row, 'status') ?? field(row, 'state'),
    conclusion: field(row, 'conclusion'),
    url: field(row, 'detailsUrl') ?? field(row, 'targetUrl'),
  }))
  if (seen.some(failedRow)) return { state: 'failed', checks }
  const missing = required.some((name) => !seen.some((row) => checkName(row) === name))
  if (seen.length === 0 || missing || seen.some(pendingRow)) return { state: 'pending', checks }
  return { state: 'passed', checks }
}
