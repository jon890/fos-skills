// PR 작업의 완료 신호(worker_done)를 같은 Task 의 앞선 준비 상태와 대조한다. wait-important 와 triage-messages 가 쓴다.
//
// 이 검사는 발신 프로세스를 인증하지 않는다. Orca 의 settlement 를 바꾸지 않고, 완료 조건의 근거가 없는 신호를
// 따로 분류해 코디네이터의 해제를 막는다.
//
// 준비 상태: 같은 task 의 status(같은 dispatch 면 발신자도 일치) 이고 제목이나 본문의 한 줄이 `준비됨 #<PR>, head <40자리 SHA>` 로 시작한다.
//   SHA 바로 뒤는 줄 끝이거나 공백, 탭, `.`, `,`, `;`, `:`, `(` 다. worker 가 같은 줄에 붙인 설명(`head <SHA> (리뷰 P3 1건)`)도 인정한다.
//   SHA 가 40자리보다 길거나 짧으면 근거가 아니다.
// 같은 dispatch 의 준비 상태를 우선하고 그 안에서 가장 늦은 시각을 고른다. 없으면 같은 Task 의 다른 dispatch 에도 같은 기준을 쓴다.
// 리뷰 dispatch(지시서에 `리뷰 PR:` 줄이 있다. 부르는 쪽이 options.isReview 로 알린다)는 PR 을 열지 않아 준비 상태가 없다.
// PR 없는 dispatch 도 지시서가 확인되면 options.isNoPr 로 알린다. 첫 줄 `완료:`만 완료 근거로 인정한다.
//   그 dispatch 는 준비 상태가 없으면 같은 dispatch, 같은 발신자가 앞서 보낸 결과 status 를 근거로 센다.
//   띄우기 기록이 없거나 지시서를 못 읽어 isReview 가 모르는 dispatch 도, 같은 발신자의 첫 status 가 `판정:` 줄이면 리뷰로 본다(옛 wait 와 같다)
//   결과 status 는 제목이나 본문의 한 줄이 `판정:`, `완료:`, `미완료:` 로 시작하는 것이다(목록 기호와 굵은 글씨는 받는다).
//   `완료:`, `미완료:` 는 verify 보고의 첫 줄이다. 다른 dispatch 의 결과는 세지 않는다. 리뷰를 다시 띄우면 새 결과를 보내야 한다
// classify 는 메시지의 복사본에 completionVerification 을 붙인다.
//   ready           근거가 있다. pr, head, statusMessageId 를 함께 둔다. 리뷰 dispatch 의 결과 근거면 kind: 'review' 와 statusMessageId 만 둔다
//   failure_report  worker_done --outcome failed 같은 실패 보고다. PR 준비를 요구하지 않는다
//   suspicious      근거가 없다. type 을 suspicious_worker_done 으로, 원래 type 을 originalType 으로 둔다

import { objectOr } from './json.ts'
import { jsonEqual } from './json.ts'
import { senderOf } from './message-fields.ts'

type Json = Record<string, unknown>

// 줄 경계는 \n 만이다. 옛 명령(Python re.M)의 ^ 와 $ 는 \n 에서만 줄을 나눴다. JS 의 m 플래그는 \r 과 \u2028 에서도 나눠
// `준비됨 #1, head <SHA>\r\n` 처럼 옛 명령이 근거로 보지 않던 줄을 근거로 보게 된다
const READY = /(?<=^|\n)준비됨[ \t]+#([1-9][0-9]*),[ \t]*head[ \t]+([0-9a-f]{40})(?=[ \t.,;:(]|\n|$)/i
// Python 의 datetime.fromisoformat 이 읽던 꼴이다. 날짜만, 공백 구분, 콜론 없는 시간대도 받는다
const ISO = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i

// 리뷰 결과 줄(머리 주석의 「리뷰 dispatch」). 줄 경계는 READY 와 같이 \n 만이다
const VERDICT = /(?<=^|\n)[ \t]*(?:[-*][ \t]+)?(?:\*\*)?(?:판정|완료|미완료)(?:\*\*)?[ \t]*[:：]/
// 리뷰 worker 의 첫 status. 띄우기 기록이 없어 isReview 가 모를 때의 근거라 `판정:` 만 받는다
const REVIEW_VERDICT = /(?<=^|\n)[ \t]*(?:[-*][ \t]+)?(?:\*\*)?판정(?:\*\*)?[ \t]*[:：]/

// 첫 status 가 `판정:` 줄이면 리뷰 worker 의 결과다(옛 wait-important 와 같은 기준이다)
function startsWithReviewVerdict(message: Json): boolean {
  return REVIEW_VERDICT.test(`${String(message.subject || '')}\n${String(message.body || '')}`)
}

export type ClassifyOptions = { isReview?: (dispatch: string) => boolean; isNoPr?: (dispatch: string) => boolean }

// 지시서의 완료 기준에 MERGED 가 없거나, 허락 줄에서 PR 을 열지 않는다고 정한 경우 PR 준비를 요구하지 않는다.
// 배경과 코드 예시의 문장은 판단 근거로 쓰지 않는다.
export function noPrInstruction(text: string): boolean {
  let inFence = false
  const visible = text.split('\n').filter(line => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return false }
    return !inFence && !/^\s*>/.test(line)
  })
  if (visible.some(line => /^\s*(?:[-*]\s+)?(?:\*\*)?허락\s*:\s*(?:\*\*)?.*\bPR\b.*(?:열지 않는다|열지 않음|만들지 않는다|생성하지 않는다)/i.test(line))) return true
  let completionLevel = 0
  let foundCompletion = false
  let merged = false
  for (const line of visible) {
    const heading = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      if (completionLevel && heading[1].length <= completionLevel) completionLevel = 0
      if (heading[2] === '완료 기준') {
        completionLevel = heading[1].length
        foundCompletion = true
      }
    }
    if (completionLevel && /\bMERGED\b/i.test(line)) merged = true
  }
  return foundCompletion && !merged
}

function startsWithCompletion(message: Json): boolean {
  return /^완료:/.test(`${String(message.subject || '')}\n${String(message.body || '')}`)
}

// 메시지의 제목과 본문에 리뷰 결과 줄이 있는지
export function hasVerdict(message: Json): boolean {
  return VERDICT.test(`${String(message.subject || '')}\n${String(message.body || '')}`)
}

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

// 메시지의 제목과 본문에서 준비 상태 줄을 읽는다. 없으면 null. head 는 소문자다
export function readyOf(message: Json): { pr: number; head: string } | null {
  const match = READY.exec(`${String(message.subject || '')}\n${String(message.body || '')}`)
  return match ? { pr: Number(match[1]), head: match[2].toLowerCase() } : null
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
  return objectOr(value, null) ?? {}
}

// 메시지의 [task, dispatch]. 최상위의 snake_case, camelCase, payload 의 camelCase, snake_case 차례로 읽는다.
export function context(message: Json): [unknown, unknown] {
  const data = payload(message)
  const pick = (snake: string, camel: string) => message[snake] || message[camel] || data[camel] || data[snake] || null
  return [pick('task_id', 'taskId'), pick('dispatch_id', 'dispatchId')]
}

function sender(message: Json): unknown {
  return senderOf(message)
}

// 시각이 둘 다 있으면 before 가 after 보다 앞서야 한다. 없으면 현재 묶음에서 먼저 온 상태만 인정한다.
// 이력(history)은 시각 없이는 인정하지 않는다.
function earlier(candidate: Json, item: Json, batch: Json[], equal: (a: unknown, b: unknown) => boolean): boolean {
  const before = candidate.created_at || candidate.createdAt
  const after = item.created_at || item.createdAt
  if (before && after) {
    const times = [isoTime(before), isoTime(after)]
    if (times[0] === null || times[1] === null) return false
    if (times[0] !== times[1]) return times[0] < times[1]
    // created_at 은 초 단위라 status 와 worker_done 을 같은 초에 보내면 같다. Orca 가 매기는 순번(sequence)으로 가린다.
    return typeof candidate.sequence === 'number' && typeof item.sequence === 'number' && candidate.sequence < item.sequence
  }
  // 옛 명령과 같이 값으로 비교한다. 같은 메시지가 이력과 묶음에 따로 담겨 와도 같은 것으로 본다
  return batch.some((message) => equal(message, candidate))
}

export function classify(messages: Json[], history: Json[] = [], options: ClassifyOptions = {}, equal = jsonEqual): Json[] {
  const output: Json[] = []
  const previous = [...history]
  for (const message of messages) {
    const item: Json = { ...message }
    // wait-important 출력에는 이미 이력과 대조한 결과가 있다. 파일 분류 때 잃지 않는다
    const verified = objectOr(item.completionVerification, null) ?? {}
    if (item.type === 'worker_done' && verified.status !== 'ready' && verified.status !== 'failure_report') {
      const outcome = item.outcome || payload(item).outcome
      if (outcome === 'failed') {
        item.completionVerification = { status: 'failure_report' }
      } else {
        const [task, dispatch] = context(item)
        let ready: Json | null = null
        let selected: Json | null = null
        if (task && dispatch && startsWithCompletion(item) && options.isNoPr?.(String(dispatch)) === true) {
          ready = { status: 'ready', kind: 'no-pr' }
        }
        for (const candidate of ready ? [] : previous) {
          if (candidate.type !== 'status' || !task || !dispatch) continue
          const [candidateTask, candidateDispatch] = context(candidate)
          if (candidateTask !== task || !candidateDispatch) continue
          const from = sender(item)
          if (!from || !sender(candidate) || (candidateDispatch === dispatch && from !== sender(candidate))) continue
          if (!earlier(candidate, item, messages.slice(0, output.length), equal)) continue
          const found = readyOf(candidate)
          if (!found) continue
          if (selected) {
            const same = candidateDispatch === dispatch
            const selectedSame = context(selected)[1] === dispatch
            if (!same && selectedSame) continue
            if (same === selectedSame) {
              const time = isoTime(candidate.created_at || candidate.createdAt)
              const previousTime = isoTime(selected.created_at || selected.createdAt)
              if (time !== null && previousTime !== null && time <= previousTime) continue
            }
          }
          selected = candidate
          ready = { status: 'ready', ...found, statusMessageId: candidate.id ?? null }
        }
        if (!ready && task && dispatch) {
          const from = sender(item)
          const isReview = options.isReview?.(String(dispatch)) === true
          const own = previous.filter((candidate) => candidate.type === 'status' && from && sender(candidate) === from
            && context(candidate)[0] === task && context(candidate)[1] === dispatch
            && earlier(candidate, item, messages.slice(0, output.length), equal))
          // 리뷰 지시서로 띄운 dispatch 는 결과 줄 전부를, 기록을 모르는 dispatch 는 첫 status 가 `판정:` 일 때만 리뷰로 본다
          const first = own.reduce<Json | null>((best, candidate) => {
            if (!best) return candidate
            const [time, bestTime] = [isoTime(candidate.created_at || candidate.createdAt), isoTime(best.created_at || best.createdAt)]
            return time !== null && bestTime !== null && time < bestTime ? candidate : best
          }, null)
          const results = isReview ? own.filter(hasVerdict) : first && startsWithReviewVerdict(first) ? own.filter(hasVerdict) : []
          const latest = results.reduce<Json | null>((best, candidate) => {
            if (!best) return candidate
            const [time, bestTime] = [isoTime(candidate.created_at || candidate.createdAt), isoTime(best.created_at || best.createdAt)]
            return time !== null && bestTime !== null && time > bestTime ? candidate : best
          }, null)
          if (latest) ready = { status: 'ready', kind: 'review', statusMessageId: latest.id ?? null }
        }
        item.completionVerification = ready ?? { status: 'suspicious', reason: '같은 Task의 앞선 PR 준비 상태가 없다' }
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
