// 코디네이터가 아직 답하지 않은 질문을 Orca 에서 읽고, 알릴 줄과 알린 기록을 정한다. delivery 를 소비하지 않는다.
// 사용처: watch-questions.ts(Monitor 의 이벤트 소스), orch-loop.ts(상주 루프의 틱), orch-doctor.ts(snapshot, ageSeconds).
//
// 이 Run 의 질문(question, escalation)을 읽고, 그다음 질문을 보낸 쪽마다 받은 답을 읽는다. 전역 inbox 는 읽지 않는다.
// 전역 기록은 수십 MB 까지 커져 조회가 느려지고 출력 한도에 닿는다.
//
// 조회 범위: Orca 는 check 의 기록과 --peek 을 100건까지 낸다. 그 한도에 닿으면 stderr 에 조회 범위를 알린다.
// 그 Run 에서는 조회마다 나오는 안내라 stdout 으로 내지 않는다(watch-questions 가 Monitor 를 깨우지 않게).
// 답 판정: 코디네이터가 질문의 스레드에 답하면 답한 것이다. 질문을 ack 했는지는 보지 않는다. worker 의 후속 메시지는 답이 아니다.
// 답은 보낸 쪽의 inbox 에서 200건까지 읽는다. 그 한도에 닿아 답했는지 증명하지 못하면 짐작하지 않고 오류를 던진다.
//
// 알린 기록(poll 의 state, 보통 <orch 작업 폴더>/state/questions-seen.json): {<Run id>: {<질문 id>: <알린 epoch 초>}}.
// 파일의 바이트 꼴은 옛 명령의 json.dumps(ensure_ascii=False) 와 같다(lib/py.ts 의 pyJson).
// 조회가 실패하면 그 파일을 지우거나 바꾸지 않는다. 최상위나 Run 의 값이 객체가 아니거나 알린 시각이 수가 아니면 형식 오류다.
//
// 오류는 모두 Error 로 던진다. 부르는 쪽이 조회 실패로 다룬다.

import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { context, isoTime, readyOf } from './completion.ts'
import { envMs } from './env.ts'
import { fire } from './events.ts'
import { ghJson } from './gh.ts'
import { defaultBase, mainCheckout } from './git.ts'
import { orcaJson } from './orca.ts'
import { makeParent } from './paths.ts'
import { pyJson, pyStr as text } from './py.ts'
import { workerRows } from './workers.ts'

export const HISTORY_LIMIT = 100
export const REPLY_LIMIT = 200
const KINDS = new Set(['question', 'escalation'])

export type Message = Record<string, unknown>

function orca(args: string[]): Record<string, unknown> {
  const got = orcaJson<unknown>(['orchestration', ...args], { timeoutMs: envMs('ORCH_QUESTIONS_TIMEOUT_SEC', 30) })
  if (!got.ok) throw new Error(got.error)
  if (typeof got.data !== 'object' || got.data === null || Array.isArray(got.data)) throw new Error('Orca result 가 객체가 아니다')
  return got.data as Record<string, unknown>
}

function messages(data: Record<string, unknown>): Message[] {
  const rows = data.messages
  if (!Array.isArray(rows) || !rows.every((m) => typeof m === 'object' && m !== null && !Array.isArray(m))) {
    throw new Error('질문 기록을 읽지 못했다')
  }
  return rows as Message[]
}

// 질문을 받은 쪽(Run)의 답만 질문을 푼다. worker 의 후속 메시지는 풀지 않는다.
export function unanswered(rows: Message[], run: string): Message[] {
  const scoped = rows.filter((m) => m.run_id === run)
  const answered = new Set(
    scoped.filter((r) => r.thread_id && r.id !== r.thread_id && r.from_handle === `run:${run}`).map((r) => r.thread_id),
  )
  return scoped.filter((m) => KINDS.has(String(m.type)) && m.to_handle === `run:${run}` && m.id && !answered.has(m.id))
}

// run 이 없으면 run-current 의 Run 이다. { run, pending } 을 낸다.
export function snapshot(run?: string | null): { run: string; pending: Message[] } {
  if (!run) {
    const current = (orca(['run-current']).run ?? {}) as Record<string, unknown>
    run = typeof current.id === 'string' ? current.id : ''
  }
  if (!run) throw new Error('현재 Run 이 없다. --run 으로 지정한다')
  const history = messages(orca(['check', '--run', run, '--all', '--types', 'question,escalation']))
  const unread = messages(orca(['check', '--run', run, '--peek', '--types', 'question,escalation']))
  if (history.length >= HISTORY_LIMIT || unread.length >= HISTORY_LIMIT) {
    process.stderr.write('질문 조회 범위: 최근 질문 100건과 읽지 않은 질문 최대 100건; 더 오래된 미답변은 빠질 수 있다\n')
  }
  // 같은 id 는 뒤의 것(읽지 않은 질문)으로 덮되 처음 나온 자리를 지킨다
  const candidates = new Map<unknown, Message>()
  for (const m of [...history, ...unread]) {
    if (m.id && m.run_id === run && KINDS.has(String(m.type)) && m.to_handle === `run:${run}`) candidates.set(m.id, m)
  }
  const replies: Message[] = []
  const senders = [...new Set([...candidates.values()].map((m) => m.from_handle))]
  for (const sender of senders) {
    if (!sender) throw new Error('질문 발신자가 없다')
    const rows = messages(orca(['inbox', '--terminal', String(sender), '--limit', String(REPLY_LIMIT)]))
    const answers = rows.filter((m) => m.from_handle === `run:${run}`)
    const pending = unanswered([...candidates.values(), ...answers], run)
    if (rows.length >= REPLY_LIMIT && pending.some((m) => m.from_handle === sender)) {
      throw new Error('답변 기록 한도에 닿아 질문의 답변 여부를 확인할 수 없다')
    }
    replies.push(...answers)
  }
  return { run, pending: unanswered([...candidates.values(), ...replies], run) }
}

// 질문이 만들어진 뒤 지난 초. now 는 epoch 초다. 시각을 읽지 못하면 0.
export function ageSeconds(message: Message, now: number): number {
  const created = isoTime(message.created_at)
  return created === null ? 0 : now - created / 1000
}

type Seen = Record<string, Record<string, number>>
export type Notice = { line: string; message: Message; reminder: boolean }

function exists(file: string): boolean {
  try {
    statSync(file)
    return true
  } catch {
    return false
  }
}

// Python 의 str.split() 처럼 공백 덩어리로 나눠 한 칸으로 잇고 앞 160자(코드 포인트)만 남긴다
function brief(body: unknown): string {
  const flat = String(body || '').split(/\s+/).filter(Boolean).join(' ')
  return Array.from(flat).slice(0, 160).join('')
}

// now 는 epoch 초다. 알릴 줄을 정하고 알린 시각을 state 에 적는다.
// 처음 보는 미답변 질문은 QUESTION, 알린 뒤 remindAfter 초가 지나도 답이 없는 질문은 REMINDER 줄이다.
// pending 은 알릴지와 무관한 미답변 질문 전부다. 상주 루프가 질문을 기다리는 worker 를 멈춘 것으로 보지 않는 데 쓴다.
export function poll(run: string | null, state: string, now: number, remindAfter: number, repo: string): { run: string; notices: Notice[]; pending: Message[] } {
  const found = snapshot(run)
  const seen = (exists(state) ? JSON.parse(readFileSync(state, 'utf8')) : {}) as Seen
  const isMap = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value)
  const malformed = () => new Error(`알림 기록 형식이 잘못됐다: ${state}`)
  if (!isMap(seen) || (Object.hasOwn(seen, found.run) && !isMap(seen[found.run]))) throw malformed()
  const notified = (seen[found.run] ??= {})
  const key = (m: Message): [string, string] => [String(m.created_at ?? ''), String(m.id)]
  const ordered = [...found.pending].sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0
  })
  const notices: Notice[] = []
  for (const message of ordered) {
    const id = String(message.id)
    const previous: unknown = notified[id]
    // 옛 명령은 수가 아닌 값에서 뺄셈이 TypeError 로 실패해 조회 실패로 끝났다. 문자열 "1000" 을 수로 읽어 넘기지 않는다
    if (previous !== undefined && previous !== null && (typeof previous !== 'number' || !Number.isFinite(previous))) throw malformed()
    if (typeof previous === 'number' && now - previous < remindAfter) continue
    const reminder = previous !== undefined && previous !== null
    notices.push({
      line: `${reminder ? 'REMINDER' : 'QUESTION'} ${id} ${text(message.type)} from=${text(message.from_handle)}: ${brief(message.body)}`,
      message,
      reminder,
    })
    notified[id] = now
  }
  makeParent(state, repo)
  // 쓰는 도중에 끊겨도 앞 기록이 깨지지 않게 옆 파일에 쓰고 바꾼다
  const temporary = state.replace(/\.json$/, '') + '.tmp'
  writeFileSync(temporary, `${pyJson(seen)}\n`)
  renameSync(temporary, state)
  return { run: found.run, notices, pending: found.pending }
}

// 알릴 줄 하나에 worker-question 이벤트를 낸다(lib/events.ts 머리 주석의 「이벤트별 필드」).
// worker.task, worker.dispatch 는 질문 메시지에서, worker.terminal 은 보낸 쪽이다.
// command 는 stderr 줄의 접두로 쓰는 부른 명령 이름이다(watch-questions, orch-loop).
export async function notifyQuestion(notice: Notice, repo: string, run: string | null, command: string): Promise<void> {
  const { message } = notice
  const [task, dispatch] = context(message)
  const root = mainCheckout(repo)
  try {
    await fire(
      'worker-question',
      {
        worker: { task, dispatch, terminal: message.from_handle ?? null, worktree: null, spec: null },
        message: { id: message.id ?? null, type: message.type ?? null, subject: message.subject ?? null, body: message.body ?? null },
        reminder: notice.reminder,
        age_sec: Math.trunc(ageSeconds(message, Date.now() / 1000)),
      },
      { repo: root, base: defaultBase(root) ?? '', run },
    )
  } catch (e) {
    // 질문 줄은 이미 냈다. 이벤트 실행기의 오류(설정 파일 오류 포함)로 감시를 멈추면 다음 질문을 알리지 못한다
    process.stderr.write(`${command}: worker-question 을 내지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
  }
}

// 닫힌 질문 ------------------------------------------------------------------
// 끝난 dispatch 가 남긴 질문은 답할 곳이 없다. Orca 는 닫힌 dispatch 에 보낸 답을 전하지 않는다.
// 그 dispatch 가 끝났고(SETTLED) 그 dispatch 가 알린 PR(status 의 `준비됨 #<PR>, head <SHA>`)이 모두 머지되거나 닫혔으면 닫힌 질문이다.
// PR 은 부른 쪽 저장소에서 `gh pr view` 로 읽고, 준비 상태의 head 가 그 PR 의 커밋에 있을 때만 그 PR 로 본다.
// 다른 저장소에서 번호만 같은 PR 을 닫힌 것으로 읽지 않으려는 것이다.
// 하나라도 읽지 못하거나 준비 상태가 없으면 닫히지 않은 것으로 본다(재알림을 계속한다).
// 준비 상태는 그 Run 의 status 를 100건까지 읽는다. 그보다 오래된 준비 상태는 찾지 못해 재알림이 남는다.
//
// 닫힌 기록(보통 <orch 작업 폴더>/state/questions-closed.json): {<Run id>: {<질문 id>: <판정 근거>}}.
// 한 번 닫힌 질문은 다시 판정하지 않는다. 미답변 목록에서 빠진 질문의 기록은 지운다.

export const SETTLED = new Set(['completed', 'failed', 'abandoned', 'canceled'])
const CLOSED_PR = new Set(['MERGED', 'CLOSED'])

// 틱 안에서 Run 마다 한 번만 읽는 worker 행과 status 메시지
export type ClosedLookup = { rows?: ReturnType<typeof workerRows>; reports?: Message[] | null }

function dispatchOf(message: Message): string | null {
  const dispatch = context(message)[1]
  if (dispatch) return String(dispatch)
  const from = String(message.from_handle ?? '')
  return from.startsWith('dispatch:') ? from.slice('dispatch:'.length) : null
}

// 닫힌 질문이면 판정 근거, 아니면 null 이다
export function closedReason(message: Message, run: string, repo: string, lookup: ClosedLookup): string | null {
  const dispatch = dispatchOf(message)
  if (!dispatch) return null
  lookup.rows ??= workerRows(run)
  if (!lookup.rows.ok) return null
  const row = lookup.rows.rows.find((r) => r.dispatchId === dispatch)
  const status = String(row?.dispatchStatus ?? '')
  if (!SETTLED.has(status)) return null
  if (lookup.reports === undefined) {
    try {
      lookup.reports = messages(orca(['check', '--run', run, '--all', '--types', 'status']))
    } catch {
      lookup.reports = null
    }
  }
  if (!lookup.reports) return null
  const heads = new Map<number, string>()
  for (const report of lookup.reports) {
    const ready = report.type === 'status' && context(report)[1] === dispatch ? readyOf(report) : null
    if (ready) heads.set(ready.pr, ready.head)
  }
  if (heads.size === 0) return null
  const states: string[] = []
  for (const [pr, head] of heads) {
    const got = ghJson<{ state?: unknown; headRefOid?: unknown; commits?: { oid?: unknown }[] }>(
      ['pr', 'view', String(pr), '--json', 'state,headRefOid,commits'],
      { cwd: repo },
    )
    if (!got.ok) return null
    const state = String(got.data.state ?? '')
    const ours = String(got.data.headRefOid ?? '').toLowerCase() === head || (got.data.commits ?? []).some((c) => String(c.oid ?? '').toLowerCase() === head)
    if (!CLOSED_PR.has(state) || !ours) return null
    states.push(`#${pr} ${state}`)
  }
  return `dispatch ${dispatch} ${status}, PR ${states.join(', ')}`
}

type Closed = Record<string, Record<string, string>>

// 닫힌 기록을 읽는다. 없거나 형식이 다르면 빈 기록이다. 잘못 지워져도 다시 판정할 뿐이다
export function readClosed(file: string): Closed {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {}
    const closed: Closed = {}
    for (const [run, entries] of Object.entries(data)) {
      if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) continue
      closed[run] = Object.fromEntries(Object.entries(entries).filter(([, reason]) => typeof reason === 'string')) as Record<string, string>
    }
    return closed
  } catch {
    return {}
  }
}

export function writeClosed(file: string, closed: Closed, repo: string): void {
  makeParent(file, repo)
  const temporary = file.replace(/\.json$/, '') + '.tmp'
  writeFileSync(temporary, `${JSON.stringify(closed)}\n`)
  renameSync(temporary, file)
}
