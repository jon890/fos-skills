// REQ7 집계. 품질은 PR을 연 effective 모델, 재시도는 첫 dispatch에 귀속한다.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleRoot } from './bundle.ts'
import type { RoutingRecord } from './routing-log.ts'

type Price = { input: number; output: number }
export type Prices = Map<string, Price>
export type ReportRow = {
  agent: string | null; model: string | null; effort: string | null; task_row: string | null
  samples: number; small_sample: boolean; minutes_to_ready_median: number | null
  first_review_p1_mean: number | null; first_review_p2_mean: number | null
  fix_commits_after_review_mean: number | null; ci_failures_mean: number | null; questions_mean: number | null
  output_tokens_median: number | null; estimated_cost_usd_median: number | null
  first_dispatch_samples: number; retried_pr_ratio: number | null
}

// 2026-11-06 공식 가격표의 캐시 배수. 기본 입력·출력 단가는 지침 표에서 읽는다.
// https://platform.claude.com/docs/en/about-claude/pricing
// https://developers.openai.com/api/docs/pricing
const CACHE_READ: Readonly<Record<string, number>> = {
  'claude-opus-5-5': 0.05, 'claude-sonnet-5-5': 0.05, 'claude-haiku-5-5': 0.1,
  'gpt-6-astra': 0.1, 'gpt-6.1-sol': 0.05, 'gpt-6.1-terra': 0.05, 'gpt-6-luna': 0.1,
}
// 기록에 TTL이 없어 Claude는 5분, Codex는 30분 쓰기 기준의 추정이다.
const CACHE_WRITE = 1.25

export function readPrices(file = join(bundleRoot(), 'references/agent-selection.md')): Prices {
  const prices: Prices = new Map()
  try {
    const text = readFileSync(file, 'utf8').split('### 비교 근거')[1]?.split(/^### /m)[0] ?? ''
    const rows = text.split('\n').filter(line => line.startsWith('|')).map(line => line.split('|').slice(1, -1).map(s => s.trim()))
    const header = rows.findIndex(row => row.includes('모델 id'))
    if (header < 0) return prices
    const model = rows[header].indexOf('모델 id'), cost = rows[header].indexOf('입력 / 출력 ($/1M 토큰)')
    for (const row of rows.slice(header + 2)) {
      const id = /^`([^`]+)`$/.exec(row[model] ?? '')?.[1]
      const values = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?:\s|$)/.exec(row[cost] ?? '')
      if (id && values) prices.set(id, { input: Number(values[1]), output: Number(values[2]) })
    }
  } catch { /* 가격표를 읽지 못하면 비용만 비운다. */ }
  return prices
}

const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
function values(items: Array<number | null | undefined>): number[] { return items.filter(numeric).sort((a, b) => a - b) }
function median(items: Array<number | null | undefined>): number | null {
  const v = values(items), n = v.length
  return n ? (v[Math.floor((n - 1) / 2)] + v[Math.floor(n / 2)]) / 2 : null
}
function mean(items: Array<number | null | undefined>): number | null {
  const v = values(items)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
function identity(dispatch: RoutingRecord['dispatches'][number], task_row: string | null) {
  return { agent: dispatch.effective?.agent ?? null, model: dispatch.effective?.model ?? null,
    effort: dispatch.effective?.effort ?? null, task_row }
}
function cost(record: RoutingRecord, prices: Prices): number | null {
  const opener = record.dispatches.find(d => d.opened_pr === true)!
  const price = prices.get(opener.effective?.model ?? '')
  const agent = opener.effective?.agent
  const readRate = CACHE_READ[opener.effective?.model ?? '']
  const t = record.tokens
  if (!price || !t || !Object.values(t).every(numeric) || !['input', 'output', 'cache_read', 'cache_write'].every(k => numeric(t[k as keyof typeof t]))) return null
  if ((agent !== 'claude' && agent !== 'codex') || (t.cache_read > 0 && readRate === undefined)) return null
  return (t.input * price.input + t.output * price.output + t.cache_read * price.input * (readRate ?? 0) +
    t.cache_write * price.input * CACHE_WRITE) / 1_000_000
}

export function reportRows(records: RoutingRecord[], prices: Prices): ReportRow[] {
  type Bucket = { id: ReturnType<typeof identity>; records: RoutingRecord[]; first: number; retried: number }
  const groups = new Map<string, Bucket>()
  function bucket(id: ReturnType<typeof identity>): Bucket {
    const key = JSON.stringify(id)
    if (!groups.has(key)) groups.set(key, { id, records: [], first: 0, retried: 0 })
    return groups.get(key)!
  }
  for (const record of records) {
    const opener = record.dispatches.find(d => d.opened_pr === true)!
    bucket(identity(opener, record.task_row)).records.push(record)
    const first = [...record.dispatches].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]
    const initial = bucket(identity(first, record.task_row))
    initial.first++
    if (record.dispatches.length > 1) initial.retried++
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => ({
    ...g.id, samples: g.records.length, small_sample: g.records.length < 10,
    minutes_to_ready_median: median(g.records.map(r => r.minutes_to_ready)),
    first_review_p1_mean: mean(g.records.map(r => r.first_review?.P1)),
    first_review_p2_mean: mean(g.records.map(r => r.first_review?.P2)),
    fix_commits_after_review_mean: mean(g.records.map(r => r.fix_commits_after_review)),
    ci_failures_mean: mean(g.records.map(r => r.ci_failures)), questions_mean: mean(g.records.map(r => r.questions)),
    output_tokens_median: median(g.records.map(r => r.tokens?.output)),
    estimated_cost_usd_median: median(g.records.map(r => cost(r, prices))),
    first_dispatch_samples: g.first, retried_pr_ratio: g.first ? g.retried / g.first : null,
  }))
}

// 공용 읽기는 최소 검사만 하므로 집계에 필요한 필드도 확인한다.
export function reportable(record: RoutingRecord): boolean {
  return record.version === 1 && typeof record.repo === 'string' && Array.isArray(record.dispatches) &&
    record.dispatches.length > 0 && record.dispatches.every(d => d && typeof d.opened_pr === 'boolean' && typeof d.at === 'string' && Number.isFinite(Date.parse(d.at)) &&
      (d.effective == null || typeof d.effective === 'object' && ['agent', 'model', 'effort'].every(k =>
        d.effective![k as 'agent' | 'model' | 'effort'] == null || typeof d.effective![k as 'agent' | 'model' | 'effort'] === 'string')) &&
      (d.row == null || typeof d.row === 'string')) && record.dispatches.filter(d => d.opened_pr === true).length === 1 &&
    (record.task_row == null || typeof record.task_row === 'string') && Number.isFinite(Date.parse(record.merged_at ?? record.closed_at ?? ''))
}
