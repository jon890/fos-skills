#!/usr/bin/env node
// 한국어 표기 정책 검사 — 금지어를 찾고, 인라인 `+` 연결은 경고로 알린다.
//
// 금지어 목록의 단일 소스는 이 스킬의 `references/korean-style.md` 의 「어색한 말 매핑 표」다.
// 별도 데이터 파일을 두지 않는다. 검사기가 쓰는 정보는 그 표의 부분집합이라,
// 사본을 만들면 원본과 갈라지는 문제만 되돌아온다.
// 다른 위치의 표를 쓰려면 `KOREAN_STYLE_RULES` 로 경로를 준다.
//
// 사용법:
//     node korean-style-check.ts <파일> [<파일>...]     확장자와 상관없이 검사한다
//     node korean-style-check.ts --hook                 PostToolUse 훅 모드(stdin 으로 JSON, .md 만 검사)
//
// 위반과 경고 줄을 stdout 으로 출력한다. 경고만 있으면 통과다.
// 실패로 막는 것은 매핑 표의 금지어뿐이다. 문장 구성 규칙은 지침이라 경고로만 알린다.
// 검사에서 제외하는 것 — 렌더·표기 대상이 아니거나 이미 구조화된 형식이다.
// YAML frontmatter, 코드 블록(```, 목록 안에 들여쓴 것 포함), 코드 스팬(`...`),
// 표 행, 링크 정의 줄, 링크 대상 URL, 자동 링크 URL 이 여기 해당한다.
// 제목은 검사한다. 제목에 쓴 금지어도 본문과 같은 무게로 읽힌다.
// 산술식은 제외 목록에 없다. `GPU 수 × (A + B)` 처럼 코드 스팬으로 감싸면 빠진다.
//
// 종료 코드 — CI 와 스크립트가 실패로 잡을 수 있게 결과를 코드로도 낸다.
//
//     0  통과. 경고만 있어도 0 이다 (--hook 모드는 위반이 있어도 늘 0 이다. 훅은 작업을 막지 않는다)
//     1  금지어 발견
//     2  검사기가 돌지 못함. 매핑 표 파일이 없거나, 표에서 금지어를 추출하지 못했거나,
//        인자가 없거나 다루지 않는 옵션을 받았거나, 넘긴 경로에 파일이 없는 경우다
//
// 편집 직후 자동 검사 (settings.json 은 머신 로컬이라 추적하지 않으므로 여기 남긴다).
// 하네스 설정의 PostToolUse 훅에 `node <이 파일 경로> --hook` 을 걸면 .md 를 쓸 때마다 검사한다.
// Claude Code 의 예시는 README.md 의 「훅 설정」이 소유한다.
//
// 옛 이름 진입 korean-style-check.py(node shebang JS)가 이 파일의 main 을 불러 쓴다. 이 파일은 명령으로 실행될 때만 스스로 돈다.

import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isMain, readStdin, write } from './io.ts'
import { pyJson, pyLen, pyReadText, pySplitLines, pyStrCompare, pyStrip, PY_SPACE } from './kit/py.ts'

// 금지어를 부분 문자열로 품고 있지만 그 자체로는 정당한 합성어.
// 한국어 금지어는 조사가 붙어 「시험이」 처럼 쓰이므로 부분 문자열로 찾아야 한다.
// 그래서 「시험적」(experimental) 처럼 다른 뜻의 낱말도 같이 걸린다.
// 뒤 글자가 한글인지로는 조사와 합성어를 구분할 수 없어, 예외는 여기에 명시한다.
// 검사 전에 이 낱말들을 줄에서 지우므로, 같은 줄에 맨 「시험」이 따로 있으면 그건 여전히 잡힌다.
export const COMPOUND_ALLOW = ['시험적', '판이하', '줄이 선다', '줄이 서야', '판가름', '원천징수', '원천적', '원천 기술', '원천기술', '원천봉쇄']

// 저장소가 두는 예외 파일. 한 줄에 문자열 하나이고 `#` 으로 시작하는 줄과 빈 줄은 무시한다.
// 금지어를 품은 고유명사(게임 콘텐츠 이름, 제품명, 인용한 원문 제목)는 이 스킬이 알 수 없어
// 쓰는 저장소가 적는다. 줄에서 그 문자열을 지우고 검사하므로 문자열 밖의 금지어는 그대로 잡힌다.
// 파일 하나가 COMPOUND_ALLOW 와 같은 효과를 낸다. 찾는 방법은 findAllowFile 이 소유한다.
const ALLOW_FILE = join('.claude', 'korean-check-allow.txt')
const ALLOW_ENV = 'KOREAN_CHECK_ALLOW'
// 한 글자 항목은 줄의 거의 모든 곳을 지워 검사를 끄는 것과 같아 읽지 않는다.
const ALLOW_MIN_LENGTH = 2

// 이 글자들로 시작하는 금지어는 앞 글자가 한글이면 다른 낱말의 일부라서 건너뛴다.
// 「번호판 번호」, 「출판 번호」, 「초판을 올린다」 의 「판」 이 버전 뜻이 아니기 때문이다.
// X판 합성어는 끝없이 늘어 COMPOUND_ALLOW 로 하나씩 막을 수 없다.
// 다른 한 글자 낱말로 시작하는 금지어가 같은 오탐을 내면 그 글자를 여기에 더한다.
// 「평가를」 의 「가를」 처럼 조사 앞 글자가 한글인 오탐은 두세 글자 접두사(「가르」, 「가를」, 「가름」)로 막는다.
// 「가」 한 글자는 「가 선다」 가 시작하는 글자라 쓰지 않는다.
export const WORD_START_PREFIXES = ['판', '날', '손', '거', '걸', '서', '갈', '가르', '가를', '가름']

const CODE_PLACEHOLDER = '\x00'

// Python 의 \s 와 같은 공백 글자(정규식 문자 클래스의 안쪽)
const SPACE = PY_SPACE.slice(1, -1)

// 「표」 와 「칸」 은 문서 표를 가리킬 때도 쓰여 금지어 목록에 올릴 수 없다.
// 그래서 DB 테이블과 컬럼을 가리키는 문맥만 패턴으로 막는다. 코드 스팬이 남은 줄에 건다.
// 파일 이름 뒤의 「`remote.md` 표」 는 문서 표라서 확장자로 끝나는 코드 스팬은 뺀다.
// 「DB 표준」, 「표시」 가 걸리지 않도록 뒤에 조사나 공백, 문장 부호가 올 때만 건다.
const AFTER = `(?=[을를이가는은의에로와과도만]|[${SPACE}.,;:)]|$)`
const IDENT = '`(?![^`]*\\.(?:md|py|sh|json|ya?ml|txt|toml|[jt]sx?)`)[^`]+`'
const DB_CONTEXT_PATTERNS: [string, RegExp][] = [
  ['DB 표', new RegExp(`DB 표${AFTER}`)],
  ['`식별자` 표', new RegExp(`${IDENT} 표${AFTER}`)],
  ['`식별자` 칸', new RegExp(`${IDENT} 칸${AFTER}`)],
]

const TABLE_HEADING = '## 어색한 말 매핑 표'
const SECTION_HEADING = /^## /
const TABLE_ROW = /^\| /
const TABLE_RULE_ROW = new RegExp(`^\\|[${SPACE}]*-`)
const TABLE_HEADER_ROW = /^\| 금지 /

// 매핑 표 첫 열의 괄호. 용례 설명이라 금지어에서 뺀다.
const PARENTHESIZED = /\([^)]*\)/g

// 영문 용어는 단어 경계로 찾는다. 그 판정에 쓰는 형태다.
const ENGLISH_TERM = /^[A-Za-z-]+$/

// 본문에서 검사 전에 지울 것.
const AUTO_LINK = /<https?:\/\/[^>]*>/g
const CODE_SPAN = /`[^`]*`/g

// 줄 자체를 건너뛰는 형태.
const FRONT_MATTER_MARK = /^---[ \t]*$/
const FENCE = /^[ \t]*```/
const TABLE_LINE = /^[ \t]*\|/
const LINK_DEFINITION = /^[ \t]*\[[^\]]+\]:/

const INLINE_PLUS = new RegExp(`([^${SPACE}]+) \\+ ([^${SPACE}]+)`, 'g')
// 코드 스팬이나 대문자 상수를 잇는 `+` 는 항목 나열이 아니라 값의 조합이다.
const CONSTANT = /^[A-Z][A-Z0-9_]*[,.;:)]*$/

const USAGE = `사용법:
    node korean-style-check.ts <파일> [<파일>...]
    node korean-style-check.ts --hook          PostToolUse 훅 모드 (stdin 으로 JSON, .md 만 검사)
`

export type Matcher = [string, (line: string) => RegExpExecArray | null]
export type MainOptions = { hookNotice?: string }

// ` + ` 양옆이 모두 코드 스팬이나 대문자 상수면 항목 이어 붙이기가 아니다.
function joinsItems(match: RegExpMatchArray): boolean {
  const left = match[1].replace(/^\(+/, '')
  const right = match[2]
  return ![left, right].every((side) => side.includes(CODE_PLACEHOLDER) || CONSTANT.test(side))
}

// 매핑 표의 경로를 정한다.
// 기본값은 이 스크립트 옆의 `../references/korean-style.md` 다.
// 절대경로를 박으면 스킬을 받은 팀원 환경에서 그 경로가 없어 검사가 통째로 건너뛰어진다.
// 심링크로 걸어 두고 부르는 것이 기본 사용법이라 실체까지 따라간 뒤 계산한다.
// 심링크가 놓인 디렉터리를 기준으로 삼으면 스킬 디렉터리를 착각한다.
export function rulesPath(): string {
  const override = process.env.KOREAN_STYLE_RULES
  if (override) return override
  return join(dirname(realpathSync(import.meta.dirname)), 'references', 'korean-style.md')
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// 매핑 표 첫 열에서 금지어를 뽑는다.
//
//     "기계가 / 기계로"    → 기계가, 기계로  (슬래시는 동의어 구분)
//     "폭주 (CPU 폭주 등)" → 폭주            (괄호 안은 용례 설명이라 제외)
//
// 둘째 열 이후는 읽지 않는다. 원어 열의 영어는 금지어가 아니다.
export function loadTerms(rules: string): string[] {
  const terms = new Set<string>()
  let inTable = false
  for (const line of pySplitLines(pyReadText(rules))) {
    if (line.startsWith(TABLE_HEADING)) {
      inTable = true
      continue
    }
    if (!inTable) continue
    if (SECTION_HEADING.test(line)) break
    if (!TABLE_ROW.test(line)) continue
    if (TABLE_RULE_ROW.test(line) || TABLE_HEADER_ROW.test(line)) continue
    const column = line.split('|')[1].replace(PARENTHESIZED, ' ')
    for (const part of column.split('/')) if (pyStrip(part)) terms.add(pyStrip(part))
  }
  return [...terms].sort(pyStrCompare)
}

// 금지어를 뽑고, 표 형태가 바뀌어 결과가 비면 stderr 로 알린다.
// 비었을 때 조용히 통과시키지 않는다.
// 검사기가 안 도는데 통과로 보이는 상황이 가장 위험하다.
function loadTermsOrComplain(rules: string): string[] {
  const terms = loadTerms(rules)
  if (terms.length === 0) write(2, `korean-style-check: ${rules} 에서 금지어를 추출하지 못했다 — 매핑 표 형식 확인 필요\n`)
  return terms
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 금지어마다 줄에서 찾는 방법을 정한다. 찾는 함수는 일치한 결과나 null 을 돌려준다.
//
// 영문 용어는 단어 경계로 찾는다. 부분 문자열로 찾으면 다른 낱말 안에서도 걸린다.
// 한국어는 조사가 붙어 「게이트를」 처럼 쓰이므로 부분 문자열로 찾는다.
// prefixes 로 시작하는 금지어는 앞 글자가 한글이 아닐 때만 찾는다.
// 일치 문자열(`[0]`)이 금지어 자신이 되도록 경계는 lookaround 로 쓴다.
export function buildMatchers(terms: string[], prefixes: readonly string[] = WORD_START_PREFIXES): Matcher[] {
  return terms.map((term) => {
    let source: string
    if (ENGLISH_TERM.test(term)) source = `(?<![A-Za-z-])${escapeRegExp(term)}(?![A-Za-z-])`
    else if (prefixes.some((prefix) => term.startsWith(prefix))) source = `(?<![가-힣])${escapeRegExp(term)}`
    else source = escapeRegExp(term)
    const pattern = new RegExp(source)
    return [term, (line: string) => pattern.exec(line)]
  })
}

// 원문 줄에서 걸린 글자의 열(1부터)을 돌려준다. 찾지 못하면 null 이다. 열은 코드 포인트로 센다.
//
// 걸린 글자는 코드 스팬과 링크 대상을 지운 줄에서 찾은 것이라, 원문에서는 코드 스팬 안의 같은 글자가
// 먼저 나올 수 있다. 코드 스팬을 같은 길이의 자리 표시자로 바꾼 줄에서 먼저 찾는다.
// DB 문맥 패턴처럼 일치 문자열이 코드 스팬을 품으면 원문에서 그대로 찾는다.
function locate(raw: string, text: string): number | null {
  const masked = raw.replace(CODE_SPAN, (span) => CODE_PLACEHOLDER.repeat(pyLen(span)))
  let index = masked.indexOf(text)
  if (index >= 0) return pyLen(masked.slice(0, index)) + 1
  index = raw.indexOf(text)
  return index >= 0 ? pyLen(raw.slice(0, index)) + 1 : null
}

// 발견 한 줄. 앞의 `경로:줄:` 은 check-diff 가 읽는 형식이라 그대로 둔다.
function describe(path: string, n: number, raw: string, term: string, match: RegExpExecArray, advice: string): string {
  const text = match[0]
  const column = locate(raw, text)
  const where = column ? `열 ${column}, ` : ''
  return `${path}:${n}: 금지어 "${term}" (${where}걸린 글자 "${text}") — ${advice}`
}

// 링크 대상의 닫는 `)` 위치를 돌려준다. 짝이 맞지 않으면 null 이다.
//
// `<...>` 로 감싼 URL 안의 괄호는 세지 않는다. 역슬래시로 이스케이프한 문자도 세지 않는다.
function findTargetEnd(target: string): number | null {
  let depth = 1
  let escaped = false
  let inAngle = target.startsWith('<')
  for (let i = 0; i < target.length; i++) {
    const ch = target[i]
    if (escaped) escaped = false
    else if (ch === '\\') escaped = true
    else if (inAngle) inAngle = ch !== '>'
    else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return null
}

// 마크다운 링크의 URL 만 지우고 문구는 남긴다.
//
// `](` 부터 짝이 맞는 `)` 까지를 잘라낸다.
// 정규식으로 `\([^)]*\)` 를 쓰면 `(경로(주석))` 처럼 괄호가 중첩된 URL 에서 먼저 끊긴다.
// 짝이 맞는 괄호를 찾지 못하면 남은 부분을 손대지 않고 그대로 둔다.
function stripLinkTargets(input: string): string {
  let line = input
  let kept = ''
  for (let mark = line.indexOf(']('); mark >= 0; mark = line.indexOf('](')) {
    kept += line.slice(0, mark + 1) // 문구와 닫는 `]` 까지 남긴다
    const target = line.slice(mark + 2)
    const end = findTargetEnd(target)
    if (end === null) return kept + line.slice(mark + 1)
    line = target.slice(end + 1)
  }
  return kept + line
}

// 검사 대상 파일에 적용할 예외 파일을 찾는다. 없으면 null.
//
// `KOREAN_CHECK_ALLOW` 가 있으면 그 경로만 본다. 없으면 대상 파일의 디렉터리에서 위로 올라가며
// `.claude/korean-check-allow.txt` 를 찾고, `.git` 이 있는 디렉터리까지만 본다.
// 저장소 밖의 파일이 다른 저장소의 예외를 가져다 쓰지 않게 하려는 경계다.
function findAllowFile(path: string): string | null {
  const override = process.env[ALLOW_ENV]
  if (override) return isFile(override) ? override : null
  let directory = dirname(realpathSync(path))
  for (;;) {
    const candidate = join(directory, ALLOW_FILE)
    if (isFile(candidate)) return candidate
    if (existsSync(join(directory, '.git'))) return null
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

const allowCache = new Map<string, string[]>()

// 예외 파일의 문자열 목록을 읽는다. 긴 것을 먼저 지우도록 길이 내림차순으로 낸다.
function loadAllow(path: string): string[] {
  const allowFile = findAllowFile(path)
  if (allowFile === null) return []
  if (!allowCache.has(allowFile)) {
    const entries = new Set<string>()
    for (const raw of pySplitLines(pyReadText(allowFile))) {
      const text = pyStrip(raw)
      if (!text || text.startsWith('#')) continue
      if (pyLen(text) < ALLOW_MIN_LENGTH) {
        write(2, `korean-style-check: ${allowFile}: 너무 짧아 읽지 않는다: ${pyRepr(text)}\n`)
        continue
      }
      entries.add(text)
    }
    // 길이는 코드 포인트 수다. 같은 길이는 먼저 들어온 차례를 지킨다
    allowCache.set(allowFile, [...entries].sort((a, b) => pyLen(b) - pyLen(a)))
  }
  return allowCache.get(allowFile) as string[]
}

// Python repr(str) 의 글자. 한 글자 항목만 찍으므로 작은따옴표와 역슬래시, 제어 문자만 다룬다
function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
  let out = ''
  for (const ch of text) {
    if (ch === '\\') out += '\\\\'
    else if (ch === quote) out += `\\${quote}`
    else out += ch
  }
  return `${quote}${out}${quote}`
}

// 한 파일을 검사해 (위반 줄 목록, 경고 줄 목록) 을 반환한다.
export function scan(path: string, matchers: Matcher[]): [string[], string[]] {
  const found: string[] = []
  const warnings: string[] = []
  let inFront = false
  let inFence = false

  const lines = pySplitLines(pyReadText(path))
  const allowed = [...COMPOUND_ALLOW, ...loadAllow(path)]

  lines.forEach((raw, index) => {
    const n = index + 1
    // YAML frontmatter 는 건너뛴다. description 은 트리거 예시를 담고,
    // triggers 는 검색 식별자라 금지어 자체가 값으로 들어가야 한다.
    if (n === 1 && FRONT_MATTER_MARK.test(raw)) {
      inFront = true
      return
    }
    if (inFront) {
      if (FRONT_MATTER_MARK.test(raw)) inFront = false
      return
    }

    // 코드 블록 펜스. 목록 안에 들여쓴 펜스도 토글해야 한다 —
    // 1열에 고정하면 들여쓴 블록의 내용이 본문으로 검사된다.
    if (FENCE.test(raw)) {
      inFence = !inFence
      return
    }
    if (inFence) return

    if (TABLE_LINE.test(raw) || LINK_DEFINITION.test(raw)) return

    let line = stripLinkTargets(raw) // 링크 문구는 남기고 URL 제외
    line = line.replace(AUTO_LINK, '') // 자동 링크 URL 제외
    let withSpans = line
    for (const name of allowed) withSpans = withSpans.replaceAll(name, '') // 저장소 예외 파일의 고유명사. DB 문맥 검사에도 같이 적용한다
    const plusLine = line.replace(CODE_SPAN, CODE_PLACEHOLDER) // + 판정은 코드 스팬 자리를 남긴다
    line = line.replace(CODE_SPAN, '') // 코드 스팬 제외
    for (const compound of allowed) line = line.replaceAll(compound, '') // 정당한 합성어와 저장소 예외 제외

    for (const [term, search] of matchers) {
      const match = search(line)
      if (match) found.push(describe(path, n, raw, term, match, 'korean-style 매핑 표의 권장 표현으로'))
    }
    for (const [term, pattern] of DB_CONTEXT_PATTERNS) {
      const match = pattern.exec(withSpans)
      if (match) found.push(describe(path, n, raw, term, match, 'DB 의 표는 테이블, 칸은 컬럼으로'))
    }
    if ([...plusLine.matchAll(INLINE_PLUS)].some(joinsItems)) warnings.push(`${path}:${n}: 경고: 인라인 + 연결 — 쉼표·와/과 또는 목록으로`)
  })

  return [found, warnings]
}

function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a, { bigint: true })
    const y = statSync(b, { bigint: true })
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

// 대상 파일들을 검사해 위반과 경고 줄을 출력하고 종료 코드를 반환한다.
//
// 검사는 끝까지 돌린다. 첫 파일에서 멈추면 나머지 위반이 안 보인다.
export function check(paths: string[], rules: string, matchers: Matcher[]): number {
  let status = 0
  for (const path of paths) {
    // 없는 경로를 건너뛰고 0 으로 끝내면 오타 난 경로가 통과로 보인다.
    if (!isFile(path)) {
      write(2, `korean-style-check: 파일이 없다: ${path}\n`)
      status = 2
      continue
    }
    // 명령행으로 직접 넘긴 파일은 확장자와 상관없이 검사한다. .md 한정은 --hook 모드에만 남는다.
    // 확장자로 건너뛰면 .txt 같은 파일이 금지어가 있어도 0 으로 끝난다 (실측).
    // 규칙 파일 자신은 건너뛴다 — 매핑 표가 곧 금지어 목록이라 전부 위반으로 잡힌다.
    if (isFile(rules) && sameFile(path, rules)) continue

    const [found, warnings] = scan(path, matchers)
    if (found.length || warnings.length) write(1, `${[...found, ...warnings].join('\n')}\n`)
    if (found.length) status = Math.max(status, 1)
  }
  return status
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

// PostToolUse 훅 모드의 판단. stdin 의 tool 입력 JSON 에서 편집된 파일 하나를 뽑아 검사하고,
// 위반이 있을 때만 모델 컨텍스트로 되돌릴 JSON 을 돌려준다. 없으면 null 이다. 작업을 막지 않는다.
// notice 가 있으면 additionalContext 맨 앞에 한 줄로 붙인다(옛 이름 진입의 안내).
export function runHook(input: string, rules: string, matchers: Matcher[], notice?: string): object | null {
  let payload: unknown
  try {
    payload = JSON.parse(input)
  } catch {
    return null
  }
  const top = record(payload)
  if (!top) return null
  const field = (section: string, key: string) => record(top[section])?.[key]
  const target = field('tool_input', 'file_path') || field('tool_response', 'filePath')
  if (typeof target !== 'string' || !target.endsWith('.md') || !isFile(target)) return null
  if (isFile(rules) && sameFile(target, rules)) return null

  const [found, warnings] = scan(target, matchers)
  if (!found.length && !warnings.length) return null

  const context = '한국어 표기 정책 점검 — 방금 편집한 파일에서 발견했다. 금지어는 지금 고치고, 경고는 문맥을 보고 판단한다.\n' + [...found, ...warnings].join('\n')
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notice ? `${notice}\n${context}` : context } }
}

// 명령 본체. stdout 과 stderr 에 직접 쓰고 종료 코드를 돌려준다. argv 는 명령 이름 뒤의 인자다.
export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const rules = rulesPath()
  if (!isFile(rules)) {
    write(2, `korean-style-check: 매핑 표를 찾지 못했다: ${rules}\n`)
    return 2
  }

  if (argv[0] === '--hook') {
    // 훅 모드는 늘 0 으로 끝난다. 편집을 막지 않고 결과만 알린다.
    // 금지어를 뽑지 못한 것도 stderr 로만 알리고 0 으로 끝낸다.
    const terms = loadTermsOrComplain(rules)
    if (!terms.length) return 0
    let input = ''
    try {
      input = readStdin()
    } catch {
      return 0
    }
    const output = runHook(input, rules, buildMatchers(terms), options.hookNotice)
    if (output) write(1, `${pyJson(output)}\n`)
    return 0
  }

  if (argv.length === 0) {
    write(2, USAGE)
    return 2
  }

  // 이 검사기는 --text 를 받지 않는다. check 가 임시 파일로 바꿔 넘긴다.
  // 그대로 두면 옵션이 파일 경로로 읽혀 금지어가 있어도 통과로 끝난다 (실측).
  const unknown = argv.filter((arg) => arg.startsWith('-'))
  if (unknown.length) {
    write(2, `korean-style-check: 다루지 않는 인자다: ${unknown.join(' ')}\n${USAGE}`)
    return 2
  }

  const terms = loadTermsOrComplain(rules)
  if (!terms.length) return 2
  return check(argv, rules, buildMatchers(terms))
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = await main(process.argv.slice(2))
