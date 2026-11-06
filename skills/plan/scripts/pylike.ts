// 옛 Python 구현이 표준 라이브러리로 하던 일 가운데 이 폴더의 명령이 쓰는 것만 옮겼다.
// 같은 입력에 같은 결과를 내는 것이 목적이라 이름과 순서를 원본(shlex, fnmatch, pathlib, posixpath, urllib.parse)에 맞췄다.
//
//     shlexSplit       shlex.shlex(line, posix=True, punctuation_chars=";&|()") + whitespace_split. 닫히지 않은 따옴표와 끝의 역슬래시는 던진다
//     fnmatchcase      fnmatch.fnmatchcase. `*` 는 `/` 도 넘는다
//     globRel          Path.glob. 저장소 상대 경로(POSIX 꼴)를 낸다. `**` 는 디렉터리를 재귀하고 마지막이면 파일도 낸다
//     pyPath           str(Path(s)). `.` 조각과 겹친 `/` 를 줄이고 `..` 는 남긴다
//     pathName, pathStem, pathSuffix, pathParts, pathParent   Path 의 name, stem, suffix, parts, parent
//     posixJoin, posixNormpath   posixpath.join, posixpath.normpath
//     pyResolve        Path.resolve(). 없는 뒷부분은 그대로 붙인다
//     pyRepr, pyStrAny repr(), str(). JSON 에서 읽은 값에 쓴다
//     urlsplitPath     urllib.parse.urlsplit 의 scheme, netloc, path
//     unquote          urllib.parse.unquote
//     lstripPy, stripChars   str.lstrip(), str.strip(chars)

import { type Dirent, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { PY_SPACE } from './kit/py.ts'

const SPACE_AT_START = new RegExp(`^${PY_SPACE}+`)

export function lstripPy(text: string): string {
  return text.replace(SPACE_AT_START, '')
}

export function stripChars(text: string, chars: string): string {
  let start = 0
  let end = text.length
  while (start < end && chars.includes(text[start])) start++
  while (end > start && chars.includes(text[end - 1])) end--
  return text.slice(start, end)
}

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// shlex

const WHITESPACE = ' \t\r\n'
const PUNCTUATION = ';&|()'
const QUOTES = '\'"'

// 한 줄을 낱말로 나눈다. 따옴표 안 낱말과 이어 붙인 낱말, `#` 주석, 연달아 붙은 `;&|()` 를 shlex 처럼 읽는다
export function shlexSplit(line: string): string[] {
  const tokens: string[] = []
  let pos = 0
  let pushback: string | null = null
  let state: string | null = ' '
  let token = ''
  let quoted = false
  let escapedState = ' '
  const next = (): string => {
    if (pushback !== null) {
      const ch = pushback
      pushback = null
      return ch
    }
    return pos < line.length ? line[pos++] : ''
  }
  for (;;) {
    const ch = next()
    let emit = false
    if (state === null) {
      token = ''
      emit = true
    } else if (state === ' ') {
      if (ch === '') {
        state = null
        emit = true
      } else if (WHITESPACE.includes(ch)) {
        if (token || quoted) emit = true
      } else if (ch === '#') {
        pos = line.length
      } else if (ch === '\\') {
        escapedState = 'a'
        state = ch
      } else if (PUNCTUATION.includes(ch)) {
        token = ch
        state = 'c'
      } else if (QUOTES.includes(ch)) {
        state = ch
      } else {
        token = ch
        state = 'a'
      }
    } else if (QUOTES.includes(state)) {
      quoted = true
      if (ch === '') throw new Error('No closing quotation')
      if (ch === state) state = 'a'
      else if (ch === '\\' && state === '"') {
        escapedState = state
        state = ch
      } else token += ch
    } else if (state === '\\') {
      if (ch === '') throw new Error('No escaped character')
      // posix 셸에서는 따옴표 안에서 그 따옴표와 역슬래시만 이스케이프한다
      if (QUOTES.includes(escapedState) && ch !== state && ch !== escapedState) token += state
      token += ch
      state = escapedState
    } else {
      // 'a' 낱말 안, 'c' 연달은 구두점 안
      if (ch === '') {
        state = null
        emit = true
      } else if (WHITESPACE.includes(ch)) {
        state = ' '
        if (token || quoted) emit = true
      } else if (ch === '#') {
        pos = line.length
        state = ' '
        if (token || quoted) emit = true
      } else if (state === 'c') {
        if (PUNCTUATION.includes(ch)) token += ch
        else {
          if (!WHITESPACE.includes(ch)) pushback = ch
          state = ' '
          emit = true
        }
      } else if (QUOTES.includes(ch)) {
        state = ch
      } else if (ch === '\\') {
        escapedState = 'a'
        state = ch
      } else if (!PUNCTUATION.includes(ch)) {
        token += ch
      } else {
        pushback = ch
        state = ' '
        if (token || quoted) emit = true
      }
    }
    if (!emit) continue
    const result = token
    token = ''
    const wasQuoted = quoted
    quoted = false
    if (state === null && result === '' && !wasQuoted) return tokens
    if (!wasQuoted && result === '') {
      // 빈 낱말은 낼 것이 없다. 이어서 읽는다
      continue
    }
    tokens.push(result)
    if (state === null) return tokens
  }
}

// fnmatch

const FNMATCH_CACHE = new Map<string, RegExp>()

function translate(pattern: string): string {
  let out = ''
  let i = 0
  const n = pattern.length
  while (i < n) {
    const c = pattern[i++]
    if (c === '*') {
      out += '.*'
    } else if (c === '?') {
      out += '.'
    } else if (c === '[') {
      let j = i
      if (j < n && pattern[j] === '!') j++
      if (j < n && pattern[j] === ']') j++
      while (j < n && pattern[j] !== ']') j++
      if (j >= n) {
        out += '\\['
      } else {
        let stuff = pattern.slice(i, j).replaceAll('\\', '\\\\').replace(/([&~|\]])/g, '\\$1').replaceAll('[', '\\[')
        i = j + 1
        if (stuff === '') out += '(?!)'
        else if (stuff === '!') out += '.'
        else {
          if (stuff[0] === '!') stuff = '^' + stuff.slice(1)
          else if (stuff[0] === '^') stuff = '\\' + stuff
          out += `[${stuff}]`
        }
      }
    } else {
      out += escapeRegExp(c)
    }
  }
  return `^(?:${out})$`
}

export function fnmatchcase(name: string, pattern: string): boolean {
  let re = FNMATCH_CACHE.get(pattern)
  if (!re) {
    re = new RegExp(translate(pattern), 's')
    FNMATCH_CACHE.set(pattern, re)
  }
  return re.test(name)
}

// Path.glob

const HAS_MAGIC = /[*?[]/

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function lexists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined
}

function listDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// 하위 항목을 재귀로 모은다. 심볼릭 링크 디렉터리는 따라가지 않는다. files 가 거짓이면 디렉터리만 모은다
function descendants(root: string, rel: string, files: boolean, out: Set<string>): void {
  for (const entry of listDir(rel ? `${root}/${rel}` : root)) {
    const child = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.add(child)
      descendants(root, child, files, out)
    } else if (files) {
      out.add(child)
    }
  }
}

// root 아래에서 pattern 에 맞는 경로를 root 기준 상대 경로로 낸다. 패턴이 비었거나 절대 경로면 던진다
export function globRel(root: string, pattern: string): string[] {
  if (pattern === '') throw new Error('Unacceptable pattern: ""')
  if (pattern.startsWith('/')) throw new Error('Non-relative patterns are unsupported')
  const parts = pattern.split('/').filter((part) => part !== '' && part !== '.')
  const directoriesOnly = pattern.endsWith('/')
  let current = new Set<string>([''])
  parts.forEach((part, index) => {
    const last = index === parts.length - 1
    const next = new Set<string>()
    for (const base of current) {
      const baseFull = base ? `${root}/${base}` : root
      if (part === '**') {
        if (isDirectory(baseFull)) next.add(base)
        descendants(root, base, last, next)
      } else if (HAS_MAGIC.test(part)) {
        for (const entry of listDir(baseFull)) {
          if (!fnmatchcase(entry.name, part)) continue
          const child = base ? `${base}/${entry.name}` : entry.name
          if (last || isDirectory(`${root}/${child}`)) next.add(child)
        }
      } else {
        const child = base ? `${base}/${part}` : part
        if (last ? lexists(`${root}/${child}`) : isDirectory(`${root}/${child}`)) next.add(child)
      }
    }
    current = next
  })
  const rootMatched = current.delete('')
  const found = [...current].filter((rel) => !directoriesOnly || isDirectory(`${root}/${rel}`))
  return rootMatched ? ['.', ...found] : found
}

// pathlib

export function pyPath(text: string): string {
  const absolute = text.startsWith('/')
  const parts = text.split('/').filter((part) => part !== '' && part !== '.')
  const joined = parts.join('/')
  if (absolute) return `/${joined}`
  return joined === '' ? '.' : joined
}

export function pathParts(text: string): string[] {
  const parts = text.split('/').filter((part) => part !== '' && part !== '.')
  return text.startsWith('/') ? ['/', ...parts] : parts
}

export function pathName(text: string): string {
  const parts = text.split('/').filter((part) => part !== '' && part !== '.')
  return parts.at(-1) ?? ''
}

// Python 3.14 의 suffix 다. 앞의 점들을 뺀 이름에서 마지막 점부터이고, 끝의 점 하나도 suffix 다
export function pathSuffix(text: string): string {
  const stripped = pathName(text).replace(/^\.+/, '')
  const i = stripped.lastIndexOf('.')
  return i > 0 ? stripped.slice(i) : ''
}

export function pathStem(text: string): string {
  const name = pathName(text)
  const suffix = pathSuffix(text)
  return suffix ? name.slice(0, -suffix.length) : name
}

export function pathParent(text: string): string {
  const parts = text.split('/').filter((part) => part !== '' && part !== '.')
  const absolute = text.startsWith('/')
  parts.pop()
  const joined = parts.join('/')
  if (absolute) return `/${joined}`
  return joined === '' ? '.' : joined
}

export const isAbsolutePath = (text: string) => text.startsWith('/')

// 그 폴더 아래에 있는가. 같은 경로도 true 다
export function isRelativeTo(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`)
}

// Path.resolve(). 심볼릭 링크를 풀고, 없는 뒷부분은 그대로 붙인다
export function pyResolve(path: string): string {
  const full = resolve(path)
  const tail: string[] = []
  let head = full
  for (;;) {
    try {
      return [realpathSync(head), ...tail.reverse()].join('/').replace(/\/+/g, '/').replace(/^\/\//, '/')
    } catch {
      const parent = dirname(head)
      if (parent === head) return full
      tail.push(basename(head))
      head = parent
    }
  }
}

// posixpath

export function posixNormpath(path: string): string {
  if (path === '') return '.'
  const initial = path.startsWith('/') ? (path.startsWith('//') && !path.startsWith('///') ? 2 : 1) : 0
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..' || (initial === 0 && parts.length === 0) || (parts.length > 0 && parts.at(-1) === '..')) parts.push(part)
    else if (parts.length > 0) parts.pop()
  }
  const joined = parts.join('/')
  return `${'/'.repeat(initial)}${joined}` || '.'
}

export function posixJoin(a: string, ...rest: string[]): string {
  let path = a
  for (const b of rest) {
    if (b.startsWith('/')) path = b
    else if (path === '' || path.endsWith('/')) path += b
    else path += `/${b}`
  }
  return path
}

// 저장소 경로와 하위 경로를 Path 처럼 잇는다
export function pjoin(...parts: string[]): string {
  return pyPath(posixJoin(parts[0], ...parts.slice(1)))
}

// repr, str

export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return reprString(value)
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`
  if (typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${reprString(k)}: ${pyRepr(v)}`).join(', ')}}`
  return String(value)
}

function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (ch === quote) out += `\\${quote}`
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return `${quote}${out}${quote}`
}

export function pyStrAny(value: unknown): string {
  return typeof value === 'string' ? value : pyRepr(value)
}

// urllib.parse

export type Split = { scheme: string; netloc: string; path: string }

export function urlsplitPath(raw: string): Split {
  let url = raw.replace(/^[\x00-\x20]+/, '').replace(/[\t\r\n]/g, '')
  let scheme = ''
  const colon = url.indexOf(':')
  if (colon > 0 && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase()
    url = url.slice(colon + 1)
  }
  let netloc = ''
  if (url.startsWith('//')) {
    const end = [...url.slice(2)].findIndex((ch) => '/?#'.includes(ch))
    const cut = end < 0 ? url.length : end + 2
    netloc = url.slice(2, cut)
    url = url.slice(cut)
  }
  const hash = url.indexOf('#')
  if (hash >= 0) url = url.slice(0, hash)
  const query = url.indexOf('?')
  if (query >= 0) url = url.slice(0, query)
  return { scheme, netloc, path: url }
}

// 퍼센트 인코딩을 UTF-8 로 푼다. 잘못된 바이트는 U+FFFD 로 바꾼다
export function unquote(text: string): string {
  if (!text.includes('%')) return text
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (let i = 0; i < text.length; ) {
    if (text[i] === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16))
      i += 3
    } else {
      const ch = String.fromCodePoint(text.codePointAt(i)!)
      bytes.push(...encoder.encode(ch))
      i += ch.length
    }
  }
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes))
}
