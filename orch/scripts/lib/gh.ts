// gh 호출의 한 벌이다. 실행 파일은 GH 환경 변수, 없으면 gh 다.
// 내 PR 판정(작성자)과 update-branch 를 부를 수 있는 경우를 이 모듈 한 곳에서 정한다.
//
// 시간 제한: 읽는 호출은 lib/proc.ts 의 기본(60초)이다. 쓰는 호출(머지, update-branch, base 옮기기)은 부르는 쪽이
// timeoutMs 로 NO_LIMIT_MS 를 준다. 옛 명령은 쓰는 호출에 시간 제한을 두지 않았고, 끊으면 GitHub 에서는 끝난 쓰기를
// 실패로 읽는다. updateBranch 는 늘 NO_LIMIT_MS 다.
//
// 호스트: `gh api` 는 origin 을 보지 않고 기본 호스트로 간다. 그래서 GitHub Enterprise 저장소에서 `api user` 를 그냥 부르면
// 다른 호스트의 사용자가 오거나 null 이 된다. 호스트는 PR URL 에서 읽어(apiTarget) GH_HOST 나 --hostname 으로 준다.

import { ConfigError, loadConfig, PIPELINE_KEYS, section } from './config.ts'
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
