#!/usr/bin/env node
// 스킬 문서에서 모델 교체 축의 후보를 고를 신호를 센다.
//
// 사용법:
//     model_fit_signals.ts SKILLS_ROOT [SKILLS_ROOT ...]
//
// SKILLS_ROOT 바로 아래에서 `SKILL.md` 가 있는 폴더를 스킬로 보고, 그 안의 Markdown 을 센다.
// `README.md`, `CHANGELOG.md`, `tests/`, `node_modules/` 는 세지 않는다.
//
// 신호는 굵은 강조, 실측 사례, 검증 지시, 위임 지시, 금지문, 날짜 표기의 출현 수다.
// 1000줄당 강조와 사례 수가 다른 스킬보다 크게 높으면 `references/audit-axes.md` 의 「모델 교체」 축으로 읽을 후보다.
// **수치는 읽을 순서를 정하는 데만 쓴다.** 판정은 문장을 읽고 시스템 프롬프트와 대조한 결과로 한다.
//
// 종료 코드
//     0  표를 냈다
//     2  인자 오류, 폴더가 없음
//

import { readdirSync } from 'node:fs'
import { isMain, readTextReplace, write } from './io.ts'
import { pyLen, pyPathCompare, pyStrip } from './kit/py.ts'
import { isDir, isFile, pathName, pjoin, pyPath, pyRepr, pyre, walk } from './pylike.ts'

const SIGNALS: Record<string, RegExp> = {
  굵은강조: /\*\*[^*]+\*\*/gu,
  실측사례: /실측(으로| 사례|했|한 )/gu,
  검증지시: /(검증|확인|재검증|다시 돌|verifier|code-reviewer|critic|리뷰어)/gu,
  위임지시: /(하위 에이전트|subagent|에이전트에게 맡|위임|Agent 도구|spawn|스폰)/gu,
  금지문: /(않는다|하지 않|말 것|금지|NEVER|MUST)/gu,
  날짜: /20\p{Nd}\p{Nd}-\p{Nd}\p{Nd}-\p{Nd}\p{Nd}/gu,
}
const SKIP_FILES = new Set(['README.md', 'CHANGELOG.md'])
const SKIP_DIRS = new Set(['tests', 'node_modules'])
const DESCRIPTION = pyre(/(?<![^\n])description:\s*\|?\s*\n?(.*?)\n(?:metadata|---|[\p{L}\p{N}_]+:)/su)

function descriptionLength(skillMd: string): number {
  const match = DESCRIPTION.exec(readTextReplace(skillMd))
  return match ? pyLen(pyStrip(match[1])) : 0
}

// 파일을 줄 단위로 읽는다. 줄바꿈을 \n 으로 바꾼 뒤 \n 에서만 나눈다(open() 의 줄 반복과 같다). 줄 끝의 \n 은 남는다
function fileLines(path: string): string[] {
  return readTextReplace(path).match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function count(skillDir: string): [number, Record<string, number>] {
  let lines = 0
  const counts = Object.fromEntries(Object.keys(SIGNALS).map((key) => [key, 0]))
  for (const step of walk(skillDir)) {
    step.directories.splice(0, step.directories.length, ...step.directories.filter((d) => !SKIP_DIRS.has(d)))
    for (const name of step.filenames) {
      if (!name.endsWith('.md') || SKIP_FILES.has(name)) continue
      for (const line of fileLines(pjoin(step.current, name))) {
        lines++
        for (const [key, pattern] of Object.entries(SIGNALS)) counts[key] += [...line.matchAll(pattern)].length
      }
    }
  }
  return [lines, counts]
}

export function main(argv: string[]): number {
  const roots = argv.map(pyPath)
  const missing = roots.filter((r) => !isDir(r))
  if (!roots.length || missing.length) {
    write(2, `인자 오류: 스킬 폴더를 하나 이상 준다. 없는 폴더: [${missing.map((m) => `PosixPath(${pyRepr(m)})`).join(', ')}]\n`)
    return 2
  }
  let out = `skill\t줄\tdesc자\t${Object.keys(SIGNALS).join('\t')}\t강조/1000줄\t사례/1000줄\n`
  for (const root of roots) {
    const skillDirs = readdirSync(root)
      .map((name) => pjoin(root, name))
      .filter((p) => isFile(pjoin(p, 'SKILL.md')))
      .sort(pyPathCompare)
    for (const skillDir of skillDirs) {
      const [lines, counts] = count(skillDir)
      const rates = ['굵은강조', '실측사례'].map((key) => Math.floor((counts[key] * 1000) / Math.max(lines, 1)))
      const row = [pathName(skillDir), lines, descriptionLength(pjoin(skillDir, 'SKILL.md')), ...Object.values(counts), ...rates]
      out += `${row.join('\t')}\n`
    }
  }
  write(1, out)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
