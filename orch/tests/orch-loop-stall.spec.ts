// orch-loop.ts 의 멈춤 확인을 가짜 orca 와 가짜 화면으로 본다. Orca 와 GitHub 에는 닿지 않는다.
// 틱 자식(--tick)을 바로 돌리고, 부모가 하듯 결과의 stalls 와 errors 를 loop.json 에 옮겨 다음 틱으로 잇는다.
// 가짜 orca 는 orca.json 의 workers_by_run(Run 마다의 worker-list 행), screens(터미널마다의 화면 문자열),
// questions_by_run(Run 마다의 미답변 질문)으로 답하고 받은 인자를 orca-calls.jsonl 에 적는다. terminal send 에는 턴이 시작됐다고 답한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeBin } from './fixtures/fake-bin.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/orch-loop.ts', import.meta.url))
const HOOKS_DOC = fileURLToPath(new URL('../references/hooks.md', import.meta.url))

// 확장자 없는 실행 파일이라 타입 문법을 쓰지 않는다
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const dir = process.env.FAKE_DIR
const argv = process.argv.slice(2)
fs.appendFileSync(dir + '/orca-calls.jsonl', JSON.stringify(argv) + '\\n')
const st = JSON.parse(fs.readFileSync(dir + '/orca.json', 'utf8'))
const reply = (result) => process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n')
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null)
const sub = argv[1]
if (sub === 'worker-list') reply({ workers: (st.workers_by_run || {})[flag('--run')] || [], page: {} })
else if (sub === 'check') reply({ messages: (st.questions_by_run || {})[flag('--run')] || [] })
else if (sub === 'inbox') reply({ messages: [] })
else if (argv[0] === 'terminal' && sub === 'read') {
  const text = (st.screens || {})[flag('--terminal')]
  if (text === undefined) process.stdout.write(JSON.stringify({ ok: false, error: { code: 'terminal_not_found' } }) + '\\n')
  else reply({ terminal: { tail: text.split('\\n') } })
} else if (argv[0] === 'terminal' && sub === 'send') reply({ send: { prompt: { stages: ['turn_started'], requestId: 'r1' } } })
else reply({})
`

const CODEX_ERROR = (footer = 'Context 47% used') => `• 테스트를 고쳤다.
■ Selected model is at capacity. Please try a different model.
› Ask Codex to do anything
  ~/work/repo · user/branch · GPT-6.1-Sol medium · ${footer}
  ? for shortcuts`

// 코디네이터가 「계속 진행해」 로 이어 가게 했는데 같은 오류로 다시 끝난 화면이다
const CODEX_ERROR_AGAIN = `• 테스트를 고쳤다.
■ Selected model is at capacity. Please try a different model.
› 계속 진행해
■ Selected model is at capacity. Please try a different model.
› Ask Codex to do anything
  ~/work/repo · user/branch · GPT-6.1-Sol medium · Context 47% used
  ? for shortcuts`

const CODEX_INTERRUPTED = `• 파일을 고친다.
■ Conversation interrupted - use /feedback if something went wrong
› Ask Codex to do anything
  ? for shortcuts`

const CLAUDE_IDLE = `⏺ 백그라운드 에이전트를 기다린다.
───────────────────────────────
❯
───────────────────────────────
  ⏵⏵ bypass permissions on`

const CLAUDE_WORKING = `⏺ 검사를 다시 돌린다.
✳ Lollygagging… (3m 0s · esc to interrupt)
❯ `

type Json = Record<string, unknown>

let binDir: string
let tmp: string
let repo: string
let env: NodeJS.ProcessEnv

before(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'orch-loop-stall-bin-')))
  writeFileSync(join(binDir, 'orca'), FAKE_ORCA)
  chmodSync(join(binDir, 'orca'), 0o755)
  writeFileSync(join(binDir, 'sweep.ts'), 'process.exitCode = 0\n')
})
after(() => rmSync(binDir, { recursive: true, force: true }))

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-loop-stall-')))
  repo = join(tmp, 'repo')
  mkdirSync(join(tmp, 'received'), { recursive: true })
  mkdirSync(repo)
  const gh = fakeBin(tmp, 'gh', [
    { args: ['pr', 'list'], stdout: '[]\n' },
    { args: ['api', 'user'], stdout: 'me\n' },
  ])
  env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ORCA: join(binDir, 'orca'),
    GH: gh.path,
    CLEANUP_SWEEP: join(binDir, 'sweep.ts'),
    FAKE_DIR: tmp,
    RECEIVED_DIR: join(tmp, 'received'),
    GIT_CEILING_DIRECTORIES: tmp,
  }
  delete env.ORCH_DIR
  delete env.ORCH_REAL_ORCA
  delete env.NODE_OPTIONS
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']]) {
    const done = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env })
    assert.equal(done.status, 0, done.stderr)
  }
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function orchFile(...parts: string[]): string {
  return join(repo, '.orch', ...parts)
}

function register(run: string, at: string): void {
  write(orchFile('state', 'loop-runs', `${run}.json`), JSON.stringify({ run, specs_dir: null, registered_at: at }))
}

function worker(dispatch: string, terminal: string, status = 'running'): Json {
  return { taskId: `task_${dispatch}`, dispatchId: dispatch, dispatchStatus: status, agentTerminalHandle: terminal, resource: { worktreeId: `repo-id::/work/${dispatch}` } }
}

function orca(state: Json): void {
  writeFileSync(join(tmp, 'orca.json'), JSON.stringify(state))
}

function handler(event: string, code = 0): void {
  write(
    orchFile('hooks', `${event}.ts`),
    `import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync(process.env.RECEIVED_DIR + '/${event}.jsonl', readFileSync(0, 'utf8') + '\\n')
appendFileSync(process.env.RECEIVED_DIR + '/${event}.env.jsonl', JSON.stringify({ ORCH_SCRIPTS: process.env.ORCH_SCRIPTS ?? null }) + '\\n')
process.exitCode = ${code}
`,
  )
}

function jsonl(file: string): Json[] {
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Json)
    : []
}

function runEvents(run: string): Json[] {
  return jsonl(orchFile('state', 'loop-events', `${run}.jsonl`))
}

function stalledEvents(run: string): Json[] {
  return runEvents(run).filter((row) => row.kind === 'WORKER-STALLED')
}

function received(event: string): Json[] {
  return jsonl(join(tmp, 'received', `${event}.jsonl`))
}

function sends(): string[][] {
  return jsonl(join(tmp, 'orca-calls.jsonl'))
    .map((argv) => argv as unknown as string[])
    .filter((argv) => argv[0] === 'terminal' && argv[1] === 'send')
}

// references/hooks.md 「멈춘 worker 다시 시도시키기」 의 핸들러 예시
function retryExample(): string {
  const doc = readFileSync(HOOKS_DOC, 'utf8')
  const section = doc.slice(doc.indexOf('### 멈춘 worker 다시 시도시키기'))
  const found = /```ts\n([\s\S]*?)```/u.exec(section)
  assert.ok(found, 'hooks.md 에 핸들러 예시가 없다')
  return found[1]
}

function screenReads(): string[] {
  return jsonl(join(tmp, 'orca-calls.jsonl'))
    .map((argv) => argv as unknown as string[])
    .filter((argv) => argv[0] === 'terminal' && argv[1] === 'read')
    .map((argv) => argv[argv.indexOf('--terminal') + 1])
}

// 틱 자식을 한 번 돌리고, 부모가 하듯 결과의 stalls 와 errors 를 loop.json 에 옮긴다
function tick(): Json {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--tick', '--tick-number', '1'], {
    env,
    cwd: tmp,
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(done.status, 0, done.stdout + done.stderr)
  const result = JSON.parse(done.stdout.trim().split('\n').at(-1) ?? '') as Json
  write(orchFile('state', 'loop.json'), JSON.stringify({ pid: 999999, errors: result.errors, stalls: result.stalls }))
  return result
}

function stallOf(result: Json, dispatch: string): Json | undefined {
  return (result.stalls as Record<string, Json>)[dispatch]
}

describe('error 멈춤', () => {
  beforeEach(() => register('A', '2026-01-01T00:00:00Z'))

  test('기준 틱 수(기본 2)만큼 이어지면 한 번만 알리고, 핸들러가 없으면 그 Run 의 알림 파일에 WORKER-STALLED 를 쓴다', () => {
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR() } })
    const first = tick()
    assert.equal(stallOf(first, 'd1')?.ticks, 1)
    assert.deepEqual(stalledEvents('A'), [])
    const second = tick()
    assert.equal(stallOf(second, 'd1')?.fired, true)
    assert.deepEqual(
      stalledEvents('A').map((row) => row.text),
      ['d1 error 2틱 tA'],
    )
    tick()
    tick()
    assert.equal(stalledEvents('A').length, 1, '같은 멈춤을 다시 알렸다')
  })

  test('알린 뒤 이어 가게 한 worker 가 같은 오류로 다시 멈추면 다시 알리고, since 는 그대로다', () => {
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR() } })
    tick()
    const fired = stallOf(tick(), 'd1')
    assert.equal(fired?.fired, true)
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR_AGAIN } })
    const recounted = stallOf(tick(), 'd1')
    assert.deepEqual([recounted?.ticks, recounted?.fired, recounted?.since], [1, false, fired?.since])
    tick()
    tick()
    tick()
    assert.deepEqual(
      stalledEvents('A').map((row) => row.text),
      ['d1 error 2틱 tA', 'd1 error 2틱 tA'],
    )
  })

  test('사람이 Esc 로 끊은 화면은 멈춤으로 세지 않고 핸들러도 부르지 않는다', () => {
    write(orchFile('hooks', 'worker-stalled.ts'), retryExample())
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_INTERRUPTED } })
    for (let i = 0; i < 4; i++) assert.deepEqual(tick().stalls, {})
    assert.deepEqual(stalledEvents('A'), [])
    assert.deepEqual(sends(), [])
  })

  test('입력란 아래 상태 줄만 바뀌어도 같은 멈춤으로 센다', () => {
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR('Context 47% used') } })
    tick()
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR('Context 52% used') } })
    tick()
    assert.equal(stalledEvents('A').length, 1)
  })

  test('마지막 메시지 묶음이 바뀌면 처음부터 다시 센다', () => {
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR() } })
    tick()
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR().replace('at capacity', 'overloaded') } })
    const result = tick()
    assert.equal(stallOf(result, 'd1')?.ticks, 1)
    assert.deepEqual(stalledEvents('A'), [])
  })

  test('작업 중으로 바뀌거나 dispatch 가 끝나면 항목을 지운다', () => {
    orca({ workers_by_run: { A: [worker('d1', 'tA'), worker('d2', 'tB')] }, screens: { tA: CODEX_ERROR(), tB: CODEX_ERROR() } })
    tick()
    orca({ workers_by_run: { A: [worker('d1', 'tA'), worker('d2', 'tB', 'completed')] }, screens: { tA: CLAUDE_WORKING, tB: CODEX_ERROR() } })
    const result = tick()
    assert.deepEqual(result.stalls, {})
    assert.deepEqual(stalledEvents('A'), [])
  })

  test('핸들러가 0 으로 끝나면 알림 파일에 쓰지 않고, 입력에 run, worker, state, since, ticks, lines 가 있다', () => {
    handler('worker-stalled')
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR() } })
    tick()
    tick()
    assert.deepEqual(stalledEvents('A'), [])
    const inputs = received('worker-stalled')
    assert.equal(inputs.length, 1)
    const [input] = inputs
    assert.equal(input.event, 'worker-stalled')
    assert.equal(input.run, 'A')
    assert.deepEqual(input.worker, { task: 'task_d1', dispatch: 'd1', terminal: 'tA', worktree: '/work/d1', spec: null })
    assert.equal(input.state, 'error')
    assert.equal(input.ticks, 2)
    assert.ok(!Number.isNaN(Date.parse(String(input.since))), String(input.since))
    assert.ok((input.lines as string[]).includes('■ Selected model is at capacity. Please try a different model.'), JSON.stringify(input.lines))
    // 핸들러가 코어 명령(nudge-worker, send-to-worker)을 찾는 폴더다
    assert.deepEqual(received('worker-stalled.env'), [{ ORCH_SCRIPTS: dirname(SCRIPT) }])
  })

  test('hooks.md 예시 핸들러는 같은 오류 화면에 상한까지 다시 시도시키고, 상한에서 10 으로 넘겨 WORKER-STALLED 를 한 번 쓴다', () => {
    write(orchFile('hooks', 'worker-stalled.ts'), retryExample())
    // 다시 시도한 worker 가 같은 오류로 바로 끝나 화면이 그대로인 경우다
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR() } })
    // 2틱마다 핸들러가 불린다. 세 번 입력하고, 네 번째 호출은 상한이라 코디네이터에게 넘긴다
    for (let i = 0; i < 6; i++) tick()
    assert.equal(sends().length, 3)
    assert.deepEqual(stalledEvents('A'), [])
    for (const argv of sends()) assert.deepEqual(argv.slice(argv.indexOf('--terminal'), argv.indexOf('--terminal') + 4), ['--terminal', 'tA', '--text', '계속 진행해'])
    tick()
    const result = tick()
    assert.equal(stallOf(result, 'd1')?.fired, true)
    assert.deepEqual(
      stalledEvents('A').map((row) => row.text),
      ['d1 error 2틱 tA'],
    )
    tick()
    tick()
    assert.equal(sends().length, 3)
    assert.equal(stalledEvents('A').length, 1, '같은 멈춤을 다시 알렸다')
    const rejected = jsonl(orchFile('state', 'hooks.jsonl')).filter((row) => row.event === 'worker-stalled' && row.result === 'reject')
    assert.deepEqual(
      rejected.map((row) => row.reason),
      ['다시 시도 3번에 닿았다'],
    )
  })

  test('hooks.md 예시 핸들러는 횟수를 멈춤(since)마다 센다', () => {
    write(orchFile('hooks', 'worker-stalled.ts'), retryExample())
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR() } })
    for (let i = 0; i < 8; i++) tick()
    assert.equal(sends().length, 3)
    assert.equal(stalledEvents('A').length, 1)
    // 작업 중 화면을 거쳐 다시 멈추면 새 멈춤이라 다시 세 번까지 시도시킨다
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CLAUDE_WORKING } })
    tick()
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR() } })
    for (let i = 0; i < 6; i++) tick()
    assert.equal(sends().length, 6)
    assert.equal(stalledEvents('A').length, 1)
  })

  test('핸들러가 실패하면 알림 파일에 쓴다', () => {
    handler('worker-stalled', 1)
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR() } })
    tick()
    tick()
    assert.equal(stalledEvents('A').length, 1)
  })

  test('pipeline.stall_ticks.error 가 0 이면 보지 않는다', () => {
    write(orchFile('config.json'), JSON.stringify({ pipeline: { stall_ticks: { error: 0 } } }))
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR() } })
    tick()
    const result = tick()
    assert.deepEqual(result.stalls, {})
    assert.deepEqual(stalledEvents('A'), [])
  })

  test('화면을 읽지 못하면 항목을 그대로 두고 stalls@<Run> 으로 알린다', () => {
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CODEX_ERROR() } })
    tick()
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: {} })
    const result = tick()
    assert.equal(stallOf(result, 'd1')?.ticks, 1)
    assert.match(String((result.errors as Json)['stalls@A']), /^tA 화면을 읽지 못했다/)
    assert.equal(runEvents('A').filter((row) => String(row.text).startsWith('stalls:')).length, 1)
  })
})

describe('Run 범위', () => {
  test('등록된 Run 의 worker 화면만 보고, 알림은 그 worker 를 띄운 Run 에 간다', () => {
    register('A', '2026-01-01T00:00:00Z')
    register('B', '2026-01-02T00:00:00Z')
    // C 는 등록되지 않은 다른 세션의 Run 이다. 그 worker 화면은 읽지 않는다
    orca({
      workers_by_run: { A: [worker('d1', 'tA')], B: [worker('d2', 'tB')], C: [worker('d3', 'tC')] },
      screens: { tA: CLAUDE_WORKING, tB: CODEX_ERROR(), tC: CODEX_ERROR() },
    })
    tick()
    tick()
    assert.deepEqual([...new Set(screenReads())].sort(), ['tA', 'tB'])
    assert.deepEqual(stalledEvents('A'), [])
    assert.deepEqual(
      stalledEvents('B').map((row) => row.text),
      ['d2 error 2틱 tB'],
    )
    assert.equal(existsSync(orchFile('state', 'loop-events', 'C.jsonl')), false)
  })

  test('등록에서 빠진 Run 의 항목은 지운다', () => {
    register('A', '2026-01-01T00:00:00Z')
    register('B', '2026-01-02T00:00:00Z')
    orca({ workers_by_run: { A: [worker('d1', 'tA')], B: [worker('d2', 'tB')] }, screens: { tA: CODEX_ERROR(), tB: CODEX_ERROR() } })
    tick()
    rmSync(orchFile('state', 'loop-runs', 'B.json'))
    const result = tick()
    assert.deepEqual(Object.keys(result.stalls as Json), ['d1'])
  })
})

describe('idle 멈춤', () => {
  beforeEach(() => register('A', '2026-01-01T00:00:00Z'))

  test('기본값은 꺼져 있어 idle 화면을 세지 않는다', () => {
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CLAUDE_IDLE } })
    for (let i = 0; i < 4; i++) tick()
    assert.deepEqual(stalledEvents('A'), [])
  })

  test('켜면 기준 틱 수만큼 이어진 idle 을 알리되, 코디네이터가 답하지 않은 질문을 보낸 dispatch 는 제외한다', () => {
    write(orchFile('config.json'), JSON.stringify({ pipeline: { stall_ticks: { idle: 2 } } }))
    const question = { id: 'q1', type: 'question', run_id: 'A', to_handle: 'run:A', from_handle: 'tA', dispatch_id: 'd1', body: '어느 쪽?', created_at: '2026-01-01T00:00:00Z' }
    orca({ workers_by_run: { A: [worker('d1', 'tA'), worker('d2', 'tB')] }, screens: { tA: CLAUDE_IDLE, tB: CLAUDE_IDLE }, questions_by_run: { A: [question] } })
    tick()
    const result = tick()
    assert.equal(stallOf(result, 'd1'), undefined)
    assert.deepEqual(
      stalledEvents('A').map((row) => row.text),
      ['d2 idle 2틱 tB'],
    )
  })

  test('질문을 읽지 못한 틱은 idle 을 세지도 지우지도 않는다', () => {
    write(orchFile('config.json'), JSON.stringify({ pipeline: { stall_ticks: { idle: 2 } } }))
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CLAUDE_IDLE } })
    tick()
    // 질문 조회만 실패하게 check 의 답을 객체가 아닌 값으로 바꾼다
    orca({ workers_by_run: { A: [worker('d1', 'tA')] }, screens: { tA: CLAUDE_IDLE }, questions_by_run: { A: 'broken' } })
    const result = tick()
    assert.equal(stallOf(result, 'd1')?.ticks, 1)
    assert.deepEqual(stalledEvents('A'), [])
  })
})

describe('설정', () => {
  test('pipeline.stall_ticks 의 모르는 키나 음수는 설정 오류다', () => {
    register('A', '2026-01-01T00:00:00Z')
    orca({})
    for (const value of [{ eror: 2 }, { error: -1 }, { idle: 1.5 }, 3]) {
      write(orchFile('config.json'), JSON.stringify({ pipeline: { stall_ticks: value } }))
      const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--tick', '--tick-number', '1'], { env, cwd: tmp, encoding: 'utf8' })
      assert.equal(done.status, 2, `${JSON.stringify(value)}: ${done.stdout}${done.stderr}`)
      assert.match(done.stderr, /pipeline\.stall_ticks/)
    }
  })
})
