import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { selectionVerdict } from '../scripts/lib/selection.ts'
import { experimentOf, selectionsOf } from '../scripts/lib/spec.ts'
import { launchHistory, latestTerminal, recordHistory, type LaunchHistory } from '../scripts/lib/launch-history.ts'
import { forgetLaunch, readLaunch, recordLaunch } from '../scripts/lib/launched.ts'

let repo: string
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'selection-')); process.env.ORCH_DIR = join(repo, 'orch') })
afterEach(() => { delete process.env.ORCH_DIR; rmSync(repo, { recursive: true, force: true }) })
const opus = (effort = 'high', reason = '') => `worker 선택: \`claude\` \`claude-opus-5-5\` effort \`${effort}\`. 행: hard-design. ${reason} 비교: sol. 이유: 계약 설계.`
const sol = 'worker 선택: `codex` `gpt-6.1-sol` effort `medium`. 행: impl-planned. 비교: Sonnet. 이유: 닫힌 결정.'
const experiment = 'experiment: trial-a. 후보: `claude` `claude-opus-5-5` effort `high` / `codex` `gpt-6.1-sol` effort `medium`.'
const row = (extra: Partial<LaunchHistory> = {}): LaunchHistory => ({ dispatch: 'ctx_old', task: 'task_a', terminal: 'term_a', worktree: repo, branch: 'feat/a', run: 'run_a', at: '2026-11-05T00:00:00Z', title: '계약 설계', row: 'hard-design', agent: 'claude', model: 'claude-opus-5-5', effort: 'medium', retry_of: null, ...extra })

test('파서는 행, 근거, 실험을 읽고 후보 꼴과 중복 줄을 검사한다', () => {
  assert.deepEqual(selectionsOf(opus('high', 'high 근거: medium 실패 ctx_old.'))[0].highReason, { kind: 'dispatch', id: 'ctx_old' })
  assert.deepEqual(selectionsOf(opus('high', 'high 근거: 사용자 지정 2026-11-05.'))[0].highReason, { kind: 'user', date: '2026-11-05' })
  assert.equal(experimentOf(experiment)?.candidates.length, 2)
  for (const text of ['experiment: bad', `${experiment}\n${experiment}`, 'experiment: a. 후보: `x` `y` effort `z`.']) assert.ok(experimentOf(text)!.problems.length)
  assert.match(selectionVerdict(`${sol}\n${experiment.replace('`codex`', '`other`')}`, repo).join(), /후보 밖/)
})

test('문서의 행을 읽고 누락, 알 수 없는 행과 읽을 수 없는 표를 거부한다', () => {
  assert.deepEqual(selectionVerdict(sol, repo), [])
  assert.match(selectionVerdict(sol.replace('행: impl-planned.', ''), repo).join(), /행/)
  assert.match(selectionVerdict(sol.replace('impl-planned', 'unknown'), repo).join(), /모델 표에 없다/)
  assert.match(selectionVerdict(sol, repo, { table: join(repo, 'missing') }).join(), /표를 읽지 못했다/)
  const table = join(repo, 'table.md'); writeFileSync(table, '| `new-row` | 설명 |')
  assert.deepEqual(selectionVerdict(sol.replace('impl-planned', 'new-row'), repo, { table }), [])
})

test('Opus 높은 effort 는 유효 근거를 요구하고 다른 모델과 medium 은 통과한다', () => {
  for (const effort of ['high', 'xhigh', 'max']) assert.match(selectionVerdict(opus(effort), repo).join(), /high 근거/)
  assert.deepEqual(selectionVerdict(opus('medium'), repo), [])
  assert.deepEqual(selectionVerdict(opus().replace('claude-opus-', 'claude-sonnet-'), repo), [])
  assert.deepEqual(selectionVerdict(opus('high', 'high 근거: 사용자 지정 2026-11-05.'), repo), [])
  assert.match(selectionVerdict(opus('high', 'high 근거: 사용자 지정 2026-02-30.'), repo).join(), /날짜/)
  assert.match(selectionVerdict(opus('high', 'high 근거: 다른 이유.'), repo).join(), /high 근거/)
})

test('근거 dispatch 는 effective 우선, 옛 기록은 모델이 없을 때 호환된다', () => {
  const text = opus('high', 'high 근거: medium 실패 ctx_old.')
  assert.match(selectionVerdict(text, repo).join(), /Opus medium/)
  recordLaunch(repo, row({ model: null, effort: null }))
  assert.deepEqual(selectionVerdict(text, repo), [])
  recordLaunch(repo, row({ model: 'claude-sonnet-5-5' }))
  assert.match(selectionVerdict(text, repo).join(), /Opus medium/)
  recordHistory(repo, row({ model: 'claude-sonnet-5-5', effort: 'high', effective: { model: 'claude-opus-5-5', effort: 'medium' } }))
  assert.deepEqual(selectionVerdict(text, repo), [])
  forgetLaunch(repo, 'ctx_old')
  assert.equal(readLaunch(repo, 'ctx_old'), null)
  assert.equal(launchHistory(repo).length, 1)
  assert.deepEqual(selectionVerdict(text, repo), [])
})

test('실험은 띄울 때만 최소 배정과 동률 순서를 검사하며 재시도는 세지 않는다', () => {
  assert.deepEqual(selectionVerdict(`${sol}\n${experiment}`, repo), [])
  assert.match(selectionVerdict(`${sol}\n${experiment}`, repo, { launch: true }).join(), /다음 experiment 후보: claude/)
  assert.deepEqual(selectionVerdict(`${opus()}\n${experiment}`, repo, { launch: true }), [])
  recordHistory(repo, row({ experiment: 'trial-a', effort: 'high', retry_of: 'ctx_first' }))
  assert.match(selectionVerdict(`${sol}\n${experiment}`, repo, { launch: true }).join(), /다음 experiment/)
  recordHistory(repo, row({ dispatch: 'ctx_new', experiment: 'trial-a', effort: 'high', at: '2026-11-06T00:00:00Z' }))
  assert.deepEqual(selectionVerdict(`${sol}\n${experiment}`, repo, { launch: true }), [])
  assert.deepEqual(selectionVerdict(`${opus()}\n${experiment}`, repo, { launch: true, retry: true }), [])
  assert.equal(latestTerminal(repo, 'term_a')?.dispatch, 'ctx_new')
})

test('근거의 실제 모델이나 effort 가 다르면 거부한다', () => {
  for (const [index, extra] of [
    { model: 'claude-sonnet-5-5', effort: 'medium' },
    { model: 'claude-opus-5-5', effort: 'high' },
    { effective: { model: 'claude-opus-5-5', effort: 'high' } },
  ].entries()) {
    const dispatch = `ctx_wrong_${index}`
    recordHistory(repo, row({ ...extra, dispatch }))
    assert.match(selectionVerdict(opus('high', `high 근거: medium 실패 ${dispatch}.`), repo).join(), /Opus medium/)
  }
})

test('실험의 기본 effort 는 옵션을 주지 않은 이력으로 집계한다', () => {
  const experiment = 'experiment: default-effort. 후보: `claude` `haiku` effort `기본` / `codex` `gpt-6.1-sol` effort `medium`.'
  recordHistory(repo, row({ model: 'haiku', effort: null, experiment: 'default-effort' }))
  assert.deepEqual(selectionVerdict(`${sol}\n${experiment}`, repo, { launch: true }), [])
})
