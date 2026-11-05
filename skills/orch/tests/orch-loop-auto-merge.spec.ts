// orch-loop.ts 의 자동 머지(머리 주석의 「자동 머지」)를 가짜 gh, orca, ps, 머지 큐로 본다. GitHub 와 Orca 에는 닿지 않는다.
// 저장소는 임시 git 저장소와 bare origin 이고, 루프는 --run 없이 --foreground --once 로 띄워 finish.run(run_t)을 쓴다.
// 가짜 머지 큐(fake-merge-with-finish.ts)는 받은 인자와 자기 pid 를 먼저 적고 FAKE_QUEUE_HOLD_MS 만큼 기다린 뒤 끝 줄과 정리 줄을 낸다.
// 이름에 `merge-with-finish.` 가 들어 루프가 명령줄로 도는 큐를 알아본다.
// 가짜 PS 는 테스트가 정한 줄(ps-lines.txt)과 실제 ps 에서 고른 가짜 큐의 pid 줄을 낸다. 머신의 다른 프로세스는 보이지 않는다.
// 큐는 분리 실행이라 틱이 끝난 뒤에도 돈다. 테스트는 인자 파일이 생기기를, 다시 걸지 않음은 pid 가 끝나기를 기다린 뒤 다음 틱을 돌린다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin, FakeRule } from './fixtures/fake-bin.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/loop/orch-loop.ts', import.meta.url))
const RULES_PATH = 'repos/o/r/rules/branches/main'
const RUN = 'run_t'
const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)
const WAIT_MS = 20_000

// 질문 조회와 worker-list 에 빈 답을 내는 가짜 orca. 확장자 없는 실행 파일이라 타입 문법을 쓰지 않는다
const FAKE_ORCA = `#!/usr/bin/env node
const argv = process.argv.slice(2)
const reply = (result) => process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n')
if (argv[1] === 'worker-list') reply({ workers: [], page: {} })
else if (argv[1] === 'check' || argv[1] === 'inbox') reply({ messages: [] })
else reply({})
`

// 인자와 pid 를 먼저 적고 기다린 뒤 머지 큐처럼 끝 줄 뒤에 정리 줄을 더 낸다
const FAKE_QUEUE = `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_DIR + '/queue-calls.jsonl', JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\\n')
setTimeout(() => {
  process.stdout.write('QUEUE-DONE\\n정리: 워크트리 없음\\n정리: 끝\\n')
}, Number(process.env.FAKE_QUEUE_HOLD_MS || 0))
`

// 테스트가 정한 줄과 가짜 큐의 pid 줄. 확장자 없는 실행 파일이라 타입 문법을 쓰지 않는다
const FAKE_PS = `#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const dir = process.env.FAKE_DIR
if (fs.existsSync(dir + '/ps-lines.txt')) process.stdout.write(fs.readFileSync(dir + '/ps-lines.txt', 'utf8'))
const calls = fs.existsSync(dir + '/queue-calls.jsonl') ? fs.readFileSync(dir + '/queue-calls.jsonl', 'utf8').split('\\n').filter(Boolean) : []
for (const line of calls) {
  const done = spawnSync('ps', ['-o', 'pid=,command=', '-p', String(JSON.parse(line).pid)], { encoding: 'utf8' })
  if (done.status === 0) process.stdout.write(done.stdout)
}
`

// 받은 인자를 버리고 0 으로 끝나는 가짜 명령(정리, 보드 동기화)
const NOOP = 'process.exitCode = 0\n'

type Json = Record<string, unknown>

let binDir: string
let tmp: string
let repo: string
let env: NodeJS.ProcessEnv
let gh: FakeBin

before(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'orch-loop-auto-merge-bin-')))
  for (const [name, text] of [
    ['orca', FAKE_ORCA],
    ['ps', FAKE_PS],
  ]) {
    writeFileSync(join(binDir, name), text)
    chmodSync(join(binDir, name), 0o755)
  }
  writeFileSync(join(binDir, 'fake-merge-with-finish.ts'), FAKE_QUEUE)
  writeFileSync(join(binDir, 'noop.ts'), NOOP)
})
after(() => rmSync(binDir, { recursive: true, force: true }))

function git(args: string[], cwd = repo): void {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-loop-auto-merge-')))
  repo = join(tmp, 'repo')
  mkdirSync(repo)
  gh = fakeBin(tmp, 'gh', [])
  env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ORCA: join(binDir, 'orca'),
    GH: gh.path,
    PS: join(binDir, 'ps'),
    MERGE_WITH_FINISH: join(binDir, 'fake-merge-with-finish.ts'),
    THREADS_CMD: 'f="$FAKE_DIR/threads-$PR"; if [ -f "$f" ]; then cat "$f"; else echo 0; fi',
    CLEANUP_SWEEP: join(binDir, 'noop.ts'),
    BOARD_SYNC: join(binDir, 'noop.ts'),
    FAKE_DIR: tmp,
    // 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다
    GIT_CEILING_DIRECTORIES: tmp,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
  delete env.ORCH_DIR
  delete env.ORCH_LOOP_ALIVE_SEC
  delete env.NODE_OPTIONS
  delete env.FAKE_QUEUE_HOLD_MS
  git(['init', '-q', '-b', 'main'])
  write(join(repo, 'db', 'api', 'V2__a.sql'), 'select 1;\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init'])
  git(['init', '-q', '--bare', '-b', 'main', join(tmp, 'origin.git')], tmp)
  git(['remote', 'add', 'origin', join(tmp, 'origin.git')])
  git(['push', '-q', 'origin', 'main'])
  config()
  spec('specs', 'spec-a.md', ['feat-1'])
})

afterEach(() => {
  // 분리 실행한 가짜 큐를 남기지 않는다
  for (const call of queueCalls()) {
    try {
      process.kill(call.pid, 'SIGKILL')
    } catch {
      // 이미 끝났다
    }
  }
  rmSync(tmp, { recursive: true, force: true })
})

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function orchFile(...parts: string[]): string {
  return join(repo, '.orch', ...parts)
}

function config(extra: { queue?: Json; migrations?: Json; finish?: Json } = {}): void {
  write(
    orchFile('config.json'),
    JSON.stringify({
      finish: { run: RUN, specs_dir: 'specs', ...extra.finish },
      queue: { auto_merge: true, ...extra.queue },
      ...(extra.migrations ? { migrations: extra.migrations } : {}),
    }),
  )
}

function spec(dir: string, name: string, branches: string[], more: string[] = []): void {
  write(join(repo, dir, name), ['# 일', '', ...branches.map((branch) => `- 브랜치: \`${branch}\``), ...more, ''].join('\n'))
}

function passed(): Json[] {
  return [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci.example.com/test' }]
}

function pending(): Json[] {
  return [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null, detailsUrl: 'https://ci.example.com/test' }]
}

function pr(number: number, extra: Json = {}): Json {
  return {
    number,
    author: { login: 'me' },
    url: `https://github.com/o/r/pull/${number}`,
    title: `PR ${number}`,
    headRefName: `feat-${number}`,
    headRefOid: HEAD_A,
    isDraft: false,
    baseRefName: 'main',
    statusCheckRollup: passed(),
    ...extra,
  }
}

function added(...paths: string[]): Json[] {
  return paths.map((path) => ({ path, changeType: 'ADDED', additions: 1, deletions: 0 }))
}

// 이번 실행의 gh 답. views 는 PR 마다의 pr view 답, open 은 마이그레이션을 보는 pr list 의 답, rules 는 저장소 규칙 API 의 답이다
function github(rows: Json[], opts: { views?: Record<number, Json>; open?: Json[]; rules?: FakeRule } = {}): void {
  gh.setRules([
    { args: ['pr', 'list', '--base'], stdout: '[]\n' },
    { args: ['pr', 'list', 'number,headRefName,baseRefName,files'], stdout: `${JSON.stringify(opts.open ?? [])}\n` },
    { args: ['pr', 'list'], stdout: `${JSON.stringify(rows)}\n` },
    ...Object.entries(opts.views ?? {}).map(([n, view]) => ({ args: ['pr', 'view', n], stdout: `${JSON.stringify({ reviews: [], comments: [], files: [], ...view })}\n` })),
    { args: ['pr', 'view'], stdout: `${JSON.stringify({ reviews: [], comments: [], files: [] })}\n` },
    { args: ['api', 'user'], stdout: 'me\n' },
    { stdout: '["test"]\n', ...opts.rules, args: [RULES_PATH] },
  ])
}

function loop(extra: NodeJS.ProcessEnv = {}): { status: number | null; output: string } {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--foreground', '--once'], {
    env: { ...env, ...extra },
    cwd: tmp,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { status: done.status, output: done.stdout + done.stderr }
}

function once(extra: NodeJS.ProcessEnv = {}): string {
  const done = loop(extra)
  assert.equal(done.status, 0, done.output)
  return done.output
}

function jsonl(file: string): Json[] {
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Json)
    : []
}

function events(kind?: string): Json[] {
  const rows = jsonl(orchFile('state', 'loop-events', `${RUN}.jsonl`))
  return kind ? rows.filter((row) => row.kind === kind) : rows
}

function queueCalls(): { pid: number; args: string[] }[] {
  return jsonl(join(tmp, 'queue-calls.jsonl')) as unknown as { pid: number; args: string[] }[]
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function until(what: string, ok: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`${WAIT_MS}ms 안에 ${what} 이 되지 않았다`)
    await sleep(50)
  }
}

// 가짜 큐가 n 번째로 불리기를 기다리고 그 인자를 낸다
async function queued(n = 1): Promise<string[]> {
  await until(`가짜 큐 호출 ${n} 번`, () => queueCalls().length >= n)
  return queueCalls()[n - 1].args
}

function queueArgs(...prs: string[]): string[] {
  return ['--repo', repo, '--run', RUN, '--continue-on-hold', ...prs]
}

function autoMergeState(): Json {
  return JSON.parse(readFileSync(orchFile('state', 'auto-merge.json'), 'utf8')) as Json
}

describe('대상 고르기', () => {
  test('지시서의 브랜치에 든 통과한 PR 만 걸고 AUTO-MERGE 를 쓴다. 지시서 밖, draft, CI pending, 스레드가 남은 PR 은 걸지 않는다', async () => {
    spec('specs', 'spec-a.md', ['feat-1', 'feat-3', 'feat-4', 'feat-5'])
    writeFileSync(join(tmp, 'threads-5'), '1\n')
    github([pr(1), pr(2), pr(3, { isDraft: true }), pr(4, { statusCheckRollup: pending() }), pr(5)])
    const output = once()
    assert.deepEqual(await queued(), queueArgs('1'))
    const [event] = events('AUTO-MERGE')
    assert.equal(event?.pr, null, JSON.stringify(events()))
    assert.match(String(event.text), new RegExp(`^#1 run=${RUN} log=${orchFile('state', 'auto-merge')}/\\d{8}T\\d{6}Z\\.log$`))
    assert.match(output, /AUTO-MERGE-WAIT #3 draft/)
    assert.match(output, /AUTO-MERGE-WAIT #4 CI pending/)
    assert.match(output, /AUTO-MERGE-WAIT #5 미해결 스레드 1/)
    assert.doesNotMatch(output, /AUTO-MERGE-WAIT #2 /)
    const state = autoMergeState()
    assert.deepEqual((state.queue as Json).prs, [1])
    assert.deepEqual(Object.keys(state.tried as Json), [`1@${HEAD_A}`])
  })

  test('이번 틱에 필수 체크 규칙을 읽지 못한 base 의 PR 은 이전 틱의 passed 로 걸지 않는다', () => {
    // 첫 틱은 지시서 보류로 걸지 않고 CI passed 만 loop.json 에 남긴다
    spec('specs', 'spec-a.md', ['feat-1'], ['- 머지 보류: 배포 뒤'])
    github([pr(1)])
    once()
    spec('specs', 'spec-a.md', ['feat-1'])
    github([pr(1)], { rules: { code: 1, stderr: 'HTTP 502: Bad Gateway\n' } })
    const output = once()
    assert.match(output, /AUTO-MERGE-WAIT #1 CI 규칙을 읽지 못했다/)
    assert.deepEqual(events('AUTO-MERGE'), [])
    assert.deepEqual(queueCalls(), [])
  })

  test('queue.auto_merge 가 false 면 가짜 큐를 부르지 않고 기록도 만들지 않는다', () => {
    config({ queue: { auto_merge: false } })
    github([pr(1)])
    once()
    assert.deepEqual(events('AUTO-MERGE'), [])
    assert.equal(existsSync(orchFile('state', 'auto-merge.json')), false)
    assert.deepEqual(queueCalls(), [])
  })

  test('queue.auto_merge 가 참거짓이 아니면 종료 코드 2 다', () => {
    config({ queue: { auto_merge: 'yes' } })
    github([pr(1)])
    const done = loop()
    assert.equal(done.status, 2, done.output)
    assert.match(done.output, /queue\.auto_merge 는 true 나 false 여야 한다/)
  })
})

describe('리뷰', () => {
  const review = { pass: '^통과', block: '^보류' }
  const reviews = (...bodies: string[]) => bodies.map((body, i) => ({ body, submittedAt: `2026-01-0${i + 1}T00:00:00Z`, commit: { oid: HEAD_A } }))

  // repo 의 feat-1 에 커밋을 만들고 origin 에 올린 뒤 그 SHA 를 낸다
  function commit(message: string, file = message): string {
    write(join(repo, file), `${message}\n`)
    // 지시서와 설정은 추적하지 않는다. 브랜치를 바꿀 때 사라지지 않게 그 파일만 더한다
    git(['add', file])
    git(['commit', '-q', '-m', message])
    const done = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', env })
    return done.stdout.trim()
  }

  function push(): void {
    git(['push', '-q', 'origin', 'main', 'feat-1'])
  }

  // feat-1 에서 리뷰할 커밋을 만들고, main 을 한 칸 올린 뒤 feat-1 에 합친다. code 면 합치기 전에 코드 커밋을 하나 더한다
  function mergedAfterReview(code: boolean): { reviewed: string; head: string } {
    git(['checkout', '-q', '-b', 'feat-1'])
    const reviewed = commit('reviewed')
    if (code) commit('code')
    git(['checkout', '-q', 'main'])
    commit('base')
    git(['checkout', '-q', 'feat-1'])
    git(['merge', '-q', '--no-edit', '--no-ff', 'main'])
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', env }).stdout.trim()
    git(['checkout', '-q', 'main'])
    push()
    return { reviewed, head }
  }

  test('마지막 리뷰 본문이 block 이면 걸지 않는다', () => {
    config({ queue: { auto_review: review } })
    github([pr(1)], { views: { 1: { reviews: reviews('통과', '보류: 고칠 것') } } })
    const output = once()
    assert.match(output, /AUTO-MERGE-WAIT #1 리뷰 보류/)
    assert.deepEqual(events('AUTO-MERGE'), [])
    assert.deepEqual(events('AUTO-MERGE-NO-REVIEW'), [])
  })

  test('마지막 리뷰 본문이 pass 면 건다', async () => {
    config({ queue: { auto_review: review } })
    github([pr(1)], { views: { 1: { reviews: reviews('보류: 고칠 것', '통과') } } })
    once()
    assert.deepEqual(await queued(), queueArgs('1'))
  })

  test('옛 HEAD 의 pass 만 있으면 걸지 않고 AUTO-MERGE-NO-REVIEW 를 그 HEAD 에 한 번만 쓴다', () => {
    config({ queue: { auto_review: review } })
    const old = [{ body: '통과', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: HEAD_B } }]
    github([pr(1)], { views: { 1: { reviews: old } } })
    const output = once()
    assert.match(output, /AUTO-MERGE-WAIT #1 리뷰 대기/)
    assert.deepEqual(events('AUTO-MERGE'), [])
    const [event] = events('AUTO-MERGE-NO-REVIEW')
    assert.equal(event?.pr, 1, JSON.stringify(events()))
    assert.match(String(event.text), new RegExp(`^HEAD ${HEAD_A.slice(0, 8)} 에 판정 문구가 든 리뷰가 없다`))
    assert.deepEqual(Object.keys(autoMergeState().unreviewed as Json), [`1@${HEAD_A}`])
    once()
    assert.equal(events('AUTO-MERGE-NO-REVIEW').length, 1, JSON.stringify(events()))
    assert.deepEqual(queueCalls(), [])
  })

  test('리뷰 뒤에 기준 브랜치를 합친 merge 커밋만 있으면 앞 HEAD 의 pass 로 건다', async () => {
    config({ queue: { auto_review: review } })
    const { reviewed, head } = mergedAfterReview(false)
    github([pr(1, { headRefOid: head })], { views: { 1: { reviews: [{ body: '통과', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: reviewed } }] } } })
    once()
    assert.deepEqual(await queued(), queueArgs('1'))
    assert.deepEqual(events('AUTO-MERGE-NO-REVIEW'), [])
  })

  test('리뷰 뒤에 코드 커밋이 섞이면 merge 커밋이 끝이어도 앞 HEAD 의 pass 로 걸지 않는다', () => {
    config({ queue: { auto_review: review } })
    const { reviewed, head } = mergedAfterReview(true)
    github([pr(1, { headRefOid: head })], { views: { 1: { reviews: [{ body: '통과', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: reviewed } }] } } })
    const output = once()
    assert.match(output, /AUTO-MERGE-WAIT #1 리뷰 대기/)
    assert.equal(events('AUTO-MERGE-NO-REVIEW').length, 1, JSON.stringify(events()))
    assert.deepEqual(queueCalls(), [])
  })

  test('커밋이 없는 댓글은 HEAD 커밋 뒤에 쓴 것만 센다', async () => {
    config({ queue: { auto_review: review } })
    git(['checkout', '-q', '-b', 'feat-1'])
    const head = commit('head')
    git(['checkout', '-q', 'main'])
    push()
    const before = [{ body: '통과', createdAt: '2000-01-01T00:00:00Z' }]
    github([pr(1, { headRefOid: head })], { views: { 1: { comments: before } } })
    assert.match(once(), /AUTO-MERGE-WAIT #1 리뷰 대기/)
    const later = [{ body: '통과', createdAt: '2999-01-01T00:00:00Z' }]
    github([pr(1, { headRefOid: head })], { views: { 1: { comments: later } } })
    once()
    assert.deepEqual(await queued(), queueArgs('1'))
  })
})

describe('리뷰 조건 조합', () => {
  const combo = { pass: '^통과', block: '^보류', require: ['verdict-seen', 'last-verdict-pass', 'rereview-after-block'] }

  function commit(message: string): string {
    write(join(repo, message), `${message}\n`)
    git(['add', message])
    git(['commit', '-q', '-m', message])
    return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', env }).stdout.trim()
  }

  test('require 를 적지 않은 설정은 verdict-on-head 와 같아 옛 HEAD 의 pass 로 걸지 않는다', () => {
    config({ queue: { auto_review: { pass: '^통과', block: '^보류' } } })
    github([pr(1)], { views: { 1: { reviews: [{ body: '통과', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: HEAD_B } }] } } })
    assert.match(once(), /AUTO-MERGE-WAIT #1 리뷰 대기/)
    assert.deepEqual(queueCalls(), [])
  })

  test('마지막 판정이 옛 HEAD 의 pass 면 걸고 통과 근거를 AUTO-MERGE-BASIS 로 남긴다', async () => {
    config({ queue: { auto_review: combo } })
    github([pr(1)], { views: { 1: { reviews: [{ body: '통과', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: HEAD_B } }] } } })
    const output = once()
    assert.deepEqual(await queued(), queueArgs('1'))
    const pass = 'pass(커밋 bbbbbbbb, 2026-01-01T00:00:00Z)'
    assert.match(output, new RegExp(`AUTO-MERGE-BASIS #1 HEAD aaaaaaaa verdict-seen ${pass.replace(/[()]/g, '\\$&')}; last-verdict-pass `))
    assert.match(output, /rereview-after-block block 없음/)
  })

  test('판정이 하나도 없으면 걸지 않고 AUTO-MERGE-NO-REVIEW 에 막은 조건을 적는다', () => {
    config({ queue: { auto_review: combo } })
    github([pr(1)], { views: { 1: { comments: [{ body: '감사합니다', createdAt: '2026-01-01T00:00:00Z' }] } } })
    assert.match(once(), /AUTO-MERGE-WAIT #1 리뷰 대기/)
    const [event] = events('AUTO-MERGE-NO-REVIEW')
    assert.match(String(event?.text), new RegExp(`^HEAD ${HEAD_A.slice(0, 8)} 의 PR 에 판정 문구가 든 리뷰가 없다\\(verdict-seen\\)`), JSON.stringify(events()))
    assert.deepEqual(queueCalls(), [])
  })

  test('마지막 판정이 block 이면 그 뒤에 커밋만 있어도 걸지 않는다', () => {
    config({ queue: { auto_review: combo } })
    const reviews = [
      { body: '통과', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: HEAD_B } },
      { body: '보류: 고칠 것', submittedAt: '2026-01-02T00:00:00Z', commit: { oid: HEAD_B } },
    ]
    github([pr(1)], { views: { 1: { reviews } } })
    assert.match(once(), /AUTO-MERGE-WAIT #1 리뷰 보류/)
    assert.deepEqual(events('AUTO-MERGE-NO-REVIEW'), [])
    assert.deepEqual(queueCalls(), [])
  })

  test('block 뒤 새 커밋의 pass 가 있으면 그 뒤 반영 커밋이 있어도 걸고, block 보다 앞 커밋의 늦은 pass 로는 걸지 않는다', async () => {
    config({ queue: { auto_review: combo } })
    git(['checkout', '-q', '-b', 'feat-1'])
    const first = commit('first')
    const fixed = commit('fixed')
    const head = commit('p3')
    git(['checkout', '-q', 'main'])
    git(['push', '-q', 'origin', 'main', 'feat-1'])
    const stale = [
      { body: '보류: 고칠 것', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: fixed } },
      { body: '통과', submittedAt: '2026-01-02T00:00:00Z', commit: { oid: first } },
    ]
    github([pr(1, { headRefOid: head })], { views: { 1: { reviews: stale } } })
    assert.match(once(), new RegExp(`AUTO-MERGE-WAIT #1 재리뷰 대기: block\\(커밋 ${fixed.slice(0, 8)}`))
    assert.deepEqual(queueCalls(), [])
    const rereviewed = [
      { body: '보류: 고칠 것', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: first } },
      { body: '통과', submittedAt: '2026-01-02T00:00:00Z', commit: { oid: fixed } },
    ]
    github([pr(1, { headRefOid: head })], { views: { 1: { reviews: rereviewed } } })
    const output = once()
    assert.deepEqual(await queued(), queueArgs('1'))
    assert.match(output, new RegExp(`rereview-after-block block\\(커밋 ${first.slice(0, 8)}, 2026-01-01T00:00:00Z\\) 뒤 pass\\(커밋 ${fixed.slice(0, 8)}`))
  })

  test('미해결 스레드가 있으면 조합이 통과해도 걸지 않는다', () => {
    config({ queue: { auto_review: combo } })
    write(join(tmp, 'threads-1'), '2\n')
    github([pr(1)], { views: { 1: { reviews: [{ body: '통과', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: HEAD_B } }] } } })
    assert.match(once(), /AUTO-MERGE-WAIT #1 미해결 스레드 2/)
    assert.deepEqual(queueCalls(), [])
  })

  test('모르는 조건 이름이 있으면 루프는 멈추지 않고 그 PR 을 걸지 않으며 이유를 로그에 남긴다', () => {
    config({ queue: { auto_review: { ...combo, require: ['verdict-seen', 'thread-resolved'] } } })
    github([pr(1)], { views: { 1: { reviews: [{ body: '통과', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: HEAD_A } }] } } })
    assert.match(once(), /AUTO-MERGE-WAIT #1 queue\.auto_review\.require 에 모르는 조건이 있다: thread-resolved\./)
    assert.deepEqual(queueCalls(), [])
  })
})

describe('보류 표시', () => {
  test('지시서의 머지 보류 줄이 있으면 걸지 않는다', () => {
    spec('specs', 'spec-a.md', ['feat-1'], ['- 머지 보류: 배포 뒤'])
    github([pr(1)])
    const output = once()
    assert.match(output, /AUTO-MERGE-WAIT #1 지시서 보류: 배포 뒤/)
    assert.deepEqual(events('AUTO-MERGE'), [])
  })

  test('pr 칸에 그 번호가 든 보드 항목에 끝나지 않은 머지 보류 줄이 있으면 걸지 않는다', () => {
    write(
      join(repo, '.omc', 'board.json'),
      JSON.stringify({ items: [{ id: 'job', status: 'doing', pr: '#1', next: [{ text: '머지 보류: 배포 창 대기', done: false }] }] }),
    )
    github([pr(1)])
    const output = once()
    assert.match(output, /AUTO-MERGE-WAIT #1 보드 보류: 머지 보류: 배포 창 대기/)
    assert.deepEqual(events('AUTO-MERGE'), [])
  })

  test('보드 파일이 JSON 이 아니면 걸지 않고 WATCH-ERROR auto-merge 로 알린다', () => {
    write(join(repo, '.omc', 'board.json'), '{')
    github([pr(1)])
    once()
    assert.deepEqual(events('AUTO-MERGE'), [])
    const errors = events('WATCH-ERROR').filter((row) => String(row.text).startsWith('auto-merge: '))
    assert.equal(errors.length, 1, JSON.stringify(events()))
    assert.match(String(errors[0].text), /^auto-merge: 보드를 읽지 못했다/)
  })
})

describe('다시 걸지 않음', () => {
  test('끝난 큐는 AUTO-MERGE-END 로 끝 줄을 알리고 같은 HEAD 는 다시 걸지 않는다. HEAD 가 바뀌면 다시 건다', async () => {
    github([pr(1)])
    once()
    await queued()
    const [first] = queueCalls()
    await until(`가짜 큐 pid ${first.pid} 종료`, () => !alive(first.pid))
    once()
    // 큐는 분리 실행이라 인자 파일이 늦게 생길 수 있다. 틱 안에서 쓰는 AUTO-MERGE 로도 본다
    assert.equal(events('AUTO-MERGE').length, 1, JSON.stringify(events()))
    assert.equal(queueCalls().length, 1)
    const ends = events('AUTO-MERGE-END')
    assert.equal(ends.length, 1, JSON.stringify(events()))
    // 끝 줄 뒤에 정리 줄이 있어도 끝 줄은 QUEUE-DONE 이다
    assert.match(String(ends[0].text), /^QUEUE-DONE log=/)
    assert.equal(autoMergeState().queue, null)
    github([pr(1, { headRefOid: HEAD_B })])
    once()
    assert.deepEqual(await queued(2), queueArgs('1'))
    assert.equal(events('AUTO-MERGE').length, 2)
  })
})

describe('큐가 도는 동안', () => {
  test('루프가 건 큐가 아직 돌면 HEAD 가 바뀌어도 걸지 않고 AUTO-MERGE-END 도 없다', async () => {
    // 테스트가 끝날 때 끝낸다. 두 번째 틱이 끝나기 전에 끝나지 않을 만큼 길게 둔다
    const hold = { FAKE_QUEUE_HOLD_MS: '120000' }
    github([pr(1)])
    once(hold)
    await queued()
    github([pr(1, { headRefOid: HEAD_B })])
    once(hold)
    assert.deepEqual(events('AUTO-MERGE-END'), [])
    assert.equal(events('AUTO-MERGE').length, 1)
    assert.equal(queueCalls().length, 1)
    assert.ok(alive(queueCalls()[0].pid), '가짜 큐가 두 번째 틱 전에 끝났다')
  })

  test('명령줄에 merge_queue. 가 든 프로세스가 있으면 걸지 않는다', () => {
    writeFileSync(join(tmp, 'ps-lines.txt'), '99999 node merge_queue.ts 9\n')
    github([pr(1)])
    const output = once()
    assert.deepEqual(events('AUTO-MERGE'), [])
    assert.equal(autoMergeState().queue, null)
    assert.deepEqual(queueCalls(), [])
    // 차례 기록이 없는 큐는 명령줄을 옮겨 적는다
    assert.match(output, /^AUTO-MERGE-HELD pid 99999 차례 기록 없음: node merge_queue\.ts 9$/m)
  })

  test('묶음 폴더 경로(scripts/queue/merge_queue.ts)로 도는 큐도 merge_queue. 로 가려 걸지 않는다', () => {
    writeFileSync(join(tmp, 'ps-lines.txt'), '99999 node --disable-warning=ExperimentalWarning /p/fos-skills/5.13.0/skills/orch/scripts/queue/merge_queue.ts 9\n')
    github([pr(1)])
    const output = once()
    assert.deepEqual(events('AUTO-MERGE'), [])
    assert.deepEqual(queueCalls(), [])
    assert.match(output, /^AUTO-MERGE-HELD pid 99999 차례 기록 없음: .*\/scripts\/queue\/merge_queue\.ts 9$/m)
  })

  test('큐가 뺀 PR 의 이유를 QUEUE-DROPPED 로 한 번만 옮기고, 끝난 큐의 기록은 옮긴 뒤 지운다', () => {
    writeFileSync(join(tmp, 'ps-lines.txt'), '99998 node merge_queue.ts 9 10\n')
    const since = new Date().toISOString()
    write(
      orchFile('state', 'queue-turn', '99998.json'),
      JSON.stringify({ pid: 99998, prs: [10], pr: 10, phase: '체크 대기', since, held: [{ pr: 9, reason: '9 실패한 체크 1 개' }] }),
    )
    write(orchFile('state', 'queue-turn', '99997.json'), JSON.stringify({ pid: 99997, prs: [], pr: null, phase: '끝', since, held: [{ pr: 8, reason: '8 HOOK-REJECT' }] }))
    github([pr(1)])
    const first = once()
    const dropped = (text: string) => text.split('\n').filter((line) => line.startsWith('QUEUE-DROPPED'))
    assert.deepEqual(dropped(first).sort(), ['QUEUE-DROPPED #8 pid 99997: 8 HOOK-REJECT', 'QUEUE-DROPPED #9 pid 99998: 9 실패한 체크 1 개'])
    assert.equal(existsSync(orchFile('state', 'queue-turn', '99997.json')), false)
    assert.equal(existsSync(orchFile('state', 'queue-turn', '99998.json')), true)
    assert.deepEqual(dropped(once()), [])
  })

  test('도는 큐의 차례 기록이 있으면 무엇을 기다리는지 AUTO-MERGE-HELD 한 줄로 남긴다', () => {
    writeFileSync(join(tmp, 'ps-lines.txt'), '99999 node merge-with-finish.ts 9 10\n99998 node merge_queue.ts 9 10\n')
    const since = new Date(Date.now() - 7 * 60_000).toISOString()
    write(orchFile('state', 'queue-turn', '99998.json'), JSON.stringify({ pid: 99998, prs: [9, 10], pr: 9, phase: 'update-branch 뒤 체크 대기', since }))
    // 머지 큐가 아닌 pid 의 남은 기록은 읽지 않는다
    write(orchFile('state', 'queue-turn', '99997.json'), JSON.stringify({ pid: 99997, prs: [8], pr: 8, phase: '체크 대기', since }))
    github([pr(1)])
    const output = once()
    assert.deepEqual(queueCalls(), [])
    const held = output.split('\n').filter((line) => line.startsWith('AUTO-MERGE-HELD'))
    assert.deepEqual(held, ['AUTO-MERGE-HELD pid 99998 #9 update-branch 뒤 체크 대기 7분 남은 #9 #10'])
  })
})

describe('마이그레이션', () => {
  const dirs = { api: 'db/api' }

  test('watch 전용 Java 폴더의 Flyway 파일도 자동 머지 순서 판정에 넣는다', async () => {
    config({ migrations: { dirs, watch: { api: ['src/main/java/db/migration'] } } })
    const files = added('src/main/java/db/migration/V3__add.java')
    github([pr(1)], { views: { 1: { files } }, open: [{ number: 1, headRefName: 'feat-1', baseRefName: 'main', files }] })
    once()
    assert.deepEqual(await queued(), queueArgs('1'))
  })

  test('base 최고 번호 이하를 더한 PR 은 걸지 않고 MIGRATION-CLASH 를 한 번만 쓴다', () => {
    config({ migrations: { dirs } })
    const files = added('db/api/V1__b.sql')
    github([pr(1)], { views: { 1: { files } }, open: [{ number: 1, headRefName: 'feat-1', baseRefName: 'main', files }] })
    once()
    once()
    assert.deepEqual(
      events('MIGRATION-CLASH').map((row) => [row.pr, row.text]),
      [[1, 'api V1: base 최고 V2 이하']],
    )
    assert.deepEqual(events('AUTO-MERGE'), [])
  })

  test('다른 열린 PR 과 같은 번호면 그 PR 번호로 알린다', () => {
    config({ migrations: { dirs } })
    const files = added('db/api/V3__b.sql')
    github([pr(1)], {
      views: { 1: { files } },
      open: [
        { number: 1, headRefName: 'feat-1', baseRefName: 'main', files },
        { number: 9, headRefName: 'feat-9', baseRefName: 'main', files: added('db/api/V3__other.sql') },
      ],
    })
    once()
    assert.deepEqual(
      events('MIGRATION-CLASH').map((row) => [row.pr, row.text]),
      [[1, 'api V3: #9 과 같은 번호']],
    )
    assert.deepEqual(events('AUTO-MERGE'), [])
  })

  test('같은 모듈의 PR 은 번호 순으로 걸고 --chain 으로 묶는다', async () => {
    config({ migrations: { dirs } })
    spec('specs', 'spec-a.md', ['feat-1', 'feat-2'])
    const views = { 1: { files: added('db/api/V4__x.sql') }, 2: { files: added('db/api/V3__y.sql') } }
    const open = [
      { number: 1, headRefName: 'feat-1', baseRefName: 'main', files: views[1].files },
      { number: 2, headRefName: 'feat-2', baseRefName: 'main', files: views[2].files },
    ]
    // 첫 틱에는 V4 의 PR 만 준비된다. V3 의 PR 을 기다리므로 걸지 않는다
    github([pr(1), pr(2, { statusCheckRollup: pending() })], { views, open })
    once()
    assert.deepEqual(events('AUTO-MERGE'), [])
    github([pr(1), pr(2)], { views, open })
    once()
    assert.deepEqual(await queued(), queueArgs('--chain', '2,1', '2', '1'))
  })

  test('migrations.before 가 있으면 PR 인자에 그 모듈의 머지 전 명령을 붙인다', async () => {
    config({ migrations: { dirs, before: { '*': 'backup {module}' } } })
    const files = added('db/api/V3__y.sql')
    github([pr(1)], { views: { 1: { files } }, open: [{ number: 1, headRefName: 'feat-1', baseRefName: 'main', files }] })
    once()
    assert.deepEqual(await queued(), queueArgs('1:backup api'))
  })

  test('더 낮은 번호의 열린 PR 이 준비되지 않으면 걸지 않고, blocked_after_sec 가 지나면 MIGRATION-BLOCKED 를 한 번 쓴다', async () => {
    config({ migrations: { dirs, blocked_after_sec: 1 } })
    spec('specs', 'spec-a.md', ['feat-1', 'feat-2'])
    const views = { 1: { files: added('db/api/V3__y.sql') }, 2: { files: added('db/api/V4__x.sql') } }
    const open = [
      { number: 1, headRefName: 'feat-1', baseRefName: 'main', files: views[1].files },
      { number: 2, headRefName: 'feat-2', baseRefName: 'main', files: views[2].files },
    ]
    github([pr(1, { statusCheckRollup: pending() }), pr(2)], { views, open })
    once()
    assert.deepEqual(events('MIGRATION-BLOCKED'), [])
    await sleep(2_000)
    once()
    once()
    const blocked = events('MIGRATION-BLOCKED')
    assert.equal(blocked.length, 1, JSON.stringify(events()))
    assert.equal(blocked[0].pr, 2)
    assert.match(
      String(blocked[0].text),
      /^api V4 이 #1 V3 을 \d+분 기다린다\. 막는 쪽 worker 가 \S+ queue reserve --again 으로 번호를 다시 받는다\. 막는 브랜치를 버렸으면 지운 뒤 \S+ queue reserve prune$/,
    )
    assert.deepEqual(events('AUTO-MERGE'), [])
  })
})

describe('마이그레이션 예약', () => {
  const dirs = { api: 'db/api' }

  function reservations(...rows: { branch: string; label: string }[]): void {
    const list = rows.map(({ branch, label }) => ({
      module: 'api',
      version: [Number(label.slice(1))],
      label,
      branch,
      name: 'x',
      path: `db/api/${label}__x.sql`,
      at: '2026-01-01T00:00:00Z',
    }))
    write(orchFile('state', 'migration-reservations.json'), JSON.stringify({ reservations: list }))
  }

  test('PR 이 없는 다른 브랜치의 더 낮은 예약이 있으면 걸지 않고, blocked_after_sec 가 지나면 막는 브랜치와 재예약 명령을 알린다', async () => {
    config({ migrations: { dirs, blocked_after_sec: 1 } })
    reservations({ branch: 'feat/x', label: 'V3' })
    const files = added('db/api/V4__y.sql')
    github([pr(1)], { views: { 1: { files } }, open: [{ number: 1, headRefName: 'feat-1', baseRefName: 'main', files }] })
    const output = once()
    assert.match(output, /AUTO-MERGE-WAIT #1 api V4 이 feat\/x 의 예약 V3 을 기다린다/)
    assert.deepEqual(events('MIGRATION-BLOCKED'), [])
    await sleep(2_000)
    once()
    const blocked = events('MIGRATION-BLOCKED')
    assert.equal(blocked.length, 1, JSON.stringify(events()))
    assert.equal(blocked[0].pr, 1)
    assert.match(String(blocked[0].text), /^api V4 이 feat\/x 의 예약 V3 을 \d+분 기다린다\. /)
    assert.match(String(blocked[0].text), / queue reserve --again/)
    assert.deepEqual(events('AUTO-MERGE'), [])
    assert.deepEqual(queueCalls(), [])
  })

  test('ADR 예약은 같은 모듈 이름의 더 낮은 번호이거나 형식이 틀려도 마이그레이션 판정에 넣지 않는다', async () => {
    config({ migrations: { dirs }, adr: { dirs: { api: 'docs/adr' } } })
    const adr = { module: 'api', version: [3], label: 'ADR-003', branch: 'feat/x', name: 'x', path: 'docs/adr/003-x.md', at: '2026-01-01T00:00:00Z' }
    write(orchFile('state', 'adr-reservations.json'), JSON.stringify({ reservations: [adr, { module: 'api' }] }))
    const files = added('db/api/V4__y.sql')
    github([pr(1)], { views: { 1: { files } }, open: [{ number: 1, headRefName: 'feat-1', baseRefName: 'main', files }] })
    once()
    assert.deepEqual(await queued(), queueArgs('1'))
    assert.deepEqual(events('WATCH-ERROR'), [])
  })

  test('같은 PR 의 브랜치가 예약한 더 낮은 번호는 기다리지 않는다', async () => {
    config({ migrations: { dirs } })
    // 열린 PR 의 파일에 없는 번호라 브랜치로 빼지 않으면 lower 로 잡혀 걸지 않는다
    reservations({ branch: 'feat-1', label: 'V3' })
    const files = added('db/api/V4__x.sql')
    github([pr(1)], { views: { 1: { files } }, open: [{ number: 1, headRefName: 'feat-1', baseRefName: 'main', files }] })
    once()
    assert.deepEqual(await queued(), queueArgs('1'))
    assert.deepEqual(events('MIGRATION-CLASH'), [])
  })

  test('예약한 브랜치의 열린 PR 이 같은 번호를 더했으면 예약을 두 번 세지 않고 둘 다 건다', async () => {
    config({ migrations: { dirs } })
    spec('specs', 'spec-a.md', ['feat-1', 'feat-2'])
    reservations({ branch: 'feat-1', label: 'V3' })
    const views = { 1: { files: added('db/api/V3__x.sql') }, 2: { files: added('db/api/V4__y.sql') } }
    const open = [
      { number: 1, headRefName: 'feat-1', baseRefName: 'main', files: views[1].files },
      { number: 2, headRefName: 'feat-2', baseRefName: 'main', files: views[2].files },
    ]
    github([pr(1), pr(2)], { views, open })
    once()
    assert.deepEqual(await queued(), queueArgs('--chain', '1,2', '1', '2'))
    assert.deepEqual(events('MIGRATION-CLASH'), [])
  })

  function migrationError(): string {
    const errors = events('WATCH-ERROR').filter((row) => String(row.text).startsWith('auto-merge: '))
    assert.equal(errors.length, 1, JSON.stringify(events()))
    return String(errors[0].text)
  }

  test('형식이 틀린 예약 항목이 있으면 마이그레이션이 든 PR 을 걸지 않고 그 수를 알린다', () => {
    config({ migrations: { dirs } })
    write(orchFile('state', 'migration-reservations.json'), JSON.stringify({ reservations: [{ module: 'api', label: 'V3' }] }))
    const files = added('db/api/V4__y.sql')
    github([pr(1)], { views: { 1: { files } }, open: [{ number: 1, headRefName: 'feat-1', baseRefName: 'main', files }] })
    once()
    assert.deepEqual(events('AUTO-MERGE'), [])
    assert.deepEqual(queueCalls(), [])
    assert.match(migrationError(), /auto-merge: 마이그레이션 예약 1 개의 형식이 틀렸다\. \S+ queue reserve prune 으로 뺀다/)
  })

  test('열린 PR 조회가 200 줄이면 목록이 잘렸을 수 있어 마이그레이션이 든 PR 을 걸지 않는다', () => {
    config({ migrations: { dirs } })
    const files = added('db/api/V3__y.sql')
    const open = [
      { number: 1, headRefName: 'feat-1', baseRefName: 'main', files },
      ...Array.from({ length: 199 }, (_, i) => ({ number: 100 + i, headRefName: `feat-${100 + i}`, baseRefName: 'main', files: [] })),
    ]
    github([pr(1)], { views: { 1: { files } }, open })
    once()
    assert.deepEqual(events('AUTO-MERGE'), [])
    assert.deepEqual(queueCalls(), [])
    assert.match(migrationError(), /auto-merge: 열린 PR 이 200 개 이상이라 마이그레이션 목록이 잘렸을 수 있다/)
  })

  test('예약 파일이 JSON 이 아니면 마이그레이션이 든 PR 을 걸지 않고 WATCH-ERROR auto-merge 로 알린다', () => {
    config({ migrations: { dirs } })
    write(orchFile('state', 'migration-reservations.json'), '{')
    const files = added('db/api/V3__y.sql')
    github([pr(1)], { views: { 1: { files } }, open: [{ number: 1, headRefName: 'feat-1', baseRefName: 'main', files }] })
    once()
    assert.deepEqual(events('AUTO-MERGE'), [])
    const errors = events('WATCH-ERROR').filter((row) => String(row.text).startsWith('auto-merge: '))
    assert.equal(errors.length, 1, JSON.stringify(events()))
    assert.match(String(errors[0].text), /auto-merge: 마이그레이션 예약을 읽지 못했다/)
  })
})

describe('막힘 정리', () => {
  test('막혀 기다리던 PR 이 걸 후보에서 빠진 틱에는 blocked 항목을 지운다', () => {
    config({ migrations: { dirs: { api: 'db/api' } } })
    spec('specs', 'spec-a.md', ['feat-1', 'feat-2'])
    const views = { 1: { files: added('db/api/V3__y.sql') }, 2: { files: added('db/api/V4__x.sql') } }
    const open = [
      { number: 1, headRefName: 'feat-1', baseRefName: 'main', files: views[1].files },
      { number: 2, headRefName: 'feat-2', baseRefName: 'main', files: views[2].files },
    ]
    github([pr(1, { statusCheckRollup: pending() }), pr(2)], { views, open })
    once()
    assert.deepEqual(Object.keys(autoMergeState().blocked as Json), ['2'])
    github([pr(1, { statusCheckRollup: pending() }), pr(2, { statusCheckRollup: pending() })], { views, open })
    once()
    assert.deepEqual(autoMergeState().blocked, {})
  })
})

describe('여러 Run', () => {
  test('큐 첫 PR 의 Run 것만 걸고, 다른 Run 의 낮은 번호 PR 을 기다리는 PR 도 뺀다', async () => {
    config({ migrations: { dirs: { api: 'db/api' } }, finish: { specs_dir: 'specs-a' } })
    spec('specs-a', 'spec-a.md', ['feat-1', 'feat-3'])
    spec('specs-b', 'spec-b.md', ['feat-2'])
    write(orchFile('state', 'loop-runs', `${RUN}.json`), JSON.stringify({ run: RUN, specs_dir: 'specs-a', registered_at: '2026-01-01T00:00:00Z' }))
    write(orchFile('state', 'loop-runs', 'run_b.json'), JSON.stringify({ run: 'run_b', specs_dir: 'specs-b', registered_at: '2026-01-02T00:00:00Z' }))
    const views = { 2: { files: added('db/api/V3__y.sql') }, 3: { files: added('db/api/V4__x.sql') } }
    const open = [
      { number: 1, headRefName: 'feat-1', baseRefName: 'main', files: [] },
      { number: 2, headRefName: 'feat-2', baseRefName: 'main', files: views[2].files },
      { number: 3, headRefName: 'feat-3', baseRefName: 'main', files: views[3].files },
    ]
    github([pr(1), pr(2), pr(3)], { views, open })
    once()
    assert.deepEqual(await queued(), queueArgs('1'))
    // 되풀이로 빠진 V4 의 PR 은 blocked 에 두지 않는다
    assert.deepEqual(autoMergeState().blocked, {})
  })
})

// 기능 경로는 리뷰 설정이 없어도 인수·문서 근거를 확인한다.
test('기능 지시서의 근거 누락은 자동 큐를 막고 현재 커밋의 근거로 다시 건다', async () => {
  config({ queue: { auto_review: { pass: 'PASS', block: 'FIX' } } })
  spec('specs', 'spec-a.md', ['feat-1'], ['## 할 일', '루프를 쓴다(스펙: 새로 쓴다)'])
  github([pr(1)], { views: { 1: { body: '', headRefOid: HEAD_A } } })
  const missing = once()
  assert.match(missing, /기능 완료 근거/)
  assert.equal(queueCalls().length, 0)
  const body = `<!-- fos-feature-evidence -->
검증 커밋: ${HEAD_A}
인수 검증: 통과 | REQ1 실제 실행 로그
문서 대조: 통과 | 설계 대조와 후보 없음 근거
독립 리뷰: 통과 | 별도 리뷰 결과
후속 검증: 없음 | 배포 없는 변경
<!-- /fos-feature-evidence -->`
  github([pr(1)], { views: { 1: { body, headRefOid: HEAD_A, reviews: [{ body: 'PASS', commit: { oid: HEAD_A }, submittedAt: '2026-11-04T00:00:00Z' }] } } })
  once()
  await queued(1)
})

test('지시서 없이 본문으로 식별한 기능 PR 도 자동 머지에는 실제 리뷰 정책이 필요하다', () => {
  github([pr(1)], { views: { 1: { body: '<!-- fos-feature-evidence -->', headRefOid: HEAD_A } } })
  const output = once()
  assert.match(output, /queue.auto_review/)
  assert.equal(queueCalls().length, 0)
})
