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
//     node check-diff.ts --staged
//
//     --base   비교 기준. 기본값은 HEAD 라 커밋하지 않은 변경만 본다.
//              브랜치 전체를 보려면 origin/main 처럼 기준 브랜치를 준다.
//              기준과 HEAD 의 merge-base 부터 작업 트리까지를 비교하므로,
//              기준 브랜치에 나중에 들어온 남의 변경은 이번 변경에 섞이지 않는다.
//     파일     생략하면 그 범위에서 바뀐 .md 와 추적하지 않는 새 .md 를 모두 본다.
//              추적하지 않는 파일은 모든 줄을 이번 변경으로 본다.
//
//     --staged 커밋 훅에서 쓴다. git 인덱스에 스테이징한 .md 에서 HEAD 보다 더하거나 바꾼 줄의 발견만 낸다.
//              작업 트리 파일이 아니라 스테이징된 내용을 읽는다. 스테이징한 뒤 고친 내용은 보지 않고,
//              `git commit -a` 처럼 git 이 임시 인덱스(GIT_INDEX_FILE)를 쓰는 커밋에서도 커밋될 내용을 본다.
//              새 파일과 첫 커밋(HEAD 없음)은 모든 줄이 대상이다. 이름만 바꾼 파일은 바뀐 줄만 본다(--base 모드는 모든 줄을 본다).
//              문서를 옮기는 커밋이 손대지 않은 줄의 금지어로 막히지 않게 하려는 것이다.
//              심볼릭 링크와 서브모듈 항목은 뺀다. 매핑 표를 가진 문서(규칙 파일 자신과 그 사본)도 뺀다. 그 표가 곧 금지어 목록이다.
//              --base 나 파일 인자와 함께 주면 사용법 오류(2)다.
//              git 에 저장된 내용을 그대로(필터와 인코딩 변환 없이) 임시 폴더에 같은 상대 경로로 풀어 두 검사기를 돌린다. 예외 파일(.claude/korean-check-allow.txt)은
//              대상 파일의 폴더에서 저장소 루트까지 있는 것을 임시 폴더의 같은 자리에 복사해 평소와 같은 규칙으로 읽힌다.
//              예외 파일은 스테이징된 내용이 아니라 작업 트리의 것을 읽는다. 커밋에 넣으려면 함께 스테이징한다.
//              git 은 저장소 루트에서만 부른다. 훅 환경에는 GIT_DIR 이 들어 있어 임시 폴더에서 부르면 실제 저장소에 닿는다.
//
// 옵션은 argparse 처럼 긴 옵션의 고유한 접두(--bas)와 `--base=값` 을 받는다. 모르는 옵션과 값 없는 --base 는 사용법 오류(2)다.
//
// 출력은 「이번 변경」 과 「기존 줄」 두 묶음이다. 기존 줄의 발견은 종료 코드에 넣지 않는다.
// --staged 의 출력은 다르다. 더한 줄의 발견 줄만 내고(경로는 저장소 루트 기준), 그 뒤에 금지어마다
// `권장 표현: "<금지어>" → <매핑 표의 권장 열>` 한 줄을 처음 나온 차례로 낸다. DB 문맥 패턴처럼 매핑 표에 행이 없는 발견은
// 발견 줄에 고칠 말이 있어 권장 표현 줄이 없다. 발견이 없으면 아무것도 내지 않는다. 훅이 그대로 내보내도 조용하다.
//
// 종료 코드:
//     0  이번 변경에 금지어, TILDE, DASH 가 없다. 경고와 기존 줄의 발견이 있어도 0 이다
//     1  이번 변경의 줄에 매핑 표 금지어, TILDE 또는 DASH 가 있다
//     2  돌지 못함. git 저장소가 아니거나 기준을 찾지 못했거나, 검사기가 돌지 못했다
//        (2 로 끝났거나, 띄우지 못했거나, 신호로 끝났거나, 잡지 않은 예외로 1 을 내며 죽었다. 판정은 checkerCode 다)
// --staged 도 같다. 다만 금지어 발견은 줄의 `: 금지어 "` 꼴로 알아본다. 경로에 그 낱말이 든 파일의 경고가 커밋 거절로 바뀌지 않게 한다.
//
// 한계: 가독성 검사기의 TILDE 발견은 단락의 첫 줄 번호로 나온다.
// 단락 중간에 더한 줄 때문에 걸려도 첫 줄이 기존 줄이면 「기존 줄」 로 분류된다.

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { isMain, write } from './io.ts'
import { loadAdvice, loadTerms, rulesPath } from './korean-style-check.ts'
import { pySplitLines, pyStrCompare, pyStrip } from './kit/py.ts'

const STYLE = join(import.meta.dirname, 'korean-style-check.ts')
const READABILITY = join(import.meta.dirname, 'check-readability.ts')

const HUNK = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/
// 두 검사기의 발견 줄은 「경로:줄번호:」 또는 「경로:줄번호  경고/실패」 로 시작한다.
const FINDING = /^(.+?):(\d+)[: ]/
const isFailure = (row: string) => BANNED_ROW.test(row) || /  실패 \[(?:TILDE|DASH)\]/.test(row)
// --staged 가 금지어 발견 줄을 알아보는 꼴. 낱말은 권장 표현 줄을 고르는 데 쓴다
const BANNED_ROW = /: 금지어 "([^"]+)"/
const ALLOW_FILE = join('.claude', 'korean-check-allow.txt')
const MAX_BUFFER = 256 * 1024 * 1024
const CHUNK = 200
const CRASHED = /^Node\.js v\d/m

const USAGE = 'usage: check-diff.ts [-h] [--base BASE] [--staged] [files ...]\n'
const HELP = `${USAGE}
git diff 로 이번에 더한 줄의 발견만 판정하고, 기존 줄의 발견은 따로 알린다.

positional arguments:
  files

options:
  -h, --help   show this help message and exit
  --base BASE
  --staged     스테이징한 .md 의 더한 줄만 본다(커밋 훅용)
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

// 검사기 자식의 결과를 0(통과), 1(금지어, TILDE 또는 DASH), 2(돌지 못함)로 맞춘다.
// 띄우지 못했거나 신호로 끝났거나 0, 1 이 아닌 코드는 돌지 못한 것이다. node 는 잡지 않은 예외에도 1 을 내므로,
// 1 인데 실패 발견 줄이 없으면 그것도 돌지 못한 것으로 본다. 죽은 검사기를 「발견 없음」 으로 읽으면 금지어가 조용히 지나간다.
// 앞 파일의 금지어를 낸 뒤 뒤 파일에서 죽은 경우도 있다. node 가 잡지 않은 예외 끝에 남기는 버전 줄(CRASHED)이 stderr 에 있으면 죽은 것이다.
export function checkerCode(done: { status: number | null; signal: string | null; error?: unknown; stderr?: string | null }, rows: string[]): number {
  if (done.error || done.signal || (done.status !== 0 && done.status !== 1)) return 2
  if (done.status === 1 && (!rows.some(isFailure) || CRASHED.test(done.stderr ?? ''))) return 2
  return done.status
}

// 경로를 CHUNK 개씩 나눠 넘긴다. 한 번에 넘기면 인자 길이 상한을 넘어 검사기를 띄우지 못한다
function runChecker(script: string, paths: string[], cwd?: string) {
  let code = 0
  const out: string[] = []
  let err = ''
  for (let at = 0; at < paths.length; at += CHUNK) {
    const done = spawnSync(process.execPath, [script, ...paths.slice(at, at + CHUNK)], { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER })
    const rows = pySplitLines((done.stdout ?? '').replace(/\r\n?/g, '\n'))
    code = Math.max(code, checkerCode(done, rows))
    out.push(...rows)
    err += done.stderr ?? ''
    if (done.error) err += `${(done.error as Error).message}\n`
  }
  return { code, out, err }
}

// argparse 가 옵션으로 읽는 글자인지. 음수처럼 보이는 것, 한 글자 `-`, 공백이 든 것은 값이다
function looksLikeOption(token: string): boolean {
  if (!token.startsWith('-') || token === '-') return false
  if (/^-\d+$|^-\d*\.\d+$/.test(token)) return false
  return !token.includes(' ')
}

type Parsed = { help: true } | { error: string } | { base: string; files: string[]; staged: boolean }

// argparse 와 같은 뜻으로 인자를 읽는다. 긴 옵션의 고유 접두, `--base=값`, `--` 를 받는다
function parseArgs(argv: string[]): Parsed {
  let base = 'HEAD'
  let baseGiven = false
  let staged = false
  const files: string[] = []
  const unrecognized: string[] = []
  const longs = ['base', 'help', 'staged']
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
    if (matches[0] === 'staged') {
      if (eq >= 0) return { error: 'argument --staged: ignored explicit argument' + ` '${token.slice(eq + 1)}'` }
      staged = true
      continue
    }
    baseGiven = true
    if (eq >= 0) base = token.slice(eq + 1)
    else if (i + 1 < argv.length && !looksLikeOption(argv[i + 1])) base = argv[++i]
    else return { error: 'argument --base: expected one argument' }
  }
  if (unrecognized.length) return { error: `unrecognized arguments: ${unrecognized.join(' ')}` }
  if (staged && (baseGiven || files.length)) return { error: 'argument --staged: not allowed with --base or files' }
  return { base, files, staged }
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
  if (parsed.staged) return checkStaged(root)

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
      write(2, err || `check-diff: 검사기가 돌지 못했다: ${script}\n`)
      return 2
    }
    for (const row of out) {
      const m = FINDING.exec(row)
      if (!m || !added.has(m[1])) continue
      const scope = added.get(m[1])
      if (scope === null || (scope as Set<number>).has(Number(m[2]))) {
        fresh.push(row)
        if (isFailure(row)) status = 1
      } else old.push(row)
    }
  }

  write(1, `## 이번 변경 (${base} 이후 더한 줄)\n${fresh.length ? fresh.join('\n') : '발견 없음'}\n\n## 기존 줄 (참고. 종료 코드에 넣지 않는다)\n${old.length ? old.join('\n') : '발견 없음'}\n`)
  return status
}

type Staged = { path: string; old: string | null; added: boolean }

// 인덱스에 더했거나 바꿨거나 이름을 바꿨거나 종류가 바뀐 .md. 경로는 저장소 루트 기준이다. 읽지 못하면 null
function stagedMarkdown(root: string): Staged[] | null {
  const done = spawnSync('git', ['diff', '--cached', '--name-status', '-z', '-M', '--diff-filter=AMRT', '--', '*.md'], { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER })
  if (done.status !== 0) return null
  // -z 출력은 「상태\0경로\0」 이고, 이름을 바꾼 항목은 「R<점수>\0옛 경로\0새 경로\0」 다
  const tokens = (done.stdout ?? '').split('\0')
  const found: Staged[] = []
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++]
    if (!status) continue
    const old = status.startsWith('R') ? tokens[i++] : null
    const path = tokens[i++]
    // 종류가 바뀐 항목(T, 심볼릭 링크가 일반 파일이 된 것)은 새 파일처럼 모든 줄을 본다
    if (path) found.push({ path, old, added: status.startsWith('A') || status.startsWith('T') })
  }
  return found
}

// 인덱스에서 일반 파일인 경로와 그 내용의 해시. 심볼릭 링크(120000)와 서브모듈(160000)의 내용은 문서가 아니다. 읽지 못하면 null
function regularEntries(root: string, paths: string[]): Map<string, string> | null {
  const regular = new Map<string, string>()
  for (let at = 0; at < paths.length; at += CHUNK) {
    const done = spawnSync('git', ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths.slice(at, at + CHUNK)], { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER })
    if (done.status !== 0) return null
    // 「모드 SP 해시 SP 단계 TAB 경로」
    for (const row of (done.stdout ?? '').split('\0')) {
      const tab = row.indexOf('\t')
      const m = /^100(?:644|755) ([0-9a-f]+) 0$/.exec(row.slice(0, Math.max(tab, 0)))
      if (m) regular.set(row.slice(tab + 1), m[1])
    }
  }
  return regular
}

// HEAD 와 인덱스 사이에서 더하거나 바꾼 줄 번호 집합. 이름을 바꾼 파일은 옛 경로와 함께 물어 바뀐 줄만 받는다
function stagedLines(root: string, item: Staged): Set<number> | null {
  const paths = item.old === null ? [item.path] : [item.old, item.path]
  // textconv 는 끈다. 변환한 글의 줄 번호는 검사기가 읽는 원문(readBlobs)의 줄 번호와 다르다
  const done = git(['--literal-pathspecs', 'diff', '--cached', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--', ...paths], root)
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

// 해시 차례대로 blob 의 바이트를 낸다. `git cat-file --batch` 의 출력은 항목마다 「해시 SP 종류 SP 크기 LF 내용 LF」 다. 읽지 못하면 null
// 해시는 CHUNK 개씩 나눠 넘긴다. 한 번에 받으면 내용의 합이 버퍼 상한을 넘을 수 있다
function readBlobs(root: string, hashes: string[]): Buffer[] | null {
  const blobs: Buffer[] = []
  for (let from = 0; from < hashes.length; from += CHUNK) {
    const part = hashes.slice(from, from + CHUNK)
    const done = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: part.map((hash) => `${hash}\n`).join(''), maxBuffer: MAX_BUFFER })
    if (done.status !== 0) return null
    const data = done.stdout as Buffer
    let at = 0
    for (const hash of part) {
      const end = data.indexOf(0x0a, at)
      if (end < 0) return null
      const [name, kind, size] = data.subarray(at, end).toString('utf8').split(' ')
      if (name !== hash || kind !== 'blob' || !/^\d+$/.test(size ?? '')) return null
      const start = end + 1
      blobs.push(data.subarray(start, start + Number(size)))
      at = start + Number(size) + 1
    }
  }
  return blobs
}

function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a, { bigint: true })
    const y = statSync(b, { bigint: true })
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

// 매핑 표를 가진 문서인가. 그 표가 곧 금지어 목록이라 검사하면 전부 위반으로 잡힌다.
// 훅은 검사기 사본의 규칙을 쓰므로 대상 저장소의 규칙 파일은 같은 파일(inode)이 아니다. 그래서 내용으로도 알아본다
function isRulesFile(path: string): boolean {
  try {
    return loadTerms(path).length > 0
  } catch {
    return false
  }
}

// 대상 파일의 폴더에서 저장소 루트까지 있는 예외 파일을 임시 폴더의 같은 자리에 복사한다
function copyAllowFiles(root: string, tmp: string, path: string, done: Set<string>): void {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    if (!done.has(dir)) {
      done.add(dir)
      const source = join(root, dir, ALLOW_FILE)
      if (isFile(source)) {
        mkdirSync(dirname(join(tmp, dir, ALLOW_FILE)), { recursive: true })
        copyFileSync(source, join(tmp, dir, ALLOW_FILE))
      }
    }
    if (dir === '.') return
  }
}

// 발견 줄이 가리키는 경로와 줄 번호. 넘긴 경로 가운데 줄 머리와 맞는 가장 긴 것을 고른다.
// 정규식으로 첫 `:<숫자>` 에서 끊으면 이름에 그 꼴이 든 파일의 발견을 버린다
function findingOf(row: string, paths: string[]): { path: string; line: number } | null {
  for (const path of paths) {
    if (!row.startsWith(`${path}:`)) continue
    const m = /^(\d+)[: ]/.exec(row.slice(path.length + 1))
    if (m) return { path, line: Number(m[1]) }
  }
  return null
}

// --staged 의 본체. 머리 주석의 「--staged」 가 동작을 소유한다
function checkStaged(root: string): number {
  const listed = stagedMarkdown(root)
  if (listed === null) return fail('스테이징된 파일을 읽지 못했다')
  const regular = regularEntries(root, listed.map((item) => item.path))
  if (regular === null) return fail('스테이징된 파일의 종류를 읽지 못했다')
  const rules = rulesPath()
  let items = listed.filter((item) => regular.has(item.path) && !sameFile(join(root, item.path), rules))
  if (!items.length) return 0

  const added = new Map<string, Set<number> | null>()
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'korean-check-staged-')))
  try {
    // 스테이징된 내용을 git 에 저장된 그대로 한 번에 읽는다. checkout-index 로 풀면 smudge 필터와 인코딩 변환을 타서
    // 커밋될 내용과 달라지거나 풀지 못한다. git 은 저장소 루트에서 부르고 임시 폴더에서는 부르지 않는다
    const blobs = readBlobs(root, items.map((item) => regular.get(item.path) as string))
    if (blobs === null) return fail('스테이징된 내용을 읽지 못했다')
    items.forEach((item, i) => {
      mkdirSync(dirname(join(tmp, item.path)), { recursive: true })
      writeFileSync(join(tmp, item.path), blobs[i])
    })
    items = items.filter((item) => !isRulesFile(join(tmp, item.path)))
    if (!items.length) return 0
    // 예외 파일 찾기는 .git 이 있는 폴더에서 멈춘다. 임시 폴더 밖으로 올라가지 않게 표시만 둔다
    mkdirSync(join(tmp, '.git'))
    const copied = new Set<string>()
    for (const item of items) {
      if (item.added) added.set(item.path, null) // null 은 모든 줄이 이번 변경이라는 뜻이다
      else {
        const lines = stagedLines(root, item)
        if (lines === null) return fail(`git diff 가 실패했다: ${item.path}`)
        added.set(item.path, lines)
      }
      copyAllowFiles(root, tmp, item.path, copied)
    }

    // 긴 경로부터 맞춰 본다. 한 경로가 다른 경로의 앞부분일 수 있다
    const paths = items.map((item) => item.path).sort((a, b) => b.length - a.length)
    const fresh: string[] = []
    for (const script of [STYLE, READABILITY]) {
      // 경로 앞에 ./ 를 붙여 넘긴다. - 로 시작하는 이름을 자식 검사기가 옵션으로 읽으면 그 커밋의 검사가 통째로 빠진다.
      // 발견 줄의 경로는 다시 저장소 루트 기준으로 되돌린다
      const { code, out, err } = runChecker(script, items.map((item) => `./${item.path}`), tmp)
      if (code === 2) {
        write(2, err || `check-diff: 검사기가 돌지 못했다: ${script}\n`)
        return 2
      }
      for (const row of out.map((line) => (line.startsWith('./') ? line.slice(2) : line))) {
        const found = findingOf(row, paths)
        if (!found) continue
        const scope = added.get(found.path)
        if (scope === null || (scope as Set<number>).has(found.line)) fresh.push(row)
      }
    }
    if (!fresh.length) return 0

    const terms = [...new Set(fresh.map((row) => BANNED_ROW.exec(row)?.[1]).filter((term): term is string => term !== undefined))]
    const advice = terms.length ? loadAdvice(rules) : new Map<string, string>()
    const hints = terms.filter((term) => advice.has(term)).map((term) => `권장 표현: "${term}" → ${advice.get(term)}`)
    write(1, `${[...fresh, ...hints].join('\n')}\n`)
    return fresh.some(isFailure) ? 1 : 0
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = await main(process.argv.slice(2))
