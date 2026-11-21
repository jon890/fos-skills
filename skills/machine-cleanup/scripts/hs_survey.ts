#!/usr/bin/env node
// 홈서버의 정리 후보, 메모리·스왑, git 저장소, 대화 기록, Hermes 세션을 조사해 JSON 으로 낸다. 홈서버에서 돈다.
//
// 사용법(이 맥에서):
//   remote.ts --host HOST --input CONFIG --json-out SURVEY hs_survey.ts --config CONFIG [--no-fetch] [--no-check-prs] [--gh-timeout SEC]
//
// CONFIG 는 hs_overlay.ts 가 검사해 낸 JSON 이다. 이 스크립트는 홈서버 값을 기본값으로 갖지 않는다.
// 아무것도 지우지 않는다. 바꾸는 것은 `git fetch --prune` 의 원격 ref 뿐이다.
// 운영 checkout(CONFIG 의 checkout 과 같은 저장소)의 fetch 만 `flock -E 75 -w 300 <잠금> git fetch` 로 감싸고,
// 잠금을 얻지 못하면 그 저장소의 fetch 만 건너뛰고 fetch 칸에 「잠금 실패」 를 적는다.
// 등급은 매기지 않는다. 등급과 원인 판정은 이 맥의 hs_classify.ts 가 한다.
// 절 하나가 실패하면 그 절에 error 를 적고 나머지를 계속한다. orca 는 부르지 않는다(홈서버의 orca 는 화면 낭독기다).
//
// 워크트리 사용 확인은 이 사용자 uid 의 프로세스 가운데 `/proc/<pid>/cwd` 가 그 워크트리 아래인 것이 있는지로 본다.
// 같은 uid 인데 cwd 를 읽지 못한 프로세스가 하나라도 있으면 모든 워크트리의 사용 여부를 「확인하지 못함」 으로 둔다.
// 환경 변수 HS_ROOT 는 테스트용이다. `/proc` 와 시스템 경로(/tmp, /var/...) 앞에 붙는다.
//
// 종료 코드: 0 조사 완료, 2 인자나 CONFIG 오류.

import { lstatSync, readdirSync, readFileSync, readlinkSync, statfsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { isMain, runText, write } from './io.ts'
import { DEFAULT_GH_TIMEOUT, surveyRepo } from './lib/git_survey.ts'
import { claudeProjectsDir, dirSizes, expandLogDirs, findOrphanSessions, isAgent, parsePs } from './lib/session_survey.ts'

type Json = Record<string, any>

export const LOCK_FAILED = 75
export const LOG_DIRS = ['~/.claude/projects', '~/.codex/sessions']
const SWAP_TOP = 10
const AGENT_OLD_HOURS = 24

const ROOT = process.env.HS_ROOT ?? ''
const HOME = process.env.HOME || homedir()
export const expandHome = (path: string, home = HOME): string => (path === '~' ? home : path.startsWith('~/') ? `${home}/${path.slice(2)}` : path)
const sys = (path: string): string => `${ROOT}${path}`

const run = (argv: string[], timeoutSec = 60): string | null => {
  const done = runText(argv, { timeoutSec, closeStdin: true })
  return done.failure || done.code !== 0 ? null : done.stdout
}

// ---------- 이미지 ----------

// `이름[:태그][@digest]` 를 [이름, 태그, digest] 로 나눈다. 레지스트리 포트의 콜론은 태그로 읽지 않는다
export function parseRef(ref: string): [string, string | null, string | null] {
  const at = ref.indexOf('@')
  let name = at < 0 ? ref : ref.slice(0, at)
  const digest = at < 0 ? null : ref.slice(at + 1) || null
  let tag: string | null = null
  const last = name.split('/').pop()!
  if (last.includes(':')) {
    const colon = name.lastIndexOf(':')
    tag = name.slice(colon + 1)
    name = name.slice(0, colon)
  }
  return [name, tag, digest]
}

export function envFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) values[key] = line.slice(eq + 1).trim().replace(/^["']+|["']+$/g, '')
  }
  return values
}

// Compose 처럼 `${VAR}`, `${VAR:-기본}`, `${VAR-기본}`, `${VAR:?메시지}` 를 .env 값으로 푼다. 풀지 못하면 null
export function expandVars(value: string, env: Record<string, string>): string | null {
  let failed = false
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-|-|:\?|\?)?([^}]*)\}/g, (_m, name: string, op: string | undefined, def: string) => {
    if (env[name]) return env[name]
    if (op === ':-' || op === '-') return def
    failed = true
    return ''
  })
  return failed ? null : out
}

// checkout 기준 상대 glob(`*` 는 경로 한 마디)을 파일 목록으로 푼다
export function globFiles(root: string, pattern: string): string[] {
  let found = [root]
  const parts = pattern.split('/').filter(Boolean)
  for (const [i, part] of parts.entries()) {
    const next: string[] = []
    const re = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
    for (const base of found) {
      if (!part.includes('*') && !part.includes('?')) {
        next.push(`${base}/${part}`)
        continue
      }
      let names: string[] = []
      try {
        names = readdirSync(base)
      } catch {
        continue
      }
      for (const name of names.sort()) if (re.test(name)) next.push(`${base}/${name}`)
    }
    found = next
    if (i === parts.length - 1) found = found.filter((f) => isFile(f))
  }
  return found
}

const isFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// 내용 해시로 태그를 정하는 이미지의 지금 태그. 파일이 하나라도 없으면 null
export function contentTag(name: string, files: string[], length: number): string | null {
  const hash = createHash('sha256')
  for (const file of files) {
    let data: Buffer
    try {
      data = readFileSync(file)
    } catch {
      return null
    }
    hash.update(data)
  }
  return `${name}:${hash.digest('hex').slice(0, length)}`
}

// Compose 의 image, Dockerfile 의 FROM, settings 의 image, 내용 해시 태그가 지금 쓰도록 정한 이미지다
export function configuredRefs(checkout: string, spec: Json): Set<string> {
  const refs = new Set<string>()
  for (const pattern of spec.compose) {
    for (const file of globFiles(checkout, pattern)) {
      const env = envFile(readText(`${file.slice(0, file.lastIndexOf('/'))}/.env`) ?? '')
      for (const m of (readText(file) ?? '').matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)) {
        const resolved = expandVars(m[1], env)
        if (resolved) refs.add(resolved)
      }
    }
  }
  for (const pattern of spec.dockerfile) {
    for (const file of globFiles(checkout, pattern)) {
      for (const m of (readText(file) ?? '').matchAll(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/gm)) refs.add(m[1])
    }
  }
  for (const pattern of spec.settings) {
    for (const file of globFiles(checkout, pattern)) {
      try {
        const image = JSON.parse(readText(file) ?? '{}').image
        if (typeof image === 'string') refs.add(image)
      } catch {
        continue
      }
    }
  }
  for (const t of spec.content_tags) {
    const ref = contentTag(t.name, t.files.map((f: string) => `${checkout}/${f}`), t.length)
    if (ref) refs.add(ref)
  }
  return new Set([...refs].filter((r) => !r.includes('$')))
}

export function isConfigured(tags: string[], digests: string[], refs: Iterable<string>): boolean {
  for (const ref of refs) {
    const [name, tag, digest] = parseRef(ref)
    if (digest && digests.includes(`${name}@${digest}`)) return true
    if (!digest && tags.includes(`${name}:${tag ?? 'latest'}`)) return true
  }
  return false
}

function dockerSection(refs: Set<string>): Json {
  if (run(['docker', 'info', '--format', '{{.ServerVersion}}']) === null) return { error: 'docker 에 닿지 못했다' }
  const summary = (run(['docker', 'system', 'df', '--format', '{{json .}}']) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const ps = run(['docker', 'ps', '-aq', '--no-trunc'])
  if (ps === null) return { error: 'docker ps 가 실패했다' }
  const ids = ps.split(/\s+/).filter(Boolean)
  const inUse = new Map<string, string>()
  if (ids.length) {
    // 그 사이 사라진 컨테이너가 있으면 inspect 가 1 로 끝나도 남은 결과는 낸다
    const done = runText(['docker', 'inspect', '--format', '{{.Image}} {{.Config.Image}}', ...ids], { timeoutSec: 120, closeStdin: true })
    for (const line of done.stdout.split('\n').filter(Boolean)) {
      const sp = line.indexOf(' ')
      inUse.set(line.slice(0, sp), parseRef(line.slice(sp + 1))[0])
    }
    if (inUse.size === 0) return { error: `docker inspect 가 실패했다: ${done.stderr.trim()}` }
  }
  const ls = run(['docker', 'image', 'ls', '-q', '--no-trunc'])
  if (ls === null) return { error: 'docker image ls 가 실패했다' }
  const imageIds = [...new Set(ls.split(/\s+/).filter(Boolean))].sort()
  // 그 사이 지워진 이미지가 있으면 1 로 끝나도 남은 것은 낸다. 하나도 못 읽으면 실패다
  const inspected = imageIds.length ? runText(['docker', 'image', 'inspect', ...imageIds], { timeoutSec: 120, closeStdin: true }) : null
  const details: Json[] = inspected ? JSON.parse(inspected.stdout.trim() || '[]') : []
  if (inspected && details.length === 0) return { error: `docker image inspect 가 실패했다: ${inspected.stderr.trim()}` }
  const runningRepos = new Set(inUse.values())
  const unused = details.filter((d) => !inUse.has(d.Id)).map((d) => {
    const tags: string[] = d.RepoTags ?? []
    const digests: string[] = d.RepoDigests ?? []
    const repos = [...new Set([...tags, ...digests].map((r) => parseRef(r)[0]))].sort()
    return {
      id: d.Id, tags, repos, created: d.Created, size: d.Size,
      configured: isConfigured(tags, digests, refs),
      running_other_version: repos.some((r) => runningRepos.has(r)),
    }
  })
  const volumes = run(['docker', 'volume', 'ls', '-q', '--filter', 'dangling=true'])
  return { summary, unused_images: unused, dangling_volumes: volumes === null ? null : volumes.split(/\s+/).filter(Boolean).length, containers_in_use: ids.length }
}

// ---------- 백업 ----------

export type BackupRule = { key: string; re: RegExp; keep: string }

// 보관 규칙 문서의 `## SECTION` 절 표를 읽는다. 첫 칸이 `용도/` 인 줄만 규칙이고 마지막 칸이 보관 규칙이다.
// `{서비스}` 같은 자리는 아무 이름과 맞는다. 자리가 없는 용도를 먼저 본다. 절이 없으면 빈 목록이다
export function backupRules(markdown: string, section: string): BackupRule[] {
  const lines = markdown.split('\n')
  const start = lines.indexOf(`## ${section}`)
  if (start < 0) return []
  const rules: BackupRule[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    const m = cells.length >= 4 ? /^`([^`]+)\/`$/.exec(cells[0]) : null
    if (!m) continue
    const pattern = m[1].replace(/[.+^$()|[\]\\*?]/g, '\\$&').replace(/\{[^}]+\}/g, '.+')
    rules.push({ key: m[1], re: new RegExp(`^${pattern}$`), keep: cells[cells.length - 1] })
  }
  return rules.sort((a, b) => Number(a.key.includes('{')) - Number(b.key.includes('{')))
}

export const ruleFor = (label: string, rules: BackupRule[]): BackupRule | null => rules.find((r) => r.re.test(label)) ?? null

// 경로 아래 파일 크기 합. 읽지 못한 곳이 있으면 complete 가 false 다(du 와 달리 장치를 넘지 않는 것은 보지 않는다)
export function treeSize(path: string): { size: number | null; complete: boolean } {
  let size = 0
  let complete = true
  const stack = [path]
  let any = false
  while (stack.length) {
    const cur = stack.pop()!
    let st
    try {
      st = lstatSync(cur)
    } catch {
      complete = false
      continue
    }
    any = true
    if (st.isDirectory()) {
      try {
        for (const name of readdirSync(cur)) stack.push(`${cur}/${name}`)
      } catch {
        complete = false
      }
    } else size += st.size
  }
  return { size: any ? size : null, complete }
}

const mtimeOf = (path: string): number | null => {
  try {
    return lstatSync(path).mtimeMs / 1000
  } catch {
    return null
  }
}

function backupsSection(cfg: Json): Json {
  const root = expandHome(cfg.backup.root)
  const doc = readText(`${expandHome(cfg.checkout)}/${cfg.backup.rules}`)
  const rules = doc === null ? [] : backupRules(doc, cfg.backup.section)
  let labels: string[]
  try {
    labels = readdirSync(root).filter((n) => {
      try {
        return lstatSync(`${root}/${n}`).isDirectory()
      } catch {
        return false
      }
    }).sort()
  } catch (error) {
    return { root: cfg.backup.root, error: `백업 루트를 읽지 못했다: ${(error as NodeJS.ErrnoException).code ?? error}`, rows: [] }
  }
  const rows = labels.map((label) => {
    const dir = `${root}/${label}`
    const { size, complete } = treeSize(dir)
    let entries: { name: string; mtime: number | null }[] = []
    try {
      entries = readdirSync(dir).sort().map((name) => ({ name, mtime: mtimeOf(`${dir}/${name}`) }))
    } catch {
      entries = []
    }
    const rule = ruleFor(label, rules)
    return { label, entries, size, complete, mtime: mtimeOf(dir), rule: rule?.keep ?? null, rule_key: rule?.key ?? null }
  })
  return { root: cfg.backup.root, rules_found: doc !== null && rules.length > 0, rows: rows.sort((a, b) => (b.size ?? 0) - (a.size ?? 0)) }
}

// ---------- 경로, 휴지통, journal, snap ----------

export const SYSTEM_PATHS = ['/tmp', '/var/tmp', '/var/cache/apt', '/var/log']
export const HOME_PATHS = ['~/.local/share/Trash', '~/.npm', '~/.local/share/pnpm', '~/.cache']

function pathsSection(cfg: Json): Json[] {
  const items = [
    ...HOME_PATHS.map((p) => ({ path: p, real: expandHome(p), owner: null as string | null })),
    ...SYSTEM_PATHS.map((p) => ({ path: p, real: sys(p), owner: null as string | null })),
    ...cfg.owned_paths.map((o: Json) => ({ path: o.path, real: expandHome(o.path), owner: o.owner })),
  ]
  return items.filter((i) => mtimeOf(i.real) !== null).map((i) => ({ path: i.path, owner: i.owner, ...treeSize(i.real) })).sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
}

function cacheDirs(): Json[] {
  const base = expandHome('~/.cache')
  let names: string[]
  try {
    names = readdirSync(base)
  } catch {
    return []
  }
  return names.map((n) => ({ name: n, mtime: mtimeOf(`${base}/${n}`), ...treeSize(`${base}/${n}`) })).sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
}

function trashSection(): Json[] {
  const base = expandHome('~/.local/share/Trash')
  let infos: string[]
  try {
    infos = readdirSync(`${base}/info`).filter((n) => n.endsWith('.trashinfo')).sort()
  } catch {
    return []
  }
  return infos.map((info) => {
    const name = info.slice(0, -'.trashinfo'.length)
    const moved = /^DeletionDate=(\S+)/m.exec(readText(`${base}/info/${info}`) ?? '')
    return { name, moved: moved ? moved[1] : '', ...treeSize(`${base}/files/${name}`) }
  }).sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
}

export function parseJournal(text: string): string | null {
  const m = /take up ([\d.]+[KMGT]?)/.exec(text)
  return m ? m[1] : null
}

export function parseSnaps(text: string): { name: string; revision: string }[] {
  return text.split('\n').slice(1).map((l) => l.split(/\s+/).filter(Boolean)).filter((f) => f.length >= 6 && f[f.length - 1].includes('disabled')).map((f) => ({ name: f[0], revision: f[2] }))
}

function snapsSection(): Json[] {
  return parseSnaps(run(['snap', 'list', '--all']) ?? '').map((s) => {
    let size: number | null = null
    try {
      size = lstatSync(sys(`/var/lib/snapd/snaps/${s.name}_${s.revision}.snap`)).size
    } catch {
      size = null
    }
    return { ...s, size }
  })
}

// ---------- 메모리 ----------

export function parseMeminfo(text: string): Json {
  const kib = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)
    return m ? Number(m[1]) * 1024 : null
  }
  const swapTotal = kib('SwapTotal')
  const swapFree = kib('SwapFree')
  return { mem_total: kib('MemTotal'), mem_available: kib('MemAvailable'), swap_total: swapTotal, swap_used: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null }
}

const UNITS: Record<string, number> = { B: 1, KB: 1e3, KIB: 1024, MB: 1e6, MIB: 1024 ** 2, GB: 1e9, GIB: 1024 ** 3, TB: 1e12, TIB: 1024 ** 4 }

// docker stats 의 "95.51MiB" 같은 값을 바이트로
export function parseDockerSize(text: string): number | null {
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(text.trim())
  if (!m) return null
  const unit = UNITS[m[2].toUpperCase()]
  return unit ? Math.round(Number(m[1]) * unit) : null
}

// docker stats 줄과 inspect 의 한도를 컨테이너 이름으로 합친다
export function containerMemory(statsJsonLines: string, inspectLines: string): Json[] {
  const limits = new Map<string, [number, number]>()
  for (const line of inspectLines.split('\n').filter(Boolean)) {
    const [name, mem, swap] = line.trim().split(/\s+/)
    limits.set(name.replace(/^\//, ''), [Number(mem), Number(swap)])
  }
  return statsJsonLines.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((s) => {
    const usage = parseDockerSize(String(s.MemUsage ?? '').split('/')[0] ?? '')
    const [limit, swapLimit] = limits.get(s.Name) ?? [0, 0]
    return { name: s.Name, usage, limit: limit || null, swap_limit: swapLimit || null }
  }).sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0))
}

// /proc 의 pid 목록. 읽지 못하면 null 이다. 빈 목록으로 다루면 「쓰는 프로세스 없음」 으로 잘못 읽힌다
const procPids = (): string[] | null => {
  try {
    return readdirSync(sys('/proc')).filter((n) => /^\d+$/.test(n))
  } catch {
    return null
  }
}

export function swapTop(limit = SWAP_TOP): Json[] {
  const rows: Json[] = []
  for (const pid of procPids() ?? []) {
    const status = readText(sys(`/proc/${pid}/status`))
    if (!status) continue
    const swap = /^VmSwap:\s+(\d+)\s*kB/m.exec(status)
    if (!swap || swap[1] === '0') continue
    rows.push({ pid: Number(pid), name: /^Name:\s*(.*)$/m.exec(status)?.[1] ?? '?', swap: Number(swap[1]) * 1024 })
  }
  return rows.sort((a, b) => b.swap - a.swap).slice(0, limit)
}

function memorySection(): Json {
  const out: Json = { ...parseMeminfo(readText(sys('/proc/meminfo')) ?? ''), swap_top: swapTop() }
  const stats = run(['docker', 'stats', '--no-stream', '--format', '{{json .}}'], 120)
  if (stats === null) out.containers_error = 'docker stats 를 읽지 못했다'
  else {
    const ids = (run(['docker', 'ps', '-q']) ?? '').split(/\s+/).filter(Boolean)
    const inspect = ids.length ? runText(['docker', 'inspect', '--format', '{{.Name}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}', ...ids], { timeoutSec: 60, closeStdin: true }).stdout : ''
    out.containers = containerMemory(stats, inspect)
  }
  return out
}

// ---------- git ----------

// 이 uid 의 프로세스 cwd 목록. 같은 uid 인데 cwd 를 읽지 못한 프로세스 수를 함께 낸다.
// /proc 목록을 읽지 못하면 unreadable 을 1 이상으로 두어 「확인하지 못함」 이 되게 한다
export function procCwds(uid: number): { cwds: Set<string>; unreadable: number; unreadableNames: string[] } {
  const cwds = new Set<string>()
  let unreadable = 0
  const unreadableNames: string[] = []
  const pids = procPids()
  if (pids === null) return { cwds, unreadable: 1, unreadableNames: ['/proc 목록'] }
  for (const pid of pids) {
    const status = readText(sys(`/proc/${pid}/status`))
    if (status === null) {
      // 그 사이 끝난 프로세스면 디렉터리도 없다. 디렉터리가 있는데 status 를 못 읽으면 확인하지 못한 것이다
      if (mtimeOf(sys(`/proc/${pid}`)) !== null) {
        unreadable += 1
        unreadableNames.push(`pid ${pid}`)
      }
      continue
    }
    const owner = /^Uid:\s+(\d+)/m.exec(status)
    if (!owner || Number(owner[1]) !== uid) continue
    try {
      cwds.add(readlinkSync(sys(`/proc/${pid}/cwd`)))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ESRCH') {
        unreadable += 1
        unreadableNames.push(/^Name:\s*(.*)$/m.exec(status!)?.[1] ?? '?')
      }
    }
  }
  return { cwds, unreadable, unreadableNames }
}

function gitSection(cfg: Json, opts: { fetch: boolean; checkPrs: boolean; ghTimeout: number }): Json {
  const uid = process.getuid?.() ?? -1
  const { cwds, unreadable, unreadableNames } = procCwds(uid)
  const checkout = expandHome(cfg.checkout).replace(/\/+$/, '')
  const repos: Json[] = []
  for (const r of cfg.repos) {
    const path = expandHome(r.path).replace(/\/+$/, '')
    const entry: Json = { path: r.path, survey_only: Boolean(r.survey_only), build_worktrees: r.build_worktrees ?? [], ops: path === checkout }
    if (mtimeOf(`${path}/.git`) === null) {
      repos.push({ ...entry, error: 'git 저장소가 아니다' })
      continue
    }
    if (opts.fetch) {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      const argv = ['git', '-C', path, 'fetch', '--prune', 'origin']
      const done = runText(entry.ops ? ['flock', '-E', String(LOCK_FAILED), '-w', '300', expandHome(cfg.lock), ...argv] : argv, { timeoutSec: 360, env, closeStdin: true })
      entry.fetch = done.code === 0 ? '완료' : entry.ops && done.code === LOCK_FAILED ? '잠금 실패' : `실패: ${done.stderr.trim().slice(0, 120) || done.message}`
    } else entry.fetch = '하지 않음'
    const result = surveyRepo(path, unreadable ? null : cwds, null, opts.checkPrs, opts.ghTimeout)
    if (!result) {
      repos.push({ ...entry, error: '기준 브랜치를 찾지 못했다' })
      continue
    }
    if (!entry.survey_only) {
      result.worktrees = result.worktrees.filter((w: Json) => w.class !== '유지' || w.pr_state === 'error')
      result.branches = result.branches.filter((b: Json) => b.class !== '유지' || b.pr_state === 'error')
    }
    repos.push({ ...entry, ...result, path: r.path, repo: path })
  }
  // 같은 uid 라도 다른 namespace(컨테이너 안)나 dumpable 이 꺼진 프로세스는 cwd 를 읽지 못한다. 이름을 보여 사람이 판단하게 한다
  const names = [...new Set(unreadableNames)].slice(0, 5).join(', ')
  return { cwd_check: unreadable ? `확인하지 못함(같은 사용자 프로세스 ${unreadable}개의 cwd 를 읽지 못함: ${names}. 컨테이너 안 프로세스일 수 있다)` : '완료', repos }
}

// ---------- 대화 기록 ----------

function sessionsSection(): Json {
  const rows = parsePs(run(['ps', '-axo', 'pid=,ppid=,etime=,tty=,rss=,pcpu=,command=']) ?? '')
  const agents = rows.filter((r) => isAgent(r.command)).map((r) => {
    let cwd = '?'
    try {
      cwd = readlinkSync(sys(`/proc/${r.pid}/cwd`))
    } catch {
      cwd = '?'
    }
    return { ...r, cwd, old: r.hours >= AGENT_OLD_HOURS, protected: r.pid === process.pid || r.pid === process.ppid }
  })
  const logs = expandLogDirs(LOG_DIRS).map((dir) => {
    const [total, old] = dirSizes(dir, 30)
    return { dir, total, older_than_days: old }
  })
  const projects = claudeProjectsDir()
  const orphans = mtimeOf(projects) !== null ? findOrphanSessions(projects) : []
  return { agents, logs, log_age_days: 30, orphans: { base: projects, created: Date.now() / 1000, orphans } }
}

// ---------- Hermes ----------

export type HermesSession = { id: string; parent: string | null; source: string; activity: number }

// profile 의 state.db 를 읽기 전용으로 열어 세션 목록을 낸다
export function readHermesDb(path: string): HermesSession[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const cols = new Set((db.prepare('PRAGMA table_info(sessions)').all() as Json[]).map((c) => c.name))
    const activity = ['started_at', 'ended_at', 'last_activity_at'].filter((c) => cols.has(c))
    const rows = db.prepare(`SELECT id, parent_session_id, source, ${activity.join(', ')} FROM sessions`).all() as Json[]
    return rows.map((r) => ({ id: String(r.id), parent: r.parent_session_id ?? null, source: String(r.source ?? ''), activity: Math.max(...activity.map((c) => Number(r[c]) || 0)) }))
  } finally {
    db.close()
  }
}

// Hermes 데이터 폴더의 profile 과 state.db. 루트의 것은 default profile 이다
export function hermesDbs(data: string): { profile: string; db: string }[] {
  const out: { profile: string; db: string }[] = []
  if (isFile(`${data}/state.db`)) out.push({ profile: 'default', db: `${data}/state.db` })
  let names: string[] = []
  try {
    names = readdirSync(`${data}/profiles`).sort()
  } catch {
    names = []
  }
  for (const n of names) if (isFile(`${data}/profiles/${n}/state.db`)) out.push({ profile: n, db: `${data}/profiles/${n}/state.db` })
  return out
}

// assistant 연결 세션 조회 명령의 출력에서 세션 id 를 모은다. NULL 과 빈 칸은 뺀다
export function parseLinked(text: string): string[] {
  return [...new Set(text.split(/\s+/).filter((t) => t && t !== 'NULL'))].sort()
}

export function readLinked(argv: string[]): { ids: string[] } | { error: string } {
  const done = runText(argv, { timeoutSec: 120, closeStdin: true })
  if (done.failure || done.code !== 0) return { error: `assistant 연결 세션 조회 실패(종료 코드 ${done.code}): ${(done.stderr.trim() || done.message).slice(0, 200)}` }
  return { ids: parseLinked(done.stdout) }
}

export function hermesSnapshot(cfg: Json): Json {
  const data = expandHome(cfg.hermes.data)
  const profiles: Json[] = []
  for (const { profile, db } of hermesDbs(data)) {
    try {
      profiles.push({ profile, sessions: readHermesDb(db).map((s) => [s.id, s.parent, s.source, s.activity]) })
    } catch (error) {
      profiles.push({ profile, error: `세션 DB 를 읽지 못했다: ${(error as Error).message}` })
    }
  }
  const linked = readLinked(cfg.hermes.linked)
  return { profiles, ...('ids' in linked ? { linked: linked.ids } : { linked_error: linked.error }) }
}

// ---------- 공통 ----------

// 가장 최근에 지난 매일 정리 시각(이 머신 현지 시각 "HH:MM")의 epoch 초
export function lastDailyPrune(now: Date, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  const at = new Date(now)
  at.setHours(h, m, 0, 0)
  if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 1)
  return at.getTime() / 1000
}

const section = (fn: () => any): any => {
  try {
    return fn()
  } catch (error) {
    return { error: (error as Error).message }
  }
}

export function main(argv: string[]): number {
  let values
  try {
    values = parseArgs({ args: argv, options: { config: { type: 'string' }, 'no-fetch': { type: 'boolean' }, 'no-check-prs': { type: 'boolean' }, 'gh-timeout': { type: 'string' }, json: { type: 'boolean' } } }).values
  } catch (error) {
    write(2, `usage: hs_survey.ts --config FILE [--no-fetch] [--no-check-prs] [--gh-timeout SEC]\n${(error as Error).message}\n`)
    return 2
  }
  if (!values.config) {
    write(2, 'usage: hs_survey.ts --config FILE [--no-fetch] [--no-check-prs] [--gh-timeout SEC]\n')
    return 2
  }
  let cfg: Json
  try {
    cfg = JSON.parse(readFileSync(values.config, 'utf8'))
  } catch (error) {
    write(2, `CONFIG 를 읽지 못했다: ${(error as Error).message}\n`)
    return 2
  }
  const now = new Date()
  const disk = statfsSync('/')
  const data = {
    now: now.getTime() / 1000,
    last_daily_prune: lastDailyPrune(now, cfg.daily_prune),
    home: HOME,
    host: { disk_total: disk.blocks * disk.bsize, disk_free: disk.bavail * disk.bsize },
    memory: section(memorySection),
    docker: section(() => dockerSection(configuredRefs(expandHome(cfg.checkout), cfg.configured_images))),
    backups: section(() => backupsSection(cfg)),
    paths: section(() => pathsSection(cfg)),
    cache_dirs: section(cacheDirs),
    trash: section(trashSection),
    journal: section(() => parseJournal(run(['journalctl', '--disk-usage']) ?? '')),
    snaps: section(snapsSection),
    git: section(() => gitSection(cfg, { fetch: !values['no-fetch'], checkPrs: !values['no-check-prs'], ghTimeout: values['gh-timeout'] ? Number(values['gh-timeout']) : DEFAULT_GH_TIMEOUT })),
    sessions: section(sessionsSection),
    hermes: section(() => hermesSnapshot(cfg)),
  }
  write(1, `${JSON.stringify(data)}\n`)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
