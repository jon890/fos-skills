// 공부 후보 파일(<orch 루트>/study/<slug>.md)을 읽고 쓴다. 절차와 상태의 뜻은 references/study-candidates.md 가 소유한다.
//
// 파일 형식:
//     후보 하나가 파일 하나다. 파일 이름은 `<slug>.md` 이고 slug 는 영문 소문자, 숫자, 하이픈(SLUG)이다.
//     첫 줄이 `---` 이고 다음 `---` 줄까지가 머리다. 머리의 한 줄은 `<칸>: <값>` 이고 칸은 FIELDS 다.
//     값은 한 줄이다. 모르는 칸과 머리 뒤의 본문(자유 메모)은 읽지 않고 고칠 때도 그대로 둔다.
//     폴더 바로 아래의 `.md` 가운데 README.md 와 옛 표 파일(LEGACY_FILE)은 후보가 아니다.
//
// 같은 후보:
//     slug 가 같거나, 주제를 NFC 로 맞추고 빈칸을 하나로 줄이고 소문자로 바꾼 값이 같으면 같은 후보다.
//
// 상태 칸:
//     `후보`, `리뷰함: <이유>`, `뺌: <이유>`, `글 씀: <글 경로>` 가운데 하나다. 첫머리의 낱말이 상태이고 `:` 뒤가 메모다.
//     첫머리가 네 낱말 가운데 어느 것도 아니면 상태를 모르는 파일이라 열린 후보로 세지 않는다.
//     열린 후보는 `후보` 와 `리뷰함` 이다. 아직 글을 쓰지도 빼지도 않았다.
//     바꿀 수 있는 것은 후보 → 리뷰함, 후보 → 뺌, 리뷰함 → 글 씀, 리뷰함 → 뺌 이다.
//
// 옛 표 파일:
//     5.16.0 전에는 `candidates.md` 한 파일의 표 한 줄이 후보 하나였다. 표 머리는 LEGACY_COLUMNS 다.
//     읽기는 옮기기(study-candidates.ts migrate)만 한다. 칸 안의 `|` 는 `\|` 로 쓰였다.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const FIELDS = ['주제', '질문', '생긴 곳', '참고', '상태', '적은 날'] as const
export type Field = (typeof FIELDS)[number]
export const STATUSES = ['후보', '리뷰함', '뺌', '글 씀'] as const
export type Status = (typeof STATUSES)[number]
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SLUG_MAX = 80
export const LEGACY_FILE = 'candidates.md'
export const LEGACY_COLUMNS = ['주제', '질문', '생긴 곳', '참고', '상태'] as const

export const OPEN: ReadonlySet<Status> = new Set<Status>(['후보', '리뷰함'])
export const NEXT: Readonly<Record<Status, readonly Status[]>> = {
  후보: ['리뷰함', '뺌'],
  리뷰함: ['글 씀', '뺌'],
  뺌: [],
  '글 씀': [],
}

export type Candidate = {
  slug: string
  file: string
  lines: string[]
  // 머리 칸의 줄 번호(0부터). 없는 칸은 빠진다
  at: Partial<Record<Field, number>>
  values: Partial<Record<Field, string>>
  // 머리를 닫는 `---` 의 줄 번호
  end: number
  status: Status | null
}

export function statusOf(value: string): Status | null {
  for (const status of STATUSES) {
    if (value === status || new RegExp(`^${status}(?=[\\s:：(])`).test(value)) return status
  }
  return null
}

export function sameTopic(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()
  return norm(a) === norm(b)
}

export function validSlug(slug: string): boolean {
  return slug.length <= SLUG_MAX && SLUG.test(slug)
}

// 사용자 글을 머리 한 줄에 담는다. 줄바꿈은 빈칸으로 바꾼다
export function oneLine(value: string): string {
  return value.replace(/\r?\n|\r/g, ' ').trim()
}

// 머리가 없으면 null 이다
export function parse(text: string, file: string, slug: string): Candidate | null {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (end < 0) return null
  const at: Partial<Record<Field, number>> = {}
  const values: Partial<Record<Field, string>> = {}
  for (let i = 1; i < end; i++) {
    const m = /^([^:]+):(.*)$/.exec(lines[i])
    if (!m) continue
    const key = m[1].trim() as Field
    if (!(FIELDS as readonly string[]).includes(key) || key in at) continue
    at[key] = i
    values[key] = m[2].trim()
  }
  return { slug, file, lines, at, values, end, status: statusOf(values['상태'] ?? '') }
}

export function render(values: Record<Field, string>, body = ''): string {
  const head = FIELDS.map((field) => `${field}: ${values[field]}`.trimEnd())
  const rest = body.trim() === '' ? [] : ['', body.trimEnd()]
  return ['---', ...head, '---', ...rest, ''].join('\n')
}

// 칸 하나를 바꾼 글. 칸이 없으면 머리 끝에 더한다
export function withField(candidate: Candidate, field: Field, value: string): string {
  const lines = [...candidate.lines]
  const line = `${field}: ${value}`
  const at = candidate.at[field]
  if (at === undefined) lines.splice(candidate.end, 0, line)
  else lines[at] = line
  return lines.join('\n')
}

export type Scan = {
  candidates: Candidate[]
  // 머리를 읽지 못한 `.md`
  broken: string[]
  // 옛 표 파일. 없으면 null
  legacy: string | null
}

// 폴더가 없으면 빈 결과다
export function scan(dir: string): Scan {
  const out: Scan = { candidates: [], broken: [], legacy: null }
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.endsWith('.md') || name === 'README.md') continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
    } catch {
      continue
    }
    if (name === LEGACY_FILE) {
      out.legacy = file
      continue
    }
    const found = parse(readFileSync(file, 'utf8'), file, name.slice(0, -3))
    if (found && found.values['주제']) out.candidates.push(found)
    else out.broken.push(file)
  }
  return out
}

export function isOpen(candidate: Candidate): boolean {
  return candidate.status !== null && OPEN.has(candidate.status)
}

// 로컬 시간대의 YYYY-MM-DD
export function localDate(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// --- 옛 표 파일 ---

export type LegacyRow = { index: number; cells: string[] }

export function splitRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

// 표 머리가 LEGACY_COLUMNS 인 첫 표의 행. 표가 없으면 null 이다
export function parseLegacy(text: string): LegacyRow[] | null {
  const lines = text.split(/\r?\n/)
  const head = lines.findIndex((line) => {
    if (!line.trim().startsWith('|')) return false
    const cells = splitRow(line)
    return cells.length === LEGACY_COLUMNS.length && cells.every((cell, i) => cell === LEGACY_COLUMNS[i])
  })
  if (head < 0 || head + 1 >= lines.length || !lines[head + 1].trim().startsWith('|')) return null
  const rows: LegacyRow[] = []
  for (let i = head + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const cells = splitRow(lines[i])
    while (cells.length < LEGACY_COLUMNS.length) cells.push('')
    rows.push({ index: rows.length + 1, cells })
  }
  return rows
}
