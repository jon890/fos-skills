#!/usr/bin/env node
// 에이전트 세션 프로세스, 반복 helper 프로세스, 대화 기록 크기를 조사한다. 읽기 전용이다.
//
// 사용법:
//   survey_sessions.ts [--min-age-hours 24] [--log-age-days 30] [--json] [--json-out FILE]
//
// 종료 코드: 0 조사 완료, 2 인자 오류.
// 현재 세션과 그 조상 PID 는 항상 제외 표시한다.
//
// 「워크트리가 사라진 대화 기록」 절은 Claude 기록 폴더(`~/.claude/projects`, `CLAUDE_CONFIG_DIR` 이 있으면 그 `projects`)의
// 하위 폴더 가운데, 안의 `.jsonl` 을 이름순으로 열어 앞 50줄에서 처음 나온 `cwd` 경로가 이미 없는 폴더를 센다.
// `cwd` 를 읽지 못한 폴더는 후보에 넣지 않는다. 경과일은 폴더 안 파일의 가장 늦은 수정 시각으로 잰다.
// --json-out 은 이 후보를 `delete_sessions.ts` 입력 형식으로 파일에 쓴다.

import { lstatSync, readdirSync, writeFileSync } from 'node:fs'
import { readArgs, type Entry } from './cli.ts'
import { isMain, ljust, readFirstLines, rjust, runText, write } from './io.ts'
import { pyHead, pySplitLines, pyStrCompare } from './kit/py.ts'
import { abspath, basename, dumpJson, exists, expanduser, isDir, isSymlink, loadJson, mtimeSeconds, osErrorMessage, osJoin, parsePyFloat, parsePyInt, PyFloat, pyFixed, pyG, pyRound, pyTime, splitWhitespace, walk } from './pylike.ts'

const USAGE = `usage: survey_sessions.ts [-h] [--min-age-hours MIN_AGE_HOURS]
                          [--log-age-days LOG_AGE_DAYS] [--json]
                          [--json-out FILE]
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
에이전트 세션 프로세스, 반복 helper 프로세스, 대화 기록 크기를 조사한다. 읽기 전용이다.

options:
  -h, --help            show this help message and exit
  --min-age-hours MIN_AGE_HOURS
  --log-age-days LOG_AGE_DAYS
  --json
  --json-out FILE       워크트리가 사라진 대화 기록 후보를 delete_sessions.py 입력으로 쓴다
`

const ENTRY: Entry = {
  prog: 'survey_sessions.ts',
  usage: USAGE,
  help: HELP,
  spec: {
    options: [
      { name: 'min-age-hours', value: true, float: true },
      { name: 'log-age-days', value: true, int: true },
      { name: 'json', value: false },
      { name: 'json-out', value: true },
    ],
    positionals: [],
  },
}

const AGENT_NAMES = ['claude', 'codex']
const HELPER_PREFIX_LEN = 150
const HELPER_MIN_COUNT = 10
const CWD_SCAN_LINES = 50
const ORPHAN_AGE_BUCKETS = [3, 7, 14, 30]
const ORPHAN_EXAMPLES = 5
const LOG_DIRS = ['~/.claude/projects', '~/.codex/sessions', '~/Library/Application Support/orca/codex-accounts/*/home/sessions']

export type PsRow = { pid: number; ppid: number; hours: number; tty: string; rss_kb: number; cpu: number; command: string }

// ps 의 etime `[[dd-]hh:]mm:ss` 를 시간으로 바꾼다. 형식이 아니면 던진다
export function parseEtime(text: string): number {
  let rest = text.trim()
  let days = 0
  if (rest.includes('-')) {
    const at = rest.indexOf('-')
    days = parsePyInt(rest.slice(0, at))
    rest = rest.slice(at + 1)
  }
  const parts = rest.split(':').map(parsePyInt)
  while (parts.length < 3) parts.unshift(0)
  if (parts.length !== 3) throw new Error('too many values to unpack')
  const [hours, minutes, seconds] = parts
  return days * 24 + hours + minutes / 60 + seconds / 3600
}

// `ps -axo pid=,ppid=,etime=,tty=,rss=,pcpu=,command=` 출력을 목록으로 만든다
export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of pySplitLines(output)) {
    const fields = splitWhitespace(line, 6)
    if (fields.length < 7) continue
    try {
      rows.push({ pid: parsePyInt(fields[0]), ppid: parsePyInt(fields[1]), hours: pyRound(parseEtime(fields[2]), 2), tty: fields[3], rss_kb: parsePyInt(fields[4]), cpu: parsePyFloat(fields[5]), command: fields[6] })
    } catch {
      continue
    }
  }
  return rows
}

// pid 부터 PID 1 까지 올라간 PID 집합
export function ancestors(pid: number, parents: Map<number, number>): Set<number> {
  const chain = new Set<number>()
  const seen = new Set<number>()
  while (pid && !seen.has(pid)) {
    seen.add(pid)
    chain.add(pid)
    if (pid === 1) break
    pid = parents.get(pid) ?? 0
  }
  return chain
}

// 실행 파일 이름이 claude 또는 codex 인 프로세스인가
export function isAgent(command: string): boolean {
  const first = splitWhitespace(command, 1)[0]
  return first !== undefined && AGENT_NAMES.includes(basename(first))
}

// 명령줄 앞 prefixLen 자가 같은 프로세스가 minCount 개 이상인 묶음을 RSS 순으로 돌려준다
export function groupHelpers(rows: { command: string; rss_kb: number }[], prefixLen = HELPER_PREFIX_LEN, minCount = HELPER_MIN_COUNT) {
  const groups = new Map<string, { command: string; rss_kb: number }[]>()
  for (const r of rows) {
    const key = pyHead(r.command, prefixLen)
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const out = [...groups].filter(([, v]) => v.length >= minCount).map(([key, v]) => ({ command: key, count: v.length, rss_kb: v.reduce((sum, r) => sum + r.rss_kb, 0) }))
  return out.sort((a, b) => b.rss_kb - a.rss_kb)
}

// `lsof -Fpn` 출력을 {pid: cwd} 로 만든다
export function parseLsofCwd(output: string): Map<number, string> {
  const result = new Map<number, string>()
  let pid: number | null = null
  for (const line of pySplitLines(output)) {
    if (line.startsWith('p')) pid = parsePyInt(line.slice(1))
    else if (line.startsWith('n') && pid !== null) result.set(pid, line.slice(1))
  }
  return result
}

const run = (argv: string[], timeoutSec = 30): string => {
  const done = runText(argv, { timeoutSec })
  return done.failure ? '' : done.stdout
}

// base 아래 전체 바이트와 ageDays 보다 오래된 파일 바이트를 센다
export function dirSizes(base: string, ageDays: number): [number, number] {
  const cutoff = pyTime() - ageDays * 86400
  let total = 0
  let old = 0
  for (const step of walk(base)) {
    for (const name of step.filenames) {
      let st
      try {
        st = lstatSync(osJoin(step.current, name), { bigint: true })
      } catch {
        continue
      }
      total += Number(st.size)
      if (mtimeSeconds(st) < cutoff) old += Number(st.size)
    }
  }
  return [total, old]
}

// `*` 가 폴더 이름 하나를 뜻하는 경로 패턴의 glob.glob. 점으로 시작하는 이름은 `*` 에 들지 않고 결과는 이름순이다
function globStar(pattern: string): string[] {
  let found = [pattern.startsWith('/') ? '/' : '']
  for (const part of pattern.split('/').filter((p) => p !== '')) {
    const next: string[] = []
    for (const base of found) {
      if (part.includes('*')) {
        let names: string[]
        try {
          names = readdirSync(base || '.')
        } catch {
          continue
        }
        for (const name of names) if (!name.startsWith('.')) next.push(osJoin(base, name))
      } else next.push(osJoin(base, part))
    }
    found = next
  }
  return found.filter(isDir).sort(pyStrCompare)
}

export function expandLogDirs(): string[] {
  const out: string[] = []
  for (const pattern of LOG_DIRS) {
    const expanded = expanduser(pattern)
    if (expanded.includes('*')) out.push(...globStar(expanded))
    else if (isDir(expanded)) out.push(expanded)
  }
  return out
}

// Claude 대화 기록 폴더. CLAUDE_CONFIG_DIR 이 있으면 그 아래 projects 다
export function claudeProjectsDir(environ: Record<string, string | undefined> = process.env): string {
  return osJoin(expanduser(environ.CLAUDE_CONFIG_DIR || '~/.claude'), 'projects')
}

// 폴더의 `.jsonl` 을 이름순으로 열어 앞 maxLines 줄에서 처음 나온 `cwd` 값을 돌려준다. 못 읽으면 null
export function readCwd(folder: string, maxLines = CWD_SCAN_LINES): string | null {
  let names: string[]
  try {
    names = readdirSync(folder).filter((n) => n.endsWith('.jsonl')).sort(pyStrCompare)
  } catch {
    return null
  }
  for (const name of names) {
    let lines: string[]
    try {
      lines = readFirstLines(osJoin(folder, name), maxLines)
    } catch {
      continue
    }
    for (const line of lines) {
      let obj: unknown
      try {
        obj = loadJson(line)
      } catch {
        continue
      }
      const cwd = obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>).cwd : undefined
      if (typeof cwd === 'string' && cwd) return cwd
    }
  }
  return null
}

// 폴더 아래 전체 바이트와 파일의 가장 늦은 수정 시각을 돌려준다. 파일이 없으면 시각은 null
export function folderStats(folder: string): [number, number | null] {
  let total = 0
  let newest: number | null = null
  for (const step of walk(folder)) {
    for (const name of step.filenames) {
      let st
      try {
        st = lstatSync(osJoin(step.current, name), { bigint: true })
      } catch {
        continue
      }
      total += Number(st.size)
      const mtime = mtimeSeconds(st)
      if (newest === null || mtime > newest) newest = mtime
    }
  }
  return [total, newest]
}

export type Orphan = { path: string; cwd: string; newest_mtime: number; size_bytes: number }

// base 의 하위 폴더 가운데 기록 안의 cwd 경로가 없는 것을 크기 큰 순서로 돌려준다
export function findOrphanSessions(base: string): Orphan[] {
  const out: Orphan[] = []
  let names: string[]
  try {
    names = readdirSync(base).sort(pyStrCompare)
  } catch {
    return out
  }
  for (const name of names) {
    const folder = osJoin(base, name)
    if (isSymlink(folder) || !isDir(folder)) continue
    const cwd = readCwd(folder)
    if (cwd === null || exists(cwd)) continue
    const [size, newest] = folderStats(folder)
    if (newest === null) continue
    out.push({ path: folder, cwd, newest_mtime: newest, size_bytes: size })
  }
  return out.sort((a, b) => b.size_bytes - a.size_bytes)
}

// N일 넘은 후보의 {일수: [개수, 바이트]}. 큰 일수가 작은 일수 묶음에 포함된다
export function orphanBuckets(orphans: { newest_mtime: number; size_bytes: number }[], now: number, buckets = ORPHAN_AGE_BUCKETS): Map<number, [number, number]> {
  const result = new Map<number, [number, number]>()
  for (const days of buckets) {
    const picked = orphans.filter((o) => o.newest_mtime < now - days * 86400)
    result.set(days, [picked.length, picked.reduce((sum, o) => sum + o.size_bytes, 0)])
  }
  return result
}

export function human(num: number): string {
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (num < 1024 || unit === 'GB') return `${pyFixed(num, 1)}${unit}`
    num /= 1024
  }
  return ''
}

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const minAgeHours = args.options['min-age-hours'] === undefined ? 24 : parsePyFloat(args.options['min-age-hours'] as string)
  const logAgeDays = args.options['log-age-days'] === undefined ? 30 : parsePyInt(args.options['log-age-days'] as string)
  const jsonOut = args.options['json-out'] as string | undefined

  const rows = parsePs(run(['ps', '-axo', 'pid=,ppid=,etime=,tty=,rss=,pcpu=,command=']))
  const parents = new Map(rows.map((r) => [r.pid, r.ppid]))
  const protectedPids = new Set([...ancestors(process.ppid, parents), process.pid])
  const sessions = rows.filter((r) => isAgent(r.command)).map((r) => ({ ...r }))
  let cwds = new Map<number, string>()
  if (sessions.length) cwds = parseLsofCwd(run(['lsof', '-a', '-p', sessions.map((r) => r.pid).join(','), '-d', 'cwd', '-Fpn']))
  const detailed = sessions.map((r) => ({ ...r, cwd: cwds.get(r.pid) ?? '?', protected: protectedPids.has(r.pid), old: r.hours >= minAgeHours }))
  const helpers = groupHelpers(rows)
  const logs = expandLogDirs().map((dir) => {
    const [total, old] = dirSizes(dir, logAgeDays)
    return { dir, total, older_than_days: old }
  })

  const projects = claudeProjectsDir()
  const orphans = isDir(projects) ? findOrphanSessions(projects) : []
  const now = pyTime()
  if (jsonOut) {
    try {
      writeFileSync(jsonOut, dumpJson({ base: projects, created: new PyFloat(now), orphans: orphans.map((o) => ({ ...o, newest_mtime: new PyFloat(o.newest_mtime) })) }))
    } catch (error) {
      write(2, `--json-out 을 쓸 수 없다: ${osErrorMessage(error, jsonOut)}\n`)
      return 2
    }
  }

  if (args.options.json) {
    write(1, `${dumpJson({ sessions: detailed.map((r) => ({ ...r, hours: new PyFloat(r.hours), cpu: new PyFloat(r.cpu) })), helpers, logs })}\n`)
    return 0
  }

  write(1, `## 에이전트 세션 ${detailed.length}개 (오래됨 기준 ${pyG(minAgeHours)}시간)\n`)
  write(1, `${rjust('PID', 7)} ${rjust('시간', 7)} ${ljust('TTY', 8)} ${rjust('RSS', 9)} ${rjust('CPU', 5)}  표시   cwd\n`)
  for (const r of [...detailed].sort((a, b) => b.hours - a.hours)) {
    const mark = r.protected ? '현재' : r.old ? '오래됨' : ''
    write(1, `${rjust(String(r.pid), 7)} ${rjust(pyFixed(r.hours, 1), 6)}h ${ljust(r.tty, 8)} ${rjust(human(r.rss_kb * 1024), 9)} ${rjust(pyFixed(r.cpu, 1), 5)}  ${ljust(mark, 5)}  ${r.cwd}\n`)
  }
  write(1, "현재 세션과 조상은 '현재' 로 표시했다. 종료 대상에 넣지 않는다.\n")
  write(1, `\n## 반복 helper 프로세스 (같은 명령줄 ${HELPER_MIN_COUNT}개 이상)\n`)
  for (const g of helpers) write(1, `${rjust(String(g.count), 4)}개 ${rjust(human(g.rss_kb * 1024), 9)}  ${g.command}\n`)
  if (helpers.length === 0) write(1, '없음\n')
  write(1, `\n## 대화 기록 (오래된 기준 ${logAgeDays}일)\n`)
  for (const item of logs) write(1, `${rjust(human(item.total), 9)} 중 오래된 것 ${rjust(human(item.older_than_days), 9)}  ${item.dir}\n`)
  if (logs.length === 0) write(1, '없음\n')
  write(1, `\n## 워크트리가 사라진 대화 기록 (${projects})\n`)
  if (orphans.length === 0) write(1, '없음\n')
  else {
    for (const [days, [count, size]] of orphanBuckets(orphans, now)) write(1, `${rjust(String(days), 3)}일 넘은 것 ${rjust(String(count), 5)}개 ${rjust(human(size), 9)}\n`)
    write(1, `전체 ${orphans.length}개 ${rjust(human(orphans.reduce((sum, o) => sum + o.size_bytes, 0)), 9)}. 크기 상위 ${Math.min(ORPHAN_EXAMPLES, orphans.length)}개:\n`)
    for (const o of orphans.slice(0, ORPHAN_EXAMPLES)) write(1, `${rjust(human(o.size_bytes), 9)} ${rjust(pyFixed((now - o.newest_mtime) / 86400, 0), 5)}일 전  ${o.cwd}\n`)
  }
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
