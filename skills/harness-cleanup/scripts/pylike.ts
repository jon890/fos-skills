// 옛 Python 구현이 표준 라이브러리로 하던 일 가운데 이 폴더의 명령이 쓰는 것만 옮겼다.
// 같은 입력에 같은 결과를 내는 것이 목적이라 이름과 순서를 원본(pathlib, os.walk, re, str)에 맞췄다.
// plan 스킬의 pylike.ts 에서 필요한 부분을 가져왔다. 스킬은 자기 폴더 밖을 import 하지 않으므로 복사본이다.
//
//     pyre             정규식의 \s, \S 를 Python re 의 공백 집합으로 바꾼다
//     WORD, notWord    Python 3 str 정규식의 \w 와 \W 에 해당하는 글자 클래스. 한글과 유니코드 숫자도 글자다 (u 플래그)
//     pyPath           str(Path(s)). `.` 조각과 겹친 `/` 를 줄이고 `..` 는 남긴다
//     pathName, pathStem, pathSuffix, pathParts, pathParent   Path 의 name, stem, suffix, parts, parent
//     pathParents      Path.parents. 가까운 상위부터 뿌리까지
//     isRelativeTo     Path.is_relative_to
//     relativeTo       Path.relative_to 의 문자열. 같은 경로면 `.`
//     pjoin            Path.__truediv__
//     pyResolve        Path.resolve(). 심볼릭 링크를 따라간 뒤에 `..` 를 처리하고, 없는 뒷부분은 그대로 붙인다
//     walk             os.walk(topdown=True, followlinks=False). directories 를 고쳐 가지를 칠 수 있다
//     pyRepr           repr(str)
//     parsePyInt       int(str)
//     escapeRegExp     re.escape 와 같은 뜻

import { lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { PY_SPACE, pyInt } from './kit/py.ts'

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// \s, \S 를 Python re 의 공백 집합으로 바꾼다. JS 의 \s 는 ﻿ 를 공백으로 보고 \x1c~\x1f, \x85 를 보지 않는다
const SPACE_INNER = PY_SPACE.slice(1, -1)

export function pyre(re: RegExp): RegExp {
  const src = re.source.replaceAll('[\\s\\S]', '[^]')
  let out = ''
  let inClass = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') {
      const next = src[++i]
      if (next === 's') out += inClass ? SPACE_INNER : PY_SPACE
      else if (next === 'S') out += inClass ? '\\S' : `[^${SPACE_INNER}]`
      else out += ch + next
      continue
    }
    if (ch === '[' && !inClass) inClass = true
    else if (ch === ']' && inClass) inClass = false
    out += ch
  }
  return new RegExp(out, re.flags)
}

// Python 3 의 \w. 영숫자(L, N 범주)와 밑줄이다. \b 는 이 클래스의 앞뒤 lookaround 로 쓴다
export const WORD = '[\\p{L}\\p{N}_]'
export const NOT_WORD_BEFORE = `(?<!${WORD})`
export const NOT_WORD_AFTER = `(?!${WORD})`

// pathlib

const pieces = (text: string) => text.split('/').filter((part) => part !== '' && part !== '.')

export function pyPath(text: string): string {
  const joined = pieces(text).join('/')
  if (text.startsWith('/')) return `/${joined}`
  return joined === '' ? '.' : joined
}

export function pathParts(text: string): string[] {
  return text.startsWith('/') ? ['/', ...pieces(text)] : pieces(text)
}

export function pathName(text: string): string {
  return pieces(text).at(-1) ?? ''
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
  const parts = pieces(text)
  parts.pop()
  const joined = parts.join('/')
  if (text.startsWith('/')) return `/${joined}`
  return joined === '' ? '.' : joined
}

export function pathParents(text: string): string[] {
  const out: string[] = []
  let current = pyPath(text)
  for (;;) {
    const parent = pathParent(current)
    if (parent === current) break
    out.push(parent)
    current = parent
  }
  return out
}

// 그 폴더 아래에 있는가. 같은 경로도 true 다
export function isRelativeTo(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`)
}

export function relativeTo(path: string, base: string): string {
  if (path === base) return '.'
  return path.slice(base.endsWith('/') ? base.length : base.length + 1)
}

export function pjoin(...parts: string[]): string {
  let path = parts[0]
  for (const b of parts.slice(1)) {
    if (b.startsWith('/')) path = b
    else if (path === '' || path.endsWith('/')) path += b
    else path += `/${b}`
  }
  return pyPath(path)
}

// Path.resolve(). 구성 요소를 앞에서부터 하나씩 풀어, 심볼릭 링크를 따라간 뒤에 `..` 를 처리한다. 없는 뒷부분은 그대로 붙인다
export function pyResolve(path: string): string {
  const queue = pieces(path.startsWith('/') ? path : `${process.cwd()}/${path}`)
  let resolved = '/'
  let links = 0
  while (queue.length) {
    const part = queue.shift()!
    if (part === '..') {
      resolved = dirname(resolved)
      continue
    }
    const candidate = resolved === '/' ? `/${part}` : `${resolved}/${part}`
    if (lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink() && links++ < 40) {
      const target = readlinkSync(candidate)
      if (target.startsWith('/')) resolved = '/'
      queue.unshift(...pieces(target))
    } else resolved = candidate
  }
  return resolved
}

export function isDir(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
}

export function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
}

export function exists(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false }) !== undefined
}

export function isSymlink(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
}

// os.walk(top). 디렉터리 링크는 내려가지 않는다. 읽을 수 없는 폴더는 건너뛴다.
// 부르는 쪽이 directories 를 고치면(가지치기, 정렬) 그 목록대로 내려간다
export type WalkStep = { current: string; directories: string[]; filenames: string[] }

export function* walk(top: string): Generator<WalkStep> {
  let entries
  try {
    entries = readdirSync(top, { withFileTypes: true })
  } catch {
    return
  }
  const directories: string[] = []
  const filenames: string[] = []
  for (const entry of entries) {
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && isDir(`${top}/${entry.name}`))
    ;(isDirectory ? directories : filenames).push(entry.name)
  }
  const step = { current: top, directories, filenames }
  yield step
  for (const name of step.directories) {
    const next = top === '/' ? `/${name}` : `${top}/${name}`
    if (!isSymlink(next)) yield* walk(next)
  }
}

// repr(str)

export function pyRepr(text: string): string {
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

// int(text). 앞뒤 공백과 부호와 밑줄 구분을 받고, 그 밖이면 던진다. 유니코드 십진 숫자도 값으로 읽는다
export function parsePyInt(text: string): number {
  const m = new RegExp(`^${PY_SPACE}*([+-]?)(\\p{Nd}+(?:_\\p{Nd}+)*)${PY_SPACE}*$`, 'u').exec(text)
  if (!m) throw new Error(`invalid literal for int() with base 10: ${pyRepr(text)}`)
  const value = pyInt(m[2].replaceAll('_', ''))
  return m[1] === '-' ? -value : value
}
