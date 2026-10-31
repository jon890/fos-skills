// orch-loop.ts 를 가짜 orca, gh, 정리 명령, 보드 동기화로 본다. Orca 와 GitHub 에는 닿지 않는다.
// 가짜 orca 와 gh 는 ORCA, GH, 가짜 정리와 보드 동기화는 CLEANUP_SWEEP, BOARD_SYNC 로 넣는다. 가짜 명령은 받은 인자를 파일에 적는다.
// 핸들러(tick, worker-question)는 작업 폴더의 .orch/hooks/ 에 두고 stdin 을 파일에 적게 해서 받은 입력을 본다.
// 띄운 루프는 테스트마다 끝낸다. 끝에 loop.json 의 pid 가 살아 있지 않은지도 본다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin } from './fixtures/fake-bin.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/orch-loop.ts', import.meta.url))

// 질문 조회에 답하는 가짜 orca. state.json 을 읽는다. by_run 이 있으면 --run 의 Run 에 그 목록으로 답한다.
// statuses 는 status 조회에, workers 는 worker-list 에 답한다. fail 이면 실패로, sleep 이 있으면 그 초만큼 잔 뒤 답한다.
// slow_run_current 는 run-current 만 그 초만큼 늦게 답한다. bound 가 있으면 그 Run 에 묶인 호출자처럼 run-current 에 그 Run 을 내고, 다른 Run 의 check 를 consumer_fenced 로 거부한다.
// 받은 인자는 calls.jsonl 에 한 줄씩 적는다. 확장자 없는 실행 파일이라 타입 문법을 쓰지 않는다.
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const dir = process.env.FAKE_DIR
const argv = process.argv.slice(2)
fs.appendFileSync(dir + '/orca-calls.jsonl', JSON.stringify(argv) + '\\n')
const st = JSON.parse(fs.readFileSync(dir + '/orca.json', 'utf8'))
if (st.sleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, st.sleep * 1000)
if (st.fail) {
  process.stderr.write('offline\\n')
  process.exit(1)
}
const reply = (result) => process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n')
const sub = argv[1]
const run = argv.includes('--run') ? argv[argv.indexOf('--run') + 1] : null
const byRun = st.by_run && run ? st.by_run[run] || [] : null
if (st.bound && sub === 'check' && run && run !== st.bound) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'consumer_fenced', message: 'This caller is bound to Run ' + st.bound + ', not Run ' + run } }) + '\\n')
  process.exit(1)
}
if (sub === 'run-current') {
  if (st.slow_run_current) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, st.slow_run_current * 1000)
  reply({ run: st.bound ? { id: st.bound } : null })
  process.exit(0)
}
if (sub === 'check' && argv.includes('--all') && argv.includes('status')) reply({ messages: st.statuses || [] })
else if (sub === 'check' && argv.includes('--all')) reply({ messages: byRun || st.messages || [] })
else if (sub === 'worker-list') reply({ workers: st.workers || [], page: {} })
else if (sub === 'check') reply({ messages: [] })
else if (sub === 'inbox') reply({ messages: [] })
else reply({})
`

// 정리와 보드 동기화 가짜. 받은 인자를 <이름>.jsonl 에 적고, <이름>.json 의 sleep(초)만큼 잔 뒤 code 로 끝난다.
// ignore_term 이면 TERM 을 무시하고, pid_file 이 있으면 자기 pid 와 부모 pid 를 그 파일에 적은 뒤 잔다
function fakeScript(name: string): string {
  return `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const dir = process.env.FAKE_DIR
appendFileSync(dir + '/${name}.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n')
const st = existsSync(dir + '/${name}.json') ? JSON.parse(readFileSync(dir + '/${name}.json', 'utf8')) : {}
if (st.ignore_term) process.on('SIGTERM', () => {})
if (st.pid_file) writeFileSync(st.pid_file, process.pid + ' ' + process.ppid + '\\n')
if (st.sleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, st.sleep * 1000)
console.log('${name} 돌았다')
process.exitCode = st.code ?? 0
`
}

// 핸들러가 받은 stdin 을 RECEIVED_DIR/<이벤트>.jsonl 에 한 줄씩 적고, HOOK_CODE_<이벤트> 로 끝난다
function handler(event: string): string {
  const key = `HOOK_CODE_${event.replaceAll('-', '_')}`
  return `import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync(process.env.RECEIVED_DIR + '/${event}.jsonl', readFileSync(0, 'utf8') + '\\n')
process.exitCode = Number(process.env.${key} || '0')
`
}

// 틱 자식(--tick)만 결과 줄 없이 3 으로 끝나게 하는 preload. TICK_FAIL_UNTIL 번째 틱까지 그렇다
const PRELOAD = `import { writeSync } from 'node:fs'
const argv = process.argv
const at = argv.indexOf('--tick-number')
if (argv.some((a) => a.endsWith('orch-loop.ts')) && argv.includes('--tick') && Number(argv[at + 1]) <= Number(process.env.TICK_FAIL_UNTIL || '0')) {
  writeSync(1, '결과 없이 끝난다\\n')
  process.exit(3)
}
`

type Json = Record<string, unknown>
type Result = { code: number | null; stdout: string; stderr: string }

let binDir: string
let tmp: string
let repo: string
let env: NodeJS.ProcessEnv
let gh: FakeBin
const spawned: ChildProcess[] = []

before(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'orch-loop-bin-')))
  writeFileSync(join(binDir, 'orca'), FAKE_ORCA)
  chmodSync(join(binDir, 'orca'), 0o755)
  writeFileSync(join(binDir, 'sweep.ts'), fakeScript('sweep'))
  writeFileSync(join(binDir, 'board.ts'), fakeScript('board'))
  writeFileSync(join(binDir, 'preload.mjs'), PRELOAD)
})
after(() => rmSync(binDir, { recursive: true, force: true }))

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-loop-')))
  repo = join(tmp, 'repo')
  mkdirSync(join(tmp, 'received'), { recursive: true })
  mkdirSync(repo)
  gh = fakeBin(tmp, 'gh', [])
  env = {
    ...process.env,
    // 가짜 orca 의 #! 줄과 핸들러가 이 테스트의 node 를 쓰게 한다
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ORCA: join(binDir, 'orca'),
    GH: gh.path,
    CLEANUP_SWEEP: join(binDir, 'sweep.ts'),
    BOARD_SYNC: join(binDir, 'board.ts'),
    FAKE_DIR: tmp,
    RECEIVED_DIR: join(tmp, 'received'),
    // 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다
    GIT_CEILING_DIRECTORIES: tmp,
  }
  delete env.ORCH_DIR
  delete env.ORCH_LOOP_ALIVE_SEC
  delete env.NODE_OPTIONS
  orca({})
  prs([])
})

afterEach(() => {
  // 테스트가 띄운 루프를 남기지 않는다. --start 로 띄운 루프는 loop.json 의 pid 로 찾는다
  for (const child of spawned.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  const state = loopState()
  if (state && typeof state.pid === 'number' && state.pid !== process.pid && pidAlive(state.pid)) process.kill(state.pid, 'SIGKILL')
  rmSync(tmp, { recursive: true, force: true })
})

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function orca(state: Json): void {
  writeFileSync(join(tmp, 'orca.json'), JSON.stringify(state))
}

function fake(name: 'sweep' | 'board', state: Json): void {
  writeFileSync(join(tmp, `${name}.json`), JSON.stringify(state))
}

const MINE = { number: 1, author: { login: 'me' }, url: 'https://github.com/o/r/pull/1' }
const THEIRS = { number: 2, author: { login: 'other' }, url: 'https://github.com/o/r/pull/2' }

function prs(rows: Json[], code = 0): void {
  gh.setRules([
    { args: ['pr', 'list'], stdout: `${JSON.stringify(rows)}\n`, stderr: code ? 'gh offline\n' : '', code },
    { args: ['api', 'user'], stdout: 'me\n' },
  ])
}

function orchFile(...parts: string[]): string {
  return join(repo, '.orch', ...parts)
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function config(value: Json): void {
  write(orchFile('config.json'), JSON.stringify(value))
}

function hook(event: string): void {
  write(orchFile('hooks', `${event}.ts`), handler(event))
}

function board(): void {
  write(join(repo, '.omc', 'board.json'), '{"items": []}\n')
}

function loop(args: string[], extra: NodeJS.ProcessEnv = {}): Result {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, ...args], {
    env: { ...env, ...extra },
    cwd: tmp,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function once(extra: NodeJS.ProcessEnv = {}, args: string[] = ['--run', 'r']): Result {
  const r = loop([...args, '--foreground', '--once'], extra)
  assert.equal(r.code, 0, r.stdout + r.stderr)
  return r
}

function jsonl(file: string): Json[] {
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Json)
    : []
}

// 알림 파일 전부. Run 이 없는 루프의 파일과 Run 마다의 파일(state/loop-events/<Run>.jsonl)을 합친다
function events(): Json[] {
  const dir = orchFile('state', 'loop-events')
  const perRun = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().flatMap((name) => jsonl(join(dir, name))) : []
  return [...jsonl(orchFile('state', 'loop-events.jsonl')), ...perRun]
}

function received(event: string): Json[] {
  return jsonl(join(tmp, 'received', `${event}.jsonl`))
}

function argsOf(name: 'sweep' | 'board'): string[][] {
  return jsonl(join(tmp, `${name}.jsonl`)) as unknown as string[][]
}

function loopState(): Json | null {
  try {
    return JSON.parse(readFileSync(orchFile('state', 'loop.json'), 'utf8')) as Json
  } catch {
    return null
  }
}

function logText(): string {
  return existsSync(orchFile('state', 'loop.log')) ? readFileSync(orchFile('state', 'loop.log'), 'utf8') : ''
}

function question(id = 'q', created = '2026-01-01T00:00:00Z'): Json {
  return { id, type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'dispatch:d', thread_id: id, body: '질문', created_at: created }
}

// 명령줄에 orch-loop 가 든 살아 있는 프로세스다. 그 pid 는 루프 프로세스로 보인다. 테스트가 끝나면 끝낸다
async function fakeLoop(t: TestContext): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'orch-loop'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  await new Promise((resolve) => child.once('spawn', resolve))
  return child.pid as number
}

// 명령줄에 orch-loop 가 없는 살아 있는 프로세스다. 테스트가 끝나면 afterEach 가 끝낸다
async function otherProcess(): Promise<number> {
  const other = spawn('sleep', ['60'], { stdio: 'ignore' })
  spawned.push(other)
  await new Promise((resolve) => other.once('spawn', resolve))
  return other.pid as number
}

// 늘 1 로 끝나는 가짜 ps 를 PATH 앞에 둔 환경. 루프 프로세스인지 판정할 수 없는 경우다
function failingPs(): NodeJS.ProcessEnv {
  const dir = join(tmp, 'ps-bin')
  mkdirSync(dir)
  fakeBin(dir, 'ps', [{ code: 1, stderr: 'ps: 실패\n' }])
  return { PATH: `${dir}${delimiter}${env.PATH ?? ''}` }
}

async function waitDead(pids: number[], ms: number): Promise<void> {
  const until = Date.now() + ms
  while (pids.some(pidAlive) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50))
}

// 루프를 띄우고 끝날 때까지 loop.json 을 50ms 마다 읽어 둔다
async function sampled(args: string[], extra: NodeJS.ProcessEnv): Promise<{ code: number | null; samples: Json[] }> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, ...args], { env: { ...env, ...extra }, cwd: tmp })
  spawned.push(child)
  const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
  const samples: Json[] = []
  let done = false
  void closed.then(() => (done = true))
  while (!done) {
    const state = loopState()
    if (state) samples.push(state)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return { code: await closed, samples }
}

describe('질문 확인', () => {
  test('새 사용자 결정은 기본 대기가 없어도 핸들러로 요청하고 같은 질문 재전송은 다시 깨우지 않는다', () => {
    hook('decision-pending')
    hook('worker-question')
    const ask = (id: string) => ({ ...question(id), body: '결정: 저장 형식\n권장: JSON' })
    const workers = [{ dispatchId: 'd', dispatchStatus: 'dispatched', agentTerminalHandle: 'term_w' }]
    orca({ messages: [ask('first')], workers })
    once()
    assert.equal(received('decision-pending').length, 1)
    assert.equal(received('decision-pending')[0].run, 'r')
    assert.equal((received('decision-pending')[0].questions as Json[])[0].id, 'first')
    const workerQuestionCount = received('worker-question').length
    // 질문 감시의 재알림 시간이 지나도 사용자 결정은 DECISION-PENDING 한 번으로만 다룬다.
    write(orchFile('state', 'questions-seen.json'), JSON.stringify({ r: { first: Date.now() / 1000 - 700, retry: Date.now() / 1000 - 700 } }))
    orca({ messages: [ask('first'), ask('retry')], workers })
    once()
    assert.equal(received('decision-pending').length, 1)
    assert.equal(events().filter((e) => e.kind === 'DECISION-PENDING').length, 1)
    assert.deepEqual(events().filter((e) => e.kind === 'REMINDER'), [])
    assert.equal(received('worker-question').length, workerQuestionCount)
    // 끝난 dispatch 의 질문은 결정 알림에서 제거된다.
    orca({ messages: [ask('retry')], workers: [{ ...workers[0], dispatchStatus: 'completed' }] })
    once()
    assert.equal(received('decision-pending').length, 1)
  })

  test('알린 지 700초 지난 기술 질문은 REMINDER 를 알림 파일에 쓰고 worker-question 이 reminder 를 받는다', () => {
    hook('worker-question')
    orca({ messages: [{ ...question(), body: '기술 질문: 연결을 확인한다' }] })
    write(orchFile('state', 'questions-seen.json'), JSON.stringify({ r: { q: Date.now() / 1000 - 700 } }))
    once()
    const lines = events()
    assert.equal(lines.length, 1, JSON.stringify(lines))
    assert.equal(lines[0].kind, 'REMINDER')
    assert.match(String(lines[0].text), /^q question from=dispatch:d: 기술 질문: 연결을 확인한다$/)
    assert.equal(lines[0].pr, null)
    const inputs = received('worker-question')
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0].reminder, true)
    assert.equal(inputs[0].run, 'r')
  })

  describe('닫힌 질문', () => {
    const SHA = 'a'.repeat(40)
    const ready = { id: 's1', type: 'status', run_id: 'r', payload: { dispatchId: 'd' }, subject: `준비됨 #7, head ${SHA}` }
    const settled = (status: string) => [{ dispatchId: 'd', dispatchStatus: status }]
    const pr = (state: string, head = SHA) =>
      gh.setRules([
        { args: ['pr', 'view', '7'], stdout: `${JSON.stringify({ state, headRefOid: head, commits: [{ oid: head }] })}\n` },
        { args: ['pr', 'list'], stdout: '[]\n' },
        { args: ['api', 'user'], stdout: 'me\n' },
      ])
    const remindLater = () => write(orchFile('state', 'questions-seen.json'), JSON.stringify({ r: { q: Date.now() / 1000 - 700 } }))

    test('dispatch 가 끝났고 PR 이 머지됐으면 재알림하지 않고 근거를 한 번만 로그에 쓴다', () => {
      hook('worker-question')
      orca({ messages: [question()], statuses: [ready], workers: settled('completed') })
      pr('MERGED')
      remindLater()
      once()
      assert.deepEqual(events(), [])
      assert.deepEqual(received('worker-question'), [])
      assert.match(logText(), /^REMINDER-SKIP q: dispatch d completed, PR #7 MERGED$/m)
      const viewed = () => gh.calls().filter((c) => c.argv.includes('view')).length
      assert.equal(viewed(), 1)
      remindLater()
      once()
      assert.deepEqual(events(), [])
      assert.equal(logText().match(/^REMINDER-SKIP /gm)?.length, 1, logText())
      // 한 번 닫힌 질문은 다시 판정하지 않는다
      assert.equal(viewed(), 1)
    })

    for (const [name, workers, state, head] of [
      ['dispatch 가 살아 있다', settled('running'), 'MERGED', SHA],
      ['PR 이 열려 있다', settled('completed'), 'OPEN', SHA],
      ['번호만 같은 다른 PR 이다', settled('completed'), 'MERGED', 'b'.repeat(40)],
    ] as const) {
      test(`${name}: 재알림한다`, () => {
        orca({ messages: [question()], statuses: [ready], workers })
        pr(state, head)
        remindLater()
        once()
        assert.deepEqual(events().map((e) => e.kind), ['REMINDER'])
        assert.doesNotMatch(logText(), /REMINDER-SKIP/)
      })
    }

    test('준비 상태가 없으면 재알림한다', () => {
      orca({ messages: [question()], statuses: [], workers: settled('completed') })
      pr('MERGED')
      remindLater()
      once()
      assert.deepEqual(events().map((e) => e.kind), ['REMINDER'])
    })
  })

  test('처음 보는 미답변 질문은 loop.log 에 QUESTION 줄이고 알림 파일에는 쓰지 않는다', () => {
    orca({ messages: [question()] })
    once()
    assert.match(logText(), /^QUESTION q question from=dispatch:d: 질문$/m)
    assert.deepEqual(events(), [])
  })

  test('조회 실패는 WATCH-ERROR 한 줄이고 같은 이유는 다시 쓰지 않으며, 한 번 성공한 뒤 실패하면 다시 쓴다', () => {
    board()
    orca({ fail: true })
    once()
    // 멈춤 확인의 worker 목록 조회도 같은 orca 로 실패해 stalls 를 따로 알린다. 여기서는 질문 확인만 본다
    const notStalls = () => events().filter((line) => !String(line.text).startsWith('stalls: '))
    const first = notStalls()
    assert.equal(first.length, 1, JSON.stringify(first))
    assert.equal(first[0].kind, 'WATCH-ERROR')
    assert.match(String(first[0].text), /^questions: .*offline/)
    // 정리와 보드 동기화는 그래도 불린다
    assert.equal(argsOf('sweep').length, 1)
    assert.equal(argsOf('board').length, 1)
    once()
    assert.equal(notStalls().length, 1, '같은 실패를 다시 알렸다')
    // loop.log 에는 실패할 때마다 쓴다
    assert.equal(logText().match(/^WATCH-ERROR questions: /gm)?.length, 2, logText())
    orca({})
    once()
    assert.equal(loopState()?.errors && (loopState()?.errors as Json)['questions@r'], null)
    orca({ fail: true })
    once()
    assert.equal(notStalls().length, 2, JSON.stringify(events()))
  })
})

describe('자리 보유 확인', () => {
  function slot(pid: number, heldAt: number, command: string): string {
    const dir = join(tmp, 'slots')
    write(join(dir, `${pid}.json`), JSON.stringify({ pid, ticket: 1, exclusive: false, held: true, slots: 3, held_at: heldAt, command }))
    return dir
  }

  test('상한을 넘겨 자리를 쥔 검사를 HEAVY-SLOT-HELD 한 줄로 알리고, 같은 검사가 계속 쥐어도 다시 쓰지 않는다', () => {
    const dir = slot(process.pid, Date.now() - 45 * 60_000, 'pnpm test:all')
    once({ HEAVY_SLOT_DIR: dir })
    const first = events().filter((line) => line.kind === 'HEAVY-SLOT-HELD')
    assert.equal(first.length, 1, JSON.stringify(events()))
    assert.match(String(first[0].text), new RegExp(`^pid ${process.pid} 4[5-6]분 pnpm test:all \\(상한 30분\\)$`))
    once({ HEAVY_SLOT_DIR: dir })
    assert.equal(events().filter((line) => line.kind === 'HEAVY-SLOT-HELD').length, 1, '같은 검사를 다시 알렸다')
  })

  test('상한 안의 자리는 알리지 않고, HEAVY_HOLD_MAX 로 상한을 줄이면 알린다', () => {
    const dir = slot(process.pid, Date.now() - 5 * 60_000, 'pnpm build')
    once({ HEAVY_SLOT_DIR: dir })
    assert.deepEqual(events().filter((line) => line.kind === 'HEAVY-SLOT-HELD'), [])
    once({ HEAVY_SLOT_DIR: dir, HEAVY_HOLD_MAX: '60' })
    const held = events().filter((line) => line.kind === 'HEAVY-SLOT-HELD')
    assert.equal(held.length, 1, JSON.stringify(events()))
    assert.match(String(held[0].text), /\(상한 1분\)$/)
  })

  test('자리를 내놓은 뒤 다시 오래 쥐면 다시 알린다', () => {
    const dir = slot(process.pid, Date.now() - 45 * 60_000, 'first')
    once({ HEAVY_SLOT_DIR: dir })
    rmSync(join(dir, `${process.pid}.json`))
    once({ HEAVY_SLOT_DIR: dir })
    slot(process.pid, Date.now() - 40 * 60_000, 'second')
    once({ HEAVY_SLOT_DIR: dir })
    assert.deepEqual(
      events().filter((line) => line.kind === 'HEAVY-SLOT-HELD').map((line) => String(line.text).split(' ').slice(3, 4)[0]),
      ['first', 'second'],
    )
  })
})

describe('tick 이벤트', () => {
  test('핸들러가 두 번 1 로 끝나면 HOOK-FAIL tick 1 은 한 줄이다', () => {
    hook('tick')
    once({ HOOK_CODE_tick: '1' })
    once({ HOOK_CODE_tick: '1' })
    const lines = events()
    assert.deepEqual(
      lines.map((line) => [line.kind, line.text]),
      [['HOOK-FAIL', 'tick 1']],
    )
    assert.equal(received('tick').length, 2)
  })

  test('입력은 틱 번호와 내 열린 PR 번호이고, gh 가 실패하면 open_prs 는 null 이다', () => {
    hook('tick')
    prs([MINE, THEIRS])
    once()
    const [input] = received('tick')
    assert.equal(input.event, 'tick')
    assert.equal(input.tick, 1)
    assert.deepEqual(input.open_prs, [1])
    const list = gh.calls().find((call) => call.argv.includes('list'))?.argv ?? []
    // CI 감시가 같은 조회를 함께 쓰므로 그 필드도 한 번에 읽는다
    assert.deepEqual(
      list.slice(list.indexOf('--json')),
      ['--json', 'number,author,url,title,headRefName,headRefOid,isDraft,baseRefName,statusCheckRollup'],
      JSON.stringify(list),
    )
    prs([], 1)
    once()
    assert.equal(received('tick')[1].open_prs, null)
    assert.ok(events().some((line) => line.kind === 'WATCH-ERROR' && String(line.text).startsWith('prs: ')), JSON.stringify(events()))
  })

  test('--tick --tick-number 5 는 마지막 줄에 결과 JSON 을 내고 loop.json 을 바꾸지 않는다', () => {
    hook('tick')
    prs([MINE])
    const before = JSON.stringify({ pid: 1, run: 'r', errors: { questions: null } })
    write(orchFile('state', 'loop.json'), before)
    const r = loop(['--run', 'r', '--tick', '--tick-number', '5'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const last = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Json
    // 열린 PR 을 읽은 틱은 CI 감시의 ci 도, 멈춤 확인을 마친 틱은 stalls 도 낸다
    assert.deepEqual(Object.keys(last).sort(), ['ci', 'errors', 'open_prs', 'stalls', 'tick_at'])
    assert.ok(!Number.isNaN(Date.parse(String(last.tick_at))), String(last.tick_at))
    assert.deepEqual(last.open_prs, [1])
    assert.equal(received('tick')[0].tick, 5)
    assert.equal(readFileSync(orchFile('state', 'loop.json'), 'utf8'), before)
    assert.equal(logText(), '', '틱 자식이 loop.log 에 썼다')
  })
})

describe('정리와 보드 동기화', () => {
  test('finish.run, finish.specs_dir 를 정리에 넘기고 다른 finish 키가 있어도 돈다. loop.json 에 last_tick, alive_at 을 쓴다', () => {
    config({ finish: { run: 'run_cfg', specs_dir: 'specs/here', deploy_workflow: 'deploy.yml' } })
    once({}, [])
    assert.deepEqual(argsOf('sweep'), [['--repo', repo, '--kill-holders', '--remote-branches', '--apply', '--run', 'run_cfg', '--specs-dir', 'specs/here']])
    const state = loopState() ?? {}
    assert.equal(state.run, 'run_cfg')
    assert.equal(state.ticks, 1)
    assert.ok(!Number.isNaN(Date.parse(String(state.last_tick))), String(state.last_tick))
    assert.ok(!Number.isNaN(Date.parse(String(state.alive_at))), String(state.alive_at))
    assert.equal(state.pid !== process.pid && !pidAlive(Number(state.pid)), true, '--once 가 끝난 뒤에도 루프가 살아 있다')
    assert.ok(!existsSync(orchFile('state', 'loop.lock')), '잠금을 풀지 않았다')
  })

  test('Run id 가 없으면 경고 한 줄을 내고 질문을 확인하지 않으며 정리에 --run 을 넘기지 않는다', () => {
    const r = once({}, [])
    assert.equal(r.stdout.match(/^경고: Run id 가 없어 질문 확인을 건너뛴다/gm)?.length, 1, r.stdout)
    // run-current 는 명의를 적으려는 호출이다(머리 주석의 「명의」). 질문 조회는 없다
    assert.deepEqual(jsonl(join(tmp, 'orca-calls.jsonl')).filter((argv) => (argv as unknown as string[])[1] !== 'run-current'), [])
    assert.equal(loopState()?.run, null)
    assert.ok(!argsOf('sweep')[0].includes('--run'), JSON.stringify(argsOf('sweep')))
  })

  test('보드 파일이 없으면 보드 동기화를 부르지 않는다', () => {
    once()
    assert.deepEqual(argsOf('board'), [])
    board()
    once()
    assert.deepEqual(argsOf('board'), [['--repo', repo, '--open-prs', '[]']])
  })

  test('정리 명령이 실패하면 WATCH-ERROR cleanup 이다', () => {
    fake('sweep', { code: 2 })
    once()
    assert.deepEqual(
      events().map((line) => line.text),
      ['cleanup: 종료 코드 2'],
    )
    assert.equal((loopState()?.errors as Json)['cleanup@r'], '종료 코드 2')
  })
})

describe('생존 타이머', () => {
  test('정리가 도는 동안에도 alive_at 이 바뀌고 last_tick 은 그대로다', async () => {
    fake('sweep', { sleep: 1.5 })
    const { code, samples } = await sampled(['--run', 'r', '--foreground', '--once'], { ORCH_LOOP_ALIVE_SEC: '0.2' })
    assert.equal(code, 0)
    const during = samples.filter((state) => state.last_tick === null)
    const distinct = new Set(during.map((state) => state.alive_at))
    // 처음 쓴 값과 그 뒤 두 번 이상 바뀐 값
    assert.ok(distinct.size >= 3, JSON.stringify([...distinct]))
  })

  test('틱 자식 안의 동기 조회가 막혀도 부모가 alive_at 을 쓴다', async () => {
    orca({ sleep: 2 })
    const { code, samples } = await sampled(['--run', 'r', '--foreground', '--once'], { ORCH_LOOP_ALIVE_SEC: '0.2' })
    assert.equal(code, 0)
    const distinct = new Set(samples.filter((state) => state.last_tick === null).map((state) => state.alive_at))
    assert.ok(distinct.size >= 3, JSON.stringify([...distinct]))
  })
})

describe('틱 자식의 실패', () => {
  test('결과 줄 없이 3 으로 끝나면 errors.tick 과 WATCH-ERROR tick 한 줄이고 다음 틱은 그대로 돈다', async () => {
    config({ pipeline: { tick_sec: 0.2 } })
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--run', 'r', '--foreground'], {
      env: { ...env, NODE_OPTIONS: `--import=${join(binDir, 'preload.mjs')}`, TICK_FAIL_UNTIL: '2' },
      cwd: tmp,
    })
    spawned.push(child)
    const closed = new Promise((resolve) => child.on('close', resolve))
    const seen: Json[] = []
    const deadline = Date.now() + 40_000
    for (;;) {
      const state = loopState()
      if (state && Number(state.ticks) >= 1 && seen.length === 0) seen.push(state)
      if (state && Number(state.ticks) >= 3) {
        seen.push(state)
        break
      }
      assert.ok(Date.now() < deadline, `틱이 세 번 돌지 않았다: ${JSON.stringify(state)}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    child.kill('SIGTERM')
    await closed
    const [first, third] = seen
    assert.equal((first.errors as Json)['tick@r'], '종료 코드 3')
    assert.equal(first.last_tick, null)
    // 같은 이유로 두 번 끝났지만 알림은 한 줄이다
    assert.deepEqual(
      events().map((line) => line.text),
      ['tick: 종료 코드 3'],
    )
    // 세 번째 틱은 성공했다
    assert.equal((third.errors as Json)['tick@r'], null)
    assert.ok(!Number.isNaN(Date.parse(String(third.last_tick))), String(third.last_tick))
    assert.match(logText(), /^결과 없이 끝난다$/m)
    assert.equal(pidAlive(child.pid as number), false)
  })
})

describe('신호', () => {
  test('정리 가짜가 TERM 을 무시하고 오래 잘 때 부모에 TERM 을 보내면, 부모가 끝난 뒤 틱 자식과 정리 가짜가 남지 않는다', { timeout: 60_000 }, async (t) => {
    const pidFile = join(tmp, 'sweep.pid')
    fake('sweep', { sleep: 60, ignore_term: true, pid_file: pidFile })
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--run', 'r', '--foreground', '--once'], { env, cwd: tmp })
    spawned.push(child)
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    const deadline = Date.now() + 20_000
    while (!(existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'))) {
      assert.ok(Date.now() < deadline, '정리 가짜가 뜨지 않았다')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // 정리 가짜의 부모가 틱 자식이다
    const [sweepPid, tickPid] = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number)
    // 실패해도 남기지 않는다
    t.after(() => {
      for (const pid of [sweepPid, tickPid]) if (pidAlive(pid)) process.kill(pid, 'SIGKILL')
    })
    assert.notEqual(tickPid, child.pid)
    child.kill('SIGTERM')
    assert.equal(await closed, 143)
    // 끝난 프로세스를 init 이 거둘 시간만 준다
    const until = Date.now() + 1_000
    while ((pidAlive(sweepPid) || pidAlive(tickPid)) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(pidAlive(tickPid), false, `틱 자식(pid ${tickPid})이 남았다`)
    assert.equal(pidAlive(sweepPid), false, `정리 가짜(pid ${sweepPid})가 남았다`)
  })

  test('부모를 KILL 하면 틱 자식이 스스로 정리 가짜를 끝내고 끝난다', { timeout: 60_000 }, async (t) => {
    const pidFile = join(tmp, 'sweep.pid')
    // TERM 을 무시하므로 틱 자식이 유예 뒤 KILL 까지 보내야 끝난다
    fake('sweep', { sleep: 60, ignore_term: true, pid_file: pidFile })
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--run', 'r', '--foreground', '--once'], { env, cwd: tmp })
    spawned.push(child)
    const closed = new Promise((resolve) => child.on('close', resolve))
    const deadline = Date.now() + 20_000
    while (!(existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'))) {
      assert.ok(Date.now() < deadline, '정리 가짜가 뜨지 않았다')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const [sweepPid, tickPid] = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number)
    t.after(() => {
      for (const pid of [sweepPid, tickPid]) if (pidAlive(pid)) process.kill(pid, 'SIGKILL')
    })
    // KILL 은 처리기를 거치지 않아 부모가 틱 자식에 신호를 전하지 못한다
    child.kill('SIGKILL')
    await closed
    // 부모 확인 간격 2초와 TERM 뒤 KILL 까지의 유예 2초에 여유를 더한다
    await waitDead([sweepPid, tickPid], 10_000)
    assert.equal(pidAlive(tickPid), false, `틱 자식(pid ${tickPid})이 남았다`)
    assert.equal(pidAlive(sweepPid), false, `정리 가짜(pid ${sweepPid})가 남았다`)
  })
})

describe('--start, --status, --stop', () => {
  test('띄우고, 다른 Run 을 더하고, 자기 Run 만 빼고, 마지막 Run 이 빠지면 멈춘다', async () => {
    config({ pipeline: { tick_sec: 3600 } })
    const started = loop(['--run', 'r1', '--start'])
    assert.equal(started.code, 0, started.stdout + started.stderr)
    const match = /^LOOP-STARTED (\d+) run=r1$/m.exec(started.stdout)
    assert.ok(match, started.stdout)
    const pid = Number(match[1])
    assert.equal(pidAlive(pid), true)
    const status = loop(['--status'])
    assert.equal(status.code, 0, status.stdout + status.stderr)
    assert.match(status.stdout, new RegExp(`^LOOP-ALIVE ${pid} run=r1 last_tick=\\S+ alive_at=\\S+$`, 'm'))
    const same = loop(['--run', 'r1', '--start'])
    assert.equal(same.code, 4, same.stdout + same.stderr)
    assert.equal(same.stdout.trim(), `LOOP-RUNNING ${pid} run=r1`)
    const joined = loop(['--run', 'r2', '--start'])
    assert.equal(joined.code, 0, joined.stdout + joined.stderr)
    assert.equal(joined.stdout.trim(), `LOOP-JOINED ${pid} run=r2`)
    assert.ok(existsSync(orchFile('state', 'loop-runs', 'r2.json')))
    const shared = loop(['--stop'])
    assert.equal(shared.code, 1, shared.stdout + shared.stderr)
    assert.match(shared.stdout, new RegExp(`^LOOP-STOP-SHARED ${pid} runs=r1,r2$`, 'm'))
    assert.equal(pidAlive(pid), true)
    const left = loop(['--run', 'r1', '--stop'])
    assert.equal(left.code, 0, left.stdout + left.stderr)
    assert.equal(left.stdout.trim(), `LOOP-LEFT ${pid} run=r1 runs=r2`)
    assert.equal(pidAlive(pid), true)
    const stopped = loop(['--run', 'r2', '--stop'])
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr)
    assert.equal(stopped.stdout.trim(), `LOOP-STOPPED ${pid}`)
    assert.equal(pidAlive(pid), false)
    assert.ok(!existsSync(orchFile('state', 'loop.lock')), '잠금을 풀지 않았다')
    assert.ok(!existsSync(orchFile('state', 'loop-runs', 'r2.json')))
    const dead = loop(['--status'])
    assert.equal(dead.code, 1)
    assert.equal(dead.stdout.trim(), `LOOP-DEAD ${repo} pid ${pid} 종료`)
    assert.equal(loop(['--stop']).stdout.trim(), 'LOOP-NOT-RUNNING')
  })

  test('부른 터미널이 다른 Run 에 묶였으면 띄우지도 등록하지도 않고 LOOP-START-FENCED 와 5 다', () => {
    config({ pipeline: { tick_sec: 3600 } })
    orca({ bound: 'X' })
    const fenced = loop(['--run', 'r1', '--start'])
    assert.equal(fenced.code, 5, fenced.stdout + fenced.stderr)
    assert.match(fenced.stdout, /^LOOP-START-FENCED r1 X$/m)
    assert.match(fenced.stdout, /^안내: 이 터미널은 Run X 에 묶여 Run r1 의 질문을 읽지 못한다/m)
    assert.equal(loopState(), null)
    assert.equal(existsSync(orchFile('state', 'loop-runs', 'r1.json')), false)
  })

  test('그 Run 에 묶인 터미널이 띄운 루프는 bound_run 을 적고, 다른 Run 은 합류하지 못한다', async () => {
    config({ pipeline: { tick_sec: 3600 } })
    orca({ bound: 'r1' })
    const started = loop(['--run', 'r1', '--start'])
    assert.equal(started.code, 0, started.stdout + started.stderr)
    const pid = Number(/^LOOP-STARTED (\d+) run=r1$/m.exec(started.stdout)?.[1])
    assert.equal(loopState()?.bound_run, 'r1')
    // 부른 쪽은 묶이지 않았지만 루프는 r1 에 묶였다
    orca({})
    const joined = loop(['--run', 'r2', '--start'])
    assert.equal(joined.code, 5, joined.stdout + joined.stderr)
    assert.match(joined.stdout, /^LOOP-START-FENCED r2 r1$/m)
    assert.match(joined.stdout, new RegExp(`^안내: 도는 루프\\(pid ${pid}\\)는 Run r1 에 묶여 Run r2 의 질문을 읽지 못한다`, 'm'))
    assert.equal(existsSync(orchFile('state', 'loop-runs', 'r2.json')), false)
    assert.equal(loop(['--run', 'r1', '--stop']).code, 0)
  })

  test('명의 조회가 시작 대기(10초)보다 느려도 띄운 루프는 다시 조회하지 않고 시작한다', { timeout: 60_000 }, () => {
    config({ pipeline: { tick_sec: 3600 } })
    orca({ bound: 'r1', slow_run_current: 11 })
    const started = loop(['--run', 'r1', '--start'])
    assert.equal(started.code, 0, started.stdout + started.stderr)
    assert.match(started.stdout, /^LOOP-STARTED \d+ run=r1$/m)
    assert.equal(loopState()?.bound_run, 'r1')
    // run-current 는 --start 가 한 번만 불렀다
    assert.equal(jsonl(join(tmp, 'orca-calls.jsonl')).filter((argv) => (argv as unknown as string[])[1] === 'run-current').length, 1)
    assert.equal(loop(['--run', 'r1', '--stop']).code, 0)
  })

  test('묶이지 않은 루프는 bound_run 이 null 이고 다른 Run 의 합류를 받는다', async () => {
    config({ pipeline: { tick_sec: 3600 } })
    const started = loop(['--run', 'r1', '--start'])
    assert.equal(started.code, 0, started.stdout + started.stderr)
    assert.equal(loopState()?.bound_run, null)
    const joined = loop(['--run', 'r2', '--start'])
    assert.equal(joined.code, 0, joined.stdout + joined.stderr)
    assert.match(joined.stdout, /^LOOP-JOINED \d+ run=r2$/m)
    assert.equal(loop(['--stop', '--all']).code, 0)
  })

  test('bound_run 이 없는 루프(명의를 모른다)에는 합류하지 않고 unknown 으로 알린다', async (t) => {
    const pid = await fakeLoop(t)
    const now = new Date().toISOString()
    write(orchFile('state', 'loop.json'), JSON.stringify({ pid, run: 'r1', runs: ['r1'], repo, tick_sec: 300, started_at: now, alive_at: now, last_tick: null, ticks: 0, errors: {} }))
    write(orchFile('state', 'loop-runs', 'r1.json'), JSON.stringify({ run: 'r1', specs_dir: null, registered_at: now }))
    const joined = loop(['--run', 'r2', '--start'])
    assert.equal(joined.code, 5, joined.stdout + joined.stderr)
    assert.match(joined.stdout, /^LOOP-START-FENCED r2 unknown$/m)
    assert.match(joined.stdout, /명의를 알 수 없어/)
    assert.equal(existsSync(orchFile('state', 'loop-runs', 'r2.json')), false)
    // 이미 등록된 Run 은 판정 없이 전처럼 LOOP-RUNNING 이다
    const same = loop(['--run', 'r1', '--start'])
    assert.equal(same.code, 4, same.stdout + same.stderr)
  })

  test('--stop --all 은 등록된 Run 을 모두 빼고 멈춘다. --all 과 --run 을 함께 주면 2 다', async () => {
    config({ pipeline: { tick_sec: 3600 } })
    const started = loop(['--run', 'r1', '--start'])
    const pid = Number(/^LOOP-STARTED (\d+)/m.exec(started.stdout)?.[1])
    assert.equal(loop(['--run', 'r2', '--start']).code, 0)
    assert.equal(loop(['--run', 'r1', '--stop', '--all']).code, 2)
    const stopped = loop(['--stop', '--all'])
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr)
    assert.equal(stopped.stdout.trim(), `LOOP-STOPPED ${pid}`)
    assert.equal(pidAlive(pid), false)
    assert.equal(existsSync(orchFile('state', 'loop-runs', 'r1.json')), false)
  })

  test('막 뜨는 루프에 이미 등록된 Run 이 합류하면 registered_at 을 새로 쓰고, 다 뜬 루프면 그대로 둔다', async (t) => {
    const pid = await fakeLoop(t)
    const old = '2026-01-01T00:00:00.000Z'
    const runFile = orchFile('state', 'loop-runs', 'r1.json')
    const registeredAt = () => String((JSON.parse(readFileSync(runFile, 'utf8')) as Json).registered_at)
    // 잠금은 그 루프가 쥐었는데 loop.json 은 아직 그 루프의 것이 아니다. 뜨는 루프가 앞 루프의 alive_at 이전 등록을 지우는 때다
    write(orchFile('state', 'loop.lock'), String(pid))
    write(runFile, JSON.stringify({ run: 'r1', specs_dir: null, registered_at: old }))
    const starting = loop(['--run', 'r1', '--start'])
    assert.equal(starting.code, 4, starting.stdout + starting.stderr)
    assert.equal(starting.stdout.trim(), `LOOP-RUNNING ${pid} run=r1`)
    assert.ok(Date.parse(registeredAt()) > Date.parse(old), registeredAt())
    const now = new Date().toISOString()
    write(orchFile('state', 'loop.json'), JSON.stringify({ pid, run: 'r1', runs: ['r1'], repo, tick_sec: 300, started_at: now, alive_at: now, last_tick: null, ticks: 0, errors: {} }))
    write(runFile, JSON.stringify({ run: 'r1', specs_dir: null, registered_at: old }))
    assert.equal(loop(['--run', 'r1', '--start']).code, 4)
    assert.equal(registeredAt(), old)
  })

  test('--stop --run 은 다 읽은 알림 파일과 커서를 지우고, 읽지 않은 줄이 있으면 남긴다', () => {
    const at = '2026-01-01T00:00:00.000Z'
    for (const run of ['r1', 'r2']) write(orchFile('state', 'loop-runs', `${run}.json`), JSON.stringify({ run, specs_dir: null, registered_at: at }))
    const row = `${JSON.stringify({ seq: 1, time: at, kind: 'REMINDER', pr: null, text: 'q' })}\n`
    write(orchFile('state', 'loop-events', 'r1.jsonl'), row)
    write(orchFile('state', 'loop-events', 'r1.cursor'), '1\n')
    write(orchFile('state', 'loop-events', 'r2.jsonl'), row)
    const left = loop(['--run', 'r1', '--stop'])
    assert.equal(left.code, 0, left.stdout + left.stderr)
    assert.equal(left.stdout.trim(), 'LOOP-LEFT - run=r1 runs=r2')
    assert.equal(existsSync(orchFile('state', 'loop-events', 'r1.jsonl')), false)
    assert.equal(existsSync(orchFile('state', 'loop-events', 'r1.cursor')), false)
    const stopped = loop(['--run', 'r2', '--stop'])
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr)
    assert.equal(stopped.stdout.trim(), 'LOOP-NOT-RUNNING')
    assert.equal(readFileSync(orchFile('state', 'loop-events', 'r2.jsonl'), 'utf8'), row)
  })

  test('Run 등록을 모르는 옛 루프에는 Run 을 더하지 않고 안내 줄을 내며, 다른 Run 의 --stop --run 은 그 루프를 멈추지 않는다', async (t) => {
    const pid = await fakeLoop(t)
    const now = new Date().toISOString()
    write(orchFile('state', 'loop.json'), JSON.stringify({ pid, run: 'r1', repo, tick_sec: 300, started_at: now, alive_at: now, last_tick: null, ticks: 0, errors: {} }))
    const again = loop(['--run', 'r2', '--start'])
    assert.equal(again.code, 4, again.stdout + again.stderr)
    assert.match(again.stdout, new RegExp(`^LOOP-RUNNING ${pid} run=r1$`, 'm'))
    assert.match(again.stdout, /^안내: 이 루프는 Run 등록을 모르는 옛 orch 로 띄운 루프다/m)
    assert.equal(existsSync(orchFile('state', 'loop-runs', 'r2.json')), false)
    const stop = loop(['--run', 'r2', '--stop'])
    assert.equal(stop.code, 0, stop.stdout + stop.stderr)
    assert.match(stop.stdout, /^LOOP-NOT-REGISTERED run=r2$/m)
    assert.equal(pidAlive(pid), true)
  })

  test('마지막 Run 의 등록이 사라지면 다음 틱 전에 LOOP-EMPTY 로 끝난다', { timeout: 60_000 }, async () => {
    config({ pipeline: { tick_sec: 1 } })
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--run', 'r1', '--foreground'], { env, cwd: tmp })
    spawned.push(child)
    let stdout = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    const exited = new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)))
    const deadline = Date.now() + 20_000
    while (!/^tick 1 /m.test(stdout) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    rmSync(orchFile('state', 'loop-runs', 'r1.json'))
    const code = await exited
    assert.equal(code, 0, stdout)
    assert.match(stdout, /^LOOP-EMPTY /m)
  })

  test('살아 있는 루프의 잠금이 있으면 --foreground 도 4 다', async (t) => {
    const pid = await fakeLoop(t)
    write(orchFile('state', 'loop.lock'), String(pid))
    const r = loop(['--run', 'r', '--foreground', '--once'])
    assert.equal(r.code, 4, r.stdout + r.stderr)
    assert.equal(r.stdout.trim(), `LOOP-RUNNING ${pid} run=-`)
    assert.equal(argsOf('sweep').length, 0)
  })

  test('잠금의 pid 가 살아 있어도 루프 프로세스가 아니면 회수하고 돈다', async () => {
    // 죽은 루프의 pid 를 다른 프로세스가 받은 경우다. sleep 의 명령줄에는 orch-loop 가 없다
    const other = await otherProcess()
    write(orchFile('state', 'loop.lock'), String(other))
    const r = once()
    assert.doesNotMatch(r.stdout, /LOOP-RUNNING/)
    assert.equal(argsOf('sweep').length, 1)
    assert.ok(!existsSync(orchFile('state', 'loop.lock')), '잠금을 풀지 않았다')
    // 다른 프로세스에는 손대지 않는다
    assert.equal(pidAlive(other), true)
  })

  test('잠금의 pid 가 살아 있고 ps 가 실패하면 판정할 수 없어 회수하지 않고 4 다', async () => {
    // ps 가 성공하면 위 테스트처럼 회수되는 프로세스다
    const other = await otherProcess()
    write(orchFile('state', 'loop.lock'), String(other))
    const r = loop(['--run', 'r', '--foreground', '--once'], failingPs())
    assert.equal(r.code, 4, r.stdout + r.stderr)
    assert.equal(r.stdout.trim(), `LOOP-RUNNING ${other} run=-`)
    assert.equal(argsOf('sweep').length, 0)
    assert.equal(readFileSync(orchFile('state', 'loop.lock'), 'utf8'), String(other), '잠금을 회수했다')
  })

  test('loop.json 의 pid 가 살아 있고 ps 가 실패하면 --stop 은 신호를 보내지 않고 1 이다', async () => {
    const other = await otherProcess()
    write(orchFile('state', 'loop.json'), JSON.stringify({ pid: other, run: 'r' }))
    const r = loop(['--stop'], failingPs())
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout.trim(), new RegExp(`^LOOP-STOP-UNKNOWN ${other} `))
    assert.equal(pidAlive(other), true, '판정하지 못한 프로세스에 신호를 보냈다')
  })

  test('죽은 pid 의 잠금은 회수하고 돈다', () => {
    const done = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    write(orchFile('state', 'loop.lock'), done.stdout)
    once()
    assert.equal(argsOf('sweep').length, 1)
    assert.ok(!existsSync(orchFile('state', 'loop.lock')))
  })
})

describe('여러 Run', () => {
  // 루프에 Run 을 등록한다. registered_at 이 이른 Run 이 주 Run 이다
  function register(run: string, at: string, specsDir: string | null = null): void {
    write(orchFile('state', 'loop-runs', `${run}.json`), JSON.stringify({ run, specs_dir: specsDir, registered_at: at }))
  }

  function runEvents(run: string): Json[] {
    return jsonl(orchFile('state', 'loop-events', `${run}.jsonl`))
  }

  // 틱 자식을 바로 돌린다. 새로 뜬 루프(--foreground)는 앞 루프의 등록을 지우므로, 등록된 Run 을 맡는 틱은 자식으로 본다
  function tickOnce(): Json {
    const r = loop(['--tick', '--tick-number', '1'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    return JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Json
  }

  test('질문, 정리, tick 은 Run 마다 그 Run 범위로 돌고 원격 브랜치 정리는 주 Run 에서만 한다', () => {
    register('A', '2026-01-01T00:00:00Z', 'specs/a')
    register('B', '2026-01-02T00:00:00Z')
    hook('tick')
    hook('worker-question')
    const asked = (run: string) => ({ ...question(`q${run}`), run_id: run, to_handle: `run:${run}` })
    orca({ by_run: { A: [asked('A')], B: [asked('B')] } })
    write(orchFile('state', 'questions-seen.json'), JSON.stringify({ A: { qA: Date.now() / 1000 - 700 }, B: { qB: Date.now() / 1000 - 700 } }))
    tickOnce()
    assert.deepEqual(argsOf('sweep'), [
      ['--repo', repo, '--kill-holders', '--remote-branches', '--apply', '--run', 'A', '--specs-dir', 'specs/a'],
      ['--repo', repo, '--kill-holders', '--apply', '--run', 'B'],
    ])
    const ticks = received('tick').map((input) => [input.run, input.primary])
    assert.deepEqual(ticks, [
      ['A', true],
      ['B', false],
    ])
    assert.deepEqual(runEvents('A').map((row) => [row.kind, String(row.text).split(' ')[0]]), [['REMINDER', 'qA']])
    assert.deepEqual(runEvents('B').map((row) => [row.kind, String(row.text).split(' ')[0]]), [['REMINDER', 'qB']])
    assert.equal(existsSync(orchFile('state', 'loop-events.jsonl')), false)
  })

  test('공유 일의 실패는 주 Run 에만, Run 의 질문 조회 실패는 그 Run 에만 알린다', () => {
    register('A', '2026-01-01T00:00:00Z')
    register('B', '2026-01-02T00:00:00Z')
    orca({ fail: true })
    prs([], 1)
    const result = tickOnce()
    const kinds = (run: string) => runEvents(run).map((row) => String(row.text).split(':')[0])
    // 같은 틱에 질문 확인도 실패한 Run 의 멈춤 확인 실패는 로그에만 쓴다. Orca 가 꺼진 틱에 같은 원인으로 두 번 깨우지 않는다
    assert.deepEqual(kinds('A').sort(), ['prs', 'questions'])
    assert.deepEqual(kinds('B').sort(), ['questions'])
    const errors = result.errors as Json
    assert.equal(typeof errors['questions@A'], 'string')
    assert.equal(typeof errors['questions@B'], 'string')
    assert.deepEqual([errors['stalls@A'], errors['stalls@B']], [null, null])
  })

  test('주 Run 이 바뀌면 진행 중인 공유 일의 실패가 새 주 Run 에 한 번 간다', () => {
    register('A', '2026-01-01T00:00:00Z')
    register('B', '2026-01-02T00:00:00Z')
    prs([], 1)
    const sharedTexts = (run: string) => runEvents(run).map((row) => String(row.text)).filter((text) => text.startsWith('prs:'))
    // 틱 자식은 loop.json 의 errors 를 이전 값으로 읽는다. 부모가 하듯 결과의 errors 를 옮겨 둔다
    const carry = (result: Json) => write(orchFile('state', 'loop.json'), JSON.stringify({ pid: 999999, errors: result.errors }))
    carry(tickOnce())
    assert.equal(sharedTexts('A').length, 1)
    assert.equal(sharedTexts('B').length, 0)
    rmSync(orchFile('state', 'loop-runs', 'A.json'))
    carry(tickOnce())
    carry(tickOnce())
    assert.equal(sharedTexts('B').length, 1)
    assert.equal(sharedTexts('A').length, 1)
  })

  test('새로 뜬 루프는 앞 루프의 alive_at 까지 쓴 다른 Run 의 등록을 지우고, 그 뒤에 쓴 등록은 남긴다', () => {
    write(orchFile('state', 'loop.json'), JSON.stringify({ pid: 999999, run: 'old', runs: ['old'], alive_at: '2026-01-02T00:00:00Z' }))
    register('old', '2026-01-01T00:00:00Z')
    register('fresh', '2026-01-03T00:00:00Z')
    const r = once({}, ['--run', 'r'])
    assert.match(r.stdout, /^앞 루프의 Run old 등록을 지웠다/m)
    assert.equal(existsSync(orchFile('state', 'loop-runs', 'old.json')), false)
    assert.deepEqual((loopState() as Json).runs, ['fresh', 'r'])
  })

  test('앞 loop.json 이 없으면 다른 Run 의 등록을 지우지 않는다', () => {
    register('other', '2026-01-01T00:00:00Z')
    const r = once({}, ['--run', 'r'])
    assert.doesNotMatch(r.stdout, /등록을 지웠다/)
    assert.deepEqual((loopState() as Json).runs, ['other', 'r'])
  })

  test('죽은 루프 뒤 두 세션이 거의 동시에 --start 하면 둘 다 0 이고 한 루프가 두 Run 을 맡는다', { timeout: 60_000 }, async () => {
    config({ pipeline: { tick_sec: 3600 } })
    // 두 Run 모두 죽은 루프에 등록돼 있었다. 같은 LOOP-DEAD 로 깨어난 경우다
    write(orchFile('state', 'loop.json'), JSON.stringify({ pid: 999999, run: 'A', runs: ['A', 'B'], alive_at: new Date(Date.now() - 600_000).toISOString() }))
    register('A', '2026-01-01T00:00:00Z')
    register('B', '2026-01-02T00:00:00Z')
    for (const delay of [0, 50, 150]) {
      const run = (id: string) =>
        new Promise<Result>((resolve) => {
          const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--run', id, '--start'], { env, cwd: tmp })
          spawned.push(child)
          let stdout = ''
          child.stdout?.on('data', (chunk) => (stdout += String(chunk)))
          child.on('close', (code) => resolve({ code, stdout, stderr: '' }))
        })
      const a = run('A')
      await new Promise((resolve) => setTimeout(resolve, delay))
      const [ra, rb] = await Promise.all([a, run('B')])
      assert.equal(ra.code, 0, `delay ${delay}: ${ra.stdout}`)
      assert.equal(rb.code, 0, `delay ${delay}: ${rb.stdout}`)
      const pid = Number(loopState()?.pid)
      const lines = [ra.stdout.trim(), rb.stdout.trim()].sort()
      assert.match(lines.join('\n'), new RegExp(`^LOOP-(STARTED|JOINED) ${pid} run=[AB]\n(LOOP-JOINED|LOOP-STARTED) ${pid} run=[AB]$`), `delay ${delay}`)
      assert.ok(existsSync(orchFile('state', 'loop-runs', 'A.json')), `delay ${delay}: A 의 등록이 지워졌다`)
      assert.ok(existsSync(orchFile('state', 'loop-runs', 'B.json')), `delay ${delay}: B 의 등록이 지워졌다`)
      assert.equal(loop(['--stop', '--all']).code, 0)
      await waitDead([pid], 20_000)
      register('A', '2026-01-01T00:00:00Z')
      register('B', '2026-01-02T00:00:00Z')
      write(orchFile('state', 'loop.json'), JSON.stringify({ pid: 999999, run: 'A', runs: ['A', 'B'], alive_at: new Date(Date.now() - 600_000).toISOString() }))
    }
  })

  test('--run 도 finish.run 도 없는 --stop 은 등록된 Run 이 하나여도 멈추지 않고 LOOP-STOP-SHARED 와 1 이다', async () => {
    config({ pipeline: { tick_sec: 3600 } })
    const started = loop(['--run', 'B', '--start'])
    const pid = Number(/^LOOP-STARTED (\d+)/m.exec(started.stdout)?.[1])
    const r = loop(['--stop'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(`^LOOP-STOP-SHARED ${pid} runs=B$`, 'm'))
    assert.equal(pidAlive(pid), true)
    assert.ok(existsSync(orchFile('state', 'loop-runs', 'B.json')))
    assert.equal(loop(['--run', 'B', '--stop']).stdout.trim(), `LOOP-STOPPED ${pid}`)
  })

  test('--stop 은 --run 이 없으면 finish.run 의 Run 만 빼고, 등록되지 않은 Run 의 --stop --run 은 루프를 멈추지 않는다', async () => {
    config({ pipeline: { tick_sec: 3600 } })
    const started = loop(['--run', 'r1', '--start'])
    const pid = Number(/^LOOP-STARTED (\d+)/m.exec(started.stdout)?.[1])
    assert.equal(loop(['--run', 'r2', '--start']).code, 0)
    config({ pipeline: { tick_sec: 3600 }, finish: { run: 'r2' } })
    const left = loop(['--stop'])
    assert.equal(left.code, 0, left.stdout + left.stderr)
    assert.equal(left.stdout.trim(), `LOOP-LEFT ${pid} run=r2 runs=r1`)
    const stranger = loop(['--run', 'zz', '--stop'])
    assert.equal(stranger.stdout.trim(), 'LOOP-NOT-REGISTERED run=zz')
    assert.equal(pidAlive(pid), true)
    assert.equal(loop(['--run', 'r1', '--stop']).stdout.trim(), `LOOP-STOPPED ${pid}`)
  })
})

describe('사용법과 설정', () => {
  test('pipeline.tick_sec 이 0 이면 설정 오류로 2 다', () => {
    config({ pipeline: { tick_sec: 0 } })
    const r = loop(['--run', 'r', '--foreground', '--once'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /pipeline\.tick_sec/)
    assert.equal(loopState(), null)
  })

  test('모드가 없거나 둘이면 2 다', () => {
    assert.equal(loop([]).code, 2)
    assert.equal(loop(['--start', '--stop']).code, 2)
    assert.equal(loop(['--tick']).code, 2)
  })
})


test('decide 제목과 줄이 바뀔 때만 DECISION-PENDING 을 보내고 삭제 뒤 재생성도 알린다', () => {
  hook('decision-pending')
  const file = join(repo, '.omc', 'board.json')
  const save = (title = '방식 선택', next = '1. 방식 고르기') => write(file, JSON.stringify({ items: [{ id: 'choice', status: 'decide', title, next }] }))
  save()
  once()
  once()
  assert.equal(events().filter((e) => e.kind === 'DECISION-PENDING').length, 1)
  assert.equal(received('decision-pending').length, 1)
  save('보관 방식 선택')
  once()
  save('보관 방식 선택', '1. 보관 기간 고르기')
  once()
  assert.equal(events().filter((e) => e.kind === 'DECISION-PENDING').length, 3)
  board()
  once()
  save()
  once()
  assert.equal(events().filter((e) => e.kind === 'DECISION-PENDING').length, 4)
})

test('완료한 decide 줄만 있으면 REMINDER 와 DECISION-PENDING 을 만들지 않는다', () => {
  hook('decision-pending')
  write(join(repo, '.omc', 'board.json'), JSON.stringify({ items: [{
    id: 'done-choice', status: 'decide', title: '끝난 결정', details: [{ text: '선택 완료', done: true }], next: ['✓ 후속 작업 완료'],
  }] }))
  once()
  assert.deepEqual(events().filter((e) => e.kind === 'REMINDER' || e.kind === 'DECISION-PENDING'), [])
  assert.deepEqual(received('decision-pending'), [])
})
