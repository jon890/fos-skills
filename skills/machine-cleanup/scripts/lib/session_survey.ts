// 맥과 홈서버가 함께 쓰는 에이전트 세션과 대화 기록 판정. 읽기 전용이다.
//
// ps 와 lsof 출력 해석, 대화 기록 폴더 크기, 워크트리가 사라진 Claude 기록 찾기를 둔다.
// 어느 기록 폴더를 볼지는 부르는 쪽이 정한다. 맥 전용 경로는 survey_sessions.ts 가 갖는다.

import { lstatSync, readdirSync } from 'node:fs'
import { readFirstLines } from '../io.ts'
import { pyHead, pySplitLines, pyStrCompare } from '../kit/py.ts'
import { basename, exists, expanduser, isDir, isSymlink, loadJson, mtimeSeconds, osJoin, parsePyFloat, parsePyInt, pyFixed, pyRound, pyTime, splitWhitespace, walk } from '../pylike.ts'

const AGENT_NAMES = ['claude', 'codex']
const HELPER_PREFIX_LEN = 150
export const HELPER_MIN_COUNT = 10
const CWD_SCAN_LINES = 50
export const ORPHAN_AGE_BUCKETS = [3, 7, 14, 30]
export const ORPHAN_EXAMPLES = 5

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

export function expandLogDirs(patterns: string[]): string[] {
  const out: string[] = []
  for (const pattern of patterns) {
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

