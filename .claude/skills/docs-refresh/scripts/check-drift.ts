#!/usr/bin/env node
// fos-skills 의 설명 문서가 원본(매니페스트, 코드의 목록)과 어긋난 자리를 찾는다.
// 어느 문서를 어느 원본과 대조하는지는 ../references/sources.md 가 소유한다. 이 파일은 그 표 가운데 자동으로 대조할 수 있는 행만 구현한다.
//
// 사용법 (cwd 와 상관없이 --root 가 저장소 루트다. 주지 않으면 이 스킬이 든 저장소다)
//   node .claude/skills/docs-refresh/scripts/check-drift.ts [--root DIR] [--summary]
//
// 출력
//   어긋남마다 한 줄: `DOCS-DRIFT <문서>:<줄> <무엇이 다른지>`. 문서는 루트 기준 상대 경로다.
//   --summary 면 어긋남이 있을 때 한 줄만 낸다: `DOCS-DRIFT <N>건. <확인 명령>`. 없으면 아무것도 내지 않는다.
//
// 종료 코드
//   0  어긋남 없음
//   1  어긋남 있음
//   2  실행 실패(원본 파일이 없거나 읽지 못함, 모르는 옵션). stderr 에 이유를 낸다

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type Drift = { doc: string; line: number; message: string }

export type Row = { line: number; cells: string[] }

// Markdown 표의 한 행을 칸으로 나눈다. `\|` 는 칸 안의 글자다
export function splitRow(text: string): string[] {
  const body = text.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cur += '|'
      i++
    } else if (body[i] === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += body[i]
  }
  cells.push(cur.trim())
  return cells
}

// 제목이 heading 인 절의 첫 표에서 머리와 구분선을 뺀 행. 절이 없으면 null 이다. line 은 1부터다
export function sectionTable(md: string, heading: string): { headingLine: number; rows: Row[] } | null {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => /^#{1,6} /.test(l) && l.replace(/^#+ /, '').trim() === heading)
  if (start < 0) return null
  const rows: Row[] = []
  let inTable = false
  let fence = false
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*```/.test(l)) fence = !fence
    if (fence) continue
    if (/^#{1,6} /.test(l)) break
    if (l.trim().startsWith('|')) {
      inTable = true
      const cells = splitRow(l)
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue
      rows.push({ line: i + 1, cells })
    } else if (inTable) break
  }
  return { headingLine: start + 1, rows: rows.slice(1) }
}

const codes = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])

// 1. 루트 README 「스킬 목록」 과 .claude-plugin/plugin.json 의 skills
export function checkSkillList(readme: string, manifestSkills: string[]): Omit<Drift, 'doc'>[] {
  const table = sectionTable(readme, '스킬 목록')
  if (!table) return [{ line: 1, message: '「스킬 목록」 절이 없다' }]
  const listed = new Map<string, number>()
  for (const row of table.rows) {
    const m = row.cells[0]?.match(/\]\(([^)]+?)\/README\.md\)/)
    if (m) listed.set(m[1].replace(/^\.\//, ''), row.line)
  }
  const declared = manifestSkills.map((s) => s.replace(/^\.\//, ''))
  const out: Omit<Drift, 'doc'>[] = []
  for (const s of declared) if (!listed.has(s)) out.push({ line: table.headingLine, message: `스킬 목록 표에 ${s} 가 없다(plugin.json 의 skills 에 있다)` })
  for (const [s, line] of listed) if (!declared.includes(s)) out.push({ line, message: `스킬 목록 표의 ${s} 가 plugin.json 의 skills 에 없다` })
  return out
}

// 2. 보드 README 의 단축키와 register.js 의 Button hotkey
export function boardHotkeys(registerJs: string): Set<string> {
  return new Set([...registerJs.matchAll(/hotkey:\s*'([^']+)'/g)].map((m) => m[1]))
}

export function checkBoardHotkeys(readme: string, hotkeys: Set<string>): Omit<Drift, 'doc'>[] {
  const out: Omit<Drift, 'doc'>[] = []
  const table = sectionTable(readme, '단축키')
  if (!table) return [{ line: 1, message: '「단축키」 절이 없다' }]
  const inTable = new Set<string>()
  for (const row of table.rows) for (const k of codes(row.cells[0] ?? '')) if (/^[a-z]$/.test(k)) inTable.add(k)
  for (const k of hotkeys) if (!inTable.has(k)) out.push({ line: table.headingLine, message: `단축키 표에 \`${k}\` 가 없다(register.js 의 hotkey 에 있다)` })
  // 표와 본문 어디서든 한 글자 키로 쓴 것은 register.js 에 있어야 한다
  readme.split('\n').forEach((l, i) => {
    for (const m of l.matchAll(/`([a-z])`/g)) {
      if (!hotkeys.has(m[1])) out.push({ line: i + 1, message: `\`${m[1]}\` 키가 register.js 의 hotkey 에 없다` })
    }
  })
  return out
}

// 3. 문서의 `orch <묶음> <동작>` 과 skills/orch/scripts/lib/commands.ts 의 명령 표
export type CommandTable = {
  groups: string[]
  resolve: (argv: string[]) => { error: string } | { command: { retired?: { since: string; doc: string } } }
}

export function checkOrchCommands(md: string, table: CommandTable): Omit<Drift, 'doc'>[] {
  const out: Omit<Drift, 'doc'>[] = []
  let fence = false
  md.split('\n').forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence
    // 코드로 적은 명령(인라인 코드의 맨 앞, 코드 펜스 줄의 맨 앞)은 묶음 이름이 없으면 오타다. 본문의 `orch 루트` 같은 말은 보지 않는다
    const asCode = [...l.matchAll(/`orch ([a-z][a-z-]*)/g)].map((m) => m[1])
    if (fence) asCode.push(...[...l.matchAll(/^\s*(?:\$ )?orch ([a-z][a-z-]*)/g)].map((m) => m[1]))
    for (const group of new Set(asCode)) {
      if (!table.groups.includes(group)) out.push({ line: i + 1, message: `\`orch ${group}\` 의 묶음 ${group} 가 orch 명령 표에 없다` })
    }
    for (const m of l.matchAll(/(?<![\w./-])orch ([a-z][a-z-]*)((?: [a-z][a-z-]*){0,2})/g)) {
      const group = m[1]
      if (!table.groups.includes(group)) continue
      const words = m[2].trim() ? m[2].trim().split(' ') : []
      const r = table.resolve([group, ...words])
      const shown = ['orch', group, ...words].join(' ')
      if ('error' in r) {
        if (r.error.includes('모르는 동작')) out.push({ line: i + 1, message: `\`${shown}\` 가 orch 명령 표에 없다` })
      } else if (r.command.retired) out.push({ line: i + 1, message: `\`${shown}\` 는 물러난 명령이다(${r.command.retired.doc})` })
    }
  })
  return out
}

// 4. docs/flow.md 「이벤트 목록」 과 events.ts 의 EVENTS
export function eventSpecs(eventsTs: string): Map<string, boolean> {
  const block = eventsTs.slice(eventsTs.indexOf('export const EVENTS'))
  const end = block.indexOf('})')
  const out = new Map<string, boolean>()
  for (const m of block.slice(0, end).matchAll(/^\s*'?([a-z-]+)'?:\s*spec\((true|false)/gm)) out.set(m[1], m[2] === 'true')
  return out
}

export function checkEvents(flow: string, events: Map<string, boolean>): Omit<Drift, 'doc'>[] {
  const table = sectionTable(flow, '이벤트 목록')
  if (!table) return [{ line: 1, message: '「이벤트 목록」 절이 없다' }]
  const out: Omit<Drift, 'doc'>[] = []
  const seen = new Set<string>()
  for (const row of table.rows) {
    const name = codes(row.cells[0] ?? '')[0]
    if (!name) continue
    seen.add(name)
    if (!events.has(name)) {
      out.push({ line: row.line, message: `이벤트 ${name} 가 events.ts 의 EVENTS 에 없다` })
      continue
    }
    const reject = row.cells[3]
    const want = events.get(name) ? '예' : '아니오'
    if (reject && reject !== want) out.push({ line: row.line, message: `이벤트 ${name} 의 거부 칸이 ${reject} 인데 events.ts 는 ${want} 다` })
  }
  for (const name of events.keys()) if (!seen.has(name)) out.push({ line: table.headingLine, message: `이벤트 목록 표에 ${name} 가 없다(events.ts 의 EVENTS 에 있다)` })
  return out
}

// 5. docs/data-schema.md 「config.json 에 더하는 절」 과 core/config.ts 의 절별 키
// finish, cleanup 과 queue 의 나머지 키는 skills/orch/references/overlay.md 「마무리 설정 파일」 이 소유해 이 표에서 뺀다
export function checkConfig(schema: string, keys: Map<string, readonly string[]>): Omit<Drift, 'doc'>[] {
  const table = sectionTable(schema, 'config.json 에 더하는 절')
  if (!table) return [{ line: 1, message: '「config.json 에 더하는 절」 절이 없다' }]
  const out: Omit<Drift, 'doc'>[] = []
  const seen = new Set<string>()
  for (const row of table.rows) {
    const section = codes(row.cells[0] ?? '')[0]
    if (!section) continue
    const known = keys.get(section)
    if (!known) {
      out.push({ line: row.line, message: `절 ${section} 가 core/config.ts 에 없다` })
      continue
    }
    for (const key of codes(row.cells[1] ?? '')) {
      seen.add(`${section}.${key}`)
      if (!known.includes(key)) out.push({ line: row.line, message: `키 ${section}.${key} 가 core/config.ts 에 없다` })
    }
  }
  for (const [section, known] of keys)
    for (const key of known) if (!seen.has(`${section}.${key}`)) out.push({ line: table.headingLine, message: `표에 ${section}.${key} 가 없다(core/config.ts 에 있다)` })
  return out
}

// data-schema 표가 갖는 절별 키. finish, cleanup 은 다른 문서가 갖는다.
// queue 는 머지 큐 옵션으로 바꾸지 않는 키(QUEUE_SCHEMA_KEYS)만 표에 적는다
export function schemaKeys(config: Record<string, unknown>): Map<string, readonly string[]> {
  const keys = new Map<string, readonly string[]>()
  for (const s of config.SECTIONS as string[]) {
    if (s === 'finish' || s === 'cleanup') continue
    const list = config[s === 'queue' ? 'QUEUE_SCHEMA_KEYS' : `${s.toUpperCase()}_KEYS`] as readonly string[] | undefined
    if (list) keys.set(s, list)
  }
  return keys
}

// 6. 문서가 백틱으로 적은 이 저장소의 경로가 있는지
// 스킬 README 의 상대 경로는 루트나 그 스킬 폴더 기준이다(pathBases).
// 전역 문서(루트 README, docs/)는 어느 스킬인지 문맥으로 정하는 경로(`scripts/lib/x.ts`)를 쓰므로 루트와 모든 스킬 폴더 가운데 한 곳에 있으면 있는 것으로 본다.
// `.claude/`, `.orch/` 는 다른 저장소나 각자의 PC 에 있는 자리를 가리키는 일이 많아 보지 않는다
// 팀 저장소의 배치를 가리키는 경로는 이 저장소에 없는 것이 맞다(scripts/export-to-team.ts 의 SHARED_TOOLS)
const ELSEWHERE = ['tools/browser-driver']
const PREFIXES = ['skills/', 'export-only-skills/', 'extensions/', 'scripts/', 'tools/', 'modules/', 'githooks/', 'bin/', '.claude-plugin/', '.codex-plugin/', '.github/', 'references/', 'templates/', 'hooks/', 'tests/', 'changes/']

export function checkPaths(md: string, bases: string[], exists: (path: string) => boolean): Omit<Drift, 'doc'>[] {
  const out: Omit<Drift, 'doc'>[] = []
  let fence = false
  md.split('\n').forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence
    if (fence) return
    for (const m of l.matchAll(/`([^`\s]+)`/g)) {
      const token = m[1].replace(/[:,.]+$/, '')
      if (/[<>*$?{}~"'()]/.test(token) || token.includes('..')) continue
      if (!PREFIXES.some((p) => token.startsWith(p)) || ELSEWHERE.some((p) => token.startsWith(p))) continue
      if (bases.some((b) => exists(b ? join(b, token) : token))) continue
      out.push({ line: i + 1, message: `경로 ${token} 가 없다` })
    }
  })
  return out
}

// 7. 루트 README 의 절 뼈대. 처음 보는 사람이 핵심만 읽게 사용자가 정한 순서다(사용자 결정 2026-11-20).
// 절을 더하거나 `###` 하위 절을 두면 상세가 README 로 돌아온 것이다. 상세는 docs/flow.md, docs/contributing.md, 스킬 README 에 둔다.
// 뼈대를 바꾸는 것은 사용자 결정이라, 바꾸면 이 목록과 ../references/readability.md 를 함께 고친다
export const README_OUTLINE = ['흐름', '스킬 목록', '설치와 갱신', '처음 써 보기', '화면', '기여']

export function checkReadmeOutline(readme: string): Omit<Drift, 'doc'>[] {
  const out: Omit<Drift, 'doc'>[] = []
  const found: { line: number; title: string }[] = []
  let fence = false
  readme.split('\n').forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence
    if (fence) return
    const m = /^(#{2,6}) (.+)$/.exec(l)
    if (!m) return
    if (m[1].length > 2) out.push({ line: i + 1, message: `하위 절 「${m[2].trim()}」 을 두지 않는다. 상세는 docs/ 로 옮긴다` })
    else found.push({ line: i + 1, title: m[2].trim() })
  })
  for (const h of found) if (!README_OUTLINE.includes(h.title)) out.push({ line: h.line, message: `절 「${h.title}」 이 README 뼈대에 없다. 상세는 docs/ 로 옮긴다` })
  const missing = README_OUTLINE.filter((t) => !found.some((h) => h.title === t))
  for (const t of missing) out.push({ line: 1, message: `README 뼈대의 절 「${t}」 이 없다` })
  const order = found.filter((h) => README_OUTLINE.includes(h.title)).map((h) => h.title)
  if (missing.length === 0 && order.join('\n') !== README_OUTLINE.join('\n')) out.push({ line: 1, message: `절 순서가 뼈대와 다르다: ${README_OUTLINE.join(' > ')}` })
  return out
}

// 스킬 폴더 기준 경로를 풀 때 쓰는 폴더들. 루트 기준 상대 경로다
export function componentDirs(root: string): string[] {
  const out: string[] = []
  for (const parent of ['skills', 'export-only-skills', 'extensions']) {
    if (!existsSync(join(root, parent))) continue
    for (const name of readdirSync(join(root, parent)).sort()) out.push(`${parent}/${name}`)
  }
  return out
}

// 문서 하나의 경로를 풀 기준 폴더. 스킬과 확장 README 는 루트와 자기 폴더만, 전역 문서는 루트와 모든 스킬 폴더다
export function pathBases(doc: string, components: string[]): string[] {
  const dir = dirname(doc)
  return components.includes(dir) ? ['', dir] : ['', ...components]
}

export function targetDocs(root: string): string[] {
  const docs = ['README.md', 'docs/contributing.md', 'docs/flow.md', 'docs/code-architecture.md', 'docs/data-schema.md']
  for (const name of readdirSync(join(root, 'skills')).sort()) if (existsSync(join(root, 'skills', name, 'README.md'))) docs.push(`skills/${name}/README.md`)
  docs.push('extensions/work-board/README.md')
  return docs.filter((d) => existsSync(join(root, d)))
}

export async function collect(root: string): Promise<Drift[]> {
  const read = (p: string) => readFileSync(join(root, p), 'utf8')
  const drifts: Drift[] = []
  const add = (doc: string, list: Omit<Drift, 'doc'>[]) => drifts.push(...list.map((d) => ({ doc, ...d })))

  add('README.md', checkSkillList(read('README.md'), JSON.parse(read('.claude-plugin/plugin.json')).skills))
  add('README.md', checkReadmeOutline(read('README.md')))
  add('extensions/work-board/README.md', checkBoardHotkeys(read('extensions/work-board/README.md'), boardHotkeys(read('extensions/work-board/hooks/register.js'))))
  add('docs/flow.md', checkEvents(read('docs/flow.md'), eventSpecs(read('skills/orch/scripts/lib/events.ts'))))

  const config = await import(pathToFileURL(join(root, 'skills/orch/scripts/core/config.ts')).href)
  add('docs/data-schema.md', checkConfig(read('docs/data-schema.md'), schemaKeys(config)))

  const commands = await import(pathToFileURL(join(root, 'skills/orch/scripts/lib/commands.ts')).href)
  const table: CommandTable = { groups: commands.GROUPS, resolve: commands.resolveNew }
  const components = componentDirs(root)
  for (const doc of targetDocs(root)) {
    const md = read(doc)
    add(doc, checkOrchCommands(md, table))
    add(doc, checkPaths(md, pathBases(doc, components), (p) => existsSync(join(root, p))))
  }
  return drifts
}

const HERE = dirname(fileURLToPath(import.meta.url))

async function main(argv: string[]): Promise<number> {
  let root = resolve(HERE, '../../../..')
  let summary = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = resolve(argv[++i] ?? '')
    else if (argv[i] === '--summary') summary = true
    else {
      process.stderr.write(`check-drift: 모르는 옵션이다: ${argv[i]}\n`)
      return 2
    }
  }
  let drifts: Drift[]
  try {
    drifts = await collect(root)
  } catch (e) {
    process.stderr.write(`check-drift: ${(e as Error)?.message ?? String(e)}\n`)
    return 2
  }
  if (summary) {
    if (drifts.length) {
      const script = relative(root, fileURLToPath(import.meta.url))
      process.stdout.write(`DOCS-DRIFT ${drifts.length}건. node ${script} 로 목록을 보고 docs-refresh 스킬로 고친다\n`)
    }
  } else for (const d of drifts) process.stdout.write(`DOCS-DRIFT ${d.doc}:${d.line} ${d.message}\n`)
  return drifts.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
