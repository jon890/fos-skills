// orch-loop.ts 의 충돌 처리를 가짜 orca, gh, send-to-worker 와 임시 git 저장소(bare origin 과 clone)로 본다. Orca 와 GitHub 에는 닿지 않는다.
// 가짜 gh 는 테스트가 정한 PR 목록을 열린 내 PR 로 낸다. 루프의 열린 PR 조회와 충돌 찾기가 같은 목록을 받는다.
// 가짜 send-to-worker 는 받은 인자를 파일에 적고 send.json 이 정한 stdout 과 종료 코드로 끝난다.
// pr-conflict 핸들러는 작업 폴더의 .orch/hooks/ 에 두고 stdin 을 파일에 적게 해서 받은 입력을 본다.
// 필수 체크는 config.json 의 queue.required 로 주고 롤업은 비워, CI 감시가 규칙 API 를 부르거나 알리지 않게 한다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loopStatus } from '../scripts/lib/loop.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin } from './fixtures/fake-bin.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/orch-loop.ts', import.meta.url))
const NOTIFY = fileURLToPath(new URL('../scripts/notify-conflicts.ts', import.meta.url))

// 질문 조회와 worker-list 에 답하는 가짜 orca. orca.json 의 workers 를 내고, workers_fail 이면 worker-list 만 실패한다.
// 확장자 없는 실행 파일이라 타입 문법을 쓰지 않는다
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const dir = process.env.FAKE_DIR
const argv = process.argv.slice(2)
const st = JSON.parse(fs.readFileSync(dir + '/orca.json', 'utf8'))
const reply = (result) => process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n')
const sub = argv[1]
if (sub === 'worker-list' && st.workers_fail) {
  process.stderr.write('worker-list offline\\n')
  process.exit(1)
}
if (sub === 'worker-list') reply({ workers: st.workers || [], page: {} })
else if (sub === 'check' || sub === 'inbox') reply({ messages: [] })
else reply({})
`

// send-to-worker 대역. 받은 인자를 send.jsonl 에 적는다. send.json 의 sleep(초)만큼 자는 동안 send-start 파일을 두고,
// 끝나면 send-end 파일을 둔 뒤 stdout 을 내고 code 로 끝난다
const FAKE_SEND = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const dir = process.env.FAKE_DIR
appendFileSync(dir + '/send.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n')
const st = existsSync(dir + '/send.json') ? JSON.parse(readFileSync(dir + '/send.json', 'utf8')) : {}
writeFileSync(dir + '/send-start', '')
if (st.sleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, st.sleep * 1000)
writeFileSync(dir + '/send-end', '')
if (st.stdout) console.log(st.stdout)
process.exitCode = st.code ?? 0
`

const FAKE_SWEEP = 'process.exitCode = 0\n'

const HOOK = `import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_DIR + '/pr-conflict.jsonl', JSON.stringify(JSON.parse(readFileSync(0, 'utf8'))) + '\\n')
`

type Json = Record<string, unknown>

let binDir: string
let tmp: string
let repo: string
let env: NodeJS.ProcessEnv
let gh: FakeBin
const spawned: ChildProcess[] = []

before(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'orch-loop-conflict-bin-')))
  writeFileSync(join(binDir, 'orca'), FAKE_ORCA)
  chmodSync(join(binDir, 'orca'), 0o755)
  writeFileSync(join(binDir, 'send.ts'), FAKE_SEND)
  writeFileSync(join(binDir, 'sweep.ts'), FAKE_SWEEP)
})
after(() => rmSync(binDir, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): string {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
  return done.stdout.trim()
}

function commit(cwd: string, files: Record<string, string>, message: string): void {
  for (const [name, body] of Object.entries(files)) writeFileSync(join(cwd, name), body)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', message)
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function orchFile(...parts: string[]): string {
  return join(repo, '.orch', ...parts)
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-loop-conflict-')))
  gh = fakeBin(tmp, 'gh', [])
  env = {
    ...process.env,
    // 가짜 orca 의 #! 줄과 핸들러가 이 테스트의 node 를 쓰게 한다
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ORCA: join(binDir, 'orca'),
    GH: gh.path,
    CLEANUP_SWEEP: join(binDir, 'sweep.ts'),
    SEND_TO_WORKER: join(binDir, 'send.ts'),
    FAKE_DIR: tmp,
    // 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다. 로컬의 전역 설정이 결과를 바꾸지 않게 고정한다
    GIT_CEILING_DIRECTORIES: tmp,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
  delete env.ORCH_DIR
  delete env.ORCH_LOOP_ALIVE_SEC
  delete env.NODE_OPTIONS
  delete env.GH_HOST
  writeFileSync(join(tmp, 'orca.json'), '{}')
  git(tmp, 'init', '-q', '--bare', '-b', 'main', join(tmp, 'origin.git'))
  repo = join(tmp, 'repo')
  git(tmp, 'clone', '-q', join(tmp, 'origin.git'), repo)
  commit(repo, { 'a.txt': '1\n2\n3\n', 'b.txt': 'b\n' }, 'init')
  git(repo, 'push', '-q', 'origin', 'HEAD:main')
  write(orchFile('config.json'), JSON.stringify({ queue: { required: ['test'] } }))
  write(orchFile('hooks', 'pr-conflict.ts'), HOOK)
})

afterEach(() => {
  for (const child of spawned.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  rmSync(tmp, { recursive: true, force: true })
})

// origin/main 위에 브랜치를 만들어 워크트리에 커밋하고 push 한다
function branch(name: string, files: Record<string, string>): { path: string; head: string } {
  const path = join(tmp, name)
  git(repo, 'worktree', 'add', '-q', '-b', name, path, 'origin/main')
  commit(path, files, name)
  git(path, 'push', '-q', 'origin', name)
  return { path, head: git(path, 'rev-parse', 'HEAD') }
}

function advanceMain(files: Record<string, string>): void {
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'pull', '-q', 'origin', 'main')
  commit(repo, files, 'main')
  git(repo, 'push', '-q', 'origin', 'main')
}

// 열린 내 PR 목록. 루프의 열린 PR 조회(CI 감시 필드)와 충돌 찾기의 필드를 함께 둔다
function prs(...rows: [number, string, string][]): void {
  const list = rows.map(([number, name, head]) => ({
    number,
    title: `PR ${number}`,
    headRefName: name,
    headRefOid: head,
    isCrossRepository: false,
    isDraft: false,
    author: { login: 'me' },
    url: `https://github.com/o/r/pull/${number}`,
    baseRefName: 'main',
    statusCheckRollup: [],
  }))
  gh.setRules([
    { args: ['api', 'user'], stdout: 'me\n' },
    { args: ['pr', 'list'], stdout: `${JSON.stringify(list)}\n` },
  ])
}

function workers(rows: { id: string; status: string; path: string }[], extra: Json = {}): void {
  const list = rows.map((row) => ({
    dispatchId: row.id,
    dispatchStatus: row.status,
    taskId: `task_${row.id}`,
    agentTerminalHandle: `term_${row.id}`,
    resource: { worktreeId: `repo::${row.path}` },
  }))
  writeFileSync(join(tmp, 'orca.json'), JSON.stringify({ workers: list, ...extra }))
}

function send(value: Json): void {
  writeFileSync(join(tmp, 'send.json'), JSON.stringify(value))
}

// feat(PR 7)이 base 와 a.txt 에서 충돌한다. 그 워크트리의 dispatch d1 의 상태는 status 다
function setupConflict(status: string): string {
  const feat = branch('feat', { 'a.txt': '1\nfeat\n3\n' })
  advanceMain({ 'a.txt': '1\nmain\n3\n' })
  prs([7, 'feat', feat.head])
  workers([{ id: 'd1', status, path: feat.path }])
  return feat.path
}

function loop(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--run', 'r', ...args], {
    env: { ...env, ...extra },
    cwd: tmp,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function once(): void {
  const r = loop(['--foreground', '--once'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
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

function sends(): string[][] {
  return jsonl(join(tmp, 'send.jsonl')) as unknown as string[][]
}

function hookInputs(): Json[] {
  return jsonl(join(tmp, 'pr-conflict.jsonl'))
}

function record(): Record<string, string> {
  const file = orchFile('state', 'notify-conflicts.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {}
}

function baseSha(): string {
  return git(repo, 'rev-parse', 'origin/main')
}

function loopState(): Json | null {
  try {
    return JSON.parse(readFileSync(orchFile('state', 'loop.json'), 'utf8')) as Json
  } catch {
    return null
  }
}

function conflictErrors(): Json[] {
  return events().filter((line) => line.kind === 'WATCH-ERROR' && String(line.text).startsWith('conflicts: '))
}

describe('살아 있는 dispatch', () => {
  test('충돌한 PR 의 살아 있는 dispatch 에 본문을 보내고 notified 로 기록한다', () => {
    setupConflict('running')
    once()
    const calls = sends()
    assert.equal(calls.length, 1, JSON.stringify(calls))
    const [argv] = calls
    assert.deepEqual(argv.slice(0, 3), ['--dispatch', 'd1', '--body'])
    assert.ok(argv[3].startsWith(`PR #7 이 base main(${baseSha().slice(0, 8)}) 와 충돌한다. 충돌 파일: a.txt.`), argv[3])
    assert.deepEqual(argv.slice(4), ['--run', 'r'])
    const [input] = hookInputs()
    assert.equal(input.action, 'notified')
    assert.equal(input.base_head, baseSha())
    assert.deepEqual(input.files, ['a.txt'])
    assert.equal((input.worker as Json).dispatch, 'd1')
    assert.deepEqual(record(), { [`7@${baseSha()}`]: 'd1' })
    assert.deepEqual(events(), [])
  })

  test('같은 (PR, base SHA) 는 다음 틱도 notify-conflicts 도 다시 보내지 않는다', () => {
    setupConflict('running')
    once()
    once()
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', NOTIFY, '--repo', repo, '--base', 'main', '--run', 'r'], { env, encoding: 'utf8' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /^ {2}이미 알렸다\(d1\)$/m)
    assert.equal(sends().length, 1, JSON.stringify(sends()))
    assert.equal(hookInputs().length, 1)
  })
})

describe('끝난 dispatch', () => {
  test('후속 지시서를 써서 --spec 으로 보내고 resumed 로 기록한다', () => {
    const path = setupConflict('completed')
    once()
    const name = `spec-conflict-7-${baseSha().slice(0, 8)}.md`
    const spec = orchFile('specs', name)
    assert.deepEqual(
      readdirSync(orchFile('specs')).filter((file) => file.startsWith('spec-conflict-')),
      [name],
    )
    assert.match(readFileSync(spec, 'utf8'), /^- a\.txt$/m)
    assert.deepEqual(sends(), [['--dispatch', 'd1', '--spec', spec, '--run', 'r']])
    const [input] = hookInputs()
    assert.equal(input.action, 'resumed')
    assert.deepEqual(input.worker, { task: 'task_d1', dispatch: 'd1', terminal: 'term_d1', worktree: path, spec })
    assert.deepEqual(record(), { [`7@${baseSha()}`]: 'd1' })
  })

  test('send-to-worker 가 1 이어도 stdout 에 LAUNCHED 가 있으면 resumed 로 기록한다', () => {
    setupConflict('completed')
    send({ code: 1, stdout: 'LAUNCHED d2' })
    once()
    assert.equal(hookInputs()[0]?.action, 'resumed', JSON.stringify(hookInputs()))
    assert.deepEqual(record(), { [`7@${baseSha()}`]: 'd1' })
    once()
    assert.equal(sends().length, 1)
  })

  test('send-to-worker 가 1 이고 LAUNCHED 줄이 없으면 기록하지 않아 다음 틱이 다시 보낸다', () => {
    setupConflict('completed')
    send({ code: 1, stdout: 'relaunch: 끝난 d1 의 터미널에 새 Task 로 띄운다' })
    once()
    assert.deepEqual(record(), {})
    assert.deepEqual(hookInputs(), [])
    once()
    assert.equal(sends().length, 2)
  })
})

describe('이어 쓰지 못함', () => {
  test('send-to-worker 가 3 이면 CONFLICT-ORPHAN 한 줄을 쓰고 orphan 으로 기록한다', () => {
    setupConflict('running')
    send({ code: 3 })
    once()
    const lines = events()
    assert.equal(lines.length, 1, JSON.stringify(lines))
    assert.equal(lines[0].kind, 'CONFLICT-ORPHAN')
    assert.equal(lines[0].pr, 7)
    assert.match(String(lines[0].text), /^d1 에 보낼 수 없다\(send-to-worker 종료 코드 3\)/)
    assert.equal(hookInputs()[0]?.action, 'orphan')
    assert.deepEqual(record(), { [`7@${baseSha()}`]: 'orphan' })
  })

  test('워크트리가 없으면 보내지 않고 CONFLICT-ORPHAN 이다', () => {
    const path = setupConflict('running')
    git(repo, 'worktree', 'remove', '--force', path)
    once()
    assert.deepEqual(sends(), [])
    assert.deepEqual(
      events().map((line) => [line.kind, line.pr, line.text]),
      [['CONFLICT-ORPHAN', 7, '워크트리 없음. 새 worker 는 띄우지 않는다']],
    )
    const [input] = hookInputs()
    assert.equal(input.action, 'orphan')
    assert.equal(input.worker, null)
    assert.deepEqual(record(), { [`7@${baseSha()}`]: 'orphan' })
  })

  test('worker-list 가 실패하면 기록도 pr-conflict 도 없고 WATCH-ERROR conflicts 한 줄이다', () => {
    const path = setupConflict('running')
    workers([{ id: 'd1', status: 'running', path }], { workers_fail: true })
    once()
    assert.deepEqual(record(), {})
    assert.deepEqual(hookInputs(), [])
    assert.deepEqual(sends(), [])
    const lines = events()
    assert.equal(lines.length, 1, JSON.stringify(lines))
    assert.equal(lines[0].kind, 'WATCH-ERROR')
    assert.match(String(lines[0].text), /^conflicts: worker 목록을 읽지 못했다: .*worker-list offline/)
  })
})

describe('send-to-worker 의 사용법 오류', () => {
  test('그 틱의 다음 충돌 PR 을 보내지 않고 WATCH-ERROR conflicts 한 줄이며, 틱 자식은 결과 줄과 0 이고 루프는 다음 틱을 돈다', async () => {
    const one = branch('feat', { 'a.txt': '1\nfeat\n3\n' })
    const two = branch('feat2', { 'a.txt': '1\nfeat2\n3\n' })
    advanceMain({ 'a.txt': '1\nmain\n3\n' })
    prs([7, 'feat', one.head], [9, 'feat2', two.head])
    workers([
      { id: 'd7', status: 'running', path: one.path },
      { id: 'd9', status: 'running', path: two.path },
    ])
    send({ code: 2 })
    write(orchFile('config.json'), JSON.stringify({ queue: { required: ['test'] }, pipeline: { tick_sec: 0.2 } }))
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--run', 'r', '--foreground'], { env, cwd: tmp })
    spawned.push(child)
    const closed = new Promise((resolve) => child.on('close', resolve))
    const deadline = Date.now() + 40_000
    while (Number(loopState()?.ticks ?? 0) < 2) {
      assert.ok(Date.now() < deadline, `틱이 두 번 돌지 않았다: ${JSON.stringify(loopState())}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    child.kill('SIGTERM')
    await closed
    const dispatches = sends().map((argv) => argv[1])
    assert.ok(dispatches.length >= 2, JSON.stringify(dispatches))
    assert.ok(
      dispatches.every((id) => id === 'd7'),
      JSON.stringify(dispatches),
    )
    assert.equal((loopState()?.errors as Json).conflicts, 'send-to-worker 사용법 오류')
    assert.deepEqual(
      conflictErrors().map((line) => line.text),
      ['conflicts: send-to-worker 사용법 오류'],
    )
    assert.deepEqual(record(), {})
    // 틱 자식 하나만 돌려도 결과 줄을 내고 0 으로 끝난다
    const r = loop(['--tick', '--tick-number', '3'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const last = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Json
    assert.equal((last.errors as Json).conflicts, 'send-to-worker 사용법 오류')
    assert.equal(conflictErrors().length, 1, '같은 이유를 다시 알렸다')
  })
})

describe('생존 타이머', () => {
  test('send-to-worker 를 기다리는 동안 alive_at 이 바뀌고 loopStatus 가 살아 있다고 낸다', async () => {
    setupConflict('running')
    send({ sleep: 3 })
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--run', 'r', '--foreground', '--once'], {
      env: { ...env, ORCH_LOOP_ALIVE_SEC: '0.2' },
      cwd: tmp,
    })
    spawned.push(child)
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    let done = false
    void closed.then(() => (done = true))
    const during: { aliveAt: unknown; alive: boolean }[] = []
    // loopStatus 는 이 프로세스의 ORCH_DIR 로 orch 루트를 찾는다. 루프와 같은 폴더를 보게 둔다
    const saved = process.env.ORCH_DIR
    process.env.ORCH_DIR = orchFile()
    try {
      while (!done) {
        if (existsSync(join(tmp, 'send-start')) && !existsSync(join(tmp, 'send-end'))) {
          const state = loopState()
          if (state) during.push({ aliveAt: state.alive_at, alive: loopStatus(repo, Date.now()).alive })
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    } finally {
      if (saved === undefined) delete process.env.ORCH_DIR
      else process.env.ORCH_DIR = saved
    }
    assert.equal(await closed, 0)
    assert.ok(new Set(during.map((sample) => sample.aliveAt)).size >= 2, JSON.stringify(during))
    assert.ok(
      during.every((sample) => sample.alive),
      JSON.stringify(during),
    )
    assert.equal(hookInputs()[0]?.action, 'notified')
  })
})
