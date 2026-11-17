import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { orca, orcaJson } from '../scripts/lib/orca.ts'
import { fakeBin } from './fixtures/fake-bin.ts'

let dir: string
let saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = { ...process.env }
  dir = mkdtempSync(join(tmpdir(), 'terminal-handle-'))
  process.env.ORCA_TERMINAL_HANDLE = 'old'
  process.env.ORCA_PANE_KEY = 'tab:leaf'
})
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(dir, { recursive: true, force: true })
})
const row = (handle: string, tabId = 'tab', leafId = 'leaf') => ({ handle, tabId, leafId, worktreePath: dir, connected: true })
function setup(rows: unknown[], truncated = false) {
  const fake = fakeBin(dir, 'orca', [
    { args: ['terminal', 'list'], stdout: JSON.stringify({ ok: true, result: { terminals: rows, truncated } }) },
    { args: ['orchestration', 'run-current'], stdout: JSON.stringify({ ok: true, result: { run: { id: 'wrong-run' } } }) },
    { args: ['orchestration', 'send'], code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'consumer_fenced', message: 'bound to Run other' } }) },
  ])
  process.env.ORCA = fake.path
  return fake
}
test('실제 pane 과 다른 핸들이면 Run 을 읽기 전에 멈추고 맞는 핸들을 안내한다', () => {
  const fake = setup([row('old', 'other'), row('correct')])
  const got = orcaJson(['orchestration', 'run-current'])
  assert.equal(got.ok, false)
  if (!got.ok) assert.match(got.error, /TERMINAL-HANDLE-MISMATCH.*correct.*export ORCA_TERMINAL_HANDLE=correct/)
  assert.deepEqual(fake.calls().map(c => c.argv.slice(0, 2)), [['terminal', 'list']])
  assert.equal(process.env.ORCA_TERMINAL_HANDLE, 'old')
})
test('같은 pane 이면 다른 폴더 대상 호출도 원래 Run 을 읽는다', () => {
  setup([row('old')])
  assert.deepEqual(orcaJson(['orchestration', 'run-current'], { cwd: dir }), { ok: true, data: { run: { id: 'wrong-run' } } })
})
test('거절된 쓰기는 재시도하지 않고 실제 창의 핸들만 안내한다', () => {
  const fake = setup([row('correct')])
  const done = orca(['orchestration', 'send'])
  assert.equal(done.code, 1)
  assert.match(done.stderr, /TERMINAL-HANDLE-MISMATCH/)
  assert.equal(fake.calls().filter(c => c.argv[1] === 'send').length, 1)
})
test('pane 근거가 없으면 후보라고 알리고 현재 창이라고 단정하지 않는다', () => {
  delete process.env.ORCA_PANE_KEY
  setup([row('candidate'), row('other')])
  const done = orca(['orchestration', 'send'], { cwd: dir })
  assert.match(done.stderr, /TERMINAL-HANDLE-CHECK.*후보: candidate, other/)
  assert.doesNotMatch(done.stderr, /TERMINAL-HANDLE-MISMATCH/)
})
test('목록이 잘리거나 pane 이 여러 개면 Run 연결을 추측해 바꾸지 않는다', () => {
  setup([row('correct')], true)
  assert.equal(orcaJson(['orchestration', 'run-current']).ok, true)
})

test('현재 창 핸들이 맞으면 consumer_fenced 를 창 불일치로 바꾸지 않는다', () => {
  setup([row('old')])
  const done = orca(['orchestration', 'send'])
  assert.match(done.stdout, /consumer_fenced/)
  assert.equal(done.stderr, '')
})
test('동일 pane 후보가 여러 개면 어느 핸들도 확정하지 않는다', () => {
  setup([row('a'), row('b')])
  assert.equal(orcaJson(['orchestration', 'run-current']).ok, true)
})

test('성공한 응답 본문의 consumer_fenced 낱말은 오류로 다루지 않는다', () => {
  const fake = fakeBin(dir, 'orca', [{ args: ['orchestration', 'send'], stdout: JSON.stringify({ ok: true, result: { body: 'consumer_fenced 설명' } }) }])
  process.env.ORCA = fake.path
  assert.deepEqual(orcaJson(['orchestration', 'send']), { ok: true, data: { body: 'consumer_fenced 설명' } })
  assert.equal(fake.calls().length, 1)
})
test('종료 코드가 0 이어도 실패 봉투의 안내를 JSON 호출자에게 돌려준다', () => {
  const fake = fakeBin(dir, 'orca', [
    { args: ['orchestration', 'send'], stdout: JSON.stringify({ ok: false, error: { code: 'consumer_fenced' } }) },
    { args: ['terminal', 'list'], stdout: JSON.stringify({ ok: true, result: { terminals: [row('correct')] } }) },
  ])
  process.env.ORCA = fake.path
  const got = orcaJson(['orchestration', 'send'])
  assert.equal(got.ok, false)
  if (!got.ok) assert.match(got.error, /TERMINAL-HANDLE-MISMATCH/)
  assert.equal(fake.calls().filter(c => c.argv[1] === 'send').length, 1)
})
