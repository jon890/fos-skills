// 메인 사이 요청의 기록, 번호, 보드 항목, 메시지 한 벌이다. 판정은 core/main-coordinator.ts 가, 계약은
// docs/features/orch-main-coordinator/design.md 의 「요청 기록」, 「보드 항목」, 「메시지」 가 소유한다(ADR-035).
//
// 위치: 받는 저장소의 <orch 루트>/state/requests/. seq.json 은 {"next": n} 이고 seq.json.lock 파일 잠금 안에서만 읽고 올린다.
//     R<n>.json 이 요청 하나다. 옆 파일에 쓰고 rename 한다. 요청 기록은 받는 저장소에만 있고 보낸 저장소는 보드 항목만 갖는다.
// 보드: 양쪽 항목 id 는 req-<받는 저장소 이름>-<n> 이다. 보드를 함께 쓰면 받는 쪽 하나만 쓴다. 옛 id 는 기록에서 읽는다.
//     하위 줄은 기록의 이력을 한 줄씩 다시 쓴다. 보드 파일이 없으면 건너뛴다. 보드 쓰기 실패는 던지지 않고 결과로 알린다.
// 메시지: lib/run-notice.ts 의 notifyRun 으로 `orca orchestration send --to run:<Run>` 을 보낸다. payload 의 source 는 orch-request 다.
//     답의 대상은 core 의 replyTarget 이다. 보낸 Run 이 살아 있는지는 lib/main-coordinator.ts 의 runAlive 로 본다.

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { withFileLock } from '../../../../modules/file-lock.ts'
import { lineBody, lineProblem, MAX_BODY } from '../../../../extensions/work-board/hooks/line-rules.js'
import { boardIds, isClosed, nextRequestState, replyKind, replyTarget, REQUEST_STATES } from '../core/main-coordinator.ts'
import type { RequestAction, RequestState } from '../core/main-coordinator.ts'
import { BOARD_BIN } from './board.ts'
import { boardSettings, DEFAULT_STEPS, milestoneLines, stagesText } from './milestones.ts'
import type { MilestoneStep } from './milestones.ts'
import { boardPath } from './board-file.ts'
import { realPath } from './fs.ts'
import { findMain, runAlive } from './main-coordinator.ts'
import { makeParent, pathOf } from './paths.ts'
import { NO_LIMIT_MS, run, scriptCommand } from './proc.ts'
import { notifyRun } from './run-notice.ts'

export type RequestHistory = { at: string; state: RequestState; reason: string | null; run: string | null }
export type RequestRecord = {
  id: string
  number: number
  repo: string
  title: string
  body: string
  state: RequestState
  reason: string | null
  from: { repo: string; run: string; terminal: string | null }
  to_run: string
  created_at: string
  updated_at: string
  ack_notice_at: string | null
  board: { to: string; from: string | null; pending?: Array<'to' | 'from'> }
  history: RequestHistory[]
  // 마무리의 자동 완료를 보내지 못했을 때 남긴다. 루프의 steps/requests.ts 가 다음 틱에 다시 보낸다
  pending_done?: { reason: string; at: string } | null
}

export const SOURCE = 'orch-request'

export function requestsDir(repo: string): string {
  return join(pathOf('state', repo), 'requests')
}

export function requestId(number: number): string {
  return `R${number}`
}

// `R12`, `r12`, `12` 를 번호로 읽는다. 읽지 못하면 null
export function parseRequestId(text: string): number | null {
  const found = /^[Rr]?(\d+)$/.exec(text.trim())
  return found ? Number(found[1]) : null
}

function recordFile(repo: string, number: number): string {
  return join(requestsDir(repo), `${requestId(number)}.json`)
}

function write(file: string, value: unknown, repo: string): void {
  if (!existsSync(file)) makeParent(file, repo)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 1)}\n`)
  renameSync(temporary, file)
}

// 다음 번호를 잡는다. 잠금 안에서 읽고 올린다. 번호는 다시 쓰지 않는다
export function allocateNumber(repo: string): number {
  const file = join(requestsDir(repo), 'seq.json')
  makeParent(file, repo)
  return withFileLock(file, () => {
    let next = 1
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { next?: unknown }
      if (typeof parsed.next === 'number' && Number.isInteger(parsed.next) && parsed.next > 0) next = parsed.next
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    write(file, { next: next + 1 }, repo)
    return next
  })
}

function valid(value: unknown): value is RequestRecord {
  const r = value as RequestRecord
  return !!r && typeof r.id === 'string' && typeof r.number === 'number' && typeof r.title === 'string' && REQUEST_STATES.includes(r.state)
    && !!r.from && typeof r.from.repo === 'string' && typeof r.from.run === 'string'
}

export function readRequest(repo: string, number: number): RequestRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(recordFile(repo, number), 'utf8')) as unknown
    return valid(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writeRequest(record: RequestRecord): void {
  write(recordFile(record.repo, record.number), record, record.repo)
}

export function forgetRequest(repo: string, number: number): void {
  try { unlinkSync(recordFile(repo, number)) } catch { /* 없으면 그만이다 */ }
}

// 번호 순
export function listRequests(repo: string): RequestRecord[] {
  let names: string[]
  try { names = readdirSync(requestsDir(repo)) } catch { return [] }
  return names.filter((name) => /^R\d+\.json$/.test(name))
    .map((name) => readRequest(repo, Number(name.slice(1, -5))))
    .filter((r): r is RequestRecord => r !== null)
    .sort((a, b) => a.number - b.number)
}

export function openRequests(repo: string): RequestRecord[] {
  return listRequests(repo).filter((r) => !isClosed(r.state))
}

export function repoName(repo: string): string {
  return basename(repo)
}

export function newRecord(input: { repo: string; number: number; title: string; body: string; from: RequestRecord['from']; toRun: string; now: string }): RequestRecord {
  const same = input.from.repo === input.repo || realPath(boardPath(input.from.repo)) === realPath(boardPath(input.repo))
  const board = boardIds(input.number, repoName(input.repo), same)
  return {
    id: requestId(input.number), number: input.number, repo: input.repo, title: input.title, body: input.body,
    state: 'sent', reason: null, from: input.from, to_run: input.toRun, created_at: input.now, updated_at: input.now, ack_notice_at: null,
    board: { ...board, pending: board.from ? ['to', 'from'] : ['to'] },
    history: [{ at: input.now, state: 'sent', reason: null, run: input.from.run }],
  }
}

const STATE_WORD: Record<RequestState, string> = { sent: '보냄', accepted: '받음', held: '보류', rejected: '거절', done: '완료', failed: '실패' }

export function stateWord(state: RequestState): string {
  return STATE_WORD[state]
}

// 보드 줄은 work-board 의 줄 규칙(lineProblem)을 지켜야 한다. 본문이 MAX_BODY(80자)를 넘으면 이유를 줄이고 `…` 를 붙인다.
// 그래도 다른 규칙(기다림 문장, 줄 안의 ✓ 등)에 걸리면 이유를 빼고 머리만 쓴다. 이유 전문은 기록과 답 메시지에 남는다
function historyLine(h: RequestHistory): string {
  const head = `${h.at.slice(0, 16).replace('T', ' ')} 요청 ${STATE_WORD[h.state]}`
  const reason = (h.reason ?? '').replace(/\s+/g, ' ').trim()
  if (!reason) return head
  const full = `${head}: ${reason}`
  const room = Math.max(0, MAX_BODY - [...head].length - ': …'.length)
  const line = [...lineBody(full)].length <= MAX_BODY ? full : `${head}: ${[...reason].slice(0, room).join('').trimEnd()}…`
  return lineProblem(line) ? head : line
}

export type BoardOutcome = { repo: string; item: string; result: 'written' | 'skipped' | 'failed'; error?: string }

function boardRun(file: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const bin = process.env.BOARD_BIN || BOARD_BIN
  return run(scriptCommand(bin, [...args, '--file', file]), { timeoutMs: NO_LIMIT_MS })
}

function failure(repo: string, item: string, done: { code: number; stdout: string; stderr: string }): BoardOutcome {
  return { repo, item, result: 'failed', error: (done.stderr || done.stdout).trim().split('\n').at(-1) ?? `종료 코드 ${done.code}` }
}

// 보드 항목 하나를 만들거나 고친다(머리 주석의 「보드」).
// 새 항목은 마일스톤 단계(lib/milestones.ts)를 갖고 wait 로 만든다. 받은 메인이 `보드 항목 id: <id>` 로 worker 를 붙이면
// lib/board.ts 의 기존 항목 분기가 doing 으로 바꾸고, finish-pr 이 마일스톤 항목으로 머지와 배포를 반영한다.
// 있는 항목은 이력 한 줄만 detail-add 로 더한다. 단계 줄을 지우지 않으려는 것이다. 끝 상태면 done 으로 바꾸되
// worker 가 붙은 받는 쪽 항목(workers 칸이 있다)은 상태를 마무리(finish-pr)에 맡긴다
function writeItem(repo: string, file: string, item: string, title: string, head: string, line: string, closed: boolean, created: boolean): BoardOutcome {
  if (!existsSync(file)) return { repo, item, result: 'skipped' }
  let workersOf: unknown = null
  // send 때 보드가 없어 건너뛴 항목은 지금 만든다
  if (!created) {
    const shown = boardRun(file, ['item', item])
    if (shown.code !== 0) created = true
    else {
      try { workersOf = (JSON.parse(shown.stdout) as { workers?: unknown }).workers } catch { /* 읽지 못하면 붙지 않은 것으로 본다 */ }
    }
  }
  if (created) {
    let steps: MilestoneStep[] = [...DEFAULT_STEPS]
    try { steps = boardSettings(repo).steps ?? steps } catch { /* 설정을 읽지 못하면 기본 단계 */ }
    const fresh = milestoneLines(steps)
    const stages = stagesText(fresh.stages)
    const done = boardRun(file, ['set', item, closed ? 'done' : 'wait', '--create-only', '--title', title, ...(stages ? ['--stages', stages] : []),
      ...fresh.details.flatMap((d) => ['--detail', d]), '--detail', head, '--detail', line])
    return done.code === 0 ? { repo, item, result: 'written' } : failure(repo, item, done)
  }
  const added = boardRun(file, ['detail-add', item, line])
  if (added.code !== 0) return failure(repo, item, added)
  if (closed) {
    const attached = Array.isArray(workersOf) && workersOf.length > 0
    if (!attached) {
      const done = boardRun(file, ['set', item, 'done', '--exact'])
      if (done.code !== 0) return failure(repo, item, done)
    }
  }
  return { repo, item, result: 'written' }
}

// 아직 만들지 못한 항목은 다음 답에서도 생성만 시도한다. 같은 id 의 다른 항목에 이력을 붙이지 않는다.
function syncBoards(record: RequestRecord): BoardOutcome[] {
  const closed = isClosed(record.state)
  const fromName = repoName(record.from.repo)
  const toName = repoName(record.repo)
  const line = historyLine(record.history.at(-1)!)
  const toFile = realPath(boardPath(record.repo))
  const fromFile = record.board.from ? realPath(boardPath(record.from.repo)) : null
  const pending = record.board.pending ?? []
  const to = writeItem(record.repo, toFile, record.board.to, `요청 ${record.id}: ${record.title}${record.repo !== record.from.repo ? ` (${fromName})` : ''}`,
    `보낸 곳: ${fromName} Run ${record.from.run}`, line, closed, pending.includes('to'))
  const from = record.board.from && fromFile && fromFile !== toFile
    ? writeItem(record.from.repo, fromFile, record.board.from, `${toName} 요청 ${record.id} 기다림: ${record.title}`, `받는 곳: ${record.repo}`, line, closed, pending.includes('from'))
    : null
  const left = pending.filter(side => (side === 'to' ? to : from)?.result !== 'written')
  if (left.length !== pending.length) writeRequest({ ...record, board: { ...record.board, pending: left } })
  return from ? [to, from] : [to]
}

// 답을 보낼 Run(스펙 REQ8). 보낸 Run 이 살아 있는지 읽지 못하면 살아 있는 것으로 본다. 메시지는 Run 메일함에 남는다
export function replyRunOf(record: RequestRecord): string {
  const alive = runAlive(record.from.run)
  if (alive !== false) return record.from.run
  const main = findMain(record.from.repo)
  return replyTarget(record.from.run, false, main.kind === 'main' ? main.run : null)
}

export function requestNotice(target: string, kind: string, record: RequestRecord, text: string): { ok: true } | { ok: false; error: string } {
  const sent = notifyRun(target, kind, text, null, {
    subject: `${kind} ${repoName(record.repo)} ${record.id} ${record.title}`.slice(0, 120),
    repo: record.repo,
    source: SOURCE,
    extra: { request: record.id, from_repo: record.from.repo },
  })
  return sent.ok ? { ok: true } : { ok: false, error: sent.error }
}

export type AnswerResult =
  | { ok: true; record: RequestRecord; target: string; boards: BoardOutcome[] }
  | { ok: false; code: 1 | 3; line: string }

// 받은 메인의 답(스펙 REQ6, REQ7). 메시지가 성공한 뒤에만 기록과 보드를 바꾼다(설계 「실패와 일관성」)
// 같은 요청에 두 답이 겹치지 않게 요청마다 잠근다(R<n>.json.lock). 보내기가 길 수 있어 기다림을 넉넉히 둔다
export function answerRequest(repo: string, number: number, action: RequestAction, reason: string | null, by: string | null, now: string): AnswerResult {
  makeParent(recordFile(repo, number), repo)
  return withFileLock(recordFile(repo, number), () => answerLocked(repo, number, action, reason, by, now), { waitMs: 60_000, staleMs: 180_000 })
}

function answerLocked(repo: string, number: number, action: RequestAction, reason: string | null, by: string | null, now: string): AnswerResult {
  const record = readRequest(repo, number)
  if (!record) return { ok: false, code: 3, line: `REQUEST-UNKNOWN ${requestId(number)} ${repo}` }
  const next = nextRequestState(record.state, action)
  if (next === null) return { ok: false, code: 3, line: isClosed(record.state) ? `REQUEST-CLOSED ${record.id} ${record.state}` : `REQUEST-REFUSED ${record.id} ${record.state} ${action}` }
  const target = replyRunOf(record)
  const kind = replyKind(next)
  const text = [
    `${repoName(record.repo)} 요청 ${record.id}(${record.title}) 이 ${stateWord(next)} 상태가 됐다.${reason ? ` 이유: ${reason}` : ''}`,
    `받은 저장소: ${record.repo}`,
  ].join('\n')
  const sent = requestNotice(target, kind, record, text)
  if (!sent.ok) return { ok: false, code: 1, line: `REQUEST-SEND-FAIL ${record.id} ${sent.error.replace(/\s+/g, ' ').slice(0, 200)}` }
  const updated: RequestRecord = { ...record, state: next, reason, updated_at: now, pending_done: null, history: [...record.history, { at: now, state: next, reason, run: by }] }
  writeRequest(updated)
  return { ok: true, record: updated, target, boards: syncBoards(updated) }
}

// 보드 항목 id 로 받은 요청을 찾는다. finish-pr 의 자동 완료가 쓴다
export function requestOfItem(repo: string, item: string): RequestRecord | null {
  return listRequests(repo).find((r) => r.board.to === item && !r.board.pending?.includes('to')) ?? null
}

export function boardLines(boards: BoardOutcome[]): string[] {
  return boards.filter((b) => b.result !== 'written').map((b) => b.result === 'skipped' ? `BOARD-SKIP ${b.repo} ${b.item}` : `BOARD-FAIL ${b.repo} ${b.item} ${b.error ?? ''}`.trim())
}

// 자동 완료를 보내지 못했을 때 기록에 남긴다(finish-pr). 기록이 없거나 끝났으면 아무것도 하지 않는다
export function markPendingDone(repo: string, number: number, reason: string, now: string): void {
  makeParent(recordFile(repo, number), repo)
  withFileLock(recordFile(repo, number), () => {
    const record = readRequest(repo, number)
    if (!record || isClosed(record.state)) return
    writeRequest({ ...record, pending_done: { reason, at: now } })
  }, { waitMs: 60_000, staleMs: 180_000 })
}

// 답 없음 알림을 보냈다고 남긴다. 그사이 답이 왔으면 그 기록을 덮지 않게 잠그고 다시 읽는다
export function markAckNoticed(repo: string, number: number, at: string): void {
  makeParent(recordFile(repo, number), repo)
  withFileLock(recordFile(repo, number), () => {
    const record = readRequest(repo, number)
    if (record) writeRequest({ ...record, ack_notice_at: at })
  }, { waitMs: 60_000, staleMs: 180_000 })
}

// 새 요청을 연다(orch request send). 기록을 쓰고 notify 로 메인에게 보낸 뒤 첫 보드 항목을 만든다. 모두 R<n>.json.lock 안에서 한다.
// 답 명령도 같은 잠금 안에서 최신 기록을 읽으므로, 메인의 답이 첫 보드 쓰기보다 먼저 쓰여 덮이는 일이 없다. 보내기가 실패하면 기록을 지운다
export function openRequest(record: RequestRecord, notify: () => { ok: true } | { ok: false; error: string }): { ok: true; boards: BoardOutcome[] } | { ok: false; error: string } {
  makeParent(recordFile(record.repo, record.number), record.repo)
  return withFileLock(recordFile(record.repo, record.number), () => {
    writeRequest(record)
    const sent = notify()
    if (!sent.ok) {
      forgetRequest(record.repo, record.number)
      return sent
    }
    return { ok: true as const, boards: syncBoards(record) }
  }, { waitMs: 60_000, staleMs: 180_000 })
}
