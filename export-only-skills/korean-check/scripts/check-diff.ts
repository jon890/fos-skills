#!/usr/bin/env node
// git diff 로 이번에 더한 줄의 발견만 판정하고, 기존 줄의 발견은 따로 알린다.
//
// 여러 사람이 함께 고치는 큰 문서에서 파일 전체를 검사하면
// 내가 손대지 않은 기존 문장의 금지어까지 실패로 막혀, 고칠 수 없는 것을 고치라는 결과가 된다.
// 이 모드는 두 검사기를 파일 전체에 그대로 돌린 뒤 발견을 줄 번호로 나눈다.
// 줄만 잘라 검사하지 않는 이유는 코드 블록과 frontmatter 안인지를 파일 전체로만 판정할 수 있어서다.
//
// 사용법 (cwd: 검사할 저장소 안):
//     node check-diff.ts [--base <ref>] [<파일.md>...]
//
//     --base   비교 기준. 기본값은 HEAD 라 커밋하지 않은 변경만 본다.
//              브랜치 전체를 보려면 origin/main 처럼 기준 브랜치를 준다.
//              기준과 HEAD 의 merge-base 부터 작업 트리까지를 비교하므로,
//              기준 브랜치에 나중에 들어온 남의 변경은 이번 변경에 섞이지 않는다.
//     파일     생략하면 그 범위에서 바뀐 .md 와 추적하지 않는 새 .md 를 모두 본다.
//              추적하지 않는 파일은 모든 줄을 이번 변경으로 본다.
//
// 옵션은 argparse 처럼 긴 옵션의 고유한 접두(--bas)와 `--base=값` 을 받는다. 모르는 옵션과 값 없는 --base 는 사용법 오류(2)다.
//
// 출력은 「이번 변경」 과 「기존 줄」 두 묶음이다. 기존 줄의 발견은 종료 코드에 넣지 않는다.
//
// 종료 코드:
//     0  이번 변경에 금지어가 없다. 경고와 기존 줄의 발견이 있어도 0 이다
//     1  이번 변경의 줄에 매핑 표 금지어가 있다
//     2  돌지 못함. git 저장소가 아니거나 기준을 찾지 못했거나, 검사기가 2 로 끝났다
//
// 한계: 가독성 검사기의 TILDE 경고는 단락의 첫 줄 번호로 나온다.
// 단락 중간에 더한 줄 때문에 걸려도 첫 줄이 기존 줄이면 「기존 줄」 로 분류된다.

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isMain, write } from './io.ts'
import { pySplitLines, pyStrCompare, pyStrip } from './kit/py.ts'

const STYLE = join(import.meta.dirname, 'korean-style-check.ts')
const READABILITY = join(import.meta.dirname, 'check-readability.ts')

const HUNK = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/
// 두 검사기의 발견 줄은 「경로:줄번호:」 또는 「경로:줄번호  경고」 로 시작한다.
const FINDING = /^(.+?):(\d+)[: ]/
const BANNED = '금지어'

const USAGE = 'usage: check-diff.ts [-h] [--base BASE] [files ...]\n'
const HELP = `${USAGE}
git diff 로 이번에 더한 줄의 발견만 판정하고, 기존 줄의 발견은 따로 알린다.

positional arguments:
  files

options:
  -h, --help   show this help message and exit
  --base BASE
`

function git(args: string[], cwd?: string) {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { status: done.status ?? 1, stdout: (done.stdout ?? '').replace(/\r\n?/g, '\n') }
}

function fail(message: string): number {
  write(2, `check-diff: ${message}\n`)
  return 2
}

// 작업 트리의 그 파일에서 merge-base 이후 더하거나 바꾼 줄 번호 집합.
function addedLines(mergeBase: string, path: string): Set<number> | null {
  const done = git(['diff', '-U0', '--no-color', '--no-ext-diff', mergeBase, '--', path])
  if (done.status !== 0) return null
  const lines = new Set<number>()
  for (const row of pySplitLines(done.stdout)) {
    const m = HUNK.exec(row)
    if (m) {
      const start = Number(m[1])
      const count = Number(m[2] ?? 1)
      for (let i = start; i < start + count; i++) lines.add(i)
    }
  }
  return lines
}

const isUntracked = (path: string): boolean => git(['ls-files', '--error-unmatch', '--', path]).status !== 0

// 범위 안에서 바뀐 .md 와 추적하지 않는 새 .md 를 cwd 기준 경로로 낸다.
function changedMarkdown(root: string, mergeBase: string): string[] {
  // diff --name-only 는 저장소 루트 기준 경로를 내고, ls-files 는 cwd 밑만 본다.
  // 둘 다 루트에서 불러 같은 기준으로 맞춘다.
  const tracked = git(['diff', '--name-only', '--diff-filter=AMR', mergeBase, '--', '*.md'], root)
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', '*.md'], root)
  const names = [...pySplitLines(tracked.stdout), ...pySplitLines(untracked.stdout)]
  return [...new Set(names.map((name) => relative(process.cwd(), join(root, name))))].sort(pyStrCompare)
}

function runChecker(script: string, paths: string[]) {
  const done = spawnSync(process.execPath, [script, ...paths], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return { code: done.status ?? 1, out: pySplitLines((done.stdout ?? '').replace(/\r\n?/g, '\n')), err: done.stderr ?? '' }
}

// argparse 가 옵션으로 읽는 글자인지. 음수처럼 보이는 것, 한 글자 `-`, 공백이 든 것은 값이다
function looksLikeOption(token: string): boolean {
  if (!token.startsWith('-') || token === '-') return false
  if (/^-\d+$|^-\d*\.\d+$/.test(token)) return false
  return !token.includes(' ')
}

type Parsed = { help: true } | { error: string } | { base: string; files: string[] }

// argparse 와 같은 뜻으로 인자를 읽는다. 긴 옵션의 고유 접두, `--base=값`, `--` 를 받는다
function parseArgs(argv: string[]): Parsed {
  let base = 'HEAD'
  const files: string[] = []
  const unrecognized: string[] = []
  const longs = ['base', 'help']
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      files.push(...argv.slice(i + 1))
      break
    }
    if (!looksLikeOption(token)) {
      files.push(token)
      continue
    }
    if (token === '-h') return { help: true }
    if (!token.startsWith('--')) {
      unrecognized.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const given = eq >= 0 ? token.slice(2, eq) : token.slice(2)
    const matches = longs.includes(given) ? [given] : longs.filter((name) => name.startsWith(given))
    if (matches.length > 1) return { error: `ambiguous option: ${token} could match ${matches.map((m) => `--${m}`).join(', ')}` }
    if (matches.length === 0) {
      unrecognized.push(token)
      continue
    }
    if (matches[0] === 'help') {
      if (eq >= 0) return { error: 'argument -h/--help: ignored explicit argument' + ` '${token.slice(eq + 1)}'` }
      return { help: true }
    }
    if (eq >= 0) base = token.slice(eq + 1)
    else if (i + 1 < argv.length && !looksLikeOption(argv[i + 1])) base = argv[++i]
    else return { error: 'argument --base: expected one argument' }
  }
  if (unrecognized.length) return { error: `unrecognized arguments: ${unrecognized.join(' ')}` }
  return { base, files }
}

// 명령 본체. stdout 과 stderr 에 직접 쓰고 종료 코드를 돌려준다. argv 는 명령 이름 뒤의 인자다.
export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if ('help' in parsed) {
    write(1, HELP)
    return 0
  }
  if ('error' in parsed) {
    write(2, `${USAGE}check-diff.ts: error: ${parsed.error}\n`)
    return 2
  }
  const { base, files } = parsed

  const top = git(['rev-parse', '--show-toplevel'])
  if (top.status !== 0) return fail('git 저장소 안에서 돌린다')
  const root = pyStrip(top.stdout)

  const mb = git(['merge-base', base, 'HEAD'])
  if (mb.status !== 0) return fail(`기준을 찾지 못했다: ${base}`)
  const mergeBase = pyStrip(mb.stdout)

  const paths = files.length ? files : changedMarkdown(root, mergeBase)
  for (const p of paths) {
    if (!isFile(p)) return fail(`대상이 없다: ${p}`)
    if (!p.endsWith('.md')) return fail(`확장자가 .md 가 아니다: ${p}`)
  }
  if (!paths.length) {
    write(1, `통과: ${base} 이후 바뀐 .md 가 없다\n`)
    return 0
  }

  const added = new Map<string, Set<number> | null>()
  for (const p of paths) {
    if (isUntracked(p)) {
      added.set(p, null) // null 은 모든 줄이 이번 변경이라는 뜻이다
      continue
    }
    const lines = addedLines(mergeBase, p)
    if (lines === null) return fail(`git diff 가 실패했다: ${p}`)
    added.set(p, lines)
  }

  const fresh: string[] = []
  const old: string[] = []
  let status = 0
  for (const script of [STYLE, READABILITY]) {
    const { code, out, err } = runChecker(script, paths)
    if (code === 2) {
      write(2, err)
      return 2
    }
    for (const row of out) {
      const m = FINDING.exec(row)
      if (!m || !added.has(m[1])) continue
      const scope = added.get(m[1])
      if (scope === null || (scope as Set<number>).has(Number(m[2]))) {
        fresh.push(row)
        if (row.includes(BANNED)) status = 1
      } else old.push(row)
    }
  }

  write(1, `## 이번 변경 (${base} 이후 더한 줄)\n${fresh.length ? fresh.join('\n') : '발견 없음'}\n\n## 기존 줄 (참고. 종료 코드에 넣지 않는다)\n${old.length ? old.join('\n') : '발견 없음'}\n`)
  return status
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = await main(process.argv.slice(2))
