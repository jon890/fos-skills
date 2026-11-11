#!/usr/bin/env node
// report 스킬이 만든 HTML 보고서 한 파일이 깨지지 않았는지 검사한다.
//
// 브라우저는 깨진 HTML 도 말없이 그려 주므로 눈으로 봐서는 놓치는 것만 본다.
//
// 사용법:
//   node "$SKILL_DIR/scripts/check-report.ts" <파일.html>          검사한다
//   node "$SKILL_DIR/scripts/check-report.ts" --text <파일.html>   보이는 글만 한 덩어리에 한 줄씩 낸다
//   node "$SKILL_DIR/scripts/check-report.ts" --korean <파일.html> 보이는 글을 korean-check 의 check.ts 로 검사한다
//
// korean-check 의 검사기는 .md 만 받고, HTML 을 그대로 넘기면 태그로 시작하는 줄을 건너뛰어 금지어를 놓친다.
// 그래서 --korean 은 보이는 글을 임시 .md 로 써서 넘긴다. 줄 머리의 <, |, # 는 \ 를 붙여
// 표 행이나 제목으로 읽혀 검사에서 빠지지 않게 한다.
// 표기가 통과해도 의미 점검은 남는다. 성공 출력에 korean-check 의 점검 문서 경로를 알린다.
// korean-check 는 KOREAN_CHECK 환경 변수, 이 스킬의 형제 디렉터리, ~/.claude/skills/korean-check 순서로 찾는다.
// 플러그인 설치본은 저장소 전체를 복사하므로 형제 디렉터리에 있다.
//
// 검사 항목 (위반 줄 형식: <파일>:<줄>: <종류>: <설명>)
//   tag       닫히지 않은 태그, 짝이 맞지 않는 끝 태그, <html> 이 없는 파일. 끝 태그를 생략할 수 있는 요소도 닫아야 한다
//   external  밖에서 불러오는 script, CSS, 글꼴, 이미지 같은 자원. data: 와 # 만 허용한다.
//             CSS 주석 안의 url() 은 보지 않는다. 상대 경로도 다른 파일에 기대므로 막는다. 본문의 <a href="https://..."> 는 허용한다
//   ref       href="#x" 링크가 가리키는 id 가 없다
//   source    id 가 src- 로 시작하는 출처 항목을 가리키는 링크가 없다
//   id        같은 id 가 두 번 나온다
//   name      파일 이름이 영문 소문자, 숫자와 - 로 된 슬러그가 아니다
//
// HTML 해석: Node 에 내장 해석기가 없어 이 파일에 작은 해석기를 둔다. 옛 Python html.parser 와 같은 규칙으로
//   태그를 열고 닫고, script·style(과 title·textarea)의 안쪽은 끝 태그까지 글로 보고, 글과 속성 값의 문자 참조를 푼다.
//   이름 문자 참조는 entities.ts 의 HTML5 표(2231개)로 푼다.
//
// 종료 코드: 0 통과, 1 위반, 2 검사기가 돌지 못함 (인자가 틀렸거나 파일이 없음, --korean 에서 korean-check 를 못 찾음)

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HTML5 } from './entities.ts'
import { PY_SPACE, pyReadText } from './kit/py.ts'

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
// 태그별로 불러오는 자원을 가리키는 속성
const RESOURCE_ATTRS: Record<string, string[]> = {
  script: ['src'],
  link: ['href'],
  img: ['src', 'srcset'],
  iframe: ['src'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  audio: ['src'],
  embed: ['src'],
  object: ['data'],
  track: ['src'],
  image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'],
  base: ['href'],
  body: ['background'],
  table: ['background'],
  td: ['background'],
  th: ['background'],
}
const CSS_URL = /url\(\s*['"]?([^'")\s]*)/gi
const CSS_IMPORT = /@import\s+(?:url\(\s*)?['"]?([^'")\s;]*)/gi
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*\.html$/
// --text 에서 줄을 나누는 요소
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'li', 'main', 'nav', 'ol', 'p', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul', 'br',
])
const HIDDEN = new Set(['script', 'style', 'code', 'pre', 'template'])
// 안쪽을 태그로 읽지 않는 요소. script, style, xmp, iframe, noembed, noframes 는 원문 그대로, title, textarea 는 문자 참조만 푼다.
// plaintext 는 시작 태그 뒤 파일 끝까지가 원문이다
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes'])
const RCDATA = new Set(['title', 'textarea'])

const SPACE = new RegExp(PY_SPACE)
const SPACES = new RegExp(`${PY_SPACE}+`)
const isSpace = (ch: string | undefined) => ch !== undefined && SPACE.test(ch)
// 태그 안의 공백. 옛 html.parser 는 NBSP 같은 글자를 속성 값에 남긴다
const isTagSpace = (ch: string | undefined) => ch !== undefined && /[\t\n\r\f ]/.test(ch)

const USAGE = `사용법:
    check-report.ts <파일.html>          검사한다
    check-report.ts --text <파일.html>   보이는 글만 한 덩어리에 한 줄씩 낸다
    check-report.ts --korean <파일.html> 보이는 글을 korean-check 의 check.ts 로 검사한다
`

function write(fd: 1 | 2, text: string): void {
  let buf = Buffer.from(text)
  while (buf.length) {
    try {
      buf = buf.subarray(writeSync(fd, buf))
    } catch (error) {
      // 파이프가 가득 찼다. 비워질 때까지 다시 쓴다
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
    }
  }
}

// ── 문자 참조 ──

const CP1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178]

function invalidCodepoint(num: number): boolean {
  return (num >= 0x1 && num <= 0x8) || num === 0xb || (num >= 0xe && num <= 0x1f) || (num >= 0x7f && num <= 0x9f) || (num >= 0xfdd0 && num <= 0xfdef) || (num & 0xfffe) === 0xfffe
}

// html.unescape. 숫자 참조와 HTML5 이름 참조를 푼다. 이름은 정확히 맞는 것을 먼저, 없으면 가장 긴 앞부분(;없는 옛 이름)을 푼다
export function unescape(text: string): string {
  return text.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g, (all, s: string) => {
    if (s[0] === '#') {
      const num = s[1] === 'x' || s[1] === 'X' ? Number.parseInt(s.slice(2).replace(/;$/, ''), 16) : Number.parseInt(s.slice(1).replace(/;$/, ''), 10)
      if (num === 0) return '\ufffd'
      if (num === 0x0d) return '\r'
      if (num >= 0x80 && num <= 0x9f) return String.fromCodePoint(CP1252[num - 0x80])
      if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return '\ufffd'
      if (invalidCodepoint(num)) return ''
      return String.fromCodePoint(num)
    }
    if (Object.hasOwn(HTML5, s)) return HTML5[s]
    for (let x = s.length - 1; x > 1; x--) {
      const prefix = s.slice(0, x)
      if (Object.hasOwn(HTML5, prefix)) return HTML5[prefix] + s.slice(x)
    }
    return all
  })
}

// ── HTML 해석기 ──

type Attrs = [string, string | null][]
export type Handlers = {
  start(tag: string, attrs: Attrs, line: number): void
  startend(tag: string, attrs: Attrs, line: number): void
  end(tag: string, line: number): void
  data(text: string, line: number): void
}

// 시작 태그의 속성을 읽는다. 끝 `>` 의 위치와 자체 닫힘 여부를 낸다. 끝을 못 찾으면 null 이다
function readStartTag(text: string, from: number): { tag: string; attrs: Attrs; end: number; selfClosing: boolean } | null {
  const n = text.length
  let i = from + 1
  const nameStart = i
  while (i < n && !/[\t\n\r\f />\0]/.test(text[i])) i++
  const tag = text.slice(nameStart, i).toLowerCase()
  const attrs: Attrs = []
  for (;;) {
    while (i < n && (isTagSpace(text[i]) || (text[i] === '/' && text[i + 1] !== '>'))) i++
    if (i >= n) return null
    if (text[i] === '>') return { tag, attrs, end: i + 1, selfClosing: false }
    if (text[i] === '/') return { tag, attrs, end: i + 2, selfClosing: true }
    const attrStart = i
    i++
    while (i < n && !isTagSpace(text[i]) && !'/=>'.includes(text[i])) i++
    const name = text.slice(attrStart, i).toLowerCase()
    let j = i
    while (j < n && isTagSpace(text[j])) j++
    let value: string | null = null
    if (text[j] === '=') {
      while (text[j] === '=') j++
      while (j < n && isTagSpace(text[j])) j++
      if (text[j] === '"' || text[j] === "'") {
        const close = text.indexOf(text[j], j + 1)
        if (close < 0) return null
        value = unescape(text.slice(j + 1, close))
        i = close + 1
      } else {
        const valueStart = j
        while (j < n && text[j] !== '>' && !isTagSpace(text[j])) j++
        value = unescape(text.slice(valueStart, j))
        i = j
      }
    }
    attrs.push([name, value])
  }
}

export function parseHtml(text: string, handlers: Handlers): void {
  const n = text.length
  // 줄 번호는 그 위치 앞의 줄바꿈 수 + 1 이다. 위치는 앞에서 뒤로만 가므로 센 자리부터 이어 센다
  let countedTo = 0
  let line = 1
  const lineAt = (index: number) => {
    for (; countedTo < index; countedTo++) if (text[countedTo] === '\n') line++
    return line
  }
  let i = 0
  let raw: string | null = null
  let rawKind: 'raw' | 'rcdata' = 'raw'
  while (i < n) {
    if (raw !== null) {
      const close = new RegExp(`</${raw}(?=[\\t\\n\\r\\f />])`, 'i').exec(text.slice(i))
      const stop = close ? i + close.index : n
      if (stop > i) {
        const chunk = text.slice(i, stop)
        handlers.data(rawKind === 'rcdata' ? unescape(chunk) : chunk, lineAt(i))
      }
      i = stop
      if (!close) break
      const gt = text.indexOf('>', i)
      if (gt < 0) break
      handlers.end(raw, lineAt(i))
      raw = null
      i = gt + 1
      continue
    }
    const lt = text.indexOf('<', i)
    const stop = lt < 0 ? n : lt
    if (stop > i) handlers.data(unescape(text.slice(i, stop)), lineAt(i))
    i = stop
    if (i >= n) break
    const next = text[i + 1]
    if (next !== undefined && /[a-zA-Z]/.test(next)) {
      const parsed = readStartTag(text, i)
      if (!parsed) break
      const at = lineAt(i)
      if (parsed.selfClosing) {
        handlers.startend(parsed.tag, parsed.attrs, at)
      } else {
        handlers.start(parsed.tag, parsed.attrs, at)
        if (parsed.tag === 'plaintext') {
          if (parsed.end < n) handlers.data(text.slice(parsed.end), lineAt(parsed.end))
          break
        }
        if (RAW_TEXT.has(parsed.tag) || RCDATA.has(parsed.tag)) {
          raw = parsed.tag
          rawKind = RAW_TEXT.has(parsed.tag) ? 'raw' : 'rcdata'
        }
      }
      i = parsed.end
    } else if (next === '/') {
      const gt = text.indexOf('>', i)
      if (gt < 0) {
        // 끝에서 잘린 `</` 는 글이고, `</p` 처럼 글자가 이어지면 버린다
        if (i + 2 === n) handlers.data('</', lineAt(i))
        break
      }
      const named = /^<\/([a-zA-Z][^\t\n\r\f />\0]*)/.exec(text.slice(i, gt + 1))
      // `</` 뒤에 글자가 없으면 주석처럼 읽어 건너뛴다
      if (named) handlers.end(named[1].toLowerCase(), lineAt(i))
      i = gt + 1
    } else if (text.startsWith('<!--', i)) {
      // 닫는 꼴은 `-->` 와 `--!>` 다. 뒤에 그런 꼴이 없을 때만 `<!-->`, `<!--->` 가 빈 주석으로 닫힌다
      const close = /--!?>/.exec(text.slice(i + 4))
      if (close) i = i + 4 + close.index + close[0].length
      else if (text[i + 4] === '>') i += 5
      else if (text.startsWith('->', i + 4)) i += 6
      else i = n
    } else if (text.startsWith('<![CDATA[', i)) {
      const close = text.indexOf(']]>', i + 9)
      if (close < 0) break
      i = close + 3
    } else if (next === '!' || next === '?') {
      const gt = text.indexOf('>', i)
      if (gt < 0) break
      i = gt + 1
    } else {
      handlers.data('<', lineAt(i))
      i += 1
    }
  }
}

// ── 검사 ──

type Problem = [number, string, string]
const allowed = (url: string) => {
  const trimmed = url.replace(new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'g'), '')
  return trimmed === '' || trimmed.startsWith('data:') || trimmed.startsWith('#')
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

class Checker {
  stack: [string, number][] = []
  problems: Problem[] = []
  ids = new Map<string, number>()
  links: [string, number][] = []
  inStyle = false

  add(kind: string, msg: string, line: number): void {
    this.problems.push([line, kind, msg])
  }

  checkCss(css: string, line: number): void {
    const stripped = css.replace(CSS_COMMENT, '')
    for (const pattern of [CSS_URL, CSS_IMPORT]) {
      for (const m of stripped.matchAll(pattern)) {
        if (!allowed(m[1])) this.add('external', `CSS 가 밖의 자원을 불러온다: ${m[1]}`, line)
      }
    }
  }

  attrs(tag: string, attrs: Attrs, line: number): void {
    const a = new Map<string, string>()
    for (const [key, value] of attrs) a.set(key, value ?? '')
    let names = RESOURCE_ATTRS[tag] ?? []
    if (tag === 'input' && (a.get('type') ?? '').toLowerCase() === 'image') names = ['src']
    if (tag === 'meta' && (a.get('http-equiv') ?? '').toLowerCase() === 'refresh' && (a.get('content') ?? '').toLowerCase().includes('url=')) {
      this.add('external', '<meta http-equiv=refresh> 가 다른 주소로 넘긴다', line)
    }
    for (const name of names) {
      const value = a.get(name)
      if (value === undefined) continue
      const urls = name === 'srcset' ? value.split(',').map((part) => part.replace(new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'g'), '').split(' ')[0]) : [value]
      for (const url of urls) {
        if (!allowed(url)) this.add('external', `<${tag} ${name}> 가 밖의 자원을 불러온다: ${url}`, line)
      }
    }
    if (a.has('style')) this.checkCss(a.get('style') as string, line)
    if (a.has('id')) {
      const id = a.get('id') as string
      if (this.ids.has(id)) this.add('id', `id "${id}" 가 ${this.ids.get(id)}줄에도 있다`, line)
      else this.ids.set(id, line)
    }
    const href = a.get('href') ?? ''
    if (tag === 'a' && href.startsWith('#') && href.length > 1) this.links.push([href.slice(1), line])
  }

  start(tag: string, attrs: Attrs, line: number): void {
    this.attrs(tag, attrs, line)
    if (!VOID.has(tag)) this.stack.push([tag, line])
    if (tag === 'style') this.inStyle = true
  }

  startend(tag: string, attrs: Attrs, line: number): void {
    this.attrs(tag, attrs, line)
  }

  end(tag: string, line: number): void {
    if (tag === 'style') this.inStyle = false
    if (VOID.has(tag)) return
    if (!this.stack.length) {
      this.add('tag', `여는 태그 없이 </${tag}> 가 나온다`, line)
      return
    }
    if (this.stack.at(-1)![0] === tag) {
      this.stack.pop()
      return
    }
    if (this.stack.some(([t]) => t === tag)) {
      // 사이에 닫히지 않은 태그를 모두 보고하고 짝을 맞춘다
      while (this.stack.at(-1)![0] !== tag) {
        const [t, opened] = this.stack.pop()!
        this.add('tag', `<${t}> 가 닫히지 않고 </${tag}> 를 만났다`, opened)
      }
      this.stack.pop()
    } else {
      this.add('tag', `여는 태그 없이 </${tag}> 가 나온다`, line)
    }
  }

  data(text: string, line: number): void {
    if (this.inStyle) this.checkCss(text, line)
  }

  finish(): Problem[] {
    for (const [t, opened] of this.stack) this.add('tag', `<${t}> 가 닫히지 않았다`, opened)
    const targets = new Set(this.links.map(([target]) => target))
    for (const [target, line] of this.links) {
      if (!this.ids.has(target)) this.add('ref', `#${target} 를 가리키지만 그 id 가 없다`, line)
    }
    for (const [ident, line] of this.ids) {
      if (ident.startsWith('src-') && !targets.has(ident)) this.add('source', `출처 ${ident} 를 가리키는 본문 링크가 없다`, line)
    }
    return this.problems.sort((a, b) => a[0] - b[0] || compare(a[1], b[1]) || compare(a[2], b[2]))
  }
}

class TextExtractor {
  hidden = 0
  lines: string[] = []
  buf: string[] = []

  flush(): void {
    const text = this.buf.join('').split(SPACES).filter(Boolean).join(' ')
    if (text) this.lines.push(text)
    this.buf = []
  }

  start(tag: string): void {
    if (HIDDEN.has(tag)) this.hidden += 1
    else if (BLOCK.has(tag)) this.flush()
  }

  end(tag: string): void {
    if (HIDDEN.has(tag)) this.hidden = Math.max(0, this.hidden - 1)
    else if (BLOCK.has(tag)) this.flush()
  }

  data(text: string): void {
    if (!this.hidden) this.buf.push(text)
  }
}

export function check(path: string, body: string): Problem[] {
  const checker = new Checker()
  parseHtml(body, {
    start: (tag, attrs, line) => checker.start(tag, attrs, line),
    startend: (tag, attrs, line) => checker.startend(tag, attrs, line),
    end: (tag, line) => checker.end(tag, line),
    data: (text, line) => checker.data(text, line),
  })
  const problems = checker.finish()
  if (!body.toLowerCase().includes('<html')) problems.unshift([1, 'tag', '<html> 요소가 없다. 틀을 복사해 채운 보고서가 아니다'])
  if (!SLUG.test(basename(path))) problems.unshift([1, 'name', `파일 이름 ${basename(path)} 이 슬러그(영문 소문자, 숫자, -)가 아니다`])
  return problems
}

export function extractText(body: string): string[] {
  const extractor = new TextExtractor()
  parseHtml(body, {
    // 자체 닫는 태그는 여는 태그와 닫는 태그를 차례로 받은 것으로 본다
    start: (tag) => extractor.start(tag),
    startend: (tag) => (extractor.start(tag), extractor.end(tag)),
    end: (tag) => extractor.end(tag),
    data: (text) => extractor.data(text),
  })
  extractor.flush()
  return extractor.lines
}

// 줄 머리가 마크다운의 표 행, 제목, HTML 로 읽혀 korean-check 가 건너뛰지 않게 한다.
export function mdSafe(line: string): string {
  return '<|#'.includes(line.slice(0, 1)) && line !== '' ? `\\${line}` : line
}

function findKoreanCheck(): string | null {
  const here = resolve(import.meta.dirname, '..')
  for (const base of [process.env.KOREAN_CHECK ?? '', join(here, '..', 'korean-check'), join(here, '..', '..', 'export-only-skills', 'korean-check'), join(homedir(), '.claude', 'skills', 'korean-check')]) {
    const script = join(base, 'scripts', 'check.ts')
    if (base && existsSync(script) && statSync(script).isFile()) return script
  }
  return null
}

function korean(path: string, shown: string): number {
  const checkTs = findKoreanCheck()
  if (!checkTs) {
    write(2, 'check-report: korean-check 를 찾지 못했다. KOREAN_CHECK 로 그 스킬 경로를 준다\n')
    return 2
  }
  const dir = mkdtempSync(join(tmpdir(), 'check-report-'))
  try {
    const stem = basename(path).replace(/(?<=.)\.[^.]*$/, '')
    const md = join(dir, `${stem}.md`)
    writeFileSync(md, `${extractText(pyReadText(path)).map(mdSafe).join('\n')}\n`)
    const result = spawnSync(process.execPath, [checkTs, md], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    // 임시 파일 이름 대신 보고서 이름으로 알린다. 줄 번호는 --text 출력의 줄이다
    write(1, (result.stdout ?? '').replaceAll(md, `${shown} (--text 줄)`))
    write(2, result.stderr ?? '')
    if (result.status === 0) write(1, '다음 단계: korean-check 의 references/review-axes.md 로 의미를 직접 점검한다.\n')
    return result.status ?? 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// pathlib.Path 로 쓴 경로의 글자. 앞의 ./ 와 겹친 /, 끝의 / 를 정리한다
function pyPath(path: string): string {
  const parts = path.split('/').filter((part) => part !== '' && part !== '.')
  return (path.startsWith('/') ? '/' : '') + (parts.join('/') || (path.startsWith('/') ? '' : '.'))
}

export function main(argv: string[]): number {
  const mode = argv[0] === '--text' || argv[0] === '--korean' ? argv[0] : ''
  const args = mode ? argv.slice(1) : argv
  if (args.length !== 1 || args[0].startsWith('-')) {
    write(2, USAGE)
    return 2
  }
  const shown = pyPath(args[0])
  if (!existsSync(args[0]) || !statSync(args[0]).isFile()) {
    write(2, `check-report: 파일이 없다: ${shown}\n`)
    return 2
  }
  if (mode === '--text') {
    for (const line of extractText(pyReadText(args[0]))) write(1, `${mdSafe(line)}\n`)
    return 0
  }
  if (mode === '--korean') return korean(args[0], shown)
  const problems = check(args[0], pyReadText(args[0]))
  for (const [line, kind, msg] of problems) write(1, `${shown}:${line}: ${kind}: ${msg}\n`)
  if (problems.length) {
    write(1, `위반 ${problems.length}건\n`)
    return 1
  }
  write(1, `통과: ${shown}\n`)
  return 0
}

// 심볼릭 링크로 불리면 argv[1] 은 링크 경로이고 import.meta.url 은 실체 경로라 둘 다 실체로 바꿔 비교한다
function entryIsThisFile(): boolean {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
const isMain = import.meta.main || entryIsThisFile()
if (isMain) process.exitCode = main(process.argv.slice(2))
