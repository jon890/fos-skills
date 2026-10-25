import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ConfigError } from '../scripts/lib/config.ts'
import { EVENTS, fire, handlerFile, reclaim, unknownHandlers } from '../scripts/lib/events.ts'
import type { FireContext } from '../scripts/lib/events.ts'
import { alive } from '../scripts/lib/process.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin } from './fixtures/fake-bin.ts'

const GUARD = fileURLToPath(new URL('../scripts/lib/guard', import.meta.url))
const ENV_KEYS = ['ORCH_DIR', 'GIT_CEILING_DIRECTORIES', 'ORCA', 'GH', 'PATH', 'ORCH_REAL_ORCA', 'ORCH_REAL_GH']
const saved: Record<string, string | undefined> = {}

let tmp: string
let binDir: string
let fake: { orca: FakeBin; gh: FakeBin }
let n = 0

before(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lib-events-')))
  binDir = join(tmp, 'bin')
  mkdirSync(binDir)
  fake = {
    orca: fakeBin(binDir, 'orca', [{ stdout: 'orca-out\n' }]),
    gh: fakeBin(binDir, 'gh', [{ stdout: 'gh-out\n' }]),
  }
  // 저장소는 git 밖 폴더라 주 checkout 이 그 폴더 자신이다. 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다.
  process.env.GIT_CEILING_DIRECTORIES = tmp
  delete process.env.ORCH_DIR
  delete process.env.ORCH_REAL_ORCA
  delete process.env.ORCH_REAL_GH
  process.env.ORCA = fake.orca.path
  process.env.GH = fake.gh.path
})

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(tmp, { recursive: true, force: true })
})

// 테스트마다 다른 저장소를 써서 잠금과 기록이 겹치지 않게 한다.
function makeRepo(): string {
  n += 1
  const repo = join(tmp, `repo-${n}`)
  mkdirSync(repo)
  return repo
}

function handler(repo: string, event: string, body: string): string {
  const dir = join(repo, '.orch/hooks')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${event}.ts`)
  writeFileSync(file, body)
  return file
}

function timeouts(repo: string, table: Record<string, number>): void {
  mkdirSync(join(repo, '.orch'), { recursive: true })
  writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ hooks: { timeouts: table } }))
}

function ctx(repo: string, extra: Partial<FireContext> = {}): { ctx: FireContext; lines: string[] } {
  const lines: string[] = []
  return { ctx: { repo, base: 'main', run: 'run_1', out: (line) => lines.push(line), ...extra }, lines }
}

function log(repo: string): Record<string, unknown>[] {
  const file = join(repo, '.orch/state/hooks.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function lockFile(repo: string, event: string): string {
  return join(repo, '.orch/state/hooks', `${event}.lock`)
}

function deadPid(): number {
  const done = spawnSync(process.execPath, ['-e', ''])
  return done.pid as number
}

function holder(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
}

const PREFIXED = (event: string, line: string) => `[hook ${event}] ${line}`

describe('핸들러 찾기와 종료 코드', () => {
  test('핸들러가 없으면 none 이고 줄도 기록도 없다', async () => {
    const repo = makeRepo()
    const { ctx: c, lines } = ctx(repo)
    const r = await fire('after-merge', { pr: { number: 1 } }, c)
    assert.deepEqual(r, { result: 'none', code: null, reason: '', durationMs: 0 })
    assert.deepEqual(lines, [])
    assert.deepEqual(log(repo), [])
  })

  test('0 은 pass 이고 입력 JSON 과 공통 필드가 stdin 으로 가며 작업 디렉터리는 주 checkout 이다', async () => {
    const repo = makeRepo()
    const file = handler(
      repo,
      'after-merge',
      `import { readFileSync, writeFileSync } from 'node:fs'
writeFileSync('received.json', JSON.stringify({ input: JSON.parse(readFileSync(0, 'utf8')), cwd: process.cwd() }))
`,
    )
    const { ctx: c, lines } = ctx(repo)
    const r = await fire('after-merge', { pr: { number: 7, branch: 'feat/x' }, merge_commit: 'abc' }, c)
    assert.equal(r.result, 'pass', `결과가 pass 가 아니다: ${JSON.stringify(r)} ${lines.join('\n')}`)
    assert.equal(r.code, 0)
    assert.deepEqual(lines, [], 'pass 는 HOOK 줄을 내지 않는다')
    const got = JSON.parse(readFileSync(join(repo, 'received.json'), 'utf8')) as { input: Record<string, unknown>; cwd: string }
    assert.equal(got.cwd, repo)
    const { time, ...rest } = got.input
    assert.deepEqual(rest, { pr: { number: 7, branch: 'feat/x' }, merge_commit: 'abc', version: 1, event: 'after-merge', repo, base: 'main', run: 'run_1' })
    assert.match(String(time), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)

    const entries = log(repo)
    assert.equal(entries.length, 1, `기록이 한 줄이 아니다: ${JSON.stringify(entries)}`)
    const { time: logTime, duration_ms, ...entry } = entries[0]
    assert.deepEqual(entry, { event: 'after-merge', handler: file, exit: 0, result: 'pass', reason: '' })
    assert.equal(typeof duration_ms, 'number')
    assert.match(String(logTime), /Z$/)
    assert.equal(existsSync(lockFile(repo, 'after-merge')), false, '실행 뒤 잠금 파일이 남았다')
  })

  test('거부할 수 있는 이벤트의 10 은 reject 이고 stdout 의 마지막 빈 줄 아닌 줄이 이유다', async () => {
    const repo = makeRepo()
    handler(repo, 'before-merge', `console.log('준비')\nconsole.log('백업이 끝나지 않았다')\nconsole.log('')\nprocess.exit(10)\n`)
    const { ctx: c, lines } = ctx(repo)
    const r = await fire('before-merge', {}, c)
    assert.equal(r.result, 'reject')
    assert.equal(r.code, 10)
    assert.equal(r.reason, '백업이 끝나지 않았다')
    assert.equal(lines.at(-1), 'HOOK-REJECT before-merge 백업이 끝나지 않았다')
    assert.equal(log(repo)[0].result, 'reject')
  })

  test('거부한 핸들러가 빈 줄만 냈거나 아무것도 내지 않았으면 이유는 (이유 없음) 이다', async () => {
    for (const body of [`process.exit(10)\n`, `console.log('')\nconsole.log('   ')\nprocess.exit(10)\n`]) {
      const repo = makeRepo()
      handler(repo, 'before-merge', body)
      const { ctx: c, lines } = ctx(repo)
      const r = await fire('before-merge', {}, c)
      assert.equal(r.result, 'reject', `핸들러 ${JSON.stringify(body)} 가 reject 가 아니다`)
      assert.equal(r.reason, '(이유 없음)')
      assert.equal(lines.at(-1), 'HOOK-REJECT before-merge (이유 없음)')
      assert.equal(log(repo)[0].reason, '(이유 없음)')
    }
  })

  test('거부할 수 없는 이벤트의 10 은 fail 이다', async () => {
    const repo = makeRepo()
    handler(repo, 'after-merge', `console.log('이유')\nprocess.exit(10)\n`)
    const { ctx: c, lines } = ctx(repo)
    const r = await fire('after-merge', {}, c)
    assert.equal(r.result, 'fail')
    assert.equal(r.code, 10)
    assert.equal(lines.at(-1), 'HOOK-FAIL after-merge 10')
  })

  test('잡지 않은 예외로 죽은 핸들러(1)는 거부할 수 있는 이벤트에서도 reject 가 아니라 fail 이고 잠금을 푼다', async () => {
    const repo = makeRepo()
    handler(repo, 'before-cleanup', `throw new Error('터졌다')\n`)
    const { ctx: c, lines } = ctx(repo)
    const r = await fire('before-cleanup', {}, c)
    assert.equal(r.result, 'fail')
    assert.equal(r.code, 1)
    assert.equal(lines.at(-1), 'HOOK-FAIL before-cleanup 1')
    assert.equal(existsSync(lockFile(repo, 'before-cleanup')), false)
  })

  test('핸들러와 legacy 가 함께 있으면 ConfigError 이고 실행하지 않는다', async () => {
    const repo = makeRepo()
    handler(repo, 'before-merge', `require('node:fs').writeFileSync('ran', '')\n`)
    const { ctx: c } = ctx(repo, { legacy: { key: 'queue.before', argv: ['true'], env: {} } })
    await assert.rejects(fire('before-merge', {}, c), ConfigError)
    assert.equal(existsSync(join(repo, 'ran')), false)
  })

  test('hooks.timeouts 에 모르는 이벤트나 양수가 아닌 값이 있으면 ConfigError 다', async () => {
    const repo = makeRepo()
    handler(repo, 'tick', '')
    timeouts(repo, { tikc: 5 })
    await assert.rejects(fire('tick', {}, ctx(repo).ctx), ConfigError)
    timeouts(repo, { tick: 0 })
    await assert.rejects(fire('tick', {}, ctx(repo).ctx), ConfigError)
  })

  test('모르는 이벤트 이름으로 부르면 예외다', async () => {
    await assert.rejects(fire('before-merg', {}, ctx(makeRepo()).ctx), /모르는 이벤트/)
  })
})

describe('handlerFile', () => {
  test('fire 가 부를 핸들러 파일을 내고 없거나 폴더면 null 이다', () => {
    const repo = makeRepo()
    assert.equal(handlerFile('worker-done', repo), null)
    const file = handler(repo, 'worker-done', '')
    assert.equal(handlerFile('worker-done', repo), file)
    mkdirSync(join(repo, '.orch/hooks/worker-lost.ts'))
    assert.equal(handlerFile('worker-lost', repo), null)
  })
})

describe('unknownHandlers', () => {
  test('hooks/ 바로 아래의 모르는 이름의 .ts 만 낸다', () => {
    const repo = makeRepo()
    handler(repo, 'before-merge', '')
    const typo = handler(repo, 'befor-merge', '')
    const extra = handler(repo, 'zz-custom', '')
    writeFileSync(join(repo, '.orch/hooks/notes.md'), '')
    mkdirSync(join(repo, '.orch/hooks/lib'))
    writeFileSync(join(repo, '.orch/hooks/lib/helper.ts'), '')
    mkdirSync(join(repo, '.orch/hooks/dir.ts'))
    assert.deepEqual(unknownHandlers(repo), [typo, extra])
  })

  test('hooks/ 가 없으면 빈 목록이다', () => {
    assert.deepEqual(unknownHandlers(makeRepo()), [])
  })

  test('EVENTS 이름의 파일은 모두 아는 핸들러다', () => {
    const repo = makeRepo()
    for (const event of Object.keys(EVENTS)) handler(repo, event, '')
    assert.deepEqual(unknownHandlers(repo), [])
  })
})

describe('핸들러 환경과 legacy', () => {
  const DUMP = `const e = process.env
console.log(JSON.stringify({ PATH: e.PATH, ORCA: e.ORCA, GH: e.GH, ORCH_REAL_ORCA: e.ORCH_REAL_ORCA ?? null, ORCH_REAL_GH: e.ORCH_REAL_GH ?? null, ORCH_EVENT: e.ORCH_EVENT, ORCH_REPO: e.ORCH_REPO, ORCH_DIR: e.ORCH_DIR }))
`
  function dumped(lines: string[], event: string): Record<string, string | null> {
    const line = lines.find((l) => l.startsWith(PREFIXED(event, '{')))
    assert.ok(line, `환경 줄이 없다: ${lines.join('\n')}`)
    return JSON.parse(line.slice(PREFIXED(event, '').length)) as Record<string, string | null>
  }

  test('PATH 첫 폴더가 가드 폴더이고 ORCA, GH 는 shim, ORCH_REAL_* 는 가드 폴더 밖의 절대경로다', async () => {
    const repo = makeRepo()
    handler(repo, 'tick', DUMP)
    const { ctx: c, lines } = ctx(repo)
    const r = await fire('tick', {}, c)
    assert.equal(r.result, 'pass', lines.join('\n'))
    const env = dumped(lines, 'tick')
    assert.equal(String(env.PATH).split(delimiter)[0], GUARD)
    assert.equal(env.ORCA, join(GUARD, 'orca'))
    assert.equal(env.GH, join(GUARD, 'gh'))
    assert.equal(env.ORCH_REAL_ORCA, fake.orca.path)
    assert.equal(env.ORCH_REAL_GH, fake.gh.path)
    for (const key of ['ORCH_REAL_ORCA', 'ORCH_REAL_GH']) assert.equal(String(env[key]).startsWith(GUARD + sep), false, `${key} 가 가드 폴더 안이다`)
    assert.deepEqual([env.ORCH_EVENT, env.ORCH_REPO, env.ORCH_DIR], ['tick', repo, join(repo, '.orch')])
  })

  test('ORCA 가 이름이면 PATH 에서 가드 폴더를 건너뛰고 찾으며, 찾지 못하면 ORCH_REAL_* 를 넘기지 않는다', async () => {
    const repo = makeRepo()
    handler(repo, 'tick', DUMP)
    const prev = { PATH: process.env.PATH, ORCA: process.env.ORCA, GH: process.env.GH }
    // 바깥 핸들러 안에서 다시 fire 가 불린 상황이다. PATH 맨 앞이 이미 가드 폴더이고 ORCA 는 shim, 남은 ORCH_REAL_GH 가 있다.
    process.env.PATH = `${GUARD}${delimiter}${binDir}${delimiter}${prev.PATH ?? ''}`
    process.env.ORCA = 'orca'
    process.env.GH = 'gh-missing-for-events-spec'
    process.env.ORCH_REAL_GH = '/stale/gh'
    try {
      const { ctx: c, lines } = ctx(repo)
      await fire('tick', {}, c)
      const env = dumped(lines, 'tick')
      assert.equal(env.ORCH_REAL_ORCA, fake.orca.path)
      assert.equal(env.ORCH_REAL_GH, null)
      process.env.ORCA = join(GUARD, 'orca')
      const second = ctx(repo)
      await fire('tick', {}, second.ctx)
      assert.equal(dumped(second.lines, 'tick').ORCH_REAL_ORCA, fake.orca.path, 'ORCA 가 shim 을 가리키면 이름으로 다시 찾는다')
    } finally {
      process.env.PATH = prev.PATH
      process.env.ORCA = prev.ORCA
      process.env.GH = prev.GH
      delete process.env.ORCH_REAL_GH
    }
  })

  test('핸들러가 PATH 로 부른 gh 는 가드를 거친다', async () => {
    const repo = makeRepo()
    handler(
      repo,
      'tick',
      `import { spawnSync } from 'node:child_process'
const merge = spawnSync('gh', ['pr', 'merge', '1'], { encoding: 'utf8' })
const view = spawnSync(process.env.GH, ['pr', 'view', '1'], { encoding: 'utf8' })
console.log(JSON.stringify({ merge: merge.status, view: view.status, out: view.stdout }))
`,
    )
    const { ctx: c, lines } = ctx(repo)
    await fire('tick', {}, c)
    const line = lines.find((l) => l.startsWith(PREFIXED('tick', '{')))
    assert.ok(line, lines.join('\n'))
    assert.deepEqual(JSON.parse(line.slice(PREFIXED('tick', '').length)), { merge: 126, view: 0, out: 'gh-out\n' })
    assert.equal(
      fake.gh.calls().some((call) => call.argv.includes('merge')),
      false,
      '거부한 gh pr merge 가 진짜 gh 로 갔다',
    )
  })

  test('핸들러 없이 legacy 만 주면 DEPRECATED 줄을 내고 legacy.env 가 보이며 시간 제한을 넘기면 timeout 이다', async () => {
    const repo = makeRepo()
    timeouts(repo, { 'after-queue': 1 })
    const argv = [process.execPath, '-e', 'console.log("값=" + process.env.LEGACY_X + " " + process.env.ORCA); console.error("오류 줄"); setInterval(() => {}, 1000)']
    const { ctx: c, lines } = ctx(repo, { legacy: { key: 'queue.after_merged', argv, env: { LEGACY_X: 'legacy-value', ORCA: '/override/orca' } } })
    const r = await fire('after-queue', { merged_prs: [1] }, c)
    assert.equal(r.result, 'timeout')
    assert.equal(r.code, null)
    assert.equal(lines[0], 'DEPRECATED queue.after_merged → hooks/after-queue.ts')
    assert.ok(lines.includes(PREFIXED('after-queue', `값=legacy-value ${join(GUARD, 'orca')}`)), `legacy.env 가 안 보이거나 ORCA 가 덮였다: ${lines.join('\n')}`)
    assert.ok(lines.includes(PREFIXED('after-queue', '오류 줄')))
    assert.equal(lines.at(-1), 'HOOK-FAIL after-queue timeout')
    const [entry] = log(repo)
    assert.deepEqual([entry.handler, entry.result, entry.exit], ['legacy:queue.after_merged', 'timeout', null])
  })
})

describe('시간 제한', { concurrency: true }, () => {
  test('TERM 에 끝나는 핸들러는 1초 제한에 KILL 유예 없이 timeout 이다', async () => {
    const repo = makeRepo()
    timeouts(repo, { 'worker-done': 1 })
    handler(repo, 'worker-done', 'setInterval(() => {}, 1000)\n')
    const { ctx: c, lines } = ctx(repo)
    const r = await fire('worker-done', {}, c)
    assert.equal(r.result, 'timeout')
    assert.equal(r.code, null)
    assert.ok(r.durationMs >= 1000 && r.durationMs < 9000, `걸린 시간 ${r.durationMs}ms 가 1초 이상 9초 미만이 아니다`)
    assert.equal(lines.at(-1), 'HOOK-FAIL worker-done timeout')
  })

  test('TERM 을 무시하는 핸들러는 KILL 로 끝나 timeout 이고 그 손자 프로세스도 끝난다', { timeout: 30_000 }, async (t) => {
    // 운영 기본 KILL 유예는 10초다. 테스트는 1초로 줄여 같은 동작을 본다
    process.env.ORCH_KILL_GRACE_SEC = '1'
    t.after(() => delete process.env.ORCH_KILL_GRACE_SEC)
    const repo = makeRepo()
    timeouts(repo, { 'before-ready': 1 })
    handler(
      repo,
      'before-ready',
      `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
process.on('SIGTERM', () => {})
const child = spawn('sleep', ['60'], { stdio: 'inherit' })
writeFileSync('grandchild.pid', String(child.pid))
setInterval(() => {}, 1000)
`,
    )
    const { ctx: c } = ctx(repo)
    let grandchild = 0
    try {
      const r = await fire('before-ready', {}, c)
      grandchild = Number(readFileSync(join(repo, 'grandchild.pid'), 'utf8'))
      assert.equal(r.result, 'timeout')
      assert.equal(r.code, null)
      assert.ok(r.durationMs >= 2_000, `시간 제한 1초와 KILL 유예 1초를 기다리지 않았다: ${r.durationMs}ms`)
      // 그룹 KILL 직후에는 손자가 아직 거둬지지 않은 좀비라 alive 가 잠시 true 일 수 있다.
      const deadline = Date.now() + 5000
      while (alive(grandchild) && Date.now() < deadline) await sleep(100)
      assert.equal(alive(grandchild), false, `손자 프로세스 ${grandchild} 가 살아 있다`)
    } finally {
      if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL')
    }
  })
})

describe('출력 파이프를 쥔 손자', { concurrency: true }, () => {
  async function gone(pid: number): Promise<boolean> {
    // 그룹 신호 직후에는 손자가 아직 거둬지지 않은 좀비라 alive 가 잠시 true 일 수 있다.
    const deadline = Date.now() + 5000
    while (alive(pid) && Date.now() < deadline) await sleep(100)
    return !alive(pid)
  }

  test('핸들러가 끝났는데 손자가 stdout 을 쥐면 시간 제한까지 기다리지 않고 그룹에 TERM 을 보내며 결과는 핸들러의 종료 코드다', { timeout: 30_000 }, async () => {
    const repo = makeRepo()
    timeouts(repo, { 'before-cleanup': 60 })
    handler(
      repo,
      'before-cleanup',
      `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'] })
writeFileSync('grandchild.pid', String(child.pid))
child.unref()
console.log('백업이 아직 돈다')
process.exitCode = 10
`,
    )
    const { ctx: c, lines } = ctx(repo)
    let grandchild = 0
    try {
      const r = await fire('before-cleanup', {}, c)
      grandchild = Number(readFileSync(join(repo, 'grandchild.pid'), 'utf8'))
      assert.equal(r.result, 'reject', `핸들러의 종료 코드 10 으로 판정하지 않았다: ${JSON.stringify(r)} ${lines.join('\n')}`)
      assert.equal(r.reason, '백업이 아직 돈다')
      assert.ok(r.durationMs < 10_000, `시간 제한 쪽으로 기다렸다: ${r.durationMs}ms`)
      assert.equal(await gone(grandchild), true, `손자 프로세스 ${grandchild} 가 TERM 뒤에도 살아 있다`)
    } finally {
      if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL')
    }
  })

  test('TERM 을 무시하는 손자가 파이프를 쥐면 KILL 로 끝내고 0 은 pass 다', { timeout: 30_000 }, async () => {
    const repo = makeRepo()
    timeouts(repo, { 'worker-done': 60 })
    handler(
      repo,
      'worker-done',
      `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn('sh', ['-c', 'trap "" TERM; sleep 60'], { stdio: ['ignore', 'inherit', 'inherit'] })
writeFileSync('grandchild.pid', String(child.pid))
child.unref()
`,
    )
    const { ctx: c, lines } = ctx(repo)
    let grandchild = 0
    try {
      const r = await fire('worker-done', {}, c)
      grandchild = Number(readFileSync(join(repo, 'grandchild.pid'), 'utf8'))
      assert.equal(r.result, 'pass', `${JSON.stringify(r)} ${lines.join('\n')}`)
      assert.equal(r.code, 0)
      assert.ok(r.durationMs < 10_000, `시간 제한 쪽으로 기다렸다: ${r.durationMs}ms`)
      assert.equal(await gone(grandchild), true, `TERM 을 무시하는 손자 프로세스 ${grandchild} 가 살아 있다`)
    } finally {
      if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL')
    }
  })
})

describe('잠금', { concurrency: true }, () => {
  test('죽은 pid 나 깨진 내용의 잠금은 회수하고 바로 돌며 실행 뒤 잠금 파일이 없다', async () => {
    for (const content of [String(deadPid()), 'garbage']) {
      const repo = makeRepo()
      handler(repo, 'pr-ready', '')
      const lock = lockFile(repo, 'pr-ready')
      mkdirSync(join(lock, '..'), { recursive: true })
      writeFileSync(lock, content)
      const r = await fire('pr-ready', {}, ctx(repo).ctx)
      assert.equal(r.result, 'pass', `잠금 내용 ${content} 에서 pass 가 아니다`)
      assert.ok(r.durationMs < 5000, `회수하지 않고 기다렸다: ${r.durationMs}ms`)
      assert.deepEqual(readdirSync(join(lock, '..')), [], '잠금 파일이나 회수용 파일이 남았다')
    }
  })

  test('회수 중 잠금이 다른 실행의 새 잠금으로 바뀌었으면 그 잠금을 되돌리고 기다리며, 같으면 지우고 다시 만들게 한다', () => {
    const repo = makeRepo()
    const lock = lockFile(repo, 'tick')
    const dir = join(lock, '..')
    mkdirSync(dir, { recursive: true })
    // 이 실행은 죽은 pid 를 읽었는데, 그 사이 다른 실행이 먼저 회수하고 자기 pid 로 새 잠금을 만든 경합이다.
    const stale = String(deadPid())
    writeFileSync(lock, '424242')
    assert.equal(reclaim(lock, stale), 'wait')
    assert.equal(readFileSync(lock, 'utf8'), '424242', '다른 실행의 새 잠금이 되돌려지지 않았다')
    assert.deepEqual(readdirSync(dir), ['tick.lock'], '회수용 파일이 남았다')

    writeFileSync(lock, stale)
    assert.equal(reclaim(lock, stale), 'retry')
    assert.deepEqual(readdirSync(dir), [], '처음 읽은 죽은 잠금이 지워지지 않았다')
  })

  test('살아 있는 pid 의 잠금이 있으면 기다리고 그 잠금을 지운 뒤에 핸들러가 돈다', { timeout: 30_000 }, async () => {
    const repo = makeRepo()
    handler(repo, 'ci-passed', `require('node:fs').writeFileSync('started', String(Date.now()))\n`)
    const lock = lockFile(repo, 'ci-passed')
    mkdirSync(join(lock, '..'), { recursive: true })
    const other = holder()
    try {
      writeFileSync(lock, String(other.pid))
      const pending = fire('ci-passed', {}, ctx(repo).ctx)
      await sleep(1200)
      assert.equal(existsSync(join(repo, 'started')), false, '잠금을 쥔 실행이 있는데 핸들러가 돌았다')
      const removedAt = Date.now()
      unlinkSync(lock)
      const r = await pending
      assert.equal(r.result, 'pass')
      const started = Number(readFileSync(join(repo, 'started'), 'utf8'))
      assert.ok(started > removedAt, `핸들러 시작 ${started} 이 잠금을 지운 ${removedAt} 보다 늦지 않다`)
      assert.equal(existsSync(lock), false)
    } finally {
      other.kill('SIGKILL')
    }
  })

  test('시간 제한과 KILL 유예의 1.5배 안에 잠금을 얻지 못하면 fail 과 HOOK-FAIL lock 이고 남의 잠금은 지우지 않는다', { timeout: 30_000 }, async (t) => {
    // 운영 기본은 시간 제한에 15초(유예 10초의 1.5배)를 더한다. 테스트는 유예를 1초로 줄여 1.5초를 더한다
    process.env.ORCH_KILL_GRACE_SEC = '1'
    t.after(() => delete process.env.ORCH_KILL_GRACE_SEC)
    const repo = makeRepo()
    timeouts(repo, { 'ci-failed': 1 })
    handler(repo, 'ci-failed', `require('node:fs').writeFileSync('started', '')\n`)
    const lock = lockFile(repo, 'ci-failed')
    mkdirSync(join(lock, '..'), { recursive: true })
    const other = holder()
    try {
      writeFileSync(lock, String(other.pid))
      const { ctx: c, lines } = ctx(repo)
      const r = await fire('ci-failed', {}, c)
      assert.equal(r.result, 'fail')
      assert.equal(r.code, null)
      assert.ok(r.durationMs >= 2_500, `2.5초를 기다리지 않았다: ${r.durationMs}ms`)
      assert.equal(lines.at(-1), 'HOOK-FAIL ci-failed lock')
      assert.equal(existsSync(join(repo, 'started')), false)
      assert.equal(readFileSync(lock, 'utf8'), String(other.pid))
      assert.equal(log(repo)[0].result, 'fail')
    } finally {
      other.kill('SIGKILL')
    }
  })
})

describe('출력과 기록', () => {
  test('핸들러의 stdout 줄과 stderr 줄이 모두 [hook <이벤트>] 로 시작해 out 에 온다', async () => {
    const repo = makeRepo()
    handler(repo, 'worker-lost', `process.stdout.write('첫 줄\\n둘째 줄\\r\\n')\nprocess.stderr.write('오류 줄\\n')\nprocess.stdout.write('끝 줄바꿈 없음')\n`)
    const { ctx: c, lines } = ctx(repo)
    const r = await fire('worker-lost', {}, c)
    assert.equal(r.result, 'pass')
    assert.deepEqual(
      [...lines].sort(),
      [PREFIXED('worker-lost', '첫 줄'), PREFIXED('worker-lost', '둘째 줄'), PREFIXED('worker-lost', '오류 줄'), PREFIXED('worker-lost', '끝 줄바꿈 없음')].sort(),
    )
  })

  test('기록을 쓰지 못하면 예외 없이 stderr 에 경고 한 줄을 내고 결과와 HOOK 줄은 그대로다', async (t) => {
    const repo = makeRepo()
    handler(repo, 'before-merge', `console.log('막는다')\nprocess.exit(10)\n`)
    // 기록 파일 자리에 폴더를 두어 쓰기가 EISDIR 로 실패하게 한다. 권한을 빼는 방식은 root 로 돌면 막히지 않는다.
    const file = join(repo, '.orch/state/hooks.jsonl')
    mkdirSync(file, { recursive: true })
    const warned: string[] = []
    t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
      warned.push(String(chunk))
      return true
    })
    const { ctx: c, lines } = ctx(repo)
    const r = await fire('before-merge', {}, c)
    t.mock.restoreAll()
    assert.deepEqual([r.result, r.code, r.reason], ['reject', 10, '막는다'])
    assert.equal(lines.at(-1), 'HOOK-REJECT before-merge 막는다')
    assert.equal(warned.length, 1, `경고가 한 줄이 아니다: ${JSON.stringify(warned)}`)
    assert.match(warned[0], /기록을 쓰지 못했다/)
    assert.ok(warned[0].includes(file), `경고에 기록 파일 경로가 없다: ${warned[0]}`)
    assert.ok(warned[0].endsWith('\n') && warned[0].indexOf('\n') === warned[0].length - 1, `경고가 한 줄이 아니다: ${JSON.stringify(warned[0])}`)
  })

  test('1MB 를 넘은 기록은 hooks.jsonl.1 로 옮기고 새 파일에 한 줄만 있다. 1MB 와 같으면 옮기지 않는다', async () => {
    const big = makeRepo()
    handler(big, 'tick', '')
    mkdirSync(join(big, '.orch/state'), { recursive: true })
    const file = join(big, '.orch/state/hooks.jsonl')
    writeFileSync(file, 'x'.repeat(1_048_577))
    writeFileSync(`${file}.1`, 'old')
    await fire('tick', {}, ctx(big).ctx)
    assert.equal(statSync(`${file}.1`).size, 1_048_577, '넘친 기록이 .1 로 가지 않았다')
    assert.equal(log(big).length, 1)

    const exact = makeRepo()
    handler(exact, 'tick', '')
    mkdirSync(join(exact, '.orch/state'), { recursive: true })
    const same = join(exact, '.orch/state/hooks.jsonl')
    writeFileSync(same, `${'x'.repeat(1_048_575)}\n`)
    await fire('tick', {}, ctx(exact).ctx)
    assert.equal(existsSync(`${same}.1`), false, '1MB 와 같은데 옮겼다')
    assert.ok(statSync(same).size > 1_048_576)
  })
})
