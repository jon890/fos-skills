// 보드 줄 규칙. 단계 줄과 하위 줄을 쓰는 명령(step-add, step-edit, step-mark wait, detail-add, detail-edit)이 쓴다.
// 어기면 고칠 꼴을 문자열로 돌려주고, 지키면 null 이다. 규칙의 이유는 skills/orch/references/board.md 「줄 규칙」 이 갖는다.
import { parseStepMark } from './step-marks.js'

export const MAX_BODY = 80
export const MAX_WAIT = 40
// 스크립트가 쓰고 바꾸는 줄은 규칙 밖이다
const SCRIPT_LINE = /^\s*(?:(?:✓|\[[xX ]\]|▶|◇)\s*)?(?:남은 일|중간 과정):/
// 줄 끝의 참조는 글자 수에서 뺀다: 사건 꼬리표 (#N 사건), 근거 (스펙|계획|앞 사건: …), 공백 없는 낱말 하나(워크트리 이름).
// 그 밖의 괄호 글은 본문으로 센다. 괄호로 80자를 피하지 못하게 하려는 것이다
const REF = String.raw`\((?:#[1-9]\d* (?:pr|merge|deploy|release)|(?:스펙|계획|앞 사건)\s*:[^()]*|[^()\s]{1,60})\)`
const TRAILING_REFS = new RegExp(String.raw`(?:\s*${REF})+\s*$`)
const LOG_LINE = /^\s*(?:확인|지금)\s*[(（]|^\s*끝난 것\s*:/
const EVENT_OR_BASIS = /(?:\s*\((?:#[1-9]\d* (?:pr|merge|deploy|release)|(?:스펙|계획|앞 사건)\s*:[^()]*)\))+\s*$/
const WAIT_PROSE = /기다리는 중|기다림|대기 중/

// 번호·자동 진행 표시·줄 끝 괄호 묶음을 뺀 본문
function bodyOf(text) {
  const parsed = parseStepMark(text)
  return (parsed ? parsed.body : text.replace(/^\s*(?:✓|\[[xX ]\]|▶|◇)\s*/, '')).trim()
}
export function lineBody(text) {
  return bodyOf(text).replace(TRAILING_REFS, '').trim()
}

// 기다림 조건: 기다리는 사람이나 사건만. 이유와 뒤 계획은 다음 단계 줄로 쓴다
export function waitConditionProblem(condition) {
  if (typeof condition !== 'string') return null
  if ([...condition].length > MAX_WAIT || /[,;.…→()·]|\s후\s|\s뒤\s|\s그다음/.test(condition)) {
    return `기다림 조건에는 기다리는 사람이나 사건만 쓴다(${MAX_WAIT}자 안, 쉼표·마침표·화살표 없이): [wait: ${condition.trim()}]. 이유와 뒤 계획은 다음 단계 줄로 쓴다`
  }
  return null
}

export function lineProblem(text) {
  if (typeof text !== 'string' || SCRIPT_LINE.test(text)) return null
  const raw = text.replace(/^\s*(?:✓|\[[xX ]\]|▶|◇)\s*/, '')
  if (raw.includes('✓') || LOG_LINE.test(bodyOf(text).replace(EVENT_OR_BASIS, ''))) {
    return `한 일을 적는 줄(「확인(…)」, 「지금(…)」, 「끝난 것:」, 줄 안의 ✓)은 쓰지 않는다. 끝난 단계는 완료 표시만 하고, 근거와 결과는 업무 댓글이나 PR 에 둔다: ${text.trim()}`
  }
  const body = lineBody(text)
  const length = [...body].length
  if (length > MAX_BODY) {
    return `단계 줄 본문은 ${MAX_BODY}자 안이다(지금 ${length}자, 번호·자동 진행 표시·줄 끝 괄호 제외). 근거·결과·수치는 업무 댓글이나 PR 에 두고 줄에는 번호나 링크만 남긴다: ${text.trim()}`
  }
  const parsed = parseStepMark(text)
  if (parsed?.mark === 'wait') {
    const problem = waitConditionProblem(parsed.condition)
    if (problem) return problem
  } else if (WAIT_PROSE.test(body)) {
    return `기다림은 [wait: 누구/무엇] 꼴로만 쓴다. 이유와 뒤 계획은 다음 단계 줄로 쓴다: ${text.trim()}`
  }
  return null
}
