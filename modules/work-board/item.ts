// 보드 항목을 읽는 orch 와 항목을 편집하는 board.ts 가 같은 형식과 줄 지문을 쓴다.
import { createHash } from 'node:crypto'

export const LEAD_MARK = /^\s*(✓|\[[xX ]\]|▶|◇)\s*/
export const FIELDS = ['title', 'owner', 'pr', 'worktree', 'branch', 'merged-pr', 'task', 'task-ref', 'progress', 'stages', 'feature', 'feature-repo'] as const
export const GET_FIELDS = ['status', ...FIELDS, 'priority', 'step'] as const

const DONE_MARKS = ['✓', '[x]', '[X]']
export type Line = { text: string; done: boolean }

// 옛 문자열을 {text, done} 으로 바꾼다. 객체의 done 값이 앞 표시보다 우선한다.
export function normalizeLine(line: unknown): Line {
  let text: string
  let done: boolean
  if (typeof line === 'object' && line !== null && !Array.isArray(line)) {
    const row = line as Record<string, unknown>
    if (!('text' in row)) throw new Error('단계 줄 객체에 text 가 없다')
    text = String(row.text)
    done = row.done === true
  } else {
    text = String(line)
    const mark = LEAD_MARK.exec(text)
    done = Boolean(mark && DONE_MARKS.includes(mark[1]))
  }
  return { text: text.replace(LEAD_MARK, ''), done }
}

// Python 의 `value or ''` 처럼 거짓 값은 빈 줄 하나가 된다
export function normalizeLines(value: unknown): Line[] {
  const lines = Array.isArray(value) ? value : String(value || '').split('\n')
  return lines.map(normalizeLine)
}

// 줄 글과 끝냄 값을 함께 비교한다. 저장 형식이 달라도 같은 줄은 같은 지문이다.
export function linesRev(item: Record<string, unknown> | undefined): string {
  const lists = ['details', 'next'].map((key) => item && key in item ? normalizeLines(item[key]).map(({ text, done }) => [text, done]) : [])
  return createHash('sha1').update(JSON.stringify(lists)).digest('hex').slice(0, 12)
}

export function fieldText(value: unknown): string | null {
  return typeof value === 'string' ? value || null : typeof value === 'number' ? String(value) : null
}
export function itemTitle(item: Record<string, unknown>): string | null {
  return 'title' in item ? fieldText(item.title) : String(item.id)
}
