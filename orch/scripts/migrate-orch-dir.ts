// 옛 위치(.omc, .claude)에 있던 orch 파일을 orch 작업 폴더(.orch)로 옮긴다.
// --hooks 는 따로 도는 모드다. config.json 의 옛 셸 명령 칸을 같은 일을 하는 핸들러 파일(<orch 루트>/hooks/<이벤트>.ts)로 바꾼다.
//
// 기본은 미리보기다. 옮길 것, 겹치는 것, 옮긴 뒤 고칠 것, 옛 경로 참조, 막는 조건(stderr)을 보이고 아무것도 바꾸지 않는다.
// `--apply` 를 주면 옮기고 고친다. 다 끝난 뒤 다시 돌리면 「옮길 것이 없다」 로 끝난다.
//
// 사용법:
//     migrate-orch-dir.ts [--repo DIR] [--run RUN] [--move 옛=새 ...] [--apply]
//     migrate-orch-dir.ts --hooks [--repo DIR] [--run RUN] [--apply]
//
//     --repo   대상 저장소. 기본은 현재 디렉터리. 워크트리를 주어도 주 checkout 을 옮긴다
//     --run    살아 있는 dispatch 를 찾을 Orca Run. 없으면 설정(옛 위치나 새 위치)의 finish.run, 그것도 없으면 범위 없이 읽는다.
//              범위 없이 읽은 worker-list 가 모든 Run 의 목록(scope.source all)이 아니면 orca 조회 실패로 막는다(lib/spec.ts 의 liveSpecPaths)
//     --move   기본 쌍 밖의 옛 위치를 더한다. 두 경로 모두 주 checkout 기준 상대경로다. 여러 번 줄 수 있다.
//              예: --move .omc/handoffs/bin=.orch/bin
//     --hooks  옛 셸 명령 칸을 핸들러로 바꾼다. 아래 「--hooks」 다. --move 와 함께 주면 사용법 오류다
//     --apply  실제로 옮긴다(--hooks 면 핸들러를 쓰고 설정에서 그 키를 지운다)
//
// 옮기는 쌍: lib/paths.ts 의 DEFAULT_MOVES 다음에 --move 쌍을 차례로 본다.
//     폴더는 대상이 없으면 통째로 옮기고, 대상이 있으면 항목별로 합친다. 같은 이름이 있으면 덮지 않고 겹침으로 알린다.
//     파일이 하나도 없는 폴더는 옮기지 않고 지운다. 빈 새 폴더를 만들지 않기 위해서다.
//     앞의 쌍이 옮긴 것은 뒤의 쌍이 다시 옮기지 않는다(.omc/orch/scripts 가 .omc/orch 보다 먼저다).
//     board.json 은 work-board 소유라 어느 쌍으로도 옮기지 않는다.
//     git 이 추적하는 파일은 옮기지 않고 대상 폴더만 만든 뒤 `git mv` 명령을 보인다. 주 checkout 에 스테이징을 남기지 않기 위해서다.
//     상대경로 심볼릭 링크가 옮긴 폴더 밖을 가리키면 새 자리에서 같은 대상을 가리키게 다시 만든다.
//
// 옮긴 뒤 고치는 것 (옮길 것이 없어도 --apply 마다 한다. 중간에 멈춘 뒤 다시 돌려도 남지 않는다):
//     - orch 작업 폴더의 .md, .json 파일(bin 아래는 빼고) 안의 옛 경로를 새 경로로 바꾼다. 지시서, PR 본문, 설정, 오버레이가 여기 해당한다
//     - 설정(config.json)의 cleanup 절: 옛 키 omc, handoffs 를 지운다. .omc/previews 가 있고 previews 키가 없으면
//       ".omc/previews" 를 써 넣어 미리보기 정리를 이어 간다. 설정 파일이 없으면 그 값만 담아 새로 만든다
//     - git 이 orch 작업 폴더를 무시하게 한다(lib/paths.ts 의 ensureIgnored)
//     - 옛 위치(쌍의 옛 경로와 lib/paths.ts 의 LEGACY_MARKERS)에 남은 빈 폴더를 지운다. .omc 와 .claude 자체는 남긴다
//
// 바꾸지 않고 보이기만 하는 것: 옛 경로를 적은 추적 파일(git grep), 추적하지 않는 .claude(worktrees 는 빼고),
// .omc/handoffs, .omc/orch 아래 파일, 옮긴 스크립트(bin). 큐 로그(.out, .pid, .log)는 보지 않는다. 그 파일은 저장소가 고친다.
// 스크립트의 참조에는 「다시 만들 수 있다」 를 붙인다. 옮긴 포장 스크립트가 옛 폴더를 다시 만들면 진입점이 다시 멈춘다.
//
// 막는 조건 (옮길 것이 있을 때 --apply 를 거부하고 종료 코드 3. --hooks 도 같다):
//     - 살아 있는 dispatch 가 있다. worker_done 뒤에도 이 저장소 워크트리의 터미널을 쥔(owned, active) worker 가 있다
//     - orca 로 그 목록을 읽지 못했다
//     - 머지 큐나 마무리(merge-queue, merge_queue, merge-with-finish, finish-pr 의 .sh, .py, .ts)가 돌고 있다.
//       옮긴 명령은 옛 .py 경로로 띄워도 ps 의 명령줄이 `node … <이름>.ts` 라 확장자를 가리지 않고 찾는다.
//       pgrep 을 돌리지 못해도 막는다
//     worker 는 지시서를 절대경로로 읽고, 머지 큐는 옛 폴더에 로그를 쓰므로 그 사이에 옮기면 끊긴다.
//
// --hooks: 폴더 옮기기와 따로 돈다. 둘을 한 번에 하면 중간에 멈췄을 때 어느 쪽이 끝났는지 가리기 어렵다.
//     1. 옛 위치가 남아 있으면(lib/paths.ts 의 legacyPaths) 아무것도 고치지 않고 「먼저 --hooks 없이 --apply 로 폴더를 옮긴다」 를 내고 2 다
//     2. <orch 루트>/config.json 의 아래 키를 읽어 만들 핸들러를 정한다. 옮길 것이 없으면 「옮길 칸이 없다」 를 내고 0 이다
//          queue.before                          hooks/before-merge.ts   PR, BRANCH, OWNER, REPO, GH_HOST 를 채워 bash -c
//          queue.verify_merged                   hooks/verify-merged.ts  위에 더해 TMPDIR(실경로), MERGE_COPY, PR_HEAD, BASE_HEAD,
//                                                                        CHANGED_FILES, OVERLAP_FILES 를 채워 사본에서
//                                                                        bash -c <명령> verify-merged <사본>. verify_merged_when 은 남긴다
//          queue.after_merged                    hooks/after-queue.ts    MERGED_PRS, CODE_PRS(공백으로 잇는다)를 채워 bash -c
//          finish.complete_cmd, task_pattern     hooks/after-deploy.ts   last_of_task 이고 deploy 가 success 나 none 일 때만 돈다.
//                                                                        pr.title 에서 번호를 뽑아 NUMBER_OK 로 검사하고, 셸 없이 인자 목록으로 돌린다
//        만든 핸들러는 머지 큐와 finish-pr 이 옛 칸을 돌리던 것과 같은 argv, 환경 변수, 작업 디렉터리, stdin 으로 옛 명령을 부르고
//        그 종료 코드로 끝난다. 작업 디렉터리는 verify-merged 가 사본이고, 나머지는 부른 명령이 --repo 로 받은 경로(ORCH_CHECKOUT)다.
//        핸들러 자신은 주 checkout 에서 돌지만, 옛 칸은 연결된 워크트리를 --repo 로 주면 그 워크트리에서 돌았기 때문이다.
//        사용자 저장소에 남고 설치 캐시의 경로가 바뀌므로 이 스킬의 lib/ 를 import 하지 않는다.
//        after-deploy.ts 의 정규식은 lib/py.ts 의 pyRegExp 로 바꾼 결과를, 인자 목록은 shSplit 으로 나눈 결과를 파일에 적는다
//     3. --apply 이고 옮길 것이 있으면 위 막는 조건을 본다. 하나라도 있으면 `막음 <이유>` 를 stderr 에 내고 3 이다
//     4. 핸들러 파일을 쓰고 쓴 키만 설정에서 지운다. 설정의 나머지 키와 순서는 그대로 둔다. 비게 된 절도 남긴다.
//        설정 파일이나 hooks/ 를 git 이 추적하면 `git add -f` 명령을 보인다. 공개 저장소에 올리면 안 되는 값이 있을 수 있어 커밋하지 않는다
//     옮기지 못하는 칸은 설정에 남기고 이유를 보인다(종료 코드 1). 다른 칸은 옮긴다.
//       - 같은 이름의 핸들러 파일이 이미 있다(겹침). 덮지 않는다
//       - 값이 비지 않은 문자열이 아니다
//       - complete_cmd 와 task_pattern 가운데 하나만 있다, complete_cmd 를 나누지 못하거나 {number} 가 없다
//       - task_pattern 을 JS 정규식으로 바꾸지 못했거나 그룹이 없다. JS 정규식으로 고쳐 task_pattern 에 다시 적고 다시 돌린다
//
// 종료 코드: 0 옮겼거나 옮길 것이 없다, 1 겹침이 있거나 추적 파일이 남았거나 옮기다 실패했다(겹침이 있으면 아무것도 옮기지 않는다),
//            --hooks 면 옮기지 못한 칸이 있다, 2 사용법 오류(--hooks 에서 옛 위치가 남았거나 설정 파일이 깨졌다), 3 막는 조건이 있다
//
// GIT, ORCA, PGREP 환경 변수로 실행 파일을 바꾼다.

import {
  accessSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { inside, isFile, real, realPath } from './lib/fs.ts'
import { mainCheckout } from './lib/git.ts'
import { orcaJson } from './lib/orca.ts'
import { DEFAULT_MOVES, ensureIgnored, hasFiles, LEGACY_MARKERS, legacyPaths, NAMES, orchDir, pathOf } from './lib/paths.ts'
import { run } from './lib/proc.ts'
import { pyRegExp, pyStr, shSplit } from './lib/py.ts'
import { LINE_BREAK, liveSpecPaths } from './lib/spec.ts'

const SCRIPT = fileURLToPath(import.meta.url)
const ACTIVE = new Set(['pending', 'dispatched', 'running'])
// pgrep -f 의 확장 정규식이다. 옮긴 명령은 ps 의 명령줄이 `node … <이름>.ts` 이고, merge-queue.sh 는 남은 옛 경로다
const BUSY = '(merge-queue|merge_queue|merge-with-finish|finish-pr)\\.(sh|py|ts)'
const REWRITE_SUFFIXES = new Set(['.md', '.json'])
const LOG_SUFFIXES = new Set(['.out', '.pid', '.log', '.tmp'])
const SCRIPT_SUFFIXES = new Set(['.sh', '.py', '.ts', '.js', '.cjs', '.mjs'])
// 추적하지 않아 git grep 이 못 보는 곳. 옮기지 않는 포장 스크립트와 로컬 설정이 옛 경로를 적고 있을 수 있다
const LOCAL_DIRS = ['.claude', '.omc/handoffs', '.omc/orch']
// LOCAL_DIRS 아래에서도 보지 않는 폴더. 다른 체크아웃이 들어 있다
const LOCAL_SKIP = new Set(['worktrees'])
const KEEP_DIRS = new Set(['.omc', '.claude'])
const PREVIEWS = '.omc/previews'
const SHOWN_REFS = 60
const PAGE_LIMIT = '100'
// finish-pr.ts 의 NUMBER_OK 와 같다. 만든 after-deploy.ts 에 그대로 적는다
const NUMBER_OK = '^[A-Za-z0-9._/-]+$'

class Usage extends Error {}

type Pair = [string, string]

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

function gitBin(): string {
  return process.env.GIT || 'git'
}

function git(root: string, args: string[]): { code: number; stdout: string } {
  return run([gitBin(), '-C', root, ...args])
}

// ---- 경로 ---------------------------------------------------------------------------------------------

function rel(target: string, root: string): string {
  return relative(root, target) || '.'
}

// target 이 dir 의 아래인지. dir 자신은 아니다
function under(target: string, dir: string): boolean {
  return target !== dir && inside(target, dir)
}

// 경로를 낱말 목록으로 비교한다. Python 의 Path 정렬과 같다(`a/b` 가 `a-b` 보다 앞이다)
function byParts(a: string, b: string): number {
  const x = a.split(sep)
  const y = b.split(sep)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  }
  return x.length - y.length
}

function depth(target: string): number {
  return target.split(sep).length
}

function exists(target: string): boolean {
  return existsSync(target)
}

function isLink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

function lexists(target: string): boolean {
  return exists(target) || isLink(target)
}

function isDir(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

function realDir(target: string): boolean {
  return isDir(target) && !isLink(target)
}

// 폴더 아래 모든 항목. 심볼릭 링크 폴더 안으로는 들어가지 않는다. 읽지 못하는 폴더는 건너뛴다
function walk(dir: string): string[] {
  const found: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    found.push(full)
    if (entry.isDirectory()) found.push(...walk(full))
  }
  return found
}

function parentsOf(target: string): string[] {
  const found: string[] = []
  let at = dirname(target)
  for (;;) {
    found.push(at)
    const up = dirname(at)
    if (up === at) return found
    at = up
  }
}

// UTF-8 로 읽는다. 바이트가 UTF-8 이 아니거나 읽지 못하면 null 이다
function readText(target: string): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(target))
  } catch {
    return null
  }
}

// Python 의 str.splitlines 와 같다. 끝의 빈 줄은 줄로 세지 않는다
function splitLines(text: string): string[] {
  const lines = text.split(LINE_BREAK)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 덮어쓰다 멈춰도 설정 파일이 반쯤 쓰인 채 남지 않게 옆에 쓴 뒤 바꾼다
function writeJson(target: string, value: unknown): void {
  const temp = `${target}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, target)
}

// ---- 계획 -----------------------------------------------------------------------------------------------

type Plan = {
  root: string
  orch: string
  pairs: Pair[] // 설정된 쌍 전부. 옛 경로 문자열을 바꿀 때도 쓴다
  moves: Pair[] // 실제로 옮길 것
  conflicts: Pair[] // 대상이 이미 있다
  tracked: Pair[] // git 이 추적한다
  boards: string[] // 건너뛴 board.json
  claimed: string[]
}

// 앞 단계가 target 자리에 옮겨 놓을 원본. 없으면 null
function plannedSource(plan: Plan, target: string): string | null {
  for (const [src, dst] of plan.moves) {
    if (target === dst) return src
    if (under(target, dst)) return join(src, relative(dst, target))
  }
  return null
}

function planExists(plan: Plan, target: string): boolean {
  const source = plannedSource(plan, target)
  return exists(target) || (source !== null && exists(source))
}

function planIsDir(plan: Plan, target: string): boolean {
  const source = plannedSource(plan, target)
  return isDir(target) || (source !== null && isDir(source))
}

function claimedByEarlier(plan: Plan, target: string): boolean {
  return plan.claimed.some((c) => target === c || under(target, c))
}

function holdsClaimOrBoard(plan: Plan, target: string): boolean {
  return plan.claimed.some((c) => under(c, target)) || walk(target).some((p) => basename(p) === 'board.json')
}

function trackedFiles(root: string): Set<string> {
  const done = git(root, ['ls-files', '-z'])
  if (done.code !== 0) return new Set()
  return new Set(done.stdout.split('\0').filter((f) => f).map((f) => join(root, f)))
}

function expand(plan: Plan, src: string, dst: string, tracked: Set<string>): void {
  if (claimedByEarlier(plan, src) || !lexists(src)) return
  if (basename(src) === 'board.json') {
    plan.boards.push(src)
    plan.claimed.push(src)
    return
  }
  if (realDir(src)) {
    const innerTracked = [...tracked].some((t) => under(t, src))
    if (!hasFiles(src)) {
      // 빈 폴더는 옮기지 않고 마무리에서 지운다
    } else if (planExists(plan, dst) && !planIsDir(plan, dst)) {
      plan.conflicts.push([src, dst])
    } else if (planExists(plan, dst) || innerTracked || holdsClaimOrBoard(plan, src)) {
      for (const name of readdirSync(src).sort()) expand(plan, join(src, name), join(dst, name), tracked)
    } else {
      plan.moves.push([src, dst])
    }
  } else if (planExists(plan, dst)) {
    plan.conflicts.push([src, dst])
  } else if (tracked.has(src)) {
    plan.tracked.push([src, dst])
  } else {
    plan.moves.push([src, dst])
  }
  plan.claimed.push(src)
}

function makePlan(root: string, orch: string, extra: Pair[]): Plan {
  const pairs: Pair[] = DEFAULT_MOVES.map(([old, now]) => [join(root, old), now ? join(orch, now) : orch])
  for (const [old, now] of extra) pairs.push([join(root, old), join(root, now)])
  const plan: Plan = { root, orch, pairs, moves: [], conflicts: [], tracked: [], boards: [], claimed: [] }
  const tracked = trackedFiles(root)
  for (const [src, dst] of pairs) expand(plan, src, dst, tracked)
  return plan
}

// ---- 옛 경로 문자열 -------------------------------------------------------------------------------------

// [바꾸는 정규식(g), 줄 검사용 정규식, 새 문자열]. 검사용은 g 가 없어 lastIndex 가 남지 않는다
type Rule = [RegExp, RegExp, string]

// 경로 앞뒤에 이어지면 경로의 일부로 보는 글자. Python 의 [\w.-] 처럼 한글도 글자로 본다
const PATH_CHAR = '[\\p{L}\\p{N}\\p{M}_.-]'

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
}

// (정규식, 새 문자열). 긴 옛 경로부터 바꾼다. 상대경로와 절대경로를 함께 다룬다
function replacements(plan: Plan): Rule[] {
  const pairs = new Map<string, string>()
  for (const [src, dst] of [...plan.pairs, ...plan.moves, ...plan.tracked]) {
    pairs.set(rel(src, plan.root), rel(dst, plan.root))
    pairs.set(src, dst)
  }
  const ordered = [...pairs.entries()].sort((a, b) => b[0].length - a[0].length)
  return ordered.map(([old, now]) => {
    const source = `(?<!${PATH_CHAR})${escapeRegExp(old)}(?!${PATH_CHAR})`
    return [new RegExp(source, 'gu'), new RegExp(source, 'u'), now]
  })
}

function rewrite(text: string, rules: Rule[]): [string, number] {
  let count = 0
  for (const [pattern, , now] of rules) {
    text = text.replace(pattern, () => {
      count += 1
      return now
    })
  }
  return [text, count]
}

// 옮긴 뒤 내용을 고치는 파일인지. orch 작업 폴더 안의 .md, .json 이고 스크립트(bin 아래)는 아니다
function willRewrite(target: string, orch: string): boolean {
  if (!REWRITE_SUFFIXES.has(extname(target)) || !under(target, orch)) return false
  return !relative(orch, target).split(sep).slice(0, -1).includes('bin')
}

// target 이 이번에 옮겨질 파일이면 옮긴 뒤의 자리, 아니면 null
function afterMove(target: string, plan: Plan): string | null {
  for (const [src, dst] of plan.moves) {
    if (target === src) return dst
    if (under(target, src)) return join(dst, relative(src, target))
  }
  return null
}

function executable(target: string): boolean {
  try {
    accessSync(target, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function isScript(target: string): boolean {
  return SCRIPT_SUFFIXES.has(extname(target)) || target.split(sep).slice(0, -1).includes('bin') || (isFile(target) && executable(target))
}

function localFiles(folder: string): string[] {
  if (!isDir(folder)) return []
  return walk(folder).filter((p) => isFile(p) && !relative(folder, p).split(sep).slice(0, -1).some((part) => LOCAL_SKIP.has(part)))
}

type Ref = { path: string; no: number; line: string }

// 옛 경로를 적은 곳. 추적 파일, LOCAL_DIRS 아래, 옮길 파일 안을 본다. orch 작업 폴더 안의 파일은 마무리 단계가 따로 보인다
function references(plan: Plan, rules: Rule[]): Ref[] {
  const files = new Set<string>()
  const olds = plan.pairs.map(([src]) => rel(src, plan.root))
  const grep = git(plan.root, ['grep', '-l', '-I', '-F', ...olds.flatMap((o) => ['-e', o])])
  if (grep.code === 0) for (const f of grep.stdout.split('\n')) if (f) files.add(join(plan.root, f))
  for (const local of LOCAL_DIRS) for (const f of localFiles(join(plan.root, local))) files.add(f)
  for (const [src] of plan.moves) {
    if (isDir(src)) for (const f of localFiles(src)) files.add(f)
    else files.add(src)
  }
  const found: Ref[] = []
  for (const target of [...files].sort(byParts)) {
    if (LOG_SUFFIXES.has(extname(target)) || under(target, plan.orch)) continue
    const text = readText(target)
    if (text === null) continue
    splitLines(text).forEach((line, i) => {
      if (rules.some(([, pattern]) => pattern.test(line))) found.push({ path: target, no: i + 1, line: line.trim() })
    })
  }
  return found
}

// ---- 막는 조건 ------------------------------------------------------------------------------------------

function worktreePaths(root: string): Set<string> {
  const done = git(root, ['worktree', 'list', '--porcelain'])
  const paths = new Set<string>([root])
  if (done.code === 0) {
    for (const line of done.stdout.split('\n')) if (line.startsWith('worktree ')) paths.add(realPath(line.slice('worktree '.length)))
  }
  return paths
}

// worker-list 를 모든 페이지에 걸쳐 읽는다. 첫 페이지만 읽으면 다른 worker 를 놓친다(lib/orca.ts 머리 주석). 실패하면 null
function workerRows(runId: string | null): Record<string, unknown>[] | null {
  const rows: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  for (let first = true; first || cursor !== null; first = false) {
    const args = ['orchestration', 'worker-list', ...(runId ? ['--run', runId] : []), '--limit', PAGE_LIMIT, ...(cursor ? ['--cursor', cursor] : [])]
    const got = orcaJson<{ workers?: unknown; page?: { nextCursor?: unknown } }>(args)
    if (!got.ok || !isObject(got.data)) return null
    const list = got.data.workers
    if (Array.isArray(list)) for (const row of list) if (isObject(row)) rows.push(row)
    const next = got.data.page?.nextCursor
    cursor = typeof next === 'string' && next ? next : null
    if (cursor !== null) {
      if (seen.has(cursor)) return null
      seen.add(cursor)
    }
  }
  return rows
}

function blockers(root: string, runId: string | null): string[] {
  const found: string[] = []
  const live = liveSpecPaths(runId)
  const workers = live === null ? null : workerRows(runId)
  if (live === null || workers === null) {
    found.push(`orca 로 살아 있는 dispatch 와 worker 를 읽지 못했다${runId ? '' : '(--run 이 없으면 모든 Run 의 목록을 읽어야 한다)'}`)
  } else {
    if (live.size > 0) found.push(`살아 있는 dispatch 가 지시서 ${live.size}개를 쓰고 있다`)
    const trees = worktreePaths(root)
    const held: string[] = []
    for (const w of workers) {
      const res = isObject(w.resource) ? w.resource : {}
      const id = String(res.worktreeId || '')
      const at = id.indexOf('::')
      const tree = realPath((at >= 0 ? id.slice(at + 2) : id) || '/nonexistent')
      const busy = ACTIVE.has(String(w.dispatchStatus)) || (w.terminalState === 'active' && res.ownershipState === 'owned')
      if (busy && trees.has(tree)) held.push(String(w.dispatchId || w.taskId || '?'))
    }
    if (held.length > 0) found.push(`이 저장소 워크트리의 터미널을 쥔 worker 가 있다: ${held.join(', ')}`)
  }
  const done = run([process.env.PGREP || 'pgrep', '-fl', BUSY])
  if (done.code === 0 && done.stdout.trim()) {
    const lines = done.stdout.split('\n').filter((l) => l.trim()).slice(0, 5)
    found.push(`머지 큐나 마무리가 돌고 있다: ${lines.map((l) => l.trim()).join('; ')}`)
  } else if (done.code !== 0 && done.code !== 1) {
    found.push(`pgrep 으로 머지 큐와 마무리 프로세스를 확인하지 못했다(종료 코드 ${done.code})`)
  }
  return found
}

// ---- 옮기기 ---------------------------------------------------------------------------------------------

// src(파일이나 폴더) 안의 상대경로 심볼릭 링크 중 src 밖을 가리키는 것: [링크, 절대 대상]
function outwardLinks(src: string): Pair[] {
  const links = isLink(src) ? [src] : isDir(src) ? walk(src).filter(isLink) : []
  const found: Pair[] = []
  for (const link of links) {
    const target = readlinkSync(link)
    if (isAbsolute(target)) continue
    const absolute = normalize(join(dirname(link), target))
    if (realDir(src) && (absolute === src || under(absolute, src))) continue
    found.push([link, absolute])
  }
  return found
}

function move(src: string, dst: string, root: string): void {
  const links = outwardLinks(src)
  mkdirSync(dirname(dst), { recursive: true })
  try {
    renameSync(src, dst)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    // 다른 파일 시스템이면 복사한 뒤 원본을 지운다. 원본을 못 지웠으면 사본을 거둬 다시 돌릴 때 겹치지 않게 한다
    try {
      cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
      rmSync(src, { recursive: true })
    } catch (inner) {
      if (lexists(src) && lexists(dst)) rmSync(dst, { recursive: true, force: true })
      throw inner
    }
  }
  for (const [link, absolute] of links) {
    const fresh = link === src ? dst : join(dst, relative(src, link))
    unlinkSync(fresh)
    symlinkSync(relative(dirname(fresh), absolute), fresh)
  }
  out(`옮김 ${rel(src, root)} -> ${rel(dst, root)}`)
}

// [새 설정, 설명 목록]. 바꿀 것이 없으면 [null, []]
function configChanges(configPath: string, root: string): [Record<string, unknown> | null, string[]] {
  const found = isFile(configPath)
  let config: unknown = {}
  if (found) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      return [null, []]
    }
  }
  if (!isObject(config) || (config.cleanup !== undefined && !isObject(config.cleanup))) return [null, []]
  const cleanup: Record<string, unknown> = { ...((config.cleanup as Record<string, unknown> | undefined) ?? {}) }
  const notes: string[] = []
  for (const key of ['omc', 'handoffs']) {
    if (Object.hasOwn(cleanup, key)) {
      notes.push(`cleanup.${key} 를 지운다(${pyStr(cleanup[key])})`)
      delete cleanup[key]
    }
  }
  if (isDir(join(root, PREVIEWS)) && !Object.hasOwn(cleanup, 'previews')) {
    cleanup.previews = PREVIEWS
    notes.push(`cleanup.previews 에 ${PREVIEWS} 를 넣는다${found ? '' : '. 설정 파일을 새로 만든다'}`)
  }
  if (notes.length === 0) return [null, []]
  if (Object.keys(cleanup).length > 0) return [{ ...config, cleanup }, notes]
  const rest = { ...config }
  delete rest.cleanup
  return [rest, notes]
}

// 지울 빈 옛 폴더. 깊은 것부터
function emptyDirs(plan: Plan): string[] {
  const starts = new Set<string>([...plan.pairs.map(([src]) => src), ...LEGACY_MARKERS.map((m) => join(plan.root, m))])
  const found = new Set<string>()
  for (const start of starts) {
    if (realDir(start) && !hasFiles(start)) {
      for (const p of walk(start)) if (isDir(p)) found.add(p)
      found.add(start)
    }
  }
  return [...found].sort(byParts).sort((a, b) => depth(b) - depth(a))
}

// 옮긴 뒤 고치는 것. 미리보기면 할 일을 보이기만 한다. 한 일(할 일)이 있으면 true
function finish(plan: Plan, rules: Rule[], apply: boolean): boolean {
  let did = false
  const orch = plan.orch
  const files = isDir(orch) ? walk(orch).filter(isFile).sort(byParts) : []
  for (const target of files) {
    if (!willRewrite(target, orch)) continue
    const text = readText(target)
    if (text === null) continue
    const [fresh, count] = rewrite(text, rules)
    if (count > 0) {
      did = true
      if (apply) writeFileSync(target, fresh, 'utf8')
      out(`${apply ? '옛 경로를 바꿈' : '바꿀 옛 경로'} ${rel(target, plan.root)} ${count}곳`)
    }
  }
  const configPath = join(orch, NAMES.config)
  const [config, notes] = configChanges(configPath, plan.root)
  if (notes.length > 0) {
    did = true
    if (apply) {
      mkdirSync(dirname(configPath), { recursive: true })
      writeJson(configPath, config)
    }
    for (const note of notes) out(`설정 ${note}`)
  }
  if (apply && exists(orch)) {
    const line = ensureIgnored(plan.root)
    if (line) {
      did = true
      out(`git 이 무시하게 했다: ${line}`)
    }
  }
  for (const folder of emptyDirs(plan)) {
    did = true
    if (apply) rmdirSync(folder)
    out(`${apply ? '빈 폴더를 지움' : '지울 빈 폴더'} ${rel(folder, plan.root)}`)
  }
  if (apply) pruneParents(plan)
  return did
}

// 옮긴 옛 경로의 부모 중 비게 된 폴더를 지운다. .omc, .claude 와 저장소 루트에서 멈춘다
function pruneParents(plan: Plan): void {
  const sources = [...plan.moves, ...plan.tracked].map(([src]) => src).sort((a, b) => depth(b) - depth(a))
  for (const src of sources) {
    for (const folder of parentsOf(src)) {
      if (folder === plan.root || !under(folder, plan.root) || KEEP_DIRS.has(basename(folder))) break
      if (!isDir(folder) || readdirSync(folder).length > 0) break
      rmdirSync(folder)
      out(`빈 폴더를 지움 ${rel(folder, plan.root)}`)
    }
  }
}

// 옮긴다. 실패하면 그때까지 옮긴 것을 보이고 false
function applyMoves(plan: Plan): boolean {
  for (const [src, dst] of plan.moves) {
    try {
      move(src, dst, plan.root)
    } catch (e) {
      err(`옮기다 실패했다 ${rel(src, plan.root)} -> ${rel(dst, plan.root)}: ${(e as Error).message}`)
      err('위의 「옮김」 줄까지 옮겼다. 원인을 고친 뒤 다시 돌리면 남은 것을 옮긴다')
      return false
    }
  }
  for (const [, dst] of plan.tracked) mkdirSync(dirname(dst), { recursive: true })
  return true
}

function gitMvCommand(src: string, dst: string, root: string): string {
  return `mkdir -p ${dirname(dst)} && git -C ${root} mv ${rel(src, root)} ${rel(dst, root)}`
}

function report(plan: Plan, refs: Ref[]): void {
  for (const [src, dst] of plan.moves) out(`옮길 것 ${rel(src, plan.root)} -> ${rel(dst, plan.root)}`)
  for (const [src, dst] of plan.conflicts) {
    out(`겹침 ${rel(src, plan.root)} -> ${rel(dst, plan.root)} 이 이미 있다. 둘을 비교해 하나만 남긴 뒤 다시 돌린다`)
  }
  for (const [src, dst] of plan.tracked) {
    out(`추적 파일 ${gitMvCommand(src, dst, plan.root)}  (옮겨 커밋한다. .orch 는 무시되므로 새 파일은 git add -f 로 더한다)`)
  }
  for (const board of plan.boards) out(`남김 ${rel(board, plan.root)} (보드는 work-board 소유라 옮기지 않는다)`)
  for (const { path: target, no, line } of refs.slice(0, SHOWN_REFS)) {
    const movedTo = afterMove(target, plan)
    let mark = '옛 경로 참조'
    if (movedTo !== null && willRewrite(movedTo, plan.orch)) mark = '바꿀 옛 경로'
    else if (isScript(movedTo ?? target)) mark = '옛 경로 참조(스크립트. 옛 폴더를 다시 만들 수 있어 옮긴 뒤 고친다)'
    // 글자 단위로 자른다. 한글이 둘로 갈리지 않게 한다
    out(`${mark} ${rel(target, plan.root)}:${no}: ${Array.from(line).slice(0, 160).join('')}`)
  }
  if (refs.length > SHOWN_REFS) out(`옛 경로 참조 ${refs.length - SHOWN_REFS}곳 더 있다`)
}

// ---- 진입점 --------------------------------------------------------------------------------------------

// 경로 낱말. `.` 은 Python 의 Path 처럼 버린다
function pathParts(part: string): string[] {
  return part.split('/').filter((p) => p && p !== '.')
}

function startsWith(parts: string[], prefix: string[]): boolean {
  return prefix.length <= parts.length && prefix.every((p, i) => parts[i] === p)
}

function parseMove(value: string): Pair {
  const eq = value.indexOf('=')
  const old = (eq >= 0 ? value.slice(0, eq) : value).trim().replace(/\/+$/, '')
  const now = (eq >= 0 ? value.slice(eq + 1) : '').trim().replace(/\/+$/, '')
  if (eq < 0 || !old || !now) throw new Usage(`--move: 옛=새 꼴이 아니다: ${value}`)
  for (const part of [old, now]) {
    const parts = pathParts(part)
    if (isAbsolute(part) || parts.includes('..') || parts.includes('.git') || part === '.' || part === './') {
      throw new Usage(`--move: 주 checkout 안의 상대경로여야 하고 ., .., .git 을 쓰지 않는다: ${part}`)
    }
  }
  if (old === now || startsWith(pathParts(now), pathParts(old)) || startsWith(pathParts(old), pathParts(now))) {
    throw new Usage(`--move: 한쪽이 다른 쪽 안에 있다: ${value}`)
  }
  return [old, now]
}

// 설정 파일의 finish.run. 옮기기 전이면 옛 위치에서 읽는다
function configuredRun(root: string): string | null {
  for (const target of [pathOf('config', root), join(root, '.claude/orch-finish.json')]) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(target, 'utf8'))
    } catch {
      continue
    }
    if (!isObject(parsed)) continue
    const section = parsed.finish ?? {}
    if (!isObject(section)) continue
    if (typeof section.run === 'string' && section.run) return section.run
  }
  return null
}

function migrateFolders(repo: string, runId: string | null, extra: Pair[], apply: boolean): number {
  const root = mainCheckout(repo)
  const orch = orchDir(root)
  for (const [old] of [...DEFAULT_MOVES, ...extra]) {
    const legacy = join(root, old)
    if (orch === legacy || under(orch, legacy)) {
      err(`orch 작업 폴더(${orch})가 옛 위치 ${old} 안이다. ORCH_DIR 을 바꾼다`)
      return 2
    }
  }
  const plan = makePlan(root, orch, extra)
  const rules = replacements(plan)
  report(plan, references(plan, rules))
  const pending = plan.moves.length > 0 || plan.conflicts.length > 0 || plan.tracked.length > 0
  const found = plan.moves.length > 0 ? blockers(root, runId ?? configuredRun(root)) : []
  for (const reason of found) err(`막음 ${reason}`)
  if (!apply) {
    const did = finish(plan, rules, false)
    if (!pending && !did) out('옮길 것이 없다')
    return plan.conflicts.length > 0 || plan.tracked.length > 0 ? 1 : 0
  }
  if (plan.conflicts.length > 0) {
    err('겹침이 있어 아무것도 옮기지 않았다')
    return 1
  }
  if (found.length > 0) {
    err('worker 와 머지 큐가 끝난 뒤 다시 돌린다')
    return 3
  }
  if (!applyMoves(plan)) return 1
  const did = finish(plan, rules, true)
  if (!pending && !did) out('옮길 것이 없다')
  return plan.tracked.length > 0 ? 1 : 0
}

// ---- --hooks --------------------------------------------------------------------------------------------

type HookWrite = { event: string; keys: [string, string][]; file: string; body: string }

// 만든 핸들러가 옛 명령을 띄우고 그 종료 코드로 끝나는 부분. 이벤트 실행기(lib/events.ts)가 옛 칸을 돌릴 때와 같게
// stdin 의 입력을 옛 명령에 그대로 넘기고, 시그널로 죽으면 128 + 신호 번호, 띄우지 못하면 127(없음)이나 1 이다.
// 옛 명령이 stdin 을 읽기 전에 끝나면 EPIPE 가 붙지만 종료 코드는 채워지므로 실패로 보지 않는다
const HANDLER_RUN = `function runOld(argv: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): number {
  const done = spawnSync(argv[0], argv.slice(1), { input: raw, stdio: ['pipe', 'inherit', 'inherit'], env: opts.env ?? process.env, cwd: opts.cwd })
  if (done.error && (done.error as NodeJS.ErrnoException).code !== 'EPIPE') {
    process.stderr.write(\`\${argv[0]} 를 실행하지 못했다: \${done.error.message}\\n\`)
    return (done.error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1
  }
  if (done.signal) return 128 + ((constants.signals as Record<string, number>)[done.signal] ?? 0)
  return done.status ?? 1
}`

function handlerHead(keys: string[], what: string, fsNames: string[] = ['readFileSync']): string {
  return [
    `// migrate-orch-dir --hooks 가 ${keys.map((k) => `\`${k}\``).join(', ')} 에서 만들었다.`,
    `// ${what}`,
    '// 옛 칸을 돌리던 것과 같은 argv, 환경 변수, 작업 디렉터리로 옛 명령을 부르고 그 종료 코드로 끝난다. stdin 의 입력도 그대로 넘긴다.',
    '// 이 파일은 저장소의 것이라 고쳐 써도 된다. 설치 캐시의 경로가 바뀌므로 orch 스킬의 모듈을 import 하지 않는다.',
    '',
    "import { spawnSync } from 'node:child_process'",
    `import { ${fsNames.join(', ')} } from 'node:fs'`,
    "import { constants } from 'node:os'",
    '',
    "const raw = readFileSync(0, 'utf8')",
    'const input = JSON.parse(raw)',
    'const pr = input.pr ?? {}',
    '',
    HANDLER_RUN,
    '',
  ].join('\n')
}

// 옛 칸이 돌던 작업 디렉터리. 이벤트 실행기가 부른 명령의 --repo 경로를 ORCH_CHECKOUT 으로 준다(lib/events.ts 머리 주석)
const CHECKOUT = `// 옛 명령은 --repo 로 준 경로에서 돌았다. 이벤트 실행기가 그 경로를 ORCH_CHECKOUT 으로 준다
const checkout = process.env.ORCH_CHECKOUT || undefined`

// PR URL(https://<호스트>/<owner>/<repo>/pull/<번호>)에서 호스트, owner, 저장소 이름을 뽑는다. 머지 큐와 같은 규칙이다
const URL_PARTS = `const url = String(pr.url ?? '')
const scheme = url.indexOf('://')
const [host = '', owner = '', name = ''] = scheme >= 0 ? url.slice(scheme + 3).split('/') : []`

function beforeMergeBody(command: string): string {
  return `${handlerHead(['queue.before'], '머지 큐의 --before 와 같이 PR 마다 머지 직전에 bash -c 로 돈다. 10 으로 끝나면 거부, 그 밖의 실패도 멈춘다.')}
const COMMAND = ${JSON.stringify(command)}
${URL_PARTS}
${CHECKOUT}
const env = { ...process.env, PR: String(pr.number ?? ''), BRANCH: String(pr.branch ?? ''), OWNER: String(input.owner ?? owner), REPO: String(input.name ?? name), GH_HOST: host }
process.exitCode = runOld(['bash', '-c', COMMAND], { env, cwd: checkout })
`
}

function verifyMergedBody(command: string): string {
  return `${handlerHead(['queue.verify_merged'], '머지 큐의 --verify-merged 와 같이 base 와 합친 사본에서 bash -c 로 돈다. 첫 인자($1)와 MERGE_COPY 가 사본 경로다.', ['readFileSync', 'realpathSync'])}
const COMMAND = ${JSON.stringify(command)}
${URL_PARTS}
const copy = String(input.copy ?? '')
const list = (value: unknown): string => (Array.isArray(value) ? value.map(String).join('\\n') : '')
// 머지 큐는 옛 칸에 TMPDIR 를 실경로로 넘겼다. 실경로를 요구하는 검사가 /var 와 /private/var 로 갈린 경로를 거부한다
let tmp = process.env.TMPDIR || '/tmp'
try {
  tmp = realpathSync(tmp)
} catch {
  // 머지 큐가 시작할 때 이미 확인한 폴더다. 읽지 못하면 받은 값을 그대로 넘긴다
}
const env = {
  ...process.env,
  PR: String(pr.number ?? ''),
  BRANCH: String(pr.branch ?? ''),
  OWNER: owner,
  REPO: name,
  TMPDIR: tmp,
  GH_HOST: host,
  MERGE_COPY: copy,
  PR_HEAD: String(pr.head ?? ''),
  BASE_HEAD: String(input.base_head ?? ''),
  CHANGED_FILES: list(input.changed_files),
  OVERLAP_FILES: list(input.overlap_files),
}
process.exitCode = runOld(['bash', '-c', COMMAND, 'verify-merged', copy], { env, cwd: copy })
`
}

function afterQueueBody(command: string): string {
  return `${handlerHead(['queue.after_merged'], '머지 큐의 --after-merged 와 같이 PR 을 하나라도 머지한 큐가 끝난 뒤 한 번 bash -c 로 돈다.')}
const COMMAND = ${JSON.stringify(command)}
${CHECKOUT}
const join = (value: unknown): string => (Array.isArray(value) ? value.map(String).join(' ') : '')
const env = { ...process.env, MERGED_PRS: join(input.merged_prs), CODE_PRS: join(input.code_prs) }
process.exitCode = runOld(['bash', '-c', COMMAND], { env, cwd: checkout })
`
}

function afterDeployBody(argv: string[], pattern: RegExp): string {
  return `${handlerHead(['finish.complete_cmd', 'finish.task_pattern'], 'finish-pr 의 업무 완료와 같이 업무의 마지막 PR 이고 배포가 성공했거나 배포 워크플로가 없을 때만 돈다.')}
// 업무 완료 명령 틀을 shlex 처럼 나눈 인자 목록이다. 조각마다 {number} 를 업무 번호로 바꾸고 셸을 거치지 않는다
const ARGV: string[] = ${JSON.stringify(argv)}
// PR 제목에서 업무 번호를 뽑는 정규식. 첫 번째 그룹이 번호다
const PATTERN = /${pattern.source}/
// 번호에 셸이나 경로를 바꾸는 글자가 들어가지 않게 막는다
const NUMBER_OK = /${NUMBER_OK}/
${CHECKOUT}

function main(): number {
  if (input.last_of_task !== true || !['success', 'none'].includes(String(input.deploy))) return 0
  const title = String(pr.title ?? '')
  const number = PATTERN.exec(title)?.[1]
  if (!number) {
    process.stderr.write(\`PR 제목에서 업무 번호를 찾지 못했다: \${title}\\n\`)
    return 1
  }
  if (!NUMBER_OK.test(number)) {
    process.stderr.write(\`업무 번호에 쓸 수 없는 글자가 있다: \${number}\\n\`)
    return 1
  }
  return runOld(ARGV.map((part) => part.replaceAll('{number}', number)), { cwd: checkout })
}

process.exitCode = main()
`
}

// 정규식의 잡는 그룹 수. 빈 문자열에 늘 맞는 대안을 붙여 exec 결과의 길이로 센다(finish-pr.ts 와 같다)
function groupCount(re: RegExp): number {
  return (new RegExp(`(?:${re.source})|`).exec('') as RegExpExecArray).length - 1
}

const QUEUE_HOOKS: ReadonlyArray<{ key: string; event: string; body: (command: string) => string }> = [
  { key: 'before', event: 'before-merge', body: beforeMergeBody },
  { key: 'verify_merged', event: 'verify-merged', body: verifyMergedBody },
  { key: 'after_merged', event: 'after-queue', body: afterQueueBody },
]

function keyNames(w: HookWrite): string[] {
  return w.keys.map(([s, k]) => `${s}.${k}`)
}

function overlapLine(file: string, root: string, keys: string[]): string {
  return `겹침 ${rel(file, root)} 이 이미 있다. ${keys.join(', ')} 를 옮기지 않았다. 둘을 비교해 하나만 남긴 뒤 다시 돌린다`
}

function hookFile(orch: string, event: string): string {
  return join(orch, NAMES.hooks, `${event}.ts`)
}

// [쓸 핸들러, 옮기지 못한 칸의 이유]. 절의 꼴이 틀리면 Usage
function hookPlan(config: Record<string, unknown>, root: string, orch: string): { writes: HookWrite[]; problems: string[] } {
  const writes: HookWrite[] = []
  const problems: string[] = []
  const sectionOf = (name: string): Record<string, unknown> => {
    const body = config[name] ?? {}
    if (!isObject(body)) throw new Usage(`설정 파일의 "${name}" 절은 객체여야 한다`)
    return body
  }
  const conflict = (file: string, keys: string[]): boolean => {
    if (!lexists(file)) return false
    problems.push(overlapLine(file, root, keys))
    return true
  }
  const queue = sectionOf('queue')
  for (const { key, event, body } of QUEUE_HOOKS) {
    const value = queue[key]
    if (value === undefined) continue
    const name = `queue.${key}`
    if (typeof value !== 'string' || !value) {
      problems.push(`옮기지 못함 ${name}: 비지 않은 문자열이어야 한다`)
      continue
    }
    const file = hookFile(orch, event)
    if (conflict(file, [name])) continue
    writes.push({ event, keys: [['queue', key]], file, body: body(value) })
  }

  const finishSection = sectionOf('finish')
  const command = finishSection.complete_cmd
  const pattern = finishSection.task_pattern
  if (command === undefined && pattern === undefined) return { writes, problems }
  const names = ['finish.complete_cmd', 'finish.task_pattern']
  const fail = (reason: string) => problems.push(`옮기지 못함 ${names.join(', ')}: ${reason}`)
  if (command === undefined) {
    fail('complete_cmd 가 없다. 업무 완료 명령이 없으면 task_pattern 은 쓰이지 않는 칸이라 지워도 된다')
  } else if (pattern === undefined) {
    fail('task_pattern 이 없다. PR 제목에서 업무 번호를 뽑을 정규식을 task_pattern 에 적고 다시 돌린다')
  } else if (typeof command !== 'string' || !command || typeof pattern !== 'string' || !pattern) {
    fail('둘 다 비지 않은 문자열이어야 한다')
  } else {
    let argv: string[] | null = null
    let regexp: RegExp | null = null
    try {
      argv = shSplit(command)
    } catch (e) {
      fail(`complete_cmd 를 나누지 못했다: ${(e as Error).message}`)
    }
    if (argv !== null && !argv.some((part) => part.includes('{number}'))) {
      fail('complete_cmd 에 {number} 가 없다')
      argv = null
    }
    if (argv !== null) {
      try {
        regexp = pyRegExp(pattern)
      } catch (e) {
        fail(`${(e as Error).message}. JS 정규식으로 고쳐 task_pattern 에 다시 적고 다시 돌린다`)
      }
    }
    if (regexp !== null && groupCount(regexp) < 1) {
      fail('task_pattern 에 업무 번호를 담을 그룹이 없다')
      regexp = null
    }
    if (argv !== null && regexp !== null) {
      const file = hookFile(orch, 'after-deploy')
      if (!conflict(file, names)) {
        writes.push({ event: 'after-deploy', keys: [['finish', 'complete_cmd'], ['finish', 'task_pattern']], file, body: afterDeployBody(argv, regexp) })
      }
    }
  }
  return { writes, problems }
}

function trackedUnder(root: string, target: string): boolean {
  const done = git(root, ['ls-files', '--', target])
  return done.code === 0 && done.stdout.trim() !== ''
}

function migrateHooks(repo: string, runId: string | null, apply: boolean): number {
  const root = mainCheckout(repo)
  const left = legacyPaths(root)
  if (left.length > 0) {
    err(`옛 위치가 남아 있다: ${left.join(', ')}. 먼저 --hooks 없이 --apply 로 폴더를 옮긴다`)
    err(`  node --disable-warning=ExperimentalWarning ${SCRIPT} --repo ${root} --apply`)
    return 2
  }
  const orch = orchDir(root)
  const configPath = join(orch, NAMES.config)
  if (!isFile(configPath)) {
    out('옮길 칸이 없다')
    return 0
  }
  let config: unknown
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (e) {
    err(`설정 파일을 읽지 못했다: ${configPath}: ${(e as Error).message}`)
    return 2
  }
  if (!isObject(config)) {
    err(`${configPath} 의 최상위는 객체여야 한다`)
    return 2
  }
  const { writes, problems } = hookPlan(config, root, orch)
  if (writes.length === 0 && problems.length === 0) {
    out('옮길 칸이 없다')
    return 0
  }
  if (!apply) {
    for (const w of writes) {
      out(`만들 핸들러 ${rel(w.file, root)} <- ${keyNames(w).join(', ')}`)
      for (const key of keyNames(w)) out(`설정에서 지울 키 ${key}`)
    }
    for (const line of problems) out(line)
    if (writes.length > 0) out('--apply 로 핸들러를 쓰고 설정에서 그 키를 지운다')
    return problems.length > 0 ? 1 : 0
  }
  if (writes.length > 0) {
    const found = blockers(root, runId ?? configuredRun(root))
    if (found.length > 0) {
      for (const reason of found) err(`막음 ${reason}`)
      err('worker 와 머지 큐가 끝난 뒤 다시 돌린다')
      return 3
    }
  }
  const written: HookWrite[] = []
  for (const w of writes) {
    mkdirSync(dirname(w.file), { recursive: true })
    try {
      // 계획한 뒤 그 사이에 생긴 파일도 덮지 않는다
      writeFileSync(w.file, w.body, { encoding: 'utf8', flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      problems.push(overlapLine(w.file, root, keyNames(w)))
      continue
    }
    written.push(w)
    out(`핸들러를 만듦 ${rel(w.file, root)} <- ${keyNames(w).join(', ')}`)
  }
  if (written.length > 0) {
    ensureIgnored(root)
    // 쓴 키만 지운다. 절과 다른 키의 순서는 그대로다
    const fresh: Record<string, unknown> = { ...config }
    for (const w of written) {
      for (const [s, k] of w.keys) {
        const body = { ...(fresh[s] as Record<string, unknown>) }
        delete body[k]
        fresh[s] = body
        out(`설정에서 지움 ${s}.${k}`)
      }
    }
    writeJson(configPath, fresh)
    const hooksDir = join(orch, NAMES.hooks)
    const trackedConfig = trackedUnder(root, configPath)
    if (trackedConfig || trackedUnder(root, hooksDir)) {
      const paths = [...written.map((w) => rel(w.file, root)), ...(trackedConfig ? [rel(configPath, root)] : [])]
      out(`추적 파일 git -C ${root} add -f ${paths.join(' ')}  (공개 저장소에 올리면 안 되는 값이 없는지 본 뒤 커밋한다)`)
    }
  }
  for (const line of problems) out(line)
  return problems.length > 0 ? 1 : 0
}

// 머리 주석이 사용법을 소유한다. -h 와 --help 가 그것을 찍는다
function usageText(): string {
  const lines: string[] = []
  for (const line of readFileSync(SCRIPT, 'utf8').split('\n')) {
    if (!line.startsWith('//')) break
    lines.push(line.replace(/^\/\/ ?/, ''))
  }
  return lines.join('\n')
}

function main(argv: string[]): number {
  const options = {
    repo: { type: 'string', default: '.' },
    run: { type: 'string' },
    move: { type: 'string', multiple: true, default: [] },
    apply: { type: 'boolean', default: false },
    hooks: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } as const
  let values
  try {
    values = parseArgs({ args: expandArgs(argv, options, ['repo', 'run', 'move']), options }).values
  } catch (e) {
    err(`migrate-orch-dir: ${(e as Error).message}. --help 로 사용법을 본다`)
    return 2
  }
  if (values.help) {
    out(usageText())
    return 0
  }
  let extra: Pair[]
  try {
    extra = (values.move as string[]).map(parseMove)
    if (values.hooks && extra.length > 0) throw new Usage('--hooks 는 --move 와 함께 쓰지 않는다. 폴더를 먼저 옮긴 뒤 --hooks 를 따로 돌린다')
  } catch (e) {
    if (!(e instanceof Usage)) throw e
    err(`migrate-orch-dir: ${e.message}`)
    return 2
  }
  const repo = values.repo as string
  const runId = (values.run as string | undefined) || null
  if (!values.hooks) return migrateFolders(repo, runId, extra, values.apply as boolean)
  try {
    return migrateHooks(repo, runId, values.apply as boolean)
  } catch (e) {
    if (!(e instanceof Usage)) throw e
    err(`migrate-orch-dir: ${e.message}`)
    return 2
  }
}

process.exitCode = main(process.argv.slice(2))
