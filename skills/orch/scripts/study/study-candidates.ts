// 공부 후보(<orch 루트>/study/<slug>.md)를 더하고, 고르고, 상태를 바꾸고, 옛 표 파일을 옮긴다.
//
// 이 명령은 파일의 머리 칸만 고치고 본문(자유 메모)은 그대로 둔다. 본문은 에이전트가 파일을 직접 고쳐 쌓는다.
// 파일 형식과 상태 전이는 lib/study.ts 머리 주석이, 적는 시점과 다시 보는 기준은 references/study-candidates.md 가 소유한다.
//
// 사용법:
//     study-candidates.ts list [--open] [--today | --date YYYY-MM-DD] [--repo DIR]
//     study-candidates.ts add --slug SLUG --topic 주제 --question 질문 --origin 생긴곳 [--ref 참고] [--memo 메모] [--repo DIR]
//     study-candidates.ts set --slug SLUG --status 상태 --note 메모 [--repo DIR]
//     study-candidates.ts migrate --slug N=SLUG [--slug N=SLUG ...] [--trash DIR] [--repo DIR]
//
//     list      한 줄에 후보 하나를 `<slug>\t<적은 날>\t<상태 칸>\t<주제>` 로 slug 순서대로 낸다.
//               --open 이면 후보와 리뷰함만, --today 나 --date 면 그날 적은 것만 낸다. 둘을 함께 주면 둘 다 맞는 것만 낸다
//     add       상태 `후보`, 적은 날 오늘로 `<slug>.md` 를 만든다. --memo 는 본문이 된다. 같은 후보가 있으면 만들지 않는다
//     set       그 후보의 상태를 바꾼다. --status 는 리뷰함, 뺌, 글 씀 가운데 하나이고 --note 는 이유나 글 경로다
//     migrate   옛 표 파일 candidates.md 의 줄마다 `<slug>.md` 를 만들고 옛 파일을 --trash 로 옮긴다. 한 번만 돌린다.
//               --slug 는 `<표의 번호>=<slug>` 이고 모든 줄에 준다. 상태는 그대로, 적은 날은 옛 파일의 수정 날짜로 적는다.
//               표 앞뒤의 글은 옮기지 않는다. 규칙은 스킬 문서와 오버레이가 소유한다.
//               하나라도 못 옮기면(slug 가 빠졌다, 틀렸다, 겹친다, 같은 후보가 이미 있다) 아무 파일도 만들지 않는다
//     --trash   옛 파일을 옮길 폴더. 기본 ~/.Trash/orch-study-<오늘>
//     --repo    orch 루트를 찾을 저장소. 기본은 작업 디렉터리. 루트는 lib/paths.ts 의 orchDir 이 정한다
//
// 출력:
//     ADDED <slug> <파일>         add 가 만들었다
//     SET <slug> <상태 칸>        set 이 바꿨다
//     MIGRATED <개수> <폴더>      migrate 가 옮겼다
//     TRASHED <옛 파일> <옮긴 곳>  migrate 가 옛 파일을 옮겼다
//     NEED-SLUG <번호>\t<주제>     migrate 에 slug 가 빠진 줄(stderr, 종료 코드 1)
//
// 종료 코드:
//     0  했다
//     1  하지 않았다. 같은 후보가 있다, 후보가 없다, 바꿀 수 없는 상태다, 옛 파일이 없다, migrate 의 slug 가 빠졌다
//     2  사용법 오류
//
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts).

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { ensure, pathOf } from '../lib/paths.ts'
import {
  type Candidate,
  type Field,
  LEGACY_FILE,
  NEXT,
  STATUSES,
  type Status,
  isOpen,
  localDate,
  oneLine,
  parseLegacy,
  render,
  sameTopic,
  scan,
  statusOf,
  validSlug,
  withField,
} from '../lib/study.ts'

const USAGE = [
  '사용법: study-candidates.ts list [--open] [--today | --date YYYY-MM-DD] [--repo DIR]',
  '        study-candidates.ts add --slug SLUG --topic 주제 --question 질문 --origin 생긴곳 [--ref 참고] [--memo 메모] [--repo DIR]',
  '        study-candidates.ts set --slug SLUG --status 상태 --note 메모 [--repo DIR]',
  '        study-candidates.ts migrate --slug N=SLUG [--slug N=SLUG ...] [--trash DIR] [--repo DIR]',
].join('\n')

const OPTIONS = {
  open: { type: 'boolean' },
  today: { type: 'boolean' },
  date: { type: 'string' },
  slug: { type: 'string', multiple: true },
  topic: { type: 'string' },
  question: { type: 'string' },
  origin: { type: 'string' },
  ref: { type: 'string' },
  memo: { type: 'string' },
  status: { type: 'string' },
  note: { type: 'string' },
  trash: { type: 'string' },
  repo: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const

type Values = {
  open?: boolean
  today?: boolean
  date?: string
  slug?: string[]
  topic?: string
  question?: string
  origin?: string
  ref?: string
  memo?: string
  status?: string
  note?: string
  trash?: string
}

class Usage extends Error {}
class Refused extends Error {}

function save(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

function need(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw new Usage(`--${name} 를 준다`)
  return value
}

function oneSlug(values: Values): string {
  const slugs = values.slug ?? []
  if (slugs.length !== 1) throw new Usage('--slug 를 하나 준다')
  const slug = slugs[0]
  if (!validSlug(slug)) throw new Usage(`--slug 는 영문 소문자, 숫자, 하이픈으로 80자 안이다: ${slug}`)
  return slug
}

// 옛 표 파일이 남아 있으면 옮기라고 알린다. 옛 파일의 후보는 list 와 같은 후보 판정에 들지 않기 때문이다
function warnLegacy(dir: string): void {
  const legacy = scan(dir).legacy
  if (legacy) process.stderr.write(`study-candidates: 옛 표 파일이 남아 있다. migrate 로 옮긴다: ${legacy}\n`)
}

function list(dir: string, values: Values): void {
  if (values.today && values.date) throw new Usage('--today 와 --date 는 함께 주지 않는다')
  if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) throw new Usage(`--date 는 YYYY-MM-DD 다: ${values.date}`)
  const date = values.today ? localDate() : values.date
  for (const c of scan(dir).candidates) {
    if (values.open && !isOpen(c)) continue
    if (date !== undefined && c.values['적은 날'] !== date) continue
    process.stdout.write(`${c.slug}\t${c.values['적은 날'] ?? ''}\t${c.values['상태'] ?? ''}\t${c.values['주제'] ?? ''}\n`)
  }
}

// 같은 후보를 찾는다. slug 가 같거나 주제가 같다
function clash(candidates: readonly Candidate[], slug: string, topic: string): Candidate | undefined {
  return candidates.find((c) => c.slug === slug || sameTopic(c.values['주제'] ?? '', topic))
}

function add(dir: string, repo: string, values: Values): void {
  const slug = oneSlug(values)
  const fields: Record<Field, string> = {
    주제: oneLine(need(values.topic, 'topic')),
    질문: oneLine(need(values.question, 'question')),
    '생긴 곳': oneLine(need(values.origin, 'origin')),
    참고: oneLine(values.ref ?? ''),
    상태: '후보',
    '적은 날': localDate(),
  }
  const file = join(dir, `${slug}.md`)
  const found = clash(scan(dir).candidates, slug, fields['주제'])
  if (found) throw new Refused(`같은 후보가 이미 있다(${found.values['상태'] ?? '상태 모름'}): ${found.file}`)
  if (existsSync(file)) throw new Refused(`파일이 이미 있다: ${file}`)
  ensure('study', repo)
  save(file, render(fields, values.memo ?? ''))
  process.stdout.write(`ADDED ${slug} ${file}\n`)
}

function set(dir: string, values: Values): void {
  const slug = oneSlug(values)
  const status = need(values.status, 'status')
  if (!(STATUSES as readonly string[]).includes(status) || status === '후보') throw new Usage(`--status 는 리뷰함, 뺌, 글 씀 가운데 하나다: ${status}`)
  const note = oneLine(need(values.note, 'note'))
  const c = scan(dir).candidates.find((x) => x.slug === slug)
  if (!c) throw new Refused(`${slug} 후보가 없다. list 로 slug 를 본다`)
  if (c.status === null) throw new Refused(`${slug} 의 상태를 모른다: ${c.values['상태'] ?? ''}`)
  if (!NEXT[c.status].includes(status as Status)) {
    const allowed = NEXT[c.status].join(', ') || '없다'
    throw new Refused(`${slug} 는 ${c.status} 에서 ${status} 로 바꿀 수 없다. 바꿀 수 있는 상태: ${allowed}`)
  }
  const value = `${status}: ${note}`
  save(c.file, withField(c, '상태', value))
  process.stdout.write(`SET ${slug} ${value}\n`)
}

function migrate(dir: string, values: Values): void {
  const legacy = join(dir, LEGACY_FILE)
  if (!existsSync(legacy)) throw new Refused(`옮길 옛 파일이 없다: ${legacy}`)
  const rows = parseLegacy(readFileSync(legacy, 'utf8'))
  if (rows === null) throw new Refused(`옛 파일에서 표 머리를 찾지 못했다: ${legacy}`)
  const given = new Map<number, string>()
  for (const pair of values.slug ?? []) {
    const m = /^([1-9]\d*)=(.+)$/.exec(pair)
    if (!m) throw new Usage(`--slug 는 <번호>=<slug> 다: ${pair}`)
    const index = Number(m[1])
    if (!validSlug(m[2])) throw new Usage(`--slug 는 영문 소문자, 숫자, 하이픈으로 80자 안이다: ${m[2]}`)
    if (given.has(index)) throw new Usage(`${index} 번에 slug 를 두 번 줬다`)
    if (!rows.some((row) => row.index === index)) throw new Usage(`표에 ${index} 번 줄이 없다`)
    given.set(index, m[2])
  }
  const missing = rows.filter((row) => !given.has(row.index))
  if (missing.length > 0) {
    for (const row of missing) process.stderr.write(`NEED-SLUG ${row.index}\t${row.cells[0]}\n`)
    throw new Refused(`slug 가 빠진 줄이 ${missing.length}개다. 모든 줄에 --slug <번호>=<slug> 를 준다`)
  }
  const existing = scan(dir).candidates
  const added = new Date(statSync(legacy).mtime)
  const planned: { file: string; text: string; slug: string; topic: string }[] = []
  const problems: string[] = []
  for (const row of rows) {
    const slug = given.get(row.index) as string
    const [topic, question, origin, ref, state] = row.cells.map(oneLine)
    const file = join(dir, `${slug}.md`)
    const found = clash(existing, slug, topic)
    const twin = planned.find((p) => p.slug === slug || sameTopic(p.topic, topic))
    if (found) problems.push(`${row.index} 번과 같은 후보가 이미 있다: ${found.file}`)
    else if (twin) problems.push(`${row.index} 번이 앞 줄과 slug 나 주제가 겹친다: ${twin.slug}`)
    else if (existsSync(file)) problems.push(`${row.index} 번의 파일이 이미 있다: ${file}`)
    if (statusOf(state) === null) process.stderr.write(`study-candidates: ${row.index} 번의 상태를 모른다. 그대로 옮긴다: ${state}\n`)
    planned.push({ file, slug, topic, text: render({ 주제: topic, 질문: question, '생긴 곳': origin, 참고: ref, 상태: state, '적은 날': localDate(added) }) })
  }
  if (problems.length > 0) throw new Refused(`옮기지 않았다.\n${problems.join('\n')}`)
  for (const p of planned) save(p.file, p.text)
  process.stdout.write(`MIGRATED ${planned.length} ${dir}\n`)
  const trash = values.trash ?? join(homedir(), '.Trash', `orch-study-${localDate()}`)
  mkdirSync(trash, { recursive: true })
  let dest = join(trash, basename(legacy))
  if (existsSync(dest)) dest = join(trash, `candidates-${process.pid}-${Date.now()}.md`)
  renameSync(legacy, dest)
  process.stdout.write(`TRASHED ${legacy} ${dest}\n`)
}

function main(argv: string[]): number {
  let parsed
  try {
    parsed = parseArgs({ args: expandArgs(argv, OPTIONS, ['topic', 'question', 'origin', 'ref', 'memo', 'note']), options: OPTIONS, allowPositionals: true })
  } catch (e) {
    process.stderr.write(`${USAGE}\nstudy-candidates: ${(e as Error).message}\n`)
    return 2
  }
  const { positionals } = parsed
  const values = parsed.values as Values & { repo?: string; help?: boolean }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const [command, ...rest] = positionals
  if (!['list', 'add', 'set', 'migrate'].includes(command ?? '') || rest.length > 0) {
    process.stderr.write(`${USAGE}\nstudy-candidates: 명령은 list, add, set, migrate 가운데 하나다\n`)
    return 2
  }
  const repo = values.repo ?? process.cwd()
  const dir = pathOf('study', repo)
  try {
    if (command !== 'migrate') warnLegacy(dir)
    if (command === 'list') list(dir, values)
    else if (command === 'add') add(dir, repo, values)
    else if (command === 'set') set(dir, values)
    else migrate(dir, values)
  } catch (e) {
    if (e instanceof Usage) {
      process.stderr.write(`${USAGE}\nstudy-candidates: ${e.message}\n`)
      return 2
    }
    if (e instanceof Refused) {
      process.stderr.write(`study-candidates: ${e.message}\n`)
      return 1
    }
    throw e
  }
  return 0
}

process.exitCode = main(process.argv.slice(2))
