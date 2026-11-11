// 실제 기록 파일과 CLI 를 임시 폴더에서 검증한다. 외부 서비스에는 닿지 않는다.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { notifyUnmatched, recordUnmatched, unmatchedRecords, pruneUnmatched } from '../scripts/lib/board-unmatched.ts'
import { syncBoard } from '../scripts/loop/steps/board.ts'
import type { StepContext, StepState } from '../scripts/loop/steps/context.ts'
import { writeNodeBin } from './fixtures/merge-queue-fakes.ts'

const moduleFile = fileURLToPath(new URL('../scripts/lib/board-unmatched.ts', import.meta.url))
const cli = fileURLToPath(new URL('../scripts/board/board-edit.ts', import.meta.url))
const pending = [{ number: 1, done: false, text: '1. 수동 확인' }]

function fixture(t: { after(fn: () => void): void }): string {
  const repo = mkdtempSync(join(tmpdir(), 'board-unmatched-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  return repo
}

test('재기록·재시작 뒤 중복 전송을 막고 실패·Run 없음 뒤에는 다시 보낸다', (t) => {
  const repo = fixture(t)
  assert.equal(recordUnmatched(repo, { id: 'a' }, pending, '70'), 'BOARD-UNMATCHED a PR #70')
  let attempts = 0
  const success = () => { attempts++; return { ok: true as const, id: 'sent' } }
  notifyUnmatched(repo, null, success)
  notifyUnmatched(repo, 'run', () => ({ ok: false, error: 'offline' }))
  assert.equal(unmatchedRecords(repo).a['70'].notified, null)
  notifyUnmatched(repo, 'run', success)
  const before = unmatchedRecords(repo).a['70']
  recordUnmatched(repo, { id: 'a' }, pending, '70')
  notifyUnmatched(repo, 'new-run', success)
  assert.equal(attempts, 1)
  assert.deepEqual(unmatchedRecords(repo).a['70'], before)
  recordUnmatched(repo, { id: 'a' }, pending, '71')
  notifyUnmatched(repo, 'new-run', success)
  assert.equal(attempts, 2)
})

test('사라진 항목·끝난 단계·해당 PR 의 끝난 꼬리표만 기록을 지운다', (t) => {
  const repo = fixture(t)
  for (const id of ['gone', 'all', 'tag', 'failed']) for (const pr of ['70', '71']) recordUnmatched(repo, { id }, pending, pr)
  pruneUnmatched(repo, new Map([
    ['gone', null], ['all', []], ['failed', undefined],
    ['tag', [{ number: 1, done: true, text: '1. 머지 (#70 merge)' }, ...pending]],
  ]))
  const records = unmatchedRecords(repo)
  assert.deepEqual(Object.keys(records).sort(), ['failed', 'tag'])
  assert.deepEqual(Object.keys(records.tag), ['71'])
  assert.deepEqual(Object.keys(records.failed), ['70', '71'])
})

test('show 는 풀린 기록을 숨기고 파일을 쓰지 않는다', (t) => {
  const repo = fixture(t)
  recordUnmatched(repo, { id: 'a' }, pending, '70')
  const board = join(repo, 'board.json')
  const run = () => spawnSync(process.execPath, [cli, 'show', 'a', '--repo', repo, '--board', board], { encoding: 'utf8' })
  writeFileSync(board, JSON.stringify({ items: [{ id: 'a', status: 'doing', details: ['1. 수동 확인'] }] }))
  const before = readFileSync(join(repo, '.orch/state/board-unmatched.json'), 'utf8')
  let result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /BOARD-UNMATCHED a PR #70/)
  writeFileSync(board, JSON.stringify({ items: [{ id: 'a', status: 'doing', details: [{ text: '1. 머지 (#70 merge)', done: true }, '2. 수동 확인'] }] }))
  result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /BOARD-UNMATCHED/)
  assert.equal(readFileSync(join(repo, '.orch/state/board-unmatched.json'), 'utf8'), before)
})

test('별도 프로세스의 동시 기록과 알림 확정이 기존 항목·PR 을 보존한다', async (t) => {
  const repo = fixture(t)
  recordUnmatched(repo, { id: 'a' }, pending, '70')
  const run = (source: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { recordUnmatched, notifyUnmatched } from ${JSON.stringify(moduleFile)}; ${source}`], { stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', (data) => { error += data })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(error)))
  })
  await Promise.all([
    run(`notifyUnmatched(${JSON.stringify(repo)}, 'run', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); return {ok:true,id:'s'} })`),
    run(`recordUnmatched(${JSON.stringify(repo)}, {id:'a'}, ${JSON.stringify(pending)}, '70'); recordUnmatched(${JSON.stringify(repo)}, {id:'b'}, ${JSON.stringify(pending)}, '71')`),
    run(`recordUnmatched(${JSON.stringify(repo)}, {id:'a'}, ${JSON.stringify(pending)}, '72')`),
  ])
  const records = unmatchedRecords(repo)
  assert.ok(records.a['70'].notified)
  assert.ok(records.a['72'])
  assert.ok(records.b['71'])
})

test('기록 실패는 머지 반영 호출을 실패로 바꾸지 않는다', (t) => {
  const repo = fixture(t)
  mkdirSync(join(repo, '.orch'), { recursive: true })
  writeFileSync(join(repo, '.orch/state'), 'not a directory')
  assert.doesNotThrow(() => recordUnmatched(repo, { id: 'a' }, pending, '70'))
})

test('루프 보드 단계는 다음 틱에 주 Run 으로 한 번 보내고 새 상태에서도 다시 보내지 않는다', async (t) => {
  const repo = fixture(t)
  mkdirSync(join(repo, '.omc'), { recursive: true })
  writeFileSync(join(repo, '.omc/board.json'), '{"items":[]}')
  const sync = join(repo, 'sync.ts')
  writeFileSync(sync, "console.log('BOARD-SYNC 0')")
  const log = join(repo, 'sent.jsonl')
  writeNodeBin(repo, 'orca', `const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')
fs.writeSync(1, JSON.stringify({ok:true,result:{id:'message'}}))`)
  const previous = { ORCA: process.env.ORCA, BOARD_SYNC: process.env.BOARD_SYNC }
  process.env.ORCA = join(repo, 'orca')
  process.env.BOARD_SYNC = sync
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  recordUnmatched(repo, { id: 'a' }, pending, '70')
  const context = { repo, primary: 'primary-run', previous: {} } as StepContext
  const state = { prs: { ok: false } } as StepState
  await syncBoard(context, state)
  await syncBoard({ ...context, previous: {} }, state)
  const sent = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(sent.length, 1)
  assert.equal(sent[0][sent[0].indexOf('--to') + 1], 'run:primary-run')
  assert.equal(sent[0][sent[0].indexOf('--body') + 1], 'BOARD-UNMATCHED a PR #70')
  assert.ok(unmatchedRecords(repo).a['70'].notified)
})
