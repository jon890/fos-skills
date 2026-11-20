// Claude 주간 사용량이 초기화 전에 남을 것 같으면 모델 표의 Codex 행을 같은 등급의 Claude 로 바꿔 띄운다.
// 계약은 docs/features/usage-routing/spec.md 와 design.md 다. launch-worker 의 차례 0-0 이 부른다.
//
// 출처: oh-my-claudecode 상태 줄의 사용량 캐시(`<CLAUDE_CONFIG_DIR 또는 ~/.claude>/plugins/oh-my-claudecode/.usage-cache-anthropic.json`).
//     `lastSuccessAt`(ms), `data.weeklyPercent`, `data.weeklyResetsAt`(ISO) 를 읽는다. `error` 가 참이면 값이 없는 것으로 본다.
//     신선도는 `timestamp` 가 아니라 `lastSuccessAt` 으로 본다. 조회가 429 로 막히면 OMC 는 data 와 lastSuccessAt 을 그대로 두고
//     timestamp 만 지금으로 다시 쓰기 때문이다. lastSuccessAt 이 없으면 값이 없는 것으로 본다.
//     ORCH_CLAUDE_USAGE 로 파일을 바꾼다(테스트는 임시 파일을 준다).
// 기준: 남은 사용량 비율(100 − 주간 사용 %)이 남은 시간 비율(초기화까지 남은 시간 ÷ 7일)보다 크면 바꾼다.
// 바꾸는 행: BOOST_ROWS 의 Codex worker 이고 지시서에 `후보 밖:` 이 없을 때만. 같은 등급은 agent-selection.md 「사용 한도에 걸렸을 때」 표의
//     「같은 등급 대응」 칸에서 첫 Claude 모델이다. 그 칸에 effort 가 없으면 행의 effort 를 그대로 쓴다.
// 바꾸지 않는 경우: routing.usage_boost 가 false, 출처가 없거나 읽지 못함, 1시간보다 오래된 값, 초기화 시각이 지난 값.
//     출처 문제는 `USAGE-UNKNOWN <이유>` 한 줄로 알리고 띄우기는 막지 않는다.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bundleRoot } from './bundle.ts'
import { ConfigError, loadConfig, ROUTING_KEYS, section } from './config.ts'
import type { CandidateOverride } from './launched.ts'
import { sameFamily } from './model-generation.ts'
import type { Candidate, Selection } from './spec.ts'

export const BOOST_ROWS: readonly string[] = ['impl-planned', 'impl-explore', 'small-fix', 'design']
export const STALE_MS = 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export type Weekly = { kind: 'ok'; used: number; resetsAt: number; at: number } | { kind: 'unknown'; reason: string }
export type Boost =
  | { kind: 'boost'; worker: Candidate; override: CandidateOverride }
  | { kind: 'keep'; notice: string | null }

export function usageCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCH_CLAUDE_USAGE) return env.ORCH_CLAUDE_USAGE
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json')
}

export function readWeekly(file: string, now: number): Weekly {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { kind: 'unknown', reason: `출처 없음: ${file}` }
  }
  let parsed: { lastSuccessAt?: unknown; error?: unknown; data?: { weeklyPercent?: unknown; weeklyResetsAt?: unknown } }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'unknown', reason: `읽지 못함: ${file}` }
  }
  const used = parsed?.data?.weeklyPercent
  const resetsAt = typeof parsed?.data?.weeklyResetsAt === 'string' ? Date.parse(parsed.data.weeklyResetsAt) : NaN
  const at = parsed?.lastSuccessAt
  if (parsed?.error === true || typeof used !== 'number' || !Number.isFinite(used) || !Number.isFinite(resetsAt) || typeof at !== 'number' || !Number.isFinite(at)) {
    return { kind: 'unknown', reason: `값 없음: ${file}` }
  }
  if (now - at > STALE_MS) return { kind: 'unknown', reason: `오래된 값: ${Math.round((now - at) / 60_000)}분 전에 갱신됐다` }
  if (resetsAt <= now) return { kind: 'unknown', reason: '초기화 시각이 지난 값이다' }
  return { kind: 'ok', used, resetsAt, at }
}

type Entry = { agent: string; model: string; effort: string | null }

// 「사용 한도에 걸렸을 때」 표의 칸 하나. `gpt-6.1-sol` `medium` 이나 Claude Opus 5.5 `medium` 꼴이다
function entryOf(text: string): Entry | null {
  const claude = /^Claude ([A-Za-z]+) (\d+(?:\.\d+)*)(?:\s+`([a-z]+)`)?$/.exec(text.trim())
  if (claude) return { agent: 'claude', model: `claude-${claude[1].toLowerCase()}-${claude[2].replaceAll('.', '-')}`, effort: claude[3] ?? null }
  const codex = /^`([^`]+)`(?:\s+`([a-z]+)`)?$/.exec(text.trim())
  if (codex) return { agent: 'codex', model: codex[1], effort: codex[2] ?? null }
  return null
}

export type LimitRow = { from: Entry; same: Entry[]; cell: string }

// 「사용 한도에 걸렸을 때」 표의 줄. 제목이나 칸 꼴이 바뀌면 빈 목록이다
export function limitRows(table: string): LimitRow[] {
  const lines = table.split('\n')
  const start = lines.indexOf('### 사용 한도에 걸렸을 때')
  if (start === -1) return []
  const rows: LimitRow[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length !== 3) continue
    const from = entryOf(cells[0])
    if (!from) continue
    rows.push({ from, same: cells[1].split(/,\s*/).map(entryOf).filter((e): e is Entry => e !== null), cell: cells[1] })
  }
  return rows
}

// 걸린 모델의 줄. effort 까지 맞는 줄이 먼저이고, 없으면 effort 없는 줄이다. 모델은 같은 계열이면 세대가 달라도 맞는 것으로 본다(model-generation.ts)
export function limitRowOf(table: string, worker: { model: string | null; effort: string | null }): LimitRow | null {
  const rows = limitRows(table)
  const exact = (r: LimitRow) => r.from.model === worker.model
  const family = (r: LimitRow) => sameFamily(r.from.model, worker.model)
  for (const match of [exact, family]) {
    const found = rows.find(r => match(r) && r.from.effort === worker.effort) ?? rows.find(r => match(r) && r.from.effort === null)
    if (found) return found
  }
  return null
}

// 걸린 모델에서 같은 등급 대응 목록으로. 첫 Claude 모델이 답이다
export function sameGradeClaude(table: string, worker: Candidate): Candidate | null {
  const claude = limitRowOf(table, worker)?.same.find(e => e.agent === 'claude')
  if (!claude) return null
  return { agent: 'claude', model: claude.model, effort: claude.effort ?? worker.effort }
}

export function boostEnabled(repo: string): boolean {
  const value = section<{ usage_boost?: unknown }>(loadConfig(repo), 'routing', ROUTING_KEYS).usage_boost
  if (value === undefined) return true
  if (typeof value !== 'boolean') throw new ConfigError('설정 파일의 routing.usage_boost 는 true 나 false 여야 한다')
  return value
}

function percent(value: number): number {
  return Math.round(value)
}

// 지시서의 선택과 사용량으로 바꿀지 정한다. 사용량은 바꿀 수 있는 행일 때만 읽는다
export function decideBoost(input: {
  selection: Selection
  enabled: () => boolean
  weekly: () => Weekly
  now: number
  table: string
}): Boost {
  const { selection } = input
  if (!selection.row || !BOOST_ROWS.includes(selection.row) || selection.agent !== 'codex' || selection.outsideReason) return { kind: 'keep', notice: null }
  if (!input.enabled()) return { kind: 'keep', notice: null }
  const target = sameGradeClaude(input.table, selection)
  if (!target) return { kind: 'keep', notice: null }
  const weekly = input.weekly()
  if (weekly.kind === 'unknown') return { kind: 'keep', notice: `USAGE-UNKNOWN ${weekly.reason}` }
  const left = 100 - weekly.used
  const timeLeft = ((weekly.resetsAt - input.now) / WEEK_MS) * 100
  if (left <= timeLeft) return { kind: 'keep', notice: null }
  return {
    kind: 'boost',
    worker: target,
    override: { row: selection.row, agent: target.agent, model: target.model, effort: target.effort, reason: `사용량: 남은 ${percent(left)}%, 남은 시간 ${percent(timeLeft)}%` },
  }
}

export function readSelectionTable(file = join(bundleRoot(), 'references', 'agent-selection.md')): string {
  return readFileSync(file, 'utf8')
}
