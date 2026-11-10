// Orca 가 worker 대신 보내는 멈춤 보고(stop report)를 가린다. 사용처: wait-important.ts, triage-messages.ts, lib/questions.ts.
//
// worker 가 worker_done 없이 턴을 끝내면 Orca 가 그 worker 이름으로 escalation 을 Run 에 보낸다(Orca 1.4.246 실측).
//     id         msg_stop_<해시>
//     subject    stopReason 마다 하나. finished 「Worker stopped without reporting」, errored 「Worker stopped on an error without reporting」,
//                needs-input 「Worker is waiting on a prompt」, exited 「Worker exited without reporting」
//     payload    { taskId, dispatchId, handle, stopReason }. 전체 기록(--full)에서는 JSON 문자열, 줄인 보기에서는 객체다
// Orca 는 worker 가 메일이나 질문의 답을 기다릴 때 finished 를 보내지 않는다. 그래도 백그라운드 검사를 기다리며 턴을 끝내는 worker 는
// 턴마다 finished 를 보내, 하루 메시지 100개 가운데 32개가 이것이었다(2026-11-02 ai-analysis 코디네이터).
//
// 판정:
//     quiet  stopReason 이 finished 인 멈춤 보고. 대기와 요약 도구가 기본으로 깨어남과 질문에서 뺀다. worker 가 정말 멈췄는지는 이것만으로
//            알 수 없고, 상주 루프의 멈춤 확인(화면)과 질문 재알림이 맡는다
//     stopped  그 밖의 멈춤 보고(errored, needs-input, exited). 실제로 멈춘 worker 라 그대로 escalation 으로 둔다

export type Message = Record<string, unknown>

const PREFIX = 'msg_stop_'
const SUBJECTS: Record<string, string> = {
  'Worker stopped without reporting': 'finished',
  'Worker stopped on an error without reporting': 'errored',
  'Worker is waiting on a prompt': 'needs-input',
  'Worker exited without reporting': 'exited',
}

function payloadOf(m: Message): Record<string, unknown> {
  let value = m.payload
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

// 멈춤 보고면 stopReason, 아니면 null 이다. payload 에 stopReason 이 없으면 제목으로 정한다
export function stopReason(m: Message): string | null {
  if (m.type !== 'escalation') return null
  const reason = payloadOf(m).stopReason
  if (typeof reason === 'string' && reason) return reason
  const bySubject = SUBJECTS[String(m.subject ?? '')]
  if (bySubject) return bySubject
  return String(m.id ?? '').startsWith(PREFIX) ? 'unknown' : null
}

export function isQuietStop(m: Message): boolean {
  return stopReason(m) === 'finished'
}

// 멈춤 보고의 dispatch. payload 의 dispatchId 다. 없으면 빈 문자열
export function stopDispatch(m: Message): string {
  const dispatch = payloadOf(m).dispatchId
  return typeof dispatch === 'string' ? dispatch : ''
}
