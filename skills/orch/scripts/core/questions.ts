import { context, isoTime } from './completion.ts'
export const KINDS = new Set(['question', 'escalation'])


export type Message = Record<string, unknown>


// worker 쪽으로 간 답이 질문을 푼다. Run 으로 간 worker 의 후속 메시지는 풀지 않는다.
export function unanswered(rows: Message[], run: string): Message[] {
  const scoped = rows.filter((m) => m.run_id === run)
  const answered = new Set(
    scoped.filter((r) => r.thread_id && r.id !== r.thread_id && r.to_handle && r.to_handle !== `run:${run}`).map((r) => r.thread_id),
  )
  const asked = [...new Map(scoped.filter((m) => KINDS.has(String(m.type)) && m.to_handle === `run:${run}` && m.id)
    .map((m) => [m.id, m])).values()]
  const key = (m: Message) => dispatchOf(m) || m.from_handle || m.id
  const later = (a: Message, b: Message) => String(a.created_at || '') === String(b.created_at || '')
    ? asked.indexOf(a) > asked.indexOf(b) : String(a.created_at || '') > String(b.created_at || '')
  const latestAnswered = new Map<unknown, Message>()
  for (const message of asked.filter((m) => answered.has(m.id))) {
    const previous = latestAnswered.get(key(message))
    if (!previous || later(message, previous)) latestAnswered.set(key(message), message)
  }
  // ask 는 한 번에 한 질문의 답을 기다린다. 뒤 질문에 답하면 같은 dispatch 의 앞선 재전송 질문도 푼다.
  return asked.filter((m) => !answered.has(m.id) && (!latestAnswered.has(key(m)) || later(m, latestAnswered.get(key(m))!)))
}


// 질문이 만들어진 뒤 지난 초. now 는 epoch 초다. 시각을 읽지 못하면 0.
export function ageSeconds(message: Message, now: number): number {
  const created = isoTime(message.created_at)
  return created === null ? 0 : now - created / 1000
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
    const from = dispatch ? `dispatch:${dispatch}` : String(q.from_handle || '-')
    return `${String(q.id || '-').replace(/\s+/g, '_')}@${from.replace(/\s+/g, '_')}`
  })
  const extra = questions.length > limit ? ` (외 ${questions.length - limit}개)` : ''
  return `questions=${refs.join(',') || '-'}${extra}`
}


export function dispatchOf(message: Message): string | null {
  const dispatch = context(message)[1]
  if (dispatch) return String(dispatch)
  const from = String(message.from_handle ?? '')
  return from.startsWith('dispatch:') ? from.slice('dispatch:'.length) : null
}
