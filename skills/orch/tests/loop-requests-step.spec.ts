// 루프 단계 steps/requests.ts(답 없는 요청 알림, 자동 완료 다시 보내기)를 임시 저장소와 가짜 orca 로 본다. Orca 에는 닿지 않는다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { notifyUnacked } from '../scripts/loop/steps/requests.ts'
import type { StepContext, StepState } from '../scripts/loop/steps/context.ts'

const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
const st = JSON.parse(fs.readFileSync(process.env.FAKE_DIR + '/orca.json', 'utf8'))
const say = (v) => process.stdout.write(JSON.stringify(v) + '\\n')
if (argv[1] === 'run-list') say({ ok: true, result: { runs: st.runs || [] } })
else if (argv[0] === 'terminal' && argv[1] === 'list') say({ ok: true, result: { terminals: st.terminals || [] } })
else if (argv[1] === 'send' && !st.send_fails) { fs.appendFileSync(process.env.FAKE_DIR + '/sends.jsonl', JSON.stringify(argv) + '\\n'); say({ ok: true, result: { message: { id: 'm' } } }) }
else { say({ ok: false, error: { code: 'x', message: 'offline' } }); process.exitCode = 1 }
`

type Json = Record<string, any>
let tmp: string
let repo: string
const saved = { ORCA: process.env.ORCA, FAKE_DIR: process.env.FAKE_DIR, ORCH_DIR: process.env.ORCH_DIR, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES }

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'loop-requests-')))
  repo = join(tmp, 'repo')
  mkdirSync(repo)
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(tmp, 'orca'), FAKE_ORCA, { mode: 0o755 })
  writeFileSync(join(tmp, 'orca.json'), JSON.stringify({ runs: [{ id: 'rA', coordinator_handle: 'tA' }], terminals: [{ handle: 'tA', agentIdentity: 'claude' }] }))
  process.env.ORCA = join(tmp, 'orca')
  process.env.FAKE_DIR = tmp
  process.env.GIT_CEILING_DIRECTORIES = tmp
  delete process.env.ORCH_DIR
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function record(fields: Json): string {
  const file = join(repo, '.orch/state/requests/R1.json')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ id: 'R1', number: 1, repo, title: '정리', body: 'b', state: 'sent', reason: null, from: { repo, run: 'rA', terminal: null },
    to_run: 'rB', updated_at: fields.created_at, ack_notice_at: null, board: { to: 'req-1', from: null }, history: [{ at: fields.created_at, state: 'sent', reason: null, run: 'rA' }], ...fields }))
  return file
}

function sends(): string[][] {
  const file = join(tmp, 'sends.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
}

const ctx = () => ({ repo, requestAckSec: 1800, primary: 'rB', previous: {} }) as unknown as StepContext
const state = {} as StepState

test('받음 답 없이 기한이 지난 요청은 보낸 Run 에 한 번만 알린다', async () => {
  const file = record({ created_at: new Date(Date.now() - 31 * 60_000).toISOString() })
  assert.deepEqual((await notifyUnacked(ctx(), state)).errors, {})
  assert.equal(sends().length, 1)
  const sent = sends()[0]
  assert.equal(sent[sent.indexOf('--to') + 1], 'run:rA')
  assert.match(sent[sent.indexOf('--payload') + 1], /REQUEST-NO-ACK/)
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).ack_notice_at)
  await notifyUnacked(ctx(), state)
  assert.equal(sends().length, 1)
})

test('기한 전이거나 이미 답한 요청은 알리지 않는다', async () => {
  record({ created_at: new Date(Date.now() - 10 * 60_000).toISOString() })
  await notifyUnacked(ctx(), state)
  record({ created_at: new Date(Date.now() - 60 * 60_000).toISOString(), state: 'accepted' })
  await notifyUnacked(ctx(), state)
  assert.equal(sends().length, 0)
})

test('보내지 못하면 표시하지 않아 다음 틱이 다시 보낸다', async () => {
  const file = record({ created_at: new Date(Date.now() - 31 * 60_000).toISOString() })
  writeFileSync(join(tmp, 'orca.json'), JSON.stringify({ runs: [], terminals: [], send_fails: true }))
  await notifyUnacked(ctx(), state)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).ack_notice_at, null)
})

test('마무리가 보내지 못한 자동 완료는 다음 틱에 다시 보낸다', async () => {
  const at = new Date().toISOString()
  const file = record({ created_at: at, state: 'accepted', pending_done: { reason: 'PR #7 마무리 FINISH-DONE', at } })
  await notifyUnacked(ctx(), state)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.state, 'done')
  assert.equal(saved.pending_done, null)
  assert.match(sends()[0][sends()[0].indexOf('--payload') + 1], /REQUEST-DONE/)
})
