// CLI 와 창이 같은 단계 및 사건 꼬리표 규칙을 쓴다. 꼬리표는 번호 단계의 줄 끝에만 붙인다.
export const STEP = /^\s*(?:(✓|\[[xX ]\]|▶|◇)\s*)?(\d+)[.)]?\s/
const EVENT_TAG = /\s+\(#([1-9]\d*) (pr|merge|deploy|release)\)\s*$/

export function parseEventTag(text) {
  if (typeof text !== 'string' || !STEP.test(text)) return null
  const match = EVENT_TAG.exec(text)
  return match ? { pr: match[1], event: match[2] } : null
}

export function hideEventTag(text) {
  return parseEventTag(text) ? text.replace(EVENT_TAG, '') : text
}
