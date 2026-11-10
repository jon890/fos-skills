// 승인 신호는 inbox --terminal run:<Run> --limit 200 으로 읽는다(2026-11-10: 0.56초, check 100건은 0.58초).
// --from 이 없으면 프로세스의 터미널이 from_handle 이다. 변수 제거로 바뀌지 않으며 Orca 밖 셸도 목록에 없는 handle 로 왔다.
// Orca 메시지의 필드 이름은 명령마다 다르다(2026-11-10 실측, Orca 1.4.255).
//   `orca orchestration check --json`, `inbox --full --json`  from_handle, to_handle, thread_id, run_id, sequence
//   `orca orchestration inbox --json`(줄인 보기)               from, to (thread_id, run_id, sequence, created_at 없음)
// 메시지를 읽는 곳은 이 함수로 읽는다. 한 이름만 읽으면 다른 명령의 결과에서 값이 빈 채로 판정이 엇나간다.

type Json = Record<string, unknown>

function first(...values: unknown[]): string {
  for (const value of values) if (typeof value === 'string' && value) return value
  return ''
}

export function senderOf(message: Json): string {
  return first(message.from_handle, message.fromHandle, message.from)
}

export function recipientOf(message: Json): string {
  return first(message.to_handle, message.toHandle, message.to)
}

export function threadOf(message: Json): string {
  return first(message.thread_id, message.threadId)
}

export function subjectOf(message: Json): string { return first(message.subject, message.title) }
export function payloadOf(message: Json): Json {
  let value = message.payload
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return {} }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {}
}
