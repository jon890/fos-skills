#!/usr/bin/env node
// `SKILL.md` 를 고치고 그것이 위임한 참조 문서를 안 고친 경우를 찾는다.
//
// 사용법:
//     check_rename_drift.ts <대상 저장소> [<기준 커밋>] [--scope <저장소 안 경로>]
//
// 기준 커밋을 생략하면 `HEAD` 와 작업 트리를 비교한다.
// `--scope` 를 주면 그 아래의 `SKILL.md` 만 본다.
//
// 이 검사의 대상은 `SKILL.md` 와 그것이 위임한 `references/` 사이다.
// `AGENTS.md` 같은 다른 지침의 절 이름을 가리키는 「제목」 참조는 `check_references.ts` 가 본다.
//
// 종료 코드:
//     0  드리프트 없음
//     1  드리프트 검출
//     2  사용법 오류이거나 검사 대상이 없음.
//        기준 커밋 대비 바뀐 `SKILL.md` 가운데 `references/` 를 가진 것이 없으면 2 다. 검사 실패가 아니다
//
// 이 저장소에서 네 번 반복된 실패가 대상이다.
// `SKILL.md` 에서 절 이름, 개념, 주어를 바꾸고 그것을 소유한 `references/*.md` 를 안 고쳤다.
// 그러면 요약본과 소유자 문서가 서로 다른 것을 지시하게 된다.
//
// 검사 대상 수를 표준 오류로 알린다.
// 출력 0줄이 「깨끗함」 인지 「볼 것이 없었음」 인지 구분되지 않으면,
// 억제된 검사가 통과로 읽혀 회귀가 그대로 지나간다.
//
// ## 이 검사가 놓치는 것
//
// **이번 변경에서 새로 만든 참조 문서 안의 드리프트는 잡지 못한다.**
//
// 참조 문서가 옛 이름을 아직 담고 있는지만 보면 둘을 구분할 수 없다.
// 절 이름을 바꾼 경우와 절을 통째로 새 참조 파일에 옮긴 경우가 모두
// 「참조 문서에 그 이름이 있다」 로 같게 보이기 때문이다.
// 실측으로 내용만 보는 판정을 만들어 돌렸더니 이동 사례를 드리프트로 잡았다.
//
// 그래서 둘을 구분하는 데 `git diff` 를 쓴다. 기준 커밋에 없던 파일은 이번에 쓴 것이므로
// 글쓴이가 방금 손댄 것으로 보고 대상에서 뺀다.
// 같은 변경에서 새 파일을 만들면서 그 안에 자기가 버리는 이름을 쓴 경우가 이 틈에 들어간다.
//

import { readdirSync } from 'node:fs'
import { capture, isMain, readTextReplace, write } from './io.ts'
import { pyPathCompare, pySplitLines, pyStrCompare, pyStrip } from './kit/py.ts'
import { exists, isDir, isFile, pathName, pathParent, pathParts, pjoin, pyPath, pyResolve, relativeTo, walk } from './pylike.ts'
import { resolveScope, takeScope, ValueError } from './target_files.ts'

const USAGE = `\`SKILL.md\` 를 고치고 그것이 위임한 참조 문서를 안 고친 경우를 찾는다.

사용법:
    check_rename_drift.ts <대상 저장소> [<기준 커밋>] [--scope <저장소 안 경로>]

기준 커밋을 생략하면 \`HEAD\` 와 작업 트리를 비교한다.
\`--scope\` 를 주면 그 아래의 \`SKILL.md\` 만 본다.

이 검사의 대상은 \`SKILL.md\` 와 그것이 위임한 \`references/\` 사이다.
\`AGENTS.md\` 같은 다른 지침의 절 이름을 가리키는 「제목」 참조는 \`check_references.ts\` 가 본다.

종료 코드:
    0  드리프트 없음
    1  드리프트 검출
    2  사용법 오류이거나 검사 대상이 없음.
       기준 커밋 대비 바뀐 \`SKILL.md\` 가운데 \`references/\` 를 가진 것이 없으면 2 다. 검사 실패가 아니다

이 저장소에서 네 번 반복된 실패가 대상이다.
\`SKILL.md\` 에서 절 이름, 개념, 주어를 바꾸고 그것을 소유한 \`references/*.md\` 를 안 고쳤다.
그러면 요약본과 소유자 문서가 서로 다른 것을 지시하게 된다.

검사 대상 수를 표준 오류로 알린다.
출력 0줄이 「깨끗함」 인지 「볼 것이 없었음」 인지 구분되지 않으면,
억제된 검사가 통과로 읽혀 회귀가 그대로 지나간다.

## 이 검사가 놓치는 것

**이번 변경에서 새로 만든 참조 문서 안의 드리프트는 잡지 못한다.**

참조 문서가 옛 이름을 아직 담고 있는지만 보면 둘을 구분할 수 없다.
절 이름을 바꾼 경우와 절을 통째로 새 참조 파일에 옮긴 경우가 모두
「참조 문서에 그 이름이 있다」 로 같게 보이기 때문이다.
실측으로 내용만 보는 판정을 만들어 돌렸더니 이동 사례를 드리프트로 잡았다.

그래서 둘을 구분하는 데 \`git diff\` 를 쓴다. 기준 커밋에 없던 파일은 이번에 쓴 것이므로
글쓴이가 방금 손댄 것으로 보고 대상에서 뺀다.
같은 변경에서 새 파일을 만들면서 그 안에 자기가 버리는 이름을 쓴 경우가 이 틈에 들어간다.
`

const PRUNE = new Set(['.git', '.omx', 'node_modules', 'data', 'private', 'sources', 'tasks'])

// diff 줄은 `-` 마커 뒤에 리스트 마커가 또 붙는다 (`-- **이름**...`).
// 마커를 먼저 벗겨야 헤딩과 굵은 라벨이 줄 머리에 온다.
const LIST_MARKER = /^ *[-*] +/u
const LABEL = /^(?:#{2,4} (.+)|\*\*([^*]+)\*\*)/u
const PAREN_TAIL = / *\(.*\)$/u

function git(repo: string, ...args: string[]) {
  const done = capture(['git', ...args], { cwd: repo })
  if (done.missing) throw new Error('git 을 찾을 수 없다')
  return done
}

// 그 경로가 기준 대비 바뀌었는가
function changed(repo: string, base: string, path: string): boolean {
  return git(repo, 'diff', '--quiet', base, '--', path).code !== 0
}

// 기준 커밋에 그 파일이 있었는가
function existsIn(repo: string, base: string, path: string): boolean {
  return git(repo, 'cat-file', '-e', `${base}:${path}`).code === 0
}

// `SKILL.md` 에서 사라진 헤딩과 굵은 라벨
function removedLabels(repo: string, base: string, md: string): string[] {
  const diff = git(repo, 'diff', base, '--', md).stdout
  const found = new Set<string>()
  for (const line of pySplitLines(diff)) {
    if (!line.startsWith('-') || line.startsWith('---')) continue
    const text = line.slice(1).replace(LIST_MARKER, '')
    const m = LABEL.exec(text)
    if (!m) continue
    found.add(pyStrip((m[1] ?? m[2]).replace(PAREN_TAIL, '')))
  }
  return [...found].sort(pyStrCompare)
}

// 가지치기할 디렉터리를 빼고 `SKILL.md` 를 모은다
function skillFiles(repo: string, scope: string | null): string[] {
  const start = scope ?? repo
  if (isFile(start)) return pathName(start) === 'SKILL.md' ? [start] : []
  const out: string[] = []
  for (const step of walk(start)) {
    const path = pjoin(step.current, 'SKILL.md')
    if (!exists(path)) continue
    if (pathParts(relativeTo(path, repo)).some((part) => PRUNE.has(part))) continue
    out.push(path)
  }
  return out.sort(pyPathCompare)
}

// refs 폴더 바로 아래 *.md 를 이름순으로 낸다
function referenceDocs(refs: string): string[] {
  return readdirSync(refs)
    .filter((name) => name.endsWith('.md'))
    .map((name) => pjoin(refs, name))
    .sort(pyPathCompare)
}

export function main(argv: string[]): number {
  let rest: string[]
  let scopeArg: string | null
  try {
    ;[rest, scopeArg] = takeScope(argv)
  } catch (error) {
    if (!(error instanceof ValueError)) throw error
    write(2, `${error.message}\n`)
    return 2
  }
  if (!rest.length) {
    write(2, `${USAGE}\n`)
    return 2
  }
  const given = pyPath(rest[0])
  const base = rest.length > 1 ? rest[1] : 'HEAD'
  if (!isDir(given)) {
    write(2, `대상 저장소가 없다: ${given}\n`)
    return 2
  }
  const repo = pyResolve(given)
  let scope: string | null
  try {
    scope = resolveScope(repo, scopeArg)
  } catch (error) {
    if (!(error instanceof ValueError)) throw error
    write(2, `${error.message}\n`)
    return 2
  }

  let scanned = 0
  const findings: string[] = []
  for (const md of skillFiles(repo, scope)) {
    const refs = pjoin(pathParent(md), 'references')
    if (!isDir(refs)) continue
    const rel = relativeTo(md, repo)
    if (!changed(repo, base, rel)) continue
    scanned++

    const body = readTextReplace(md)
    for (const label of removedLabels(repo, base, rel)) {
      // 그 이름이 지금도 SKILL.md 에 있으면 이름을 바꾼 것이 아니라 옮긴 것이다.
      // diff 는 이동을 삭제와 추가로 보여주므로 이 가드가 없으면 절 이동마다 오탐이 난다.
      if (body.includes(label)) continue

      let owners = referenceDocs(refs).filter((p) => readTextReplace(p).includes(label))

      // 기준 커밋에 없던 참조 문서는 드리프트 대상이 아니다.
      // 절을 새 참조 파일로 옮기는 것이 이 스킬이 처방하는 정상 작업인데,
      // 새 파일은 `git diff` 에 변경으로 잡히지 않아 「안 고친 문서」 로 세어진다 (실측).
      // 그러면 분리 작업마다 종료 코드 1 이 나서 진짜 드리프트가 묻힌다.
      owners = owners.filter((p) => existsIn(repo, base, relativeTo(p, repo)))
      if (!owners.length) continue

      // 그 라벨을 담은 문서가 하나라도 함께 바뀌었으면 반영된 것으로 본다.
      // 스킬 단위로 「참조가 하나라도 바뀌었나」 를 보면, 무관한 참조 파일 한 줄 수정이
      // 그 스킬의 드리프트를 전부 침묵시킨다. 라벨을 담은 파일만 따져야 한다.
      // 반대로 파일별로 따로 따지면, 라벨이 새 소유자로 옮겨 간 리팩토링에서
      // 그 단어를 우연히 담은 무관한 문서가 매번 오탐으로 걸린다.
      const stale = owners.filter((p) => !changed(repo, base, relativeTo(p, repo)))
      if (stale.length === owners.length) {
        const paths = stale.map((p) => `./${relativeTo(p, repo)}`).join(' ')
        findings.push(`DRIFT: ./${rel} 에서 "${label}" 을 바꿨는데 참조 문서가 그대로다 — ${paths}`)
      }
    }
  }

  for (const line of findings) write(1, `${line}\n`)

  // 검사 대상이 없으면 통과가 아니라 검사가 돌지 못한 것이다.
  // 0 으로 끝내면 아무것도 보지 않은 실행이 통과로 기록된다 (실측).
  if (scanned === 0) {
    write(2, `검사 대상 없음 — 기준 '${base}' 대비 변경된 SKILL.md 가 하나도 없다.\n`)
    write(2, '기준을 바꾸거나 변경을 커밋한 뒤 다시 돌린다.\n')
    write(2, '다른 지침의 절 참조는 check_references.ts 가 본다.\n')
    return 2
  }

  write(2, `검사한 SKILL.md: ${scanned}개, 드리프트: ${findings.length}건\n`)
  return findings.length ? 1 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
