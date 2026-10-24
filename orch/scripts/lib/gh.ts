// gh 호출의 한 벌이다. 실행 파일은 GH 환경 변수, 없으면 gh 다.
// 내 PR 판정(작성자)과 update-branch 를 부를 수 있는 경우를 이 모듈 한 곳에서 정한다.

import { run } from './proc.ts'
import type { RunResult } from './proc.ts'

type GhOptions = { host?: string; cwd?: string }

export function ghBin(): string {
  return process.env.GH || 'gh'
}

export function gh(args: string[], opts: GhOptions = {}): RunResult {
  return run([ghBin(), ...args], { cwd: opts.cwd, env: opts.host ? { GH_HOST: opts.host } : undefined })
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

// GitHub 로그인은 대소문자를 가리지 않으므로 소문자로 맞춰 비교한다.
export function isOwnPr(pr: { author: { login: string } }, authors: string[]): boolean {
  const login = pr.author.login.toLowerCase()
  return authors.some((author) => author.toLowerCase() === login)
}

// base 를 합치는 유일한 경로다. 머지 차례가 온 PR(merge-turn)과 뒤처진 draft(behind-draft)에만 부른다.
// reason 은 호출 이유를 출력과 기록에 남기려고 받는다. draft 여부는 부르는 쪽이 gh 조회에서 받아 넘긴다.
export function updateBranch(repo: string, pr: { number: number; isDraft: boolean }, reason: 'merge-turn' | 'behind-draft'): RunResult {
  if (reason === 'behind-draft' && !pr.isDraft) {
    return { code: 2, stdout: '', stderr: `거부: ${repo}#${pr.number} 는 draft 가 아니라 behind-draft 로 base 를 합치지 않는다\n`, timedOut: false }
  }
  process.stderr.write(`update-branch ${repo}#${pr.number} 이유: ${reason}\n`)
  return gh(['api', '-X', 'PUT', `repos/${repo}/pulls/${pr.number}/update-branch`])
}
