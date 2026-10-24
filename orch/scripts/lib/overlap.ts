// PR 을 머지하기 전에 base 최신화가 필요한지 「단위」 겹침으로 정하는 판정의 한 벌이다. git 조회는 하지 않는다.
// overlap_units 명령과 머지 큐가 쓴다. 판정 규칙(단위, 단위 묶음, 공용 경로, 문서 파일, 바로 머지로 보는 경우)은
// overlap_units.ts 머리 주석이 소유한다.
//
// 공용 경로 정규식은 Python re 의 글자로 받는다(lib/py.ts 의 pyRegExp). 옛 overlap_units.py 를 부르던 설정이 그대로 통하게 하려는 것이다.
// 문서 glob 은 Python fnmatch.fnmatchcase 와 같다. `*` 가 `/` 도 넘고 대소문자를 가린다.

import { pyRegExp } from './py.ts'

// 이유에 이름을 적는 개수. 넘으면 「외 N」 으로 줄인다
const SHOWN = 3

export type Verdict = { update: boolean; reason: string }

// 명령의 출력 한 줄. 옛 Verdict.__str__ 과 같다
export function verdictText(verdict: Verdict): string {
  return verdict.update ? `갱신 필요(${verdict.reason})` : '바로 머지'
}

// 접두는 폴더 경계로 끝나야 `modules` 가 `modules-old/` 와 맞지 않는다.
export function normalizePrefix(prefix: string): string {
  return !prefix || prefix.endsWith('/') ? prefix : `${prefix}/`
}

// 파일이 속한 단위. 접두 아래 폴더가 있으면 그 폴더 이름이고, 아니면 경로 자체다.
export function unitOf(path: string, unitPrefix: string): string {
  const prefix = normalizePrefix(unitPrefix)
  if (prefix && path.startsWith(prefix)) {
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash > 0) return rest.slice(0, slash)
  }
  return path
}

// 묶음 목록([['a', 'b'], ...])을 단위 이름에서 묶음 이름으로 가는 Map 으로 바꾼다. 묶음 이름은 멤버를 `+` 로 이은 것이다.
// 한 단위가 두 묶음에 들면 모호하므로 Error 다. 같은 묶음을 두 번 적은 것은 모호하지 않다.
export function groupMap(groups: readonly (readonly string[])[]): Map<string, string> {
  const mapping = new Map<string, string>()
  for (const given of groups) {
    const members = given.filter((member) => member)
    const label = members.join('+')
    for (const member of members) {
      const known = mapping.get(member)
      if (known !== undefined && known !== label) throw new Error(`단위 ${member} 가 묶음 둘에 들어 있다: ${known}, ${label}`)
      mapping.set(member, label)
    }
  }
  return mapping
}

// Python fnmatch.translate 의 규칙으로 glob 을 정규식으로 바꾼다. 닫히지 않은 `[` 는 글자 그대로다.
function globRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else if (ch === '[') {
      let j = i + 1
      if (pattern[j] === '!') j++
      if (pattern[j] === ']') j++
      while (j < pattern.length && pattern[j] !== ']') j++
      if (j >= pattern.length) {
        out += '\\['
        continue
      }
      let stuff = pattern.slice(i + 1, j).replaceAll('\\', '\\\\')
      if (stuff.startsWith('!')) stuff = `^${stuff.slice(1)}`
      else if (stuff.startsWith('^') || stuff.startsWith('[')) stuff = `\\${stuff}`
      out += `[${stuff}]`
      i = j
    } else out += ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, 's')
}

export function isDoc(path: string, docsGlobs: readonly string[]): boolean {
  return docsGlobs.some((pattern) => globRegExp(pattern).test(path))
}

// 쉼표로 나눈 목록. 빈 조각은 버린다. --docs-glob 과 --unit-group 의 값을 읽는다.
export function splitGlobs(text: string): string[] {
  return (text || '').split(',').filter((part) => part)
}

function names(items: Iterable<string>): string {
  const sorted = [...items].sort()
  const shown = sorted.slice(0, SHOWN).join(', ')
  return sorted.length > SHOWN ? `${shown} 외 ${sorted.length - SHOWN}` : shown
}

export type JudgeOptions = { sharedPaths?: string; unitPrefix?: string; docsGlobs?: readonly string[]; groups?: readonly (readonly string[])[] }

// PR 쪽 파일 목록과 base 쪽 파일 목록으로 최신화가 필요한지 정한다. sharedPaths 를 읽지 못하면 pyRegExp 의 Error 를 던진다.
export function judge(prFiles: readonly string[], baseFiles: readonly string[], opts: JudgeOptions = {}): Verdict {
  const docsGlobs = opts.docsGlobs ?? []
  const unitPrefix = opts.unitPrefix ?? 'modules/'
  const pr = prFiles.filter((file) => file && !isDoc(file, docsGlobs))
  const base = baseFiles.filter((file) => file && !isDoc(file, docsGlobs))
  if (base.length === 0 || pr.length === 0) return { update: false, reason: '' }
  if (opts.sharedPaths) {
    const shared = pyRegExp(opts.sharedPaths)
    const hits = new Set([...pr, ...base].filter((file) => shared.test(file)))
    if (hits.size > 0) return { update: true, reason: `공용 경로: ${names(hits)}` }
  }
  const mapping = groupMap(opts.groups ?? [])
  const units = (files: string[]) => new Set(files.map((file) => unitOf(file, unitPrefix)).map((unit) => mapping.get(unit) ?? unit))
  const theirs = units(base)
  const overlap = [...units(pr)].filter((unit) => theirs.has(unit))
  if (overlap.length > 0) return { update: true, reason: `단위 겹침: ${names(overlap)}` }
  return { update: false, reason: '' }
}
