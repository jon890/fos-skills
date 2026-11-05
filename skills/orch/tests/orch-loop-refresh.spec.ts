// orch-loop.ts 의 최신화(머리 주석의 「최신화」)를 가짜 orca, gh, ps, send-to-worker 와 임시 git 저장소(bare origin 과 clone)로 본다.
// Orca 와 GitHub 에는 닿지 않는다. 가짜 gh 는 테스트가 정한 PR 목록을 열린 내 PR 로 내고, update-branch 호출은 기록만 하고 0 으로 끝난다.
// 가짜 ps 는 ps-lines.txt 의 줄만 낸다. 머지 큐의 차례 기록은 테스트가 .orch/state/queue-turn/ 에 직접 둔다.
// 필수 체크는 config.json 의 queue.required 로 주어 CI 감시가 규칙 API 를 부르지 않게 한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin } from './fixtures/fake-bin.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/loop/orch-loop.ts', import.meta.url))

// 질문 조회와 worker-list 에 답하는 가짜 orca. orca.json 의 workers 를 낸다. 확장자 없는 실행 파일이라 타입 문법을 쓰지 않는다
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const st = JSON.parse(fs.readFileSync(process.env.FAKE_DIR + '/orca.json', 'utf8'))
const reply = (result) => process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n')
const sub = process.argv[3]
if (sub === 'worker-list') reply({ workers: st.workers || [], page: {} })
else if (sub === 'check' || sub === 'inbox') reply({ messages: [] })
else reply({})
`

const FAKE_PS = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_DIR + '/ps-lines.txt'
if (fs.existsSync(file)) process.stdout.write(fs.readFileSync(file, 'utf8'))
`

// send-to-worker 대역. 받은 인자를 send.jsonl 에 적고 0 으로 끝난다
const FAKE_SEND = `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_DIR + '/send.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n')
`

const NOOP = 'process.exitCode = 0\n'

type Json = Record<string, unknown>

let binDir: string
let tmp: string
let repo: string
let env: NodeJS.ProcessEnv
let gh: FakeBin

before(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'orch-loop-refresh-bin-')))
  for (const [name, text] of [
    ['orca', FAKE_ORCA],
    ['ps', FAKE_PS],
  ]) {
    writeFileSync(join(binDir, name), text)
    chmodSync(join(binDir, name), 0o755)
  }
  writeFileSync(join(binDir, 'send.ts'), FAKE_SEND)
  writeFileSync(join(binDir, 'noop.ts'), NOOP)
})
after(() => rmSync(binDir, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): string {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
  return done.stdout.trim()
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function commit(cwd: string, files: Record<string, string>, message: string): void {
  for (const [name, body] of Object.entries(files)) write(join(cwd, name), body)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', message)
}

function orchFile(...parts: string[]): string {
  return join(repo, '.orch', ...parts)
}

function config(pipeline: Json = {}, queue: Json = {}): void {
  write(
    orchFile('config.json'),
    JSON.stringify({
      pipeline: { refresh_slots: 3, ...pipeline },
      queue: { required: ['test'], require_up_to_date: true, up_to_date_when: 'overlap', shared_paths: ['^contracts/'], ...queue },
    }),
  )
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-loop-refresh-')))
  gh = fakeBin(tmp, 'gh', [])
  env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ORCA: join(binDir, 'orca'),
    GH: gh.path,
    PS: join(binDir, 'ps'),
    CLEANUP_SWEEP: join(binDir, 'noop.ts'),
    BOARD_SYNC: join(binDir, 'noop.ts'),
    SEND_TO_WORKER: join(binDir, 'send.ts'),
    FAKE_DIR: tmp,
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
  commit(repo, { 'contracts/a.yaml': 'a\n', 'contracts/version.txt': '1\n2\n3\n', 'modules/api/A.java': 'a\n', 'modules/web/W.java': 'w\n' }, 'init')
  git(repo, 'push', '-q', 'origin', 'HEAD:main')
  git(repo, 'remote', 'set-head', 'origin', 'main')
  config()
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

// origin/main 위에 브랜치를 만들어 워크트리에 커밋하고 push 한다. keep 이 false 면 워크트리를 지운다(worker 없는 PR)
function branch(name: string, files: Record<string, string>, keep = true): { path: string; head: string } {
  const path = join(tmp, name)
  git(repo, 'worktree', 'add', '-q', '-b', name, path, 'origin/main')
  commit(path, files, name)
  git(path, 'push', '-q', 'origin', name)
  const head = git(path, 'rev-parse', 'HEAD')
  if (!keep) git(repo, 'worktree', 'remove', '--force', path)
  return { path, head }
}

function advanceMain(files: Record<string, string>): string {
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'pull', '-q', 'origin', 'main')
  commit(repo, files, 'main')
  git(repo, 'push', '-q', 'origin', 'main')
  return git(repo, 'rev-parse', 'HEAD')
}

function passed(): Json[] {
  return [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }]
}

function pending(): Json[] {
  return [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null }]
}

function prs(...rows: { number: number; name: string; head: string; rollup?: Json[]; draft?: boolean }[]): void {
  const list = rows.map((row) => ({
    number: row.number,
    title: `PR ${row.number}`,
    headRefName: row.name,
    headRefOid: row.head,
    isCrossRepository: false,
    isDraft: row.draft ?? false,
    author: { login: 'me' },
    url: `https://github.com/o/r/pull/${row.number}`,
    baseRefName: 'main',
    statusCheckRollup: row.rollup ?? passed(),
  }))
  gh.setRules([
    { args: ['api', 'user'], stdout: 'me\n' },
    { args: ['pr', 'list'], stdout: `${JSON.stringify(list)}\n` },
  ])
}

function workers(rows: { id: string; status: string; path: string }[]): void {
  const list = rows.map((row) => ({
    dispatchId: row.id,
    dispatchStatus: row.status,
    taskId: `task_${row.id}`,
    agentTerminalHandle: `term_${row.id}`,
    resource: { worktreeId: `repo::${row.path}` },
  }))
  writeFileSync(join(tmp, 'orca.json'), JSON.stringify({ workers: list }))
}

function once(): string {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--run', 'r', '--foreground', '--once'], {
    env,
    cwd: tmp,
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(done.status, 0, done.stdout + done.stderr)
  return done.stdout + done.stderr
}

function lines(output: string, kind: string): string[] {
  return output.split('\n').filter((line) => line.startsWith(`${kind} `))
}

// 가짜 gh 가 받은 update-branch 호출의 [PR 번호, expected_head_sha]
function updates(): [number, string][] {
  return gh
    .calls()
    .map((call) => call.argv)
    .filter((argv) => argv.some((arg) => arg.endsWith('/update-branch')))
    .map((argv) => {
      const path = argv.find((arg) => arg.endsWith('/update-branch')) ?? ''
      const head = argv.find((arg) => arg.startsWith('expected_head_sha=')) ?? ''
      return [Number(path.split('/').at(-2)), head.slice('expected_head_sha='.length)]
    })
}

function sends(): string[][] {
  const file = join(tmp, 'send.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]) : []
}

function records(): Record<string, Json> {
  const file = orchFile('state', 'refresh.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Json>) : {}
}

function events(): Json[] {
  const dir = orchFile('state', 'loop-events')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Json))
}

describe('update-branch', () => {
  test('공용 경로가 바뀐 base 에 뒤처진 PR 만 update-branch 하고, 같은 base 에는 다시 걸지 않는다', () => {
    const api = branch('feat-7', { 'modules/api/A.java': 'api\n' })
    const fresh = branch('feat-9', { 'modules/web/W.java': 'web9\n' })
    const base = advanceMain({ 'contracts/a.yaml': 'b\n' })
    // 8 은 base 를 이미 품는다
    const merged = branch('feat-8', { 'modules/web/W.java': 'web8\n' })
    prs({ number: 7, name: 'feat-7', head: api.head }, { number: 8, name: 'feat-8', head: merged.head }, { number: 9, name: 'feat-9', head: fresh.head })
    const output = once()
    // 9 도 공용 경로 때문에 갱신 필요다. 8 은 최신이라 걸지 않는다
    assert.deepEqual(updates(), [
      [7, api.head],
      [9, fresh.head],
    ])
    assert.deepEqual(lines(output, 'REFRESH').length, 2, output)
    assert.match(output, new RegExp(`^REFRESH #7 update-branch base main\\(${base.slice(0, 8)}\\) HEAD ${api.head.slice(0, 8)}: 공용 경로: contracts/a\\.yaml$`, 'm'))
    assert.deepEqual(Object.keys(records()), ['7', '9'])
    assert.equal(records()['7'].base, base)
    assert.equal(records()['7'].from, api.head)
    assert.equal(records()['7'].value, 'updated')
    once()
    assert.equal(updates().length, 2)
  })

  test('up_to_date_when overlap 에서 단위가 겹치지 않으면 걸지 않는다. always 면 건다', () => {
    const web = branch('feat-7', { 'modules/web/W.java': 'web\n' })
    advanceMain({ 'modules/api/A.java': 'api2\n' })
    prs({ number: 7, name: 'feat-7', head: web.head })
    once()
    assert.deepEqual(updates(), [])
    config({}, { up_to_date_when: 'always' })
    once()
    assert.deepEqual(updates(), [[7, web.head]])
  })

  test('CI 가 passed 가 아니거나 draft 면 걸지 않고, CI 는 REFRESH-WAIT 로 남긴다', () => {
    const a = branch('feat-7', { 'modules/api/A.java': 'api\n' })
    const b = branch('feat-8', { 'modules/web/W.java': 'web\n' })
    advanceMain({ 'contracts/a.yaml': 'b\n' })
    prs({ number: 7, name: 'feat-7', head: a.head, rollup: pending() }, { number: 8, name: 'feat-8', head: b.head, draft: true })
    const output = once()
    assert.deepEqual(updates(), [])
    assert.deepEqual(lines(output, 'REFRESH-WAIT'), ['REFRESH-WAIT #7 CI pending(공용 경로: contracts/a.yaml)'])
    assert.deepEqual(records(), {})
  })

  test('최신화 자리가 차면 번호 순으로 그만큼만 건다', () => {
    config({ refresh_slots: 1 })
    const a = branch('feat-7', { 'modules/api/A.java': 'api\n' })
    const b = branch('feat-8', { 'modules/web/W.java': 'web\n' })
    advanceMain({ 'contracts/a.yaml': 'b\n' })
    prs({ number: 8, name: 'feat-8', head: b.head }, { number: 7, name: 'feat-7', head: a.head })
    const output = once()
    assert.deepEqual(updates(), [[7, a.head]])
    assert.deepEqual(lines(output, 'REFRESH-WAIT'), ['REFRESH-WAIT #8 최신화 자리 1/1 가 찼다(공용 경로: contracts/a.yaml)'])
    // 7 의 update 가 아직 HEAD 를 바꾸지 않았으므로 다음 틱도 자리를 쥔다
    once()
    assert.equal(updates().length, 1)
  })
})

describe('머지 큐', () => {
  test('차례 PR 은 건드리지 않고, 큐의 앞 PR 과 겹치는 PR 은 미루고, 겹치지 않는 PR 만 건다', () => {
    const a = branch('feat-7', { 'modules/api/A.java': 'api7\n' })
    const b = branch('feat-8', { 'modules/api/B.java': 'api8\n' })
    const c = branch('feat-9', { 'modules/web/W.java': 'web9\n' })
    advanceMain({ 'contracts/a.yaml': 'b\n' })
    prs({ number: 7, name: 'feat-7', head: a.head }, { number: 8, name: 'feat-8', head: b.head }, { number: 9, name: 'feat-9', head: c.head })
    writeFileSync(join(tmp, 'ps-lines.txt'), '99998 node merge_queue.ts 7 8\n')
    write(orchFile('state', 'queue-turn', '99998.json'), JSON.stringify({ pid: 99998, prs: [7, 8], pr: 7, phase: '체크 대기', since: new Date().toISOString() }))
    const output = once()
    assert.deepEqual(updates(), [[9, c.head]])
    assert.deepEqual(lines(output, 'REFRESH-WAIT'), [
      'REFRESH-WAIT #7 머지 큐의 차례다(공용 경로: contracts/a.yaml)',
      'REFRESH-WAIT #8 머지 큐의 앞 PR #7 이 머지된 뒤 최신화한다(공용 경로: contracts/a.yaml)',
    ])
  })

  test('머지 큐 프로세스가 아닌 pid 의 차례 기록은 보지 않는다', () => {
    const a = branch('feat-7', { 'modules/api/A.java': 'api7\n' })
    advanceMain({ 'contracts/a.yaml': 'b\n' })
    prs({ number: 7, name: 'feat-7', head: a.head })
    write(orchFile('state', 'queue-turn', '99998.json'), JSON.stringify({ pid: 99998, prs: [7], pr: 7, phase: '체크 대기', since: new Date().toISOString() }))
    once()
    assert.deepEqual(updates(), [[7, a.head]])
  })
})

describe('worker 판단', () => {
  test('refresh_worker_paths 의 파일을 양쪽이 바꿨으면 살아 있는 worker 에게 합치기를 보내고, worker 가 없으면 REFRESH-ORPHAN 이다', () => {
    config({ refresh_worker_paths: ['^contracts/version'] })
    const a = branch('feat-7', { 'contracts/version.txt': '1a\n2\n3\n' })
    const b = branch('feat-8', { 'contracts/version.txt': '1b\n2\n3\n' }, false)
    const base = advanceMain({ 'contracts/version.txt': '1\n2\n3c\n' })
    workers([{ id: 'd1', status: 'running', path: a.path }])
    prs({ number: 7, name: 'feat-7', head: a.head }, { number: 8, name: 'feat-8', head: b.head })
    const output = once()
    assert.deepEqual(updates(), [])
    const calls = sends()
    assert.equal(calls.length, 1, JSON.stringify(calls))
    assert.deepEqual(calls[0].slice(0, 3), ['--dispatch', 'd1', '--body'])
    assert.equal(
      calls[0][3],
      `PR #7 이 base main(${base.slice(0, 8)}) 에 뒤처졌다. 양쪽이 바꾼 worker 판단 파일: contracts/version.txt. origin/main 를 합쳐 검증하고 한 번 push 한다. 끝나면 status 로 알린다.`,
    )
    assert.deepEqual(calls[0].slice(4), ['--no-reply', '--run', 'r'])
    assert.match(output, /^REFRESH-WORKER #7 d1 에 합치기를 보냈다: /m)
    assert.match(output, /^REFRESH-ORPHAN #8 워크트리 없음: 양쪽이 바꾼 worker 판단 파일: contracts\/version\.txt$/m)
    assert.equal(records()['7'].value, 'd1')
    assert.equal(records()['8'].value, 'orphan')
    // 같은 base 에는 다시 보내지도 다시 로그를 남기지도 않는다
    const again = once()
    assert.equal(sends().length, 1)
    assert.deepEqual(lines(again, 'REFRESH-ORPHAN'), [])
  })
})

describe('설정', () => {
  test('require_up_to_date 가 false 면 걸지 않고 WATCH-ERROR refresh 를 한 번 쓴다', () => {
    config({}, { require_up_to_date: false })
    const a = branch('feat-7', { 'modules/api/A.java': 'api\n' })
    advanceMain({ 'contracts/a.yaml': 'b\n' })
    prs({ number: 7, name: 'feat-7', head: a.head })
    once()
    once()
    assert.deepEqual(updates(), [])
    const errors = events().filter((row) => row.kind === 'WATCH-ERROR' && String(row.text).startsWith('refresh: '))
    assert.equal(errors.length, 1, JSON.stringify(events()))
  })

  test('refresh_slots 가 0 이면 최신화하지 않고 기록도 만들지 않는다', () => {
    config({ refresh_slots: 0 })
    const a = branch('feat-7', { 'modules/api/A.java': 'api\n' })
    advanceMain({ 'contracts/a.yaml': 'b\n' })
    prs({ number: 7, name: 'feat-7', head: a.head })
    const output = once()
    assert.deepEqual(updates(), [])
    assert.equal(existsSync(orchFile('state', 'refresh.json')), false)
    assert.deepEqual(lines(output, 'REFRESH-WAIT'), [])
  })
})
