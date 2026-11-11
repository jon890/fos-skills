#!/usr/bin/env node
// macOS 개발 머신의 디스크, 메모리, 스왑, 큰 디렉터리, 도구 캐시를 조사한다. 읽기 전용이다.
//
// 사용법: survey_system.ts
// 걸리는 시간: du 때문에 1분에서 5분. 홈 디렉터리가 클수록 오래 걸린다.
// 종료 코드: 0 조사 완료. 개별 항목이 없거나 실패해도 건너뛰고 0 으로 끝난다.
//
// 컨테이너 런타임(Docker Desktop, Colima, OrbStack 등)은 런타임마다 context 가 다르므로 `container_runtimes.ts` 가 따로 조사한다.
//
// 큰 디렉터리는 `du -xkd1` 한 번으로 하위 항목을 모두 읽는다. 셸 glob 을 쓰지 않으므로
// 점으로 시작하는 디렉터리가 없어도 다른 항목이 빠지지 않는다.

import { lstatSync, readdirSync } from 'node:fs'
import { readArgs, type Entry } from './cli.ts'
import { isMain, rjust, runText, which, write } from './io.ts'
import { PY_SPACE, pySplitLines, pyStrCompare, pyStrip } from './kit/py.ts'
import { basename, exists, expanduser, isDir, isSymlink, mtimeSeconds, osJoin, parsePyInt, pyFixed, pyFloorDiv, pyResolve, pyTime, splitWhitespace, walk } from './pylike.ts'

const USAGE = `usage: survey_system.ts [-h]
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
macOS 개발 머신의 디스크, 메모리, 스왑, 큰 디렉터리, 도구 캐시를 조사한다. 읽기 전용이다.

options:
  -h, --help  show this help message and exit
`

const ENTRY: Entry = { prog: 'survey_system.ts', usage: USAGE, help: HELP, spec: { options: [], positionals: [] } }

const HOME = expanduser('~')
const DU_TIMEOUT = 600

// 명령을 돌려 표준 출력을 문자열로 돌려준다. 없거나 실패하거나 시간이 넘으면 null. mergeStderr 면 표준 오류도 합친다
export function run(cmd: string[], timeoutSec = 60, mergeStderr = false): string | null {
  const done = runText(cmd, { timeoutSec, closeStdin: true, mergeStderr })
  if (done.failure) return null
  return done.code === 0 ? done.stdout : null
}

// KiB 를 `du -h` 처럼 읽기 쉬운 크기로 바꾼다
export function humanKb(kb: number): string {
  let size = kb
  for (const unit of ['K', 'M', 'G', 'T']) {
    if (size < 1024 || unit === 'T') return size >= 10 || unit === 'K' ? `${pyFixed(size, 0)}${unit}` : `${pyFixed(size, 1)}${unit}`
    size /= 1024
  }
  return ''
}

// `du -k` 출력(크기<탭>경로)을 [KiB, 경로] 목록으로 만든다. 알아볼 수 없는 줄은 건너뛴다
export function parseDuKb(output: string): [number, string][] {
  const rows: [number, string][] = []
  for (const line of pySplitLines(output)) {
    const tab = line.indexOf('\t')
    const size = tab < 0 ? line : line.slice(0, tab)
    const path = tab < 0 ? '' : line.slice(tab + 1)
    if (/^\p{Nd}+$/u.test(size) && path) rows.push([parsePyInt(size), path])
  }
  return rows
}

// du 행에서 큰 순서로 limit 개를 고른다. 크기가 같으면 경로순이다
export function topDirs(rows: [number, string][], limit: number): [number, string][] {
  return [...rows].sort((a, b) => b[0] - a[0] || pyStrCompare(a[1], b[1])).slice(0, limit)
}

// `du -k` 를 돌려 [KiB, 경로] 목록을 돌려준다. du 는 읽을 수 없는 하위 항목이 있으면 1 로 끝나도 출력을 내므로 종료 코드를 보지 않는다
export function duKb(args: string[]): [number, string][] {
  const done = runText(['du', '-xk', ...args], { timeoutSec: DU_TIMEOUT, closeStdin: true })
  return done.failure ? [] : parseDuKb(done.stdout)
}

function duTop(root: string, limit: number): void {
  if (!isDir(root)) return
  for (const [kb, path] of topDirs(duKb(['-d1', root]), limit)) write(1, `${rjust(humanKb(kb), 6)}  ${path}\n`)
}

// 경로가 있으면 `크기<탭>경로` 한 줄을 출력한다. 없으면 아무것도 내지 않는다
function sizeOf(path: string): void {
  if (!path || !exists(path)) return
  const rows = duKb(['-s', path])
  if (rows.length) write(1, `${rjust(humanKb(rows[0][0]), 6)}\t${rows[0][1]}\n`)
}

const APP_RE = /\/([^/]+)\.app(?:\/|$)/

// 명령줄에서 앱 이름을 뽑는다. `.app` 번들이 없으면 실행 파일 이름이다
export function appName(command: string): string {
  const m = APP_RE.exec(command)
  if (m) return m[1]
  const words = splitWhitespace(command)
  return words.length ? words[0].split('/').at(-1)! : '?'
}

// `ps -axo rss=,command=` 출력을 앱별 RSS(KiB) 합계로 만든다
export function rssByApp(psOutput: string): Map<string, number> {
  const total = new Map<string, number>()
  for (const line of pySplitLines(psOutput)) {
    const parts = splitWhitespace(pyStrip(line), 1)
    if (parts.length < 2 || !/^\p{Nd}+$/u.test(parts[0])) continue
    const name = appName(parts[1])
    total.set(name, (total.get(name) ?? 0) + parsePyInt(parts[0]))
  }
  return total
}

// `vm_stat` 출력에서 [페이지 크기, 압축기가 쓰는 페이지 수]를 뽑는다. 없는 값은 null
export function parseVmStat(output: string): [number | null, number | null] {
  const page = /page size of (\p{Nd}+)/u.exec(output)
  const comp = new RegExp(`occupied by compressor:${PY_SPACE}+(\\p{Nd}+)`, 'u').exec(output)
  return [page ? parsePyInt(page[1]) : null, comp ? parsePyInt(comp[1]) : null]
}

// 설치를 기다리는 업데이트가 있다는 표시. Electron 계열 updater 는 내려받은 압축 파일을 `update.zip` 으로,
// 풀어 둔 설치본을 `pending` 디렉터리에 두고 앱이 다음 실행에서 설치한다.
const PENDING_NAMES = new Set(['pending', 'update.zip', 'update-info.json'])

// `*-updater` 또는 `*.ShipIt` 이름의 캐시 디렉터리인지
export const isUpdaterDir = (name: string): boolean => name.endsWith('-updater') || name.endsWith('.ShipIt')

// 디렉터리 직속 항목 이름에서 대기 중인 업데이트 표시를 골라 정렬해 돌려준다. 없으면 빈 목록
export const pendingMarks = (entryNames: string[]): string[] => entryNames.filter((n) => PENDING_NAMES.has(n)).sort(pyStrCompare)

// 대기 표시가 없을 때만 안전이고, 하나라도 있으면 유지다. 지우면 아직 설치하지 않은 업데이트가 사라진다
export const updaterVerdict = (marks: string[]): string => (marks.length ? '유지(설치 대기 업데이트)' : '안전(대기 표시 없음)')

// ~/.cache 하위 디렉터리를 보이는 기준. 이 크기(KiB) 이상이면 나열한다
const CACHE_MIN_KB = 100 * 1024
const NEWEST_MTIME_MAX_ENTRIES = 200_000
const CODEX_RELEASES = '~/.codex/packages/standalone/releases'
const CODEX_CURRENT = '~/.codex/packages/standalone/current'
const CURSOR_SNAPSHOTS = '~/Library/Application Support/Cursor/snapshots'
const S = PY_SPACE
const NON_S = `(?:(?!${S})[^])`
const PRUNABLE_RE = new RegExp(`^${S}*(?:mise${S}+)?(${NON_S}+?)@(${NON_S}+) is prunable: ([^\\n]*)$`)
const CURSOR_APP_RE = /\/Cursor\.app\//

// `mise prune --dry-run` 출력에서 지울 수 있다고 본 [도구, 버전, 이유] 목록을 뽑는다. 다른 줄은 건너뛴다
export function parseMisePrunable(output: string): [string, string, string][] {
  const rows: [string, string, string][] = []
  for (const line of pySplitLines(output)) {
    const m = PRUNABLE_RE.exec(line)
    if (m) rows.push([m[1], m[2], pyStrip(m[3])])
  }
  return rows
}

// [도구, 버전, 이유] 목록을 도구별 버전 목록으로 묶는다. 도구 이름순이다
export function groupByTool(rows: [string, string, string][]): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const [tool, version] of rows) grouped.set(tool, [...(grouped.get(tool) ?? []), version])
  return new Map([...grouped].sort((a, b) => pyStrCompare(a[0], b[0])))
}

// mise 가 도구를 설치하는 데이터 디렉터리. MISE_DATA_DIR 이 있으면 그것, 없으면 ~/.local/share/mise
export function miseDataDir(environ: Record<string, string | undefined> = process.env): string {
  return environ.MISE_DATA_DIR || osJoin(osJoin(osJoin(HOME, '.local'), 'share'), 'mise')
}

// 같은 installs/<도구>/ 안에서 각 후보 버전 경로로 풀리는 심볼릭 링크(`24.15`, `lts` 등)를 {버전 경로: [링크 경로]} 로 읽는다
export function miseAliases(dataDir: string, grouped: Map<string, string[]>): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const [tool, versions] of grouped) {
    const toolDir = osJoin(osJoin(dataDir, 'installs'), tool)
    let names: string[]
    try {
      names = readdirSync(toolDir)
    } catch {
      continue
    }
    const targets = new Map(versions.map((v) => [pyResolve(osJoin(toolDir, v)), osJoin(toolDir, v)]))
    for (const name of names.sort(pyStrCompare)) {
      const link = osJoin(toolDir, name)
      const real = isSymlink(link) ? pyResolve(link) : null
      if (real !== null && targets.has(real)) {
        const key = targets.get(real)!
        found.set(key, [...(found.get(key) ?? []), link])
      }
    }
  }
  return found
}

export type MiseRow = { tool: string; version: string; path: string; kb: number | null; running: boolean }

// ps 의 명령줄 중 needle 경로를 포함한 줄의 수
export const commandsUsing = (psOutput: string, needle: string): number => pySplitLines(psOutput).filter((line) => line.includes(needle)).length

// 지울 수 있다고 본 mise 버전별 행을 만든다. sizes 는 {설치 경로: KiB}(없는 경로는 빠진다).
// running 은 설치 경로 뒤에 `/` 를 붙여 명령줄에서 찾는다. `24.15.0` 이 `24.15.01` 에 걸리지 않게 한다.
// aliases 는 {버전 경로: [별칭 링크 경로]} 이고, 별칭 경로(`installs/node/24.15/bin/node`)로 도는 프로세스도 실행중으로 본다
export function miseVersionRows(grouped: Map<string, string[]>, dataDir: string, sizes: Map<string, number>, psOutput: string, aliases: Map<string, string[]> = new Map()): MiseRow[] {
  const rows: MiseRow[] = []
  for (const [tool, versions] of grouped) {
    for (const version of versions) {
      const path = osJoin(osJoin(osJoin(dataDir, 'installs'), tool), version)
      rows.push({ tool, version, path, kb: sizes.get(path) ?? null, running: [path, ...(aliases.get(path) ?? [])].some((p) => commandsUsing(psOutput, `${p}/`) > 0) })
    }
  }
  return rows
}

// 버전별 한 줄. 설치 경로가 없으면 크기 자리에 `없음` 을 쓴다
export function formatMiseRow(row: MiseRow): string {
  const size = row.kb === null ? '없음' : humanKb(row.kb)
  return `${rjust(size, 6)}  ${row.tool} ${row.version}${row.running ? '  실행중' : ''}`
}

// Cursor 앱 번들 안에서 도는 프로세스가 있는지
export const cursorRunning = (psOutput: string): boolean => pySplitLines(psOutput).some((line) => CURSOR_APP_RE.test(line))

// 마지막 수정 시각(epoch)을 경과 일수로 바꾼다. 시각을 모르면 null
export function ageDays(newestTs: number | null, now: number): number | null {
  return newestTs === null ? null : Math.max(0, Math.trunc(pyFloorDiv(now - newestTs, 86400)))
}

// root 아래에서 가장 늦은 수정 시각. 디렉터리 자신의 mtime 은 직속 항목이 바뀔 때만 변해, 안쪽 파일까지 본다.
// 항목이 maxEntries 를 넘으면 거기까지 본 값을 쓴다. 비어 있거나 읽지 못하면 root 자신의 mtime 이다
export function newestMtime(root: string, maxEntries = NEWEST_MTIME_MAX_ENTRIES): number | null {
  let newest: number
  try {
    newest = mtimeSeconds(lstatSync(root, { bigint: true }))
  } catch {
    return null
  }
  let seen = 0
  for (const step of walk(root)) {
    for (const name of [...step.filenames, ...step.directories]) {
      seen += 1
      if (seen > maxEntries) return newest
      try {
        newest = Math.max(newest, mtimeSeconds(lstatSync(osJoin(step.current, name), { bigint: true })))
      } catch {
        continue
      }
    }
  }
  return newest
}

export type CodexRow = { path: string; kb: number; current: boolean; running: boolean }

// Codex 릴리스 디렉터리별 행을 만든다. sizes 는 {경로: KiB}, current 는 `current` 가 가리키는 경로(없으면 null).
// running 은 그 경로를 명령줄에 가진 프로세스가 있다는 뜻이다
export function codexReleaseRows(sizes: Map<string, number>, current: string | null, psOutput: string): CodexRow[] {
  const realCurrent = current ? pyResolve(current) : null
  return [...sizes].sort((a, b) => pyStrCompare(a[0], b[0])).map(([path, kb]) => ({ path, kb, current: pyResolve(path) === realCurrent, running: commandsUsing(psOutput, path) > 0 }))
}

const section = (title: string) => write(1, `\n## ${title}\n`)

function surveyDisk(): void {
  section('디스크 (APFS 데이터 볼륨)')
  write(1, run(['df', '-h', '/System/Volumes/Data']) || 'df 를 읽지 못했다\n')
}

function surveyMemory(): void {
  section('메모리와 스왑')
  const mem = run(['sysctl', '-n', 'hw.memsize'])
  if (mem && /^\p{Nd}+$/u.test(pyStrip(mem))) write(1, `실제 메모리: ${Math.floor(parsePyInt(mem) / 1073741824)}GB\n`)
  write(1, run(['sysctl', 'vm.swapusage']) || '')
  const pressure = run(['memory_pressure'])
  if (pressure && pyStrip(pressure)) write(1, `${pySplitLines(pyStrip(pressure)).at(-1)}\n`)
  const [page, comp] = parseVmStat(run(['vm_stat']) || '')
  if (page && comp !== null) write(1, `압축 메모리: ${Math.floor((comp * page) / 1048576)}MB\n`)
  write(1, run(['uptime']) || '')
}

function surveyRss(): void {
  section('앱별 RSS 합계 상위 15')
  const totals = rssByApp(run(['ps', '-axo', 'rss=,command=']) || '')
  for (const [name, kb] of [...totals].sort((a, b) => b[1] - a[1]).slice(0, 15)) write(1, `${rjust(pyFixed(kb / 1048576, 2), 7)}GB  ${name}\n`)
}

function surveyBigDirs(): void {
  section('큰 디렉터리')
  write(1, '-- ~ (상위 15)\n')
  duTop(HOME, 15)
  write(1, '-- ~/Library/Caches (상위 10)\n')
  duTop(osJoin(HOME, 'Library/Caches'), 10)
  write(1, '-- ~/Library/Application Support (상위 10)\n')
  duTop(osJoin(HOME, 'Library/Application Support'), 10)
}

function surveyToolCaches(): void {
  section('도구 캐시')
  sizeOf(osJoin(HOME, '.npm'))
  sizeOf(osJoin(HOME, '.npm/_npx'))
  if (which('pnpm')) sizeOf(pyStrip(run(['pnpm', 'store', 'path']) || ''))
  sizeOf(osJoin(HOME, '.gradle'))
  sizeOf(osJoin(HOME, '.m2'))
  sizeOf(osJoin(HOME, '.cache/uv'))
  sizeOf(osJoin(HOME, '.bun/install/cache'))
  if (which('pip3')) sizeOf(pyStrip(run(['pip3', 'cache', 'dir']) || ''))
  if (which('brew')) sizeOf(pyStrip(run(['brew', '--cache']) || ''))
  sizeOf(osJoin(HOME, '.cache/huggingface'))
  const caches = osJoin(HOME, 'Library/Caches')
  if (isDir(caches)) for (const name of readdirSync(caches).sort(pyStrCompare)) if (name.startsWith('ms-playwright')) sizeOf(osJoin(caches, name))
}

function surveyUpdaters(): void {
  section('업데이트 캐시 (*-updater, *.ShipIt)')
  const caches = osJoin(HOME, 'Library/Caches')
  let names: string[]
  try {
    names = readdirSync(caches).filter(isUpdaterDir).sort(pyStrCompare)
  } catch {
    names = []
  }
  if (names.length === 0) write(1, '해당 디렉터리 없음\n')
  for (const name of names) {
    const path = osJoin(caches, name)
    let marks: string[]
    try {
      marks = pendingMarks(readdirSync(path))
    } catch {
      marks = []
    }
    const rows = duKb(['-s', path])
    const size = rows.length ? humanKb(rows[0][0]) : '?'
    write(1, `${rjust(size, 6)}  ${path}  ${updaterVerdict(marks)}${marks.length ? `  대기=${marks.join(',')}` : ''}\n`)
  }
}

function surveyCodexReleases(): void {
  section('Codex 이전 버전')
  const releases = expanduser(CODEX_RELEASES)
  if (!isDir(releases)) {
    write(1, '해당 디렉터리 없음\n')
    return
  }
  const sizes = new Map<string, number>()
  for (const [kb, p] of duKb(['-d1', releases])) if (p !== releases) sizes.set(p, kb)
  const currentPath = expanduser(CODEX_CURRENT)
  const current = isSymlink(currentPath) ? pyResolve(currentPath) : null
  const rows = codexReleaseRows(sizes, current, run(['ps', '-axo', 'command=']) || '')
  for (const row of rows) {
    const marks = (row.current ? ' current' : '') + (row.running ? ' 실행중' : '')
    write(1, `${rjust(humanKb(row.kb), 6)}  ${basename(row.path)}${marks}\n`)
  }
  const keep = rows.filter((r) => r.current || r.running)
  write(1, `버전 ${rows.length}개, 합계 ${humanKb(rows.reduce((sum, r) => sum + r.kb, 0))}, 남길 것(current 또는 실행중) ${keep.length}개\n`)
  if (!rows.some((r) => r.running)) write(1, '이 경로를 실행 중인 프로세스 없음(실행 중 codex 는 다른 경로를 쓴다)\n')
}

function surveyCursorSnapshots(): void {
  section('Cursor snapshots')
  const snapshots = expanduser(CURSOR_SNAPSHOTS)
  if (!isDir(snapshots)) {
    write(1, '해당 디렉터리 없음\n')
    return
  }
  sizeOf(snapshots)
  write(1, `Cursor 실행 중: ${cursorRunning(run(['ps', '-axo', 'command=']) || '') ? '예' : '아니오'}\n`)
}

function surveyMisePrune(): void {
  section('mise prune --dry-run')
  if (!which('mise')) {
    write(1, 'mise 가 없어 건너뛴다\n')
    return
  }
  const out = run(['mise', 'prune', '--dry-run'], 120, true)
  if (out === null) {
    write(1, 'mise prune --dry-run 을 읽지 못했다\n')
    return
  }
  const grouped = groupByTool(parseMisePrunable(out))
  if (grouped.size === 0) {
    write(1, '지울 수 있다고 본 버전 없음\n')
    return
  }
  const dataDir = miseDataDir()
  const sizes = new Map<string, number>()
  for (const [tool, versions] of grouped) {
    for (const version of versions) {
      const path = osJoin(osJoin(osJoin(dataDir, 'installs'), tool), version)
      if (isDir(path)) {
        const found = duKb(['-s', path])
        if (found.length) sizes.set(path, found[0][0])
      }
    }
  }
  const rows = miseVersionRows(grouped, dataDir, sizes, run(['ps', '-axo', 'command=']) || '', miseAliases(dataDir, grouped))
  for (const row of rows) write(1, `${formatMiseRow(row)}\n`)
  const keep = rows.filter((r) => r.running)
  write(1, `버전 ${rows.length}개, 남길 것(실행중) ${keep.length}개\n`)
  write(1, 'mise prune 을 그대로 돌리지 않는다. 사용자가 고른 도구만 `mise uninstall 도구@버전` 으로 지운다. 실행중 표시가 붙은 버전은 남긴다\n')
}

function surveyDotCache(): void {
  section('~/.cache 하위 (큰 것)')
  const root = osJoin(HOME, '.cache')
  if (!isDir(root)) {
    write(1, '해당 디렉터리 없음\n')
    return
  }
  const psOutput = run(['ps', '-axo', 'command=']) || ''
  const now = pyTime()
  const big = duKb(['-d1', root]).filter(([kb, p]) => p !== root && kb >= CACHE_MIN_KB)
  for (const [kb, path] of topDirs(big, 15)) {
    const days = ageDays(newestMtime(path), now)
    const age = days === null ? '?' : `${days}일`
    const used = commandsUsing(psOutput, path) ? '사용중' : '프로세스 없음'
    write(1, `${rjust(humanKb(kb), 6)}  마지막 수정 ${rjust(age, 6)} 전  ${used}  ${path}\n`)
  }
  if (big.length === 0) write(1, `${humanKb(CACHE_MIN_KB)} 이상인 하위 디렉터리 없음\n`)
}

function surveySnapshots(): void {
  section('로컬 스냅샷과 휴지통')
  write(1, run(['tmutil', 'listlocalsnapshots', '/']) || '')
  sizeOf(osJoin(HOME, '.Trash'))
}

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  for (const step of [surveyDisk, surveyMemory, surveyRss, surveyBigDirs, surveyToolCaches, surveyUpdaters, surveyDotCache, surveyCodexReleases, surveyCursorSnapshots, surveyMisePrune, surveySnapshots]) step()
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
