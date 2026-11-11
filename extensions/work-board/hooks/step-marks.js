// 단계 번호 뒤의 자동 진행 표시를 읽고 바꾼다. 사건 꼬리표는 본문에 보존한다.
import { STEP } from './event-tags.js'

export function parseStepMark(text) {
  if (typeof text !== 'string') return null
  const step = STEP.exec(text)
  if (!step) return null
  const rest = text.slice(step[0].length).trimStart()
  const tag = /^\[(auto|ask|wait)(?::\s*([^\]\r\n]+))?\](?=\s|$)/.exec(rest)
  const condition = tag?.[2]?.trim() || null
  const valid = tag && (tag[2] === undefined || (tag[1] === 'wait' && condition))
  return { number: Number(step[2]), mark: valid ? tag[1] : null, condition: valid ? condition : null, body: valid ? rest.slice(tag[0].length).trimStart() : rest }
}

export function withStepMark(text, mark, condition = null) {
  const parsed = parseStepMark(text)
  if (!parsed || !['auto', 'ask', 'wait', null].includes(mark)) return null
  if (condition !== null && (mark !== 'wait' || typeof condition !== 'string' || !condition.trim() || /[\]\r\n]/.test(condition))) return null
  const tag = mark === null ? '' : `[${mark}${condition === null ? '' : `: ${condition.trim()}`}]`
  const result = STEP.exec(text)[0] + (tag ? tag + (parsed.body ? ' ' : '') : '') + parsed.body
  const again = parseStepMark(result)
  return again?.mark === mark && again.condition === (condition === null ? null : condition.trim()) && again.body === parsed.body ? result : null
}
