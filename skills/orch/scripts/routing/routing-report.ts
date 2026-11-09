// 읽기 전용 routing 집계. --since는 PR 종료일(UTC)부터 포함한다.
// 비용은 PR 전체 토큰에 PR을 연 모델의 현재 단가를 적용한 추정이다. dispatch별 비용은 기록에 없다.
// 요청 단위 정보가 없어 Haiku 의 10만 토큰 초과 요청 단가와 Fast mode 단가는 반영하지 않는다.
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

const USAGE = 'orch routing report [--repo DIR]... [--since YYYY-MM-DD] [--json | --full]'
const options = { repo: { type: 'string', multiple: true }, since: { type: 'string' }, json: { type: 'boolean' }, full: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } as const
function show(v: unknown): string { return v == null ? '' : typeof v === 'number' ? String(Number(v.toFixed(6))) : String(v).replace(/[|\r\n]/g, ' ') }
const columns: Array<[keyof ReportRow, string]> = [
  ['agent', 'agent'], ['model', '모델'], ['effort', 'effort'], ['task_row', '지침 행'], ['samples', '표본 수'],
  ['hours_to_ready_median', '준비 중앙(시간)'], ['first_review_p1_mean', '첫 리뷰 P1 평균'], ['first_review_p2_mean', '첫 리뷰 P2 평균'],
  ['fix_commits_after_review_mean', '리뷰 뒤 커밋 평균'], ['ci_failures_mean', 'CI 실패 평균'], ['questions_mean', '질문 평균'],
  ['output_tokens_median', '출력 토큰 중앙'], ['estimated_cost_usd_median', '비용 추정 중앙($)'],
  ['first_dispatch_samples', '첫 dispatch 표본 수'], ['retried_pr_ratio', '다시 띄운 PR 비율'],
]
function main(): number {
  let args: { repo?: string[]; since?: string; json?: boolean; full?: boolean; help?: boolean }
  try {
    args = parseArgs({ args: expandArgs(process.argv.slice(2), options), options }).values
    if (args.json && (args.full || fullAsked())) throw new Error('--json 과 --full 은 함께 쓸 수 없다')
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
  const rows = reportRows([...records.values()], readPrices())
  if (args.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
  else if (args.full || fullAsked()) {
    process.stdout.write(`| ${columns.map(([, title]) => title).join(' | ')} | 비고 |\n| ${columns.map(() => '---').join(' | ')} | --- |\n`)
    for (const row of rows) process.stdout.write(`| ${columns.map(([key]) => show(row[key])).join(' | ')} | ${row.small_sample ? '표본 적음' : ''} |\n`)
  } else for (const row of rows) process.stdout.write(`ROUTING-ROW ${columns.map(([key]) => `${key}=${JSON.stringify(row[key])}`).join(' ')}${row.small_sample ? ' 표본 적음' : ''}\n`)
  return 0
}
try { process.exitCode = main() }
catch (e) { process.stderr.write(`ROUTING-REPORT-FAIL ${(e as Error).message}\n`); process.exitCode = 1 }
