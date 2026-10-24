// orch-loop.ts 를 가짜 orca, gh, 정리 명령, 보드 동기화로 본다. Orca 와 GitHub 에는 닿지 않는다.
// 가짜 orca 와 gh 는 ORCA, GH, 가짜 정리와 보드 동기화는 CLEANUP_SWEEP, BOARD_SYNC 로 넣는다. 가짜 명령은 받은 인자를 파일에 적는다.
// 핸들러(tick, worker-question)는 작업 폴더의 .orch/hooks/ 에 두고 stdin 을 파일에 적게 해서 받은 입력을 본다.
// 띄운 루프는 테스트마다 끝낸다. 끝에 loop.json 의 pid 가 살아 있지 않은지도 본다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin } from './fixtures/fake-bin.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/orch-loop.ts', import.meta.url))

// 질문 조회에 답하는 가짜 orca. state.json 을 읽는다. fail 이면 실패로, sleep 이 있으면 그 초만큼 잔 뒤 답한다.
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
if (sub === 'check' && argv.includes('--all')) reply({ messages: st.messages || [] })
else if (sub === 'check') reply({ messages: [] })
else if (sub === 'inbox') reply({ messages: [] })
else reply({})
`

// 정리와 보드 동기화 가짜. 받은 인자를 <이름>.jsonl 에 적고, <이름>.json 의 sleep(초)만큼 잔 뒤 code 로 끝난다
function fakeScript(name: string): string {
  return `import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const dir = process.env.FAKE_DIR
appendFileSync(dir + '/${name}.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n')
const st = existsSync(dir + '/${name}.json') ? JSON.parse(readFileSync(dir + '/${name}.json', 'utf8')) : {}
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

function events(): Json[] {
  return jsonl(orchFile('state', 'loop-events.jsonl'))
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
  test('알린 지 700초 지난 미답변 질문은 REMINDER 를 알림 파일에 쓰고 worker-question 이 reminder 를 받는다', () => {
    hook('worker-question')
    orca({ messages: [question()] })
    write(orchFile('state', 'questions-seen.json'), JSON.stringify({ r: { q: Date.now() / 1000 - 700 } }))
    once()
    const lines = events()
    assert.equal(lines.length, 1, JSON.stringify(lines))
    assert.equal(lines[0].kind, 'REMINDER')
    assert.match(String(lines[0].text), /^REMINDER q question from=dispatch:d: 질문$/)
    assert.equal(lines[0].pr, null)
    const inputs = received('worker-question')
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0].reminder, true)
    assert.equal(inputs[0].run, 'r')
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
    const first = events()
    assert.equal(first.length, 1, JSON.stringify(first))
    assert.equal(first[0].kind, 'WATCH-ERROR')
    assert.match(String(first[0].text), /^WATCH-ERROR questions: .*offline/)
    // 정리와 보드 동기화는 그래도 불린다
    assert.equal(argsOf('sweep').length, 1)
    assert.equal(argsOf('board').length, 1)
    once()
    assert.equal(events().length, 1, '같은 실패를 다시 알렸다')
    // loop.log 에는 실패할 때마다 쓴다
    assert.equal(logText().match(/^WATCH-ERROR questions: /gm)?.length, 2, logText())
    orca({})
    once()
    assert.equal(loopState()?.errors && (loopState()?.errors as Json).questions, null)
    orca({ fail: true })
    once()
    assert.equal(events().length, 2, JSON.stringify(events()))
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
      [['HOOK-FAIL', 'HOOK-FAIL tick 1']],
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
    assert.deepEqual(list.slice(list.indexOf('--json')), ['--json', 'number,author,url'], JSON.stringify(list))
    prs([], 1)
    once()
    assert.equal(received('tick')[1].open_prs, null)
    assert.ok(events().some((line) => String(line.text).startsWith('WATCH-ERROR prs: ')), JSON.stringify(events()))
  })

  test('--tick --tick-number 5 는 마지막 줄에 결과 JSON 을 내고 loop.json 을 바꾸지 않는다', () => {
    hook('tick')
    prs([MINE])
    const before = JSON.stringify({ pid: 1, run: 'r', errors: { questions: null } })
    write(orchFile('state', 'loop.json'), before)
    const r = loop(['--run', 'r', '--tick', '--tick-number', '5'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const last = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Json
    assert.deepEqual(Object.keys(last).sort(), ['errors', 'open_prs', 'tick_at'])
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
    assert.equal(jsonl(join(tmp, 'orca-calls.jsonl')).length, 0)
    assert.equal(loopState()?.run, null)
    assert.ok(!argsOf('sweep')[0].includes('--run'), JSON.stringify(argsOf('sweep')))
  })

  test('보드 파일이 없으면 보드 동기화를 부르지 않는다', () => {
    once()
    assert.deepEqual(argsOf('board'), [])
    board()
    once()
    assert.deepEqual(argsOf('board'), [['--repo', repo]])
  })

  test('정리 명령이 실패하면 WATCH-ERROR cleanup 이다', () => {
    fake('sweep', { code: 2 })
    once()
    assert.deepEqual(
      events().map((line) => line.text),
      ['WATCH-ERROR cleanup: 종료 코드 2'],
    )
    assert.equal((loopState()?.errors as Json).cleanup, '종료 코드 2')
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
    assert.equal((first.errors as Json).tick, '종료 코드 3')
    assert.equal(first.last_tick, null)
    // 같은 이유로 두 번 끝났지만 알림은 한 줄이다
    assert.deepEqual(
      events().map((line) => line.text),
      ['WATCH-ERROR tick: 종료 코드 3'],
    )
    // 세 번째 틱은 성공했다
    assert.equal((third.errors as Json).tick, null)
    assert.ok(!Number.isNaN(Date.parse(String(third.last_tick))), String(third.last_tick))
    assert.match(logText(), /^결과 없이 끝난다$/m)
    assert.equal(pidAlive(child.pid as number), false)
  })
})

describe('--start, --status, --stop', () => {
  test('띄우고, 살아 있음을 보고, 다른 Run 의 --start 는 4 이고, 멈춘 뒤 pid 가 죽어 있다', async () => {
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
    const again = loop(['--run', 'r2', '--start'])
    assert.equal(again.code, 4, again.stdout + again.stderr)
    assert.equal(again.stdout.trim(), `LOOP-RUNNING ${pid} run=r1`)
    const stopped = loop(['--stop'])
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr)
    assert.equal(stopped.stdout.trim(), `LOOP-STOPPED ${pid}`)
    assert.equal(pidAlive(pid), false)
    assert.ok(!existsSync(orchFile('state', 'loop.lock')), '잠금을 풀지 않았다')
    const dead = loop(['--status'])
    assert.equal(dead.code, 1)
    assert.equal(dead.stdout.trim(), `LOOP-DEAD ${repo} pid ${pid} 종료`)
    assert.equal(loop(['--stop']).stdout.trim(), 'LOOP-NOT-RUNNING')
  })

  test('살아 있는 루프의 잠금이 있으면 --foreground 도 4 다', () => {
    // 테스트 프로세스가 쥔 잠금은 살아 있는 pid 의 잠금이다
    write(orchFile('state', 'loop.lock'), String(process.pid))
    const r = loop(['--run', 'r', '--foreground', '--once'])
    assert.equal(r.code, 4, r.stdout + r.stderr)
    assert.equal(r.stdout.trim(), `LOOP-RUNNING ${process.pid} run=-`)
    assert.equal(argsOf('sweep').length, 0)
  })

  test('죽은 pid 의 잠금은 회수하고 돈다', () => {
    const done = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    write(orchFile('state', 'loop.lock'), done.stdout)
    once()
    assert.equal(argsOf('sweep').length, 1)
    assert.ok(!existsSync(orchFile('state', 'loop.lock')))
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
