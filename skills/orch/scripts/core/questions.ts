import { context, isoTime } from './completion.ts'
import { recipientOf, senderOf, threadOf } from './message-fields.ts'
import { isQuietStop } from './stop-reports.ts'

export const KINDS = new Set(['question', 'escalation'])

export type Message = Record<string, unknown>

// Orca 의 턴 종료 알림(finished)은 앞선 보고와 관계없이 질문에서 뺀다.
export function isQuestionCandidate(message: Message): boolean {
  return KINDS.has(String(message.type)) && !isQuietStop(message)
}

// worker 쪽으로 간 답이 질문을 푼다. Run 으로 간 worker 의 후속 메시지는 풀지 않는다.
export function unanswered(rows: Message[], run: string): Message[] {
  const scoped = rows.filter((m) => m.run_id === run)
  const answered = new Set(
    scoped.filter((r) => threadOf(r) && r.id !== threadOf(r) && recipientOf(r) && recipientOf(r) !== `run:${run}`).map((r) => threadOf(r)),
  )
  const asked = [...new Map(scoped.filter((m) => isQuestionCandidate(m) && recipientOf(m) === `run:${run}` && m.id)
    .map((m) => [m.id, m])).values()]
  const key = (m: Message) => dispatchOf(m) || senderOf(m) || m.id
  const later = (a: Message, b: Message) => String(a.created_at || '') === String(b.created_at || '')
    ? asked.indexOf(a) > asked.indexOf(b) : String(a.created_at || '') > String(b.created_at || '')
  const latestAnswered = new Map<unknown, Message>()
  for (const message of asked.filter((m) => answered.has(String(m.id)))) {
    const previous = latestAnswered.get(key(message))
    if (!previous || later(message, previous)) latestAnswered.set(key(message), message)
  }
  // ask 는 한 번에 한 질문의 답을 기다린다. 뒤 질문에 답하면 같은 dispatch 의 앞선 재전송 질문도 푼다.
  return asked.filter((m) => !answered.has(String(m.id)) && (!latestAnswered.has(key(m)) || later(m, latestAnswered.get(key(m))!)))
}

// 질문이 만들어진 뒤 지난 초. now 는 epoch 초다. 시각을 읽지 못하면 0.
export function ageSeconds(message: Message, now: number): number {
  const created = isoTime(message.created_at)
  return created === null ? 0 : now - created / 1000
}

// 시간 제한이 있는 질문의 만료 줄 머리. worker-ask --expires-at 이 질문 본문 끝에 `만료: <UTC ISO 시각>` 을 붙인다
export const EXPIRY_PREFIX = '만료:'
export const EXPIRED_MARK = '[만료됨]'

// 시간대를 붙인 ISO 8601 시각의 epoch 밀리초. 시간대가 없으면 머신마다 뜻이 달라 읽지 않는다
export function expiryTime(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return null
  const at = Date.parse(trimmed)
  return Number.isFinite(at) ? at : null
}

// 질문 본문의 마지막 `만료:` 줄이 가리키는 epoch 밀리초. 줄이 없거나 읽지 못하면 null 이다
export function expiresAt(message: Message): number | null {
  const line = String(message.body || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(EXPIRY_PREFIX)).pop()
  return line === undefined ? null : expiryTime(line.slice(EXPIRY_PREFIX.length))
}

// now 는 epoch 초다. 만료 줄의 시각이 지났으면 true 다
export function isExpired(message: Message, now: number): boolean {
  const at = expiresAt(message)
  return at !== null && at <= now * 1000
}

export type Notice = { line: string; message: Message; reminder: boolean }
export function brief(body: unknown): string {
  const flat = String(body || '').split(/\s+/).filter(Boolean).join(' ')
  return Array.from(flat).slice(0, 160).join('')
}

// 알림 본문에 붙이는 질문 위치다. 많은 질문은 앞 일부만 내고 전체 수는 원래 문장에 둔다.
export function questionLocations(questions: { id?: unknown; dispatch?: unknown; from_handle?: unknown; payload?: unknown }[]): string {
  const limit = 5
  const refs = questions.slice(0, limit).map((q) => {
    const dispatch = q.dispatch || dispatchOf(q)
    const from = dispatch ? `dispatch:${dispatch}` : String(senderOf(q as Message) || '-')
    return `${String(q.id || '-').replace(/\s+/g, '_')}@${from.replace(/\s+/g, '_')}`
  })
  const extra = questions.length > limit ? ` (외 ${questions.length - limit}개)` : ''
  return `questions=${refs.join(',') || '-'}${extra}`
}

export function dispatchOf(message: Message): string | null {
  const dispatch = context(message)[1]
  if (dispatch) return String(dispatch)
  const from = senderOf(message)
  return from.startsWith('dispatch:') ? from.slice('dispatch:'.length) : null
}
