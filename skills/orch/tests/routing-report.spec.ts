import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { readPrices, reportRows } from '../scripts/lib/routing-report.ts'
import type { RoutingRecord } from '../scripts/lib/routing-log.ts'

let dir: string
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'routing-report-'))) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const sol = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }
const opus = { agent: 'claude', model: 'claude-opus-5-5', effort: 'medium' }
function record(pr: number, extra: Partial<RoutingRecord> = {}): RoutingRecord {
  return { version: 1, recorded_at: '2026-11-06T12:00:00Z', repo: 'test/a', pr, branch: `feat/${pr}`, outcome: 'merged',
    merged_at: '2026-11-06T12:00:00Z', closed_at: null,
    dispatches: [{ dispatch: 'd1', at: '2026-11-06T00:00:00Z', agent: 'claude', model: 'requested-other', effort: 'high',
      effective: sol, row: 'impl-explore', experiment: null, retry_of: null, opened_pr: true }], task_row: 'impl-explore', size_grade: 'B',
    first_review: { P1: 0, P2: 2 }, fix_commits_after_review: 2, ci_failures: 0, questions: 1, escalations: 0, coordinator_messages: 0,
    minutes_to_ready: 10, minutes_waiting_user: 0, tokens: { input: 1_000_000, output: 100_000, cache_read: 500_000, cache_write: 0 }, ...extra }
}
function repo(name: string, rows: RoutingRecord[], text = ''): string {
  const root = join(dir, name)
  mkdirSync(join(root, '.orch/state'), { recursive: true })
  writeFileSync(join(root, '.orch/state/routing-log.jsonl'), text + rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  return root
}
function cli(args: string[]) {
  const env = { ...process.env, ORCH_DIR: '.orch', GIT_CEILING_DIRECTORIES: dir, ORCH_SCRIPTS_DIR: resolve('skills/orch/scripts') }
  delete env.ORCH_OUTPUT
  return spawnSync(process.execPath, ['skills/orch/bin/orch.ts', 'routing', 'report', ...args], { encoding: 'utf8', env })
}

test('실제 진입점으로 두 저장소를 모아 중앙값·평균·요청과 다른 effective·비용을 계산한다', () => {
  const a = repo('a', [record(1), record(2, { minutes_to_ready: 30, questions: 3, first_review: { P1: 2, P2: 4 }, ci_failures: 2,
    fix_commits_after_review: 4, tokens: { input: 2_000_000, output: 300_000, cache_read: 0, cache_write: 0 } })])
  const b = repo('b', [record(1, { repo: 'test/b', minutes_to_ready: null, first_review: null, tokens: null, ci_failures: null, questions: null, fix_commits_after_review: null })])
  const result = cli(['--repo', a, '--repo', b, '--json'])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [{ ...sol, task_row: 'impl-explore', samples: 3, small_sample: true, hours_to_ready_median: 1 / 3,
    first_review_p1_mean: 1, first_review_p2_mean: 3, fix_commits_after_review_mean: 3, ci_failures_mean: 1, questions_mean: 2,
    output_tokens_median: 200_000, estimated_cost_usd_median: 5.025, first_dispatch_samples: 3, retried_pr_ratio: 0 }])
  const full = cli(['--repo', a, '--repo', b, '--full'])
  assert.match(full.stdout, /^\| agent \|/)
  assert.match(full.stdout, /표본 적음/)
  assert.match(full.stdout, /준비 중앙\(시간\)/)
  assert.match(full.stdout, /0\.333333/)
  const short = cli(['--repo', a])
  assert.match(short.stdout, /^ROUTING-ROW /)
  assert.match(short.stdout, /samples=2/)
})

test('품질은 PR을 연 모델에, 재시도 비율만 시각상 첫 모델에 돌리고 task_row를 유지한다', () => {
  const r = record(1)
  const first = { ...r.dispatches[0], effective: opus, row: 'hard-design', opened_pr: false }
  r.dispatches = [{ ...r.dispatches[0], at: '2026-11-06T01:00:00Z', dispatch: 'retry', retry_of: 'd1' }, first]
  const rows = reportRows([r, record(2)], readPrices())
  const a = rows.find(row => row.model === sol.model)!
  const b = rows.find(row => row.model === opus.model)!
  assert.equal(a.samples, 2)
  assert.equal(a.first_dispatch_samples, 1)
  assert.equal(a.retried_pr_ratio, 0)
  assert.equal(b.task_row, 'impl-explore')
  assert.equal(b.samples, 0)
  assert.equal(b.hours_to_ready_median, null)
  assert.equal(b.first_dispatch_samples, 1)
  assert.equal(b.retried_pr_ratio, 1)
})

test('가격표의 모델 id를 읽고 알 수 없는 모델과 가격표 부재는 비용을 비운다', () => {
  const prices = readPrices()
  assert.deepEqual(prices.get('gpt-6.1-sol'), { input: 2, output: 10 })
  const r = record(1)
  r.dispatches[0].effective = { ...sol, model: 'unknown' }
  assert.equal(reportRows([r], prices)[0].estimated_cost_usd_median, null)
  assert.equal(reportRows([record(1)], readPrices(join(dir, 'missing')))[0].estimated_cost_usd_median, null)
  const unknownRepo = repo('unknown', [r])
  const full = cli(['--repo', unknownRepo, '--full'])
  assert.equal(full.status, 0, full.stderr)
  assert.equal(full.stdout.trim().split('\n')[2].split('|')[13].trim(), '')
  const table = join(dir, 'prices.md')
  writeFileSync(table, '### 비교 근거\n| 모델 id | 입력 / 출력 ($/1M 토큰) |\n| --- | --- |\n| `gpt-6.1-sol` | 3 / 15 |\n')
  assert.equal(reportRows([record(1)], readPrices(table))[0].estimated_cost_usd_median, 4.575)
  writeFileSync(table, '깨진 표')
  assert.equal(readPrices(table).size, 0)
})

test('Claude 캐시 읽기와 5분 쓰기 배수를 쓴다', () => {
  const r = record(1, { tokens: { input: 1_000_000, output: 100_000, cache_read: 1_000_000, cache_write: 1_000_000 } })
  r.dispatches[0].effective = opus
  assert.equal(reportRows([r], readPrices())[0].estimated_cost_usd_median, 11.2)
})

test('깨진 줄과 잘못된 집계 필드를 경고하고 뒤의 정상 줄을 읽으며 원본은 바꾸지 않는다', () => {
  const malformed = record(3)
  ;(malformed.dispatches[0] as unknown as { opened_pr: string }).opened_pr = 'false'
  const a = repo('a', [record(1), { ...record(2), dispatches: null } as unknown as RoutingRecord, malformed], '\n{PRIVATE broken\n')
  const file = join(a, '.orch/state/routing-log.jsonl'), original = readFileSync(file, 'utf8')
  const result = cli(['--repo', a, '--json'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout)[0].samples, 1)
  assert.match(result.stderr, new RegExp('routing-log.jsonl:2:'))
  assert.match(result.stderr, /PR 2: 집계 필드/)
  assert.match(result.stderr, /PR 3: 집계 필드/)
  assert.ok(!result.stderr.includes('PRIVATE'))
  assert.equal(readFileSync(file, 'utf8'), original)
})

test('종료일 필터는 UTC 경계를 포함하고 중복 저장소·PR을 중복 집계하지 않는다', () => {
  const a = repo('a', [record(1, { merged_at: '2026-11-05T23:59:59Z' }), record(2, { outcome: 'closed', merged_at: null, closed_at: '2026-11-06T00:00:00Z' })])
  const b = repo('b', [record(2, { outcome: 'closed', merged_at: null, closed_at: '2026-11-06T00:00:00Z' })])
  const result = cli(['--repo', a, '--repo', a, '--repo', b, '--since', '2026-11-06', '--json'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout)[0].samples, 1)
  for (const since of ['2026-02-30', 'yesterday', '2026-13-01']) assert.equal(cli(['--repo', a, '--since', since]).status, 2)
})

test('10건부터 표본 적음 표시를 없애며 누락 effective는 요청 모델로 대체하지 않는다', () => {
  const rows = Array.from({ length: 10 }, (_, n) => record(n))
  assert.equal(reportRows(rows, readPrices())[0].small_sample, false)
  const r = record(1); r.dispatches[0].effective = null
  const row = reportRows([r], readPrices())[0]
  assert.equal(row.model, null)
  assert.equal(row.estimated_cost_usd_median, null)
})

test('없는 폴더와 기록 파일마다 경고하며 빈 JSON을 내고 읽기 실패는 1이다', () => {
  const missing = resolve(dir, 'empty')
  const a = repo('a', [])
  const file = join(a, '.orch/state/routing-log.jsonl')
  rmSync(file)
  const result = cli(['--repo', missing, '--repo', a, '--json'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '[]')
  assert.deepEqual(result.stderr.trim().split('\n').sort(), [
    `ROUTING-LOG-WARN ${join(missing, '.orch/state/routing-log.jsonl')}: 기록 없음`,
    `ROUTING-LOG-WARN ${file}: 기록 없음`,
  ].sort())
  mkdirSync(file)
  assert.equal(cli(['--repo', a]).status, 1)
})

test('Codex 캐시 쓰기는 30분 배수이며 배수를 모르는 새 모델의 캐시 비용은 비운다', () => {
  const r = record(1, { tokens: { input: 0, output: 0, cache_read: 0, cache_write: 1_000_000 } })
  assert.equal(reportRows([r], readPrices())[0].estimated_cost_usd_median, 2.5)
  r.dispatches[0].effective = { ...sol, model: 'future' }
  r.tokens!.cache_read = 1
  assert.equal(reportRows([r], new Map([['future', { input: 1, output: 5 }]]))[0].estimated_cost_usd_median, null)
})


test('PR을 연 뒤 붙은 후속 dispatch는 다시 띄운 PR로 세지 않는다', () => {
  for (const retry_of of [null, 'd1']) {
    const r = record(1)
    const opener = r.dispatches[0]
    r.dispatches = [{ ...opener, dispatch: 'follow-up', at: '2026-11-06T01:00:00Z', opened_pr: false, retry_of }, opener]
    const row = reportRows([r], readPrices())[0]
    assert.equal(row.samples, 1)
    assert.equal(row.first_dispatch_samples, 1)
    assert.equal(row.retried_pr_ratio, 0)
  }
})


test('JSON과 전체 표 출력을 함께 고르면 진입점에서 사용법 오류로 끝낸다', () => {
  const a = repo('a', [record(1)])
  for (const flags of [['--json', '--full'], ['--full', '--json']]) {
    const result = cli(['--repo', a, ...flags])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--json 과 --full 은 함께 쓸 수 없다/)
  }
})
