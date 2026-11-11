import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendStepLaunch, stepLaunches } from '../scripts/lib/step-launches.ts'
import { recordStepLaunch } from '../scripts/lib/auto-advance.ts'

test('띄운 기록은 항목과 단계로 고르고 깨진 줄과 마지막 줄바꿈 누락을 견딘다', t => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'step-launches-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const previous = process.env.ORCH_DIR
  process.env.ORCH_DIR = join(repo, '.orch')
  t.after(() => { if (previous === undefined) delete process.env.ORCH_DIR; else process.env.ORCH_DIR = previous })
  assert.deepEqual(stepLaunches(repo, 'a', '2. 다음'), [])
  const row = { item: 'a', number: 2, step: '2. 다음', dispatch: 'ctx_1', branch: 'feat/x' }
  appendStepLaunch(repo, row)
  appendStepLaunch(repo, { ...row, dispatch: 'ctx_2' })
  assert.deepEqual(stepLaunches(repo, 'a', row.step), [{ dispatch: 'ctx_1', branch: 'feat/x' }, { dispatch: 'ctx_2', branch: 'feat/x' }])
  assert.deepEqual(stepLaunches(repo, 'other', row.step), [])
  assert.deepEqual(stepLaunches(repo, 'a', '다른 단계'), [])
  const file = join(repo, '.orch/state/step-launches.jsonl')
  appendFileSync(file, 'broken\n' + JSON.stringify({ item: 'a', step: row.step, dispatch: 'old' }))
  appendStepLaunch(repo, { ...row, dispatch: 'ctx_3' })
  assert.deepEqual(stepLaunches(repo, 'a', row.step).slice(-2), [{ dispatch: 'old', branch: null }, { dispatch: 'ctx_3', branch: 'feat/x' }])
  assert.ok(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).at.endsWith('Z'))
})

test('첫 미완료 자동 단계만 기록하고 사건 꼬리표는 비교할 글에서 뺀다', t => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'record-step-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const old = { ORCH_DIR: process.env.ORCH_DIR, BOARD_BIN: process.env.BOARD_BIN }
  process.env.ORCH_DIR = join(repo, '.orch')
  delete process.env.BOARD_BIN
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  assert.equal(recordStepLaunch(repo, 'a', 'ctx', null), false)
  mkdirSync(join(repo, '.omc'), { recursive: true })
  const board = join(repo, '.omc/board.json')
  for (const text of ['2. 다음', '2. [ask] 다음', '2. [auto] 다음 (#700 merge)']) {
    writeFileSync(board, JSON.stringify({ items: [{ id: 'a', status: 'doing', details: [text] }] }))
    assert.equal(recordStepLaunch(repo, 'a', 'ctx', 'feat/x'), text.includes('[auto]'))
  }
  assert.deepEqual(stepLaunches(repo, 'a', '2. [auto] 다음'), [{ dispatch: 'ctx', branch: 'feat/x' }])
  assert.equal(recordStepLaunch(repo, 'missing', 'ctx', null), false)
  writeFileSync(board, 'broken')
  assert.throws(() => recordStepLaunch(repo, 'a', 'ctx', null))
  assert.ok(existsSync(board))
})
