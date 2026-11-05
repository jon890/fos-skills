// 옛 Python 명령과 같은 글자를 내는 변환이다. 출력 줄과 저장 파일의 바이트 꼴을 옛 명령과 맞춰, 그것을 읽는 쪽이 깨지지 않게 한다.
// pyStr, pyJson, shQuote, shSplit 의 원본은 orch 의 skills/orch/scripts/lib/py.ts 이고, 같은 입력에 같은 글자를 내는지
// scripts/tests/kit-copies.spec.ts 가 본다. 함수의 뜻은 그 파일 머리 주석이 소유한다. orch 의 pyRegExp 는 옮기지 않는다
// (docs/features/node-runtime/design.md 「공통 꼴 모듈 kit」).
//
// 이 파일에만 있는 것:
//     pySplitLines    str.splitlines. \n, \r\n, \r 말고도 \v, \f, \x1c, \x1d, \x1e, \x85, \u2028, \u2029 에서 나눈다.
//                     keepends 면 줄 끝 글자를 남긴다. 끝이 줄바꿈이면 빈 줄을 더하지 않는다
//     pyLen           len(str). UTF-16 단위가 아니라 코드 포인트 수다
//     pyHead          str[:n]. 앞 n 개 코드 포인트다
//     pyReadText      Path.read_text() 와 subprocess(text=True). 둘 다 줄바꿈을 \r\n, \r 에서 \n 으로 바꿔 읽는다
//     PY_SPACE        str 정규식의 \s 와 str.isspace 가 공백으로 보는 글자의 클래스. JS 의 \s 와 달리 \x1c~\x1f, \x85 가 들고 \ufeff 가 빠진다
//     pyStrip         str.strip(). PY_SPACE 의 글자를 양끝에서 지운다
//     정규식의 re.M 은 플래그 없이 ^ 를 (?<![^\n]), $ 를 (?![^\n]) 로 쓴다. JS 의 m 플래그는 \r, \u2028 도 줄 경계로 본다.
//     re.M 없는 $ 는 끝 또는 끝 줄바꿈 앞이라 (?=\n?$) 로 쓴다
//     pyStrCompare    str 의 < 비교. 코드 포인트 순이다
//     pyPathCompare   sorted(Path 목록) 의 비교. 같은 뿌리 아래 상대 경로를 / 로 나눈 조각 단위로 견준다.
//                     그래서 a/b 가 a-c 보다 앞이다(문자열 비교는 - 가 / 보다 앞이다)

import { readFileSync } from 'node:fs'

export function pyStr(value: unknown): string {
  if (value === undefined || value === null) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

export function pyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pyJson(item)}`)
      .join(', ')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function shQuote(word: string): string {
  if (word === '') return "''"
  if (!/[^\w@%+=:,./-]/.test(word)) return word
  return `'${word.replaceAll("'", `'"'"'`)}'`
}

const SPLIT_SPACE = new Set([' ', '\t', '\r', '\n'])
// shlex 의 escapedquotes 와 escape 다
const DOUBLE_ESCAPES = new Set(['"', '\\'])

export function shSplit(text: string): string[] {
  const words: string[] = []
  let word = ''
  // 따옴표만 있는 인자('')도 인자 하나로 세려고 글자가 없어도 인자가 시작됐는지 따로 둔다
  let started = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (SPLIT_SPACE.has(ch)) {
      if (started) words.push(word)
      word = ''
      started = false
      continue
    }
    started = true
    if (ch === '\\') {
      if (i + 1 >= text.length) throw new Error(`끝의 역슬래시 뒤에 글자가 없다: ${JSON.stringify(text)}`)
      word += text[++i]
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) throw new Error(`닫히지 않은 따옴표가 있다: ${JSON.stringify(text)}`)
      word += text.slice(i + 1, end)
      i = end
    } else if (ch === '"') {
      let closed = false
      for (i += 1; i < text.length; i++) {
        const inner = text[i]
        if (inner === '"') {
          closed = true
          break
        }
        if (inner === '\\' && i + 1 < text.length && DOUBLE_ESCAPES.has(text[i + 1])) {
          word += text[++i]
          continue
        }
        word += inner
      }
      if (!closed) throw new Error(`닫히지 않은 따옴표가 있다: ${JSON.stringify(text)}`)
    } else {
      word += ch
    }
  }
  if (started) words.push(word)
  return words
}

export function pyReadText(path: string): string {
  return normalizeNewlines(readFileSync(path, 'utf8'))
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export const PY_SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'g')

export function pyStrip(text: string): string {
  return text.replace(STRIP, '')
}

const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g

export function pySplitLines(text: string, keepends = false): string[] {
  const lines: string[] = []
  let start = 0
  for (const match of text.matchAll(LINE_BREAK)) {
    const end = match.index + match[0].length
    lines.push(text.slice(start, keepends ? end : match.index))
    start = end
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

export function pyLen(text: string): number {
  let count = 0
  for (const _ of text) count++
  return count
}

export function pyHead(text: string, n: number): string {
  return Array.from(text).slice(0, n).join('')
}

export function pyStrCompare(a: string, b: string): number {
  // Python 의 str 비교는 코드 포인트 순이다. JS 의 < 는 UTF-16 단위라 BMP 밖 글자에서 다르다
  const x = Array.from(a, (ch) => ch.codePointAt(0)!)
  const y = Array.from(b, (ch) => ch.codePointAt(0)!)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}

export function pyPathCompare(a: string, b: string): number {
  const x = a.split('/')
  const y = b.split('/')
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const order = pyStrCompare(x[i], y[i])
    if (order !== 0) return order
  }
  return x.length - y.length
}
