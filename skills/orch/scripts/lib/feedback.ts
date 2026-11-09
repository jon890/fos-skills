// 개선 후보의 고정 양식과 옛 메모 읽기. 후보 하나가 feedback/<slug>.md 하나다.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { oneLine } from './study.ts'

export const FIELDS = ['스킬', '상황', '문제', '바라는 기능', '근거', '판단', '상태'] as const
export type Field = typeof FIELDS[number]
export type Candidate = { title: string; values: Record<Field, string>; text: string; file: string; slug: string }

export function validStatus(value: string): boolean {
  if (value === '후보' || /^채택 #[1-9]\d*$/.test(value)) return true
  const reason = /^(?:기각|보류)\((.*)\)$/.exec(value)?.[1]
  return reason !== undefined && reason.trim() !== ''
}

export function isOpen(candidate: Candidate): boolean {
  return candidate.values.상태 === '후보' || candidate.values.상태.startsWith('보류(')
}

export function render(title: string, values: Record<Field, string>): string {
  return [`## ${oneLine(title)}`, ...FIELDS.map(field => `- ${field}: ${oneLine(values[field])}`), ''].join('\n')
}

export function parse(text: string, file = '', slug = ''): Candidate | null {
  const lines = text.trimEnd().split(/\r?\n/)
  if (lines.length !== FIELDS.length + 1 || !lines[0].startsWith('## ') || !lines[0].slice(3).trim()) return null
  const values = {} as Record<Field, string>
  for (const [i, field] of FIELDS.entries()) {
    const prefix = `- ${field}: `
    if (!lines[i + 1].startsWith(prefix) || !lines[i + 1].slice(prefix.length).trim()) return null
    values[field] = lines[i + 1].slice(prefix.length).trim()
  }
  if (!validStatus(values.상태)) return null
  return { title: lines[0].slice(3), values, text, file, slug }
}

export function scan(dir: string): { candidates: Candidate[]; legacy: string[] } {
  const out: { candidates: Candidate[]; legacy: string[] } = { candidates: [], legacy: [] }
  let names: string[]
  try { names = readdirSync(dir).sort() } catch { return out }
  for (const name of names) {
    if (!name.endsWith('.md') || name === 'README.md') continue
    const file = join(dir, name)
    let text: string
    try {
      if (!statSync(file).isFile()) continue
      text = readFileSync(file, 'utf8')
    } catch { continue }
    const candidate = parse(text, file, name.slice(0, -3))
    if (candidate) out.candidates.push(candidate)
    else out.legacy.push(file)
  }
  return out
}

export type Legacy = { title: string; values: Record<Field, string> }
// 명시된 칸만 옮기고, 읽지 못한 원문은 근거에 남긴다.
export function parseLegacy(text: string, source: string): Legacy[] {
  const lines = text.split(/\r?\n/)
  const starts = lines.flatMap((line, index) => /^## /.test(line) ? [index] : [])
  if (starts.length === 0) starts.push(0)
  return starts.map((start, i) => {
    const section = lines.slice(start, starts[i + 1] ?? lines.length)
    const values = {} as Record<Field, string>
    for (const field of FIELDS) {
      const found = section.find(line => line.startsWith(`- ${field}: `))
      values[field] = found?.slice(`- ${field}: `.length).trim() || '확인 필요'
    }
    const judgments = [['유의미', '유의미한가'], ['단순 함정 아님', '단순 함정이 아닌가'], ['구조로 막기', '구조로 막을 수 있는가']].map(([label, target]) => {
      const found = section.find(line => line.startsWith(`- ${label}: `))
      return `${target}: ${found?.slice(`- ${label}: `.length).trim() || '확인 필요'}`
    })
    if (values.판단 === '확인 필요') values.판단 = judgments.join(' / ')
    // 원문 전체를 근거에 남겨 알 수 없는 칸과 파일 앞의 메모도 잃지 않는다.
    values.근거 = `${source}:${start + 1}; ${values.근거}; 원문: ${oneLine(i === 0 ? lines.slice(0, starts[1] ?? lines.length).join('\n') : section.join('\n'))}`
    if (!validStatus(values.상태)) values.상태 = '보류(확인 필요: 옛 메모의 판정을 확인한다)'
    const heading = section.find(line => /^#{1,2} /.test(line))
    const title = heading?.replace(/^#{1,2} /, '').replace(/^\d+\.\s*/, '') || '확인 필요: 제목이 없는 옛 메모'
    return { title, values }
  })
}
