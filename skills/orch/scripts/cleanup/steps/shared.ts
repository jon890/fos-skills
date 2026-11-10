import { LINE_BREAK } from '../../lib/spec.ts'
import type { WorkerRow } from '../../lib/ownership.ts'
import { isObject } from '../../core/json.ts'
import { readFileSync } from 'node:fs'
import { run as runCommand } from '../../lib/proc.ts'

export const RUN_TIMEOUT_SEC = 120

export const BY_PR = 'PR MERGED'

export const BY_NO_PR = 'PR 없음, 끝난 dispatch, base 보다 앞선 커밋 0 개'

export type Json = Record<string, unknown>

export type Terminal = Json

export type Pr = Json & { number: number; state: string }

export type Log = (line: string) => void

export type Report = { removed: string[]; skipped: { path: string; reason: string }[] }

export type Args = {
  base: string
  run: string | null
  specsDir: string | null
  killHolders: boolean
  agentGlob: string
  closeOwnTakenOver: boolean
  remoteBranches: boolean
  trash: string
  apply: boolean
  wait: number
  pollInterval: number
  removeTimeoutSec: number
  // 다른 Run 의 worker 가 쥔 살아 있는 터미널 handle. --run 이 없거나 모든 Run 을 읽지 못하면 null 이다
  foreign: Set<unknown> | null
  allWorkers: () => Promise<WorkerRow[]>
  worktreeWorkers: (path: string) => Promise<WorkerRow[]>
  liveSpecs: Set<string> | null
}

// 저장소 하나를 읽지 못했다. main 이 stderr 에 내고 종료 코드를 2 로 하고 다음 저장소로 간다
export class RepoError extends Error {}

// Python 의 참거짓 판정. 옛 명령의 `if x` 와 `x or y` 를 같게 옮긴다. 빈 목록과 빈 객체도 거짓이다
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (isObject(value)) return Object.keys(value).length > 0
  return value !== undefined && value !== null && value !== '' && value !== 0 && value !== false
}

export function resourceOf(row: Json): Json {
  return isObject(row.resource) ? row.resource : {}
}

export function lines(text: string): string[] {
  return text ? text.split(LINE_BREAK) : []
}

// 옛 명령의 run 과 같게 stdout 과 stderr 의 앞뒤 공백을 지운다. 시간을 넘기면 1 과 그 이유다
export function run(argv: string[], opts: { cwd?: string; timeoutSec?: number } = {}): { code: number; out: string; err: string } {
  const seconds = opts.timeoutSec ?? RUN_TIMEOUT_SEC
  const done = runCommand(argv, { cwd: opts.cwd, timeoutMs: seconds * 1000 })
  if (done.timedOut) return { code: 1, out: '', err: `${argv.join(' ')} 가 ${seconds}초 안에 끝나지 않았다` }
  return { code: done.code, out: done.stdout.trim(), err: done.stderr.trim() }
}

export function git(repo: string, ...args: string[]): { code: number; out: string; err: string } {
  return run(['git', '-C', repo, ...args])
}

// 기본 체크아웃을 뺀 [경로, 브랜치] 목록. 브랜치가 없으면 빈 문자열이다.
export function worktrees(repo: string): [string, string][] {
  const listed = git(repo, 'worktree', 'list', '--porcelain')
  if (listed.code !== 0) throw new RepoError(`git worktree list 실패: ${repo}`)
  const items: [string, string][] = []
  let path: string | null = null
  let branch = ''
  for (const line of [...lines(listed.out), '']) {
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
      branch = ''
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length)
      branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (!line && path) {
      items.push([path, branch])
      path = null
    }
  }
  return items.slice(1)
}

export function dirty(path: string): boolean {
  const done = git(path, 'status', '--porcelain')
  return done.code !== 0 || done.out !== ''
}

export function under(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

// 「내 PR」 의 작성자 목록. 읽지 못했으면 null 이다
export type Owners = () => string[] | null

export type Sweep = { repo: string; args: Args; workers: WorkerRow[]; specsDir: string | null; log: Log; report: Report; owners: Owners }
