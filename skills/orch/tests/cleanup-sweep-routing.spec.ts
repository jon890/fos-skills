import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fx, runSweepFull } from './fixtures/cleanup-sweep.ts'
import { afterEach, beforeEach, test } from 'node:test'
import { sweepRouting } from '../scripts/lib/routing-log.ts'
import { fixture, launch, PR } from './fixtures/routing-fakes.ts'

let f: ReturnType<typeof fixture>
beforeEach(() => { f = fixture() })
afterEach(() => f.close())
const NOW = Date.parse('2026-11-06T03:00:00Z')

test('run 없이도 CLOSED PR과 finish가 빠진 MERGED PR을 기록한다', async () => {
  for (const state of ['CLOSED', 'MERGED']) {
    Object.assign(f.state.pr, { ...PR, state, number: state === 'CLOSED' ? 7 : 8, mergedAt: state === 'CLOSED' ? null : PR.mergedAt,
      closedAt: state === 'CLOSED' ? PR.mergedAt : null })
    f.history(launch({ dispatch: `ctx_${state}` }))
    f.save()
    await sweepRouting(f.dir, NOW)
  }
  assert.deepEqual(f.rows().map(row => row.outcome), ['closed', 'merged'])
})

test('오래된 이력과 이미 기록한 이력은 다시 조회하지 않는다', async () => {
  f.history(launch({ at: '2026-09-01T00:00:00Z' }))
  await sweepRouting(f.dir, NOW)
  assert.deepEqual(f.rows(), [])
  f.history(launch({ dispatch: 'ctx_new' }))
  await sweepRouting(f.dir, NOW)
  const count = f.calls().length
  await sweepRouting(f.dir, NOW)
  assert.equal(f.calls().length, count)
})

test('cleanup CLI가 apply일 때만 run 없이 routing을 쓴다', () => {
  const state = join(fx.repo, '.orch/state')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'launch-history.jsonl'), JSON.stringify(launch({ at: new Date(Date.now() - 3600_000).toISOString() })) + '\n')
  const pr = { ...PR, state: 'CLOSED', createdAt: new Date(Date.now() - 3000_000).toISOString(), mergedAt: null, closedAt: new Date(Date.now() - 1000).toISOString() }
  fx.ghRaw['feat/a'] = JSON.stringify([pr])
  fx.prViews['7'] = pr
  fx.env.ORCA_USAGE_DIR = join(fx.tmp, 'missing-usage')
  runSweepFull([])
  assert.throws(() => readFileSync(join(state, 'routing-log.jsonl')))
  const done = runSweepFull(['--apply'])
  assert.ok(!done.stderr.includes('ROUTING-LOG-FAIL'), done.stderr)
  const recorded = JSON.parse(readFileSync(join(state, 'routing-log.jsonl'), 'utf8'))
  assert.equal(recorded.pr, 7)
  assert.equal(recorded.outcome, 'closed')
})
