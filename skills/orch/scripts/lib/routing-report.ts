// REQ7 집계. 품질은 PR을 연 effective 모델, 재시도는 첫 dispatch에 귀속한다.
// PR 을 연 dispatch 는 기록의 opened_pr 다. 이어 맡은 dispatch(origin returned, stopped)가 준비를 알린 PR 은 수집이 이어 맡기 전 dispatch 에 둔다.
// 모델 이름: 계열 이름(`opus`, `fable`, `sonnet`, `haiku`)으로 남은 기록은 FAMILY_IDS 의 정식 id 로 합친다.
//     이 이름은 2026-11-28 까지 modelId 를 읽지 못한 띄우기에서만 남았고, 그때 Claude Code 의 계열 최신이 이 id 다.
// 단가: 가격표(evidence.md 「### 비교 근거」)에 없는 Codex 모델은 같은 계열(`gpt-<세대>-<계열>`) 가운데 그 세대 이상인 가장 낮은 세대,
//     없으면 가장 높은 세대 행의 단가와 캐시 배수를 쓴다. 공식 가격표에 없는 옛 세대(`gpt-6-sol`)는 다음 세대(`gpt-6.1-sol`) 단가로 본다.
// 일의 크기 구간(size)은 수집이 정한다(lib/routing-log.ts 머리 주석의 「일의 크기」). 옛 기록은 null 이다.
// 첫 리뷰는 출처(first_review_source)마다 따로 센다. 척도가 달라 한 칸에 섞지 않는다. 출처가 없는 옛 기록은 UNKNOWN_SOURCE 다.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleRoot } from './bundle.ts'
import { compareGeneration, parseModel } from './model-generation.ts'
import type { RoutingRecord, SizeBucket } from './routing-log.ts'

type Price = { input: number; output: number }
export type Prices = Map<string, Price>
export type ReviewSummary = { samples: number; means: Record<string, number> }
export type ReportRow = {
  agent: string | null; model: string | null; effort: string | null; task_row: string | null; size: SizeBucket | null
  samples: number; small_sample: boolean; hours_to_ready_median: number | null
  first_review: Record<string, ReviewSummary>
  fix_commits_after_review_mean: number | null; ci_failures_mean: number | null; questions_mean: number | null
  returned_mean: number | null; stopped_mean: number | null
  output_tokens_median: number | null; estimated_cost_usd_median: number | null
  first_dispatch_samples: number; retried_pr_ratio: number | null
}
export const UNKNOWN_SOURCE = '출처 미기록'
export const FAMILY_IDS: Readonly<Record<string, string>> = {
  opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-2',
}
export const canonicalModel = (model: string | null | undefined): string | null => model == null ? null : FAMILY_IDS[model] ?? model

// 공식 가격표의 캐시 읽기 배수(캐시 입력 단가 / 입력 단가). 2026-11-06 확인, gpt-6.2-sol·gpt-6.2-astra·claude-fable-5-2 는 2026-11-27 확인.
// 기본 입력·출력 단가는 모델 조사 근거의 가격표에서 읽는다.
// https://platform.claude.com/docs/en/about-claude/pricing
// https://developers.openai.com/api/docs/pricing
export const CACHE_READ: Readonly<Record<string, number>> = {
  'claude-opus-5-5': 0.05, 'claude-sonnet-5-5': 0.05, 'claude-haiku-5-5': 0.1, 'claude-fable-5-2': 0.025,
  'gpt-6-astra': 0.1, 'gpt-6.1-sol': 0.05, 'gpt-6.1-terra': 0.05, 'gpt-6-luna': 0.1, 'gpt-6.2-sol': 0.05, 'gpt-6.2-astra': 0.05,
}
// 기록에 TTL이 없어 Claude는 5분, Codex는 30분 쓰기 기준의 추정이다.
const CACHE_WRITE = 1.25

export function readPrices(file = join(bundleRoot(), '../../docs/features/orch-routing/evidence.md')): Prices {
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
function identity(dispatch: RoutingRecord['dispatches'][number], task_row: string | null, size: SizeBucket | null) {
  return { agent: dispatch.effective?.agent ?? null, model: canonicalModel(dispatch.effective?.model),
    effort: dispatch.effective?.effort ?? null, task_row, size }
}
const bucketOf = (record: RoutingRecord): SizeBucket | null =>
  record.size && ['small', 'medium', 'large'].includes(record.size.bucket) ? record.size.bucket : null

// 머리 주석의 「단가」. 표에 있으면 그 id, 없으면 같은 계열의 가까운 세대 id 다
export function pricedModel(model: string | null, prices: Prices): string | null {
  if (!model || prices.has(model)) return model
  const name = parseModel(model)
  if (!name || name.provider !== 'codex' || !name.generation) return null
  const family = [...prices.keys()].map(id => ({ id, name: parseModel(id) }))
    .filter(row => row.name?.provider === 'codex' && row.name.family === name.family && row.name.generation)
    .sort((a, b) => compareGeneration(a.name!.generation, b.name!.generation))
  return (family.find(row => compareGeneration(row.name!.generation, name.generation) >= 0) ?? family.at(-1))?.id ?? null
}
function cost(record: RoutingRecord, prices: Prices): number | null {
  const opener = record.dispatches.find(d => d.opened_pr === true)!
  const model = pricedModel(canonicalModel(opener.effective?.model), prices)
  const price = prices.get(model ?? '')
  const agent = opener.effective?.agent
  const readRate = CACHE_READ[model ?? '']
  const t = record.tokens
  if (!price || !t || !Object.values(t).every(numeric) || !['input', 'output', 'cache_read', 'cache_write'].every(k => numeric(t[k as keyof typeof t]))) return null
  if ((agent !== 'claude' && agent !== 'codex') || (t.cache_read > 0 && readRate === undefined)) return null
  return (t.input * price.input + t.output * price.output + t.cache_read * price.input * (readRate ?? 0) +
    t.cache_write * price.input * CACHE_WRITE) / 1_000_000
}

// 출처별 첫 리뷰. first_reviews 가 있으면 출처마다, 옛 기록은 first_review 하나를 그 출처(없으면 UNKNOWN_SOURCE)로 본다
function reviewsOf(record: RoutingRecord): Array<{ source: string; counts: Record<string, number> }> {
  if (Array.isArray(record.first_reviews)) return record.first_reviews.filter(r => r && typeof r.source === 'string' && r.counts && typeof r.counts === 'object')
  return record.first_review && typeof record.first_review === 'object' ? [{ source: record.first_review_source ?? UNKNOWN_SOURCE, counts: record.first_review }] : []
}
function reviewSummary(records: RoutingRecord[]): Record<string, ReviewSummary> {
  const by = new Map<string, Array<Record<string, number>>>()
  for (const record of records) for (const review of reviewsOf(record)) {
    if (!by.has(review.source)) by.set(review.source, [])
    by.get(review.source)!.push(review.counts)
  }
  return Object.fromEntries([...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([source, list]) => {
    const keys = [...new Set(list.flatMap(counts => Object.keys(counts)))].sort()
    return [source, { samples: list.length, means: Object.fromEntries(keys.map(key => [key, mean(list.map(counts => counts[key]))!]).filter(([, v]) => v !== null)) }]
  }))
}

// bySize 면 크기 구간도 묶음 키에 넣는다. 아니면 size 는 늘 null 이다
export function reportRows(records: RoutingRecord[], prices: Prices, options: { bySize?: boolean } = {}): ReportRow[] {
  type Bucket = { id: ReturnType<typeof identity>; records: RoutingRecord[]; first: number; retried: number }
  const groups = new Map<string, Bucket>()
  function bucket(id: ReturnType<typeof identity>): Bucket {
    const key = JSON.stringify(id)
    if (!groups.has(key)) groups.set(key, { id, records: [], first: 0, retried: 0 })
    return groups.get(key)!
  }
  for (const record of records) {
    const size = options.bySize ? bucketOf(record) : null
    const opener = record.dispatches.find(d => d.opened_pr === true)!
    bucket(identity(opener, record.task_row, size)).records.push(record)
    // 이어 맡기기로 생긴 dispatch 는 opened_pr 가 앞 dispatch 에 있어 다시 띄운 것으로 세지 않는다
    const first = [...record.dispatches].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]
    const initial = bucket(identity(first, record.task_row, size))
    initial.first++
    if (Date.parse(first.at) < Date.parse(opener.at)) initial.retried++
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => ({
    ...g.id, samples: g.records.length, small_sample: g.records.length < 10,
    hours_to_ready_median: median(g.records.map(r => numeric(r.minutes_to_ready) ? r.minutes_to_ready / 60 : null)),
    first_review: reviewSummary(g.records),
    fix_commits_after_review_mean: mean(g.records.map(r => r.fix_commits_after_review)),
    ci_failures_mean: mean(g.records.map(r => r.ci_failures)), questions_mean: mean(g.records.map(r => r.questions)),
    returned_mean: mean(g.records.map(r => r.returned)), stopped_mean: mean(g.records.map(r => r.stopped)),
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
