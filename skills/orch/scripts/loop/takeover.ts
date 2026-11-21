// 메인 코디네이터 넘겨받기(ADR-035). lifecycle.ts 의 mainGate 가 메인을 판정한 뒤 부른다. 계약은
// docs/features/orch-main-coordinator/design.md 의 「`orch loop start` 의 차례」 와 「worker 옮기기」 다.
//
// 언제: 메인이 없을 때(자동, 스펙 REQ2), 메인이 이 Run 인데 도는 루프가 다른 Run 의 명의로 묶였을 때(다시 띄우기),
//     메인이 살아 있어도 --take-over --confirmed "<사용자 답>" 을 줬을 때(스펙 REQ3).
//     --confirmed 는 코디네이터가 사용자에게 물어 받은 답이다. 스크립트는 채팅 답을 확인할 수 없다. 보드 승인의 채팅 승인과 같은 한계이며,
//     그 답을 앞 메인에게 가는 MAIN-TAKEN 알림 본문에 남겨 앞 메인이 본다.
// 잠금: 판정부터 새 루프가 뜰 때까지 state/takeover.lock 을 쥔다(holdTakeover). 두 세션이 함께 넘겨받지 않게 한다.
//     잠금 안에서 메인을 다시 판정하므로, 기다린 쪽은 먼저 넘겨받은 Run 을 메인으로 보고 MAIN-EXISTS 로 끝난다. 60초 안에 얻지 못하면 TAKEOVER-BUSY.
// 차례(lifecycle.ts 의 takeOver):
//     1. 도는 루프 프로세스를 멈춘다. 멈추지 못하면 등록을 건드리지 않고 TAKEOVER-FAIL stop 이다
//     2. 지울 Run 등록(앞 메인과 살아 있지 않은 Run)을 지우고 state/takeover.json 의 옮길 Run 목록에 더한다
//     3. 지금 흐름으로 새 루프를 띄운다. 실패하면 TAKEOVER-FAIL start 다. 이 Run 은 이미 등록됐으므로 다시 --start 하면 메인으로 이어 간다
//     4. 새 loop.json 의 bound_run 이 이 Run(또는 묶이지 않음)일 때만 worker 를 옮긴다(moveWorkers). 아니면 TAKEOVER-RACE <bound_run> 이다
//     5. MAIN-TAKEN <새 Run> from=<지운 Run 목록 또는 -> 을 내고, 명시적 넘겨받기면 앞 메인 Run 에 MAIN-TAKEN 알림을 보낸다
//     6. 끝나지 않은 요청마다 REQUEST-OPEN <번호> <상태> <제목> 을 낸다
//     ADR-032(옛 루프가 잠금을 넘기는 넘겨받기)와 달리 옛 루프를 먼저 멈춘다. 새 루프는 넘겨받는 터미널의 명의로 떠야 해서 옛 루프가 자식으로 띄울 수 없다.
// 다시 옮기기: 메인이 이 Run 일 때 --take-over 를 주면 state/takeover.json 의 Run 들에서 옮기지 못한 worker 를 다시 옮긴다.
//     작업 중이라 남은 worker 는 일이 끝나 화면이 쉬면 이것으로 옮긴다.
//
// worker 옮기기(moveWorkers): 옮길 Run 마다 worker-list --run 을 읽어 살아 있는 dispatch 를 본다.
//     워크트리가 이 저장소의 git 워크트리(주 checkout 은 뺀다)가 아니면 옮기지 않고 WORKER-OTHER-REPO <터미널 또는 -> <dispatch> <워크트리> 를 낸다.
//     아래를 모두 확인한 뒤에만 worker-abandon 과 worker-start --terminal 을 부른다. 하나라도 아니면 옮기지 않고
//     WORKER-NOT-MOVED <터미널 또는 -> <dispatch> <이유> 다.
//       터미널이 열려 있고 에이전트가 있다(이유: 터미널 없음)
//       화면이 idle, error, interrupted 다(이유: 작업 중. 작업 중인 dispatch 를 끊으면 그 턴의 보고가 사라진다)
//       현재 또는 같은 브랜치·워크트리의 이전 띄우기 기록에 지시서 파일이 있다(이유: 지시서 모름)
//       worker-start 가 --terminal 과 --worktree 를 받는다(이유: CLI 가 이어 붙이기를 모른다)
//     abandon 이 실패하면 WORKER-NOT-MOVED <터미널> <dispatch> abandon 실패. worker-start 가 실패하면 다시 시도하지 않고
//     WORKER-MOVE-FAIL <터미널> <이어받기 파일> 이다. 그 터미널은 dispatch 가 없어 orch worker adopt 로 잇는다.
//     성공하면 앞 기록을 복사해 새 dispatch 로 띄우기 기록을 남기고 앞 기록은 지운다. 보드의 그 worker 줄은 새 dispatch 로 다시 잇는다
//     (끊긴 worker 로 보지 않게 한다). WORKER-MOVED <터미널> <앞 dispatch> <새 dispatch> 다.
//     옮길 Run 의 worker 목록을 읽지 못하면 WORKER-LIST-FAIL <Run> <이유> 다.
//     옮기지 못한 worker 와 조회에 실패한 Run 은 takeover.json 에 남긴다. 새 메인은 마지막 보고를 읽기 전용으로 확인한다.

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { boardWorkerRows } from '../core/board-workers.ts'
import { isObject, objectOr } from '../core/json.ts'
import { LIVE_DISPATCH } from '../core/workers.ts'
import { classify, screenLines, screenTail } from '../core/screen.ts'
import { context } from '../core/completion.ts'
import { senderOf, subjectOf } from '../core/message-fields.ts'
import { isQuietStop } from '../core/stop-reports.ts'
import { isFile } from '../lib/fs.ts'
import { BOARD_BIN, readBoard } from '../lib/board.ts'
import { boardPath } from '../lib/board-file.ts'
import { allLaunches, forgetLaunch, readLaunch, recordLaunch } from '../lib/launched.ts'
import { terminalFacts } from '../lib/main-coordinator.ts'
import { orca, orcaJson } from '../lib/orca.ts'
import { rowHandles } from '../lib/ownership.ts'
import { makeParent, pathOf } from '../lib/paths.ts'
import { NO_LIMIT_MS, run, scriptCommand } from '../lib/proc.ts'
import { openRequests } from '../lib/requests.ts'
import { notifyRun } from '../lib/run-notice.ts'
import { handover } from '../lib/sessions.ts'
import type { Session } from '../lib/sessions.ts'
import { worktreePaths, workerRows } from '../lib/workers.ts'
import { log, oneLine } from './steps/shared.ts'

type Json = Record<string, unknown>

type PendingWorker = { dispatch: string; worktree: string }
type Pending = { from: string[]; workers?: Record<string, PendingWorker[]> }

function pendingFile(repo: string): string {
  return join(pathOf('state', repo), 'takeover.json')
}

function readPending(repo: string): Pending {
  try {
    const parsed = objectOr(JSON.parse(readFileSync(pendingFile(repo), 'utf8')))
    const from = Array.isArray(parsed.from) ? parsed.from.filter((r): r is string => typeof r === 'string' && r !== '') : []
    const workers = Object.fromEntries(from.map(run => {
      const rows = objectOr(parsed.workers)[run]
      return [run, Array.isArray(rows) ? rows.filter(row => isObject(row) && typeof row.dispatch === 'string' && typeof row.worktree === 'string') : []]
    }))
    return { from, workers }
  } catch {
    return { from: [] }
  }
}

export function pendingRuns(repo: string): string[] {
  return readPending(repo).from
}

function writeState(file: string, repo: string, data: unknown): void {
  makeParent(file, repo)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(data)}\n`)
  renameSync(temporary, file)
}

export function writePending(repo: string, runs: string[], workers = readPending(repo).workers ?? {}): void {
  const from = [...new Set(runs)]
  writeState(pendingFile(repo), repo, { from, workers: Object.fromEntries(from.filter(run => workers[run]?.length).map(run => [run, workers[run]])) })
}

function rowWorktree(row: Json): string {
  const id = String(objectOr(row.resource).worktreeId ?? '')
  const at = id.indexOf('::')
  return at >= 0 ? resolve(id.slice(at + 2)) : ''
}

const MOVABLE = new Set(['idle', 'error', 'interrupted'])

function receiptValue(stdout: string, keys: string[]): string {
  let result: unknown
  try { result = (JSON.parse(stdout) as { result?: unknown }).result } catch { return '' }
  for (const key of keys) {
    let value: unknown = result
    for (const part of key.split('.')) value = isObject(value) ? value[part] : undefined
    if (typeof value === 'string' && value) return value
  }
  return ''
}

// 보드의 앞 dispatch 줄을 새 dispatch 로 다시 잇는다. 보드가 없거나 그 줄이 없으면 아무것도 하지 않는다
function relinkBoard(repo: string, worktree: string, branch: string, before: string, after: string): string | null {
  const file = boardPath(repo)
  if (!existsSync(file)) return null
  let items
  try { items = readBoard(file) } catch (e) { return `보드를 읽지 못했다: ${oneLine(e)}` }
  for (const item of items) {
    const row = boardWorkerRows(item).find((r) => r.dispatch === before)
    if (!row) continue
    const bin = process.env.BOARD_BIN || BOARD_BIN
    const done = run(scriptCommand(bin, ['worker-add', item.id, row.role, '--worktree', basename(worktree), '--branch', branch, '--dispatch', after, '--file', file]), { timeoutMs: NO_LIMIT_MS })
    return done.code === 0 ? null : `보드 ${item.id} 의 worker 줄을 잇지 못했다: ${oneLine(done.stderr || done.stdout)}`
  }
  return null
}

export function moveWorkers(repo: string, fromRuns: string[], toRun: string): { lines: string[]; remaining: string[]; workers: Record<string, PendingWorker[]> } {
  const lines: string[] = []
  const remaining = new Set<string>()
  const workers: Record<string, PendingWorker[]> = {}
  if (fromRuns.length === 0) return { lines, remaining: [], workers }
  const branches = new Map([...worktreePaths(repo)].map(([branch, directory]) => [resolve(directory), branch]))
  branches.delete(resolve(repo))
  const terminals = terminalFacts()
  if (typeof terminals === 'string') return { lines: [`WORKER-LIST-FAIL terminals ${oneLine(terminals).slice(0, 200)}`], remaining: fromRuns.filter((r) => r !== toRun), workers }
  let canAttach: boolean | null = null
  let launches: ReturnType<typeof allLaunches> | undefined
  for (const from of fromRuns) {
    if (from === toRun) continue
    const listed = workerRows(from)
    if (!listed.ok) {
      lines.push(`WORKER-LIST-FAIL ${from} ${oneLine(listed.error).slice(0, 200)}`)
      remaining.add(from)
      continue
    }
    workers[from] = []
    for (const row of listed.rows) {
      const dispatch = typeof row.dispatchId === 'string' ? row.dispatchId : ''
      if (!dispatch || !LIVE_DISPATCH.has(String(row.dispatchStatus))) continue
      const worktree = rowWorktree(row)
      const handles = [...rowHandles(row)].filter((h): h is string => typeof h === 'string')
      const branch = branches.get(worktree)
      if (!branch) {
        lines.push(`WORKER-OTHER-REPO ${handles[0] ?? '-'} ${dispatch} ${worktree || '-'}`)
        continue
      }
      const notMoved = (who: string, why: string) => {
        lines.push(`WORKER-NOT-MOVED ${who} ${dispatch} ${why}`)
        remaining.add(from)
        workers[from].push({ dispatch, worktree })
      }
      const handle = handles.find((h) => !!terminals.get(h)?.agent && !!terminals.get(h)?.connected)
      if (!handle) { notMoved('-', '터미널 없음'); continue }
      const screen = orcaJson<Json>(['terminal', 'read', '--terminal', handle, '--screen', '--limit', '40'])
      const state = screen.ok ? classify(screenTail(screenLines(screen.data), 20)) : 'unknown'
      if (!MOVABLE.has(state)) { notMoved(handle, `작업 중(${state})`); continue }
      const recorded = readLaunch(repo, dispatch)
      const launch = recorded && resolve(recorded.worktree) === worktree && (!recorded.branch || recorded.branch === branch) ? recorded : null
      let spec = launch?.spec && isFile(launch.spec) ? launch.spec : null
      if (!spec) {
        try {
          launches ??= allLaunches(repo)
          spec = launches.find(candidate => candidate.branch === branch && resolve(candidate.worktree) === worktree && candidate.spec && isFile(candidate.spec))?.spec ?? null
        } catch (e) {
          notMoved(handle, `띄우기 기록 읽기 실패: ${oneLine(e).slice(0, 160)}`)
          continue
        }
      }
      if (!spec) { notMoved(handle, '지시서 모름'); continue }
      if (canAttach === null) {
        const help = orca(['orchestration', 'worker-start', '--help'])
        const text = help.stdout + help.stderr
        canAttach = help.code === 0 && text.includes('--terminal') && text.includes('--worktree')
      }
      if (!canAttach) { notMoved(handle, 'CLI 가 이어 붙이기를 모른다'); continue }
      const session: Session = { terminal: handle, worktree, branch, agent: 'agent', state: state as Session['state'], lines: [], specs: [spec], prs: null,
        previous: [{ dispatch, task: row.taskId, status: row.dispatchStatus }] }
      const file = join(mkdtempSync(join(tmpdir(), 'orch-takeover-')), 'handover.md')
      writeFileSync(file, handover(session, spec))
      const abandoned = orcaJson<Json>(['orchestration', 'worker-abandon', '--dispatch', dispatch])
      if (!abandoned.ok) { notMoved(handle, `abandon 실패: ${oneLine(abandoned.error).slice(0, 160)}`); continue }
      const started = orca(['orchestration', 'worker-start', '--spec', `지시서 ${JSON.stringify(file)} 를 끝까지 읽고 수행한다.`,
        '--terminal', handle, '--worktree', `path:${worktree}`, '--run', toRun, '--json'])
      const moved = started.code === 0 ? receiptValue(started.stdout, ['dispatch.id', 'dispatchId', 'worker.dispatchId']) : ''
      if (!moved) {
        lines.push(`WORKER-MOVE-FAIL ${handle} ${file}`)
        remaining.add(from)
        workers[from].push({ dispatch, worktree })
        continue
      }
      try {
        recordLaunch(repo, { ...(launch ?? {}), dispatch: moved, task: receiptValue(started.stdout, ['dispatch.taskId', 'taskId', 'task.id']) || null, terminal: handle, worktree, run: toRun, spec, branch })
        forgetLaunch(repo, dispatch)
      } catch (e) { log(`takeover: ${moved} 의 띄우기 기록을 남기지 못했다: ${oneLine(e)}`) }
      const board = relinkBoard(repo, worktree, branch, dispatch, moved)
      if (board) log(`takeover: ${board}`)
      lines.push(`WORKER-MOVED ${handle} ${dispatch} ${moved}`)
    }
  }
  return { lines, remaining: [...remaining], workers }
}

// 옮기고 남은 Run 을 takeover.json 에 둔다. 옮긴 Run 목록 밖의 남은 항목은 그대로 둔다
export function settlePending(repo: string, tried: string[], remaining: string[], workers: Record<string, PendingWorker[]> = {}): void {
  const before = readPending(repo)
  const keep = before.from.filter((r) => !tried.includes(r))
  writePending(repo, [...keep, ...remaining], { ...before.workers, ...workers })
}

const REPORT_TYPES = new Set(['status', 'worker_done', 'question', 'escalation', 'merge_ready'])

// 최근 메일부터 읽는다. 다른 worker 보고에 밀렸으면 조회 범위를 넓혀 필요한 dispatch 를 찾는다.
function lastReports(run: string, workers: Map<string, string>, senders: Map<string, string | null>): { reports: Map<string, Json>; error?: string } {
  const reports = new Map<string, Json>()
  for (const limit of [200, 3000]) {
    const inbox = orcaJson<{ messages?: unknown }>(['orchestration', 'inbox', '--terminal', `run:${run}`, '--limit', String(limit)], { timeoutMs: 10_000 })
    if (!inbox.ok) return { reports, error: oneLine(inbox.error).slice(0, 160) }
    if (!Array.isArray(inbox.data?.messages)) return { reports, error: '메시지 목록 없음' }
    for (const message of inbox.data.messages) {
      if (!isObject(message) || !REPORT_TYPES.has(String(message.type)) || isQuietStop(message)) continue
      const [, linked] = context(message)
      const sender = senderOf(message)
      const dispatch = linked ?? (sender.startsWith('dispatch:') ? sender.slice('dispatch:'.length) : senders.get(sender))
      if (typeof dispatch === 'string' && workers.has(dispatch) && !reports.has(dispatch)) reports.set(dispatch, message)
    }
    if (reports.size === workers.size || inbox.data.messages.length < limit) break
  }
  return { reports }
}

// 옛 Run 을 소비하지 않고 코디네이터 메일함만 읽는다. 이미 끝난 추적 대상도 마지막 보고를 보여 준다.
export function oldWorkerReports(repo: string): { lines: string[]; errors: string[] } {
  const pending = readPending(repo)
  const lines: string[] = []
  const errors: string[] = []
  if (!pending.from.length) return { lines, errors }
  const worktrees = new Set([...worktreePaths(repo).values()].map(path => resolve(path)))
  worktrees.delete(resolve(repo))
  for (const run of pending.from) {
    const workers = new Map((pending.workers?.[run] ?? []).map(worker => [worker.dispatch, worker.worktree]))
    const listed = workerRows(run)
    const senders = new Map<string, string | null>()
    if (!listed.ok) errors.push(`OLD-RUN-READ-FAIL ${run} workers ${oneLine(listed.error).slice(0, 160)}`)
    else for (const row of listed.rows) {
      const dispatch = row.dispatchId
      if (typeof dispatch !== 'string') continue
      for (const handle of rowHandles(row)) {
        if (typeof handle !== 'string') continue
        const previous = senders.get(handle)
        senders.set(handle, previous === undefined || previous === dispatch ? dispatch : null)
      }
      const worktree = rowWorktree(row)
      if (LIVE_DISPATCH.has(String(row.dispatchStatus)) && worktrees.has(worktree)) workers.set(dispatch, worktree)
    }
    if (!workers.size) continue
    const { reports, error } = lastReports(run, workers, senders)
    if (error) errors.push(`OLD-RUN-READ-FAIL ${run} inbox ${error}`)
    for (const [dispatch, worktree] of workers) {
      const report = reports.get(dispatch)
      const summary = report ? [
        report.type, report.created_at ?? report.createdAt, report.id, subjectOf(report), report.body,
      ].filter(part => typeof part === 'string' && part).join(' ') : '-'
      lines.push(`OLD-RUN-WORKER run=${run} dispatch=${dispatch} worktree=${JSON.stringify(worktree)} 마지막 보고=${oneLine(summary).slice(0, 320)}`)
    }
  }
  return { lines: lines.sort(), errors }
}

// 메인 Run 이 바뀌거나 목록·마지막 보고가 바뀌면 다시 알린다. 전송 성공 뒤에만 기록한다.
export function notifyOldWorkers(repo: string, run: string): string[] {
  const { lines, errors } = oldWorkerReports(repo)
  const file = join(pathOf('state', repo), 'takeover-notice.json')
  const text = lines.length ? [...lines, ...errors].join('\n') : ''
  const current = { run, hash: text ? createHash('sha256').update(text).digest('hex') : null }
  let previous: unknown
  try { previous = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 처음 확인한다 */ }
  const before = objectOr(previous)
  if (current.run === before.run && current.hash === before.hash) return errors
  if (text) {
    const sent = notifyRun(run, 'OLD-RUN-WORKER', `옛 Run 에 남은 worker\n${text}`, null, { repo, subject: 'OLD-RUN-WORKER 옛 Run 에 남은 worker' })
    if (!sent.ok) return [...errors, `NOTICE-FAIL OLD-RUN-WORKER ${oneLine(sent.error).slice(0, 160)}`]
  } else if (errors.length || !before.hash) return errors
  writeState(file, repo, current)
  return errors
}

// 넘겨받은 뒤의 출력과 알림. confirmed 가 있으면 명시적 넘겨받기다
export function announce(repo: string, run: string, from: string[], confirmed: string | null, previousMain: string | null): string[] {
  const lines = [`MAIN-TAKEN ${run} from=${from.join(',') || '-'}`]
  if (confirmed !== null && previousMain) {
    const text = `${repo} 의 메인 코디네이터를 Run ${run} 이 넘겨받았다. 이 Run 은 그 저장소 루프에서 빠졌다. 사용자 확인: ${confirmed}`
    const sent = notifyRun(previousMain, 'MAIN-TAKEN', text, null, { repo })
    if (!sent.ok) lines.push(`NOTICE-FAIL MAIN-TAKEN ${oneLine(sent.error).slice(0, 200)}`)
  }
  for (const request of openRequests(repo)) lines.push(`REQUEST-OPEN ${request.id} ${request.state} ${request.title}`)
  return lines
}
