// 읽기 전용 routing 집계. --since는 PR 종료일(UTC)부터 포함한다.
// 비용은 PR 전체 토큰에 PR을 연 모델의 현재 단가를 적용한 추정이다. dispatch별 비용은 기록에 없다.
// 요청 단위 정보가 없어 Haiku 의 10만 토큰 초과 요청 단가와 Fast mode 단가는 반영하지 않는다.
// --by-size 는 크기 구간(작음, 중간, 큼, 옛 기록은 미기록)도 묶음에 넣는다.
// --compare 는 지침 행과 크기 구간마다 모델들을 한 줄에 나란히 둔다. 칸마다 값은 「모델」 칸의 순서대로 ` / ` 로 잇는다.
// 첫 리뷰는 출처마다 칸이 따로다(`첫 리뷰 <출처>`). 칸 값은 지적 등급별 평균과 표본 수다.
// 종료 코드: 0 성공(손상 줄 경고 포함), 1 파일 읽기 실패, 2 사용법 오류.
import { parseArgs } from 'node:util'
import { statSync } from 'node:fs'
import { expandArgs } from '../lib/args.ts'
import { routingRecords, type RoutingRecord } from '../lib/routing-log.ts'
import { readPrices, reportable, reportRows, type ReportRow } from '../lib/routing-report.ts'
import { fullAsked } from '../lib/output.ts'
import { pathOf } from '../lib/paths.ts'
import { mainCheckout } from '../lib/git.ts'
import { real } from '../lib/fs.ts'
import { join } from 'node:path'

const USAGE = 'orch routing report [--repo DIR]... [--since YYYY-MM-DD] [--by-size | --compare] [--json | --full]'
const options = { repo: { type: 'string', multiple: true }, since: { type: 'string' }, json: { type: 'boolean' }, full: { type: 'boolean' },
  'by-size': { type: 'boolean' }, compare: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } as const
function show(v: unknown): string { return v == null ? '' : typeof v === 'number' ? String(Number(v.toFixed(6))) : String(v).replace(/[|\r\n]/g, ' ') }
const SIZES: Record<string, string> = { small: '작음', medium: '중간', large: '큼' }
const sizeName = (size: string | null): string => size ? SIZES[size] ?? size : '미기록'
type Cell = (row: ReportRow) => unknown
const before: Array<[string, Cell]> = [['agent', r => r.agent], ['모델', r => r.model], ['effort', r => r.effort], ['지침 행', r => r.task_row]]
const metrics: Array<[string, Cell]> = [
  ['표본 수', r => r.samples], ['준비 중앙(시간)', r => r.hours_to_ready_median],
  ['리뷰 뒤 커밋 평균', r => r.fix_commits_after_review_mean], ['CI 실패 평균', r => r.ci_failures_mean], ['질문 평균', r => r.questions_mean],
  ['되돌림 평균', r => r.returned_mean], ['보고 없이 멈춤 평균', r => r.stopped_mean],
  ['출력 토큰 중앙', r => r.output_tokens_median], ['비용 추정 중앙($)', r => r.estimated_cost_usd_median],
  ['첫 dispatch 표본 수', r => r.first_dispatch_samples], ['다시 띄운 PR 비율', r => r.retried_pr_ratio],
]
// 출처마다 한 칸. 값은 `P1 0.5, P2 1 (3건)` 꼴이다
function reviewColumns(rows: ReportRow[]): Array<[string, Cell]> {
  const sources = [...new Set(rows.flatMap(row => Object.keys(row.first_review)))].sort()
  return sources.map(source => [`첫 리뷰 ${source}`, (row: ReportRow) => {
    const got = row.first_review[source]
    return got ? `${Object.entries(got.means).map(([key, value]) => `${key} ${show(value)}`).join(', ')} (${got.samples}건)` : null
  }])
}
function table(head: string[], body: string[][]): string {
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map(cells => `| ${cells.join(' | ')} |`)].join('\n') + '\n'
}
type Compare = { task_row: string | null; size: string | null; models: ReportRow[] }
function compare(rows: ReportRow[]): Compare[] {
  const groups = new Map<string, Compare>()
  for (const row of rows) {
    const key = JSON.stringify([row.task_row, row.size])
    if (!groups.has(key)) groups.set(key, { task_row: row.task_row, size: row.size, models: [] })
    groups.get(key)!.models.push(row)
  }
  const order = (size: string | null) => size === 'small' ? 0 : size === 'medium' ? 1 : size === 'large' ? 2 : 3
  return [...groups.values()].sort((a, b) => String(a.task_row).localeCompare(String(b.task_row)) || order(a.size) - order(b.size))
}
const modelName = (row: ReportRow) => [row.agent, row.model, row.effort].filter(Boolean).join(' ') || '-'
function main(): number {
  let args: { repo?: string[]; since?: string; json?: boolean; full?: boolean; 'by-size'?: boolean; compare?: boolean; help?: boolean }
  try {
    args = parseArgs({ args: expandArgs(process.argv.slice(2), options), options }).values
    if (args.json && (args.full || fullAsked())) throw new Error('--json 과 --full 은 함께 쓸 수 없다')
    if (args['by-size'] && args.compare) throw new Error('--by-size 와 --compare 는 함께 쓸 수 없다')
    if (args.since && (!/^\d{4}-\d{2}-\d{2}$/.test(args.since) || !Number.isFinite(Date.parse(args.since)) || new Date(args.since).toISOString().slice(0, 10) !== args.since)) throw new Error('--since 는 YYYY-MM-DD 날짜다')
  } catch (e) { process.stderr.write(`${USAGE}\n${(e as Error).message}\n`); return 2 }
  if (args.help) { process.stdout.write(`${USAGE}\n`); return 0 }
  const records = new Map<string, RoutingRecord>()
  const repos = new Set((args.repo ?? [process.cwd()]).map(repo => mainCheckout(real(repo))))
  for (const repo of repos) {
    const warn = (e: Error) => process.stderr.write(`ROUTING-LOG-WARN ${e.message}\n`)
    const file = join(pathOf('state', repo), 'routing-log.jsonl')
    try { statSync(file) }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      warn(new Error(`${file}: 기록 없음`))
      continue
    }
    for (const record of routingRecords(repo, warn)) {
      if (!reportable(record)) { warn(new Error(`${file}: PR ${record.pr}: 집계 필드 형식 오류`)); continue }
      if (args.since && Date.parse(record.merged_at ?? record.closed_at!) < Date.parse(args.since)) continue
      const key = JSON.stringify([record.repo, record.pr])
      const previous = records.get(key)
      if (!previous || previous.outcome !== 'merged' && record.outcome === 'merged') records.set(key, record)
    }
  }
  const rows = reportRows([...records.values()], readPrices(), { bySize: args['by-size'] || args.compare })
  const full = args.full || fullAsked()
  if (args.compare) {
    const groups = compare(rows)
    if (args.json) process.stdout.write(`${JSON.stringify(groups, null, 2)}\n`)
    else if (full) {
      const cells = [...metrics, ...reviewColumns(rows)]
      process.stdout.write(table(['지침 행', '크기', '모델', ...cells.map(([title]) => title)], groups.map(g => [show(g.task_row), sizeName(g.size),
        g.models.map(modelName).join(' / '), ...cells.map(([, cell]) => g.models.map(row => show(cell(row)) || '-').join(' / '))])))
    } else for (const g of groups) process.stdout.write(`ROUTING-COMPARE task_row=${JSON.stringify(g.task_row)} size=${JSON.stringify(g.size)} models=${JSON.stringify(g.models.map(modelName))} samples=${JSON.stringify(g.models.map(row => row.samples))}\n`)
    return 0
  }
  const columns = [...before, ...(args['by-size'] ? [['크기', (r: ReportRow) => sizeName(r.size)] as [string, Cell]] : []), ...metrics, ...reviewColumns(rows)]
  if (args.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
  else if (full) process.stdout.write(table([...columns.map(([title]) => title), '비고'], rows.map(row => [...columns.map(([, cell]) => show(cell(row))), row.small_sample ? '표본 적음' : ''])))
  else for (const row of rows) process.stdout.write(`ROUTING-ROW ${Object.entries(row).filter(([key]) => key !== 'small_sample' && (key !== 'size' || args['by-size'])).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')}${row.small_sample ? ' 표본 적음' : ''}\n`)
  return 0
}
try { process.exitCode = main() }
catch (e) { process.stderr.write(`ROUTING-REPORT-FAIL ${(e as Error).message}\n`); process.exitCode = 1 }
