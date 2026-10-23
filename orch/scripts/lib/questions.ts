// 코디네이터가 아직 답하지 않은 질문을 Orca 에서 읽는다. delivery 를 소비하지 않는다. watch-questions 가 쓴다.
//
// 이 Run 의 질문(question, escalation)을 읽고, 그다음 질문을 보낸 쪽마다 받은 답을 읽는다. 전역 inbox 는 읽지 않는다.
// 전역 기록은 수십 MB 까지 커져 조회가 느려지고 출력 한도에 닿는다.
//
// 조회 범위: Orca 는 check 의 기록과 --peek 을 100건까지 낸다. 그 한도에 닿으면 stderr 에 조회 범위를 알린다.
// 그 Run 에서는 조회마다 나오는 안내라 stdout 으로 내지 않는다(watch-questions 가 Monitor 를 깨우지 않게).
// 답 판정: 코디네이터가 질문의 스레드에 답하면 답한 것이다. 질문을 ack 했는지는 보지 않는다. worker 의 후속 메시지는 답이 아니다.
// 답은 보낸 쪽의 inbox 에서 200건까지 읽는다. 그 한도에 닿아 답했는지 증명하지 못하면 짐작하지 않고 오류를 던진다.
//
// 오류는 모두 Error 로 던진다. 부르는 쪽이 조회 실패로 다룬다.

import { isoTime } from './completion.ts'
import { orcaJson } from './orca.ts'

export const HISTORY_LIMIT = 100
export const REPLY_LIMIT = 200
const TIMEOUT_MS = 30_000
const KINDS = new Set(['question', 'escalation'])

export type Message = Record<string, unknown>

function orca(args: string[]): Record<string, unknown> {
  const got = orcaJson<unknown>(['orchestration', ...args], { timeoutMs: TIMEOUT_MS })
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
