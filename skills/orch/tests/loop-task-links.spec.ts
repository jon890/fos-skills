import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fillTaskUrls } from '../scripts/lib/task-links.ts'
import { run, scriptCommand } from '../scripts/lib/proc.ts'
import { BOARD_BIN } from '../scripts/lib/board.ts'
let repo: string, file: string, logs: string[], clock: number
const saved = { ...process.env }
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'task-links-')); file = join(repo, 'board.json'); logs = []; clock = Date.parse('2026-11-13T00:00:00Z')
  process.env.ORCH_DIR = join(repo, '.orch'); process.env.GIT_CEILING_DIRECTORIES = repo
  mkdirSync(join(repo, '.orch')); config({ adapter: 'url-template', url: 'https://x/{number}' })
  put([{ id: 'a', status: 'doing', 'task-ref': 'P/1', details: ['1. PR'] }])
})
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); rmSync(repo, { recursive: true, force: true }) })
function config(task?: unknown) { writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ finish: { board: file }, ...(task === undefined ? {} : { board: { task } }) })) }
function put(items: unknown[]) { writeFileSync(file, JSON.stringify({ items })) }
const rows = () => JSON.parse(readFileSync(file, 'utf8')).items
const record = () => JSON.parse(readFileSync(join(repo, '.orch/state/task-links.json'), 'utf8'))
const options = () => ({ log: (line: string) => logs.push(line), now: () => clock })
function set(args: string[]) { const result = run(scriptCommand(BOARD_BIN, ['set', 'a', '--file', file, ...args])); assert.equal(result.code, 0, result.stderr) }
test('번호만 있는 열린 항목만 채우고 설정이 없으면 조회하지 않는다', async () => {
  put([...rows(), { id: 'done', status: 'done', 'task-ref': 'P/2' }, { id: 'url', status: 'wait', 'task-ref': 'P/3', task: 'https://old' }])
  assert.deepEqual(await fillTaskUrls(repo, options()), { filled: ['a'], failed: [] })
  assert.equal(rows()[0].task, 'https://x/P/1'); assert.equal(rows()[1].task, undefined); assert.equal(rows()[2].task, 'https://old'); assert.deepEqual(logs, ['TASK-LINK a P/1'])
  config(); set(['--task', '']); let calls = 0
  await fillTaskUrls(repo, { ...options(), resolve: async () => { calls++; return 'https://x' } }); assert.equal(calls, 0); assert.equal(rows()[0].task, undefined)
})
test('실패 간격과 첫 로그는 파일로 이어지고 번호 변경은 새 실패다', async () => {
  let calls = 0
  const fail = async () => { calls++; throw new Error('offline\nnext') }
  await fillTaskUrls(repo, { ...options(), resolve: fail }); assert.equal(calls, 1); assert.deepEqual(logs, ['TASK-LINK-FAIL a P/1 offline next'])
  clock += 29 * 60000; await fillTaskUrls(repo, { ...options(), resolve: fail }); assert.equal(calls, 1)
  clock += 2 * 60000; await fillTaskUrls(repo, { ...options(), resolve: fail }); assert.equal(calls, 2); assert.equal(logs.length, 1)
  set(['--task-ref', 'P/2']); await fillTaskUrls(repo, { ...options(), resolve: fail }); assert.equal(logs.length, 2)
  clock += 31 * 60000; await fillTaskUrls(repo, options()); assert.deepEqual(record().items, {})
})
test('사람이 넣은 주소와 끝난 항목은 실패 기록을 지운다', async () => {
  await fillTaskUrls(repo, { ...options(), resolve: async () => { throw Error('offline') } })
  set(['--task', 'https://manual']); await fillTaskUrls(repo, options()); assert.deepEqual(record().items, {})
  assert.equal(rows()[0].task, 'https://manual')
})
test('주소를 만드는 사이 번호가 바뀌거나 항목이 없어져도 실패를 남기지 않는다', async () => {
  await fillTaskUrls(repo, { ...options(), resolve: async () => { set(['--task-ref', 'Z/9']); return 'https://old' } })
  assert.equal(rows()[0].task, undefined); assert.deepEqual(logs, [])
  await fillTaskUrls(repo, { ...options(), resolve: async () => { put([]); return 'https://old' } }); assert.deepEqual(logs, [])
})
test('시간 예산을 넘기면 다음 항목은 조회하지 않는다', async () => {
  put(['a', 'b', 'c'].map(id => ({ id, status: 'wait', 'task-ref': id })))
  let calls = 0
  await fillTaskUrls(repo, { ...options(), budgetMs: 100, resolve: async () => { calls++; clock += 101; return 'https://x/1' } })
  assert.equal(calls, 1); assert.equal(rows()[1].task, undefined)
})
test('설정 오류는 같은 이유를 한 번만 남기고 복구하면 지운다', async () => {
  config({ adapter: 'unknown' })
  await fillTaskUrls(repo, options()); await fillTaskUrls(repo, options()); assert.equal(logs.length, 1); assert.match(logs[0], /^TASK-LINK-CONFIG /)
  config({ adapter: 'url-template', url: 'https://x/{number}' }); await fillTaskUrls(repo, options()); assert.equal(record().config, undefined)
})
