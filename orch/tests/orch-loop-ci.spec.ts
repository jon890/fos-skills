// orch-loop.ts 의 CI 감시를 가짜 gh, orca, send-to-worker 로 본다. GitHub 와 Orca 에는 닿지 않는다.
// --foreground --once 를 여러 번 돌린다. 한 번이 틱 하나이고, 루프 상태(loop.json 의 ci)가 다음 실행으로 이어진다.
// 가짜 gh 는 실행마다 테스트가 정한 PR 목록(롤업 포함)과 저장소 규칙을 낸다. 가짜 send-to-worker 는 받은 인자를 파일에 적고 정한 코드로 끝난다.
// ci-passed, ci-failed 핸들러는 작업 폴더의 .orch/hooks/ 에 두고 stdin 을 파일에 적게 해서 받은 입력을 본다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin, FakeRule } from './fixtures/fake-bin.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/orch-loop.ts', import.meta.url))
const RULES_PATH = 'repos/o/r/rules/branches/main'
const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)

// 질문 조회와 worker-list 에 답하는 가짜 orca. worker-list 는 orca.json 의 workers 를 낸다. 확장자 없는 실행 파일이라 타입 문법을 쓰지 않는다
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const dir = process.env.FAKE_DIR
const argv = process.argv.slice(2)
fs.appendFileSync(dir + '/orca-calls.jsonl', JSON.stringify(argv) + '\\n')
const st = JSON.parse(fs.readFileSync(dir + '/orca.json', 'utf8'))
const reply = (result) => process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n')
const sub = argv[1]
if (sub === 'worker-list') reply({ workers: st.workers || [], page: {} })
else if (sub === 'check' || sub === 'inbox') reply({ messages: [] })
else reply({})
`

// 받은 인자를 <이름>.jsonl 에 적고 <이름>.json 의 code 로 끝나는 가짜 명령
function fakeScript(name: string): string {
  return `import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const dir = process.env.FAKE_DIR
appendFileSync(dir + '/${name}.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n')
const st = existsSync(dir + '/${name}.json') ? JSON.parse(readFileSync(dir + '/${name}.json', 'utf8')) : {}
process.exitCode = st.code ?? 0
`
}

function handler(event: string): string {
  return `import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync(process.env.RECEIVED_DIR + '/${event}.jsonl', readFileSync(0, 'utf8') + '\\n')
`
}

type Json = Record<string, unknown>

let binDir: string
let tmp: string
let repo: string
let env: NodeJS.ProcessEnv
let gh: FakeBin

before(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'orch-loop-ci-bin-')))
  writeFileSync(join(binDir, 'orca'), FAKE_ORCA)
  chmodSync(join(binDir, 'orca'), 0o755)
  writeFileSync(join(binDir, 'sweep.ts'), fakeScript('sweep'))
  writeFileSync(join(binDir, 'send.ts'), fakeScript('send'))
})
after(() => rmSync(binDir, { recursive: true, force: true }))

function git(args: string[], cwd = repo): void {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-loop-ci-')))
  repo = join(tmp, 'repo')
  mkdirSync(join(tmp, 'received'), { recursive: true })
  mkdirSync(repo)
  gh = fakeBin(tmp, 'gh', [])
  env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ORCA: join(binDir, 'orca'),
    GH: gh.path,
    CLEANUP_SWEEP: join(binDir, 'sweep.ts'),
    SEND_TO_WORKER: join(binDir, 'send.ts'),
    FAKE_DIR: tmp,
    RECEIVED_DIR: join(tmp, 'received'),
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
  git(['init', '-q', '-b', 'main'])
  git(['commit', '-q', '--allow-empty', '-m', 'init'])
  // 틱의 충돌 처리가 git fetch origin 을 하므로 origin 을 둔다. 충돌을 보는 gh pr list --base 는 빈 목록이다(github())
  git(['init', '-q', '--bare', '-b', 'main', join(tmp, 'origin.git')], tmp)
  git(['remote', 'add', 'origin', join(tmp, 'origin.git')])
  git(['push', '-q', 'origin', 'main'])
  writeFileSync(join(tmp, 'orca.json'), JSON.stringify({}))
  hook('ci-passed')
  hook('ci-failed')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function orchFile(...parts: string[]): string {
  return join(repo, '.orch', ...parts)
}

function hook(event: string): void {
  write(orchFile('hooks', `${event}.ts`), handler(event))
}

function config(value: Json): void {
  write(orchFile('config.json'), JSON.stringify(value))
}

function check(name: string, conclusion: string | null, status = 'COMPLETED'): Json {
  return { __typename: 'CheckRun', name, status, conclusion, detailsUrl: `https://ci.example.com/${name}` }
}

function pr(number: number, rollup: Json[], extra: Json = {}): Json {
  return {
    number,
    author: { login: 'me' },
    url: `https://github.com/o/r/pull/${number}`,
    title: `PR ${number}`,
    headRefName: `feat-${number}`,
    headRefOid: HEAD_A,
    isDraft: false,
    baseRefName: 'main',
    statusCheckRollup: rollup,
    ...extra,
  }
}

// 이번 실행의 gh 답. rules 는 저장소 규칙 API 의 답이다(기본은 필수 체크 test 하나)
function github(rows: Json[], rules: FakeRule = { stdout: 'test\n' }, listCode = 0): void {
  gh.setRules([
    { args: ['pr', 'list', '--base'], stdout: '[]\n' },
    { args: ['pr', 'list'], stdout: `${JSON.stringify(rows)}\n`, stderr: listCode ? 'gh offline\n' : '', code: listCode },
    { args: ['api', 'user'], stdout: 'me\n' },
    { ...rules, args: [RULES_PATH] },
  ])
}

function once(): void {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--run', 'r', '--foreground', '--once'], {
    env,
    cwd: tmp,
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(done.status, 0, done.stdout + done.stderr)
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

function sends(): string[][] {
  return jsonl(join(tmp, 'send.jsonl')) as unknown as string[][]
}

function loopCi(): Json {
  const state = JSON.parse(readFileSync(orchFile('state', 'loop.json'), 'utf8')) as Json
  return (state.ci ?? {}) as Json
}

function ruleCalls(): number {
  return gh.calls().filter((call) => call.argv.includes(RULES_PATH)).length
}

// 브랜치 feat-<n> 의 워크트리를 만들고 그 워크트리의 worker-list 행을 가짜 orca 에 둔다
function worker(number: number, status: string): string {
  const path = join(tmp, `wt-${number}`)
  git(['worktree', 'add', '-q', '-b', `feat-${number}`, path])
  writeFileSync(
    join(tmp, 'orca.json'),
    JSON.stringify({ workers: [{ resource: { worktreeId: `wt::${path}` }, dispatchId: 'd1', dispatchStatus: status, taskId: 't1' }] }),
  )
  return path
}

describe('알림 한 번', () => {
  test('같은 HEAD 의 실패를 두 틱 연속 보면 ci-failed 와 CI-FAILED 는 한 번이다', () => {
    github([pr(1, [check('test', 'FAILURE')])])
    once()
    once()
    assert.equal(received('ci-failed').length, 1)
    assert.deepEqual(
      events().map((line) => [line.kind, line.pr]),
      [['CI-FAILED', 1]],
    )
    assert.deepEqual(loopCi(), { 1: { head: HEAD_A, state: 'failed' } })
  })

  test('실패한 PR 에 새 HEAD 가 와서 다시 실패하면 한 번 더 알린다', () => {
    github([pr(1, [check('test', 'FAILURE')])])
    once()
    github([pr(1, [check('test', 'FAILURE')], { headRefOid: HEAD_B })])
    once()
    assert.equal(received('ci-failed').length, 2)
    assert.equal(events().filter((line) => line.kind === 'CI-FAILED').length, 2)
    assert.deepEqual(loopCi(), { 1: { head: HEAD_B, state: 'failed' } })
  })

  test('필수 체크가 모두 통과하면 ci-passed 한 번이고 알림 파일에 줄이 없다. 입력은 pr, checks, required 다', () => {
    github([pr(1, [check('test', 'SUCCESS')])])
    once()
    once()
    const inputs = received('ci-passed')
    assert.equal(inputs.length, 1)
    assert.deepEqual(inputs[0].pr, { number: 1, title: 'PR 1', branch: 'feat-1', head: HEAD_A, author: 'me', draft: false, url: 'https://github.com/o/r/pull/1' })
    assert.deepEqual(inputs[0].required, ['test'])
    assert.deepEqual(inputs[0].checks, [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', url: 'https://ci.example.com/test' }])
    assert.equal(inputs[0].base, 'main')
    assert.deepEqual(received('ci-failed'), [])
    assert.deepEqual(events(), [])
  })

  test('같은 HEAD 에서 실패한 체크를 다시 돌려 통과하면 ci-passed 를 낸다', () => {
    github([pr(1, [check('test', 'FAILURE')])])
    once()
    github([pr(1, [check('test', 'SUCCESS')])])
    once()
    assert.equal(received('ci-failed').length, 1)
    assert.equal(received('ci-passed').length, 1)
    assert.deepEqual(loopCi(), { 1: { head: HEAD_A, state: 'passed' } })
  })

  test('필수가 아닌 체크가 실패하면 ci-failed 이고 CI-FAILED 에 그 체크 이름이 있다', () => {
    github([pr(1, [check('test', 'SUCCESS'), check('extra', 'FAILURE')])])
    once()
    assert.deepEqual(received('ci-passed'), [])
    const inputs = received('ci-failed')
    assert.equal(inputs.length, 1)
    assert.deepEqual(inputs[0].required, ['test'])
    assert.deepEqual(
      events().map((line) => [line.kind, line.text]),
      [['CI-FAILED', 'extra: 살아 있는 dispatch 없음']],
    )
  })

  test('필수 체크 하나가 아직 나타나지 않았으면 이벤트가 없다', () => {
    github([pr(1, [check('test', 'SUCCESS')])], { stdout: 'lint,test\n' })
    once()
    assert.deepEqual(received('ci-passed'), [])
    assert.deepEqual(received('ci-failed'), [])
    assert.deepEqual(events(), [])
    assert.deepEqual(loopCi(), { 1: { head: HEAD_A, state: 'pending' } })
  })

  test('닫힌 PR 의 항목은 빠진다', () => {
    github([pr(1, [check('test', 'FAILURE')]), pr(2, [check('test', 'SUCCESS')])])
    once()
    github([pr(2, [check('test', 'SUCCESS')])])
    once()
    assert.deepEqual(loopCi(), { 2: { head: HEAD_A, state: 'passed' } })
  })
})

describe('필수 체크 이름', () => {
  test('queue.required 와 다른 queue 키가 있으면 규칙 API 를 부르지 않고 그 이름으로 판정한다', () => {
    config({ queue: { required: ['lint'], method: 'squash', docs_glob: 'docs/**' } })
    // 규칙 API 는 test 를 필수로 내지만 부르지 않으므로, 나타나지 않은 test 를 기다리지 않는다
    github([pr(1, [check('lint', 'SUCCESS')])])
    once()
    assert.equal(ruleCalls(), 0)
    assert.equal(received('ci-passed').length, 1)
    assert.deepEqual(received('ci-passed')[0].required, ['lint'])
    assert.deepEqual(received('ci-failed'), [])
  })

  test('규칙이 플랜 제한(403)이면 나타난 체크 전부로 판정한다', () => {
    github([pr(1, [check('test', 'SUCCESS'), check('lint', 'FAILURE')])], {
      code: 1,
      stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)\n',
    })
    once()
    const inputs = received('ci-failed')
    assert.equal(inputs.length, 1)
    assert.deepEqual(inputs[0].required, [])
    assert.deepEqual(
      (inputs[0].checks as Json[]).map((c) => c.name),
      ['test', 'lint'],
    )
    assert.ok(!events().some((line) => line.kind === 'WATCH-ERROR'), JSON.stringify(events()))
  })

  test('queue.skipped_is_missing 이고 필수 체크가 SKIPPED 면 이벤트가 없다', () => {
    config({ queue: { skipped_is_missing: true } })
    github([pr(1, [check('test', 'SKIPPED')])])
    once()
    assert.deepEqual(received('ci-passed'), [])
    assert.deepEqual(received('ci-failed'), [])
    assert.deepEqual(events(), [])
  })

  test('규칙을 읽지 못한 base 의 PR 은 이전 값을 그대로 옮겨, 다시 읽은 틱에 같은 HEAD 의 실패를 다시 알리지 않는다', () => {
    github([pr(1, [check('test', 'FAILURE')])])
    once()
    github([pr(1, [check('test', 'FAILURE')])], { code: 1, stderr: 'HTTP 502: Bad Gateway\n' })
    once()
    assert.deepEqual(loopCi(), { 1: { head: HEAD_A, state: 'failed' } })
    const errors = events().filter((line) => line.kind === 'WATCH-ERROR')
    assert.equal(errors.length, 1, JSON.stringify(events()))
    assert.match(String(errors[0].text), /^ci: main 의 필수 체크 규칙을 읽지 못했다: .*HTTP 502/)
    // 열린 PR 을 읽지 못한 틱도 이전 값을 둔다
    github([], { stdout: 'test\n' }, 1)
    once()
    assert.deepEqual(loopCi(), { 1: { head: HEAD_A, state: 'failed' } })
    github([pr(1, [check('test', 'FAILURE')])])
    once()
    assert.equal(received('ci-failed').length, 1)
    assert.equal(events().filter((line) => line.kind === 'CI-FAILED').length, 1)
  })
})

describe('보지 않는 PR', () => {
  test('draft PR 과 다른 작성자의 PR 이 실패해도 이벤트도 보내기도 없다', () => {
    worker(1, 'running')
    github([pr(1, [check('test', 'FAILURE')], { isDraft: true }), pr(2, [check('test', 'FAILURE')], { author: { login: 'other' } })])
    once()
    assert.deepEqual(received('ci-failed'), [])
    assert.deepEqual(events(), [])
    assert.deepEqual(sends(), [])
  })
})

describe('worker 에게 보내기', () => {
  test('실패한 PR 의 브랜치 워크트리에 살아 있는 dispatch 가 있으면 실패한 체크 이름과 URL 을 본문으로 보낸다', () => {
    worker(1, 'running')
    github([pr(1, [check('test', 'FAILURE')])])
    once()
    const calls = sends()
    assert.equal(calls.length, 1, JSON.stringify(calls))
    const [argv] = calls
    assert.deepEqual(argv.slice(0, 2), ['--dispatch', 'd1'])
    assert.equal(argv[2], '--body')
    assert.match(argv[3], /^PR #1 의 체크가 실패했다: test https:\/\/ci\.example\.com\/test\./)
    assert.deepEqual(argv.slice(4), ['--run', 'r'])
    assert.deepEqual(
      events().map((line) => line.text),
      ['test: 보냈다 d1'],
    )
    assert.equal(received('ci-failed').length, 1)
  })

  test('send-to-worker 가 4 로 끝나면 CI-FAILED 에 깨우지 못했다고 적는다', () => {
    worker(1, 'running')
    writeFileSync(join(tmp, 'send.json'), JSON.stringify({ code: 4 }))
    github([pr(1, [check('test', 'FAILURE')])])
    once()
    assert.deepEqual(
      events().map((line) => line.text),
      ['test: 깨우지 못했다(종료 코드 4)'],
    )
  })

  test('그 dispatch 가 끝났으면 보내지 않고 CI-FAILED 에 살아 있는 dispatch 없음이다', () => {
    worker(1, 'completed')
    github([pr(1, [check('test', 'FAILURE')])])
    once()
    assert.deepEqual(sends(), [])
    assert.deepEqual(
      events().map((line) => [line.kind, line.text]),
      [['CI-FAILED', 'test: 살아 있는 dispatch 없음']],
    )
    assert.equal(received('ci-failed').length, 1)
  })
})
