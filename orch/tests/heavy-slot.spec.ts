// heavy-slot.ts 의 대기열 판정, 분류, wait_idle, 명령 수명을 본다.
//
// 대기열 판정은 Queue 를 import 해 pid 와 생존 판정을 대역으로 바꿔 본다. 명령 수명과 wait_idle 은 명령을 실제로 띄운다.
// 메모리 대기는 MEM_GATE 로 바꾼 셸 스크립트다. 무거운 프로세스는 명령줄에 고유한 표지를 넣은 node -e 자식이다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { classify, compileHeavy, Queue } from '../scripts/heavy-slot.ts'
import type { Heavy } from '../scripts/heavy-slot.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/heavy-slot.ts', import.meta.url))
const NODE = process.execPath
const CLEAR = ['HEAVY_SLOT_DIR', 'HEAVY_SLOT_HELD', 'HEAVY_SLOTS', 'HEAVY_EXCLUSIVE', 'HEAVY_POLL', 'HEAVY_IDLE_WAIT', 'MEM_GATE', 'ORCH_DIR']
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

// 한 저장소의 명령 이름 대신 같은 꼴의 일반 명령으로 만든 분류 설정이다
const SAMPLE = {
  exclusive: ['local-ci', 'playwright', 'browser'],
  normal: ['scenario', 'baseline'],
  light: [
    '^(pnpm( -s)?( exec)? )?(tsc|oxlint|oxfmt)\\b',
    '^pnpm( -s)? (type-check|lint|format(:changed)?)\\b',
    '^pnpm( -s)? (test|vitest)( run)? (?!-)\\S+',
    '^(pnpm( -s)? exec |npx )?vitest( run)? (?!-)\\S+',
    '^node (--check|-c) ',
    '^(echo|cd|git|ls|cat|true|test|\\[)(\\s|$)',
  ],
}

let tmp: string
let slots: string
let gate: string
const started: ChildProcess[] = []

type Result = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV }
  for (const key of CLEAR) delete env[key]
  return { ...env, ...extra }
}

function slotEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return baseEnv({ HEAVY_SLOT_DIR: slots, MEM_GATE: gate, ...extra })
}

// 명령을 띄우고 끝날 때까지의 결과를 돌려준다. 끝내지 못한 프로세스는 afterEach 가 끝낸다
function launch(
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string },
): { child: ChildProcess; done: Promise<Result>; stderr: () => string } {
  const child = spawn(NODE, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env: opts.env, cwd: opts.cwd ?? tmp })
  started.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  const done = new Promise<Result>((resolve) => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })))
  return { child, done, stderr: () => stderr }
}

function slot(args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string }): Promise<Result> {
  return launch(args, opts).done
}

// 명령줄에 표지를 담은 무거운 프로세스. 끝날 때까지 산다
function busy(marker: string): ChildProcess {
  const child = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)', marker], { stdio: 'ignore' })
  started.push(child)
  return child
}

function entries(dir = slots): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : []
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`${ms}ms 안에 ${what} 가 되지 않았다`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function config(dir: string, heavy: Record<string, unknown>): void {
  mkdirSync(join(dir, '.orch'), { recursive: true })
  writeFileSync(join(dir, '.orch/config.json'), JSON.stringify({ heavy }))
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'heavy-slot-')))
  slots = join(tmp, 'slots')
  gate = join(tmp, 'gate.sh')
  writeFileSync(gate, 'exit 0\n')
})

afterEach(() => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  rmSync(tmp, { recursive: true, force: true })
})

describe('Queue', () => {
  // [pid, ticket, held, exclusive]
  function rows(...list: [number, number, boolean, boolean][]): void {
    mkdirSync(slots, { recursive: true })
    for (const [pid, ticket, held, exclusive] of list) {
      writeFileSync(join(slots, `${pid}.json`), JSON.stringify({ pid, ticket, held, exclusive, slots: 3 }))
    }
  }

  function claim(pid: number): Promise<boolean> {
    return new Queue(slots, 3, { pid, alive: () => true }).claim()
  }

  test('먼저 등록한 것이 먼저이고 등록 시각은 pid 보다 앞선다', async () => {
    rows([100, 5, false, false], [20, 1, false, false], [30, 2, false, false], [40, 3, false, false])
    assert.equal(await claim(100), false)
    assert.equal(await claim(20), true)
  })

  test('자리를 쥔 것은 기다리는 줄에 세지 않는다', async () => {
    rows([10, 1, true, false], [100, 2, false, false])
    assert.equal(await claim(100), true)
  })

  test('앞에 기다리는 exclusive 가 있으면 normal 은 들어가지 못한다', async () => {
    rows([10, 1, false, true], [100, 2, false, false])
    assert.equal(await claim(100), false)
    assert.equal(await claim(10), true)
    assert.equal(await claim(100), false)
  })

  test('exclusive 는 모든 자리가 빌 때 들어간다', async () => {
    rows([10, 1, true, false], [100, 2, false, true])
    assert.equal(await claim(100), false)
    unlinkSync(join(slots, '10.json'))
    assert.equal(await claim(100), true)
  })

  test('끝난 pid 의 등록은 회수한다', async () => {
    rows([10, 1, true, true])
    const queue = new Queue(slots, 3, { alive: (pid) => pid === process.pid })
    await queue.register(false)
    assert.equal(await queue.claim(), true)
    await queue.cleanup()
    assert.deepEqual(entries(), [])
  })

  test('끝난 pid 가 쓰다 만 등록도 회수한다', async () => {
    mkdirSync(slots, { recursive: true })
    writeFileSync(join(slots, '10.json'), '{')
    const queue = new Queue(slots, 3, { alive: (pid) => pid === process.pid })
    await queue.register(false)
    assert.equal(existsSync(join(slots, '10.json')), false)
    assert.equal(await queue.claim(), true)
    await queue.cleanup()
  })

  test('등록 시각이 같으면 pid 가 작은 것이 먼저다', async () => {
    rows([100, 1, false, true], [200, 1, false, false])
    assert.equal(await claim(200), false)
    assert.equal(await claim(100), true)
  })

  test('자기 등록이 없으면 자리를 잡지 않고 실패한다', async () => {
    mkdirSync(slots, { recursive: true })
    await assert.rejects(new Queue(slots, 3).claim(), /queue entry is missing/)
  })

  test('명령의 따옴표가 등록을 깨거나 기다리는 등록을 숨기지 않고, 명령은 인자를 그대로 받는다', async () => {
    // 앞에 기다리는 exclusive 등록. 살아 있는 pid 여야 회수되지 않으므로 이 테스트 프로세스의 pid 를 쓴다
    rows([process.pid, 1, false, true])
    const out = join(tmp, 'argv.json')
    const quoted = [`a'b`, 'c"d', `'; echo injected; '`, '"$(touch x)"', '\\"']
    const run = launch(['--', NODE, '-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(1)))`, ...quoted], {
      env: slotEnv({ HEAVY_POLL: '0.1' }),
    })
    await until(() => run.stderr().includes('heavy-slot: waiting'), '앞의 exclusive 를 기다림')
    const own = entries().filter((name) => name !== `${process.pid}.json`)
    assert.equal(own.length, 1, `등록이 하나가 아니다: ${entries().join(', ')}`)
    const row = JSON.parse(readFileSync(join(slots, own[0]), 'utf8')) as { held: boolean; exclusive: boolean }
    assert.deepEqual([row.held, row.exclusive], [false, false])
    assert.equal(existsSync(out), false, '앞에 exclusive 가 기다리는데 명령을 실행했다')
    unlinkSync(join(slots, `${process.pid}.json`))
    const r = await run.done
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), quoted)
    assert.equal(existsSync(join(tmp, 'x')), false, '따옴표 안의 명령이 셸로 실행됐다')
    assert.deepEqual(entries(), [])
  })

  test('다른 HEAVY_SLOTS 로 쓰는 대기열에는 등록하지 않는다', async () => {
    rows([10, 1, false, false])
    await assert.rejects(new Queue(slots, 2, { alive: () => true }).register(false), /different HEAVY_SLOTS/)
    assert.deepEqual(entries(), ['10.json'])
  })
})

describe('분류', () => {
  const heavy: Heavy = compileHeavy(SAMPLE)
  const none: Heavy = compileHeavy({})

  for (const [argv, expected] of [
    [['pnpm', 'type-check'], 'light'],
    [['bash', '-c', 'cd /x && pnpm exec tsc -p tsconfig.json && pnpm exec oxlint src'], 'light'],
    [['pnpm', 'test', 'tests/unit/a.test.cjs'], 'light'],
    [['pnpm', 'test'], 'normal'],
    [['pnpm', 'build'], 'normal'],
    [['pnpm', 'lint', '&&', 'pnpm', 'build'], 'normal'],
    [['bash', 'scripts/local-ci.sh'], 'exclusive'],
    [['node', 'tools/browser-check.ts'], 'exclusive'],
    [['pnpm', 'exec', 'vitest', 'run', 'tests/scenario-region.test.cjs'], 'normal'],
  ] as const) {
    test(`${argv.join(' ')} 는 ${expected} 다`, () => {
      assert.equal(classify([...argv], heavy), expected)
    })
  }

  test('exclusive 와 light 에 함께 맞으면 exclusive 다', () => {
    assert.equal(classify(['echo', 'browser'], heavy), 'exclusive')
  })

  test('heavy 설정이 없으면 pnpm type-check 도 normal 이다', () => {
    assert.equal(classify(['pnpm', 'type-check'], none), 'normal')
  })

  test('조각을 나눈 뒤 time 과 괄호를 떼고 본다', () => {
    assert.equal(classify(['bash', '-c', '(time pnpm type-check) | cat'], heavy), 'light')
    assert.equal(classify(['/usr/bin/time', '-l', 'git', 'status'], heavy), 'light')
  })

  test('조각이 없는 명령은 light 가 아니다', () => {
    assert.equal(classify(['bash', '-c', ' ; '], heavy), 'normal')
  })
})

describe('설정', () => {
  // gate 가 돌면 표지 파일을 남긴다. 대기열을 거쳤는지 본다
  function markingGate(): string {
    const marker = join(tmp, 'gate-ran')
    writeFileSync(gate, `touch ${JSON.stringify(marker)}\nexit 0\n`)
    return marker
  }

  test('heavy.light 에 맞는 명령은 대기열과 메모리 대기를 거치지 않는다', async () => {
    config(tmp, SAMPLE)
    const marker = markingGate()
    const r = await slot(['--', 'true'], { env: slotEnv() })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(existsSync(marker), false, '가벼운 명령인데 메모리 대기를 거쳤다')
    assert.equal(existsSync(slots), false, '가벼운 명령인데 대기열 폴더를 만들었다')
  })

  test('heavy 설정이 없으면 같은 명령도 자리를 쓴다', async () => {
    const marker = markingGate()
    const r = await slot(['--', 'true'], { env: slotEnv() })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(existsSync(marker), true, '설정이 없는데 메모리 대기를 건너뛰었다')
    assert.deepEqual(entries(), [])
  })

  test('heavy.light 의 정규식이 틀리면 등록하지 않고 2 로 끝난다', async () => {
    config(tmp, { light: ['('] })
    const r = await slot(['--', 'true'], { env: slotEnv() })
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /^heavy-slot: heavy\.light 의 정규식이 틀렸다: \(: /m)
    assert.deepEqual(entries(), [])
  })

  for (const [name, value] of [
    ['HEAVY_POLL', 'soon'],
    ['HEAVY_IDLE_WAIT', '-1'],
  ] as const) {
    test(`${name}=${value} 처럼 0 이상의 초가 아니면 등록하지 않고 1 로 끝난다`, async () => {
      const marker = markingGate()
      const r = await slot(['--', 'true'], { env: slotEnv({ [name]: value }) })
      assert.equal(r.code, 1, r.stderr)
      assert.ok(r.stderr.includes(`heavy-slot: ${name} 는 0 이상의 초여야 한다: ${value}`), r.stderr)
      assert.equal(existsSync(marker), false, '틀린 값인데 메모리 대기를 거쳤다')
      assert.deepEqual(entries(), [])
    })
  }

  test('heavy.light 에 맞는 명령이 없으면 127, 실행할 수 없으면 126 이다', async () => {
    const noExec = join(tmp, 'light-no-exec')
    writeFileSync(noExec, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    config(tmp, { light: ['light-'] })
    let r = await slot(['--', join(tmp, 'light-missing')], { env: slotEnv() })
    assert.equal(r.code, 127, r.stderr)
    assert.ok(r.stderr.includes(`heavy-slot: command not found: ${join(tmp, 'light-missing')}`), r.stderr)
    r = await slot(['--', noExec], { env: slotEnv() })
    assert.equal(r.code, 126, r.stderr)
    assert.ok(r.stderr.includes(`heavy-slot: command is not executable: ${noExec}`), r.stderr)
    assert.equal(existsSync(slots), false, '가벼운 명령인데 대기열 폴더를 만들었다')
  })

  test('heavy 의 값이 문자열 목록이 아니면 2 다', async () => {
    config(tmp, { wait_idle: 'image-build' })
    const r = await slot(['--exclusive', '--', 'true'], { env: slotEnv() })
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /heavy\.wait_idle 는 정규식 문자열 목록이어야 한다/)
    assert.deepEqual(entries(), [])
  })
})

describe('명령 수명', () => {
  test('메모리 대기의 실패와 명령의 종료 코드를 내고 자리를 반납한다', async () => {
    writeFileSync(gate, 'exit 9\n')
    const cmd = ['--exclusive', '--', NODE, '-e', 'process.exit(7)']
    assert.equal((await slot(cmd, { env: slotEnv() })).code, 9)
    writeFileSync(gate, 'exit 0\n')
    assert.equal((await slot(cmd, { env: slotEnv() })).code, 7)
    assert.deepEqual(entries(), [])
  })

  test('없는 명령은 127 이고 자리를 반납한다', async () => {
    const r = await slot(['--exclusive', '--', join(tmp, 'missing')], { env: slotEnv() })
    assert.equal(r.code, 127, r.stderr)
    assert.match(r.stderr, /heavy-slot: command not found: /)
    assert.deepEqual(entries(), [])
  })

  test('중첩 호출은 메모리 대기를 거치지 않는다', async () => {
    const r = await slot(['--', NODE, '-e', 'process.exit(7)'], { env: baseEnv({ HEAVY_SLOT_HELD: 'parent', MEM_GATE: '/missing' }) })
    assert.equal(r.code, 7, r.stderr)
  })

  for (const nested of [false, true]) {
    test(`${nested ? '중첩 호출의 ' : ''}명령은 신호를 받으면 끝난 뒤에 자리를 반납한다`, async () => {
      const marker = join(tmp, 'child-pid')
      const payload = [NODE, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`]
      const inner = nested ? [NODE, '--disable-warning=ExperimentalWarning', SCRIPT, '--', ...payload] : payload
      const run = launch(['--exclusive', '--', ...inner], { env: slotEnv() })
      await until(() => existsSync(marker) && readFileSync(marker, 'utf8') !== '', '명령 시작')
      run.child.kill('SIGTERM')
      const r = await run.done
      assert.equal(r.code, 143, r.stderr)
      assert.equal(isAlive(Number(readFileSync(marker, 'utf8'))), false, '명령이 아직 살아 있다')
      assert.deepEqual(entries(), [])
    })
  }
})

describe('신호', () => {
  test('명령을 돌리는 중에 SIGINT 를 받으면 명령을 끝내고 130 으로 끝난다', async () => {
    const marker = join(tmp, 'child-pid')
    const run = launch(
      ['--exclusive', '--', NODE, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`],
      { env: slotEnv() },
    )
    await until(() => existsSync(marker) && readFileSync(marker, 'utf8') !== '', '명령 시작')
    run.child.kill('SIGINT')
    const r = await run.done
    assert.equal(r.code, 130, r.stderr)
    assert.equal(isAlive(Number(readFileSync(marker, 'utf8'))), false, '명령이 아직 살아 있다')
    assert.deepEqual(entries(), [])
  })

  test('ps 가 신호로 죽고 heavy-slot 도 TERM 을 받았으면 1 이 아니라 143 이다', { timeout: 30_000 }, async () => {
    const bin = join(tmp, 'bin')
    mkdirSync(bin)
    // 터미널의 신호가 그룹 전체에 간 것처럼 부모(heavy-slot)와 자기에게 TERM 을 보낸다
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nkill -TERM $PPID\nkill -TERM $$\n', { mode: 0o755 })
    config(tmp, { wait_idle: ['anything'] })
    const r = await slot(['--', NODE, '-e', ''], { env: slotEnv({ PATH: `${bin}:${process.env.PATH ?? ''}` }) })
    assert.equal(r.code, 143, r.stdout + r.stderr)
    assert.deepEqual(entries(), [])
  })

  // queue.lock 을 먼저 쥐는 도우미. 옛 heavy-slot.py 의 fcntl.flock 과 새 heavy-slot.ts 의 perl 도우미 둘 다로 쥔다
  const holders: Record<string, (lock: string) => string[]> = {
    perl: (lock) => ['perl', '-e', 'use Fcntl qw(:flock); open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; $| = 1; print "locked\\n"; <STDIN>;', lock],
    'python3 fcntl': (lock) => [
      'python3',
      '-c',
      'import fcntl, sys\nf = open(sys.argv[1], "a")\nfcntl.flock(f, fcntl.LOCK_EX)\nprint("locked", flush=True)\nsys.stdin.read()',
      lock,
    ],
  }

  // heavy-slot 의 자식 가운데 perl(잠금 도우미)이 있는지. 있으면 잠금을 기다리는 중이다
  function lockHelperOf(pid: number): boolean {
    const done = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    return done.stdout.split('\n').some((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      return m !== null && Number(m[2]) === pid && m[3].startsWith('perl ')
    })
  }

  async function holdLock(kind: string): Promise<ChildProcess> {
    mkdirSync(slots, { recursive: true })
    const [cmd, ...args] = holders[kind](join(slots, 'queue.lock'))
    const holder = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] })
    started.push(holder)
    let out = ''
    holder.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
    await until(() => out.includes('locked'), `${kind} 가 queue.lock 을 쥠`)
    return holder
  }

  for (const kind of Object.keys(holders)) {
    test(`${kind} 가 queue.lock 을 쥐면 등록을 기다리고, 놓으면 명령을 실행한다`, { timeout: 30_000 }, async () => {
      const holder = await holdLock(kind)
      const out = join(tmp, 'ran')
      const run = launch(['--exclusive', '--', NODE, '-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, 'x')`], { env: slotEnv() })
      await until(() => lockHelperOf(run.child.pid as number), '잠금 기다림')
      assert.deepEqual(entries(), [], '잠금을 잡지 않고 등록했다')
      assert.equal(existsSync(out), false)
      holder.stdin?.end()
      const r = await run.done
      assert.equal(r.code, 0, r.stderr)
      assert.equal(existsSync(out), true)
      assert.deepEqual(entries(), [])
    })

    test(`${kind} 가 queue.lock 을 쥔 동안 SIGTERM 을 받으면 기다림을 멈추고 143 으로 끝난다`, { timeout: 30_000 }, async () => {
      const holder = await holdLock(kind)
      const out = join(tmp, 'ran')
      const run = launch(['--exclusive', '--', NODE, '-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, 'x')`], { env: slotEnv() })
      const pid = run.child.pid as number
      await until(() => lockHelperOf(pid), '잠금 기다림')
      run.child.kill('SIGTERM')
      const r = await run.done
      assert.equal(r.code, 143, r.stderr)
      assert.equal(lockHelperOf(pid), false, '잠금 도우미가 남았다')
      assert.equal(existsSync(out), false)
      assert.deepEqual(entries(), [])
      assert.equal(holder.exitCode, null, '잠금을 쥔 쪽이 먼저 끝나 판정을 보지 못했다')
      holder.stdin?.end()
    })
  }
})

describe('wait_idle', () => {
  test('맞는 프로세스가 끝날 때까지 자리를 잡지 않고, 끝나면 명령을 실행한다', async () => {
    const marker = `idle-${randomUUID()}`
    config(tmp, { wait_idle: [marker] })
    const heavyProc = busy(marker)
    const out = join(tmp, 'ran')
    const run = launch(['--', NODE, '-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, String(Date.now()))`], {
      env: slotEnv({ HEAVY_POLL: '0.1' }),
    })
    await until(() => entries().length === 1, '등록')
    await until(() => run.stderr().includes(`waiting for idle`), 'wait_idle 대기')
    const row = JSON.parse(readFileSync(join(slots, entries()[0]), 'utf8')) as { held: boolean }
    assert.equal(row.held, false, '무거운 프로세스가 도는데 자리를 잡았다')
    assert.equal(existsSync(out), false, '무거운 프로세스가 도는데 명령을 실행했다')
    const exited = new Promise<number>((resolve) => heavyProc.once('exit', () => resolve(Date.now())))
    heavyProc.kill('SIGTERM')
    const endedAt = await exited
    const r = await run.done
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, new RegExp(`heavy-slot: waiting for idle: .*${marker}`))
    assert.ok(Number(readFileSync(out, 'utf8')) >= endedAt, '무거운 프로세스가 끝나기 전에 명령을 실행했다')
    assert.deepEqual(entries(), [])
  })

  test('자기 명령줄이 wait_idle 에 맞아도 기다리지 않는다', async () => {
    const marker = `idle-${randomUUID()}`
    config(tmp, { wait_idle: [marker] })
    const r = await slot(['--', NODE, '-e', '', marker], { env: slotEnv({ HEAVY_POLL: '0.1', HEAVY_IDLE_WAIT: '1' }) })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stderr, /waiting for idle/)
  })

  test('다른 heavy-slot 이 자리를 쥐고 돌리는 명령은 기다리지 않는다', async () => {
    const marker = `idle-${randomUUID()}`
    const holderDir = join(tmp, 'holder')
    mkdirSync(holderDir)
    const startedFile = join(tmp, 'holder-started')
    const holder = launch(
      ['--', NODE, '-e', `require('node:fs').writeFileSync(${JSON.stringify(startedFile)}, 'x'); setInterval(() => {}, 1000)`, marker],
      { env: slotEnv(), cwd: holderDir },
    )
    await until(() => existsSync(startedFile), '자리를 쥔 명령 시작')
    config(tmp, { wait_idle: [marker] })
    const r = await slot(['--', NODE, '-e', ''], { env: slotEnv({ HEAVY_POLL: '0.1', HEAVY_IDLE_WAIT: '1' }) })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stderr, /waiting for idle/)
    assert.equal(holder.child.exitCode, null, '자리를 쥔 검사가 먼저 끝나 판정을 보지 못했다')
    holder.child.kill('SIGTERM')
    assert.equal((await holder.done).code, 143)
  })

  test('등록된 heavy-slot 의 조상만 명령줄이 맞아도 기다리지 않는다', { timeout: 30_000 }, async () => {
    const marker = `idle-${randomUUID()}`
    const holderDir = join(tmp, 'holder')
    mkdirSync(holderDir)
    const startedFile = join(tmp, 'holder-started')
    // 표지는 상위 프로세스(heavy-slot 을 띄운 node)의 명령줄에만 있다. heavy-slot 과 그 명령의 명령줄에는 없다
    const inner = [SCRIPT, '--', NODE, '-e', `require('node:fs').writeFileSync(${JSON.stringify(startedFile)}, 'x'); setInterval(() => {}, 1000)`]
    const parentCode = `const c = require('node:child_process').spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...${JSON.stringify(inner)}], { stdio: 'inherit' }); process.on('SIGTERM', () => c.kill('SIGTERM')); c.on('exit', (code) => process.exit(code ?? 1))`
    // afterEach 의 SIGKILL 은 안쪽 heavy-slot 에 전해지지 않아 고아가 남는다. 실패해도 TERM 으로 넘겨 끝내도록 여기서 끝낸다
    const parent = spawn(NODE, ['-e', parentCode, marker], { env: slotEnv(), cwd: holderDir, stdio: 'ignore' })
    const exited = new Promise<number | null>((resolve) => parent.once('exit', (code) => resolve(code)))
    try {
      await until(() => existsSync(startedFile), '자리를 쥔 명령 시작')
      config(tmp, { wait_idle: [marker] })
      const r = await slot(['--', NODE, '-e', ''], { env: slotEnv({ HEAVY_POLL: '0.1', HEAVY_IDLE_WAIT: '1' }) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.doesNotMatch(r.stderr, /waiting for idle/)
      assert.equal(parent.exitCode, null, '상위 프로세스가 먼저 끝나 판정을 보지 못했다')
    } finally {
      parent.kill('SIGTERM')
      await exited
    }
    assert.equal(await exited, 143)
    await until(() => entries().length === 0, '자리를 쥔 검사의 반납')
  })

  test('HEAVY_IDLE_WAIT 를 넘으면 대기 초과 줄을 내고 등록을 지운 뒤 124 로 끝난다', async () => {
    const marker = `idle-${randomUUID()}`
    config(tmp, { wait_idle: [marker] })
    busy(marker)
    const out = join(tmp, 'ran')
    // 초 자리는 원문(` 1.0`)이 아니라 읽은 값이다
    const r = await slot(['--', NODE, '-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, 'x')`], {
      env: slotEnv({ HEAVY_POLL: '0.1', HEAVY_IDLE_WAIT: ' 1.0' }),
    })
    assert.equal(r.code, 124, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(`^heavy-slot: wait_idle 대기가 1초를 넘었다: .*${marker}$`, 'm'))
    assert.equal(existsSync(out), false)
    assert.deepEqual(entries(), [])
  })

  test('ps 를 읽지 못하면 등록을 지우고 1 로 끝난다', async () => {
    const bin = join(tmp, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\necho broken >&2\nexit 3\n', { mode: 0o755 })
    config(tmp, { wait_idle: ['anything'] })
    const r = await slot(['--', NODE, '-e', ''], { env: slotEnv({ PATH: `${bin}:${process.env.PATH ?? ''}` }) })
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /프로세스 목록을 읽지 못했다\(ps 종료 코드 3\): broken/)
    assert.deepEqual(entries(), [])
  })
})

describe('기본 대기열 폴더', () => {
  let repo: string
  let child: string

  function git(...args: string[]): string {
    const done = spawnSync('git', args, { env: baseEnv(), encoding: 'utf8' })
    assert.equal(done.status, 0, `git ${args.join(' ')} 실패: ${done.stderr}`)
    return done.stdout.trim()
  }

  function runSlot(extra: Record<string, string> = {}): Promise<Result> {
    return slot(['--exclusive', '--', NODE, '-e', ''], { env: baseEnv({ MEM_GATE: gate, ...extra }), cwd: child })
  }

  beforeEach(() => {
    repo = join(tmp, 'repo')
    child = join(tmp, 'child')
    git('init', '-q', '-b', 'main', repo)
    git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init')
    git('-C', repo, 'worktree', 'add', '-q', '-b', 'child', child)
  })

  test('워크트리끼리 주 checkout 의 대기열을 쓰고 git 이 무시하게 한다', async () => {
    const r = await runSlot()
    assert.equal(r.code, 0, r.stderr)
    assert.ok(existsSync(join(repo, '.orch/state/heavy-slot/queue.lock')))
    assert.equal(existsSync(join(child, '.orch')), false)
    assert.equal(git('-C', repo, 'status', '--porcelain'), '')
    assert.equal(git('-C', child, 'status', '--porcelain'), '')
  })

  test('ORCH_DIR 가 기본 대기열 폴더의 루트를 바꾼다', async () => {
    const r = await runSlot({ ORCH_DIR: 'custom-orch' })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(existsSync(join(repo, 'custom-orch/state/heavy-slot/queue.lock')))
    assert.equal(git('-C', repo, 'status', '--porcelain'), '')
  })

  test('명시한 slot 폴더가 ORCH_DIR 보다 앞선다', async () => {
    const shared = join(tmp, 'shared')
    const r = await runSlot({ ORCH_DIR: 'unused', HEAVY_SLOT_DIR: shared })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(existsSync(join(shared, 'queue.lock')))
    assert.equal(existsSync(join(repo, 'unused')), false)
  })

  test('옮기기 전이면 기본 폴더는 거절하고 명시한 대기열은 받는다', async () => {
    mkdirSync(join(repo, '.omc/orch'), { recursive: true })
    writeFileSync(join(repo, '.omc/orch/old.json'), '{}')
    let r = await runSlot()
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /옮기기 전/)
    assert.equal(existsSync(join(repo, '.orch')), false)
    r = await runSlot({ HEAVY_SLOT_DIR: join(tmp, 'shared') })
    assert.equal(r.code, 0, r.stderr)
  })
})
