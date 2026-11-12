// lib/questions.ts 의 미답변 판정과 poll 기록을 가짜 orca 로 본다. Orca 에는 닿지 않는다.
// 가짜 orca 는 ORCA 환경 변수로 넣는다. lib/orca.ts 는 ORCA_CLI_COMMAND 를 읽지 않는다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ageSeconds, dismissQuestion, poll, readDismissed, REPLY_LIMIT, snapshot, unanswered } from '../scripts/lib/questions.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/wait/watch-questions.ts', import.meta.url))

// state.json 을 읽어 답한다. raw 가 있으면 그것을 그대로 내고 rc 로 끝난다.
// check --all 은 부를 때마다 checkSeq 의 다음 값(ok 나 fail)을 따른다. 다 쓰면 마지막 값을 되풀이한다.
// 받은 인자는 calls.jsonl 에 한 줄씩 적는다. 확장자 없는 실행 파일이라 타입 문법을 쓰지 않는다.
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const dir = process.env.FAKE_DIR
const argv = process.argv.slice(2)
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify(argv) + '\\n')
const st = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8'))
const reply = (result) => process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n')
if (st.raw !== undefined) {
  process.stdout.write(st.raw)
  process.exit(st.rc || 0)
}
const sub = argv[1]
if (sub === 'run-current') reply({ run: st.current ? { id: st.current } : null })
else if (sub === 'check' && argv.includes('--all')) {
  const counter = dir + '/all-count'
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0
  fs.writeFileSync(counter, String(n + 1))
  const seq = st.checkSeq || ['ok']
  if (seq[Math.min(n, seq.length - 1)] === 'fail') {
    process.stderr.write('offline\\n')
    process.exit(1)
  }
  reply(st.all === undefined ? { messages: [] } : st.all)
} else if (sub === 'check') reply(st.peek === undefined ? { messages: [] } : st.peek)
else if (sub === 'task-list') reply({ tasks: st.tasks || [] })
else if (sub === 'inbox') reply({ messages: (st.inbox || {})[argv[argv.indexOf('--terminal') + 1]] || [] })
`

type Json = Record<string, unknown>

let binDir: string
let tmp: string
let env: NodeJS.ProcessEnv
const savedOrca = process.env.ORCA
const savedFakeDir = process.env.FAKE_DIR

before(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'questions-bin-')))
  writeFileSync(join(binDir, 'orca'), FAKE_ORCA)
  chmodSync(join(binDir, 'orca'), 0o755)
})
after(() => {
  rmSync(binDir, { recursive: true, force: true })
  if (savedOrca === undefined) delete process.env.ORCA
  else process.env.ORCA = savedOrca
  if (savedFakeDir === undefined) delete process.env.FAKE_DIR
  else process.env.FAKE_DIR = savedFakeDir
})

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'questions-')))
  env = {
    ...process.env,
    // 가짜 orca 의 #! 줄과 이벤트 핸들러가 이 테스트의 node 를 쓰게 한다
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ORCA: join(binDir, 'orca'),
    FAKE_DIR: tmp,
    // 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다
    GIT_CEILING_DIRECTORIES: dirname(tmp),
  }
  delete env.ORCH_DIR
  delete env.ORCA_CLI_COMMAND
  // lib 를 이 프로세스에서 부르는 테스트도 같은 가짜를 쓴다
  process.env.ORCA = env.ORCA
  process.env.FAKE_DIR = tmp
  // 닫은 질문 기록을 이 머신의 폴더에서 읽지 않는다
  env.ORCH_MACHINE_DIR = join(tmp, 'machine')
  process.env.ORCH_MACHINE_DIR = env.ORCH_MACHINE_DIR
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function fake(state: Json): void {
  writeFileSync(join(tmp, 'state.json'), JSON.stringify(state))
}

// orchestration 과 --json 을 뺀 인자
function calls(): string[][] {
  const log = join(tmp, 'calls.jsonl')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line)
    .map((line) => JSON.parse(line) as string[])
    // orchestration 명령은 모두 --full 로 부른다(lib/orca.ts 의 withFull). 비교에서는 --json 과 --full 을 뺀다
    .map((argv) => {
      assert.ok(argv.includes('--full'), argv.join(' '))
      return argv.slice(1).filter((a) => a !== '--json' && a !== '--full')
    })
}

function message(id = 'q', kind = 'question', extra: Json = {}): Json {
  return {
    id,
    type: kind,
    run_id: 'r',
    to_handle: 'run:r',
    from_handle: 'dispatch:d',
    thread_id: id,
    body: '두 줄\n질문',
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  }
}

function answer(thread = 'q', extra: Json = {}): Json {
  return message('answer', 'status', { from_handle: 'run:r', to_handle: 'dispatch:d', thread_id: thread, ...extra })
}

test('끝난 dispatch 의 질문은 발신 터미널과 dispatch 메일함을 읽지 않는다', () => {
  const statuses = ['completed', 'failed', 'cancelled', 'canceled', 'abandoned']
  const questions = statuses.map((status) => message(status, 'question', { dispatch_id: status, from_handle: `term_${status}` }))
  const live = message('live', 'question', { dispatch_id: 'live', from_handle: 'term_live' })
  fake({ all: { messages: [...questions, live] } })
  const got = snapshot('r', { rows: { ok: true, rows: statuses.map((status) => ({ dispatchId: status, dispatchStatus: status })) } })
  assert.deepEqual(got.pending, [live])
  assert.deepEqual(calls().filter((args) => args[0] === 'inbox').map((args) => args[args.indexOf('--terminal') + 1]), ['term_live', 'dispatch:live'])
})

test('관측 뒤 재조회한 failed dispatch·completed Task·닫힌 질문은 조회하지 않는다', () => {
  // 2026-11-12 재조회에서 읽은 상태만 보존한다. 식별자는 바꿨고, 반복 알림 당시 상태를 재현한 것은 아니다.
  const qs = ['a', 'b'].map(id => message(`observed-${id}`, 'escalation', { dispatch_id: id, task_id: `task-${id}`, from_handle: `term_${id}` }))
  const rows = ['a', 'b'].map(id => ({ dispatchId: id, taskId: `task-${id}`, dispatchStatus: 'failed', workerState: 'abandoned', terminalState: 'retained', resource: { ownershipState: 'owned', releaseState: 'not_requested' } }))
  fake({ all: { messages: qs }, tasks: ['a', 'b'].map(id => ({ id: `task-${id}`, status: 'completed' })) })
  for (const q of qs) dismissQuestion(String(q.id), 'dispatch_inactive')
  assert.deepEqual(snapshot('r', { rows: { ok: true, rows } }).pending, [])
  assert.ok(!calls().some(args => args[0] === 'inbox' || args[0] === 'task-list'))
})

test('해제된 dispatch 와 끝난 Task 는 답변 메일함을 읽기 전에 뺀다', () => {
  const cases = [
    { dispatchStatus: 'released' },
    { dispatchStatus: 'dispatch_inactive' },
    { resource: { ownershipState: 'released' } },
    { resource: { releaseState: 'released' } },
    { terminalState: 'released' },
  ]
  for (const extra of cases) {
    fake({ all: { messages: [message()] } })
    assert.deepEqual(snapshot('r', { rows: { ok: true, rows: [{ dispatchId: 'd', dispatchStatus: 'running', ...extra }] } }).pending, [])
  }
  for (const status of ['completed', 'failed', 'cancelled', 'canceled']) {
    fake({ all: { messages: [message('q', 'escalation', { task_id: 't' })] }, tasks: [{ id: 't', status }] })
    assert.deepEqual(snapshot('r', { rows: { ok: true, rows: [{ dispatchId: 'd', dispatchStatus: 'running' }] } }).pending, [])
  }
  assert.equal(calls().filter((args) => args[0] === 'inbox').length, 0)
})

test('Task 조회가 실패하거나 형식이 바뀌면 질문이 끝났다고 추측하지 않는다', () => {
  fake({ all: { messages: [message('q', 'question', { task_id: 't' })] }, tasks: 'invalid' })
  assert.throws(() => snapshot('r'), /Task 종료 상태를 읽지 못했다/)
})

test('열린 Task 와 상태를 모르는 dispatch 의 질문은 남긴다', () => {
  const q = message('q', 'question', { task_id: 't' })
  for (const tasks of [[], [{ id: 't', status: 'running' }], [{ id: 'other', status: 'completed' }]]) {
    fake({ all: { messages: [q] }, tasks })
    assert.deepEqual(snapshot('r', { rows: { ok: false, error: 'offline' } }).pending, [q])
  }
})

test('worker_done 이 오면 아직 running 인 행의 질문도 조회하지 않고 다른 Run 의 보고는 무시한다', () => {
  const question = message('q', 'question', { dispatch_id: 'd', from_handle: 'term_d' })
  fake({ all: { messages: [question] } })
  const rows = { ok: true as const, rows: [{ dispatchId: 'd', dispatchStatus: 'running' }] }
  const done = message('done', 'worker_done', { dispatch_id: 'd' })
  assert.deepEqual(snapshot('r', { rows, done: [done] }).pending, [])
  assert.equal(calls().filter((args) => args[0] === 'inbox').length, 0)
  assert.deepEqual(snapshot('r', { rows, done: [{ ...done, run_id: 'another' }] }).pending, [question])
})

describe('unanswered', () => {
  test('최신 질문의 답은 같은 dispatch 의 앞선 질문도 풀고 그 뒤의 새 질문은 남긴다', () => {
    const q1 = message('q1', 'question', { created_at: '2026-01-01T01:00:00Z', payload: { dispatchId: 'd' } })
    const q2 = message('q2', 'question', { created_at: '2026-01-01T02:00:00Z', payload: JSON.stringify({ dispatchId: 'd' }) })
    const q3 = message('q3', 'question', { created_at: '2026-01-01T03:00:00Z' })
    const other = message('other', 'question', { from_handle: 'dispatch:another' })
    assert.deepEqual(unanswered([q2, q1, answer('q2'), other], 'r'), [other])
    assert.deepEqual(unanswered([q2, q1, answer('q2'), q3], 'r'), [q3])
  })

  test('ack 은 질문을 풀지 않고 코디네이터의 답은 푼다', () => {
    const q = message('q', 'question', { read: 1 })
    const follow = { ...q, id: 'follow', type: 'status', thread_id: 'q' }
    const other = { ...q, id: 'other', run_id: 'other', to_handle: 'run:other' }
    assert.deepEqual(unanswered([q, follow, other], 'r'), [q])
    const reply = { ...follow, id: 'answer', from_handle: 'run:r', to_handle: 'dispatch:d' }
    assert.deepEqual(unanswered([q, reply], 'r'), [])
    const e = message('e', 'escalation')
    assert.deepEqual(unanswered([e, reply], 'r'), [e])
    assert.deepEqual(unanswered([e, { ...reply, thread_id: 'e' }], 'r'), [])
  })

  test('--from 없이 코디네이터 터미널이 보낸 답도 worker 쪽으로 갔으면 답이다', () => {
    const q = message('q', 'escalation', { from_handle: 'term_w' })
    const reply = message('answer', 'status', { from_handle: 'term_coord', to_handle: 'dispatch:d', thread_id: 'q' })
    assert.deepEqual(unanswered([q, reply], 'r'), [])
    assert.deepEqual(unanswered([q, { ...reply, to_handle: 'run:r' }], 'r'), [q])
  })
})

describe('snapshot', () => {
  test('Run 을 모르면 run-current 를 읽고, 읽기 전용 조회만 부른다', () => {
    const q = message('q', 'question', { read: 1 })
    fake({ current: 'r', all: { messages: [q] }, peek: { messages: [q] } })
    assert.deepEqual(snapshot(), { run: 'r', pending: [q] })
    assert.deepEqual(calls(), [
      ['run-current'],
      ['check', '--run', 'r', '--all', '--types', 'question,escalation'],
      ['check', '--run', 'r', '--peek', '--types', 'question,escalation'],
      ['inbox', '--terminal', 'dispatch:d', '--limit', String(REPLY_LIMIT)],
    ])
  })

  test('닫은 질문(send-to-worker 가 답할 수 없다고 적은 것)은 미답변에서 뺀다', () => {
    const old = message('q_old', 'question', { from_handle: 'dispatch:closed' })
    const open = message('q_open')
    fake({ all: { messages: [old, open] }, peek: { messages: [] } })
    dismissQuestion('q_old', 'dispatch_inactive')
    assert.deepEqual(snapshot('r').pending.map((m) => m.id), ['q_open'])
    assert.deepEqual(readDismissed(), { q_old: 'dispatch_inactive' })
    assert.ok(!calls().some((args) => args.includes('dispatch:closed')))
  })

  test('턴만 끝낸 멈춤 보고는 질문이 아니고, 오류로 멈춘 보고는 질문으로 남는다', () => {
    const quiet = message('msg_stop_a', 'escalation', { subject: 'Worker stopped without reporting', payload: JSON.stringify({ dispatchId: 'd', stopReason: 'finished' }) })
    const errored = message('msg_stop_b', 'escalation', { subject: 'Worker stopped on an error without reporting', payload: JSON.stringify({ dispatchId: 'd', stopReason: 'errored' }) })
    fake({ all: { messages: [quiet, errored] }, peek: { messages: [] } })
    assert.deepEqual(snapshot('r').pending.map((m) => m.id), ['msg_stop_b'])
  })

  test('질문 기록이 목록이 아니면 빈 성공이 아니라 오류다', () => {
    for (const all of [{}, { messages: null }, { messages: [null] }]) {
      fake({ all })
      assert.throws(() => snapshot('r'), /질문 기록을 읽지 못했다/, JSON.stringify(all))
    }
  })

  test('답과 짝지은 질문은 빠지고 읽지 않은 옛 질문은 남는다. 답은 보낸 쪽마다 한 번 읽는다', () => {
    const q = message('q', 'question', { read: 1 })
    const old = message('old')
    fake({ all: { messages: [q] }, peek: { messages: [old] }, inbox: { 'dispatch:d': [answer()] } })
    assert.deepEqual(snapshot('r'), { run: 'r', pending: [old] })
    assert.equal(calls().length, 3)
  })

  test('답 기록이 한도에 닿으면 모든 질문이 답을 받았을 때만 성공이다', () => {
    const unrelated = { ...message(), id: 'follow', type: 'status' }
    const rows = Array.from({ length: REPLY_LIMIT }, () => unrelated)
    fake({ all: { messages: [message()] }, inbox: { 'dispatch:d': rows } })
    assert.throws(() => snapshot('r'), /답변 기록 한도/)
    fake({ all: { messages: [message()] }, inbox: { 'dispatch:d': [{ ...unrelated, id: 'answer', from_handle: 'run:r', to_handle: 'dispatch:d' }, ...rows.slice(1)] } })
    assert.deepEqual(snapshot('r'), { run: 'r', pending: [] })
  })

  test('터미널에서 보낸 질문은 그 dispatch 의 inbox 에서도 답을 찾는다', () => {
    const q = message('q', 'escalation', { from_handle: 'term_w', payload: JSON.stringify({ dispatchId: 'd' }) })
    const reply = answer('q', { from_handle: 'term_coord' })
    fake({ all: { messages: [q] }, inbox: { 'dispatch:d': [reply] } })
    assert.deepEqual(snapshot('r').pending, [])
    assert.deepEqual(calls().filter((c) => c[0] === 'inbox').map((c) => c[2]), ['term_w', 'dispatch:d'])
  })

  test('전역 inbox 는 부르지 않는다', () => {
    fake({ all: { messages: [message()] }, inbox: { 'dispatch:d': [answer()] } })
    assert.deepEqual(snapshot('r').pending, [])
    const inbox = calls().filter((c) => c[0] === 'inbox')
    assert.ok(inbox.length > 0 && inbox.every((c) => c.includes('--terminal')), JSON.stringify(inbox))
  })

  test('orca 오류와 객체가 아닌 응답은 오류다', () => {
    for (const [raw, rc] of [['[]', 0], ['{"ok":false,"error":"offline"}', 0], ['{"result":null}', 0], ['', 1]] as const) {
      fake({ raw, rc })
      assert.throws(() => snapshot('r'), Error, raw)
    }
  })
})

describe('ageSeconds', () => {
  test('만들어진 뒤 지난 초. 시각을 읽지 못하면 0', () => {
    const start = Date.UTC(2026, 0, 1) / 1000
    assert.equal(ageSeconds(message(), start + 600), 600)
    assert.equal(ageSeconds(message('q', 'question', { created_at: 'bad' }), start), 0)
  })
})

type Result = { code: number | null; stdout: string; stderr: string }

function seenFile(): string {
  return join(tmp, '.orch/state/questions-seen.json')
}

function lines(text: string, prefix: string): string[] {
  return text.split('\n').filter((line) => line.startsWith(prefix))
}

describe('poll 기록과 재알림', () => {
  test('재알림은 알린 뒤 --remind-after 초가 되는 때부터다', () => {
    // 옛 명령의 테스트와 같은 시각이다. 1000 에 알리고 600 초 뒤인 1600 에 다시 알린다. 1599 는 조용하다
    fake({ all: { messages: [message()] } })
    const state = seenFile()
    assert.deepEqual(poll('r', state, 1000, 600, tmp).notices.map((n) => n.line), ['QUESTION q question from=dispatch:d: 두 줄 질문'])
    assert.deepEqual(poll('r', state, 1599, 600, tmp).notices, [])
    const reminded = poll('r', state, 1600, 600, tmp).notices
    assert.deepEqual(reminded.map((n) => [n.line, n.reminder]), [['REMINDER q question from=dispatch:d: 두 줄 질문', true]])
    // 파일은 옛 명령의 json.dumps 꼴이다
    assert.equal(readFileSync(state, 'utf8'), '{"r": {"q": 1600}}\n')
  })

  test('깨진 알림 기록과 조회 실패는 기록을 덮지 않고 오류를 낸다', () => {
    fake({ all: { messages: [message()] } })
    mkdirSync(dirname(seenFile()), { recursive: true })
    const raw='{"r":{"q":"1000"}}'
    writeFileSync(seenFile(),raw)
    assert.throws(() => poll('r',seenFile(),1600,600,tmp), /알림 기록 형식/)
    assert.equal(readFileSync(seenFile(),'utf8'),raw)
    writeFileSync(seenFile(),'{"r":{"q":1000}}')
    fake({checkSeq:['fail']})
    assert.throws(() => poll('r',seenFile(),1600,600,tmp), /offline/)
    assert.equal(readFileSync(seenFile(),'utf8'),'{"r":{"q":1000}}')
  })
})

test('끝난 dispatch 는 같은 Task 의 다른 dispatch PR 로 질문을 닫고, 살아 있으면 닫지 않는다', async () => {
  const { closedReason } = await import('../scripts/lib/questions.ts')
  const head = 'a'.repeat(40)
  const q = message('q', 'question', { task_id: 'task', dispatch_id: 'old' })
  const report = message('ready', 'status', { task_id: 'task', dispatch_id: 'new', subject: `준비됨 #123, head ${head}` })
  for (const state of ['MERGED', 'CLOSED', 'OPEN']) {
    const readPr = (() => ({ ok: true, data: { state, headRefOid: head } })) as typeof import('../scripts/lib/gh.ts').ghJson
    const lookup = { rows: { ok: true as const, rows: [{ dispatchId: 'old', dispatchStatus: 'abandoned' }] }, reports: [report], readPr }
    assert.equal(closedReason(q, 'r', tmp, lookup) !== null, state !== 'OPEN')
    assert.equal(closedReason(q, 'r', tmp, { ...lookup, reports: [{ ...report, task_id: 'another' }] }), null)
    assert.equal(closedReason(q, 'r', tmp, { ...lookup, rows: { ok: true, rows: [{ dispatchId: 'old', dispatchStatus: 'running' }] } }), null)
    const wrongHead = (() => ({ ok: true, data: { state, headRefOid: 'b'.repeat(40) } })) as typeof import('../scripts/lib/gh.ts').ghJson
    assert.equal(closedReason(q, 'r', tmp, { ...lookup, readPr: wrongHead }), null)
  }
})

test('다른 Task 가 같은 워크트리 브랜치의 PR 을 끝냈으면 질문을 닫는다', async () => {
  const { closedReason } = await import('../scripts/lib/questions.ts')
  const q = message('q', 'question', { task_id: 'old-task', dispatch_id: 'old' })
  for (const state of ['MERGED', 'CLOSED', 'OPEN']) {
    const calls: string[][] = []
    const readPr = ((args: string[]) => {
      calls.push(args)
      return { ok: true, data: [{ number: 456, state, headRefName: 'retry-feature' }] }
    }) as typeof import('../scripts/lib/gh.ts').ghJson
    const lookup = {
      rows: { ok: true as const, rows: [{ dispatchId: 'old', dispatchStatus: 'abandoned', resource: { worktreeId: 'repo::/work/retry-feature' } }] },
      reports: [{ type: 'status', task_id: 'new-task', dispatch_id: 'new', subject: `준비됨 #456, head ${'a'.repeat(40)}` }],
      branches: new Map([['retry-feature', '/work/retry-feature']]), readPr,
    }
    assert.equal(closedReason(q, 'r', tmp, lookup) !== null, state !== 'OPEN')
    assert.ok(calls[0].includes('retry-feature'))
    assert.equal(closedReason(q, 'r', tmp, { ...lookup, branches: new Map([['other', '/work/other']]) }), null)
    assert.equal(closedReason(q, 'r', tmp, { ...lookup, readPr: (() => ({ ok: false, error: 'offline' })) as typeof readPr }), null)
  }
})

test('워크트리가 지워져도 띄우기 기록의 브랜치로 PR 종료를 확인한다', async () => {
  const { closedReason } = await import('../scripts/lib/questions.ts')
  const worktree = join(tmp, 'removed-worktree')
  const dir = join(tmp, '.orch/state/launched-workers')
  mkdirSync(dir, { recursive: true })
  const launch = { dispatch: 'old', worktree, branch: 'retry-feature', terminal: null, run: 'r' }
  writeFileSync(join(dir, 'old.json'), JSON.stringify(launch))
  const q = message('q', 'question', { task_id: 'old-task', dispatch_id: 'old' })
  for (const state of ['MERGED', 'CLOSED', 'OPEN']) {
    const readPr = (() => ({ ok: true, data: [{ number: 456, state, headRefName: 'retry-feature' }] })) as typeof import('../scripts/lib/gh.ts').ghJson
    const lookup = { rows: { ok: true as const, rows: [{ dispatchId: 'old', dispatchStatus: 'abandoned', resource: { worktreeId: `repo::${worktree}` } }] }, reports: [], branches: new Map<string, string>(), readPr }
    assert.equal(closedReason(q, 'r', tmp, lookup) !== null, state !== 'OPEN')
  }
})

test('브랜치 없는 옛 띄우기 기록은 끝난 dispatch 의 같은 경로가 없을 때만 질문을 닫는다', async () => {
  const { closedReason } = await import('../scripts/lib/questions.ts')
  const worktree = join(tmp, 'removed-worktree')
  const launch = { dispatch: 'old', worktree, terminal: null, run: 'r' }
  const q = message('q', 'question', { dispatch_id: 'old' })
  const lookup = { rows: { ok: true as const, rows: [{ dispatchId: 'old', dispatchStatus: 'abandoned', resource: { worktreeId: `repo::${worktree}` } }] }, reports: [], branches: new Map<string, string>(), launches: new Map([['old', launch]]) }
  assert.match(closedReason(q, 'r', tmp, lookup) ?? '', /recorded worktree removed/u)
  mkdirSync(worktree)
  assert.equal(closedReason(q, 'r', tmp, lookup), null)
  assert.equal(closedReason(q, 'r', tmp, { ...lookup, launches: new Map([['old', { ...launch, worktree: join(tmp, 'other') }]]) }), null)
  assert.equal(closedReason(q, 'r', tmp, { ...lookup, launches: new Map([['old', null]]) }), null)
})

test('종료 근거는 질문별로 보존하고 Run 을 구분한다', async () => {
  const { shareClosedQuestion, sharedClosedReason } = await import('../scripts/lib/questions.ts')
  const previous = process.env.ORCH_MACHINE_DIR
  process.env.ORCH_MACHINE_DIR = join(tmp, 'machine')
  try {
    shareClosedQuestion('r1', 'q1', 'PR merged')
    shareClosedQuestion('r2', 'q2', 'worktree removed')
    assert.equal(sharedClosedReason('r1', 'q1'), 'PR merged')
    assert.equal(sharedClosedReason('r2', 'q2'), 'worktree removed')
    assert.equal(sharedClosedReason('r2', 'q1'), null)
  } finally {
    if (previous === undefined) delete process.env.ORCH_MACHINE_DIR
    else process.env.ORCH_MACHINE_DIR = previous
  }
})

test('오랫동안 조회하지 않은 종료 근거만 정리하고 계속 관측한 질문은 보존한다', async () => {
  const { shareClosedQuestion, sharedClosedReason, pruneSharedClosed } = await import('../scripts/lib/questions.ts')
  const previous = process.env.ORCH_MACHINE_DIR
  process.env.ORCH_MACHINE_DIR = join(tmp, 'machine')
  try {
    shareClosedQuestion('r', 'old', 'merged')
    shareClosedQuestion('r', 'observed', 'merged')
    const directory = join(tmp, 'machine', 'questions-closed')
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    for (const name of readdirSync(directory)) utimesSync(join(directory, name), old, old)
    assert.equal(sharedClosedReason('r', 'observed', true), 'merged')
    shareClosedQuestion('r', 'new', 'merged')
    pruneSharedClosed()
    assert.equal(sharedClosedReason('r', 'old'), null)
    assert.equal(sharedClosedReason('r', 'observed'), 'merged')
    assert.equal(sharedClosedReason('r', 'new'), 'merged')
  } finally {
    if (previous === undefined) delete process.env.ORCH_MACHINE_DIR
    else process.env.ORCH_MACHINE_DIR = previous
  }
})
