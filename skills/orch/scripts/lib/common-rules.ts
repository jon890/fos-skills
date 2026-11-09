// 공통 지시서의 표지 항목과 비교 규칙. lint 와 sync-common 이 함께 쓴다.
import { ConfigError, loadConfig } from './config.ts'

export type RuleBody = { no: number; body: string; head: number; end: number; raw: string; keep: boolean; unsafe: boolean }
const RULE_MARK = /<!--\s*orch-rule:\s*([A-Za-z0-9_-]+)([^>]*?)-->/g
export type RuleMark = { name: string; no: number; keep: boolean; error?: string }
export function ruleMarks(text: string): RuleMark[] {
  return text.split(/\r\n|[\n\r\u2028\u2029]/).flatMap((line, index) => [...line.matchAll(RULE_MARK)].map((m) => {
    const tail = m[2].trim()
    const keep = /^keep(?:\s+이유:\s*.+)?$/i.test(tail)
    return { name: m[1], no: index + 1, keep, ...(tail && !keep ? { error: `표지 ${m[1]}:${index + 1} 의 뒤꼬리를 알 수 없다: ${tail}` } : {}) }
  }))
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
  const indented = (line: string) => /^\s/.test(line)
  const found = new Map<string, RuleBody>()
  lines.forEach((line, index) => {
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
      found.set(mark.name, { no: head + 1, body, head, end, raw: lines.slice(head, end).join('\n'), keep: mark.keep, unsafe: index !== head || lines.slice(head + 1, end).some((row) => /^\s+(?:[-*+]|\d+[.)])\s+/.test(row)) })
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

