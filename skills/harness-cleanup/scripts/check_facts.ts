#!/usr/bin/env node
// 문서에 박힌 개수·목록 표기를 뽑아 검토 지점을 제시한다.
//
// 자동 판정이 아니다. 개수와 목록은 맥락을 봐야 맞는지 알 수 있으므로
// "여기가 틀리기 쉽다" 를 모아 보여 준다.
//
// 사용법: node check_facts.ts [repo-root] [--scope <저장소 안 경로>]
//
// 종료 코드: 0 검사를 마침, 2 범위 인자 오류.
// 1 은 내지 않는다. 발견을 출력하면서 0 으로 끝나므로 출력으로 판정한다.

import { isMain, readTextReplace, write } from './io.ts'
import { pyHead, pyInt, pySplitLines, pyStrCompare, pyStrip } from './kit/py.ts'
import { isRelativeTo, pyPath, pyResolve, pyre, relativeTo } from './pylike.ts'
import { iterTargets, resolveScope, takeScope, ValueError } from './target_files.ts'

// "N개 명령", "N개 파일", "16개" 처럼 개수를 박은 표기
const COUNT = pyre(/(\p{Nd}+)\s*개(?:\s*(명령|파일|패턴|항목|축|단계|행))?/gu)
// 고유어 수사로 쓴 개수. 관형사형(두·세·네)과 수사형(둘·셋·넷)이 다르고, 열은 '열다', '열' 과 겹쳐 단위가 붙을 때만 본다.
const NATIVE_UNIT =
  '개|가지|항목|단계|축|행|명령|파일|패턴|줄|곳|종류|절|문장|칸|표|문서|스킬|검사|판정|조건|' + '역할|층|부분|갈래|군데|사례|옵션|스크립트|플래그'
const NATIVE_DETERMINER = pyre(new RegExp(`(?<![가-힣])(?:두|세|네|다섯|여섯|일곱|여덟|아홉|열)\\s*(?:${NATIVE_UNIT})(?![가-힣]*째)`, 'gu'))
// 'X 는 둘이다', '스킬 넷' 처럼 단독으로 개수를 말하는 수사. 개수를 명사 앞에서 말할 때는 관형사(두·세·네)를 쓰므로,
// 수사가 공백 뒤 낱말로 이어지는 꼴('둘 다가', '둘 때', '둘 자리', '여섯 달') 은 개수 표기가 아니다.
// 서술격 어미, 보조사 '은/는/뿐', 문장부호, 줄 끝 앞에서만 잡는다. '둘째', '셋째' 도 '째' 가 이어져 빠진다.
const NATIVE_NUMERAL = pyre(/(?<![가-힣])(?:둘|셋|넷|다섯|여섯|일곱|여덟|아홉)(?=이다|이고|이며|입니다|이었|이라|은|는|뿐|[,.;:?!)]|\s*$)/gu)
// 문서 안에 나열된 옵션 플래그
const FLAG = /`(--[a-z][a-z0-9-]+)`/gu
// 코드 식별자로 보이는 백틱 조각 — 파일명 나열 여부 판단용
const JSONFILE = /`([a-z][a-z0-9-]*\.json)`/gu

export function main(argv: string[]): number {
  let root: string
  let scope: string | null
  try {
    const [rest, scopeArg] = takeScope(argv)
    root = pyResolve(pyPath(rest.length ? rest[0] : '.'))
    scope = resolveScope(root, scopeArg)
  } catch (error) {
    if (!(error instanceof ValueError)) throw error
    write(2, `${error.message}\n`)
    return 2
  }

  const counts: [string, number, string, string][] = []
  const flags = new Map<string, Set<string>>()
  const jsons = new Map<string, Set<string>>()
  const add = (map: Map<string, Set<string>>, key: string, rel: string) => {
    if (!map.has(key)) map.set(key, new Set())
    map.get(key)!.add(rel)
  }

  for (const f of iterTargets(root, true, scope).filter((path) => isRelativeTo(pyResolve(path), root))) {
    const rel = relativeTo(f, root)
    pySplitLines(readTextReplace(f)).forEach((line, index) => {
      const i = index + 1
      for (const m of line.matchAll(COUNT)) {
        const unit = m[2] ?? ''
        // 버전·날짜·TTL 등은 대상이 아니다
        if (unit || pyInt(m[1]) > 2) counts.push([rel, i, pyStrip(m[0]), pyHead(pyStrip(line), 70)])
      }
      for (const pattern of [NATIVE_DETERMINER, NATIVE_NUMERAL]) {
        for (const m of line.matchAll(pattern)) counts.push([rel, i, pyStrip(m[0]), pyHead(pyStrip(line), 70)])
      }
      for (const m of line.matchAll(FLAG)) add(flags, m[1], rel)
      for (const m of line.matchAll(JSONFILE)) add(jsons, m[1], rel)
    })
  }

  let out = '## 개수 표기 — 늘거나 줄면 곧 틀린다\n'
  out += '개수를 빼고 서술하는 것이 안전하다.\n\n'
  if (counts.length) {
    for (const [rel, i, what, ctx] of counts) out += `  ${rel}:${i}  "${what}"  — ${ctx}\n`
  } else {
    out += '  없음\n'
  }

  out += '\n## 여러 문서에 흩어진 옵션 — 한 곳이 단일 소스여야 한다\n'
  const multi = [...flags].filter(([, v]) => v.size >= 3)
  if (multi.length) {
    for (const [k, v] of [...multi].sort((a, b) => b[1].size - a[1].size).slice(0, 12)) {
      out += `  ${k}: ${v.size}개 문서 — ${[...v].sort(pyStrCompare).slice(0, 4).join(', ')}\n`
    }
  } else {
    out += '  없음\n'
  }

  out += '\n## 여러 문서에 나열된 캐시·설정 파일 — 목록이 갈라지기 쉽다\n'
  const multiJson = [...jsons].filter(([, v]) => v.size >= 2).sort((a, b) => pyStrCompare(a[0], b[0]))
  if (multiJson.length) {
    for (const [k, v] of multiJson) out += `  ${k}: ${[...v].sort(pyStrCompare).join(', ')}\n`
  } else {
    out += '  없음\n'
  }

  out += '\n## 직접 확인할 것\n'
  out += '  - 위 개수가 실제와 맞는지 세어 본다 (`ls`, `--help`, `grep -c`)\n'
  out += '  - 옵션이 실제로 있는지 `--help` 로 대조한다\n'
  out += '  - 파일 목록은 코드(예: 캐시 경로 상수)와 대조한다\n'
  write(1, out)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
