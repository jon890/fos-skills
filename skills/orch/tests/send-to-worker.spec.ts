// send-to-worker.ts 를 가짜 orca, 가짜 nudge-worker, 가짜 launch-worker 로 본다. Orca 에는 닿지 않는다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { unanswered } from '../scripts/lib/questions.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/worker/send-to-worker.ts', import.meta.url))
// 다시 띄우라는 안내 줄이 가리키는 명령. 실행 규칙의 꼴이다
const LAUNCH_HINT = `node --disable-warning=ExperimentalWarning ${fileURLToPath(new URL('../scripts/worker/launch-worker.ts', import.meta.url))}`

// 상태 파일로 움직이는 가짜 orca. 받은 인자를 한 줄씩 기록한다. 확장자가 없어 타입 문법 없이 쓴다.
// macOS 에서 파이프로 가는 process.stdout 쓰기는 비동기라 process.exit 가 출력을 자를 수 있어 writeSync 로 쓴다.
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2).filter((a) => a !== '--json' && a !== '--full')
fs.appendFileSync(process.env.FAKE_LOG, 'orca ' + args.join(' ') + '\\n')
// --full 없이 부른 orchestration 명령은 따로 적는다. Orca 1.4.246 의 줄인 보기는 판정에 쓰는 키를 뺀다
if (args[0] === 'orchestration' && !process.argv.includes('--full')) fs.appendFileSync(process.env.FAKE_LOG + '.concise', args.join(' ') + '\\n')
function print(text, code) {
  fs.writeSync(1, text + '\\n')
  process.exit(code)
}
function out(result, code = 0) {
  fs.writeFileSync(file, JSON.stringify(state))
  print(JSON.stringify({ ok: code === 0, result }), code)
}
function opt(name) {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : null
}
const is = (a, b) => args[0] === a && args[1] === b
if (state.fail) print('boom', 1)
if (is('terminal', 'list')) out({ terminals: state.terminals || [] })
if (is('terminal', 'read')) out({ terminal: { tail: state.screen || [] } })
if (is('terminal', 'close')) out({}, state.close_fails ? 1 : 0)
if (is('orchestration', 'worker-show')) {
  const d = state.dispatches[opt('--dispatch')]
  if (!d) out({}, 1)
  out({ dispatch: d.dispatch, worker: d.worker || {}, resource: d.resource || {}, terminalResource: d.terminalResource || {} })
}
if (is('orchestration', 'inbox')) out({ messages: state.inbox || [] })
if (is('orchestration', 'check')) out({ messages: args.includes('--types') ? state.questions || state.inbox || [] : state.inbox || [] })
if (is('orchestration', 'reply')) {
  if (state.no_pane || (state.no_pane_scoped && (args.includes('--run') || args.includes('--from')))) {
    print(JSON.stringify({ ok: false, error: { code: 'stable_pane_required', message: 'The coordinator terminal has no stable pane identity' } }), 1)
  }
  if ((state.inactive || []).includes(opt('--id'))) {
    print(JSON.stringify({ ok: false, error: { code: 'dispatch_inactive', message: 'Dispatch ctx_1 is completed; its worker will never read that mailbox.' } }), 1)
  }
  if ((state.answered || []).includes(opt('--id'))) {
    print(JSON.stringify({ ok: false, error: { message: 'Question ' + opt('--id') + ' already has a different answer' } }), 1)
  }
  if (state.fenced && args.includes('--from')) {
    print(JSON.stringify({ ok: false, error: { code: 'consumer_fenced', message: 'run consumer is fenced to another terminal' } }), 1)
  }
  out({ message: { id: 'msg_new' } })
}
if (is('orchestration', 'send')) {
  if (state.send_rejected && (opt('--body') || '').startsWith('지시서 ')) print(JSON.stringify({ ok: false, error: { code: 'dispatch_inactive', message: 'remote finished worker refuses follow-up' } }), 1)
  if (state.send_ambiguous) print('connection lost', 1)
  if (state.fenced && args.includes('--from')) {
    print(JSON.stringify({ ok: false, error: { code: 'consumer_fenced', message: 'run consumer is fenced to another terminal' } }), 1)
  }
  out(state.receipt || { message: { id: 'msg_sent' } })
}
if (is('orchestration', 'worker-list')) {
  if (state.worker_pages && state.worker_pages.length) out(state.worker_pages.shift())
  out({ workers: state.workers || [] })
}
process.exit(3)
`

// 받은 인자를 FAKE_LOG 에 「이름 인자...」 로 적고 FAKE_OUT 을 낸 뒤 FAKE_EXIT 로 끝나는 가짜 명령
function recorder(name: string): string {
  return `echo "${name} $*" >> "$FAKE_LOG"\necho "\${FAKE_OUT:-ok}"\nexit "\${FAKE_EXIT:-0}"\n`
}

// launch-worker 가 --terminal 로 이어 쓸 때만 agent_unconfigured(3)로 끝나게 한다
const LAUNCH_UNCONFIGURED = 'echo "launch $*" >> "$FAKE_LOG"\ncase " $* " in *" --terminal "*) exit 3 ;; esac\n'

let binDir: string
let tmp: string
let stateFile: string
let log: string
let launch: string
let env: NodeJS.ProcessEnv

before(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'send-to-worker-bin-')))
  writeFileSync(join(binDir, 'orca'), FAKE_ORCA)
  chmodSync(join(binDir, 'orca'), 0o755)
})
after(() => rmSync(binDir, { recursive: true, force: true }))

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'send-to-worker-')))
  stateFile = join(tmp, 'state.json')
  log = join(tmp, 'log.txt')
  launch = join(tmp, 'launch.sh')
  writeFileSync(join(tmp, 'nudge.sh'), recorder('nudge'))
  writeFileSync(launch, recorder('launch'))
  env = {
    ...process.env,
    // 가짜 orca 의 #! 줄이 이 테스트의 node 를 쓰게 한다
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ORCA: join(binDir, 'orca'),
    FAKE_STATE: stateFile,
    FAKE_LOG: log,
    ORCH_DIR: join(tmp, 'orch'),
    NUDGE_WORKER: join(tmp, 'nudge.sh'),
    LAUNCH_WORKER: launch,
    // 닫은 질문 기록(lib/questions.ts)을 이 머신의 폴더에 쓰지 않게 한다
    ORCH_MACHINE_DIR: join(tmp, 'machine'),
  }
  writeFileSync(join(tmp, 'next.md'), '# 후속 작업\n브랜치: `feat/next`\n허락: 로컬 검증을 허락했다.\nworker 선택: `codex` `gpt-6.1-sol` effort `medium`. 행: impl-explore. 비교: claude. 이유: 구현.\n')
  delete env.FAKE_OUT
  delete env.FAKE_EXIT
})
afterEach(() => {
  // 모든 테스트에서 orchestration 명령은 --full 로 불려야 한다(lib/orca.ts 의 withFull)
  const concise = `${log}.concise`
  const leaked = existsSync(concise) ? readFileSync(concise, 'utf8') : ''
  rmSync(tmp, { recursive: true, force: true })
  assert.equal(leaked, '', '--full 없이 부른 orchestration 명령')
})

type Json = Record<string, any>

function state(values: Json): void {
  // 기존 복구 사례는 send 가 거절된 서버를 나타낸다. 후속 일 사례는 receipt 를 명시한다.
  writeFileSync(stateFile, JSON.stringify({ send_rejected: !!values.dispatches?.ctx_1 && !['pending', 'dispatched', 'running'].includes(values.dispatches.ctx_1.dispatch.status) && !values.receipt, ...values }))
}

function readState(): Json {
  return JSON.parse(readFileSync(stateFile, 'utf8')) as Json
}

function logText(): string {
  return existsSync(log) ? readFileSync(log, 'utf8') : ''
}

function lines(prefix: string): string[] {
  return logText()
    .split('\n')
    .filter((line) => line.startsWith(prefix))
}

function worker(status: string): Json {
  return { ctx_1: { dispatch: { id: 'ctx_1', status, runId: 'run_x' }, worker: { agentTerminalHandle: 'term_w', worktreeId: 'repo::/w/feat' } } }
}

function message(id: string, sender: string, type = 'status', sequence = 1): Json {
  return { id, from_handle: sender, type, sequence, payload: null }
}

type Result = { code: number | null; stdout: string; stderr: string }

function send(...args: string[]): Result {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--dispatch', 'ctx_1', ...args], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function both(r: Result): string {
  return r.stdout + r.stderr
}

describe('살아 있는 dispatch', () => {
  test('본문과 --spec 을 함께 주면 본문만 보내고 무시한 옵션을 알린다', () => {
    state({ dispatches: worker('dispatched') })
    const r = send('--body', '답', '--spec', join(tmp, '없는-지시서.md'), '--no-reply')
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /note: 살아 있는 dispatch 에는 본문만 보낸다.*--spec.*무시했다/)
    assert.match(lines('orca orchestration send')[0], /--body 답/)
    assert.deepEqual(lines('launch'), [])
  })
  test('status 에 밀린 질문은 Run 질문 조회로 찾고 전역 inbox 는 읽지 않는다', () => {
    state({ dispatches: worker('dispatched'), inbox: [message('status', 'term_w', 'status', 20)],
      questions: [{ ...message('q', 'term_w', 'question', 2), payload: { dispatchId: 'ctx_1' } }] })
    const r = send('--body', '답')
    assert.equal(r.code, 0, both(r))
    assert.match(lines('orca orchestration reply')[0], /--id q /)
    assert.ok(lines('orca orchestration inbox').every((line) => line.includes('--terminal')), logText())
  })

  test('최신 질문에 답했으면 앞선 재전송 질문에 다시 답하지 않는다', () => {
    const old = message('old', 'term_w', 'question', 2)
    const latest = message('latest', 'term_w', 'question', 4)
    const answer = { ...message('answer', 'run:run_x', 'status', 5), thread_id: 'latest' }
    state({ dispatches: worker('dispatched'), inbox: [old, latest, answer, message('progress', 'term_w', 'status', 10)] })
    const r = send('--body', '계속 진행')
    assert.equal(r.code, 0, both(r))
    assert.match(lines('orca orchestration reply')[0], /--id progress /)
  })

  test('질문 뒤에 status 가 와도 최신 미답변 질문에 답한다', () => {
    state({ dispatches: worker('dispatched'), inbox: [
      message('old', 'term_w', 'question', 2),
      message('latest', 'term_w', 'question', 4),
      message('progress', 'term_w', 'status', 10),
    ] })
    const r = send('--body', '권장안으로 한다')
    assert.equal(r.code, 0, both(r))
    assert.match(lines('orca orchestration reply')[0], /--id latest /)
    assert.match(r.stdout, /replied: latest/)
  })

  test('--no-reply 는 열린 질문이 있어도 새 메시지로 보내고 질문을 건드리지 않는다', () => {
    state({ dispatches: worker('dispatched'), inbox: [message('q', 'term_w', 'question', 3)] })
    const r = send('--body', '별도 진행 지시', '--no-reply')
    assert.equal(r.code, 0, both(r))
    assert.equal(lines('orca orchestration reply').length, 0)
    assert.equal(lines('orca orchestration send').length, 1)
  })

  test('--no-reply 와 --reply-to 를 함께 주면 보내기 전에 멈춘다', () => {
    const r = send('--body', 'x', '--no-reply', '--reply-to', 'q')
    assert.equal(r.code, 2, both(r))
    assert.equal(logText(), '')
  })

  test('구조화 worker 는 답만 달고 nudge-worker 를 부르지 않는다', () => {
    const dispatches = worker('dispatched')
    dispatches.ctx_1.worker = { agentTerminalHandle: 'structworker_1', worktreeId: 'repo::/w/feat', startOptions: { mode: { mode: 'structured' } } }
    state({ dispatches, inbox: [message('m_q', 'dispatch:ctx_1', 'question', 5)] })
    const r = send('--body', '그렇게 한다')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration reply'), ['orca orchestration reply --id m_q --body 그렇게 한다 --run run_x --from run:run_x'])
    assert.match(r.stdout, /^delivered: Orca 가 msg_new 로 깨운다/m)
    assert.deepEqual(lines('nudge'), [])
  })

  test('handle 이 structworker_ 면 실행 방식이 없어도 구조화 worker 로 본다', () => {
    const dispatches = worker('dispatched')
    dispatches.ctx_1.worker = { agentTerminalHandle: 'structworker_2', worktreeId: 'repo::/w/feat' }
    state({ dispatches, inbox: [] })
    const r = send('--body', '이어 간다', '--no-reply')
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /^delivered: /m)
    assert.deepEqual(lines('nudge'), [])
  })

  test('그 worker 의 마지막 메시지에 reply 하고 깨운다', () => {
    const inbox = [
      message('m_hb', 'term_w', 'heartbeat', 9),
      message('m_q', 'dispatch:ctx_1', 'question', 5),
      message('m_st', 'term_w', 'status', 3),
      message('m_other', 'term_x', 'status', 8),
      message('m_coord', 'run:run_x', 'status', 7),
    ]
    state({ dispatches: worker('dispatched'), inbox })
    const r = send('--body', '그렇게 한다')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration reply'), ['orca orchestration reply --id m_q --body 그렇게 한다 --run run_x --from run:run_x'])
    assert.deepEqual(lines('nudge'), [])
  })

  test('이미 답한 question 으로 거부되면 다음 후보에 답한다', () => {
    const inbox = [message('m_q', 'dispatch:ctx_1', 'question', 5), message('m_st', 'term_w', 'status', 3)]
    state({ dispatches: worker('dispatched'), inbox, answered: ['m_q'] })
    const r = send('--body', 'x')
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /skipped: m_q/)
    assert.deepEqual(
      lines('orca orchestration reply').map((line) => line.split(' ').slice(3, 5).join(' ')),
      ['--id m_q', '--id m_st'],
    )
    assert.deepEqual(lines('nudge'), [])
  })

  test('이미 답한 question 은 닫은 질문으로 적어 루프가 다시 알리지 않게 한다', () => {
    const inbox = [message('m_q', 'dispatch:ctx_1', 'question', 5), message('m_st', 'term_w', 'status', 3)]
    state({ dispatches: worker('dispatched'), inbox, answered: ['m_q'] })
    const r = send('--body', 'x')
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /^closed: m_q 는 answer_conflict 로 답할 수 없어 닫은 질문으로 적었다/m)
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'machine', 'questions-dismissed.json'), 'utf8')), { m_q: 'answer_conflict' })
  })

  test('답이 보이는 question 은 시도하지 않는다', () => {
    const answer = { ...message('m_ans', 'run:run_x', 'status', 6), thread_id: 'm_q' }
    const question = { ...message('m_q', 'dispatch:ctx_1', 'question', 5), thread_id: 'm_q' }
    state({ dispatches: worker('dispatched'), inbox: [question, answer, message('m_st', 'term_w', 'status', 3)] })
    const r = send('--body', 'x')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration reply'), ['orca orchestration reply --id m_st --body x --run run_x --from run:run_x'])
  })

  test('두 번째 후보도 거부되면 더 reply 하지 않고 새 메시지로 보내 깨운다', () => {
    const inbox = [message('m_a', 'term_w', 'question', 5), message('m_b', 'term_w', 'question', 4), message('m_c', 'term_w', 'question', 3)]
    state({ dispatches: worker('dispatched'), inbox, answered: ['m_a', 'm_b'] })
    const r = send('--body', '후속 지시\n둘째 줄')
    assert.equal(r.code, 0, both(r))
    assert.equal(lines('orca orchestration reply').length, 2)
    // 본문의 줄바꿈 때문에 기록이 두 줄로 나뉜다. 제목은 첫 줄이다
    assert.deepEqual(lines('orca orchestration send'), ['orca orchestration send --run run_x --to dispatch:ctx_1 --subject 후속 지시 --body 후속 지시'])
    assert.match(r.stdout, /^sent: 후보가 모두 이미 답한 question 이라 reply 대신 dispatch:ctx_1 에 새 메시지로 보냈다 \(msg_sent\)$/m)
    assert.deepEqual(lines('nudge'), [])
  })

  test('--reply-to 로 준 질문이 이미 답했으면 새 메시지로 보낸다', () => {
    state({ dispatches: worker('dispatched'), inbox: [], answered: ['m_done'] })
    const r = send('--body', 'x', '--reply-to', 'm_done')
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /^sent: .*dispatch:ctx_1 에 새 메시지로 보냈다 \(msg_sent\)$/m)
    assert.deepEqual(lines('nudge'), [])
  })

  test('--reply-to 와 --body-file 을 쓰고 nudge-worker 를 부르지 않고 끝난다', () => {
    state({ dispatches: worker('dispatched') })
    env.FAKE_EXIT = '4'
    const body = join(tmp, 'body.txt')
    writeFileSync(body, '파일 본문\n')
    const r = send('--body-file', body, '--reply-to', 'm_given')
    assert.equal(r.code, 0, both(r))
    assert.ok(lines('orca orchestration reply')[0].includes('--id m_given --body 파일 본문'), logText())
  })

  test('- 로 시작하는 --body 도 본문으로 보낸다', () => {
    state({ dispatches: worker('dispatched') })
    const r = send('--body', '- 첫 항목', '--reply-to', 'm_given')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration reply'), ['orca orchestration reply --id m_given --body - 첫 항목 --run run_x --from run:run_x'])
  })

  test('worker 가 보낸 메시지가 없으면 reply 없이 새 메시지로 보내고 깨운다', () => {
    state({ dispatches: worker('dispatched'), inbox: [] })
    const r = send('--body', 'x')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration reply'), [])
    assert.deepEqual(lines('orca orchestration send'), ['orca orchestration send --run run_x --to dispatch:ctx_1 --subject x --body x --from run:run_x'])
    assert.match(r.stdout, /^sent: 보낸 메시지가 없어 reply 대신 dispatch:ctx_1 에 새 메시지로 보냈다 \(msg_sent\)$/m)
    assert.deepEqual(lines('nudge'), [])
  })

  test('새 메시지의 --from run:<run> 이 consumer_fenced 면 --from 없이 다시 보낸다', () => {
    state({ dispatches: worker('dispatched'), inbox: [], fenced: true })
    const r = send('--body', 'x')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration send'), [
      'orca orchestration send --run run_x --to dispatch:ctx_1 --subject x --body x --from run:run_x',
      'orca orchestration send --run run_x --to dispatch:ctx_1 --subject x --body x',
    ])
    assert.match(r.stdout, /^retry: .*consumer_fenced/m)
  })

  test('답할 후보가 있으면 새 메시지를 보내지 않는다', () => {
    state({ dispatches: worker('dispatched'), inbox: [message('m_st', 'term_w')] })
    const r = send('--body', 'x')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration send'), [])
    assert.match(r.stdout, /^replied: m_st 에 답했다/m)
  })

  test('--spec 만 주면 보낼 글이 없어 2 다', () => {
    state({ dispatches: worker('dispatched'), inbox: [message('m_st', 'term_w')] })
    const r = send('--spec', join(tmp, 'next.md'))
    assert.equal(r.code, 2, both(r))
    assert.match(r.stderr, /아직 살아 있어/)
    assert.deepEqual(lines('orca orchestration reply'), [])
    assert.deepEqual(lines('launch'), [])
  })
})

describe('끝난 dispatch', () => {
  test('--reply-to 로 준 메시지에 --from run:<run> 으로 답하고 깨우지 않고 0 이다', () => {
    state({ dispatches: worker('succeeded'), terminals: [{ handle: 'term_w' }] })
    const r = send('--body', '이렇게 한다', '--reply-to', 'm_esc')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration reply'), ['orca orchestration reply --id m_esc --body 이렇게 한다 --run run_x --from run:run_x'])
    assert.match(r.stdout, /^replied: m_esc 에 답했다 \(msg_new\)\. 끝난 dispatch 라 깨우지 않았다/m)
    assert.deepEqual(lines('nudge'), [])
    assert.deepEqual(lines('launch'), [])
  })

  test('--reply-to 가 없으면 미답변 question 과 escalation 중 마지막에 답한다', () => {
    const inbox = [
      message('m_hb', 'term_w', 'heartbeat', 9),
      message('m_q', 'dispatch:ctx_1', 'question', 5),
      message('m_esc', 'term_w', 'escalation', 7),
      message('m_st', 'term_w', 'status', 8),
    ]
    state({ dispatches: worker('succeeded'), terminals: [], inbox })
    const r = send('--body', 'x')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration reply'), ['orca orchestration reply --id m_esc --body x --run run_x --from run:run_x'])
  })

  test('--reply-to 와 --spec 을 주면 답을 단 뒤 이어 띄운다', () => {
    state({ dispatches: worker('completed'), terminals: [{ handle: 'term_w' }] })
    const r = send('--body', '답', '--reply-to', 'm_esc', '--spec', join(tmp, 'next.md'))
    assert.equal(r.code, 0, both(r))
    assert.equal(lines('orca orchestration reply').length, 1)
    assert.deepEqual(lines('launch'), [`launch --spec ${join(tmp, 'next.md')} --worktree /w/feat --run run_x -- --terminal term_w`])
    assert.doesNotMatch(r.stdout, /note:/)
  })

  test('답할 메시지도 --spec 도 없으면 3 이다', () => {
    const answer = { ...message('m_ans', 'run:run_x', 'status', 6), thread_id: 'm_q' }
    const question = { ...message('m_q', 'dispatch:ctx_1', 'question', 5), thread_id: 'm_q' }
    state({ dispatches: worker('completed'), terminals: [], inbox: [question, answer, message('m_st', 'term_w', 'status', 3)] })
    const r = send('--body', 'x')
    assert.equal(r.code, 3, both(r))
    assert.match(r.stdout, /^ended:/m)
    assert.deepEqual(lines('orca orchestration reply'), [])
  })

  test('reply 가 dispatch_inactive 로 거절되면 닫은 질문으로 적고 답할 곳이 없는 것으로 다룬다', () => {
    state({ dispatches: worker('completed'), terminals: [], inbox: [message('m_old', 'dispatch:ctx_1', 'question', 5)], inactive: ['m_old'] })
    const r = send('--body', '정리한다')
    assert.equal(r.code, 3, both(r))
    assert.match(r.stdout, /^closed: m_old 는 dispatch_inactive 로 답할 수 없어 닫은 질문으로 적었다/m)
    assert.match(r.stdout, /^ended:/m)
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'machine', 'questions-dismissed.json'), 'utf8')), { m_old: 'dispatch_inactive' })
  })

  test('이 답을 unanswered() 가 답으로 세어 그 메시지를 뺀다', () => {
    state({ dispatches: worker('succeeded'), terminals: [] })
    send('--body', 'x', '--reply-to', 'm_esc')
    const sent = lines('orca orchestration reply')[0].split(' ')
    const from = sent[sent.indexOf('--from') + 1]
    const escalation = { id: 'm_esc', run_id: 'run_x', type: 'escalation', from_handle: 'term_w', to_handle: 'run:run_x', thread_id: 'm_esc' }
    const answer = { id: 'msg_new', run_id: 'run_x', type: 'reply', from_handle: from, to_handle: 'dispatch:ctx_1', thread_id: 'm_esc' }
    assert.deepEqual(unanswered([escalation], 'run_x').map((m) => m.id), ['m_esc'])
    assert.deepEqual(unanswered([escalation, answer], 'run_x'), [])
  })

  test('--from run:<run> 이 consumer_fenced 로 거부되면 --from 없이 한 번 다시 보낸다', () => {
    state({ dispatches: worker('succeeded'), terminals: [], fenced: true })
    const r = send('--body', 'x', '--reply-to', 'm_esc')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration reply'), [
      'orca orchestration reply --id m_esc --body x --run run_x --from run:run_x',
      'orca orchestration reply --id m_esc --body x --run run_x',
    ])
    assert.match(r.stdout, /^retry: .*consumer_fenced/m)
    assert.match(r.stdout, /^replied: m_esc 에 답했다 \(msg_new\)/m)
  })

  test('터미널이 남았어도 --spec 이 없으면 3 으로 --spec 을 요구한다', () => {
    state({ dispatches: worker('completed'), terminals: [{ handle: 'term_w' }] })
    const r = send('--body', 'x')
    assert.equal(r.code, 3, both(r))
    assert.match(r.stdout, /--spec/)
    assert.deepEqual(lines('orca orchestration reply'), [])
    assert.deepEqual(lines('launch'), [])
  })

  test('아직 일하는 터미널도 입력하지 않고 Orca 메시지로 보낸다', () => {
    state({ dispatches: worker('succeeded'), terminals: [{ handle: 'term_w' }], screen: ['• Working (1s)'], send_rejected: false })
    const r = send('--body', 'main 을 합쳐라')
    assert.equal(r.code, 0, both(r))
    assert.match(r.stderr, /띄우기 기록에 남지 않는다/)
    assert.equal(lines('orca orchestration send').length, 1)
    assert.deepEqual(lines('nudge'), [])
    assert.deepEqual(lines('orca terminal send'), [])
    assert.deepEqual(lines('launch'), [])
  })

  test('남은 터미널에 후속 지시서로 이어 띄운다', () => {
    state({ dispatches: worker('completed'), terminals: [{ handle: 'term_w' }] })
    const r = send('--body', 'x', '--spec', join(tmp, 'next.md'))
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('launch'), [`launch --spec ${join(tmp, 'next.md')} --worktree /w/feat --run run_x -- --terminal term_w`])
    assert.match(r.stdout, /--body 가 가지 않는다/)
  })

  test('--spec 만 주면 본문 없이 이어 띄우고 note 를 내지 않는다', () => {
    state({ dispatches: worker('completed'), terminals: [{ handle: 'term_w' }] })
    const r = send('--spec', join(tmp, 'next.md'))
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('launch'), [`launch --spec ${join(tmp, 'next.md')} --worktree /w/feat --run run_x -- --terminal term_w`])
    assert.doesNotMatch(r.stdout, /note:/)
  })

  test('--body 도 --spec 도 없으면 사용법 오류다', () => {
    state({ dispatches: worker('completed'), terminals: [{ handle: 'term_w' }] })
    assert.equal(send().code, 2)
  })

  test('터미널도 없으면 새로 띄우라고 안내하고 3 이다', () => {
    state({ dispatches: worker('failed'), terminals: [{ handle: 'term_other' }] })
    const r = send('--body', 'x')
    assert.equal(r.code, 3, both(r))
    assert.ok(r.stdout.includes(`${LAUNCH_HINT} --spec <지시서> --worktree /w/feat 로 새로 띄운다`), r.stdout)
    assert.deepEqual(lines('launch'), [])
  })

  test('상태가 없는 dispatch 는 옛 명령처럼 (None) 으로 보인다', () => {
    const dispatches = worker('completed')
    delete dispatches.ctx_1.dispatch.status
    state({ dispatches, terminals: [] })
    const r = send('--body', 'x')
    assert.equal(r.code, 3, both(r))
    assert.match(r.stdout, /^ended: ctx_1 가 끝났고\(None\) 터미널도 없다/m)
  })
})

describe('코디네이터 터미널의 pane 신원이 없을 때', () => {
  const STATUS = 'orca orchestration send --run run_x --type status --thread-id m_q --to dispatch:ctx_1 --subject'

  test('question 에는 같은 스레드에 status answer 로 보내고 알린 뒤 깨운다', () => {
    state({ dispatches: worker('dispatched'), inbox: [message('m_q', 'dispatch:ctx_1', 'question', 5)], no_pane: true })
    const r = send('--body', '그렇게 한다')
    assert.equal(r.code, 0, both(r))
    // plain reply 도 거부돼야 status 로 바꾼다
    assert.equal(lines('orca orchestration reply').length, 2)
    assert.deepEqual(lines(STATUS), [`${STATUS} answer: 그렇게 한다 --body 그렇게 한다 --from run:run_x`])
    assert.match(r.stdout, /^fallback: reply 가 stable_pane_required 로 거부돼 m_q 스레드에 status answer 로 보냈다 \(msg_sent\)$/m)
    assert.deepEqual(lines('nudge'), [])
  })

  test('--run 과 --from 을 뺀 plain reply 가 받아들여지면 status 로 바꾸지 않는다', () => {
    state({ dispatches: worker('dispatched'), inbox: [message('m_q', 'dispatch:ctx_1', 'question', 5)], no_pane_scoped: true })
    const r = send('--body', '그렇게 한다')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration reply'), [
      'orca orchestration reply --id m_q --body 그렇게 한다 --run run_x --from run:run_x',
      'orca orchestration reply --id m_q --body 그렇게 한다',
    ])
    assert.deepEqual(lines('orca orchestration send'), [])
    assert.match(r.stdout, /^retry: reply 가 stable_pane_required 로 거부돼 --run 과 --from 없이 다시 보냈다$/m)
    assert.deepEqual(lines('nudge'), [])
  })

  test('여러 줄 본문은 첫 줄만 제목에 쓰고 본문은 그대로 보낸다', () => {
    state({ dispatches: worker('dispatched'), inbox: [message('m_q', 'dispatch:ctx_1', 'question', 5)], no_pane: true })
    const r = send('--body', '첫째 줄\n둘째 줄')
    assert.equal(r.code, 0, both(r))
    // 본문의 줄바꿈 때문에 기록이 두 줄로 나뉜다
    assert.deepEqual(lines(STATUS), [`${STATUS} answer: 첫째 줄 --body 첫째 줄`])
    assert.ok(logText().includes('둘째 줄 --from run:run_x'), logText())
  })

  test('question 이 아닌 메시지에는 전환하지 않고 5 로 실패한다', () => {
    state({ dispatches: worker('dispatched'), inbox: [message('m_st', 'term_w', 'status', 3)], no_pane: true })
    const r = send('--body', 'x')
    assert.equal(r.code, 5, both(r))
    assert.match(r.stdout, /stable_pane_required/)
    assert.deepEqual(lines('orca orchestration send'), [])
    assert.deepEqual(lines('nudge'), [])
  })

  test('--reply-to 가 inbox 에 없으면 종류를 몰라 전환하지 않는다', () => {
    state({ dispatches: worker('dispatched'), inbox: [], no_pane: true })
    const r = send('--body', 'x', '--reply-to', 'm_gone')
    assert.equal(r.code, 5, both(r))
    assert.deepEqual(lines('orca orchestration send'), [])
  })

  test('끝난 dispatch 의 question 에도 status answer 로 보내고 깨우지 않는다', () => {
    state({ dispatches: worker('completed'), inbox: [message('m_q', 'dispatch:ctx_1', 'question', 5)], no_pane: true })
    const r = send('--body', '그렇게 한다', '--reply-to', 'm_q')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines(STATUS), [`${STATUS} answer: 그렇게 한다 --body 그렇게 한다 --from run:run_x`])
    assert.match(r.stdout, /^fallback: /m)
    assert.match(r.stdout, /끝난 dispatch 라 깨우지 않았다/)
    assert.deepEqual(lines('nudge'), [])
  })

  test('보낸 status 가 unanswered() 에서 그 질문을 답한 것으로 세어진다', () => {
    const question = { id: 'm_q', type: 'question', run_id: 'run_x', to_handle: 'run:run_x', from_handle: 'dispatch:ctx_1', thread_id: 'm_q' }
    // send 가 만드는 메시지의 꼴: 스레드가 그 질문이고 받는 곳이 worker 의 dispatch 다
    const answer = { id: 'msg_sent', type: 'status', run_id: 'run_x', to_handle: 'dispatch:ctx_1', from_handle: 'run:run_x', thread_id: 'm_q' }
    assert.deepEqual(unanswered([question], 'run_x').map((m) => m.id), ['m_q'])
    assert.deepEqual(unanswered([question, answer], 'run_x'), [])
  })
})

describe('Orca 후속 일과 기록', () => {
  function follow(delivery = 'follow_up', extra: Json = {}): void {
    state({
      dispatches: {
        ...worker('completed'),
        ctx_new: { dispatch: { id: 'ctx_new', status: 'dispatched' }, worker: {
          agentTerminalHandle: 'term_new',
          startOptions: { launch: { effective: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } } },
        } },
      },
      terminals: [],
      receipt: { delivery, dispatchId: 'ctx_new', taskId: 'task_new' },
      ...extra,
    })
  }

  for (const delivery of ['follow_up', 'reopened']) {
    test(`${delivery} 는 새 터미널과 Task 를 기록하고 launch 를 부르지 않는다`, () => {
      follow(delivery)
      const r = send('--spec', join(tmp, 'next.md'))
      assert.equal(r.code, 0, both(r))
      assert.equal(r.stdout.trim(), 'FOLLOW-UP ctx_1 ctx_new task_new')
      const record = JSON.parse(readFileSync(join(tmp, 'orch/state/launched-workers/ctx_new.json'), 'utf8'))
      assert.equal(record.terminal, 'term_new')
      assert.equal(record.task, 'task_new')
      assert.equal(record.worktree, '/w/feat')
      assert.equal(record.spec, join(tmp, 'next.md'))
      const history = JSON.parse(readFileSync(join(tmp, 'orch/state/launch-history.jsonl'), 'utf8'))
      assert.equal(history.dispatch, record.dispatch)
      assert.equal(history.retry_of, 'ctx_1')
      assert.equal(history.row, 'impl-explore')
      const sent = lines('orca orchestration send')[0]
      assert.ok(sent.includes('--subject 후속 작업 --body 지시서 ' + join(tmp, 'next.md')))
      assert.ok(sent.includes(' 를 끝까지 읽고 수행한다. 로컬 검증을 허락했다. 못 읽으면 escalation 으로 알린다.'))
      assert.deepEqual(lines('launch'), [])
      assert.deepEqual(lines('orca terminal close'), [])
    })
  }

  test('새 worker 의 resource.terminalHandle 도 읽는다', () => {
    follow()
    const st = readState()
    st.dispatches.ctx_new = { dispatch: {}, worker: {}, resource: { terminalHandle: 'term_resource' } }
    state(st)
    assert.equal(send('--spec', join(tmp, 'next.md')).code, 0)
    const record = JSON.parse(readFileSync(join(tmp, 'orch/state/launched-workers/ctx_new.json'), 'utf8'))
    assert.equal(record.terminal, 'term_resource')
  })

  test('지시서 선택과 달라도 새 dispatch 의 실제 설정을 기록한다', () => {
    follow()
    const st = readState()
    const actual = { agent: 'claude', model: 'actual-model', effort: 'high' }
    st.dispatches.ctx_new.worker.startOptions.launch.effective = actual
    state(st)
    const r = send('--spec', join(tmp, 'next.md'))
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /note: 지시서의 worker 선택과 실제 실행 설정이 달라/)
    const record = JSON.parse(readFileSync(join(tmp, 'orch/state/launched-workers/ctx_new.json'), 'utf8'))
    const history = JSON.parse(readFileSync(join(tmp, 'orch/state/launch-history.jsonl'), 'utf8'))
    for (const saved of [record, history]) {
      assert.deepEqual(saved.effective, actual)
      for (const key of ['agent', 'model', 'effort']) assert.equal(saved[key], actual[key as keyof typeof actual])
    }
  })

  test('새 설정을 읽지 못하면 앞 기록의 실제 설정을 물려받는다', () => {
    follow()
    const st = readState()
    delete st.dispatches.ctx_new
    st.dispatches.ctx_1.worker.startOptions = { launch: { requested: { agent: 'codex', model: 'requested-model' } } }
    state(st)
    const dir = join(tmp, 'orch/state/launched-workers')
    mkdirSync(dir, { recursive: true })
    const actual = { agent: 'claude', model: 'inherited-model', effort: 'low' }
    writeFileSync(join(dir, 'ctx_1.json'), JSON.stringify({ dispatch: 'ctx_1', worktree: '/w/feat', effective: actual }))
    const r = send('--spec', join(tmp, 'next.md'))
    assert.equal(r.code, 0, both(r))
    const record = JSON.parse(readFileSync(join(dir, 'ctx_new.json'), 'utf8'))
    assert.deepEqual(record.effective, actual)
    assert.equal(record.terminal, null)
  })

  test('실제 설정을 모르면 지시서 선택을 실제 값으로 적지 않는다', () => {
    follow()
    const st = readState()
    delete st.dispatches.ctx_new.worker.startOptions
    state(st)
    assert.equal(send('--spec', join(tmp, 'next.md')).code, 0)
    const record = JSON.parse(readFileSync(join(tmp, 'orch/state/launched-workers/ctx_new.json'), 'utf8'))
    assert.deepEqual(record.effective, { agent: null, model: null, effort: null })
  })

  for (const broken of ['', 'board', 'hook']) {
    test(`후속 일도 보드와 worker-launched 를 갱신하며 실패가 전달을 취소하지 않는다: ${broken || '정상'}`, () => {
      follow()
      const st = readState()
      st.dispatches.ctx_1.worker.worktreeId = `repo::${tmp}`
      state(st)
      const board = join(tmp, '.omc/board.json')
      mkdirSync(dirname(board), { recursive: true })
      writeFileSync(board, broken === 'board' ? 'invalid' : JSON.stringify({ items: [{ id: 'next', title: '기존 제목', status: 'doing', worktree: 'old', branch: 'old', progress: '0/1' }] }))
      const spec = join(tmp, 'next.md')
      writeFileSync(spec, readFileSync(spec, 'utf8') + '보드 항목 id: next\n')
      const hook = join(tmp, 'orch/hooks/worker-launched.ts')
      mkdirSync(dirname(hook), { recursive: true })
      const captured = join(tmp, 'event.json')
      writeFileSync(hook, `import { readFileSync, writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(captured)}, readFileSync(0, 'utf8'))\nprocess.exitCode = ${broken === 'hook' ? 1 : 0}\n`)
      const r = send('--spec', spec)
      assert.equal(r.code, 0, both(r))
      const event = JSON.parse(readFileSync(captured, 'utf8'))
      assert.equal(event.event, 'worker-launched')
      assert.equal(event.worker.dispatch, 'ctx_new')
      assert.equal(event.worker.task, 'task_new')
      assert.equal(event.worker.terminal, 'term_new')
      assert.equal(event.worker.worktree, tmp)
      assert.equal(event.worker.spec, spec)
      assert.equal(event.model, 'gpt-6.1-sol')
      assert.equal(event.run, 'run_x')
      if (broken === 'board') assert.match(r.stderr, /보드를 갱신하지 못했다/)
      else {
        assert.equal(r.stderr, '', both(r))
        const item = JSON.parse(readFileSync(board, 'utf8')).items[0]
        assert.equal(item.worktree, tmp.split('/').at(-1))
        assert.equal(item.branch, 'feat/next')
        assert.equal(item.title, '기존 제목')
      }
      if (broken === 'hook') assert.match(r.stdout, /HOOK-FAIL worker-launched 1/)
      assert.deepEqual(lines('launch'), [])
    })
  }

  test('새 터미널 조회가 실패해도 앞 터미널을 쓰지 않고 빈 값과 경고로 기록한다', () => {
    follow()
    const st = readState()
    delete st.dispatches.ctx_new
    state(st)
    const r = send('--spec', join(tmp, 'next.md'))
    assert.equal(r.code, 0, both(r))
    assert.match(r.stderr, /터미널을 읽지 못해 빈 값/)
    const record = JSON.parse(readFileSync(join(tmp, 'orch/state/launched-workers/ctx_new.json'), 'utf8'))
    assert.equal(record.terminal, null)
    assert.deepEqual(lines('launch'), [])
  })

  test('허락이나 worker 선택이 잘못되면 reply 와 send 전에 2 다', () => {
    for (const text of ['# 허락 없음', '# 선택 없음\n허락: 허락했다.', '# 선택 오류\n허락: 허락했다.\nworker 선택: `codex`']) {
      follow()
      writeFileSync(join(tmp, 'bad.md'), text)
      const r = send('--spec', join(tmp, 'bad.md'), '--body', '답', '--reply-to', 'm_q')
      assert.equal(r.code, 2, both(r))
      assert.deepEqual(lines('orca orchestration send'), [])
      assert.deepEqual(lines('orca orchestration reply'), [])
    }
  })

  test('성공 영수증이 불완전하면 5 이며 전송 사실과 영수증을 알리고 중복 실행하지 않는다', () => {
    for (const receipt of [{ delivery: 'unknown' }, { delivery: 'follow_up', dispatchId: 'ctx_new' }]) {
      follow('follow_up', { receipt })
      const r = send('--spec', join(tmp, 'next.md'))
      assert.equal(r.code, 5, both(r))
      assert.match(r.stdout, /note: 전송은 성공했지만/)
      assert.ok(r.stdout.includes(`"delivery":"${receipt.delivery}"`))
      assert.doesNotMatch(r.stdout, /^FAIL /m)
      assert.deepEqual(lines('launch'), [])
    }
  })

  test('delivered 영수증이면 보낸 것으로 끝내고 후속 기록을 만들지 않는다', () => {
    follow('delivered', { receipt: { delivery: 'delivered', message: { id: 'msg_live' } } })
    env.ORCH_OUTPUT = 'short'
    const r = send('--spec', join(tmp, 'next.md'))
    assert.equal(r.code, 0, both(r))
    assert.equal(r.stdout.trim(), 'SENT ctx_1 msg_live\nDELIVERED msg_live')
    assert.equal(existsSync(join(tmp, 'orch/state/launched-workers/ctx_new.json')), false)
    assert.equal(existsSync(join(tmp, 'orch/state/launch-history.jsonl')), false)
    assert.deepEqual(lines('launch'), [])
  })

  test('연결 오류로 전달 여부를 모르면 복구 작업을 만들지 않는다', () => {
    follow('follow_up', { send_ambiguous: true })
    assert.equal(send('--spec', join(tmp, 'next.md')).code, 5)
    assert.deepEqual(lines('launch'), [])
  })

  test('각 기록의 쓰기 실패는 경고만 내고 다른 기록은 시도한다', () => {
    for (const blocked of ['launched-workers', 'launch-history.jsonl']) {
      follow()
      const dir = join(tmp, 'orch/state')
      mkdirSync(dir, { recursive: true })
      const target = join(dir, blocked)
      if (blocked === 'launched-workers') writeFileSync(target, 'blocked')
      else mkdirSync(target)
      const r = send('--spec', join(tmp, 'next.md'))
      assert.equal(r.code, 0, both(r))
      assert.match(r.stderr, /기록을 쓰지 못했다|이력을 쓰지 못했다/)
      assert.deepEqual(lines('launch'), [])
      if (blocked === 'launched-workers') assert.ok(existsSync(join(dir, 'launch-history.jsonl')))
      else assert.ok(existsSync(join(dir, 'launched-workers/ctx_new.json')))
      rmSync(join(tmp, 'orch'), { recursive: true, force: true })
    }
  })

  test('짧은 출력도 FOLLOW-UP 이다', () => {
    follow()
    env.ORCH_OUTPUT = 'short'
    const r = send('--spec', join(tmp, 'next.md'))
    assert.equal(r.stdout.trim(), 'FOLLOW-UP ctx_1 ctx_new task_new')
  })
})

describe('agent_unconfigured 뒤 다시 띄우기', () => {
  function restartSetup(extra: Json = {}): void {
    const dispatches = worker('completed')
    dispatches.ctx_1.worker.startOptions = { launch: { effective: { agent: 'codex', model: 'original-model', effort: 'high' } } }
    state({ dispatches, terminals: [{ handle: 'term_w' }], ...extra })
    writeFileSync(launch, LAUNCH_UNCONFIGURED)
  }

  function withResource(resource: Json): void {
    const data = readState()
    data.dispatches.ctx_1.terminalResource = resource
    state(data)
  }

  test('터미널을 닫고 원래 설정으로 같은 워크트리에 띄운다', () => {
    restartSetup()
    const r = send('--body', 'x', '--spec', join(tmp, 'next.md'))
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca terminal close'), ['orca terminal close --terminal term_w'])
    assert.equal(lines('launch').at(-1), `launch --spec ${join(tmp, 'next.md')} --worktree /w/feat --run run_x -- --agent codex --model original-model --effort high`)
    assert.ok(logText().indexOf('orca terminal close') < logText().lastIndexOf('launch --spec'), logText())
  })

  test('requested 의 값을 effective 에 없는 칸에 쓴다', () => {
    restartSetup()
    const data = readState()
    data.dispatches.ctx_1.worker.startOptions = {
      launch: { requested: { agent: 'claude', model: 'asked-model', effort: 'low' }, effective: { model: 'real-model', effort: '' } },
    }
    state(data)
    const r = send('--spec', join(tmp, 'next.md'))
    assert.equal(r.code, 0, both(r))
    assert.ok(lines('launch').at(-1)?.endsWith('-- --agent claude --model real-model --effort low'), logText())
  })

  test('--agent, --model, --effort 로 설정을 바꾼다', () => {
    restartSetup()
    const r = send('--body', 'x', '--spec', join(tmp, 'next.md'), '--agent', 'claude', '--model', 'new-model', '--effort', 'low')
    assert.equal(r.code, 0, both(r))
    assert.ok(lines('launch').at(-1)?.includes('--agent claude --model new-model --effort low'), logText())
  })

  test('활성 dispatch 가 붙은 터미널은 닫지 않는다', () => {
    restartSetup({ workers: [{ dispatchStatus: 'dispatched', agentTerminalHandle: 'term_w' }] })
    assert.equal(send('--body', 'x', '--spec', join(tmp, 'next.md')).code, 1)
    assert.deepEqual(lines('orca terminal close'), [])
    assert.equal(lines('launch').length, 1)
  })

  test('닫기가 실패하면 새로 띄우지 않고 5 다', () => {
    restartSetup({ close_fails: true })
    assert.equal(send('--body', 'x', '--spec', join(tmp, 'next.md')).code, 5)
    assert.equal(lines('launch').length, 1)
  })

  test('agent_unconfigured 가 아닌 띄우기 실패는 다시 시도하지 않는다', () => {
    restartSetup()
    writeFileSync(launch, 'echo "launch $*" >> "$FAKE_LOG"\nexit 1\n')
    assert.equal(send('--body', 'x', '--spec', join(tmp, 'next.md')).code, 1)
    assert.deepEqual(lines('orca terminal close'), [])
  })

  test('원래 실행 설정이 없으면 터미널을 남긴다', () => {
    restartSetup()
    const data = readState()
    delete data.dispatches.ctx_1.worker.startOptions
    state(data)
    const r = send('--body', 'x', '--spec', join(tmp, 'next.md'))
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /--agent 와 --model 을 주면/)
    assert.deepEqual(lines('orca terminal close'), [])
  })

  test('터미널 소유 dispatch 가 바뀌었으면 닫지 않는다', () => {
    restartSetup()
    withResource({ ownerDispatchId: 'ctx_other' })
    assert.equal(send('--body', 'x', '--spec', join(tmp, 'next.md')).code, 1)
    assert.deepEqual(lines('orca terminal close'), [])
  })

  test('다음 페이지의 활성 dispatch 도 닫기를 막는다', () => {
    restartSetup({
      worker_pages: [
        { workers: [], page: { hasMore: true, nextCursor: 'page2' } },
        { workers: [{ agentTerminalHandle: 'term_w', dispatchStatus: 'running' }] },
      ],
    })
    assert.equal(send('--body', 'x', '--spec', join(tmp, 'next.md')).code, 1)
    assert.deepEqual(lines('orca terminal close'), [])
    assert.ok(lines('orca orchestration worker-list').at(-1)?.includes('--cursor page2'), logText())
  })

  test('사용자가 보유한 터미널은 닫지 않고 직접 할 명령을 알린다', () => {
    restartSetup()
    withResource({ ownerDispatchId: 'ctx_1', ownershipState: 'user_owned' })
    const r = send('--body', 'x', '--spec', join(tmp, 'next.md'))
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /orca terminal close --terminal term_w/)
    assert.match(r.stdout, /orca terminal read --terminal term_w/)
    assert.ok(r.stdout.includes(`${LAUNCH_HINT} --spec ${join(tmp, 'next.md')} --worktree /w/feat (--terminal 없이) 로 띄우기`), r.stdout)
    assert.deepEqual(lines('orca terminal close'), [])
  })
})

describe('입력 경로 제거', () => {
  test('handle 이 없어도 전송에 성공하고 nudge 를 실행하지 않는다', () => {
    const dispatches = worker('dispatched')
    delete dispatches.ctx_1.worker.agentTerminalHandle
    state({ dispatches })
    env.FAKE_EXIT = '4'
    const r = send('--body', '계속', '--no-reply')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('nudge'), [])
    assert.deepEqual(lines('orca terminal send'), [])
  })
})

describe('옵션 접두', () => {
  test('고유 접두는 펼치고 여러 옵션에 맞는 접두는 사용법 오류 2 다', () => {
    state({ dispatches: worker('dispatched') })
    const r = send('--body', 'x', '--rep', 'm_given')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration reply'), ['orca orchestration reply --id m_given --body x --run run_x --from run:run_x'])
    const ambiguous = send('--bo', 'x')
    assert.equal(ambiguous.code, 2, both(ambiguous))
    assert.match(ambiguous.stderr, /--bo 이 여러 옵션의 접두다: --body, --body-file/)
  })
})

describe('오류', () => {
  test('orca 가 실패하면 5 다', () => {
    state({ fail: true })
    assert.equal(send('--body', 'x').code, 5)
  })

  test('사용법 오류는 2 다', () => {
    state({})
    assert.equal(send().code, 2)
    assert.equal(send('--body', 'a', '--body-file', 'b').code, 2)
    assert.equal(send('--body-file', '/nonexistent/b').code, 2)
    assert.equal(send('--body', 'x', '--bogus').code, 2)
  })
})

describe('짧은 출력', () => {
  beforeEach(() => {
    // 가짜 자식은 이어 받은 짧은 출력 신호를 찍는다. 신호를 넘기지 않으면 out= 이 빈다
    writeFileSync(join(tmp, 'nudge.sh'), 'echo "nudge $*" >> "$FAKE_LOG"\necho "NUDGED out=${ORCH_OUTPUT:-}"\n')
    writeFileSync(launch, 'echo "launch $*" >> "$FAKE_LOG"\necho "LAUNCHED out=${ORCH_OUTPUT:-}"\n')
  })

  test('답한 뒤 REPLIED 와 깨운 자식의 짧은 줄만 내고 자식에 신호를 넘긴다', () => {
    state({ dispatches: worker('dispatched'), inbox: [message('m_q', 'dispatch:ctx_1', 'question', 5)] })
    env.ORCH_OUTPUT = 'short'
    const r = send('--body', '그렇게 한다')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(r.stdout.trim().split('\n'), ['REPLIED m_q msg_new', 'DELIVERED msg_new'])
  })

  test('신호가 없으면 지금 줄이고 자식에도 신호가 없다', () => {
    state({ dispatches: worker('dispatched'), inbox: [message('m_q', 'dispatch:ctx_1', 'question', 5)] })
    const r = send('--body', '그렇게 한다')
    assert.match(r.stdout, /^replied: m_q 에 답했다/m)
    assert.match(r.stdout, /^delivered: Orca 가 msg_new/m)
  })

  test('끝난 dispatch 를 이어 띄우면 RESUMED 와 띄운 자식의 짧은 줄이고 자식에 신호를 넘긴다', () => {
    state({ dispatches: worker('completed'), terminals: [{ handle: 'term_w' }] })
    env.ORCH_OUTPUT = 'short'
    const r = send('--spec', join(tmp, 'next.md'))
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(r.stdout.trim().split('\n'), ['RESUMED ctx_1 term_w', 'LAUNCHED out=short'])
  })

  test('끝난 dispatch 에 답만 달면 REPLIED 끝에 no-wake 를 붙인다', () => {
    state({ dispatches: worker('succeeded'), terminals: [{ handle: 'term_w' }] })
    env.ORCH_OUTPUT = 'short'
    const r = send('--body', '이렇게 한다', '--reply-to', 'm_esc')
    assert.equal(r.code, 0, both(r))
    assert.equal(r.stdout.trim(), 'REPLIED m_esc msg_new no-wake')
  })

  test('끝나고 터미널도 없는 dispatch 는 ENDED 다', () => {
    state({ dispatches: worker('completed'), terminals: [] })
    env.ORCH_OUTPUT = 'short'
    const r = send('--body', 'x')
    assert.equal(r.code, 3, both(r))
    assert.equal(r.stdout.trim(), 'ENDED ctx_1 completed no-terminal')
  })
})
