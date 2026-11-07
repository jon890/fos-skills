#!/usr/bin/env node
// 지우거나 이름을 바꾸려는 문자열을 저장소의 테스트가 요구하는지 찾는다.
//
// 판정표에 제거·축소·이름 변경을 적기 전에 그 제목이나 문장을 넘긴다.
// 찾으면 그 위치가 「테스트가 요구」 근거다. 테스트도 함께 고칠지를 승인 항목으로 낸다.
// 탐색 대상은 테스트 폴더와 테스트 파일 이름 규칙에 맞는 파일, CI 설정(`.github/workflows/*.yml`), `scripts/validate*` 다.
// `tests/data/` 같은 fixture 폴더도 읽는다.
//
// 후보 파일은 git 저장소면 `git ls-files -co --exclude-standard` 로 정한다. git 이 무시하는 빌드 결과물은 빠진다.
// git 저장소가 아니면 디렉터리를 순회하고 `.git`, `node_modules`, `.venv`, `worktrees`, `__pycache__` 와
// 빌드 결과물 폴더(`build`, `dist`, `out`, `target`, `coverage`, `.next`)를 건너뛴다.
//
// 「테스트가 요구」 로 내는 줄은 셋이다. 인자가 Markdown 제목 표기(`#` 와 공백)로 시작하면 표기를 뗀 문자열을 `S` 라 한다.
//   1. 인자를 그대로 담은 줄. 예: `## 확인`
//   2. `S` 가 따옴표(`"`, `'`, `` ` ``)나 「」, 『』 로 감싸인 줄
//   3. 줄 전체를 trim 한 값이 `S` 와 같은 줄
// 제목 표기가 없는 인자는 `S` 가 인자와 같으므로 1번이 부분 문자열 일치다.
// `S` 가 줄 어딘가에 들어 있을 뿐인 나머지는 `낱말만 겹침 N건` 으로 개수만 낸다. `--loose` 를 주면 그 목록을 펼친다.
// `확인` 처럼 흔한 낱말은 이 줄이 수백 건이 되어, 펼치면 진짜 근거가 묻힌다.
// 찾지 못해도 종료 코드는 0 이다. 출력의 「없음」 으로 판정한다.
//
// Usage: node find_test_requirements.ts <repo-root> <문자열> [<문자열> ...] [--loose]
// 종료 코드: 0 (검사를 마침), 2 (인자 오류, 빈 문자열 포함)
//

import { spawnSync } from 'node:child_process'
import { isMain, write } from './io.ts'
import { pyHead, pyReadText, pySplitLines, pyStrCompare, pyStrip } from './kit/py.ts'
import { isDir, isFile, pathName, pathParts, pathStem, pathSuffix, pjoin, pyPath, pyResolve, pyre, relativeTo, walk } from './pylike.ts'

const USAGE = `지우거나 이름을 바꾸려는 문자열을 저장소의 테스트가 요구하는지 찾는다.

판정표에 제거·축소·이름 변경을 적기 전에 그 제목이나 문장을 넘긴다.
찾으면 그 위치가 「테스트가 요구」 근거다. 테스트도 함께 고칠지를 승인 항목으로 낸다.
탐색 대상은 테스트 폴더와 테스트 파일 이름 규칙에 맞는 파일, CI 설정(\`.github/workflows/*.yml\`), \`scripts/validate*\` 다.
\`tests/data/\` 같은 fixture 폴더도 읽는다.

후보 파일은 git 저장소면 \`git ls-files -co --exclude-standard\` 로 정한다. git 이 무시하는 빌드 결과물은 빠진다.
git 저장소가 아니면 디렉터리를 순회하고 \`.git\`, \`node_modules\`, \`.venv\`, \`worktrees\`, \`__pycache__\` 와
빌드 결과물 폴더(\`build\`, \`dist\`, \`out\`, \`target\`, \`coverage\`, \`.next\`)를 건너뛴다.

「테스트가 요구」 로 내는 줄은 셋이다. 인자가 Markdown 제목 표기(\`#\` 와 공백)로 시작하면 표기를 뗀 문자열을 \`S\` 라 한다.
  1. 인자를 그대로 담은 줄. 예: \`## 확인\`
  2. \`S\` 가 따옴표(\`"\`, \`'\`, \`\` \` \`\`)나 「」, 『』 로 감싸인 줄
  3. 줄 전체를 trim 한 값이 \`S\` 와 같은 줄
제목 표기가 없는 인자는 \`S\` 가 인자와 같으므로 1번이 부분 문자열 일치다.
\`S\` 가 줄 어딘가에 들어 있을 뿐인 나머지는 \`낱말만 겹침 N건\` 으로 개수만 낸다. \`--loose\` 를 주면 그 목록을 펼친다.
\`확인\` 처럼 흔한 낱말은 이 줄이 수백 건이 되어, 펼치면 진짜 근거가 묻힌다.
찾지 못해도 종료 코드는 0 이다. 출력의 「없음」 으로 판정한다.

Usage: node find_test_requirements.ts <repo-root> <문자열> [<문자열> ...] [--loose]
종료 코드: 0 (검사를 마침), 2 (인자 오류, 빈 문자열 포함)
`

const TEST_SKIP = new Set(['.git', 'node_modules', '.venv', 'worktrees', '__pycache__'])
const BUILD_SKIP = new Set(['build', 'dist', 'out', 'target', 'coverage', '.next'])
const TEST_DIRS = new Set(['tests', 'test', '__tests__'])
const WRAPPERS = ['"', "'", '`', '「」', '『』']
const TITLE_MARK = pyre(/^#+\s+/u)

function isTestFile(path: string, root: string): boolean {
  const parts = pathParts(relativeTo(path, root))
  const name = pathName(path)
  return (
    (parts[0] === '.github' && parts[1] === 'workflows' && ['.yml', '.yaml'].includes(pathSuffix(path))) ||
    (parts[0] === 'scripts' && name.startsWith('validate')) ||
    parts.slice(0, -1).some((part) => TEST_DIRS.has(part)) ||
    name.startsWith('test_') ||
    name.includes('.test.') ||
    pathStem(path).endsWith('_test')
  )
}

// git 저장소면 추적 파일과 무시되지 않은 새 파일. 저장소가 아니면 null
function gitCandidates(root: string): string[] | null {
  const done = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root })
  if (done.error) throw done.error
  if (done.status !== 0) return null
  const names = new TextDecoder('utf-8', { ignoreBOM: true }).decode(done.stdout).split('\0')
  return [...new Set(names)].sort(pyStrCompare).filter((name) => name).map((name) => pjoin(root, name))
}

function walkCandidates(root: string): string[] {
  const out: string[] = []
  for (const step of walk(root)) {
    const kept = step.directories.filter((d) => !TEST_SKIP.has(d) && !BUILD_SKIP.has(d)).sort(pyStrCompare)
    step.directories.splice(0, step.directories.length, ...kept)
    for (const name of [...step.filenames].sort(pyStrCompare)) out.push(pjoin(step.current, name))
  }
  return out
}

function testFiles(root: string): string[] {
  const candidates = gitCandidates(root) ?? walkCandidates(root)
  return candidates.filter((path) => {
    const parts = pathParts(relativeTo(path, root))
    if (parts.slice(0, -1).some((part) => TEST_SKIP.has(part)) || !isFile(path)) return false
    return isTestFile(path, root)
  })
}

const strippedForm = (needle: string): string => needle.replace(TITLE_MARK, '')

// 줄이 「테스트가 요구」 에 드는가. 인자 그대로, 감싼 S, 줄 전체가 S
function requires(needle: string, line: string): boolean {
  if (line.includes(needle)) return true
  const bare = strippedForm(needle)
  if (!bare || bare === needle) return false
  if (pyStrip(line) === bare) return true
  return WRAPPERS.some((w) => {
    const open = [...w][0]
    const close = [...w].at(-1)!
    return line.includes(bare) && line.includes(`${open}${bare}${close}`)
  })
}

function loosely(needle: string, line: string): boolean {
  const bare = strippedForm(needle)
  return Boolean(bare) && line.includes(bare)
}

export function main(args: string[]): number {
  const loose = args.includes('--loose')
  const argv = args.filter((item) => item !== '--loose')
  if (argv.length < 2) {
    write(2, `${USAGE}\n`)
    return 2
  }
  const root = pyResolve(pyPath(argv[0]))
  const needles = argv.slice(1)
  if (needles.some((needle) => !needle)) {
    write(2, '빈 문자열은 찾을 수 없다\n')
    return 2
  }
  if (!isDir(root)) {
    write(2, `대상 저장소를 찾을 수 없다: ${root}\n`)
    return 2
  }

  const contents: [string, string[]][] = []
  for (const path of testFiles(root)) {
    try {
      contents.push([relativeTo(path, root), pySplitLines(pyReadText(path))])
    } catch {
      continue
    }
  }
  let out = `테스트 파일 ${contents.length}개에서 ${needles.length}개 문자열을 찾는다\n`
  for (const needle of needles) {
    const hits: [string, number, string][] = []
    const overlaps: [string, number, string][] = []
    for (const [rel, lines] of contents) {
      lines.forEach((line, index) => {
        const entry: [string, number, string] = [rel, index + 1, pyHead(pyStrip(line), 80)]
        if (requires(needle, line)) hits.push(entry)
        else if (loosely(needle, line)) overlaps.push(entry)
      })
    }
    out += `\n"${needle}"\n`
    for (const [rel, i, text] of hits) out += `  테스트가 요구: ${rel}:${i}  ${text}\n`
    if (!hits.length) out += '  없음\n'
    if (overlaps.length) {
      if (loose) {
        for (const [rel, i, text] of overlaps) out += `  낱말만 겹침: ${rel}:${i}  ${text}\n`
      } else {
        out += `  낱말만 겹침 ${overlaps.length}건 (--loose 로 목록)\n`
      }
    }
  }
  write(1, out)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
