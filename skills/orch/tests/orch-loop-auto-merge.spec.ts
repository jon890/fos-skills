// orch-loop.ts 의 자동 머지(loop/steps/auto-merge.ts 머리 주석의 「자동 머지」)를 가짜 gh, orca, ps, 머지 큐로 본다. GitHub 와 Orca 에는 닿지 않는다.
// 저장소는 임시 git 저장소와 bare origin 이고, 루프는 --run 없이 --foreground --once 로 띄워 finish.run(run_t)을 쓴다.
// 가짜 머지 큐(fake-merge-with-finish.ts)는 받은 인자와 자기 pid 를 먼저 적고 FAKE_QUEUE_HOLD_MS 만큼 기다린 뒤 끝 줄과 정리 줄을 낸다.
// 이름에 `merge-with-finish.` 가 들어 루프가 명령줄로 도는 큐를 알아본다.
// 가짜 PS 는 테스트가 정한 줄(ps-lines.txt)과 실제 ps 에서 고른 가짜 큐의 pid 줄을 낸다. 머신의 다른 프로세스는 보이지 않는다.
// 큐는 분리 실행이라 틱이 끝난 뒤에도 돈다. 테스트는 인자 파일이 생기기를, 다시 걸지 않음은 pid 가 끝나기를 기다린 뒤 다음 틱을 돌린다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin, FakeRule } from './fixtures/fake-bin.ts'
import { linkBin } from '../../../modules/testkit/fake-bin.ts'
import { loopRepo } from './fixtures/orch-loop-repo.ts'
import { queuedNotices } from './fixtures/queued-notices.ts'
import { BOT, BOT_SETTING, receipt } from './fixtures/codex-review.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/loop/orch-loop.ts', import.meta.url))
const FUNCTION_SCRIPT = fileURLToPath(new URL('./fixtures/orch-loop-run.ts', import.meta.url))
const RULES_PATH = 'repos/o/r/rules/branches/main'
const RUN = 'run_t'
const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)
const WAIT_MS = 20_000

// 질문 조회와 worker-list 에 빈 답을 내는 가짜 orca. 확장자 없는 실행 파일이라 타입 문법을 쓰지 않는다
const FAKE_ORCA = `#!/usr/bin/env node
const argv = process.argv.slice(2)
require('node:fs').appendFileSync(process.env.FAKE_DIR + '/orca-calls.jsonl', JSON.stringify(argv) + '\\n')
const reply = (result) => process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n')
if (argv[1] === 'send' && require('node:fs').existsSync(process.env.FAKE_DIR + '/send-fail')) { process.stderr.write('offline\\n'); process.exit(1) }
else if (argv[1] === 'send') reply({ message: { id: 'notice' } })
else if (argv[1] === 'worker-list') reply({ workers: [], page: {} })
else if (argv[1] === 'check' || argv[1] === 'inbox') reply({ messages: [] })
else reply({})
`

// 인자와 pid 를 먼저 적고 기다린 뒤 머지 큐처럼 끝 줄 뒤에 정리 줄을 더 낸다
const FAKE_QUEUE = `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_DIR + '/queue-calls.jsonl', JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\\n')
setTimeout(() => {
  process.stdout.write((process.env.FAKE_QUEUE_SAY || 'QUEUE-DONE') + '\\n정리: 워크트리 없음\\n정리: 끝\\n')
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
    linkBin(binDir, name, text.replace(/^#![^\n]*\n/, ''))
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
    ORCH_MACHINE_DIR: join(tmp, 'machine'),
    // 사용자의 실제 비공개 낱말 목록과 떼어 놓는다(lib/private-words.ts)
    ORCH_PRIVATE_WORDS: join(tmp, 'no-private-words.txt'),
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
  delete env.FAKE_QUEUE_SAY
  loopRepo(repo, { 'db/api/V2__a.sql': 'select 1;\n' })
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
      // 리뷰 설정이 없으면 루프는 어떤 PR 도 걸지 않는다(조건 표의 review-config). 기본은 CI 체크 test 를 리뷰 체크로 본다
      queue: { auto_merge: true, auto_review: { review_checks: ['test'] }, ...extra.queue },
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

// 이번 실행의 gh 답. views 는 PR 마다의 pr view 답, open 은 마이그레이션을 보는 pr list 의 답, rules 는 저장소 규칙 API 의 답이다. failView 는 pr view 가 실패하는 PR 이다
function github(rows: Json[], opts: { views?: Record<number, Json>; open?: Json[]; rules?: FakeRule; botReview?: FakeRule; failView?: number } = {}): void {
  gh.setRules([
    { args: ['pr', 'list', '--base'], stdout: '[]\n' },
    { args: ['pr', 'list', 'number,headRefName,baseRefName,files'], stdout: `${JSON.stringify(opts.open ?? [])}\n` },
    { args: ['pr', 'list'], stdout: `${JSON.stringify(rows)}\n` },
    ...(opts.failView ? [{ args: ['pr', 'view', String(opts.failView)], code: 1, stderr: 'HTTP 502\n' }] : []),
    // pr view 는 그 PR 의 목록 행과 같은 HEAD 와 롤업을 기본으로 낸다. 루프가 읽은 HEAD 를 틱의 HEAD 와 대조한다
    ...[...new Set([...rows.map((row) => String(row.number)), ...Object.keys(opts.views ?? {})])].map((n) => {
      const row = rows.find((one) => String(one.number) === n)
      const base = { reviews: [], comments: [], files: [], ...(row ? { headRefOid: row.headRefOid, statusCheckRollup: row.statusCheckRollup } : {}) }
      return { args: ['pr', 'view', n], stdout: `${JSON.stringify({ ...base, ...opts.views?.[Number(n)] })}\n` }
    }),
    { args: ['pr', 'view'], stdout: `${JSON.stringify({ reviews: [], comments: [], files: [] })}\n` },
    { args: ['api', 'user'], stdout: 'me\n' },
    ...(opts.botReview ? [opts.botReview] : []),
    { stdout: '["test"]\n', ...opts.rules, args: [RULES_PATH] },
  ])
}

function loop(extra: NodeJS.ProcessEnv = {}, targetRepo = repo): { status: number | null; output: string } {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', extra.NODE_OPTIONS ? SCRIPT : FUNCTION_SCRIPT, '--repo', targetRepo, '--foreground', '--once'], {
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
  const rows = jsonl(join(tmp, 'orca-calls.jsonl')).flatMap((args: any) => args[1] === 'send' && args.includes('--payload') ? [{ ...JSON.parse(args[args.indexOf('--payload') + 1]), text: args[args.indexOf('--body') + 1] }] : [])
  const all = [...rows, ...queuedNotices(orchFile())]
  return kind ? all.filter((row) => row.kind === kind) : all
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
  test('체크 없는 PR 은 저장소 설정을 켰을 때 자동 머지 큐에 들어간다', async () => {
    github([pr(1, { statusCheckRollup: [] })], { rules: { stdout: '[]\n' } })
    assert.match(once(), /AUTO-MERGE-WAIT #1 CI pending/)
    assert.deepEqual(queueCalls(), [])

    // 리뷰 체크는 CI 체크와 따로 둔다. 틱의 롤업(CI)은 비었고 PR 조회의 롤업에만 리뷰 체크가 있다
    config({ queue: { allow_no_checks: true, auto_review: { review_checks: ['review'] } } })
    github([pr(1, { statusCheckRollup: [] })], { rules: { stdout: '[]\n' }, views: { 1: { statusCheckRollup: [{ __typename: 'CheckRun', name: 'review', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } })
    once()
    assert.deepEqual(await queued(), queueArgs('1'))
  })

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

  test('CI 실패 알림을 보내지 못해 CI 기록이 이전 passed 로 남은 틱에도 그 틱의 롤업으로 CI failed 를 쓰고 걸지 않는다', () => {
    // 첫 틱은 지시서 보류로 걸지 않고 CI passed 만 loop.json 에 남긴다
    spec('specs', 'spec-a.md', ['feat-1'], ['- 머지 보류: 배포 뒤'])
    github([pr(1)])
    once()
    spec('specs', 'spec-a.md', ['feat-1'])
    writeFileSync(join(tmp, 'send-fail'), '')
    github([pr(1, { statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci.example.com/test' }] })])
    const output = once()
    assert.match(output, /AUTO-MERGE-WAIT #1 CI failed/)
    assert.deepEqual(queueCalls(), [])
  })

  test('스레드 명령이 실패하거나 숫자가 아닌 것을 내면 그 문구를 WATCH-ERROR auto-merge 로 알리고 걸지 않는다', () => {
    const autoErrors = () => events('WATCH-ERROR').filter((row) => String(row.text).startsWith('auto-merge: ')).map((row) => String(row.text))
    spec('specs', 'spec-a.md', ['feat-1', 'feat-2'])
    writeFileSync(join(tmp, 'threads-1'), 'abc\n')
    github([pr(1), pr(2)])
    once({ THREADS_CMD: 'if [ "$PR" = 2 ]; then echo boom >&2; exit 3; fi; cat "$FAKE_DIR/threads-$PR"' })
    assert.deepEqual(autoErrors(), ['auto-merge: #1 의 미해결 스레드를 읽지 못했다(종료 코드 0): abc; #2 의 미해결 스레드를 읽지 못했다(종료 코드 3): boom'])
    assert.deepEqual(queueCalls(), [])
  })

  test('PR 조회가 실패하면 그 문구를 WATCH-ERROR auto-merge 로 알리고 걸지 않는다', () => {
    github([pr(1)], { failView: 1 })
    once()
    const texts = events('WATCH-ERROR').map((row) => String(row.text)).filter((text) => text.startsWith('auto-merge: '))
    assert.equal(texts.length, 1, JSON.stringify(events()))
    assert.match(texts[0], /^auto-merge: #1 의 리뷰와 파일을 읽지 못했다: /)
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

// 사용자 결정 2026-11-24: 리뷰 댓글 문구로 판정하지 않는다. 봇 영수증이나 리뷰 체크(review_checks)만 본다
describe('리뷰', () => {
  const checks = { review_checks: ['claude-review'] }
  const reviewCheck = (conclusion: string) => [{ __typename: 'CheckRun', name: 'claude-review', status: 'COMPLETED', conclusion }]
  const phrases = { reviews: [{ body: '통과', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: HEAD_A } }], comments: [{ body: '판정: 머지 가능', createdAt: '2026-01-01T00:00:00Z' }] }

  test('리뷰 댓글 문구만 있으면 걸지 않고 AUTO-MERGE-NO-REVIEW 를 그 HEAD 에 한 번만 쓴다', () => {
    config({ queue: { auto_review: checks } })
    github([pr(1)], { views: { 1: phrases } })
    const output = once()
    assert.match(output, new RegExp(`AUTO-MERGE-WAIT #1 HEAD ${HEAD_A.slice(0, 8)} 에 리뷰 체크\\(claude-review\\) 성공이 없다`))
    const [event] = events('AUTO-MERGE-NO-REVIEW')
    assert.equal(event?.pr, 1, JSON.stringify(events()))
    assert.match(String(event.text), /봇 영수증이나 리뷰 체크가 이 HEAD 에 생기면 다음 틱이 건다$/)
    assert.deepEqual(Object.keys(autoMergeState().unreviewed as Json), [`1@${HEAD_A}`])
    once()
    assert.equal(events('AUTO-MERGE-NO-REVIEW').length, 1, JSON.stringify(events()))
    assert.deepEqual(queueCalls(), [])
  })

  test('리뷰 체크가 지금 HEAD 에서 success 면 걸고 근거를 AUTO-MERGE-BASIS 로 남긴다. 실패면 걸지 않는다', async () => {
    config({ queue: { auto_review: checks } })
    github([pr(1)], { views: { 1: { statusCheckRollup: reviewCheck('FAILURE') } } })
    assert.match(once(), /AUTO-MERGE-WAIT #1 HEAD .* 리뷰 체크\(claude-review\) 성공이 없다/)
    assert.deepEqual(queueCalls(), [])
    github([pr(1)], { views: { 1: { statusCheckRollup: reviewCheck('SUCCESS') } } })
    assert.match(once(), /AUTO-MERGE-BASIS #1 HEAD aaaaaaaa 리뷰 체크 claude-review success/)
    assert.deepEqual(await queued(), queueArgs('1'))
  })

  // 스펙 DECISION15: 봇의 마지막 리뷰에 P1·P2 지적이 없으면 앞 커밋의 리뷰도 인정한다
  test('앞 커밋의 봇 리뷰는 P1·P2 지적이 있으면 기다리고, 없으면 인정해 큐에 건다', async () => {
    config({ queue: { auto_review: { trusted_bots: [BOT_SETTING] } } })
    const withReceipt = (commit: string, threads: Json[] = []) => {
      const page = (nodes: Json[] = []) => ({ nodes, pageInfo: { hasNextPage: false } })
      const pullRequest = { headRefOid: HEAD_A, comments: page([receipt(commit)]), reviews: page(), reviewThreads: page(threads) }
      github([pr(1)], { views: { 1: phrases }, botReview: { args: ['api', 'graphql', 'readThreads=true'], stdout: JSON.stringify({ data: { repository: { pullRequest } } }) } })
    }
    const finding = (level: number) => ({ isResolved: true, comments: { nodes: [{ author: BOT, createdAt: '2026-01-01T00:02:00Z', body: `**<sub><sub>![P${level} Badge](https://img.shields.io/badge/P${level}-yellow?style=flat)</sub></sub>  제목**`, originalCommit: { oid: HEAD_B } }] } })
    withReceipt(HEAD_B, [finding(2)])
    assert.match(once(), /AUTO-MERGE-WAIT #1 chatgpt-codex-connector 봇이 P1·P2 지적을 남겼다/)
    assert.deepEqual(queueCalls(), [])

    withReceipt(HEAD_B, [finding(3)])
    assert.match(once(), /AUTO-MERGE-BASIS #1 .*봇 영수증 chatgpt-codex-connector\(커밋 bbbbbbbb, .*앞 리뷰 인정\(P1·P2 없음\)\)/)
    assert.deepEqual(await queued(), queueArgs('1'))
  })

  test('옛 문구 판정 키만 있으면 리뷰 설정이 없는 것과 같아 걸지 않는다', () => {
    config({ queue: { auto_review: { pass: '^통과', block: '^보류', require: ['verdict-seen'] } } })
    github([pr(1)], { views: { 1: { reviews: [{ body: '통과', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: HEAD_A } }] } } })
    assert.match(once(), /AUTO-MERGE-WAIT #1 자동 머지는 queue\.auto_review 의 trusted_bots 나 review_checks 가 필요하다/)
    assert.deepEqual(queueCalls(), [])
  })

  // REQ6: 루프의 PR 조회가 돌려준 HEAD 가 틱의 HEAD 와 다르면 그 판단을 통과로 보지 않는다
  test('PR 조회가 다른 HEAD 를 돌려주면 리뷰 체크가 통과해도 걸지 않고 HEAD 가 바뀌었다로 기다린다', () => {
    config({ queue: { auto_review: checks } })
    github([pr(1)], { views: { 1: { headRefOid: HEAD_B, statusCheckRollup: reviewCheck('SUCCESS') } } })
    assert.match(once(), /AUTO-MERGE-WAIT #1 HEAD 가 바뀌었다/)
    assert.deepEqual(queueCalls(), [])
  })

  test('미해결 스레드가 있으면 리뷰 체크가 통과해도 걸지 않는다', () => {
    config({ queue: { auto_review: checks } })
    write(join(tmp, 'threads-1'), '2\n')
    github([pr(1)], { views: { 1: { statusCheckRollup: reviewCheck('SUCCESS') } } })
    assert.match(once(), /AUTO-MERGE-WAIT #1 미해결 스레드 2/)
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

  test('PR 본문에만 머지 보류 줄이 있어도 걸지 않는다', () => {
    spec('specs', 'spec-a.md', ['feat-1'])
    github([pr(1)], { views: { 1: { body: '## 요약\n\n- 머지 보류: 본문의 배포 대기\n' } } })
    const output = once()
    assert.match(output, /AUTO-MERGE-WAIT #1 PR 본문 보류: 본문의 배포 대기/)
    assert.deepEqual(events('AUTO-MERGE'), [])
    assert.deepEqual(queueCalls(), [])
  })

  // 코디네이터가 허락한 범위(2026-11-21): 목록에 걸린 보류 이유는 값 없이 위치만 로그에 남긴다. 걸리지 않은 이유는 위 테스트처럼 그대로다.
  // 가상 낱말만 쓴다
  test('보류 이유에 비공개 낱말이 있으면 루프 로그에 값 대신 위치를 쓴다', () => {
    const home = join(tmp, 'home')
    mkdirSync(join(home, '.config', 'orch'), { recursive: true })
    writeFileSync(join(home, '.config', 'orch', 'private-words.txt'), 'example-secret\n')
    github([pr(1)], { views: { 1: { body: '## 요약\n\n- 머지 보류: example-secret 서버 확인 전\n' } } })
    const words = { ORCH_PRIVATE_WORDS: join(home, '.config', 'orch', 'private-words.txt') }
    const body = once(words)
    assert.match(body, /AUTO-MERGE-WAIT #1 PR 본문 보류: 비공개 낱말이 있어 값을 생략한다\(PR 본문 3번째 줄\)/)
    spec('specs', 'spec-a.md', ['feat-1'], ['- 머지 보류: EXAMPLE-SECRET 배포 뒤'])
    const held = once(words)
    assert.match(held, /AUTO-MERGE-WAIT #1 지시서 보류: 비공개 낱말이 있어 값을 생략한다\(지시서 \d+번째 줄\)/)
    for (const output of [body, held]) assert.ok(!output.toLowerCase().includes('example-secret'), output)
    assert.deepEqual(queueCalls(), [])
  })

  test('지시서에도 보류가 있으면 지시서 이유가 먼저다', () => {
    spec('specs', 'spec-a.md', ['feat-1'], ['- 머지 보류: 지시서 이유'])
    github([pr(1)], { views: { 1: { body: '- 머지 보류: 본문 이유' } } })
    assert.match(once(), /AUTO-MERGE-WAIT #1 지시서 보류: 지시서 이유/)
  })

  test('워크트리에서 부른 루프도 상대경로 지시서는 주 checkout 에서 읽는다', async () => {
    config({ finish: { specs_dir: 'custom-specs' } })
    spec('custom-specs', 'spec-a.md', ['feat-1'], ['- 머지 보류: 주 checkout 의 배포 확인 대기'])
    const worktree = join(tmp, 'worker')
    git(['worktree', 'add', '--detach', worktree, 'HEAD'])
    // 같은 상대경로에 보류 없는 지시서가 있어도 주 checkout 의 지시서가 기준이다.
    write(join(worktree, 'custom-specs', 'spec-a.md'), '- 브랜치: `feat-1`\n')
    github([pr(1)])
    const held = loop({}, worktree)
    assert.equal(held.status, 0, held.output)
    assert.match(held.output, /AUTO-MERGE-WAIT #1 지시서 보류: 주 checkout 의 배포 확인 대기/)
    assert.deepEqual(events('AUTO-MERGE'), [])
    assert.deepEqual(queueCalls(), [])
    spec('custom-specs', 'spec-a.md', ['feat-1'])
    const released = loop({}, worktree)
    assert.equal(released.status, 0, released.output)
    assert.deepEqual(await queued(), queueArgs('1'))
  })

  test('pr 칸에 그 번호가 든 보드 항목에 끝나지 않은 머지 보류 줄이 있으면 걸지 않는다', () => {
    config({ finish: { board: 'chosen.json' } })
    write(
      join(repo, 'chosen.json'),
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

  test('등록한 지시서 폴더를 읽지 못한 틱에는 자동 머지를 걸지 않는다', () => {
    write(join(repo, 'unreadable-specs'), '')
    write(orchFile('state', 'loop-runs', 'run_b.json'), JSON.stringify({ run: 'run_b', specs_dir: 'unreadable-specs', registered_at: '2026-01-02T00:00:00Z' }))
    github([pr(1)])
    once()
    assert.deepEqual(events('AUTO-MERGE'), [])
    assert.ok(events('WATCH-ERROR').some((row) => /^auto-merge: 지시서를 읽지 못해 머지 보류를 확인할 수 없다/.test(String(row.text))))
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

// 큐가 실행권을 잡지 못해 아무것도 걸지 않고 끝난 경우다(lib/pr-claim.ts 의 QUEUE-DUP, QUEUE-CLAIM-FAIL)
describe('걸지 못하고 끝난 큐', () => {
  // PR 558 리뷰: 일시 실패로 걸지 못했는데 tried 가 남아, 잠금이 풀린 뒤에도 `이미 건 HEAD` 로 멈췄다
  test('실행권을 확인하지 못해 끝난 큐(QUEUE-CLAIM-FAIL)의 PR 은 tried 를 지워 같은 HEAD 로 다시 건다', async () => {
    github([pr(1)])
    once({ FAKE_QUEUE_SAY: 'QUEUE-CLAIM-FAIL 다른 머지 큐가 이 PR 을 맡았는지 확인하지 못해 아무것도 걸지 않았다' })
    await queued()
    const [first] = queueCalls()
    await until(`가짜 큐 pid ${first.pid} 종료`, () => !alive(first.pid))
    once()
    const ends = events('AUTO-MERGE-END')
    assert.equal(ends.length, 1, JSON.stringify(events()))
    assert.match(String(ends[0].text), /^QUEUE-CLAIM-FAIL .* log=/)
    assert.deepEqual(await queued(2), queueArgs('1'))
    assert.equal(events('AUTO-MERGE').length, 2)
  })

  // PR 568 리뷰: PR 을 쥔 큐도 다른 PR 에서 막혀 물러나면, QUEUE-DUP 을 받은 PR 을 아무도 맡지 않는다
  test('다른 큐가 쥐고 있어 물러난 큐(QUEUE-DUP)의 PR 도 tried 를 지워, 함께 걸었던 PR 과 같이 다시 건다', async () => {
    spec('specs', 'spec-a.md', ['feat-1', 'feat-2'])
    github([pr(1), pr(2)])
    once({ FAKE_QUEUE_SAY: 'QUEUE-DUP 1 이미 진행 중이다: pid 4242 2026-11-20T00:00:00.000Z queue merge run=run_other' })
    assert.deepEqual(await queued(), queueArgs('1', '2'))
    const [first] = queueCalls()
    await until(`가짜 큐 pid ${first.pid} 종료`, () => !alive(first.pid))
    once()
    assert.match(String(events('AUTO-MERGE-END')[0]?.text), /^QUEUE-DUP 1 /)
    assert.deepEqual(await queued(2), queueArgs('1', '2'))
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
    // 뺀 PR 번호와 이유를 바로 보내고, 같은 PR 의 같은 이유는 큐를 다시 돌려도 한 번만 보낸다
    assert.deepEqual(events('QUEUE-DROPPED').map((row) => [row.pr, row.text]).sort(), [[8, '#8 8 HOOK-REJECT'], [9, '#9 9 실패한 체크 1 개']])
    write(orchFile('state', 'queue-turn', '99997.json'), JSON.stringify({ pid: 99997, prs: [], pr: null, phase: '끝', since, held: [{ pr: 8, reason: '8 HOOK-REJECT' }] }))
    once()
    assert.equal(events('QUEUE-DROPPED').length, 2)
  })

  test('끝난 큐의 QUEUE-DROPPED 전송이 실패하면 차례 기록을 남겨 다음 틱이 다시 보낸다', () => {
    writeFileSync(join(tmp, 'ps-lines.txt'), '')
    const since = new Date().toISOString()
    const turn = orchFile('state', 'queue-turn', '99997.json')
    write(turn, JSON.stringify({ pid: 99997, prs: [], pr: null, phase: '끝', since, held: [{ pr: 8, reason: '8 HOOK-REJECT' }] }))
    github([pr(1)])
    writeFileSync(join(tmp, 'send-fail'), '')
    once()
    assert.equal(existsSync(turn), true)
    assert.equal(events('QUEUE-DROPPED').length, 1, '실패한 전송 시도 하나')
    rmSync(join(tmp, 'send-fail'))
    once()
    assert.equal(existsSync(turn), false)
    assert.deepEqual(events('QUEUE-DROPPED').map((row) => row.pr), [8, 8], '다음 틱이 다시 보낸다')
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

// 기능 PR 도 본문의 완료 근거 블록을 읽지 않는다. 리뷰 판정이 지금 HEAD 에 있으면 건다(사용자 결정 2026-11-24)
test('기능 지시서의 PR 은 본문에 완료 근거 블록이 없어도 지금 HEAD 의 리뷰 체크로 자동 큐에 건다', async () => {
  config({ queue: { auto_review: { review_checks: ['claude-review'] } } })
  spec('specs', 'spec-a.md', ['feat-1'], ['## 할 일', '루프를 쓴다(스펙: 새로 쓴다)'])
  github([pr(1)], { views: { 1: { body: '', headRefOid: HEAD_A, statusCheckRollup: [{ __typename: 'CheckRun', name: 'claude-review', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } })
  const output = once()
  assert.doesNotMatch(output, /기능 완료 근거/)
  await queued(1)
})

// REQ5: 리뷰 설정이 없으면 기능 PR 인지와 관계없이 걸지 않는다. 이 조건은 스레드 명령과 PR 조회 앞에서 본다(설계 DECISION11)
test('리뷰 설정(trusted_bots, review_checks)이 없으면 기능 PR 이 아니어도 걸지 않고 스레드와 PR 조회를 부르지 않는다', () => {
  config({ queue: { auto_review: { pass: 'PASS', block: 'FIX' } } })
  write(join(tmp, 'threads-1'), '2\n')
  github([pr(1)])
  const output = once()
  assert.match(output, /AUTO-MERGE-WAIT #1 자동 머지는 queue\.auto_review 의 trusted_bots 나 review_checks 가 필요하다/)
  assert.doesNotMatch(output, /AUTO-MERGE-WAIT #1 기능 /)
  assert.equal(queueCalls().length, 0)
  assert.deepEqual(gh.calls().map((call) => call.argv).filter((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === '1'), [])
})

test('지시서 없는 PR 은 본문에 근거 블록 표시가 있어도 기능 PR 로 보지 않는다', async () => {
  github([pr(1)], { views: { 1: { body: '<!-- fos-feature-evidence -->', headRefOid: HEAD_A } } })
  const output = once()
  assert.doesNotMatch(output, /trusted_bots 나 review_checks 가 필요하다/)
  await queued(1)
})
