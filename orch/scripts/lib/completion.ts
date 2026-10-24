// PR 작업의 완료 신호(worker_done)를 같은 Dispatch 의 앞선 준비 상태와 대조한다. wait-important 와 triage-messages 가 쓴다.
//
// 이 검사는 발신 프로세스를 인증하지 않는다. Orca 의 settlement 를 바꾸지 않고, 완료 조건의 근거가 없는 신호를
// 따로 분류해 코디네이터의 해제를 막는다.
//
// 준비 상태: 같은 task, dispatch, 발신자의 status 이고 제목이나 본문의 한 줄이 `준비됨 #<PR>, head <40자리 SHA>` 다.
// classify 는 메시지의 복사본에 completionVerification 을 붙인다.
//   ready           근거가 있다. pr, head, statusMessageId 를 함께 둔다
//   failure_report  worker_done --outcome failed 같은 실패 보고다. PR 준비를 요구하지 않는다
//   suspicious      근거가 없다. type 을 suspicious_worker_done 으로, 원래 type 을 originalType 으로 둔다

import { isDeepStrictEqual } from 'node:util'

type Json = Record<string, unknown>

// 줄 경계는 \n 만이다. 옛 명령(Python re.M)의 ^ 와 $ 는 \n 에서만 줄을 나눴다. JS 의 m 플래그는 \r 과 \u2028 에서도 나눠
// `준비됨 #1, head <SHA>\r\n` 처럼 옛 명령이 근거로 보지 않던 줄을 근거로 보게 된다
const READY = /(?<=^|\n)준비됨[ \t]+#([1-9][0-9]*),[ \t]*head[ \t]+([0-9a-f]{40})[ \t]*(?=\n|$)/i
// Python 의 datetime.fromisoformat 이 읽던 꼴이다. 날짜만, 공백 구분, 콜론 없는 시간대도 받는다
const ISO = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i

// ISO 시각을 epoch ms 로 읽는다. 시간대가 없으면 UTC 로 본다. orca 는 UTC 로 낸다.
// Date.parse 에 그대로 넘기지 않는 것은 시간대 없는 시각을 지역 시각으로 읽기 때문이다. 읽지 못하면 null.
// 정밀도는 ms 다. 옛 명령(datetime)은 µs 까지 보아, 1ms 안에서만 다른 두 시각을 옛 명령은 앞뒤로, 여기서는 같다고 본다.
// orca 의 시각은 JS 의 toISOString 이라 ms 까지만 있어 실제로는 갈리지 않는다. Date 가 ms 까지만 담아 맞추지 않았다.
export function isoTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const m = ISO.exec(value.trim())
  if (!m) return null
  const [, date, time, fraction, zone] = m
  const clock = time ? (time.length === 5 ? `${time}:00` : time) : '00:00:00'
  const millis = fraction ? fraction.slice(0, 4).padEnd(4, '0') : ''
  const offset = !zone || zone.toUpperCase() === 'Z' ? 'Z' : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`
  const ms = Date.parse(`${date}T${clock}${millis}${offset}`)
  return Number.isNaN(ms) ? null : ms
}

function obj(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null
}

// payload 는 객체이거나 JSON 문자열이다. 읽지 못하면 빈 객체.
export function payload(message: Json): Json {
  let value = message.payload || {}
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      value = {}
    }
  }
  return obj(value) ?? {}
}

// 메시지의 [task, dispatch]. 최상위의 snake_case, camelCase, payload 의 camelCase, snake_case 차례로 읽는다.
export function context(message: Json): [unknown, unknown] {
  const data = payload(message)
  const pick = (snake: string, camel: string) => message[snake] || message[camel] || data[camel] || data[snake] || null
  return [pick('task_id', 'taskId'), pick('dispatch_id', 'dispatchId')]
}

function sender(message: Json): unknown {
  return message.from_handle || message.fromHandle
}

// 시각이 둘 다 있으면 before 가 after 보다 앞서야 한다. 없으면 현재 묶음에서 먼저 온 상태만 인정한다.
// 이력(history)은 시각 없이는 인정하지 않는다.
function earlier(candidate: Json, item: Json, batch: Json[]): boolean {
  const before = candidate.created_at || candidate.createdAt
  const after = item.created_at || item.createdAt
  if (before && after) {
    const times = [isoTime(before), isoTime(after)]
    return times[0] !== null && times[1] !== null && times[0] < times[1]
  }
  // 옛 명령과 같이 값으로 비교한다. 같은 메시지가 이력과 묶음에 따로 담겨 와도 같은 것으로 본다
  return batch.some((message) => isDeepStrictEqual(message, candidate))
}

export function classify(messages: Json[], history: Json[] = []): Json[] {
  const output: Json[] = []
  const previous = [...history]
  for (const message of messages) {
    const item: Json = { ...message }
    // wait-important 출력에는 이미 이력과 대조한 결과가 있다. 파일 분류 때 잃지 않는다
    const verified = obj(item.completionVerification) ?? {}
    if (item.type === 'worker_done' && verified.status !== 'ready' && verified.status !== 'failure_report') {
      const outcome = item.outcome || payload(item).outcome
      if (outcome === 'failed') {
        item.completionVerification = { status: 'failure_report' }
      } else {
        const [task, dispatch] = context(item)
        let ready: Json | null = null
        for (const candidate of previous) {
          if (candidate.type !== 'status' || !task || !dispatch) continue
          const [candidateTask, candidateDispatch] = context(candidate)
          if (candidateTask !== task || candidateDispatch !== dispatch) continue
          const from = sender(item)
          if (!from || from !== sender(candidate)) continue
          if (!earlier(candidate, item, messages.slice(0, output.length))) continue
          const match = READY.exec(`${String(candidate.subject || '')}\n${String(candidate.body || '')}`)
          if (match) ready = { status: 'ready', pr: Number(match[1]), head: match[2].toLowerCase(), statusMessageId: candidate.id ?? null }
        }
        item.completionVerification = ready ?? { status: 'suspicious', reason: '같은 Task·Dispatch의 앞선 PR 준비 상태가 없다' }
        if (!ready) {
          item.originalType = 'worker_done'
          item.type = 'suspicious_worker_done'
        }
      }
    }
    output.push(item)
    previous.push(message)
  }
  return output
}
