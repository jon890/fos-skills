// lib/questions.ts 의 미답변 판정과 watch-questions.ts 를 가짜 orca 로 본다. Orca 에는 닿지 않는다.
// 가짜 orca 는 ORCA 환경 변수로 넣는다. lib/orca.ts 는 ORCA_CLI_COMMAND 를 읽지 않는다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ageSeconds, poll, REPLY_LIMIT, snapshot, unanswered } from '../scripts/lib/questions.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/watch-questions.ts', import.meta.url))
const SHIM = fileURLToPath(new URL('../scripts/watch-questions.py', import.meta.url))

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
    .map((line) => (JSON.parse(line) as string[]).slice(1, -1))
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

describe('unanswered', () => {
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

function watch(...args: string[]): Result {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', tmp, ...args], {
    env,
    cwd: tmp,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function seenFile(): string {
  return join(tmp, '.orch/state/questions-seen.json')
}

function lines(text: string, prefix: string): string[] {
  return text.split('\n').filter((line) => line.startsWith(prefix))
}

describe('watch-questions', () => {
  test('처음 보는 질문은 QUESTION 이고 다시 불러도 재알림 전에는 조용하다', () => {
    fake({ all: { messages: [message()] } })
    const first = watch('--run', 'r', '--once')
    assert.equal(first.code, 0, first.stderr)
    assert.deepEqual(lines(first.stdout, 'QUESTION'), ['QUESTION q question from=dispatch:d: 두 줄 질문'])
    const second = watch('--run', 'r', '--once')
    assert.deepEqual([second.code, second.stdout], [0, ''])
    // 알린 지 --remind-after(600초)가 지나면 다시 알린다. 지나지 않았으면 알리지 않는다
    const now = Date.now() / 1000
    writeFileSync(seenFile(), JSON.stringify({ r: { q: now - 590 } }))
    assert.equal(watch('--run', 'r', '--once').stdout, '')
    writeFileSync(seenFile(), JSON.stringify({ r: { q: now - 601 } }))
    const reminded = watch('--run', 'r', '--once')
    assert.match(reminded.stdout, /^REMINDER q question from=dispatch:d: /m)
  })

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

  test('알린 시각이 수가 아니면 형식 오류로 WATCH-ERROR 이고 기록을 바꾸지 않는다', () => {
    fake({ all: { messages: [message()] } })
    mkdirSync(dirname(seenFile()), { recursive: true })
    writeFileSync(seenFile(), '{"r": {"q": "1000"}}')
    const r = watch('--run', 'r', '--once')
    assert.equal(r.code, 1, r.stderr)
    assert.match(r.stdout, /^WATCH-ERROR 알림 기록 형식이 잘못됐다: /m)
    // stderr 도 wait-important 와 같은 WATCH-ERROR 줄이다
    assert.match(r.stderr, /^WATCH-ERROR 알림 기록 형식이 잘못됐다: /m)
    assert.equal(readFileSync(seenFile(), 'utf8'), '{"r": {"q": "1000"}}')
  })

  test('알림 기록은 Run 별이고 답한 질문은 다시 알리지 않는다', () => {
    fake({ all: { messages: [message()] } })
    assert.equal(lines(watch('--run', 'r', '--once').stdout, 'QUESTION').length, 1)
    fake({ all: { messages: [message('q', 'question', { run_id: 'other', to_handle: 'run:other' })] } })
    assert.equal(lines(watch('--run', 'other', '--once').stdout, 'QUESTION').length, 1)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(seenFile(), 'utf8'))).sort(), ['other', 'r'])
    writeFileSync(seenFile(), JSON.stringify({ r: { q: 0 } }))
    fake({ all: { messages: [message()] }, inbox: { 'dispatch:d': [answer()] } })
    assert.deepEqual(watch('--run', 'r', '--once'), { code: 0, stdout: '', stderr: '' })
  })

  test('질문이 없어도 Run 의 빈 기록을 남긴다', () => {
    fake({})
    assert.equal(watch('--run', 'r', '--once').code, 0)
    assert.deepEqual(JSON.parse(readFileSync(seenFile(), 'utf8')), { r: {} })
  })

  test('check 가 실패하면 --once 는 WATCH-ERROR 줄과 1 이고 알림 기록을 바꾸지 않는다', () => {
    mkdirSync(dirname(seenFile()), { recursive: true })
    writeFileSync(seenFile(), '{"r":{"q":1000}}')
    fake({ checkSeq: ['fail'] })
    const r = watch('--run', 'r', '--once')
    assert.equal(r.code, 1, r.stderr)
    const errors = lines(r.stdout, 'WATCH-ERROR ')
    assert.equal(errors.length, 1, r.stdout)
    assert.match(errors[0], /offline/)
    assert.ok(r.stderr.includes(errors[0].slice('WATCH-ERROR '.length)), r.stderr)
    assert.equal(readFileSync(seenFile(), 'utf8'), '{"r":{"q":1000}}')
  })

  test('답 기록 한도와 깨진 알림 기록도 WATCH-ERROR 다', () => {
    const unrelated = { ...message(), id: 'follow', type: 'status' }
    fake({ all: { messages: [message()] }, inbox: { 'dispatch:d': Array.from({ length: REPLY_LIMIT }, () => unrelated) } })
    assert.match(watch('--run', 'r', '--once').stdout, /^WATCH-ERROR .*답변 기록 한도/m)
    fake({})
    mkdirSync(dirname(seenFile()), { recursive: true })
    writeFileSync(seenFile(), 'not json')
    const broken = watch('--run', 'r', '--once')
    assert.equal(broken.code, 1)
    assert.match(broken.stdout, /^WATCH-ERROR /m)
    assert.equal(readFileSync(seenFile(), 'utf8'), 'not json')
  })

  test('반복 모드는 같은 이유를 한 번만 내고 조회가 성공한 뒤에는 다시 낸다', async () => {
    // 실패, 실패, 성공, 실패, 실패 순이다. 처음 실패와 성공 뒤 실패에서만 낸다
    fake({ checkSeq: ['fail', 'fail', 'ok', 'fail'] })
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', tmp, '--run', 'r', '--interval', '0.1'], { env, cwd: tmp })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    const closed = new Promise((resolve) => child.on('close', resolve))
    const counter = join(tmp, 'all-count')
    const deadline = Date.now() + 30_000
    while (!(existsSync(counter) && Number(readFileSync(counter, 'utf8')) >= 5)) {
      assert.ok(Date.now() < deadline, `조회가 다섯 번 돌지 않았다: ${stdout}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    child.kill('SIGTERM')
    await closed
    assert.equal(lines(stdout, 'WATCH-ERROR ').length, 2, stdout)
  })

  test('질문 100건인 Run 은 조회 범위를 stderr 로만 알린다', () => {
    fake({ all: { messages: Array.from({ length: 100 }, () => message()) } })
    const r = watch('--run', 'r', '--once')
    assert.equal(r.code, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /WATCH-ERROR/)
    assert.match(r.stderr, /더 오래된 미답변은 빠질 수 있다/)
    assert.equal(lines(r.stdout, 'QUESTION').length, 1)
  })

  test('QUESTION 과 REMINDER 뒤에 worker-question 핸들러가 질문을 받는다', () => {
    const capture = join(tmp, 'input.jsonl')
    mkdirSync(join(tmp, '.orch/hooks'), { recursive: true })
    writeFileSync(
      join(tmp, '.orch/hooks/worker-question.ts'),
      `import { appendFileSync, readFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(capture)}, readFileSync(0, 'utf8') + '\\n')\nconsole.log('알렸다')\n`,
    )
    fake({ all: { messages: [message('q', 'question', { task_id: 'task_a', payload: { dispatchId: 'ctx_a' }, subject: '제목' })] } })
    const r = watch('--run', 'r', '--once')
    assert.equal(r.code, 0, r.stderr)
    const out = r.stdout.split('\n')
    assert.ok(out.indexOf('[hook worker-question] 알렸다') > out.findIndex((line) => line.startsWith('QUESTION q')), r.stdout)
    writeFileSync(seenFile(), JSON.stringify({ r: { q: Date.now() / 1000 - 601 } }))
    assert.match(watch('--run', 'r', '--once').stdout, /^REMINDER q/m)
    const inputs = readFileSync(capture, 'utf8')
      .split('\n')
      .filter((line) => line)
      .map((line) => JSON.parse(line) as Json)
    assert.equal(inputs.length, 2)
    const [first, second] = inputs
    assert.equal(first.event, 'worker-question')
    assert.equal(first.run, 'r')
    assert.deepEqual(first.message, { id: 'q', type: 'question', subject: '제목', body: '두 줄\n질문' })
    assert.equal(first.reminder, false)
    assert.deepEqual(first.worker, { task: 'task_a', dispatch: 'ctx_a', terminal: 'dispatch:d', worktree: null, spec: null })
    assert.ok(Number.isInteger(first.age_sec) && (first.age_sec as number) > 0, String(first.age_sec))
    assert.equal(second.reminder, true)
  })

  test('worker-question 핸들러가 실패해도 종료 코드는 그대로다', () => {
    mkdirSync(join(tmp, '.orch/hooks'), { recursive: true })
    writeFileSync(join(tmp, '.orch/hooks/worker-question.ts'), 'process.exitCode = 1\n')
    fake({ all: { messages: [message()] } })
    const r = watch('--run', 'r', '--once')
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^HOOK-FAIL worker-question 1$/m)
  })

  test('간격이 양수가 아니면 사용법 오류다', () => {
    for (const option of ['--interval', '--remind-after']) {
      for (const value of ['0', 'abc']) assert.equal(watch(option, value).code, 2, `${option} ${value}`)
    }
  })
})

describe('watch-questions.py shim', () => {
  // python3 은 절대경로로 부른다
  const python = (): string => spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim()

  test('옛 경로가 같은 옵션, 줄, 종료 코드로 넘긴다', () => {
    fake({ all: { messages: [message()] } })
    const done = spawnSync(python(), [SHIM, '--repo', tmp, '--run', 'r', '--once'], { env, cwd: tmp, encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
    assert.match(done.stdout, /^QUESTION q question/m)
    assert.equal(spawnSync(python(), [SHIM, '--interval', '0'], { env, encoding: 'utf8' }).status, 2)
  })
})
