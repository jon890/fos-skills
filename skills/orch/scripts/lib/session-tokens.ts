// worker 세션 기록(Claude 의 projects/<경로>/<세션>.jsonl, Codex 의 sessions/날짜/rollout-*.jsonl)에서 dispatch 의 토큰을 센다.
// Orca 사용량 파일은 늦게 갱신되므로 기록이 있으면 이쪽을 먼저 쓴다. 읽을 수 없으면 null 이다.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { profilesRoot } from './claude-profile.ts'

export type SessionTokens = { input: number; output: number; cache_read: number; cache_write: number }
// 실행 이력의 at 은 worker 를 띄운 뒤에 적히므로 세션은 그보다 조금 먼저 시작할 수 있다. 호출하는 쪽이 SLACK_MS 만큼 앞당긴 기간을 준다.
export const SLACK_MS = 5 * 60_000
export type Window = { worktree: string; from: number; until: number }

const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
const names = (dir: string): string[] => { try { return readdirSync(dir) } catch { return [] } }
const add = (a: SessionTokens, b: SessionTokens) => { for (const k of Object.keys(a) as Array<keyof SessionTokens>) a[k] += b[k] }

// Claude 가 프로젝트 폴더 이름을 만드는 방식: 영숫자가 아닌 글자를 모두 -로 바꾼다.
export const claudeProjectName = (worktree: string): string => resolve(worktree).replace(/[^A-Za-z0-9]/g, '-')

function claudeHomes(): string[] {
  const homes = [process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')]
  const root = profilesRoot()
  for (const id of names(root)) homes.push(join(root, id, 'home'))
  return [...new Set(homes.filter((h): h is string => !!h))]
}

function codexHomes(): string[] {
  const homes = [process.env.CODEX_HOME, join(homedir(), '.codex')]
  const accounts = process.env.ORCA_CODEX_ACCOUNTS || join(homedir(), 'Library/Application Support/Orca/codex-accounts')
  for (const id of names(accounts)) homes.push(join(accounts, id, 'home'))
  return [...new Set(homes.filter((h): h is string => !!h))]
}

// 같은 message.id 는 스트리밍으로 여러 줄 남을 수 있어 한 번만 센다.
export function claudeTokens(w: Window): SessionTokens | null {
  const seen = new Map<string, SessionTokens>()
  for (const home of claudeHomes()) {
    const dir = join(home, 'projects', claudeProjectName(w.worktree))
    for (const file of names(dir).filter(n => n.endsWith('.jsonl'))) {
      let text: string
      try { text = readFileSync(join(dir, file), 'utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (!line.includes('"usage"')) continue
        let row: any
        try { row = JSON.parse(line) } catch { continue }
        const at = Date.parse(row?.timestamp)
        const usage = row?.message?.usage
        if (row?.type !== 'assistant' || !usage || typeof row.message.id !== 'string' || !(at >= w.from && at < w.until)) continue
        seen.set(row.message.id, { input: num(usage.input_tokens), output: num(usage.output_tokens),
          cache_read: num(usage.cache_read_input_tokens), cache_write: num(usage.cache_creation_input_tokens) })
      }
    }
  }
  if (!seen.size) return null
  const total: SessionTokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
  for (const t of seen.values()) add(total, t)
  return total
}

// 세션 하나의 마지막 token_count 가 누적 합계다. 입력은 캐시 읽기를 뺀 값으로 맞춘다.
export function codexTokens(w: Window): SessionTokens | null {
  const total: SessionTokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
  let found = false
  // 날짜 폴더 기준이 UTC 인지 로컬인지 알 수 없어 하루 앞뒤도 본다.
  const days = new Set<string>()
  for (let t = w.from - 86400_000; t <= Math.min(w.until, Date.now()) + 86400_000; t += 86400_000) {
    days.add(new Date(t).toISOString().slice(0, 10).split('-').join('/'))
  }
  for (const home of codexHomes()) for (const day of days) {
    const dir = join(home, 'sessions', day)
    for (const file of names(dir).filter(n => n.startsWith('rollout-') && n.endsWith('.jsonl'))) {
      let text: string
      try { text = readFileSync(join(dir, file), 'utf8') } catch { continue }
      const nl = text.indexOf('\n')
      let meta: any
      try { meta = JSON.parse(nl < 0 ? text : text.slice(0, nl)) } catch { continue }
      const start = Date.parse(meta?.payload?.timestamp ?? meta?.timestamp)
      const cwd = meta?.payload?.cwd
      if (meta?.type !== 'session_meta' || typeof cwd !== 'string' || resolve(cwd) !== resolve(w.worktree) || !(start >= w.from && start < w.until)) continue
      // 집계를 끝낼 시각 뒤의 누적값은 다른 일의 토큰이라 until 앞의 마지막 token_count 를 쓴다.
      let usage: any
      for (const line of text.split('\n')) {
        if (!line.includes('"total_token_usage"')) continue
        try {
          const row = JSON.parse(line)
          if (Date.parse(row?.timestamp) < w.until && row?.payload?.info?.total_token_usage) usage = row.payload.info.total_token_usage
        } catch { continue }
      }
      if (!usage) continue
      const cached = num(usage.cached_input_tokens)
      add(total, { input: Math.max(0, num(usage.input_tokens) - cached), output: num(usage.output_tokens), cache_read: cached, cache_write: 0 })
      found = true
    }
  }
  return found ? total : null
}

export const sessionTokens = (agent: string, w: Window): SessionTokens | null =>
  agent === 'claude' ? claudeTokens(w) : agent === 'codex' ? codexTokens(w) : null

// 워크트리의 Claude 세션 가운데 since(ms) 뒤에 시작한 세션의 첫 assistant 응답 모델 ID. 없거나 그런 세션이 둘 이상이면 null 이다.
// launch-worker 가 계열 이름(`fable`)으로 띄운 worker 의 실제 모델을 띄우기 기록에 남기려고 부른다.
// 세션의 시작은 파일의 첫 `timestamp` 다. 파일 수정 시각으로 고르지 않는다. 같은 워크트리의 옛 세션이 나중에 갱신돼도 그 세션의 모델을 읽지 않는다.
// 응답도 since 뒤의 것만 본다. `<synthetic>` 같은 가짜 응답은 건너뛴다
export function claudeModelOf(worktree: string, since: number): string | null {
  // Claude 는 실제 경로(/private/var/…)로 폴더 이름을 만든다. 받은 경로와 실제 경로를 모두 본다
  let real = worktree
  try { real = realpathSync(worktree) } catch { /* 없는 경로면 받은 그대로 */ }
  const projects = [...new Set([claudeProjectName(worktree), claudeProjectName(real)])]
  const sessions = new Map<string, string | null>()
  for (const home of claudeHomes()) for (const project of projects) {
    const dir = join(home, 'projects', project)
    for (const name of names(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(dir, name)
      try {
        if (statSync(file).mtimeMs < since) continue
        let started: number | null = null
        let model: string | null = null
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue
          let row: { type?: unknown; timestamp?: unknown; message?: { model?: unknown } }
          try { row = JSON.parse(line) } catch { continue }
          const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
          if (started === null && Number.isFinite(at)) started = at
          if (row.type === 'assistant' && Number.isFinite(at) && at >= since && typeof row.message?.model === 'string' && /^claude-/.test(row.message.model)) { model = row.message.model; break }
        }
        if (started !== null && started >= since) sessions.set(realPathOr(file), model)
      } catch { /* 쓰는 중인 줄이나 지워진 파일은 건너뛴다 */ }
    }
  }
  if (sessions.size !== 1) return null
  return [...sessions.values()][0]
}

function realPathOr(file: string): string {
  try { return realpathSync(file) } catch { return file }
}
