#!/usr/bin/env node
// 지침 파일 사이에서 같은 내용이 반복되는 구간을 찾는다.
//
// 연속 N줄 이상이 다른 파일과 일치하면 보고한다.
// "A 가 단일 소스다" 라고 적어 두고 내용을 복사한 경우가 가장 흔하다.
//
// 사용법: node check_duplication.ts [repo-root] [최소-연속-줄수] [--scope <저장소 안 경로>]
//
// 종료 코드: 0 중복 없음, 1 중복 있음, 2 범위 인자 오류이거나 대상 파일이 0.

import { isMain, readTextReplace, write } from './io.ts'
import { PY_SPACE, pyHead, pyLen, pySplitLines, pyStrip } from './kit/py.ts'
import { isRelativeTo, parsePyInt, pyPath, pyResolve, relativeTo } from './pylike.ts'
import { iterTargets, resolveScope, takeScope, ValueError } from './target_files.ts'

const WARNING = `
주의 — 이 검사는 줄 단위 문자열 일치만 본다.
0건은 의미 중복이 없다는 뜻이 아니다. 같은 규칙을 문서마다 다르게 표현해 두면 잡히지 않는다.
같은 개념(레이어 경계, 배포 정책, 검증 순서 등)을 언급하는 파일이 몇 개인지는 사람이 센다.`

const SPACES = new RegExp(`${PY_SPACE}+`)

// " ".join(line.split())
function normalize(line: string): string {
  return pyStrip(line)
    .split(SPACES)
    .filter((part) => part !== '')
    .join(' ')
}

function withoutFrontmatter(lines: string[]): string[] {
  if (!lines.length || pyStrip(lines[0]) !== '---') return lines
  const result = [...lines]
  result[0] = ''
  for (let index = 1; index < result.length; index++) {
    const line = result[index]
    result[index] = ''
    if (pyStrip(line) === '---') break
  }
  return result
}

// 정규화한 줄이 | - : 공백 글자만으로 되어 있는가
const onlyRule = (n: string) => [...n].every((ch) => '|-: '.includes(ch))

type Run = [number, string, number, string, number, string]

export function main(argv: string[]): number {
  let root: string
  let scope: string | null
  let rest: string[]
  try {
    let scopeArg: string | null
    ;[rest, scopeArg] = takeScope(argv)
    root = pyResolve(pyPath(rest.length ? rest[0] : '.'))
    scope = resolveScope(root, scopeArg)
  } catch (error) {
    if (!(error instanceof ValueError)) throw error
    write(2, `${error.message}\n`)
    return 2
  }
  // int(ARGV[1]) 는 정수가 아니면 ValueError 로 멈춘다
  const minRun = rest.length > 1 ? parsePyInt(rest[1]) : 3

  const docs = new Map<string, string[]>()
  for (const p of iterTargets(root, false, scope)) {
    if (isRelativeTo(pyResolve(p), root)) docs.set(relativeTo(p, root), withoutFrontmatter(pySplitLines(readTextReplace(p))))
  }
  if (docs.size === 0) {
    write(2, '대상 파일을 찾지 못했다 — repo root 에서 실행하는지 확인하라\n')
    return 2
  }

  // 정규화한 줄 → (파일, 줄번호) 목록
  const index = new Map<string, [string, number][]>()
  for (const [name, lines] of docs) {
    lines.forEach((line, i) => {
      const n = normalize(line)
      // 짧은 줄, 구분선, 표 구분자, 구조 태그는 제외 — 우연히 겹친다
      if (pyLen(n) < 15 || onlyRule(n)) return
      if (n.startsWith('<') && n.endsWith('>')) return
      if (n.startsWith('```')) return
      if (!index.has(n)) index.set(n, [])
      index.get(n)!.push([name, i])
    })
  }

  // 두 파일 사이의 연속 일치 구간을 모은다
  const runs: Run[] = []
  const seen = new Set<string>()
  for (const [, places] of index) {
    if (places.length < 2) continue
    for (let a = 0; a < places.length; a++) {
      for (let b = a + 1; b < places.length; b++) {
        const [fa, ia] = places[a]
        const [fb, ib] = places[b]
        if (fa === fb) continue
        if (seen.has(`${fa}\0${ia}\0${fb}\0${ib}`)) continue
        // 아래로 얼마나 이어지는지 센다
        let length = 0
        for (;;) {
          const ja = ia + length
          const jb = ib + length
          if (ja >= docs.get(fa)!.length || jb >= docs.get(fb)!.length) break
          if (normalize(docs.get(fa)![ja]) !== normalize(docs.get(fb)![jb])) break
          seen.add(`${fa}\0${ja}\0${fb}\0${jb}`)
          length++
        }
        if (length >= minRun) runs.push([length, fa, ia + 1, fb, ib + 1, pyHead(normalize(docs.get(fa)![ia]), 60)])
      }
    }
  }

  if (!runs.length) {
    write(1, `연속 ${minRun}줄 이상 중복 0건\n${WARNING}\n`)
    return 0
  }

  // runs.sort(reverse=True) — 튜플 전체를 큰 것부터. 길이, 파일 이름, 줄 번호, 표본 순이다
  runs.sort((x, y) => compareRun(y, x))
  const total = runs.reduce((sum, r) => sum + r[0], 0)
  let out = `중복 구간 ${runs.length}건 (합계 ${total}줄)\n\n`
  for (const [length, fa, ia, fb, ib, sample] of runs.slice(0, 25)) {
    out += `  ${String(length).padStart(3)}줄  ${fa}:${ia}  ↔  ${fb}:${ib}\n`
    out += `         "${sample}"\n`
  }
  out += '\n어느 쪽이 단일 소스인지 정하고 나머지는 그 문서를 가리키게 바꾼다.\n'
  out += `${WARNING}\n`
  write(1, out)
  return 1
}

// 문자열은 코드 포인트 순, 숫자는 크기 순으로 견준다
function compareRun(x: Run, y: Run): number {
  for (let k = 0; k < x.length; k++) {
    const a = x[k]
    const b = y[k]
    if (a === b) continue
    if (typeof a === 'number' && typeof b === 'number') return a - b
    return cmpStr(a as string, b as string)
  }
  return 0
}

function cmpStr(a: string, b: string): number {
  const x = Array.from(a, (ch) => ch.codePointAt(0)!)
  const y = Array.from(b, (ch) => ch.codePointAt(0)!)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
