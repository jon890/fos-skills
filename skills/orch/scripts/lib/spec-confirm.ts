// 기능 스펙의 확인 줄은 지시서 검사와 자동 진행 확인이 같은 규칙으로 읽는다.
import { LINE_BREAK } from '../core/text.ts'
import { outsideFences } from './common-rules.ts'

const CONFIRMED = /^확인:\s*(\d{4}-\d{2}-\d{2})\s*$/

export function splitLines(text: string): string[] {
  const lines = text.split(LINE_BREAK)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function validDate(text: string): boolean {
  const [y, m, d] = text.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d
}

// 스펙 본문에서 확인 줄 문제. 없으면 null. 제목과 첫 `## ` 절 사이만 본다(check_feature.ts 의 check_confirmed)
export function confirmProblem(text: string): string | null {
  for (const line of outsideFences(splitLines(text))) {
    if (/^##\s/.test(line)) break
    const m = CONFIRMED.exec(line.trim())
    if (m) return validDate(m[1]) ? null : `확인 줄의 날짜가 올바르지 않다: ${m[1]}`
  }
  return '제목 아래에 `확인: YYYY-MM-DD` 줄이 없다. 사용자가 확인한 스펙만 넘긴다. 확인 전이면 `루프를 쓴다(스펙: 새로 쓴다)` 로 spec 단계부터 맡긴다'
}

