// 사건 대기(lib/wait-events.ts). 보드 파일과 보드 도구는 실제로 쓰고, 사건 명령은 가짜 스크립트, 알림은 함수로 받는다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { checkWaitEvents } from '../scripts/lib/wait-events.ts'
import { waitEventOf } from '../scripts/core/step-ready.ts'
import { waitEventLimitMs, waitEventsOf } from '../scripts/core/wait-events.ts'

type Json = Record<string, any>
const LINE = '2. [wait: 사건 dev-eval] 평가 끝'

function setup(t: TestContext) {
  const root = tempDir('wait-events-', t)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, '.orch/state'), { recursive: true })
  spawnSync('git', ['init', '-q', repo])
  const board = join(repo, 'board.json')
  const saved = { ...process.env }
  Object.assign(process.env, { ORCH_DIR: join(repo, '.orch'), ORCH_MACHINE_DIR: join(root, 'machine'), BOARD_BIN: '' })
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved) })
  const configure = (events: Json) => writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ finish: { board }, board: { wait_events: events } }))
  const put = (items: Json[]) => writeFileSync(board, JSON.stringify({ items }))
  const item = (extra: Json = {}, text = LINE) => ({ id: 'a', status: 'wait', details: [{ text: '1. 앞', done: true }, { text, done: false }], ...extra })
  const rows = () => JSON.parse(readFileSync(board, 'utf8')).items
  const sent: string[] = []
  const logs: string[] = []
  const check = (deadline: number | null = null, now?: () => number) => checkWaitEvents(repo, {
    deadline, now, log: (line) => logs.push(line), notify: (kind, text) => { sent.push(`${kind} ${text}`) },
  })
  // 부를 때마다 카운터 파일에 한 줄을 더하고 code 로 끝나는 가짜 사건 명령
  const counter = join(root, 'calls')
  const command = (code: number | string) => `echo x >> ${counter}; ${typeof code === 'number' ? `exit ${code}` : code}`
  const calls = () => { try { return readFileSync(counter, 'utf8').trim().split('\n').length } catch { return 0 } }
  configure({ 'dev-eval': { command: command(1), timeout_sec: 5 } })
  put([item()])
  return { root, repo, board, configure, put, item, rows, sent, logs, check, command, calls }
}

test('waitEventOf 는 이름 규칙에 맞는 사건 조건만 읽는다', () => {
  assert.equal(waitEventOf('사건 dev-eval'), 'dev-eval')
  assert.equal(waitEventOf('사건 a'), 'a')
  assert.equal(waitEventOf(`사건 ${'a'.repeat(32)}`), 'a'.repeat(32))
  for (const bad of [null, '2026-11-27 10:00', '사건', '사건 ', '사건 Dev', '사건 -x', `사건 ${'a'.repeat(33)}`, '사건 a b', '사건  a']) assert.equal(waitEventOf(bad), null, String(bad))
})

test('설정 검사: 이름, 명령, 시간 상한, 모르는 키', () => {
  assert.deepEqual(waitEventsOf({}), {})
  assert.deepEqual(waitEventsOf({ board: { wait_events: { 'dev-eval': { command: 'true' } } } }), { 'dev-eval': { command: 'true', timeoutSec: 60 } })
  assert.deepEqual(waitEventsOf({ board: { wait_events: { x: { command: 'true', timeout_sec: 600 } } } }).x.timeoutSec, 600)
  for (const bad of [[], 'x', { Bad: { command: 'true' } }, { x: { command: '' } }, { x: { command: 'true', timeout_sec: 0 } },
    { x: { command: 'true', timeout_sec: 601 } }, { x: { command: 'true', timeout_sec: 1.5 } }, { x: { command: 'true', extra: 1 } }, { x: 'true' }]) {
    assert.throws(() => waitEventsOf({ board: { wait_events: bad } }), /board\.wait_events/, JSON.stringify(bad))
  }
})

test('남은 시간: 마감이 없으면 timeout_sec, 모자라면 null, 아니면 30초를 남긴다', () => {
  assert.equal(waitEventLimitMs(60, null, 0), 60_000)
  assert.equal(waitEventLimitMs(60, 39_999, 0), null)
  assert.equal(waitEventLimitMs(60, 50_000, 0), 20_000)
  assert.equal(waitEventLimitMs(5, 600_000, 0), 5_000)
})

test('0 이면 그 줄만 끝내고 알림 하나, 상태는 그대로다', async (t) => {
  const c = setup(t)
  c.configure({ 'dev-eval': { command: c.command(0) } })
  const result = await c.check()
  assert.deepEqual(result, { done: ['a 2 dev-eval'], failed: [] })
  assert.deepEqual(c.sent, ['WAIT-EVENT a 2 dev-eval'])
  const [row] = c.rows()
  assert.equal(row.status, 'wait')
  assert.equal(row.details[1].done, true)
  await c.check()
  assert.equal(c.sent.length, 1)
  assert.equal(c.calls(), 1)
})

test('1 이면 그대로고 알림이 없다', async (t) => {
  const c = setup(t)
  await c.check(); await c.check()
  assert.deepEqual(c.sent, [])
  assert.equal(c.rows()[0].details[1].done, false)
  assert.equal(c.calls(), 2)
})

test('같은 이름의 줄이 여럿이면 명령은 한 번 돈다', async (t) => {
  const c = setup(t)
  c.configure({ 'dev-eval': { command: c.command(0) } })
  c.put([c.item(), c.item({ id: 'b' })])
  await c.check()
  assert.equal(c.calls(), 1)
  assert.deepEqual(c.sent.sort(), ['WAIT-EVENT a 2 dev-eval', 'WAIT-EVENT b 2 dev-eval'])
})

test('명령 없음, 다른 코드, 시간 초과, 출력 초과는 한 번만 알리고 종류가 바뀌면 다시 알린다', { timeout: 60_000 }, async (t) => {
  const c = setup(t)
  process.env.ORCH_KILL_GRACE_SEC = '1'
  c.configure({})
  await c.check(); await c.check()
  assert.equal(c.sent.length, 1)
  assert.match(c.sent[0], /^WAIT-EVENT-ERROR a 2 dev-eval: 설정 board\.wait_events 에 이 이름이 없다$/)
  c.configure({ 'dev-eval': { command: c.command('echo boom >&2; exit 3') } })
  await c.check(); await c.check()
  assert.equal(c.sent.length, 2)
  assert.match(c.sent[1], /: 종료 코드 3: boom$/)
  c.configure({ 'dev-eval': { command: c.command('sleep 30'), timeout_sec: 1 } })
  await c.check(); await c.check()
  assert.equal(c.sent.length, 3)
  assert.match(c.sent[2], /1초 안에 끝나지 않아 끊었다/)
  c.configure({ 'dev-eval': { command: c.command(`head -c 2000000 /dev/zero`) } })
  await c.check(); await c.check()
  assert.equal(c.sent.length, 4)
  assert.match(c.sent[3], /출력이 한도/)
  assert.equal(c.rows()[0].details[1].done, false)
  // 「아직」 이 나오면 기록을 지운다. 같은 실패가 다시 나면 다시 알린다
  c.configure({ 'dev-eval': { command: c.command(1) } })
  await c.check()
  c.configure({})
  await c.check()
  assert.equal(c.sent.length, 5)
})

test('줄 글이 바뀌면 같은 실패도 다시 알린다', async (t) => {
  const c = setup(t)
  c.configure({})
  await c.check()
  c.put([c.item({}, '2. [wait: 사건 dev-eval] 평가 다시')])
  await c.check()
  assert.equal(c.sent.length, 2)
})

test('다른 저장소가 띄운 항목의 줄은 돌리지 않고 이 저장소가 띄운 항목은 돌린다', async (t) => {
  const c = setup(t)
  c.put([c.item({ workers: [{ role: 'impl', worktree: 'w', dispatch: 'other', status: 'working' }] })])
  writeFileSync(join(c.repo, '.orch/state/launch-history.jsonl'), JSON.stringify({ dispatch: 'mine', at: '2026-11-27T00:00:00Z', worktree: 'm' }) + '\n')
  await c.check()
  assert.equal(c.calls(), 0)
  assert.deepEqual(c.sent, [])
  c.put([c.item({ workers: [{ role: 'impl', worktree: 'm', dispatch: 'mine', status: 'working' }] })])
  await c.check()
  assert.equal(c.calls(), 1)
})

test('보드가 저장소 밖이고 띄운 저장소도 없으면 확인할 저장소 없음으로 한 번 알린다', async (t) => {
  const c = setup(t)
  const outside = join(c.root, 'home-board', 'board.json')
  mkdirSync(join(c.root, 'home-board'))
  writeFileSync(outside, JSON.stringify({ items: [c.item()] }))
  writeFileSync(join(c.repo, '.orch/config.json'), JSON.stringify({ finish: { board: outside }, board: { wait_events: { 'dev-eval': { command: c.command(0) } } } }))
  process.env.GIT_CEILING_DIRECTORIES = c.root
  await c.check(); await c.check()
  assert.equal(c.calls(), 0)
  assert.equal(c.sent.length, 1)
  assert.match(c.sent[0], /^WAIT-EVENT-ERROR a 2 dev-eval: 확인할 저장소가 없다/)
})

test('남은 시간이 모자라면 돌리지 않고 알리지 않는다', async (t) => {
  const c = setup(t)
  c.configure({ 'dev-eval': { command: c.command(0) } })
  await c.check(1_000_000 + 39_000, () => 1_000_000)
  assert.equal(c.calls(), 0)
  assert.deepEqual(c.sent, [])
  assert.match(c.logs.join('\n'), /WAIT-EVENT-SKIP dev-eval/)
})

test('시각 대기와 글 조건, 끝난 항목은 건드리지 않는다', async (t) => {
  const c = setup(t)
  c.put([c.item({}, '2. [wait: 2099-01-01 00:00] 시각'), c.item({ id: 'b' }, '2. [wait: 사람이 확인] 글'), c.item({ id: 'c', status: 'done' })])
  await c.check()
  assert.equal(c.calls(), 0)
  assert.deepEqual(c.sent, [])
})

test('줄을 끝낸 뒤 알림이 실패하면 다시 보내지 않고 failed 로 돌려준다', async (t) => {
  const c = setup(t)
  c.configure({ 'dev-eval': { command: c.command(0) } })
  const result = await checkWaitEvents(c.repo, { deadline: null, log: () => {}, notify: () => { throw new Error('offline') } })
  assert.equal(result.done.length, 1)
  assert.match(result.failed[0], /WAIT-EVENT a 2 dev-eval 알림을 보내지 못했다: offline/)
  assert.equal(c.rows()[0].details[1].done, true)
})
