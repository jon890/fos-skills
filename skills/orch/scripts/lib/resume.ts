// `orch worker resume` 의 세션 찾기, 실행 줄 만들기, 요청 폴더 형식을 한 벌로 둔다.
// 코디네이터 쪽 명령(worker/resume-worker.ts)과 새 터미널에서 도는 실행기(worker/resume-exec.ts)가 함께 쓴다.
// 실행기가 새 터미널에서 가볍게 뜨도록 다른 orch lib 를 import 하지 않고 바깥 명령(orca, git, gh)을 부르지 않는다.
// 계약은 docs/features/limit-resume/design.md 의 「책임과 경계」, 「요청 폴더」 다.
//
// 요청 폴더 <orch 루트>/state/resume/<옛 dispatch>/:
//     lock         코디네이터가 O_EXCL 로 만든다. { pid, startedAt, terminal }. terminal 은 새 터미널을 연 뒤 채운다
//     request.json 코디네이터가 쓴다. ResumeRequest
//     found.json   실행기가 쓴다. Found
//     go           코디네이터가 옛 dispatch 정리를 마친 뒤 쓰는 빈 파일. 실행기의 출발 신호다
//     launch.sh    실행기가 go 를 본 뒤 쓴다. `exec …` 한 줄. 셸이 source 해 에이전트가 된다
//
// 세션 기록:
//     Claude  <CLAUDE_CONFIG_DIR>/projects/<워크트리 실경로의 영숫자 밖 글자를 - 로 바꾼 이름>/<세션 id>.jsonl
//     Codex   <CODEX_HOME>/state_5.sqlite 의 threads(id, cwd, rollout_path, updated_at). 없거나 맞는 행이 없으면
//             <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl 의 첫 줄({"type":"session_meta","payload":{"id","cwd"}})
//     둘 다 기록 안에 dispatch 머리말의 dispatch id 가 남는다. 한 세션에 dispatch 여럿이 쌓일 수 있어 dispatch id 로 고른다.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export type Agent = 'claude' | 'codex'
export type ResumeRequest = { dispatch: string; worktree: string; agent: Agent; model: string; effort: string | null; pluginDir: string | null; goDeadline: number }
export type Found = { ok: true; session: string; home: string; terminal: string | null } | { ok: false; reason: string }

export const REQUEST = 'request.json'
export const FOUND = 'found.json'
export const GO = 'go'
export const LAUNCH = 'launch.sh'
export const LOCK = 'lock'

// Codex 가 rollout 을 날짜 폴더에 쌓는다. DB 가 없을 때 이만큼의 최근 날짜 폴더만 본다
const ROLLOUT_DAYS = 14
// Orca 가 Codex 를 띄울 때 shell_environment_policy 로 넘기는 값. 하나라도 없으면 resume 한 Codex 가 Orca 와 이어지지 않는다
export const CODEX_ORCA_ENV = ['ORCA_USER_DATA_PATH', 'ORCA_WORKSPACE_ID', 'ORCA_WORKTREE_ID', 'ORCA_PANE_KEY', 'ORCA_TERMINAL_HANDLE'] as const

function real(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return target
  }
}

function isDir(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

function contains(file: string, needle: string): boolean {
  try {
    return readFileSync(file, 'utf8').includes(needle)
  } catch {
    return false
  }
}

function newestFirst(files: string[]): string[] {
  const time = (file: string) => {
    try {
      return statSync(file).mtimeMs
    } catch {
      return 0
    }
  }
  return files.map((file) => [file, time(file)] as const).sort((a, b) => b[1] - a[1]).map(([file]) => file)
}

export function claudeProjectDir(home: string, worktree: string): string {
  return join(home, 'projects', real(worktree).replace(/[^A-Za-z0-9]/g, '-'))
}

// 그 워크트리의 기록 가운데 dispatch id 가 든 가장 최근 세션 id. 없으면 null
export function findClaudeSession(home: string, worktree: string, dispatch: string): string | null {
  const dir = claudeProjectDir(home, worktree)
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return null
  }
  const hit = newestFirst(names.map((name) => join(dir, name))).find((file) => contains(file, dispatch))
  return hit ? hit.slice(dir.length + 1, -'.jsonl'.length) : null
}

type Thread = { id: unknown; rollout_path: unknown }

function threadsFromDb(file: string, cwds: string[]): Thread[] | null {
  if (!existsSync(file)) return null
  try {
    // node:sqlite 를 쓰지 못하는 node 에서도 rollout 파일로 찾게 require 를 실패로 받는다
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const marks = cwds.map(() => '?').join(', ')
      return db.prepare(`select id, rollout_path from threads where cwd in (${marks}) order by updated_at desc`).all(...cwds) as Thread[]
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

function firstLine(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    const end = text.indexOf('\n')
    return end < 0 ? text : text.slice(0, end)
  } finally {
    closeSync(fd)
  }
}

function recentRollouts(home: string, now: number): string[] {
  const files: string[] = []
  for (let day = 0; day < ROLLOUT_DAYS; day++) {
    const at = new Date(now - day * 86_400_000)
    const dir = join(home, 'sessions', String(at.getFullYear()), String(at.getMonth() + 1).padStart(2, '0'), String(at.getDate()).padStart(2, '0'))
    try {
      for (const name of readdirSync(dir)) if (name.startsWith('rollout-') && name.endsWith('.jsonl')) files.push(join(dir, name))
    } catch {
      // 그날 폴더가 없으면 건너뛴다
    }
  }
  return newestFirst(files)
}

// 그 워크트리의 Codex 세션 가운데 rollout 에 dispatch id 가 든 가장 최근 것. 없으면 null
export function findCodexSession(home: string, worktree: string, dispatch: string, now = Date.now()): string | null {
  const cwds = [...new Set([real(worktree), worktree])]
  for (const row of threadsFromDb(join(home, 'state_5.sqlite'), cwds) ?? []) {
    if (typeof row.id === 'string' && typeof row.rollout_path === 'string' && contains(row.rollout_path, dispatch)) return row.id
  }
  for (const file of recentRollouts(home, now)) {
    let meta: unknown
    try {
      meta = JSON.parse(firstLine(file))
    } catch {
      continue
    }
    const payload = (meta as { type?: unknown; payload?: { id?: unknown; cwd?: unknown } } | null)?.payload
    if ((meta as { type?: unknown }).type !== 'session_meta' || typeof payload?.id !== 'string' || typeof payload.cwd !== 'string') continue
    if (cwds.includes(payload.cwd) && contains(file, dispatch)) return payload.id
  }
  return null
}

// --plugin-dir 값. 새 터미널의 ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR, 없으면 옛 에이전트의 실행 줄에서 읽은 값이다.
// claude-agent-view 아래 해시 폴더가 여럿일 수 있어 폴더 목록에서 고르지 않는다
export function pickPluginDir(fromEnv: string | undefined, requested: string | null): string | null {
  if (fromEnv && isDir(fromEnv)) return fromEnv
  if (requested && isDir(requested)) return requested
  return null
}

export function claudeResumeArgv(session: string, req: Pick<ResumeRequest, 'model' | 'effort'>, pluginDir: string): string[] {
  return ['claude', '--plugin-dir', pluginDir, '--permission-mode', 'auto', '--model', req.model, ...(req.effort ? ['--effort', req.effort] : []), '--resume', session]
}

// Orca 의 Codex 실행 줄(2026-11-05 ps 실측)을 따른다. -c 값은 TOML 로 읽히므로 ORCA_* 값은 JSON 문자열(TOML 기본 문자열과 같은 꼴)로 감싼다.
// 감싸지 않으면 숫자만 든 값이 정수로 읽힌다. ORCA_* 가운데 하나라도 없으면 null
export function codexResumeArgv(session: string, req: Pick<ResumeRequest, 'model' | 'effort'>, env: NodeJS.ProcessEnv): string[] | null {
  const sets: string[] = []
  for (const name of CODEX_ORCA_ENV) {
    const value = env[name]
    if (!value) return null
    sets.push('-c', `shell_environment_policy.set.${name}=${JSON.stringify(value)}`)
  }
  return ['codex', 'resume', session, '--no-daemon', ...sets, '-c', 'check_for_update_on_startup=false', '-c', 'disable_paste_burst=true',
    '--dangerously-bypass-approvals-and-sandbox', '-m', req.model, ...(req.effort ? ['-c', `model_reasoning_effort=${req.effort}`] : [])]
}

// exec 로 시작하는 셸 한 줄. 낱말마다 작은따옴표로 감싼다
export function shellLine(argv: string[]): string {
  return `exec ${argv.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(' ')}`
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

export function readRequest(dir: string): ResumeRequest {
  const data = JSON.parse(readFileSync(join(dir, REQUEST), 'utf8')) as ResumeRequest
  if (typeof data?.dispatch !== 'string' || typeof data.worktree !== 'string' || (data.agent !== 'claude' && data.agent !== 'codex')
    || typeof data.model !== 'string' || typeof data.goDeadline !== 'number') throw new Error(`${REQUEST} 형식이 잘못됐다`)
  return data
}

export function writeRequest(dir: string, req: ResumeRequest): void {
  writeAtomic(join(dir, REQUEST), `${JSON.stringify(req)}\n`)
}

export function writeFound(dir: string, found: Found): void {
  writeAtomic(join(dir, FOUND), `${JSON.stringify(found)}\n`)
}

export function readFound(dir: string): Found | null {
  try {
    const data = JSON.parse(readFileSync(join(dir, FOUND), 'utf8')) as Found
    return typeof data?.ok === 'boolean' ? data : null
  } catch {
    return null
  }
}

export function writeLaunch(dir: string, argv: string[]): void {
  writeAtomic(join(dir, LAUNCH), `${shellLine(argv)}\n`)
}
