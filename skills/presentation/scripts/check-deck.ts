#!/usr/bin/env node
// 덱 HTML 한 파일의 구조를 검사한다.
//
// 눈으로 훑어서는 놓치는 것만 본다. 장 수와 주석 번호, 활성 장 개수,
// JS 문법, 이전에 남은 하드코딩 값, 노트 누락, 금지어다.
// 금지어의 단일 소스는 korean-check 스킬의 korean-style.md 「어색한 말 매핑 표」 다.
// 세로 넘침은 렌더링해야 알 수 있으므로 --browser 로 따로 잰다.
//
// 사용법: node "$SKILL_DIR/scripts/check-deck.ts" <deck.html> [--browser]
//
// 종료 코드: 0 통과, 1 위반, 2 검사기가 돌지 못함

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { isMain, write } from './io.ts'

// 발표 고유 금지어. 전역 매핑 표에 없고 덱에서만 문제가 되는 것만 둔다.
const DECK_BANNED = ['굳혔다', '굳혀', '띄울 곳', '확인할 방법이 없', '당연히 된다', '정직하게', '솔직히 말하면']

// 전역 금지어의 단일 소스는 korean-check 스킬의 「어색한 말 매핑 표」 다.
// 표를 읽는 규칙과 매칭 규칙(한글 조사, 영문 단어 경계, 낱말 시작 예외)도 그 스킬 검사기가 소유한다.
// 사본을 두지 않는다. 사본은 원본과 갈라지고, 실제로 갈라졌다.
// 그 검사기를 자식 프로세스로 부른다(스킬은 다른 스킬 폴더를 import 하지 않는다).
// 팀 배치의 형제 korean-check 또는 이 저장소의 내보내기 전용 원본을 쓴다.
// 다른 위치에 있으면 KOREAN_CHECK_DIR 로 그 스킬 디렉터리를 준다.
const SKILL = resolve(import.meta.dirname, '..')
const PARENT = resolve(SKILL, '..')
const ROOT = ['skills', 'export-only-skills'].includes(basename(PARENT)) ? resolve(PARENT, '..') : PARENT
const SIBLING_CHECK = join(PARENT, 'korean-check')
const expandUser = (path: string) => (path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path)
const KOREAN_CHECK = expandUser(process.env.KOREAN_CHECK_DIR ?? (existsSync(SIBLING_CHECK) && statSync(SIBLING_CHECK).isDirectory() ? SIBLING_CHECK : join(ROOT, 'export-only-skills', 'korean-check')))
const RULES = join(KOREAN_CHECK, 'references', 'korean-style.md')
const STYLE_CHECKERS: [string, string[]][] = [
  [join(KOREAN_CHECK, 'scripts', 'korean-style-check.ts'), [process.execPath]],
]

const isFile = (path: string) => existsSync(path) && statSync(path).isFile()
const head = (text: string, n: number) => Array.from(text).slice(0, n).join('')
// Python str.strip() 이 공백으로 보는 글자
const SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const STRIP = new RegExp(`^${SPACE}+|${SPACE}+$`, 'g')
const strip = (text: string) => text.replace(STRIP, '')
const LINES = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/
const splitLines = (text: string) => {
  const parts = text.split(LINES)
  if (parts.at(-1) === '') parts.pop()
  return parts
}

// Python repr(str) 의 글자. 작은따옴표를 우선하고, 출력할 수 없는 글자(제어·서식·공백류 글자)는 이스케이프한다
export function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) as number
    if (ch === '\\') out += '\\\\'
    else if (ch === quote) out += `\\${quote}`
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (ch !== ' ' && /[\p{C}\p{Z}]/u.test(ch)) {
      out += code < 0x100 ? `\\x${code.toString(16).padStart(2, '0')}` : code < 0x10000 ? `\\u${code.toString(16).padStart(4, '0')}` : `\\U${code.toString(16).padStart(8, '0')}`
    } else out += ch
  }
  return `${quote}${out}${quote}`
}

// korean-check 검사기가 보는 전역 금지어를 덱의 산문에서 찾는다. 낱말을 처음 나온 차례로 낸다.
// 검사기가 없으면 null 이다. 매핑 표에서 금지어를 뽑지 못해 검사기가 돌지 못하면 오류를 던진다.
function globalBanned(prose: string): string[] | null {
  const checker = STYLE_CHECKERS.find(([path]) => isFile(path))
  if (!isFile(RULES) || !checker) return null
  const dir = mkdtempSync(join(tmpdir(), 'check-deck-'))
  try {
    const md = join(dir, 'prose.md')
    // 줄마다 역슬래시를 붙여 표 행, 펜스, 제목, 링크 정의로 읽혀 검사에서 빠지지 않게 한다
    writeFileSync(md, `${splitLines(prose).map((line) => `\\${line}`).join('\n')}\n`)
    const done = spawnSync(checker[1][0], [...checker[1].slice(1), checker[0], md], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, KOREAN_STYLE_RULES: RULES } })
    if (done.status !== 0 && done.status !== 1) throw new Error(`매핑 표에서 금지어를 추출하지 못했다: ${RULES}`)
    const terms: string[] = []
    for (const line of splitLines(done.stdout ?? '')) {
      const m = /금지어 "(.*)" \(열 \d+/.exec(line)
      if (m && !terms.includes(m[1])) terms.push(m[1])
    }
    return terms
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 파일을 UTF-8 로 읽고 줄바꿈을 \n 으로 바꾼다. UTF-8 이 아니면 옛 명령처럼 오류로 멈춘다
function readText(path: string): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)).replace(/\r\n?/g, '\n')
}

const WORD = '[\\p{L}\\p{N}_]'

export function main(argv: string[]): number {
  const args = argv.filter((a) => !a.startsWith('--'))
  const useBrowser = argv.includes('--browser')
  if (!args.length) {
    write(2, '사용법: check-deck.ts <deck.html> [--browser]\n')
    return 2
  }
  const path = args[0]
  if (!isFile(path)) {
    write(2, `파일이 없다: ${path}\n`)
    return 2
  }
  const src = readText(path)

  const bad: string[] = []
  const note: string[] = []

  // 속성 순서를 고정하지 않는다. data-title 이 먼저 오면 장이 0개로 세어져
  // "장 주석 개수가 다르다" 라는 엉뚱한 지적으로 나온다.
  const sectionTag = new RegExp(`<section(?!${WORD})[^>]*(?<!${WORD})class="slide[^"]*"[^>]*>`, 'gu')
  const tags = src.match(sectionTag) ?? []
  const sections: string[] = []
  for (const tag of tags) {
    const m = /data-title="([^"]*)"/.exec(tag)
    if (m) sections.push(m[1])
  }
  if (tags.length !== sections.length) bad.push(`data-title 이 없는 장이 ${tags.length - sections.length}개다`)
  const comments = [...src.matchAll(/(?<![^\n])<!-- (\p{Nd}{2}) -->/gu)].map((m) => m[1])
  note.push(`장 ${sections.length}개`)

  if (comments.length !== sections.length) {
    bad.push(`장 주석 ${comments.length}개와 section ${sections.length}개가 다르다`)
  } else {
    const want = comments.map((_, n) => String(n + 1).padStart(2, '0'))
    const first = comments.findIndex((c, i) => c !== want[i])
    if (first >= 0) bad.push(`장 주석 번호가 어긋난다: ${first + 1}번째가 <!-- ${comments[first]} -->`)
  }

  const nActive = (src.match(new RegExp(`class="slide[^"]*(?<!${WORD})active(?!${WORD})`, 'gu')) ?? []).length
  if (nActive !== 1) bad.push(`active 장이 ${nActive}개다. 정확히 1개여야 한다`)

  const emptyTitles = sections.flatMap((t, i) => (strip(t) === '' ? [i + 1] : []))
  if (emptyTitles.length) bad.push(`data-title 이 빈 장: [${emptyTitles.join(', ')}]`)

  const nNote = src.split('<template class="note">').length - 1
  if (nNote !== sections.length) bad.push(`노트가 ${nNote}개, 장이 ${sections.length}개다. 장마다 노트가 있어야 한다`)

  // 이전 버전에서 남은 하드코딩 값. JS 가 매번 채우므로 파일에 값이 남으면 낡은 것이다.
  for (const [elId, label] of [['pageno', '쪽 표시'], ['ovgrid', '개요 버튼'], ['sv-body', '스크립트 패널']]) {
    const m = new RegExp(`id="${elId}"[^>]*>([\\s\\S]*?)</`).exec(src)
    if (m && strip(m[1])) bad.push(`${label}(${elId}) 에 옛 내용이 박혀 있다: ${pyRepr(head(m[1], 40))}`)
  }

  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  if (scripts.length !== 1) {
    bad.push(`<script> 블록이 ${scripts.length}개다. 1개여야 한다`)
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'check-deck-'))
    try {
      const tmp = join(dir, 'deck.js')
      writeFileSync(tmp, scripts[0])
      const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
      if (r.status !== 0) bad.push(`JS 문법 오류: ${splitLines(strip(r.stderr ?? ''))[0]}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 산문만 남긴다. 전역 검사기가 코드 블록과 코드 스팬을 빼는 것과 같은 이유다.
  // style 과 script 는 코드라 CSS 의 baseline·clamp 이 금지어로 걸린다 (실측).
  let prose = src.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  prose = prose.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  prose = prose.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, '')
  let terms: string[] | null
  try {
    terms = globalBanned(prose)
  } catch (error) {
    write(2, `${(error as Error).message}\n`)
    return 2
  }
  if (terms === null) {
    note.push(`${KOREAN_CHECK} 가 없어 전역 금지어를 못 봤다`)
    terms = []
  }
  for (const term of terms) bad.push(`금지어: ${term}`)
  for (const w of DECK_BANNED) if (prose.includes(w)) bad.push(`금지어: ${w}`)

  for (const line of note) write(1, `· ${line}\n`)
  if (useBrowser) bad.push(...browserOverflow(path))
  if (bad.length) {
    write(1, '\n')
    for (const line of bad) write(1, `✗ ${line}\n`)
    return 1
  }
  write(1, '통과\n')
  return 0
}

// 이 저장소의 tools/browser-driver 를 먼저 찾고, 없으면 개인이 걸어 둔 것으로 내려간다.
function findDriver(): string | null {
  for (const candidate of [join(ROOT, 'tools', 'browser-driver', 'browser_driver.py'), expandUser('~/.claude/scripts/browser-driver')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function drive(driver: string, args: string[], seconds: number): { status: number | null; stdout: string; stderr: string } {
  const done = spawnSync(driver, args, { encoding: 'utf8', timeout: seconds * 1000, maxBuffer: 64 * 1024 * 1024 })
  if (done.error) {
    const code = (done.error as NodeJS.ErrnoException).code
    throw new Error(code === 'ETIMEDOUT' ? `Command '[${[driver, ...args].map(pyRepr).join(', ')}]' timed out after ${seconds} seconds` : done.error.message)
  }
  return { status: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
}

// 세로 넘침을 잰다.
//
// 드라이버가 아예 없는 것과 있는데 실패한 것을 구분한다.
// 없으면 건너뛰고, 실패는 위반으로 낸다. `--browser` 통과 여부가 판정 기준인데
// 실패를 통과로 끝내면 종료 코드로 둘을 구분할 수 없다.
function browserOverflow(path: string): string[] {
  const driver = findDriver()
  if (!driver) {
    write(1, '· browser-driver 가 없어 넘침을 못 봤다\n')
    return []
  }
  const url = `file://${resolve(path)}`
  let handle = ''
  try {
    const page = drive(driver, ['open', url, '20000'], 90)
    const lines = splitLines(strip(page.stdout))
    if (page.status !== 0 || !lines.length) return [`브라우저 검사: 탭을 열지 못했다 ${head(strip(page.stderr), 80)}`]
    handle = lines.at(-1) as string
    const js =
      'var r=[];var ss=document.querySelectorAll("section.slide");' +
      'for(var k=0;k<ss.length;k++){var s=ss[k];var w=s.classList.contains("active");' +
      's.style.display="flex";var o=s.scrollHeight-s.clientHeight;' +
      'if(o>2)r.push((k+1)+" "+s.dataset.title+" +"+o+"px");' +
      'if(!w)s.style.display="";}r.join(" | ")'
    const out = drive(driver, ['js', handle, js], 90)
    if (out.status !== 0) return [`브라우저 검사: 측정에 실패했다 ${head(strip(out.stderr), 80)}`]
    const found = strip(out.stdout)
    if (found) return [`세로 넘침: ${found}`]
    write(1, '· 세로 넘침 없음\n')
    return []
  } catch (error) {
    return [`브라우저 검사가 돌지 못했다: ${(error as Error).message}`]
  } finally {
    // 예외로 빠져나가도 탭을 남기지 않는다.
    if (handle) {
      try {
        drive(driver, ['close', handle], 30)
      } catch {
        // 닫기 실패는 알릴 수 없다. 결과는 이미 정해졌다
      }
    }
  }
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
