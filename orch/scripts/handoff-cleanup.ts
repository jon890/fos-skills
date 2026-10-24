// orch 작업 폴더에 남은 끝난 산출물을 휴지통 폴더로 옮긴다. 지우지 않으므로 되살릴 수 있다.
//
// 기본은 옮길 후보만 보인다. `--apply` 를 주면 옮긴다. 몇 번을 돌려도 같은 상태에서는 같은 결과다.
//
// 사용법:
//     handoff-cleanup.ts [--repo DIR] [--config FILE] [--apply] [옵션...]
//
// 옮기는 것 (<orch> 는 orch 작업 폴더다. lib/paths.ts 의 orchDir 이 정한다):
//     - <orch>/queue/*.out: QUEUE-DONE, STOP, FINISH-DONE, FINISH-FAIL 중 하나로 끝났고 --queue-days 일 넘게 지난 로그
//     - <orch>/specs/spec-*.md: 아래가 모두 참인 지시서. spec-common.md 는 남긴다
//         · 지시서의 `보드 항목 id: \`x\`` 항목이 보드에서 done 이다. 보드에 항목이 없거나 done 이 아니면
//           아직 쓰는 지시서다(띄우기 전, PR 이 여럿인 일의 중간). 그 줄이 없는 지시서는 이 조건을 건너뛴다
//         · 지시서의 `브랜치:` 가 원격과 워크트리에 없고 그 브랜치의 열린 PR 도 없다
//         · 열린 PR 목록을 읽지 못하면 아무것도 옮기지 않는다
//         · 살아 있는 dispatch 의 `--spec` 줄이 가리키는 지시서가 아니다. 그 판정과 옮기기는 lib/spec.ts 의 deleteSpecs 한 곳이 맡는다.
//           살아 있는 지시서 목록(liveSpecPaths)을 읽지 못하면 아무것도 옮기지 않는다.
//           브랜치가 모두 머지됐다는 이유로 아직 일하는 worker 의 지시서를 옮긴 일이 있었다
//     - <orch>/<폴더>: --folder-days 일 넘게 바뀌지 않았고, 보드 파일에 이름이 없고 <orch>/.keep 에도 없는 폴더
//       (bin, queue, specs, state 는 건드리지 않는다)
//     - <previews>/<폴더나 파일>: --previews 를 줄 때만 본다. 조건은 위와 같고 남길 이름은 <previews>/.keep 에 적는다.
//       미리보기는 content-preview 의 산출물이라 기본으로는 보지 않는다
//     - <orch> 아래 --data-ext 확장자 파일(기본 csv, tsv) 중 --data-days 일 넘게 지난 것. bin 폴더 안은 뺀다
//       (DB 에서 뽑은 원본은 쓰고 나서 지운다)
//
// 남길 폴더는 .keep 에 한 줄에 하나씩 이름을 적는다.
// 휴지통 안에서는 <휴지통>/<그 폴더 이름>/<상대 경로> 로 두고, 같은 이름이 있으면 번호를 붙여 덮어쓰지 않는다.
//
// 출력: 지시서가 아닌 후보는 `후보 <상대경로>`, 옮긴 뒤에는 `옮김 <상대경로>` 다. 지시서는 deleteSpecs 의 문구를 그대로 낸다
//     (`지시서를 휴지통으로 옮길 것 …`, `지시서 옮김 … -> …`, `지시서를 남긴다 …: <이유>`. 남긴다 줄은 stderr 다)
//
// 옵션 (저장소마다 다른 값이다. --config 의 JSON 키는 옵션 이름의 하이픈을 밑줄로 바꾼 것이다. 옵션은 고유 접두로 줄여 쓸 수 있다):
//     --repo DIR         대상 저장소. 기본은 현재 디렉터리. git 과 gh 를 여기서 돌린다
//     --config FILE      옵션 값을 담은 JSON. 「cleanup」 절을 읽는다. 없으면 <orch>/config.json 이 있을 때 쓴다. 명령줄이 우선한다
//     --gh-host HOST     gh 에 줄 GH_HOST
//     --run RUN          살아 있는 dispatch 를 찾을 Orca Run. 없으면 코디네이터에 묶인 Run 이다
//     --orch-dir DIR     orch 작업 폴더. 기본은 lib/paths.ts 가 정한 곳(<주 checkout>/.orch). 상대경로면 주 checkout 기준
//     --previews DIR     미리보기 폴더. 주지 않으면 보지 않는다. 상대경로면 주 checkout 기준
//     --board FILE       보드 파일. 기본은 work-board 의 board.ts 가 정한 위치. 상대경로면 주 checkout 기준
//     --trash DIR        휴지통 폴더. 기본 ~/.Trash/orch-cleanup-<날짜>
//     --queue-days N     기본 1
//     --folder-days N    기본 3
//     --data-days N      기본 1
//     --data-ext LIST    쉼표로 이은 확장자. 기본 csv,tsv
//     --apply            실제로 옮긴다
//
// GH, GIT, ORCA 환경 변수로 실행 파일을 바꾼다.
//
// 종료 코드: 0 돌았다(후보가 없어도 0), 2 사용법 오류이거나 orch 작업 폴더를 옮기기 전이다(lib/paths.ts 「옛 구조」)

import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { ConfigError, loadConfig, section } from './lib/config.ts'
import { isFile, realPath } from './lib/fs.ts'
import { mainCheckout } from './lib/git.ts'
import { ghJson } from './lib/gh.ts'
import { boardPath, orchDir, requireMigrated } from './lib/paths.ts'
import { run } from './lib/proc.ts'
import { branchesOf, deleteSpecs, LINE_BREAK, liveSpecPaths } from './lib/spec.ts'

const USAGE = '사용법: handoff-cleanup.ts [--repo DIR] [--config FILE] [--apply] [--gh-host HOST] [--run RUN] [--orch-dir DIR] [--previews DIR] [--board FILE] [--trash DIR] [--queue-days N] [--folder-days N] [--data-days N] [--data-ext LIST]'
const QUEUE_DONE = /QUEUE-DONE|^STOP|FINISH-DONE|FINISH-FAIL/m
const BOARD_ID_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?보드 항목 id:(?:\*\*)?\s*`([^`]+)`/m
const RESERVED = new Set(['bin', 'queue', 'specs', 'state'])
const DAY = 86400
const RUN_TIMEOUT_MS = 120_000

const OPTIONS = {
  repo: { type: 'string' },
  config: { type: 'string' },
  'gh-host': { type: 'string' },
  run: { type: 'string' },
  'orch-dir': { type: 'string' },
  previews: { type: 'string' },
  board: { type: 'string' },
  trash: { type: 'string' },
  'queue-days': { type: 'string' },
  'folder-days': { type: 'string' },
  'data-days': { type: 'string' },
  'data-ext': { type: 'string' },
  apply: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

// 설정 절의 키. 옵션 이름의 하이픈을 밑줄로 바꾼 것이고 config 와 help 는 뺀다
const CLEANUP_KEYS: readonly string[] = Object.keys(OPTIONS)
  .filter((name) => name !== 'config' && name !== 'help')
  .map((name) => name.replaceAll('-', '_'))

class Usage extends Error {}

type Args = {
  repo: string
  config: string | null
  ghHost: string | null
  run: string | null
  orchDir: string | null
  previews: string | null
  board: string | null
  trash: string | null
  queueDays: number
  folderDays: number
  dataDays: number
  dataExt: Set<string>
  apply: boolean
}

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

function expandUser(value: string): string {
  if (value === '~') return homedir()
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

// ---- 판정 (순수 함수) ----------------------------------------------------------------------------------

function isOld(mtime: number, now: number, days: number): boolean {
  return now - mtime > days * DAY
}

// 로그의 마지막 3줄에 끝 표시가 있는지.
function queueLogFinished(text: string): boolean {
  const lines = text.replace(/\n+$/, '').split(LINE_BREAK)
  if (lines.at(-1) === '') lines.pop()
  return QUEUE_DONE.test(lines.slice(-3).join('\n'))
}

// 보드 JSON 에서 id 별 status. items 는 목록이나 id 로 묶은 객체다. 읽지 못하면 빈 Map 이다.
function boardStatuses(boardText: string): Map<unknown, unknown> {
  const found = new Map<unknown, unknown>()
  let items: unknown
  try {
    items = (JSON.parse(boardText) as { items?: unknown }).items
  } catch {
    return found
  }
  const rows = Array.isArray(items) ? items : typeof items === 'object' && items !== null ? Object.values(items) : []
  for (const row of rows) {
    if (typeof row === 'object' && row !== null && !Array.isArray(row) && Object.hasOwn(row, 'id')) {
      const item = row as { id: unknown; status?: unknown }
      found.set(item.id, item.status ?? null)
    }
  }
  return found
}

// 지시서가 끝난 작업의 것인지. 살아 있는 dispatch 가 쓰는지는 여기서 보지 않는다. deleteSpecs 가 판정한다.
function specFinished(
  text: string,
  statuses: Map<unknown, unknown>,
  openHeads: Set<string>,
  remoteHas: (branch: string) => boolean,
  worktreeHas: (branch: string) => boolean,
): boolean {
  const branch = branchesOf(text)[0]
  if (branch === undefined) return false
  const boardId = BOARD_ID_LINE.exec(text)
  if (boardId && statuses.get(boardId[1]) !== 'done') return false
  if (openHeads.has(branch)) return false
  return !remoteHas(branch) && !worktreeHas(branch)
}

// 보드 파일 본문에 이름이 들어 있거나 .keep 에 한 줄로 적혀 있는지.
function referenced(name: string, boardText: string, keepLines: Set<string>): boolean {
  return boardText.includes(name) || keepLines.has(name)
}

// 다른 후보 안에 든 후보는 뺀다. 폴더를 옮기면 그 안의 파일은 함께 가기 때문이다.
function dropNested(found: string[]): string[] {
  const depth = (p: string) => p.split(sep).length
  const ordered = [...new Set(found)].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
  const kept: string[] = []
  for (const target of ordered) if (!kept.some((parent) => target.startsWith(parent + sep))) kept.push(target)
  return kept
}

function taken(target: string): boolean {
  try {
    lstatSync(target)
    return true
  } catch {
    return false
  }
}

function uniqueDest(dest: string): string {
  if (!taken(dest)) return dest
  let n = 2
  while (taken(`${dest}.${n}`)) n += 1
  return `${dest}.${n}`
}

// 휴지통이 다른 볼륨이면 rename 이 EXDEV 로 실패하므로 복사한 뒤 지운다.
function movePath(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
    rmSync(from, { recursive: true, force: true })
  }
}

// ---- 수집 ----------------------------------------------------------------------------------------------

function gitBin(): string {
  return process.env.GIT || 'git'
}

function runOut(argv: string[], cwd: string): { code: number; out: string } {
  const done = run(argv, { cwd, timeoutMs: RUN_TIMEOUT_MS })
  return { code: done.code, out: done.stdout }
}

// 열린 PR 의 head 브랜치 집합. 읽지 못하면 null 이다.
function openPrHeads(repo: string): Set<string> | null {
  const got = ghJson<unknown>(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'headRefName'], { cwd: repo, timeoutMs: RUN_TIMEOUT_MS })
  if (!got.ok || !Array.isArray(got.data)) return null
  const heads = new Set<string>()
  for (const row of got.data) {
    const head = (row as { headRefName?: unknown } | null)?.headRefName
    if (typeof head !== 'string') return null
    heads.add(head)
  }
  return heads
}

function keepNames(folder: string): Set<string> {
  const keepFile = join(folder, '.keep')
  if (!isFile(keepFile)) return new Set()
  return new Set(readFileSync(keepFile, 'utf8').split(LINE_BREAK).map((line) => line.trim()))
}

function isDir(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

function listDir(dir: string): string[] {
  return readdirSync(dir).sort()
}

function mtimeSec(target: string): number {
  return statSync(target).mtimeMs / 1000
}

// 확장자가 dataExt 에 드는 파일. bin 폴더 안은 들어가지 않는다.
function dataFiles(dir: string, dataExt: Set<string>): string[] {
  const found: string[] = []
  for (const name of listDir(dir)) {
    const target = join(dir, name)
    let entry
    try {
      entry = lstatSync(target)
    } catch {
      continue
    }
    if (entry.isDirectory()) {
      if (name !== 'bin') found.push(...dataFiles(target, dataExt))
    } else if (isFile(target)) {
      const dot = name.lastIndexOf('.')
      if (dot > 0 && dataExt.has(name.slice(dot + 1).toLowerCase())) found.push(target)
    }
  }
  return found
}

// specs 는 끝난 지시서이고 live 는 살아 있는 지시서 목록이다(읽지 못했으면 null). 옮길지는 deleteSpecs 가 정한다
type Found = { others: string[]; specs: string[]; live: Set<string> | null }

function candidates(args: Args, repo: string, orch: string, previews: string | null, board: string, now: number): Found {
  const found: string[] = []
  const queue = join(orch, 'queue')
  for (const name of isDir(queue) ? listDir(queue).filter((n) => n.endsWith('.out')) : []) {
    const log = join(queue, name)
    try {
      if (isOld(mtimeSec(log), now, args.queueDays) && queueLogFinished(readFileSync(log, 'utf8'))) found.push(log)
    } catch {
      continue
    }
  }

  const boardText = isFile(board) ? readFileSync(board, 'utf8') : ''
  const statuses = boardStatuses(boardText)
  const specsDir = join(orch, 'specs')
  const specFiles = isDir(specsDir)
    ? listDir(specsDir)
        .filter((n) => n.startsWith('spec-') && n.endsWith('.md') && n !== 'spec-common.md')
        .map((n) => join(specsDir, n))
    : []
  const finished: string[] = []
  let live: Set<string> | null = new Set()
  if (specFiles.length > 0) {
    const heads = openPrHeads(repo)
    if (heads === null) {
      err('gh 로 열린 PR 을 읽지 못해 지시서는 옮기지 않는다')
    } else {
      live = liveSpecPaths(args.run)
      if (live === null) err('orca 로 살아 있는 dispatch 의 지시서를 읽지 못해 지시서는 옮기지 않는다')
      const worktrees = runOut([gitBin(), 'worktree', 'list'], repo).out
      const remoteHas = (b: string) => runOut([gitBin(), 'ls-remote', '--exit-code', '--heads', 'origin', b], repo).code === 0
      const worktreeHas = (b: string) => worktrees.includes(`[${b}]`)
      for (const spec of specFiles) {
        const text = readFileSync(spec, 'utf8')
        if (specFinished(text, statuses, heads, remoteHas, worktreeHas)) finished.push(spec)
      }
    }
  }

  const entries: { entry: string; root: string }[] = isDir(orch)
    ? listDir(orch).map((n) => ({ entry: join(orch, n), root: orch })).filter(({ entry }) => isDir(entry) && !RESERVED.has(basename(entry)))
    : []
  if (previews && isDir(previews)) {
    for (const n of listDir(previews)) if (n !== '.keep') entries.push({ entry: join(previews, n), root: previews })
  }
  const keep = new Map<string, Set<string>>()
  for (const root of [orch, previews]) if (root) keep.set(root, keepNames(root))
  for (const { entry, root } of entries) {
    if (isOld(mtimeSec(entry), now, args.folderDays) && !referenced(basename(entry), boardText, keep.get(root) as Set<string>)) found.push(entry)
  }

  if (isDir(orch)) {
    for (const file of dataFiles(orch, args.dataExt)) if (isOld(mtimeSec(file), now, args.dataDays)) found.push(file)
  }
  return { others: dropNested(found), specs: finished, live }
}

// ---- 진입점 --------------------------------------------------------------------------------------------

function number(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null) return fallback
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) throw new Usage(`${name} 은 수다: ${String(value)}`)
  return n
}

function parse(argv: string[]): Args | null {
  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({ args: expandArgs(argv, OPTIONS), options: OPTIONS, allowPositionals: false }).values as typeof values
  } catch (e) {
    throw new Usage((e as Error).message)
  }
  if (values.help) return null
  const cli = (name: string) => values[name] as string | undefined
  const configFile = cli('config') ?? null
  const config = section<Record<string, unknown>>(loadConfig(cli('repo') ?? '.', configFile ? { file: configFile } : {}), 'cleanup', CLEANUP_KEYS)
  const text = (name: string): string | null => {
    const value = cli(name) ?? config[name.replaceAll('-', '_')]
    if (value === undefined || value === null) return null
    if (typeof value !== 'string') throw new ConfigError(`설정 파일의 cleanup.${name.replaceAll('-', '_')} 는 문자열이어야 한다`)
    return value
  }
  const num = (name: string, fallback: number) => number(cli(name) ?? config[name.replaceAll('-', '_')], `--${name}`, fallback)
  const configApply = config.apply
  if (configApply !== undefined && typeof configApply !== 'boolean') throw new ConfigError('설정 파일의 cleanup.apply 는 true 나 false 여야 한다')
  return {
    repo: text('repo') ?? '.',
    config: configFile,
    ghHost: text('gh-host'),
    run: text('run'),
    orchDir: text('orch-dir'),
    previews: text('previews'),
    board: text('board'),
    trash: text('trash'),
    queueDays: num('queue-days', 1),
    folderDays: num('folder-days', 3),
    dataDays: num('data-days', 1),
    dataExt: new Set((text('data-ext') ?? 'csv,tsv').split(',').map((e) => e.trim().toLowerCase().replace(/^\.+/, '')).filter((e) => e)),
    apply: values.apply === true || configApply === true,
  }
}

function main(argv: string[]): number {
  let args: Args | null
  try {
    args = parse(argv)
  } catch (e) {
    if (!(e instanceof Usage || e instanceof ConfigError)) throw e
    err(`${USAGE}\nhandoff-cleanup: ${e.message}`)
    return 2
  }
  if (args === null) {
    out(USAGE)
    return 0
  }
  if (!(args.config || args.orchDir) && !requireMigrated(args.repo, 'handoff-cleanup', '설정 파일을 --config 로 직접 주거나 --orch-dir 로 폴더를 준다')) return 2
  const repo = resolve(args.repo)
  const mainRoot = mainCheckout(repo)
  const orch = args.orchDir ? realPath(resolve(mainRoot, expandUser(args.orchDir))) : orchDir(repo)
  const previews = args.previews ? realPath(resolve(mainRoot, expandUser(args.previews))) : null
  const board = boardPath(repo, args.board)
  const nowMs = Date.now()
  const day = new Date(nowMs)
  const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`
  const trash = resolve(args.trash ? expandUser(args.trash) : join(homedir(), '.Trash', `orch-cleanup-${stamp}`))
  if (args.ghHost) process.env.GH_HOST = args.ghHost
  const roots = [orch, previews].filter((r): r is string => Boolean(r))
  const found = candidates(args, repo, orch, previews, board, nowMs / 1000)
  for (const target of found.others) {
    const root = roots.find((r) => target.startsWith(r + sep))
    if (root === undefined) {
      err(`정리 대상 폴더(${roots.join(', ')}) 밖이라 건너뛴다: ${target}`)
      continue
    }
    const rel = join(basename(root), relative(root, target))
    if (!args.apply) {
      out(`후보 ${rel}`)
      continue
    }
    const dest = uniqueDest(join(trash, rel))
    mkdirSync(dirname(dest), { recursive: true })
    movePath(target, dest)
    out(`옮김 ${rel}`)
  }
  if (found.specs.length > 0) {
    // 남긴다 줄은 옛 명령처럼 stderr 로 낸다
    const log = (line: string) => (line.startsWith('지시서를 남긴다') || line.startsWith('PR 본문을 남긴다') ? err(line) : out(line))
    deleteSpecs({ root: orch, specs: found.specs, prBodies: [], live: found.live, mode: { trash }, apply: args.apply, log })
  }
  if (args.apply) out(`휴지통 폴더: ${trash}`)
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  err(`handoff-cleanup: ${(e as Error)?.stack ?? String(e)}`)
  process.exitCode = 1
}
