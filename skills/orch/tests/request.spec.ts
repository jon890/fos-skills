// orch request(request/orch-request.ts)를 임시 저장소 둘, 가짜 orca, 실제 보드 명령으로 본다. Orca 에는 닿지 않는다.
// 가짜 orca 는 FAKE_DIR/orca.json 의 runs(run-list), terminals(terminal list)로 답하고, send 는 sends.jsonl 에 적는다. send_fails 면 send 가 실패한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/request/orch-request.ts', import.meta.url))

const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
const st = JSON.parse(fs.readFileSync(process.env.FAKE_DIR + '/orca.json', 'utf8'))
const say = (v) => process.stdout.write(JSON.stringify(v) + '\\n')
if (argv[1] === 'run-list') say({ ok: true, result: { runs: st.runs || [] } })
else if (argv[0] === 'terminal' && argv[1] === 'list') say({ ok: true, result: { terminals: st.terminals || [] } })
else if (argv[1] === 'send') {
  if (st.send_fails) { say({ ok: false, error: { code: 'runtime_unavailable', message: 'offline' } }); process.exitCode = 1 }
  else {
    fs.appendFileSync(process.env.FAKE_DIR + '/sends.jsonl', JSON.stringify(argv) + '\\n')
    // 메인이 깨어나 곧바로 거절하는 경우를 흉내 낸다. 보낸 쪽이 첫 보드를 쓰는 사이에 답이 들어온다
    if (st.reject_on_request && argv.some((a) => a.startsWith('REQUEST '))) {
      const { spawn } = require('node:child_process')
      spawn(process.execPath, ['--disable-warning=ExperimentalWarning', process.env.REQUEST_SCRIPT, 'reject', '--id', 'R1', '--reason', '이미 하는 일', '--repo', st.reject_on_request], { detached: true, stdio: ['ignore', fs.openSync(process.env.FAKE_DIR + '/reject.out', 'a'), fs.openSync(process.env.FAKE_DIR + '/reject.out', 'a')], env: process.env }).unref()
      // 메인의 답이 보낸 쪽의 첫 보드 쓰기보다 먼저 끝날 만큼 메시지 응답을 늦춘다
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)
    }
    say({ ok: true, result: { message: { id: 'msg_' + Date.now() } } })
  }
} else { say({ ok: false, error: { code: 'unknown', message: argv.join(' ') } }); process.exitCode = 1 }
`

type Json = Record<string, any>
let tmp: string
let sender: string
let receiver: string
let env: NodeJS.ProcessEnv

function git(repo: string): void {
  mkdirSync(repo, { recursive: true })
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env }).status, 0)
  mkdirSync(join(repo, '.omc'), { recursive: true })
  writeFileSync(join(repo, '.omc/board.json'), JSON.stringify({ items: [] }))
}

function register(repo: string, run: string): void {
  const file = join(repo, '.orch/state/loop-runs', `${run}.json`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ run, specs_dir: null, registered_at: new Date().toISOString(), coordinator_terminal: null }))
}

function orca(state: Json): void {
  writeFileSync(join(tmp, 'orca.json'), JSON.stringify(state))
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-request-')))
  writeFileSync(join(tmp, 'orca'), FAKE_ORCA, { mode: 0o755 })
  env = { ...process.env, REQUEST_SCRIPT: SCRIPT, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, ORCA: join(tmp, 'orca'), FAKE_DIR: tmp, GIT_CEILING_DIRECTORIES: tmp }
  for (const key of ['ORCH_DIR', 'NODE_OPTIONS', 'ORCH_OUTPUT', 'BOARD_BIN', 'ORCA_TERMINAL_HANDLE']) delete env[key]
  sender = join(tmp, 'sender')
  receiver = join(tmp, 'receiver')
  git(sender)
  git(receiver)
  register(receiver, 'rB')
  // rA 는 보낸 저장소의 코디네이터, rB 는 받는 저장소의 메인이다
  orca({ runs: [{ id: 'rA', coordinator_handle: 'tA' }, { id: 'rB', coordinator_handle: 'tB' }], terminals: [{ handle: 'tA', agentIdentity: 'claude', connected: true }, { handle: 'tB', agentIdentity: 'claude', connected: true }] })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function request(args: string[]): { code: number; lines: string[]; stderr: string } {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env, encoding: 'utf8' })
  return { code: done.status ?? -1, lines: done.stdout.split('\n').filter(Boolean), stderr: done.stderr }
}

function sends(): string[][] {
  const file = join(tmp, 'sends.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
}

function board(repo: string): Json[] {
  return JSON.parse(readFileSync(join(repo, '.omc/board.json'), 'utf8')).items as Json[]
}

function record(repo: string, id: string): Json {
  return JSON.parse(readFileSync(join(repo, '.orch/state/requests', `${id}.json`), 'utf8'))
}

const send = (extra: string[] = []) => request(['send', '--to', receiver, '--title', '로그인 고침', '--body', '로그인 오류를 고쳐 달라', '--repo', sender, '--run', 'rA', ...extra])

test('다른 저장소의 메인에게 요청 번호를 붙여 보내고 양쪽 보드에 항목을 만든다', () => {
  const r = send()
  assert.equal(r.code, 0, r.lines.join('\n') + r.stderr)
  assert.deepEqual(r.lines, [`REQUEST-SENT R1 repo=${receiver} main=rB`])
  const saved = record(receiver, 'R1')
  assert.equal(saved.state, 'sent')
  assert.deepEqual(saved.from, { repo: sender, run: 'rA', terminal: null })
  const sent = sends()
  assert.equal(sent.length, 1)
  assert.equal(sent[0][sent[0].indexOf('--to') + 1], 'run:rB')
  assert.match(sent[0][sent[0].indexOf('--body') + 1], /로그인 오류를 고쳐 달라/)
  assert.match(JSON.parse(sent[0][sent[0].indexOf('--payload') + 1]).source, /^orch-request$/)
  const mine = board(receiver)
  assert.deepEqual(mine.map((item) => [item.id, item.status]), [['req-1', 'wait']])
  assert.match(String(mine[0].title), /^요청 R1: 로그인 고침 \(sender\)$/)
  assert.ok(mine[0].stages, JSON.stringify(mine[0]))
  const theirs = board(sender)
  assert.deepEqual(theirs.map((item) => [item.id, item.status]), [['req-receiver-1', 'wait']])
  // 번호는 받는 저장소마다 이어진다
  assert.deepEqual(send().lines, [`REQUEST-SENT R2 repo=${receiver} main=rB`])
})

test('메인이 곧바로 거절해도 보낸 쪽의 첫 보드 쓰기가 그 답을 덮지 않는다', async () => {
  orca({ runs: [{ id: 'rA', coordinator_handle: 'tA' }, { id: 'rB', coordinator_handle: 'tB' }], terminals: [{ handle: 'tA', agentIdentity: 'claude' }, { handle: 'tB', agentIdentity: 'claude' }], reject_on_request: receiver })
  const r = send()
  assert.equal(r.code, 0, r.lines.join('\n') + r.stderr)
  const deadline = Date.now() + 30_000
  // 거절은 기록을 쓴 뒤 보드를 고친다. 양쪽 보드가 바뀔 때까지 기다린다
  while ((board(sender)[0]?.status !== 'done' || board(receiver)[0]?.status !== 'done') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(record(receiver, 'R1').state, 'rejected')
  for (const repo of [receiver, sender]) {
    const item = board(repo)[0]
    assert.equal(item.status, 'done', JSON.stringify(item))
    assert.ok(item.details.some((d: unknown) => /요청 거절: 이미 하는 일/.test(typeof d === 'string' ? d : (d as Json).text)), JSON.stringify(item))
  }
})

test('같은 저장소 안의 요청은 보드 항목 하나만 만든다', () => {
  register(sender, 'rS')
  orca({ runs: [{ id: 'rA', coordinator_handle: 'tA' }, { id: 'rS', coordinator_handle: 'tS' }], terminals: [{ handle: 'tA', agentIdentity: 'claude' }, { handle: 'tS', agentIdentity: 'codex' }] })
  const r = request(['send', '--to', sender, '--title', '정리', '--body', '본문', '--repo', sender, '--run', 'rA'])
  assert.equal(r.code, 0, r.lines.join('\n') + r.stderr)
  assert.deepEqual(board(sender).map((item) => item.id), ['req-1'])
  assert.equal(record(sender, 'R1').board.from, null)
})

test('메인이 없는 저장소에는 보내지 않고 직접 띄우라고 알린다', () => {
  orca({ runs: [{ id: 'rB', coordinator_handle: 'tB' }], terminals: [{ handle: 'tB', connected: true }] })
  const r = send()
  assert.equal(r.code, 3)
  assert.equal(r.lines[0], `REQUEST-NO-MAIN ${receiver}`)
  assert.match(r.lines[1], /worker launch --repo/)
  assert.equal(sends().length, 0)
  assert.equal(existsSync(join(receiver, '.orch/state/requests/R1.json')), false)
})

test('메인을 판정하지 못하면 보내지 않는다', () => {
  writeFileSync(join(tmp, 'orca.json'), '{"runs": 3}')
  const r = send()
  assert.equal(r.code, 1)
  assert.match(r.lines[0], /^REQUEST-MAIN-UNKNOWN /)
})

test('보내기가 실패하면 기록을 지우고 번호는 다시 쓰지 않는다', () => {
  orca({ runs: [{ id: 'rB', coordinator_handle: 'tB' }], terminals: [{ handle: 'tB', agentIdentity: 'claude' }], send_fails: true })
  const r = send()
  assert.equal(r.code, 1)
  assert.match(r.lines[0], /^REQUEST-SEND-FAIL R1 /)
  assert.equal(existsSync(join(receiver, '.orch/state/requests/R1.json')), false)
  assert.deepEqual(board(receiver), [])
  orca({ runs: [{ id: 'rB', coordinator_handle: 'tB' }], terminals: [{ handle: 'tB', agentIdentity: 'claude' }] })
  assert.deepEqual(send().lines, [`REQUEST-SENT R2 repo=${receiver} main=rB`])
})

test('받은 메인은 받음, 보류, 완료를 보내고 보낸 쪽 보드가 따라 바뀐다', () => {
  send()
  const accepted = request(['accept', '--id', 'R1', '--repo', receiver, '--run', 'rB'])
  assert.deepEqual(accepted.lines, ['REQUEST-ACCEPTED R1 to=rA'])
  assert.equal(record(receiver, 'R1').state, 'accepted')
  assert.equal(sends().at(-1)![sends().at(-1)!.indexOf('--to') + 1], 'run:rA')
  assert.ok(board(sender)[0].details.some((d: unknown) => /요청 받음/.test(typeof d === 'string' ? d : (d as Json).text)), JSON.stringify(board(sender)[0]))
  assert.equal(request(['hold', '--id', 'R1', '--repo', receiver]).code, 2)
  assert.deepEqual(request(['hold', '--id', 'R1', '--reason', '다른 일 먼저', '--repo', receiver]).lines, ['REQUEST-HELD R1 to=rA'])
  assert.deepEqual(request(['done', '--id', 'r1', '--repo', receiver]).lines, ['REQUEST-DONE R1 to=rA'])
  assert.equal(board(sender)[0].status, 'done')
  assert.equal(board(receiver)[0].status, 'done')
  assert.deepEqual(request(['fail', '--id', 'R1', '--reason', 'x', '--repo', receiver]).lines, ['REQUEST-CLOSED R1 done'])
})

test('받은 뒤에는 거절할 수 없고 없는 번호는 알린다', () => {
  send()
  request(['accept', '--id', 'R1', '--repo', receiver])
  const r = request(['reject', '--id', 'R1', '--reason', '안 함', '--repo', receiver])
  assert.equal(r.code, 3)
  assert.deepEqual(r.lines, ['REQUEST-REFUSED R1 accepted reject'])
  assert.equal(request(['accept', '--id', 'R9', '--repo', receiver]).lines[0], `REQUEST-UNKNOWN R9 ${receiver}`)
})

test('보낸 Run 이 끝났으면 답은 보낸 저장소의 지금 메인에게 간다', () => {
  send()
  register(sender, 'rA2')
  orca({ runs: [{ id: 'rA', coordinator_handle: 'tA' }, { id: 'rA2', coordinator_handle: 'tA2' }, { id: 'rB', coordinator_handle: 'tB' }],
    terminals: [{ handle: 'tA', connected: true }, { handle: 'tA2', agentIdentity: 'claude' }, { handle: 'tB', agentIdentity: 'claude' }] })
  assert.deepEqual(request(['reject', '--id', 'R1', '--reason', '이미 하는 일', '--repo', receiver]).lines, ['REQUEST-REJECTED R1 to=rA2'])
})

test('보내기가 실패한 답은 기록과 보드를 바꾸지 않는다', () => {
  send()
  orca({ runs: [{ id: 'rA', coordinator_handle: 'tA' }], terminals: [{ handle: 'tA', agentIdentity: 'claude' }], send_fails: true })
  const r = request(['accept', '--id', 'R1', '--repo', receiver])
  assert.equal(r.code, 1)
  assert.match(r.lines[0], /^REQUEST-SEND-FAIL R1 /)
  assert.equal(record(receiver, 'R1').state, 'sent')
})

test('list 는 번호 순으로 내고 --open 은 끝난 요청을 뺀다', () => {
  send()
  send()
  request(['reject', '--id', 'R2', '--reason', '중복', '--repo', receiver])
  assert.deepEqual(request(['list', '--repo', receiver]).lines, ['REQUEST R1 sent from=sender 로그인 고침', 'REQUEST R2 rejected from=sender 로그인 고침'])
  assert.deepEqual(request(['list', '--open', '--repo', receiver]).lines, ['REQUEST R1 sent from=sender 로그인 고침'])
})

test('보낸 Run 없이 보내면 사용법 오류다', () => {
  assert.equal(request(['send', '--to', receiver, '--title', 't', '--body', 'b', '--repo', sender]).code, 2)
})
