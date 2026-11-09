import { runtimeEnv } from './runtime.ts'
// 옛 Python 구현이 표준 라이브러리로 하던 일 가운데 이 드라이버가 쓰는 것만 옮겼다.
// 같은 입력에 같은 글자를 내는 것이 목적이라 이름과 순서를 원본(str, float, int, json, os.path, pathlib, shutil, shlex)에 맞췄다.
// 이 폴더는 팀 저장소에 tools/browser-driver 로 실려 폴더 밖을 import 할 수 없다(docs/features/node-runtime/design.md DECISION1).
// 그래서 modules/kit 과 mac-cleanup 의 같은 이름 함수를 복사해 필요한 만큼만 둔다.
//
// 문자열 (str)
//     PY_SPACE, pyStrip     str.isspace 가 공백으로 보는 글자와 str.strip
//     pySplitLines          str.splitlines
//     pyDecode, pyReadText  bytes.decode('utf-8') 와 Path.read_text(). 잘못된 바이트는 던진다. 줄바꿈은 \n 으로 읽는다
//     isDigit               str.isdigit
//     pyRepr, pyStrOf       repr(값)과 str(값). JSON 에서 읽은 값(Map, 배열, PyFloat, bigint)도 받는다
// 숫자 (int, float)
//     parsePyInt            int(str). 공백, 부호, 밑줄 구분, 유니코드 십진 숫자를 받는다. 큰 수를 위해 bigint 를 낸다
//     parsePyFloat          float(str). inf, nan 도 받는다
//     PyFloat, pyFloatStr   float 을 나타내는 값과 str(float)(`50.0`, `1e-05`, `inf`)
// JSON (json)
//     loadJson              json.loads. 정수와 실수를 구분하고 오류 문장과 위치까지 같다(JsonDecodeError)
//     dumpJson              json.dumps(ensure_ascii, 구분자 선택)
// 경로 (os.path, pathlib, shutil, shlex)
//     pyHome, pyExpanduser, pyResolve, pyPath, pyName, pySuffix, isFile, exists, isSymlink
//     which                 shutil.which
//     shQuote               shlex.quote
//     osErrorMessage        OSError 의 str()

import { accessSync, constants, lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname as nodeDirname } from 'node:path'

// ── 문자열 ──

export const PY_SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'g')

export function pyStrip(text: string): string {
  return text.replace(STRIP, '')
}

const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g

export function pySplitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (const match of text.matchAll(LINE_BREAK)) {
    lines.push(text.slice(start, match.index))
    start = match.index + match[0].length
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

// bytes.decode('utf-8'). 잘못된 바이트는 U+FFFD 로 바꾸지 않고 던진다. BOM 은 지우지 않는다
export function pyDecode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

// 텍스트 모드의 줄바꿈 읽기: \r\n 과 \r 을 \n 으로
export const normalizeNewlines = (text: string): string => text.replace(/\r\n?/g, '\n')

export function pyReadText(path: string): string {
  return normalizeNewlines(pyDecode(readFileSync(path)))
}

// str.isdigit: 십진 숫자(Nd)와 위첨자·원문자처럼 숫자 성질이 Digit 인 글자. 뒤쪽은 int() 가 못 읽는다
const DIGIT_ONLY = '\\u00b2\\u00b3\\u00b9\\u2070\\u2074-\\u2079\\u2080-\\u2089\\u2460-\\u2468\\u2474-\\u247c\\u2488-\\u2490\\u24ea\\u24f5-\\u24fd\\u24ff\\u2776-\\u277e\\u2780-\\u2788\\u278a-\\u2792\\u1369-\\u1371'
const IS_DIGIT = new RegExp(`^[\\p{Nd}${DIGIT_ONLY}]+$`, 'u')

export const isDigit = (text: string): boolean => IS_DIGIT.test(text)

// ── 숫자 ──

// int(), float() 가 앞뒤에서 받는 공백. str.strip 의 PY_SPACE 에서 \x1c~\x1f 만 빠진다(Python 이 거절한다)
const NUM_SPACE = PY_SPACE.replace('\\x1c-\\x1f ', ' ')
const NUM_STRIP = new RegExp(`^${NUM_SPACE}+|${NUM_SPACE}+$`, 'g')

const NUMERIC = /^\p{Nd}$/u

// 유니코드의 십진 숫자는 0~9 가 이어진 자리에 열 개씩 놓여 있다. 이어진 숫자 줄의 처음에서 떨어진 거리를 10 으로 나눈 나머지가 값이다
function digitValue(ch: string): number {
  let cp = ch.codePointAt(0)!
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30
  const start = cp
  while (NUMERIC.test(String.fromCodePoint(cp - 1))) cp--
  return (start - cp) % 10
}

const toAscii = (text: string) => Array.from(text, (ch) => (NUMERIC.test(ch) ? String(digitValue(ch)) : ch)).join('')

// int(text). 앞뒤 공백, 부호, 숫자 사이의 밑줄을 받고 그 밖이면 던진다
export function parsePyInt(text: string): bigint {
  const m = new RegExp(`^${NUM_SPACE}*([+-]?)(\\p{Nd}+(?:_\\p{Nd}+)*)${NUM_SPACE}*$`, 'u').exec(text)
  if (!m) throw new Error(`invalid literal for int() with base 10: ${pyRepr(text)}`)
  const value = BigInt(toAscii(m[2]).replaceAll('_', ''))
  return m[1] === '-' ? -value : value
}

// float(text). 앞뒤 공백과 숫자 사이 밑줄을 받고 그 밖이면 던진다
export function parsePyFloat(text: string): number {
  const stripped = text.replace(NUM_STRIP, '')
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(stripped)
  if (special) return special[2].toLowerCase() === 'nan' ? NaN : special[1] === '-' ? -Infinity : Infinity
  const digits = '\\p{Nd}+(?:_\\p{Nd}+)*'
  const re = new RegExp(`^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:[eE][+-]?${digits})?$`, 'u')
  if (!re.test(stripped)) throw new Error(`could not convert string to float: ${pyRepr(text)}`)
  return Number(toAscii(stripped).replaceAll('_', ''))
}

// float 값. 정수 값이라도 `1.0` 꼴로 나와야 해서 JS 의 number(정수로 읽은 값)와 구분한다
export class PyFloat {
  readonly value: number
  constructor(value: number) {
    this.value = value
  }
}

// repr(float). 정수 값도 `24.0` 꼴이고 지수는 -4 보다 작거나 16 이상일 때 쓴다
function floatRepr(x: number): string {
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0'
  const [mantissa, exp] = Math.abs(x).toExponential().split('e')
  const digits = mantissa.replace('.', '')
  const exponent = Number(exp)
  let body: string
  if (exponent < -4 || exponent >= 16) {
    const frac = digits.length > 1 ? `.${digits.slice(1)}` : ''
    body = `${digits[0]}${frac}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`
  } else if (exponent >= 0) {
    const whole = digits.padEnd(exponent + 1, '0').slice(0, exponent + 1)
    body = `${whole}.${digits.slice(exponent + 1) || '0'}`
  } else {
    body = `0.${'0'.repeat(-exponent - 1)}${digits}`
  }
  return (x < 0 ? '-' : '') + body
}

// str(float): nan, inf, -inf 는 소문자다
export function pyFloatStr(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf'
  return floatRepr(x)
}

// json.dumps 가 쓰는 float 표기: NaN, Infinity, -Infinity
function jsonFloat(x: number): string {
  if (Number.isNaN(x)) return 'NaN'
  if (!Number.isFinite(x)) return x < 0 ? '-Infinity' : 'Infinity'
  return floatRepr(x)
}

// repr(str)
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return String(value)
  if (value instanceof PyFloat) return pyFloatStr(value.value)
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`
  if (value instanceof Map) return `{${[...value].map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(', ')}}`
  const text = String(value)
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

// str(값). 문자열은 그대로이고 나머지는 repr 이다. float 은 str 과 repr 이 같다
export const pyStrOf = (value: unknown): string => (typeof value === 'string' ? value : pyRepr(value))

// str 의 < 비교는 코드 포인트 순이다. JS 의 < 는 UTF-16 단위라 BMP 밖 글자에서 다르다
export function pyStrCompare(a: string, b: string): number {
  const x = Array.from(a, (ch) => ch.codePointAt(0)!)
  const y = Array.from(b, (ch) => ch.codePointAt(0)!)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}

// 값의 참거짓: 0, 빈 문자열, 빈 목록, 빈 객체, None, False 가 거짓이다
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'bigint') return value !== 0n
  if (value instanceof PyFloat) return value.value !== 0
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0
  if (value instanceof Map) return value.size > 0
  return true
}

// ── JSON ──

// Python json.JSONDecodeError 의 str(): `<이유>: line N column M (char P)`. 위치는 코드 포인트 수다
export class JsonDecodeError extends Error {}

const WS = new Set([' ', '\t', '\n', '\r'])

class Scanner {
  readonly s: string
  readonly length: number
  constructor(s: string) {
    this.s = s
    this.length = s.length
  }

  // Python 의 JSONDecodeError 문장: 위치는 코드 포인트 수이고 열은 마지막 줄바꿈 뒤의 글자 수 + 1 이다
  fail(message: string, at: number): never {
    const before = this.s.slice(0, at)
    const lastNewline = before.lastIndexOf('\n')
    const line = before.split('\n').length
    const column = Array.from(before.slice(lastNewline + 1)).length + 1
    throw new JsonDecodeError(`${message}: line ${line} column ${column} (char ${Array.from(before).length})`)
  }

  skip(i: number): number {
    while (i < this.length && WS.has(this.s[i])) i++
    return i
  }

  // StopIteration(idx) 대신 이 값을 던져 부르는 쪽이 「Expecting value」 로 바꾼다
  stop(at: number): never {
    throw new Stop(at)
  }

  value(idx: number, depth: number): [unknown, number] {
    const { s, length } = this
    if (idx >= length) this.stop(idx)
    if (depth > 900) throw new Error('maximum recursion depth exceeded while decoding a JSON document')
    switch (s[idx]) {
      case '"':
        return this.string(idx + 1)
      case '{':
        return this.object(idx + 1, depth + 1)
      case '[':
        return this.array(idx + 1, depth + 1)
      case 'n':
        if (idx + 3 < length && s.startsWith('null', idx)) return [null, idx + 4]
        break
      case 't':
        if (idx + 3 < length && s.startsWith('true', idx)) return [true, idx + 4]
        break
      case 'f':
        if (idx + 4 < length && s.startsWith('false', idx)) return [false, idx + 5]
        break
      case 'N':
        if (idx + 2 < length && s.startsWith('NaN', idx)) return [new PyFloat(NaN), idx + 3]
        break
      case 'I':
        if (idx + 7 < length && s.startsWith('Infinity', idx)) return [new PyFloat(Infinity), idx + 8]
        break
      case '-':
        if (idx + 8 < length && s.startsWith('-Infinity', idx)) return [new PyFloat(-Infinity), idx + 9]
        break
    }
    return this.number(idx)
  }

  number(start: number): [unknown, number] {
    const { s, length } = this
    const end = length - 1
    const isDigit09 = (i: number) => s[i] >= '0' && s[i] <= '9'
    let idx = start
    if (s[idx] === '-') {
      idx++
      if (idx > end) this.stop(start)
    }
    if (s[idx] >= '1' && s[idx] <= '9') {
      idx++
      while (idx <= end && isDigit09(idx)) idx++
    } else if (s[idx] === '0') {
      idx++
    } else this.stop(start)
    let isFloat = false
    if (idx < end && s[idx] === '.' && isDigit09(idx + 1)) {
      isFloat = true
      idx += 2
      while (idx <= end && isDigit09(idx)) idx++
    }
    if (idx < end && (s[idx] === 'e' || s[idx] === 'E')) {
      const eStart = idx
      idx++
      if (idx < end && (s[idx] === '-' || s[idx] === '+')) idx++
      while (idx <= end && isDigit09(idx)) idx++
      if (isDigit09(idx - 1)) isFloat = true
      else idx = eStart
    }
    const text = s.slice(start, idx)
    if (isFloat) return [new PyFloat(Number(text)), idx]
    const big = BigInt(text)
    return [big >= -9007199254740991n && big <= 9007199254740991n ? Number(big) : big, idx]
  }

  string(begin: number): [string, number] {
    const { s, length } = this
    let end = begin
    let out = ''
    const open = begin - 1
    for (;;) {
      let next = end
      let c = ''
      for (; next < length; next++) {
        c = s[next]
        if (c === '"' || c === '\\') break
        if (c.charCodeAt(0) <= 0x1f) this.fail('Invalid control character at', next)
      }
      if (!(c === '"' || c === '\\') || next >= length) this.fail('Unterminated string starting at', open)
      out += s.slice(end, next)
      next++
      if (c === '"') {
        end = next
        break
      }
      if (next === length) this.fail('Unterminated string starting at', open)
      c = s[next]
      if (c !== 'u') {
        end = next + 1
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
        if (!(c in simple)) this.fail('Invalid \\escape', end - 2)
        out += simple[c]
      } else {
        next++
        end = next + 4
        if (end >= length) this.fail('Invalid \\uXXXX escape', next - 1)
        const hex = (from: number, to: number): number => {
          let value = 0
          for (let i = from; i < to; i++) {
            if (!/^[0-9a-fA-F]$/.test(s[i] ?? '')) this.fail('Invalid \\uXXXX escape', to - 5)
            value = value * 16 + parseInt(s[i], 16)
          }
          return value
        }
        let code = hex(next, end)
        next = end
        if (code >= 0xd800 && code <= 0xdbff && end + 6 < length && s[next] === '\\' && s[next + 1] === 'u') {
          const low = hex(next + 2, next + 6)
          if (low >= 0xdc00 && low <= 0xdfff) {
            out += String.fromCharCode(code, low)
            end += 6
            continue
          }
        }
        out += String.fromCharCode(code)
      }
    }
    return [out, end]
  }

  object(start: number, depth: number): [Map<string, unknown>, number] {
    const { s, length } = this
    const result = new Map<string, unknown>()
    let idx = this.skip(start)
    if (idx >= length || s[idx] !== '}') {
      for (;;) {
        if (idx >= length || s[idx] !== '"') this.fail('Expecting property name enclosed in double quotes', idx)
        const [key, afterKey] = this.string(idx + 1)
        idx = this.skip(afterKey)
        if (idx >= length || s[idx] !== ':') this.fail("Expecting ':' delimiter", idx)
        idx = this.skip(idx + 1)
        const [value, afterValue] = this.value(idx, depth)
        result.set(key, value)
        idx = this.skip(afterValue)
        if (idx < length && s[idx] === '}') break
        if (idx >= length || s[idx] !== ',') this.fail("Expecting ',' delimiter", idx)
        const comma = idx
        idx = this.skip(idx + 1)
        if (idx < length && s[idx] === '}') this.fail('Illegal trailing comma before end of object', comma)
      }
    }
    return [result, idx + 1]
  }

  array(start: number, depth: number): [unknown[], number] {
    const { s, length } = this
    const result: unknown[] = []
    let idx = this.skip(start)
    if (idx >= length || s[idx] !== ']') {
      for (;;) {
        const [value, afterValue] = this.value(idx, depth)
        result.push(value)
        idx = this.skip(afterValue)
        if (idx < length && s[idx] === ']') break
        if (idx >= length || s[idx] !== ',') this.fail("Expecting ',' delimiter", idx)
        const comma = idx
        idx = this.skip(idx + 1)
        if (idx < length && s[idx] === ']') this.fail('Illegal trailing comma before end of array', comma)
      }
    }
    return [result, idx + 1]
  }
}

class Stop extends Error {
  readonly at: number
  constructor(at: number) {
    super('stop')
    this.at = at
  }
}

// json.loads. 정수는 number(큰 수는 bigint), 실수는 PyFloat, 객체는 Map, 목록은 배열이다. NaN, Infinity, -Infinity 도 받는다
export function loadJson(text: string): unknown {
  const scanner = new Scanner(text)
  if (text.startsWith('\ufeff')) scanner.fail('Unexpected UTF-8 BOM (decode using utf-8-sig)', 0)
  const first = scanner.skip(0)
  let result: [unknown, number]
  try {
    result = scanner.value(first, 0)
  } catch (error) {
    if (error instanceof Stop) scanner.fail('Expecting value', error.at)
    throw error
  }
  const end = scanner.skip(result[1])
  if (end !== text.length) scanner.fail('Extra data', end)
  return result[0]
}

// json.dumps 의 문자열 이스케이프. 짝 없는 서로게이트도 그대로 둔다(ensure_ascii 가 거짓이면 Python 은 쓰는 쪽에서 오류가 난다)
function jsonString(text: string, ensureAscii: boolean): string {
  const named: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }
  const hex = (code: number) => `\\u${code.toString(16).padStart(4, '0')}`
  let out = '"'
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const code = text.charCodeAt(i)
    if (ch in named) out += named[ch]
    else if (code < 0x20) out += hex(code)
    else if (ensureAscii && code > 0x7e) out += hex(code)
    else out += ch
  }
  return `${out}"`
}

// json.dumps(value, ensure_ascii=ascii, separators=compact ? (",", ":") : 기본(", ", ": "))
export function dumpJson(value: unknown, opts: { ascii?: boolean; compact?: boolean } = {}): string {
  const ascii = opts.ascii ?? false
  const comma = opts.compact ? ',' : ', '
  const colon = opts.compact ? ':' : ': '
  const dump = (v: unknown): string => {
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (typeof v === 'bigint') return v.toString()
    if (typeof v === 'number') return String(v)
    if (v instanceof PyFloat) return jsonFloat(v.value)
    if (typeof v === 'string') return jsonString(v, ascii)
    if (Array.isArray(v)) return `[${v.map(dump).join(comma)}]`
    if (v instanceof Map) return `{${[...v].map(([k, item]) => `${jsonString(String(k), ascii)}${colon}${dump(item)}`).join(comma)}}`
    throw new TypeError(`Object of type ${typeof v} is not JSON serializable`)
  }
  return dump(value)
}

// ── 경로 ──

// Path.home(): HOME 이 있으면 그 값(끝 /는 뗀다), 없으면 사용자 정보에서 찾는다
export function pyHome(): string {
  return pyHomePrefix() || '/'
}

// 홈 뒤에 `/…` 를 이어 붙일 때 쓰는 앞부분. 홈이 / 이면 빈 문자열이라 `//…` 가 되지 않는다
export function pyHomePrefix(): string {
  const home = runtimeEnv().HOME
  if (home !== undefined) return home.replace(/\/+$/, '')
  return homedir().replace(/\/+$/, '')
}

// Path.expanduser(): `~` 와 `~/…` 만 홈으로 푼다
export function pyExpanduser(path: string): string {
  if (!path.startsWith('~')) return path
  const slash = path.indexOf('/')
  const head = slash < 0 ? path : path.slice(0, slash)
  if (head !== '~') return path
  return pyHomePrefix() + path.slice(head.length) || '/'
}

const pieces = (text: string) => text.split('/').filter((part) => part !== '' && part !== '.')

// str(Path(text)). `.` 조각과 겹친 /, 끝의 / 를 줄이고 `..` 는 남긴다. 처음의 // 는 정확히 둘일 때만 남는다
export function pyPath(text: string): string {
  const joined = pieces(text).join('/')
  if (text.startsWith('/')) return `${text.startsWith('//') && !text.startsWith('///') ? '//' : '/'}${joined}`
  return joined === '' ? '.' : joined
}

// Path.name 과 Path.suffix
export const pyName = (path: string): string => pieces(path).at(-1) ?? ''
export function pySuffix(path: string): string {
  const name = pyName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot)
}

// Path.resolve(): 구성 요소를 앞에서부터 하나씩 풀어 심볼릭 링크를 따라간 뒤에 `..` 를 처리한다. 없는 뒷부분은 그대로 붙인다.
// 읽을 수 없거나(EACCES) 폴더가 아닌(ENOTDIR) 경로는 풀지 못한 채 남기고 계속한다(os.path.realpath 의 strict=False)
export function pyResolve(path: string): string {
  const queue = pieces(path.startsWith('/') ? path : `${process.cwd()}/${path}`)
  let resolved = '/'
  let links = 0
  while (queue.length) {
    const part = queue.shift()!
    if (part === '..') {
      resolved = nodeDirname(resolved)
      continue
    }
    const candidate = resolved === '/' ? `/${part}` : `${resolved}/${part}`
    let target: string | null = null
    try {
      if (lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink() && links++ < 40) target = readlinkSync(candidate)
    } catch {
      target = null
    }
    if (target !== null) {
      if (target.startsWith('/')) resolved = '/'
      queue.unshift(...pieces(target))
    } else resolved = candidate
  }
  return resolved
}

// 없거나 읽을 수 없거나 링크가 순환이면(ELOOP) undefined. Python 의 is_file, exists 가 OSError 를 False 로 삼는 것과 같다
function statOrNone(path: string) {
  try {
    return statSync(path, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}

export const isFile = (path: string): boolean => statOrNone(path)?.isFile() ?? false
export const isDirectory = (path: string): boolean => statOrNone(path)?.isDirectory() ?? false
export const exists = (path: string): boolean => statOrNone(path) !== undefined

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
  } catch {
    return false
  }
}

// shutil.which(cmd). PATH 가 비었으면 못 찾은 것이다. 빈 PATH 항목은 현재 폴더다
export function which(cmd: string): string | null {
  let path = runtimeEnv().PATH
  if (path === undefined) path = '/usr/bin:/bin:/usr/sbin:/sbin'
  if (!path) return null
  const check = (file: string) => {
    if (!exists(file) || isDirectory(file)) return false
    try {
      accessSync(file, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (cmd.includes('/')) return check(cmd) ? cmd : null
  const seen = new Set<string>()
  for (const dir of path.split(':')) {
    if (seen.has(dir)) continue
    seen.add(dir)
    const name = dir === '' ? cmd : dir.endsWith('/') ? dir + cmd : `${dir}/${cmd}`
    if (check(name)) return name
  }
  return null
}

// shlex.quote
export function shQuote(word: string): string {
  if (word === '') return "''"
  if (!/[^\w@%+=:,./-]/.test(word)) return word
  return `'${word.replaceAll("'", `'"'"'`)}'`
}

const ERRNO: Record<string, [number, string]> = {
  EPERM: [1, 'Operation not permitted'],
  ENOENT: [2, 'No such file or directory'],
  EIO: [5, 'Input/output error'],
  EACCES: [13, 'Permission denied'],
  EEXIST: [17, 'File exists'],
  ENOTDIR: [20, 'Not a directory'],
  EISDIR: [21, 'Is a directory'],
  EINVAL: [22, 'Invalid argument'],
  EMFILE: [24, 'Too many open files'],
  ENAMETOOLONG: [63, 'File name too long'],
  ELOOP: [62, 'Too many levels of symbolic links'],
}

// OSError 의 str(): `[Errno 2] No such file or directory: '경로'`. 원인 코드를 모르면 던져 처리하지 못한 오류로 끝낸다
export function osErrorMessage(error: unknown, path: string): string {
  const code = (error as NodeJS.ErrnoException).code
  const known = code ? ERRNO[code] : undefined
  if (!known) throw error
  return `[Errno ${known[0]}] ${known[1]}: ${pyRepr(path)}`
}
