// 공통 지시서의 표지 항목과 비교 규칙. lint 와 sync-common 이 함께 쓴다.
import { ConfigError, loadConfig } from './config.ts'

export type RuleBody = { no: number; body: string; head: number; end: number; raw: string; keep: boolean; unsafe: boolean; section: string | null }
const RULE_MARK = /<!--\s*orch-rule:\s*([A-Za-z0-9_-]+)([^>]*?)-->/g
const FENCE = /^\s*(```|~~~)/
// 코드 블록(``` 나 ~~~) 안의 줄을 빈 줄로 바꾼다. 줄 번호는 그대로다. 예시로 인용한 제목과 줄을 판정에 쓰지 않으려는 것이다
export function outsideFences(lines: string[]): string[] {
  let fence: string | null = null
  return lines.map((line) => {
    const m = FENCE.exec(line)
    if (m) {
      if (fence === null) fence = m[1]
      else if (fence === m[1]) fence = null
      return ''
    }
    return fence === null ? line : ''
  })
}

export type RuleMark = { name: string; no: number; keep: boolean; error?: string }
export function ruleMarks(text: string): RuleMark[] {
  return outsideFences(text.split(/\r\n|[\n\r\u2028\u2029]/)).flatMap((line, index) => [...line.matchAll(RULE_MARK)].map((m) => {
    const tail = m[2].trim()
    const keep = /^keep(?:\s+이유:\s*.+)?$/i.test(tail)
    return { name: m[1], no: index + 1, keep, ...(tail && !keep ? { error: `표지 ${m[1]}:${index + 1} 의 뒤꼬리를 알 수 없다: ${tail}` } : {}) }
  }))
}

export function ruleIssues(text: string): { no: number; message: string }[] {
  const marks = ruleMarks(text)
  const issues = marks.filter((mark) => mark.error).map((mark) => ({ no: mark.no, message: mark.error! }))
  for (const name of new Set(marks.map((mark) => mark.name))) {
    const rows = marks.filter((mark) => mark.name === name)
    if (rows.length > 1) issues.push({ no: rows[0].no, message: `같은 표지 ${name} 가 둘 이상 있다: ${rows.map((mark) => mark.no).join(', ')}줄` })
  }
  return issues
}

// 머리 주석의 「공통」 의 조건부 표지. 조건이 거짓인 저장소에서는 그 표지가 빠져도 알리지 않는다
export const CONDITIONAL_RULES: Record<string, (repoRoot: string) => boolean> = {
  migration: (repoRoot) => configured(repoRoot, 'migrations', ['dirs', 'watch']),
  adr: (repoRoot) => configured(repoRoot, 'adr', ['dirs']),
}

// 설정 절의 keys 가운데 하나라도 비지 않은 객체인지. 설정을 읽지 못하면 거짓이다
function configured(repoRoot: string, name: 'migrations' | 'adr', keys: string[]): boolean {
  let body: unknown
  try {
    body = loadConfig(repoRoot)[name]
  } catch (e) {
    if (e instanceof ConfigError) return false
    throw e
  }
  if (typeof body !== 'object' || body === null) return false
  const filled = (value: unknown) => typeof value === 'object' && value !== null && Object.keys(value).length > 0
  return keys.some((key) => filled((body as Record<string, unknown>)[key]))
}

// 표지마다 그 표지가 든 목록 항목의 본문과 머리 줄 번호. 머리 주석의 「공통」 이 범위를 정한다
export function ruleBodies(text: string): Map<string, RuleBody> {
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/)
  const visible = outsideFences(lines)
  const indented = (line: string) => /^\s/.test(line)
  const found = new Map<string, RuleBody>()
  visible.forEach((line, index) => {
    for (const mark of ruleMarks(line)) {
      let head = index
      while (head > 0 && indented(lines[head])) head -= 1
      let end = index + 1
      while (end < lines.length && (lines[end].trim() === '' || indented(lines[end]))) end += 1
      const body = lines
        .slice(head, end)
        .map((l, i) => (i === 0 ? l.replace(/^(?:[-*]|\d+\.)\s+/, '') : l).trimEnd())
        .filter((l) => l !== '')
        .join('\n').replace(RULE_MARK, (_all, name) => `<!-- orch-rule: ${name} -->`)
      found.set(mark.name, { no: head + 1, body, head, end, raw: lines.slice(head, end).join('\n'), section: visible.slice(0, head).findLast((row) => /^#{1,6}\s+/.test(row))?.trim() ?? null, keep: mark.keep, unsafe: index !== head || visible.slice(head + 1, end).some((row) => /^\s+(?:[-*+]|\d+[.)])\s+/.test(row)) })
    }
  })
  return found
}

// 틀 본문의 {{...}} 는 저장소가 채운 값이라 아무 글자에나 맞춘다
export function sameBody(template: string, copy: string): boolean {
  const parts = template.split(/\{\{[^}]*\}\}/)
  if (parts.length === 1) return template === copy
  const pattern = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*?')
  return new RegExp(`^${pattern}$`).test(copy)
}

