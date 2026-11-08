// 옛 Python 구현이 표준 라이브러리로 하던 일 가운데 이 폴더의 명령이 쓰는 것만 옮겼다.
// 같은 입력에 같은 결과를 내는 것이 목적이라 이름과 순서를 원본(os.path, os.walk, str.format, json, datetime, float)에 맞췄다.
// harness-cleanup 의 pylike.ts 에서 경로 함수를 가져왔다. 스킬은 자기 폴더 밖을 import 하지 않으므로 복사본이다.
//
// 경로 (os.path)
//     osJoin           os.path.join. 정규화하지 않는다
//     normpath         os.path.normpath. 심볼릭 링크를 따라가지 않고 `..` 를 글자로 줄인다
//     abspath          os.path.abspath. 현재 폴더에 이어 normpath 한다
//     dirname, basename   os.path.dirname, os.path.basename
//     expanduser       os.path.expanduser. `~` 와 `~/` 만 홈으로 푼다(HOME 이 없으면 홈 폴더 조회)
//     pyResolve        os.path.realpath / Path.resolve(). 심볼릭 링크를 따라간 뒤에 `..` 를 처리하고, 없는 뒷부분은 그대로 붙인다
//     pyPath           str(Path(s)). `.` 조각과 겹친 `/` 를 줄이고 `..` 는 남긴다
//     isDir, exists, isSymlink   os.path.isdir, exists, islink. 판정 오류(ELOOP 등)는 False
//     walk             os.walk(topdown=True, followlinks=False). directories 를 고쳐 가지를 칠 수 있다. 읽을 수 없는 폴더는 건너뛴다
// 서식 (str.format, repr)
//     pyFixed          `{x:.Nf}`. 정확한 십진 값에서 정확히 반이면 짝수로 반올림한다(JS toFixed 는 큰 쪽이다)
//     pyG              `{x:g}`
//     pyFloatRepr      repr(float). 정수 값도 `24.0` 꼴이다
//     pyRound          round(x, ndigits)
//     pyFloorDiv       float 의 `//`
//     pyRepr           repr(str)
// 변환
//     parsePyInt       int(str)
//     parsePyFloat     float(str). 공백, 밑줄 구분, 유니코드 숫자, inf, nan 을 받는다
//     fromIsoFormat    datetime.fromisoformat(text).timestamp(). 알아볼 수 없으면 null
//     mktimeLocal      time.mktime(time.strptime(text, "%Y-%m-%dT%H:%M:%S")). 틀리면 던진다
//     formatLocal      datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
//     mtimeSeconds     os.stat().st_mtime 과 같은 값(초 + 나노초 * 1e-9)
//     pyTime           time.time()
// JSON
//     PyFloat, dumpJson   json.dump(value, ensure_ascii=False, indent=2). 실수는 PyFloat 로 감싸야 `1.0` 꼴로 나온다
//     loadJson         json.loads. NaN, Infinity, -Infinity 도 받는다
// 그 밖에
//     splitWhitespace  str.split(None, maxsplit)
//     osErrorMessage   OSError 의 str(). `[Errno 2] No such file or directory: 'path'`

import { lstatSync, readdirSync, readlinkSync, statSync, type BigIntStats } from 'node:fs'
import { homedir } from 'node:os'
import { dirname as nodeDirname } from 'node:path'
import { PY_SPACE, pyInt } from './kit/py.ts'

// os.path

export function osJoin(base: string, name: string): string {
  if (name.startsWith('/')) return name
  if (base === '' || base.endsWith('/')) return base + name
  return `${base}/${name}`
}

export function normpath(path: string): string {
  if (path === '') return '.'
  let initialSlashes = path.startsWith('/') ? 1 : 0
  if (initialSlashes && path.startsWith('//') && !path.startsWith('///')) initialSlashes = 2
  const parts: string[] = []
  for (const comp of path.split('/')) {
    if (comp === '' || comp === '.') continue
    if (comp !== '..' || (!initialSlashes && parts.length === 0) || (parts.length > 0 && parts[parts.length - 1] === '..')) parts.push(comp)
    else if (parts.length > 0) parts.pop()
  }
  return '/'.repeat(initialSlashes) + parts.join('/') || '.'
}

export function abspath(path: string): string {
  return normpath(path.startsWith('/') ? path : osJoin(process.cwd(), path))
}

export function dirname(path: string): string {
  const head = path.slice(0, path.lastIndexOf('/') + 1)
  return head && head !== '/'.repeat(head.length) ? head.replace(/\/+$/, '') : head
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function expanduser(path: string): string {
  if (!path.startsWith('~')) return path
  const i = path.indexOf('/', 1)
  const end = i < 0 ? path.length : i
  if (end !== 1) return path
  const home = (process.env.HOME ?? homedir()).replace(/\/+$/, '')
  return home + path.slice(end) || '/'
}

const pieces = (text: string) => text.split('/').filter((part) => part !== '' && part !== '.')

export function pyPath(text: string): string {
  const joined = pieces(text).join('/')
  if (text.startsWith('/')) return `/${joined}`
  return joined === '' ? '.' : joined
}

// 구성 요소를 앞에서부터 하나씩 풀어, 심볼릭 링크를 따라간 뒤에 `..` 를 처리한다. 없는 뒷부분은 그대로 붙인다
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
    // 읽을 수 없거나(EACCES) 폴더가 아닌(ENOTDIR) 경로는 풀지 못한 채 남기고 계속한다(os.path.realpath 의 strict=False)
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

// 없거나 읽을 수 없거나 링크가 순환이면(ELOOP) undefined. Python 의 is_dir, is_file, exists 가 OSError 를 False 로 삼는 것과 같다
function statOrNone(path: string) {
  try {
    return statSync(path, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}

export const isDir = (path: string): boolean => statOrNone(path)?.isDirectory() ?? false

export const exists = (path: string): boolean => statOrNone(path) !== undefined

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
  } catch {
    return false
  }
}

// os.walk(top). 디렉터리 링크는 directories 에 들지만 내려가지 않는다. 읽을 수 없는 폴더는 건너뛴다.
// 하위 경로는 os.path.join 처럼 만든다. 부르는 쪽이 directories 를 고치면(가지치기) 그 목록대로 내려간다
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
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && isDir(osJoin(top, entry.name)))
    ;(isDirectory ? directories : filenames).push(entry.name)
  }
  const step = { current: top, directories, filenames }
  yield step
  for (const name of step.directories) {
    const next = osJoin(top, name)
    if (!isSymlink(next)) yield* walk(next)
  }
}

// 서식

const POW10: bigint[] = []
const pow10 = (n: number): bigint => (POW10[n] ??= 10n ** BigInt(n))

// |x| = mant * 2^exp2 (정확한 값)
function exactParts(x: number): { mant: bigint; exp2: number } {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, Math.abs(x))
  const bits = view.getBigUint64(0)
  const exponent = Number((bits >> 52n) & 0x7ffn)
  const fraction = bits & 0xfffffffffffffn
  if (exponent === 0) return { mant: fraction, exp2: -1074 }
  return { mant: fraction | (1n << 52n), exp2: exponent - 1075 }
}

// round-half-even(|x| * 10^digits). digits 는 음수일 수 있다
function scaledInteger(x: number, digits: number): bigint {
  const { mant, exp2 } = exactParts(x)
  let numerator = mant
  let denominator = 1n
  if (exp2 >= 0) numerator <<= BigInt(exp2)
  else denominator <<= BigInt(-exp2)
  if (digits >= 0) numerator *= pow10(digits)
  else denominator *= pow10(-digits)
  let quotient = numerator / denominator
  const twice = (numerator % denominator) * 2n
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n
  return quotient
}

const signOf = (x: number) => (x < 0 || Object.is(x, -0) ? '-' : '')

export function pyFixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf'
  const text = scaledInteger(x, digits).toString().padStart(digits + 1, '0')
  const body = digits === 0 ? text : `${text.slice(0, -digits)}.${text.slice(-digits)}`
  return signOf(x) + body
}

// `{x:g}`. 유효숫자 6자리, 끝의 0 은 지우고 지수가 -4 보다 작거나 6 이상이면 지수 꼴이다
export function pyG(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf'
  if (x === 0) return `${signOf(x)}0`
  const P = 6
  let exponent = Math.floor(Math.log10(Math.abs(x)))
  let digits = scaledInteger(x, P - 1 - exponent).toString()
  if (digits.length > P) {
    exponent += 1
    digits = scaledInteger(x, P - 1 - exponent).toString()
  } else if (digits.length < P) {
    exponent -= 1
    digits = scaledInteger(x, P - 1 - exponent).toString()
  }
  if (exponent < -4 || exponent >= P) {
    const mantissa = digits.replace(/0+$/, '')
    const body = mantissa.length > 1 ? `${mantissa[0]}.${mantissa.slice(1)}` : mantissa
    const sign = exponent < 0 ? '-' : '+'
    return `${signOf(x)}${body}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`
  }
  let text: string
  if (exponent >= 0) {
    const whole = digits.slice(0, exponent + 1)
    const fraction = digits.slice(exponent + 1).replace(/0+$/, '')
    text = fraction ? `${whole}.${fraction}` : whole
  } else {
    const fraction = `${'0'.repeat(-exponent - 1)}${digits}`.replace(/0+$/, '')
    text = `0.${fraction}`
  }
  return signOf(x) + text
}

export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'NaN'
  if (!Number.isFinite(x)) return x < 0 ? '-Infinity' : 'Infinity'
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
    const fraction = digits.slice(exponent + 1) || '0'
    body = `${whole}.${fraction}`
  } else {
    body = `0.${'0'.repeat(-exponent - 1)}${digits}`
  }
  return (x < 0 ? '-' : '') + body
}

// round(x, ndigits) 는 정확한 십진 값을 짝수 쪽으로 반올림한 뒤 다시 실수로 읽는다
export function pyRound(x: number, ndigits: number): number {
  return Number.isFinite(x) ? Number(pyFixed(x, ndigits)) : x
}

// float 의 `//`
export function pyFloorDiv(a: number, b: number): number {
  const mod = a % b
  let div = (a - mod) / b
  if (mod && b < 0 !== mod < 0) div -= 1
  if (!div) return b < 0 !== a < 0 ? -0 : 0
  const floored = Math.floor(div)
  return div - floored > 0.5 ? floored + 1 : floored
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

// 변환

const DIGIT = /^\p{Nd}$/u

function digitValue(ch: string): number {
  let cp = ch.codePointAt(0)!
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30
  const start = cp
  while (DIGIT.test(String.fromCodePoint(cp - 1))) cp--
  return (start - cp) % 10
}

const toAscii = (text: string) => Array.from(text, (ch) => (DIGIT.test(ch) ? String(digitValue(ch)) : ch)).join('')

const STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'g')

// int(text). 앞뒤 공백과 부호와 밑줄 구분을 받고, 그 밖이면 던진다. 유니코드 십진 숫자도 값으로 읽는다
export function parsePyInt(text: string): number {
  const m = new RegExp(`^${PY_SPACE}*([+-]?)(\\p{Nd}+(?:_\\p{Nd}+)*)${PY_SPACE}*$`, 'u').exec(text)
  if (!m) throw new Error(`invalid literal for int() with base 10: ${pyRepr(text)}`)
  const value = pyInt(m[2].replaceAll('_', ''))
  return m[1] === '-' ? -value : value
}

// float(text). 앞뒤 공백과 숫자 사이 밑줄을 받고, 그 밖이면 던진다
export function parsePyFloat(text: string): number {
  const stripped = text.replace(STRIP, '')
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(stripped)
  if (special) return special[2].toLowerCase() === 'nan' ? NaN : special[1] === '-' ? -Infinity : Infinity
  const digits = '\\p{Nd}+(?:_\\p{Nd}+)*'
  const re = new RegExp(`^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:[eE][+-]?${digits})?$`, 'u')
  if (!re.test(stripped)) throw new Error(`could not convert string to float: ${pyRepr(text)}`)
  return Number(toAscii(stripped).replaceAll('_', ''))
}

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
const daysInMonth = (year: number, month: number) => [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]

const YMD = /^(\d{4})-(\d{2})-(\d{2})$|^(\d{4})(\d{2})(\d{2})$/
const TIME = /^(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6})\d*)?)?)?$/
const OFFSET = /^(?:Z|([+-])(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,]\d{1,6})?)?)?)$/

// datetime.fromisoformat(text).timestamp(). 날짜는 YYYY-MM-DD 와 YYYYMMDD, 구분 글자는 아무거나 하나, 시각은 HH[:MM[:SS[.ffffff]]],
// 시간대는 Z 나 ±HH[:MM[:SS]] 다. 시간대가 없으면 지역 시각이다. ISO 주(YYYY-Www-D) 꼴은 알아보지 못해 null 이다
export function fromIsoFormat(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const chars = Array.from(text)
  let dateText: string
  let rest: string | null = null
  if (chars.length === 8 || chars.length === 10) {
    dateText = text
  } else if (chars.length > 10) {
    const dateLen = /^\d{4}-\d{2}-\d{2}/.test(text) ? 10 : 8
    dateText = chars.slice(0, dateLen).join('')
    rest = chars.slice(dateLen + 1).join('')
  } else return null
  const dm = YMD.exec(dateText)
  if (!dm) return null
  const [year, month, day] = (dm[1] ? [dm[1], dm[2], dm[3]] : [dm[4], dm[5], dm[6]]).map(Number)
  if (month < 1 || month > 12 || day < 1 || year < 1 || day > daysInMonth(year, month)) return null
  let hour = 0
  let minute = 0
  let second = 0
  let micro = 0
  let offsetSeconds: number | null = null
  if (rest !== null) {
    const tz = /(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:[.,]\d{1,6})?)?)?)$/.exec(rest)
    let timeText = rest
    if (tz && tz.index > 0) {
      timeText = rest.slice(0, tz.index)
      const om = OFFSET.exec(tz[1])
      if (!om) return null
      if (tz[1] === 'Z') offsetSeconds = 0
      else {
        const sign = om[1] === '-' ? -1 : 1
        const oh = Number(om[2])
        const omin = Number(om[3] ?? 0)
        const osec = Number(om[4] ?? 0)
        if (oh > 23 || omin > 59 || osec > 59) return null
        offsetSeconds = sign * (oh * 3600 + omin * 60 + osec)
      }
    }
    const tm = TIME.exec(timeText)
    if (!tm) return null
    hour = Number(tm[1])
    minute = Number(tm[2] ?? 0)
    second = Number(tm[3] ?? 0)
    micro = Number((tm[4] ?? '').padEnd(6, '0') || 0)
    if (hour > 23 || minute > 59 || second > 59) return null
  }
  const seconds = second + micro / 1e6
  if (offsetSeconds === null) return new Date(year, month - 1, day, hour, minute, 0, 0).getTime() / 1000 + seconds
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0) / 1000 - offsetSeconds + seconds
}

// time.mktime(time.strptime(text, "%Y-%m-%dT%H:%M:%S")). 형식에 맞지 않으면 던진다(옛 명령은 이 오류로 멈췄다)
export function mktimeLocal(text: string): number {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(text)
  const bad = () => new Error(`time data ${pyRepr(text)} does not match format '%Y-%m-%dT%H:%M:%S'`)
  if (!m) throw bad()
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number)
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 61) throw bad()
  return new Date(year, month - 1, day, hour, minute, second).getTime() / 1000
}

// datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
export function formatLocal(timestamp: number): string {
  const d = new Date(timestamp * 1000)
  const p = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// os.stat().st_mtime. 초에 나노초 * 1e-9 를 더한 실수다
export function mtimeSeconds(stats: BigIntStats): number {
  return Number(stats.mtimeNs / 1_000_000_000n) + Number(stats.mtimeNs % 1_000_000_000n) * 1e-9
}

export function pyTime(): number {
  return (performance.timeOrigin + performance.now()) / 1000
}

// JSON

export class PyFloat {
  readonly value: number
  constructor(value: number) {
    this.value = value
  }
}

function dump(value: unknown, level: number, indent: number): string {
  if (value === null || value === undefined) return 'null'
  if (value instanceof PyFloat) return pyFloatRepr(value.value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  const pad = ' '.repeat(indent * (level + 1))
  const close = ' '.repeat(indent * level)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map((item) => pad + dump(item, level + 1, indent)).join(',\n')}\n${close}]`
  }
  const entries = Object.entries(value as object)
  if (entries.length === 0) return '{}'
  return `{\n${entries.map(([key, item]) => `${pad}${JSON.stringify(key)}: ${dump(item, level + 1, indent)}`).join(',\n')}\n${close}}`
}

// json.dump(value, ensure_ascii=False, indent=2). 끝에 줄바꿈이 없다
export function dumpJson(value: unknown, indent = 2): string {
  return dump(value, 0, indent)
}

// json.loads. Python 은 NaN, Infinity, -Infinity 도 받는다. 문자열 밖의 그 낱말을 null 로 바꿔 다시 읽는다
export function loadJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    const replaced = text.replace(/"(?:[^"\\]|\\.)*"|-?Infinity|NaN/g, (token) => (token.startsWith('"') ? token : 'null'))
    if (replaced === text) throw error
    return JSON.parse(replaced)
  }
}

// 그 밖에

// str.split(None, maxsplit). 남은 뒷부분은 앞 공백만 지우고 그대로 둔다
export function splitWhitespace(text: string, maxsplit = -1): string[] {
  const out: string[] = []
  const space = new RegExp(`^${PY_SPACE}+`)
  const word = new RegExp(`^(?:(?!${PY_SPACE})[^])+`)
  let rest = text.replace(space, '')
  while (rest !== '') {
    if (maxsplit >= 0 && out.length === maxsplit) {
      out.push(rest)
      return out
    }
    const m = word.exec(rest)!
    out.push(m[0])
    rest = rest.slice(m[0].length).replace(space, '')
  }
  return out
}

const ERRNO: Record<string, [number, string]> = {
  ENOENT: [2, 'No such file or directory'],
  EACCES: [13, 'Permission denied'],
  EEXIST: [17, 'File exists'],
  ENOTDIR: [20, 'Not a directory'],
  EISDIR: [21, 'Is a directory'],
  ENOTEMPTY: [66, 'Directory not empty'],
  EPERM: [1, 'Operation not permitted'],
  EBUSY: [16, 'Resource busy'],
}

// OSError 의 str(). 원인 코드를 모르면 Node 의 문장을 그대로 쓴다
export function osErrorMessage(error: unknown, path?: string): string {
  const code = (error as NodeJS.ErrnoException).code
  const known = code ? ERRNO[code] : undefined
  if (!known) return error instanceof Error ? error.message : String(error)
  return `[Errno ${known[0]}] ${known[1]}${path === undefined ? '' : `: ${pyRepr(path)}`}`
}
