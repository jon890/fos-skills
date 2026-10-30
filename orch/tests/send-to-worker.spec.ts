// send-to-worker.ts 를 가짜 orca, 가짜 nudge-worker, 가짜 launch-worker 로 본다. Orca 에는 닿지 않는다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { unanswered } from '../scripts/lib/questions.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/send-to-worker.ts', import.meta.url))
// 다시 띄우라는 안내 줄이 가리키는 명령. 실행 규칙의 꼴이다
const LAUNCH_HINT = `node --disable-warning=ExperimentalWarning ${fileURLToPath(new URL('../scripts/launch-worker.ts', import.meta.url))}`

// 상태 파일로 움직이는 가짜 orca. 받은 인자를 한 줄씩 기록한다. 확장자가 없어 타입 문법 없이 쓴다.
// macOS 에서 파이프로 가는 process.stdout 쓰기는 비동기라 process.exit 가 출력을 자를 수 있어 writeSync 로 쓴다.
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2).filter((a) => a !== '--json')
fs.appendFileSync(process.env.FAKE_LOG, 'orca ' + args.join(' ') + '\\n')
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
if (is('terminal', 'close')) out({}, state.close_fails ? 1 : 0)
if (is('orchestration', 'worker-show')) {
  const d = state.dispatches[opt('--dispatch')]
  out({ dispatch: d.dispatch, worker: d.worker || {}, terminalResource: d.terminalResource || {} })
}
if (is('orchestration', 'inbox')) out({ messages: state.inbox || [] })
if (is('orchestration', 'reply')) {
  if (state.no_pane) {
    print(JSON.stringify({ ok: false, error: { code: 'stable_pane_required', message: 'The coordinator terminal has no stable pane identity' } }), 1)
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
  if (state.fenced && args.includes('--from')) {
    print(JSON.stringify({ ok: false, error: { code: 'consumer_fenced', message: 'run consumer is fenced to another terminal' } }), 1)
  }
  out({ message: { id: 'msg_sent' } })
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
    NUDGE_WORKER: join(tmp, 'nudge.sh'),
    LAUNCH_WORKER: launch,
  }
  delete env.FAKE_OUT
  delete env.FAKE_EXIT
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

type Json = Record<string, any>

function state(values: Json): void {
  writeFileSync(stateFile, JSON.stringify(values))
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
    assert.deepEqual(lines('nudge'), ['nudge --terminal term_w --msg-id msg_new'])
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
    assert.deepEqual(lines('nudge'), ['nudge --terminal term_w --msg-id msg_new'])
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
    assert.deepEqual(lines('nudge'), ['nudge --terminal term_w --msg-id msg_sent'])
  })

  test('--reply-to 로 준 질문이 이미 답했으면 새 메시지로 보낸다', () => {
    state({ dispatches: worker('dispatched'), inbox: [], answered: ['m_done'] })
    const r = send('--body', 'x', '--reply-to', 'm_done')
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /^sent: .*dispatch:ctx_1 에 새 메시지로 보냈다 \(msg_sent\)$/m)
    assert.deepEqual(lines('nudge'), ['nudge --terminal term_w --msg-id msg_sent'])
  })

  test('--reply-to 와 --body-file 을 쓰고 nudge-worker 의 종료 코드를 그대로 낸다', () => {
    state({ dispatches: worker('dispatched') })
    env.FAKE_EXIT = '4'
    const body = join(tmp, 'body.txt')
    writeFileSync(body, '파일 본문\n')
    const r = send('--body-file', body, '--reply-to', 'm_given')
    assert.equal(r.code, 4, both(r))
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
    assert.deepEqual(lines('nudge'), ['nudge --terminal term_w --msg-id msg_sent'])
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
    const r = send('--spec', '/s/next.md')
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
    const r = send('--body', '답', '--reply-to', 'm_esc', '--spec', '/s/next.md')
    assert.equal(r.code, 0, both(r))
    assert.equal(lines('orca orchestration reply').length, 1)
    assert.deepEqual(lines('launch'), ['launch --spec /s/next.md --worktree /w/feat --run run_x -- --terminal term_w'])
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

  test('아직 일하는 터미널에는 경고와 함께 본문을 넣는다', () => {
    // worker 가 phase 중간에 worker_done 을 보내 dispatch 가 닫혔지만 계속 일하는 경우다
    state({ dispatches: worker('succeeded'), terminals: [{ handle: 'term_w' }] })
    env.FAKE_OUT = 'working'
    const r = send('--body', 'main 을 합쳐라')
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /Task 기록에 묶이지 않는다/)
    assert.deepEqual(lines('nudge'), [
      'nudge --terminal term_w --state',
      'nudge --terminal term_w --text 코디네이터(닫힌 dispatch ctx_1): main 을 합쳐라',
    ])
    assert.deepEqual(lines('orca orchestration reply'), [])
    assert.deepEqual(lines('launch'), [])
  })

  test('남은 터미널에 후속 지시서로 이어 띄운다', () => {
    state({ dispatches: worker('completed'), terminals: [{ handle: 'term_w' }] })
    const r = send('--body', 'x', '--spec', '/s/next.md')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('launch'), ['launch --spec /s/next.md --worktree /w/feat --run run_x -- --terminal term_w'])
    assert.match(r.stdout, /--body 가 가지 않는다/)
  })

  test('--spec 만 주면 본문 없이 이어 띄우고 note 를 내지 않는다', () => {
    state({ dispatches: worker('completed'), terminals: [{ handle: 'term_w' }] })
    const r = send('--spec', '/s/next.md')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('launch'), ['launch --spec /s/next.md --worktree /w/feat --run run_x -- --terminal term_w'])
    assert.doesNotMatch(r.stdout, /note:/)
  })

  test('--body 도 --spec 도 없으면 사용법 오류다', () => {
    state({ dispatches: worker('completed'), terminals: [{ handle: 'term_w' }] })
    assert.equal(send().code, 2)
  })

  test('터미널도 없으면 새로 띄우라고 안내하고 3 이다', () => {
    state({ dispatches: worker('failed'), terminals: [{ handle: 'term_other' }] })
    const r = send('--body', 'x', '--spec', '/s/next.md')
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
    assert.equal(lines('orca orchestration reply').length, 1)
    assert.deepEqual(lines(STATUS), [`${STATUS} answer: 그렇게 한다 --body 그렇게 한다 --from run:run_x`])
    assert.match(r.stdout, /^fallback: reply 가 stable_pane_required 로 거부돼 m_q 스레드에 status answer 로 보냈다 \(msg_sent\)$/m)
    assert.deepEqual(lines('nudge'), ['nudge --terminal term_w --msg-id msg_sent'])
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
    const r = send('--body', 'x', '--spec', '/s/next.md')
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca terminal close'), ['orca terminal close --terminal term_w'])
    assert.equal(lines('launch').at(-1), 'launch --spec /s/next.md --worktree /w/feat --run run_x -- --agent codex --model original-model --effort high')
    assert.ok(logText().indexOf('orca terminal close') < logText().lastIndexOf('launch --spec'), logText())
  })

  test('requested 의 값을 effective 에 없는 칸에 쓴다', () => {
    restartSetup()
    const data = readState()
    data.dispatches.ctx_1.worker.startOptions = {
      launch: { requested: { agent: 'claude', model: 'asked-model', effort: 'low' }, effective: { model: 'real-model', effort: '' } },
    }
    state(data)
    const r = send('--spec', '/s/next.md')
    assert.equal(r.code, 0, both(r))
    assert.ok(lines('launch').at(-1)?.endsWith('-- --agent claude --model real-model --effort low'), logText())
  })

  test('--agent, --model, --effort 로 설정을 바꾼다', () => {
    restartSetup()
    const r = send('--body', 'x', '--spec', '/s/next.md', '--agent', 'claude', '--model', 'new-model', '--effort', 'low')
    assert.equal(r.code, 0, both(r))
    assert.ok(lines('launch').at(-1)?.includes('--agent claude --model new-model --effort low'), logText())
  })

  test('활성 dispatch 가 붙은 터미널은 닫지 않는다', () => {
    restartSetup({ workers: [{ dispatchStatus: 'dispatched', agentTerminalHandle: 'term_w' }] })
    assert.equal(send('--body', 'x', '--spec', '/s/next.md').code, 1)
    assert.deepEqual(lines('orca terminal close'), [])
    assert.equal(lines('launch').length, 1)
  })

  test('닫기가 실패하면 새로 띄우지 않고 5 다', () => {
    restartSetup({ close_fails: true })
    assert.equal(send('--body', 'x', '--spec', '/s/next.md').code, 5)
    assert.equal(lines('launch').length, 1)
  })

  test('agent_unconfigured 가 아닌 띄우기 실패는 다시 시도하지 않는다', () => {
    restartSetup()
    writeFileSync(launch, 'echo "launch $*" >> "$FAKE_LOG"\nexit 1\n')
    assert.equal(send('--body', 'x', '--spec', '/s/next.md').code, 1)
    assert.deepEqual(lines('orca terminal close'), [])
  })

  test('원래 실행 설정이 없으면 터미널을 남긴다', () => {
    restartSetup()
    const data = readState()
    delete data.dispatches.ctx_1.worker.startOptions
    state(data)
    const r = send('--body', 'x', '--spec', '/s/next.md')
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /--agent 와 --model 을 주면/)
    assert.deepEqual(lines('orca terminal close'), [])
  })

  test('터미널 소유 dispatch 가 바뀌었으면 닫지 않는다', () => {
    restartSetup()
    withResource({ ownerDispatchId: 'ctx_other' })
    assert.equal(send('--body', 'x', '--spec', '/s/next.md').code, 1)
    assert.deepEqual(lines('orca terminal close'), [])
  })

  test('다음 페이지의 활성 dispatch 도 닫기를 막는다', () => {
    restartSetup({
      worker_pages: [
        { workers: [], page: { hasMore: true, nextCursor: 'page2' } },
        { workers: [{ agentTerminalHandle: 'term_w', dispatchStatus: 'running' }] },
      ],
    })
    assert.equal(send('--body', 'x', '--spec', '/s/next.md').code, 1)
    assert.deepEqual(lines('orca terminal close'), [])
    assert.ok(lines('orca orchestration worker-list').at(-1)?.includes('--cursor page2'), logText())
  })

  test('사용자가 보유한 터미널은 닫지 않고 직접 할 명령을 알린다', () => {
    restartSetup()
    withResource({ ownerDispatchId: 'ctx_1', ownershipState: 'user_owned' })
    const r = send('--body', 'x', '--spec', '/s/next.md')
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /orca terminal close --terminal term_w/)
    assert.match(r.stdout, /orca terminal read --terminal term_w/)
    assert.ok(r.stdout.includes(`${LAUNCH_HINT} --spec /s/next.md --worktree /w/feat (--terminal 없이) 로 띄우기`), r.stdout)
    assert.deepEqual(lines('orca terminal close'), [])
  })
})

describe('자식 출력', () => {
  test('nudge-worker 의 줄을 모으지 않고 낸 차례대로 바로 흘린다', { timeout: 60_000 }, async () => {
    state({ dispatches: worker('dispatched'), inbox: [message('m_st', 'term_w')] })
    writeFileSync(join(tmp, 'nudge.sh'), 'echo "nudge $*" >> "$FAKE_LOG"\necho NUDGE-START\nsleep 2\necho NUDGE-END\n')
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--dispatch', 'ctx_1', '--body', 'x'], { env })
    const seen: { line: string; at: number }[] = []
    let rest = ''
    child.stdout.on('data', (chunk: Buffer) => {
      const parts = (rest + chunk.toString('utf8')).split('\n')
      rest = parts.pop() ?? ''
      for (const line of parts) seen.push({ line, at: Date.now() })
    })
    const code = await new Promise((resolve) => child.on('close', resolve))
    assert.equal(code, 0)
    assert.deepEqual(
      seen.map((s) => s.line),
      ['replied: m_st 에 답했다 (msg_new)', 'NUDGE-START', 'NUDGE-END'],
    )
    // 모아서 냈다면 두 표지 줄이 자식이 끝난 뒤 함께 온다. 잠든 2초 가운데 대부분이 둘 사이에 있어야 한다
    const gap = seen[2].at - seen[1].at
    assert.ok(gap >= 1000, `NUDGE-START 와 NUDGE-END 가 ${gap}ms 차이로 왔다`)
  })

  test('nudge-worker 가 제한 시간에 끊기면 124 가 아니라 1 이다', () => {
    state({ dispatches: worker('dispatched'), inbox: [message('m_st', 'term_w')] })
    writeFileSync(join(tmp, 'nudge.sh'), 'exec sleep 20\n')
    env.ORCH_NUDGE_TIMEOUT_MS = '500'
    const r = send('--body', 'x')
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /nudge-worker 가 0\.5초 안에 끝나지 않아 끊었다/)
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
