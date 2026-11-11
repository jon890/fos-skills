// 보드 창이 사람이 누른 버튼을 기록하는 규칙(core)과 기록·신호 보내기(lib)를 본다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyAdd, applyPress, emptyFile, revertPress } from '../scripts/core/approvals.ts'
import type { AddInput, ApprovalFile } from '../scripts/core/approvals.ts'
import { recordPress } from '../scripts/lib/approvals.ts'
import { fakeBin } from './fixtures/fake-bin.ts'

const T0 = new Date('2026-11-10T03:00:00.000Z')
const base = (over: Partial<AddInput> = {}): AddInput => ({
  id: 'demo', title: '제목', kind: 'post', run: 'R', terminal: 'term_c', preview: { path: '/p.html', sha256: 'x' },
  item: null, step: null, then: '두레이 등록', real: null, command: null, ...over,
})
const press = (version: number, action: 'approve' | 'revise' = 'approve', note: string | null = null) => ({ id: 'demo', version, action, terminal: 'term_c', origin: 'person', nonce: 'n1', note })
function withOpen(): ApprovalFile { return applyAdd(emptyFile(), base(), T0).file }

test('열린 지금 버전에 승인을 누르면 승인 상태와 누름 기록을 쓴다', () => {
  const result = applyPress(withOpen(), press(1), T0)
  assert.ok('entry' in result)
  assert.equal(result.entry.state, 'approved')
  assert.deepEqual(result.entry.press, { action: 'approve', terminal: 'term_c', origin: 'person', at: T0.toISOString(), nonce: 'n1' })
  assert.equal(result.entry.closedAt, T0.toISOString())
  assert.equal(result.entry.note, null)
})

test('고쳐 달라는 글을 trim 해 남기고 공백뿐인 글은 거절한다', () => {
  const done = applyPress(withOpen(), press(1, 'revise', '  제목을 짧게  '), T0)
  assert.ok('entry' in done)
  assert.equal(done.entry.state, 'revise')
  assert.equal(done.entry.note, '제목을 짧게')
  for (const note of ['', '   \n', null]) assert.deepEqual(applyPress(withOpen(), press(1, 'revise', note), T0), { refusal: '고칠 내용이 비었어요' })
})

test('지금 버전이 아닌 누름은 이유를 돌려주고 파일을 바꾸지 않는다(예전 화면의 버튼)', () => {
  const file = applyAdd(withOpen(), base({ title: '바뀐 제목' }), T0).file
  assert.deepEqual(applyPress(file, press(1), T0), { refusal: '내용이 바뀌었어요' })
  assert.deepEqual(applyPress(file, { ...press(2), id: 'none' }, T0), { refusal: '대기가 없어요' })
})

test('이미 눌렸거나 거둔 대기와 직접 실행 대기는 거절한다', () => {
  const approved = applyPress(withOpen(), press(1), T0)
  assert.ok('file' in approved)
  assert.deepEqual(applyPress(approved.file, press(1), T0), { refusal: '다른 창에서 이미 눌렀어요' })
  const cancelled: ApprovalFile = { ...withOpen(), entries: withOpen().entries.map(e => ({ ...e, state: 'cancelled' as const })) }
  assert.deepEqual(applyPress(cancelled, press(1), T0), { refusal: '코디네이터가 거뒀어요' })
  const command = applyAdd(emptyFile(), base({ kind: 'command', preview: null, command: 'echo ok' }), T0).file
  assert.deepEqual(applyPress(command, press(1), T0), { refusal: '직접 실행하는 대기예요' })
})

test('revertPress 는 같은 nonce 일 때만 열림으로 되돌린다', () => {
  const pressed = applyPress(withOpen(), press(1, 'revise', '고쳐'), T0)
  assert.ok('file' in pressed)
  const back = revertPress(pressed.file, 'demo', 1, 'n1')
  assert.ok('file' in back)
  assert.deepEqual({ ...back.file.entries[0] }, { ...withOpen().entries[0] })
  assert.deepEqual(revertPress(pressed.file, 'demo', 1, 'other'), { skipped: true })
  assert.deepEqual(revertPress(pressed.file, 'demo', 2, 'n1'), { skipped: true })
  assert.deepEqual(revertPress(withOpen(), 'demo', 1, 'n1'), { skipped: true })
  const used = { ...pressed.file, entries: pressed.file.entries.map(e => ({ ...e, state: 'used' as const })) }
  assert.deepEqual(revertPress(used, 'demo', 1, 'n1'), { skipped: true })
})

const envelope = (result: unknown) => JSON.stringify({ ok: true, result })
const workers = (handles: string[] = []) => envelope({ workers: handles.map(agentTerminalHandle => ({ agentTerminalHandle, dispatchId: 'd' })), scope: { source: 'all' }, page: {} })
const SENT = envelope({ message: { id: 'msg_abc123' } })

async function withRepo<T>(terminal: string | undefined, rules: ReturnType<typeof rulesFor>, body: (f: { root: string; file: string; calls: () => { argv: string[] }[]; read: () => ApprovalFile }) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'approval-press-'))
  spawnSync('git', ['init', '-q', root])
  const fake = fakeBin(root, 'orca', rules)
  const keep = { ...process.env }
  Object.assign(process.env, { ORCH_DIR: join(root, '.orch'), ORCA: fake.path })
  if (terminal === undefined) delete process.env.ORCA_TERMINAL_HANDLE; else process.env.ORCA_TERMINAL_HANDLE = terminal
  const file = join(root, '.orch/state/approvals.json')
  try {
    const stateDir = join(root, '.orch/state')
    spawnSync('mkdir', ['-p', stateDir])
    writeFileSync(file, JSON.stringify(withOpen()))
    return await body({ root, file, calls: () => fake.calls(), read: () => JSON.parse(readFileSync(file, 'utf8')) as ApprovalFile })
  } finally {
    for (const key of ['ORCH_DIR', 'ORCA', 'ORCA_TERMINAL_HANDLE']) { if (keep[key] === undefined) delete process.env[key]; else process.env[key] = keep[key] }
    rmSync(root, { recursive: true, force: true })
  }
}
function rulesFor(send: { stdout?: string; code?: number; stderr?: string }, handles: string[] = []) {
  return [{ args: ['send'], ...send }, { stdout: workers(handles) }]
}
const sends = (calls: { argv: string[] }[]) => calls.filter(c => c.argv.includes('send'))

test('recordPress: 승인을 기록하고 올린 Run 으로 APPROVED 신호를 보낸다', async () => {
  await withRepo('term_coord', rulesFor({ stdout: SENT }), async f => {
    const out = await recordPress(f.root, { id: 'demo', version: 1, action: 'approve', note: null, origin: 'person' })
    assert.deepEqual(out, { ok: true, messageId: 'msg_abc123' })
    const entry = f.read().entries[0]
    assert.equal(entry.state, 'approved')
    assert.equal(entry.press?.terminal, 'term_coord')
    const [call] = sends(f.calls())
    const arg = (name: string) => call.argv[call.argv.indexOf(name) + 1]
    assert.equal(arg('--to'), 'run:R')
    assert.equal(arg('--type'), 'status')
    assert.equal(arg('--subject'), 'APPROVED demo 1')
    assert.ok(!call.argv.includes('--from'))
    assert.deepEqual(JSON.parse(arg('--payload')), { source: 'board-approval', action: 'approve', id: 'demo', version: 1, nonce: entry.press?.nonce })
  })
})

test('recordPress: 고쳐 달라는 REVISE 제목과 글을 본문으로 보낸다', async () => {
  await withRepo('term_coord', rulesFor({ stdout: SENT }), async f => {
    const out = await recordPress(f.root, { id: 'demo', version: 1, action: 'revise', note: '제목을 짧게', origin: 'person' })
    assert.equal(out.ok, true)
    const [call] = sends(f.calls())
    assert.equal(call.argv[call.argv.indexOf('--subject') + 1], 'REVISE demo 1')
    assert.match(call.argv[call.argv.indexOf('--body') + 1], /제목을 짧게/)
    assert.equal(f.read().entries[0].state, 'revise')
  })
})

test('recordPress: 신호를 보내지 못하면 기록을 열림으로 되돌린다', async () => {
  await withRepo('term_coord', rulesFor({ code: 1, stderr: 'boom' }), async f => {
    const out = await recordPress(f.root, { id: 'demo', version: 1, action: 'approve', note: null, origin: 'person' })
    assert.equal(out.ok, false)
    assert.match(out.ok ? '' : out.reason, /신호를 보내지 못했어요/)
    const entry = f.read().entries[0]
    assert.equal(entry.state, 'open')
    assert.equal(entry.press, null)
  })
})

test('recordPress: worker 터미널은 거절하고 기록도 신호도 없다', async () => {
  await withRepo('term_w', rulesFor({ stdout: SENT }, ['term_w']), async f => {
    const out = await recordPress(f.root, { id: 'demo', version: 1, action: 'approve', note: null, origin: 'person' })
    assert.deepEqual(out, { ok: false, reason: 'worker 터미널에서는 누를 수 없어요' })
    assert.equal(f.read().entries[0].state, 'open')
    assert.equal(sends(f.calls()).length, 0)
  })
})

test('recordPress: worker 목록을 읽지 못하면 거절한다', async () => {
  await withRepo('term_x', [{ code: 1 }], async f => {
    const out = await recordPress(f.root, { id: 'demo', version: 1, action: 'approve', note: null, origin: 'person' })
    assert.deepEqual(out, { ok: false, reason: 'worker 터미널인지 확인하지 못했어요' })
    assert.equal(f.read().entries[0].state, 'open')
  })
})

test('recordPress: 지금 버전이 아니면 신호를 한 번도 보내지 않는다', async () => {
  await withRepo('term_coord', rulesFor({ stdout: SENT }), async f => {
    const out = await recordPress(f.root, { id: 'demo', version: 9, action: 'approve', note: null, origin: 'person' })
    assert.deepEqual(out, { ok: false, reason: '내용이 바뀌었어요' })
    assert.equal(sends(f.calls()).length, 0)
    assert.equal(f.read().entries[0].state, 'open')
  })
})

test('recordPress: Orca 터미널 변수가 없는 창은 판정 없이 누르고 터미널은 null 로 남긴다', async () => {
  await withRepo(undefined, rulesFor({ stdout: SENT }), async f => {
    assert.equal((await recordPress(f.root, { id: 'demo', version: 1, action: 'approve', note: null, origin: 'none' })).ok, true)
    assert.equal(f.read().entries[0].press?.terminal, null)
    assert.equal(f.read().entries[0].press?.origin, 'none')
  })
})
