// 메인이 아닌 Run 의 쓰기 경계(ADR-035). 명령의 옵션을 파싱한 뒤, 쓰기 전에 부른다.
//
// guardWrite(repo, command, reason, target):
//   메인이 없거나 실제 run-current 가 메인/Run 없는 셸이면 허용한다. --run 이 신원을 바꾸지 않는다.
//   다른 Run 은 NOT-MAIN main=<Run> caller=<Run> repo=<경로> command=<명령> 과 요청 명령, 코드 1 이다.
//   옛 기록 또는 main_guard.main=null 인 worker 는 원래 Run 의 해당 dispatch/worktree/PR 에만 예외다.
//   sweep 예외의 worktrees 집합 밖과 저장소 전체 단계는 호출자가 건드리지 않는다.
//   --not-main 이유는 빈 값과 다음 옵션이면 NOT-MAIN-REASON, 코드 2 다.
//   DECISION27 의 별도 우회 기록을 먼저 쓰고 메인에게 notifyRun 으로 알린다. 실패하면 코드 1 이고 실제 쓰기는 하지 않는다.
//   NOT-MAIN-RECORD-FAIL, NOT-MAIN-NOTICE-FAIL 은 기록/전송 실패, MAIN-UNKNOWN 은 메인 조회 실패,
//   MAIN-CALLER-UNKNOWN 은 실제 호출 Run 을 읽지 못한 경우다. 모두 코드 1 이다.
// mainDoctorLines(repo): NON-MAIN-RUN, FOREIGN-WORKER 로 남은 소유를 알린다. SKIP-MAIN/WORKERS 는 조회 실패다.
//   doctor 의 기존 종료 코드는 바꾸지 않는다. 정확한 기록 필드는 lib/launched.ts 와 docs/data-schema.md 가 소유한다.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { mainCheckout } from './git.ts'
import { ghJson } from './gh.ts'
import { allLaunches, readLaunch } from './launched.ts'
import type { Launch, MainGuardStamp } from './launched.ts'
import { findMain } from './main-coordinator.ts'
import { registeredRuns } from './loop.ts'
import { orcaJson } from './orca.ts'
import { ensure } from './paths.ts'
import { realPath } from './fs.ts'
import { shQuote } from './py.ts'
import { notifyRun } from './run-notice.ts'

export const MAIN_GUARD_OPTIONS = { 'not-main': { type: 'string' } } as const
type Caller = { kind: 'caller'; run: string | null } | { kind: 'unknown'; error: string }

export function boardRepo(repo: string, board?: string | null): string {
  if (!board) return mainCheckout(repo)
  let dir = dirname(realPath(board))
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir)
  return mainCheckout(dir)
}

export function dispatchRepo(repo: string, dispatch: string): string | null {
  const got = orcaJson<{ dispatch?: { id?: string; runId?: string }; worker?: { worktreeId?: string; startOptions?: { resolvedWorktreeId?: string; worktree?: string } } }>(['orchestration', 'worker-show', '--dispatch', dispatch])
  if (!got.ok) return null
  const worker = got.data?.worker
  const id = worker?.worktreeId ?? worker?.startOptions?.resolvedWorktreeId ?? worker?.startOptions?.worktree ?? ''
  const raw = id.includes('::') ? id.slice(id.indexOf('::') + 2) : id.replace(/^path:/, '')
  if (isAbsolute(raw)) return mainCheckout(raw)
  const recorded = readLaunch(repo, dispatch)
  return recorded && got.data?.dispatch?.id === dispatch && got.data.dispatch.runId === recorded.run ? mainCheckout(recorded.worktree) : null
}

// --run 은 대상 Run 이다. 호출자의 신원은 실제 run-current 로만 읽는다.
export function callerRun(): Caller {
  const got = orcaJson<{ run?: { id?: unknown } | null; runId?: unknown }>(['orchestration', 'run-current'], { timeoutMs: 5_000 })
  if (!got.ok) return { kind: 'unknown', error: got.error }
  const value = got.data?.run?.id ?? got.data?.runId
  if (typeof value === 'string' && value) return { kind: 'caller', run: value }
  if (got.data?.run === null || got.data?.runId === null) return { kind: 'caller', run: null }
  return { kind: 'unknown', error: 'run-current 에 Run 또는 명시적인 Run 없음이 없다' }
}

export function callerIsMain(repo: string, readUnboundMain = true) {
  const target = mainCheckout(repo)
  if (!registeredRuns(target).length) return { main: { kind: 'none' as const, stale: [] as string[] }, caller: { kind: 'caller', run: null } as Caller, allowed: true }
  const caller = callerRun()
  // Run 없는 셸의 단순 쓰기에는 메인을 조회할 필요가 없다. 띄우기 표지와 우회 알림은 실제 메인을 읽는다.
  if (!readUnboundMain && caller.kind === 'caller' && caller.run === null) return { main: { kind: 'none' as const, stale: [] as string[] }, caller, allowed: true }
  const main = findMain(target)
  return { main, caller, allowed: main.kind === 'none' || caller.kind === 'caller' && (caller.run === null || main.kind === 'main' && main.run === caller.run) }
}

export type GuardTarget = { dispatch?: string; worktree?: string; prs?: (string | number)[]; sweepRun?: string | null }
export type GuardResult = { code: 0; stamp: MainGuardStamp; reason?: string; worktrees?: Set<string>; ownerRun?: string } | { code: 1 | 2 }

export function legacyOwned(launch: Launch, caller: string): boolean {
  return !launch.invalid_main_guard && launch.run === caller && (!launch.main_guard || launch.main_guard.main === null)
}

// 최신 기록부터 읽어 같은 경로의 앞 소유자에게 권한이 돌아가지 않게 한다.
function ownedLaunches(repo: string, caller: string): Launch[] {
  const seen = new Set<string>()
  return allLaunches(repo).filter(launch => {
    const worktree = realPath(launch.worktree)
    if (seen.has(worktree)) return false
    seen.add(worktree)
    return legacyOwned(launch, caller)
  })
}

function exception(repo: string, caller: string, target: GuardTarget): Set<string> | null {
  if (target.dispatch) {
    const launch = readLaunch(repo, target.dispatch)
    return launch && legacyOwned(launch, caller) && (!target.worktree || realPath(launch.worktree) === realPath(target.worktree)) ? new Set([realPath(launch.worktree)]) : null
  }
  const owned = ownedLaunches(repo, caller)
  if (!owned.length) return null
  if (target.worktree) {
    const worktree = realPath(target.worktree)
    return owned.some(l => realPath(l.worktree) === worktree) ? new Set([worktree]) : null
  }
  if (target.prs?.length) {
    const paths = new Set<string>()
    for (const pr of target.prs) {
      const got = ghJson<{ headRefName?: string }>(['pr', 'view', String(pr), '--json', 'headRefName'], { cwd: repo })
      if (!got.ok || !got.data?.headRefName) return null
      const launch = owned.find(l => l.branch === got.data.headRefName)
      if (!launch) return null
      paths.add(realPath(launch.worktree))
    }
    return paths
  }
  if (target.sweepRun === caller && owned.length) return new Set(owned.map(l => realPath(l.worktree)))
  return null
}

export function guardWrite(repoArg: string, command: string, reason: unknown, target: GuardTarget = {}): GuardResult {
  const reject = (code: 1 | 2, line: string): GuardResult => { process.stderr.write(`${line}\n`); return { code } }
  if (reason !== undefined && (typeof reason !== 'string' || !reason.trim() || reason.trim().startsWith('--'))) return reject(2, 'NOT-MAIN-REASON --not-main 에는 우회하는 이유가 필요하다')
  const repo = mainCheckout(repoArg)
  const judged = callerIsMain(repo, command === 'worker launch' || reason !== undefined)
  const { main, allowed } = judged
  const caller = reason !== undefined && main.kind === 'none' ? callerRun() : judged.caller
  const stamp: MainGuardStamp = { version: 1, main: main.kind === 'main' ? main.run : null, caller_repo: mainCheckout(process.cwd()), target_repo: repo }
  if (allowed && reason === undefined) return { code: 0, stamp }
  if (caller.kind === 'unknown') return reject(1, `MAIN-CALLER-UNKNOWN ${caller.error}`)
  if (main.kind === 'unknown') return reject(1, `MAIN-UNKNOWN ${main.error}`)
  if (!allowed && caller.run && reason === undefined) {
    const worktrees = exception(repo, caller.run, target)
    if (worktrees) return { code: 0, stamp, worktrees, ownerRun: caller.run }
    return reject(1, `NOT-MAIN main=${main.kind === 'main' ? main.run : '-'} caller=${caller.run} repo=${repo} command=${command}\n  orch request send --to ${shQuote(repo)} --title "<할 일>" --body "<요청 내용>"`)
  }
  if (reason === undefined) return { code: 0, stamp }
  const text = String(reason).trim()
  const record = { repo, caller_run: caller.run, main_run: stamp.main, command, reason: text, at: new Date().toISOString(), notified: false }
  let file: string
  try {
    const dir = join(ensure('state', repo), 'launched-workers', 'not-main')
    mkdirSync(dir, { recursive: true })
    file = join(dir, `${randomUUID()}.json`)
    writeFileSync(file, JSON.stringify(record) + '\n', { flag: 'wx' })
  } catch (e) { return reject(1, `NOT-MAIN-RECORD-FAIL ${(e as Error).message}`) }
  if (stamp.main) {
    const sent = notifyRun(stamp.main, 'NOT-MAIN', `repo=${repo}\ncaller=${caller.run ?? '-'}\ncommand=${command}\nreason=${text}`, null, { repo, source: 'orch-main-guard' })
    if (!sent.ok) return reject(1, `NOT-MAIN-NOTICE-FAIL ${sent.error} record=${file}`)
    try { writeFileSync(file, JSON.stringify({ ...record, notified: true }) + '\n') }
    catch (e) { return reject(1, `NOT-MAIN-RECORD-FAIL ${(e as Error).message}`) }
  }
  return { code: 0, stamp, reason: text }
}

export function mainDoctorLines(repo: string): string[] {
  const main = findMain(repo)
  if (main.kind === 'unknown') return [`SKIP-MAIN ${main.error}`]
  const lines = registeredRuns(repo).filter(row => main.kind !== 'main' || row.run !== main.run)
    .map(row => `NON-MAIN-RUN ${row.run} main=${main.kind === 'main' ? main.run : '-'} repo=${repo}`)
  try {
    for (const launch of allLaunches(repo)) {
      if (main.kind === 'main' && launch.run === main.run && (!launch.main_guard || launch.main_guard.caller_repo === mainCheckout(repo))) continue
      lines.push(`FOREIGN-WORKER ${launch.dispatch} run=${launch.run ?? '-'} worktree=${launch.worktree} spec=${launch.spec ?? '-'} caller_repo=${launch.main_guard?.caller_repo ?? '-'}`)
    }
  } catch (e) { lines.push(`SKIP-MAIN-WORKERS ${(e as Error).message}`) }
  return lines
}
