// 공개 저장소에 비공개 낱말(사용자가 목록에 적은 운영 정보)이 들어가지 않게 찾는다. 스펙은 docs/features/private-leak-guard/spec.md 다.
// worker 훅(githooks/dispatch.mjs), 머지 관문(queue/steps/private-words.ts), doctor 가 이 파일 하나를 함께 쓴다.
// lib/commit-check.ts 가 이 파일을 worker 워크트리의 훅 폴더에 복사해 그대로 실행하므로 Node 내장 모듈만 import 한다.
//
// 목록: ~/.config/orch/private-words.txt(ORCH_PRIVATE_WORDS 가 있으면 그 경로. 테스트가 실제 목록과 떼어 놓는 자리다).
//     한 줄에 낱말 하나, 앞뒤 빈칸은 뺀다. 빈 줄과 `#` 로 시작하는 줄은 건너뛴다.
//     목록이 없거나 비었으면 검사하지 않는다. 형식은 docs/data-schema.md 의 「사용자 설정 파일」 이 소유한다.
// 비교: 대소문자를 가리지 않는 부분 문자열이다. 경로나 컨테이너 이름이 더 긴 글 안에 든 것도 찾는다.
// 출력: 걸린 위치(파일과 줄, 커밋 메시지 줄, PR 본문 줄, 댓글 id)와 목록의 줄 번호만 쓴다. 걸린 값과 그 줄의 글은 쓰지 않는다.
//     파일 이름에 낱말이 든 경우 그 부분을 *** 로 가린다.
//
// 공개 여부(repoVisibility): 머신 폴더(ORCH_MACHINE_DIR, 없으면 ~/.cache/orch)의 repo-visibility.json 에 저장소(공통 git 폴더)마다 기억한다.
//     읽은 값은 VISIBILITY_TTL_MS, 읽지 못한 결과는 FAILED_TTL_MS 동안 다시 묻지 않는다. 읽지 못하면 unknown 이고 부르는 쪽이 공개로 보고 검사한다.
//     조회는 부르는 쪽이 넘긴다. 훅은 gh 를 직접 부르고(ghVisibility), 관문과 doctor 는 lib/gh.ts 를 거친다.
//
// 명령줄(훅 폴더의 사본으로 dispatch.mjs 가 부른다):
//     node private-words.ts pre-commit          스테이징한 추가 줄과 생기거나 바뀌는 파일의 이름을 본다
//     node private-words.ts commit-msg <파일>   커밋 메시지를 본다. `git commit -v` 의 자르는 줄(>8) 아래는 보지 않는다
// 종료 코드: 0 통과(목록 없음, 비공개 저장소 포함), 1 낱말이 있어 커밋을 거절한다, 2 검사하지 못했다

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VISIBILITY_TTL_MS = 60 * 60 * 1000
export const FAILED_TTL_MS = 10 * 60 * 1000
const MAX_BUFFER = 256 * 1024 * 1024
const SCISSORS = /^# -+ >8 -+$/
// 거절 출력의 첫 줄. 훅 본체가 이 줄로 「낱말이 있다」 와 「검사기가 예외로 1 을 냈다」 를 구분한다
export const REFUSED_HEAD = 'orch 커밋 검사: 비공개 낱말 목록('

export type Visibility = 'public' | 'private' | 'unknown'
export type PrivateWord = { word: string; line: number }
// where 는 사람이 읽는 위치, entry 는 걸린 낱말의 목록 줄 번호다
export type Finding = { where: string; entry: number }

export function privateWordsPath(home?: string): string {
  if (home === undefined && process.env.ORCH_PRIVATE_WORDS) return process.env.ORCH_PRIVATE_WORDS
  return join(home ?? homedir(), '.config', 'orch', 'private-words.txt')
}

// 목록을 읽는다. 없거나 읽지 못하면 빈 목록이다
export function readPrivateWords(file: string = privateWordsPath()): PrivateWord[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const words: PrivateWord[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const word = raw.trim()
    if (word && !word.startsWith('#')) words.push({ word: word.toLowerCase(), line: index + 1 })
  })
  return words
}

// 글 안에 든 첫 낱말의 목록 줄 번호. 없으면 null 이다
export function matchedEntry(text: string, words: PrivateWord[]): number | null {
  const lower = text.toLowerCase()
  for (const w of words) if (lower.includes(w.word)) return w.line
  return null
}

// 여러 줄 글에서 낱말이 든 줄마다 위치를 낸다. label 은 `커밋 메시지` 같은 글 이름이다
export function textFindings(text: string, words: PrivateWord[], label: string): Finding[] {
  const found: Finding[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    const entry = matchedEntry(line, words)
    if (entry !== null) found.push({ where: `${label} ${index + 1}번째 줄`, entry })
  })
  return found
}

// 낱말이 든 부분을 *** 로 바꾼다. 위치를 알릴 파일 이름과, 관문이 내보내는 줄을 마지막으로 가릴 때 쓴다.
// 원문을 소문자로 바꾸지 않고 i 플래그로 찾는다. 소문자로 바꾸면 길이가 달라지는 문자 뒤에서 위치가 어긋난다
export function mask(text: string, words: PrivateWord[]): string {
  let out = text
  for (const w of words) out = out.replace(new RegExp(w.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '***')
  return out
}

// 보류 이유처럼 그대로 로그에 쓰는 한 줄 글. 낱말이 있으면 값 대신 위치만 남긴다. source 는 그 글을 읽은 곳(`PR 본문`)이고 text 는 그 글 전체다
export function redactLine(value: string, words: PrivateWord[], source: string, text: string): string {
  if (matchedEntry(value, words) === null) return value
  const index = text.split(/\r?\n/).findIndex((line) => line.includes(value))
  return `비공개 낱말이 있어 값을 생략한다(${source}${index >= 0 ? ` ${index + 1}번째 줄` : ''})`
}

// PR 댓글 조회 결과의 줄. 한 줄에 [id, body] 하나다(--jq 의 @json). 줄을 읽지 못하면 null 이다
export function commentRows(stdout: string): Array<{ id: string; body: string }> | null {
  const rows: Array<{ id: string; body: string }> = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const [id, body] = JSON.parse(line) as [unknown, unknown]
      rows.push({ id: String(id), body: typeof body === 'string' ? body : '' })
    } catch {
      return null
    }
  }
  return rows
}

export function findingsText(found: Finding[]): string {
  return found.map((f) => `${f.where}(목록 ${f.entry}번째 줄)`).join(', ')
}

// 커밋 메시지. 자르는 줄 아래(`git commit -v` 의 diff)는 커밋에 들어가지 않는다
export function messageFindings(message: string, words: PrivateWord[]): Finding[] {
  const lines = message.split(/\r?\n/)
  const cut = lines.findIndex((line) => SCISSORS.test(line))
  return textFindings((cut >= 0 ? lines.slice(0, cut) : lines).join('\n'), words, '커밋 메시지')
}

// git diff 머리의 경로. 따옴표로 감싼 경로는 C 꼴 탈출을 푼다
function diffPath(raw: string): string {
  if (!raw.startsWith('"')) return raw
  try {
    return JSON.parse(raw.replace(/\\([0-7]{3})/g, (_, oct: string) => `\\u00${Number.parseInt(oct, 8).toString(16).padStart(2, '0')}`)) as string
  } catch {
    return raw.slice(1, -1)
  }
}

// `git diff --cached -U0` 출력에서 더한 줄을 본다. 지운 줄은 보지 않는다
export function diffFindings(diff: string, words: PrivateWord[]): Finding[] {
  const found: Finding[] = []
  let file = ''
  let next = 0
  // 파일 머리(diff --git 부터 첫 @@ 까지)에서만 +++ 를 경로로 읽는다. 더한 줄이 `++ ` 로 시작해도 머리로 보지 않는다
  let header = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      header = true
      file = ''
      continue
    }
    if (header && line.startsWith('+++ ')) {
      const raw = line.slice(4)
      // 빈칸이 든 경로면 git 이 끝에 탭을 붙인다
      file = raw === '/dev/null' ? '' : diffPath(raw.replace(/\t$/, '')).replace(/^b\//, '')
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      header = false
      next = Number(hunk[1])
      continue
    }
    if (header || !file || !line.startsWith('+')) continue
    const entry = matchedEntry(line.slice(1), words)
    if (entry !== null) found.push({ where: `${mask(file, words)}:${next}`, entry })
    next += 1
  }
  return found
}

// 이번 커밋에 생기거나 바뀌는 파일의 이름. 바이너리 파일과 내용 없는 파일도 이름은 커밋에 남는다
export function nameFindings(names: string[], words: PrivateWord[]): Finding[] {
  const found: Finding[] = []
  for (const name of names) {
    const entry = matchedEntry(name, words)
    if (entry !== null) found.push({ where: `파일 이름 ${mask(name, words)}`, entry })
  }
  return found
}

export function stagedNames(cwd: string = process.cwd()): string[] | null {
  const done = spawnSync('git', ['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=ACMT'], { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER })
  return done.status === 0 ? done.stdout.split('\0').filter(Boolean) : null
}

// --text 로 바이너리로 보이는 파일(NUL 이 든 텍스트, .gitattributes 의 -diff)도 줄로 본다. --no-textconv 로 변환 전 내용을 본다.
// 아주 큰 파일로 MAX_BUFFER 를 넘으면 읽지 못한 것이라 커밋을 거절한다(종료 코드 2)
export function stagedDiff(cwd: string = process.cwd()): string | null {
  const done = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--cached', '-U0', '--text', '--no-textconv', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'], { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER })
  return done.status === 0 ? done.stdout : null
}

function machineDir(): string {
  return process.env.ORCH_MACHINE_DIR || join(homedir(), '.cache', 'orch')
}

function visibilityFile(): string {
  return join(machineDir(), 'repo-visibility.json')
}

// 기억의 열쇠. 같은 저장소의 워크트리는 공통 git 폴더가 같다
export function repoKey(cwd: string): string | null {
  const done = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' })
  if (done.status !== 0 || !done.stdout.trim()) return null
  try {
    return realpathSync(done.stdout.trim())
  } catch {
    return done.stdout.trim()
  }
}

type Remembered = { visibility: Visibility; at: number }

function readRemembered(): Record<string, Remembered> {
  try {
    const data = JSON.parse(readFileSync(visibilityFile(), 'utf8')) as unknown
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, Remembered>) : {}
  } catch {
    return {}
  }
}

function remember(key: string, visibility: Visibility, now: number): void {
  const file = visibilityFile()
  const data = readRemembered()
  data[key] = { visibility, at: now }
  // 옆 파일에 쓴 뒤 rename 한다. 쓰지 못해도 다음 조회가 다시 물을 뿐이다
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // 기억하지 못해도 판정은 그대로다
  }
}

// gh 의 visibility 값. PUBLIC 만 공개, PRIVATE 와 INTERNAL 은 비공개, 그 밖은 읽지 못한 것이다
export function parseVisibility(value: unknown): Visibility {
  if (value === 'PUBLIC') return 'public'
  if (value === 'PRIVATE' || value === 'INTERNAL') return 'private'
  return 'unknown'
}

// 훅이 쓰는 조회. GH 환경 변수로 실행 파일을 바꾼다(lib/gh.ts 와 같다)
export function ghVisibility(cwd: string): Visibility {
  const done = spawnSync(process.env.GH || 'gh', ['repo', 'view', '--json', 'visibility', '--jq', '.visibility'], { cwd, encoding: 'utf8', timeout: 20_000 })
  return done.status === 0 ? parseVisibility(done.stdout.trim()) : 'unknown'
}

// 공개 여부. 기억한 값이 기한 안이면 조회하지 않는다
export function repoVisibility(cwd: string, lookup: (cwd: string) => Visibility = ghVisibility, now: number = Date.now()): Visibility {
  const key = repoKey(cwd)
  if (key === null) return lookup(cwd)
  const known = readRemembered()[key]
  if (known && typeof known.at === 'number' && ['public', 'private', 'unknown'].includes(known.visibility)) {
    const ttl = known.visibility === 'unknown' ? FAILED_TTL_MS : VISIBILITY_TTL_MS
    if (now - known.at < ttl && now >= known.at) return known.visibility
  }
  const visibility = lookup(cwd)
  remember(key, visibility, now)
  return visibility
}

function say(text: string): void {
  process.stderr.write(`${text}\n`)
}

function refuse(found: Finding[]): number {
  say(`${REFUSED_HEAD}${privateWordsPath()})의 낱말이 있어 커밋하지 않았다. 값은 보이지 않는다.`)
  for (const f of found) say(`  ${f.where}(목록 ${f.entry}번째 줄)`)
  say('그 낱말을 빼거나 일반 표현으로 바꿔 다시 스테이징한 뒤 커밋한다. --no-verify 로 넘기지 않는다.')
  return 1
}

export function main(argv: string[]): number {
  const words = readPrivateWords()
  if (words.length === 0) return 0
  const [hook, file] = argv
  if (hook !== 'pre-commit' && hook !== 'commit-msg') {
    say('사용법: private-words.ts pre-commit | commit-msg <파일>')
    return 2
  }
  if (repoVisibility(process.cwd()) === 'private') return 0
  if (hook === 'pre-commit') {
    const names = stagedNames()
    const diff = stagedDiff()
    if (names === null || diff === null) {
      say('orch 커밋 검사: 스테이징한 변경을 읽지 못해 비공개 낱말을 확인하지 못했다')
      return 2
    }
    const found = [...nameFindings(names, words), ...diffFindings(diff, words)]
    return found.length > 0 ? refuse(found) : 0
  }
  let message: string
  try {
    message = readFileSync(file ?? '', 'utf8')
  } catch {
    say('orch 커밋 검사: 커밋 메시지 파일을 읽지 못해 비공개 낱말을 확인하지 못했다')
    return 2
  }
  const found = messageFindings(message, words)
  return found.length > 0 ? refuse(found) : 0
}

// import.meta.main 은 Node 24.2 부터 있다. 그 전 버전에서 main 을 건너뛰고 0(통과)으로 끝나지 않게 경로도 비교한다
function isEntry(): boolean {
  if (import.meta.main) return true
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntry()) process.exitCode = main(process.argv.slice(2))
