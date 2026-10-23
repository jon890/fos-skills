// nudge-worker.ts 의 화면 판정과 입력 흐름을 본다. 흐름은 가짜 orca 로 돌아 Orca 에는 닿지 않는다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/nudge-worker.ts', import.meta.url))

const CLAUDE_FOOTER = (input: string) => `───────────────────────────────────────────────────────────────
${input}
───────────────────────────────────────────────────────────────
   Model: Sonnet 5.5  Context: [██░░░░░░░░░░░░░░] 112k/1.0M (11%)
  ⏵⏵ bypass permissions on · 1 shell · ← 1 agent`

const CLAUDE_IDLE = `⏺ worker_done 을 보냈다.
✻ Baked for 41m 26s · done 오후 11:19 · 1 shell still running
※ recap: 작업은 끝났고 PR 을 열어 코디네이터에게 보고했다. (disable recaps in /config)
${CLAUDE_FOOTER('❯ ')}`

const CLAUDE_WORKING = `⏺ 검사를 다시 돌린다.
✳ Lollygagging… (3m 0s · ↓ 9.2k tokens)
  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work
${CLAUDE_FOOTER('❯ ')}`

const CLAUDE_DRAFT = CLAUDE_IDLE.replace('❯ ', '❯ 이 브랜치 이름을 바꿔')

const CLAUDE_PERMISSION = ` Bash command
   rm -rf build
 Do you want to proceed?
 ❯ 1. Yes
   2. No, and tell Claude what to do differently (esc)`

const CODEX_FOOTER = (input: string) => `› ${input}
  ~/work/repo · user/branch · GPT-6.1-Sol medium · Context 47% used
  ? for shortcuts                                       ⚠ 2 warnings · f2 to view`

const CODEX_HISTORY = `› You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
• 전체 CI 는 통과했고, 머지 완료를 기다리고 있습니다.
`

const CODEX_WORKING = `${CODEX_HISTORY}• Working (50m 46s • esc to interrupt) · 1 background terminal running · /ps to view
  └ Tip: Use /hooks to view and manage lifecycle hooks.
${CODEX_FOOTER('Ask Codex to do anything')}`

const CODEX_IDLE = CODEX_HISTORY + CODEX_FOOTER('Ask Codex to do anything')
const CODEX_EMPTY = CODEX_HISTORY + CODEX_FOOTER('')
const CODEX_DRAFT = CODEX_HISTORY + CODEX_FOOTER('PR 본문을 고쳐')

const CODEX_PERMISSION = `  Would you like to run the following command?
  $ git push -u origin HEAD
› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)`

// 차례로 응답을 하나씩 낸다. 부를 때마다 인자를 기록한다. 확장자가 없어 타입 문법 없이 쓴다.
// macOS 에서 파이프로 가는 process.stdout 쓰기는 비동기라 process.exit 가 출력을 자를 수 있어 writeSync 로 쓴다.
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
const reply = state.replies.shift()
fs.writeFileSync(file, JSON.stringify(state))
fs.writeSync(1, JSON.stringify(reply) + '\\n')
process.exit(reply.ok ? 0 : 1)
`

function screen(text: string): unknown {
  return { ok: true, result: { terminal: { tail: text.split('\n'), source: 'screen' } } }
}

function receipt(stages: string[], observation = 'observed', request = 'req_1'): unknown {
  return {
    ok: true,
    result: { send: { accepted: true, handle: 'term_w', prompt: { requestId: request, stages, provider: 'claude', observation } } },
  }
}

let binDir: string
let tmp: string
let stateFile: string
let log: string
let env: NodeJS.ProcessEnv

before(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'nudge-worker-bin-')))
  writeFileSync(join(binDir, 'orca'), FAKE_ORCA)
  chmodSync(join(binDir, 'orca'), 0o755)
})
after(() => rmSync(binDir, { recursive: true, force: true }))

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nudge-worker-')))
  stateFile = join(tmp, 'state.json')
  log = join(tmp, 'log.txt')
  env = {
    ...process.env,
    // 가짜 orca 의 #! 줄이 이 테스트의 node 를 쓰게 한다
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ORCA: join(binDir, 'orca'),
    FAKE_STATE: stateFile,
    FAKE_LOG: log,
  }
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

type Result = { code: number | null; stdout: string; stderr: string }

function nudge(args: string[], input?: string): Result {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], {
    env,
    input,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function withReplies(replies: unknown[], args: string[]): Result {
  writeFileSync(stateFile, JSON.stringify({ replies }))
  return nudge(['--terminal', 'term_w', ...args])
}

function runNudge(replies: unknown[]): Result {
  return withReplies(replies, ['--msg-id', 'msg_1', '--wait-submit', '5'])
}

function calls(): string[][] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line)
    .map((line) => JSON.parse(line) as string[])
}

function sends(): string[][] {
  return calls().filter((c) => c[0] === 'terminal' && c[1] === 'send')
}

describe('화면 판정', () => {
  const classify = (text: string) => nudge(['--classify'], text)

  const cases: [string, string, string][] = [
    ['Claude 입력 대기', CLAUDE_IDLE, 'idle'],
    ['Claude 작업 중', CLAUDE_WORKING, 'working'],
    ['Claude 쓰다 만 글', CLAUDE_DRAFT, 'draft'],
    ['Claude 권한 확인', CLAUDE_PERMISSION, 'permission'],
    ['Codex 안내 문구', CODEX_IDLE, 'idle'],
    ['Codex 빈 입력란', CODEX_EMPTY, 'idle'],
    ['Codex 작업 중', CODEX_WORKING, 'working'],
    ['Codex 쓰다 만 글', CODEX_DRAFT, 'draft'],
    ['Codex 권한 확인', CODEX_PERMISSION, 'permission'],
    // 아래 12줄만 본다. 그 위의 입력란 기호는 대화 기록이다
    ['화면 위쪽의 입력란은 기록이다', `› 지난 지시\n${Array.from({ length: 20 }, (_, i) => `출력 ${i}`).join('\n')}`, 'unknown'],
    ['셸 화면', '~/work/repo on main\n$ ', 'unknown'],
  ]
  for (const [name, text, expected] of cases) {
    test(`${name} 은 ${expected} 다`, () => {
      const r = classify(text)
      assert.equal(r.code, 0, r.stderr)
      assert.equal(r.stdout, `${expected}\n`, text)
    })
  }
})

describe('입력 흐름', () => {
  test('입력 대기인 worker 에게 한 번 넣고 턴 시작을 보면 0 이다', () => {
    const r = runNudge([screen(CLAUDE_IDLE), receipt(['input_accepted', 'turn_started'])])
    assert.equal(r.code, 0, r.stdout)
    assert.ok(r.stdout.startsWith('nudged'), r.stdout)
    const [call, ...rest] = sends()
    assert.deepEqual(rest, [])
    assert.ok(call.includes('코디네이터 메시지 msg_1 를 orca orchestration check 로 읽고 수행한다'), JSON.stringify(call))
    assert.ok(call.includes('--enter'))
    assert.ok(!call.includes('--retry-request'))
  })

  test('턴 시작을 못 보면 같은 request id 로 한 번 더 확인한다', () => {
    const r = runNudge([screen(CODEX_IDLE), receipt(['input_accepted']), receipt(['input_accepted', 'turn_started'])])
    assert.equal(r.code, 0, r.stdout)
    const [first, retry] = sends()
    assert.deepEqual(retry, [...first.slice(0, -1), '--retry-request', 'req_1', '--json'])
  })

  test('다시 확인해도 턴 시작이 없으면 1 이다', () => {
    const r = runNudge([screen(CODEX_IDLE), receipt(['input_accepted']), receipt(['input_accepted'])])
    assert.equal(r.code, 1, r.stdout)
    assert.equal(sends().length, 2)
    assert.ok(r.stdout.startsWith('unobserved'), r.stdout)
  })

  test('권한 확인 receipt 는 다시 보내지 않고 4 다', () => {
    const r = runNudge([screen(CLAUDE_IDLE), receipt(['input_accepted'], 'permission')])
    assert.equal(r.code, 4, r.stdout)
    assert.equal(sends().length, 1)
  })

  test('작업 중이면 입력하지 않고 0 이다', () => {
    const r = runNudge([screen(CODEX_WORKING)])
    assert.equal(r.code, 0, r.stdout)
    assert.ok(r.stdout.startsWith('working'), r.stdout)
    assert.deepEqual(sends(), [])
  })

  test('쓰다 만 글과 권한 확인 화면에는 입력하지 않고 4 다', () => {
    for (const text of [CLAUDE_DRAFT, CODEX_PERMISSION]) {
      if (existsSync(log)) unlinkSync(log)
      const r = runNudge([screen(text)])
      assert.equal(r.code, 4, text)
      assert.deepEqual(sends(), [])
    }
  })

  test('--text 는 작업 중인 터미널에 턴 시작을 기다리지 않고 넣는다', () => {
    // 닫힌 dispatch 의 worker 가 아직 일할 때 send-to-worker 가 이 길로 본문을 넣는다
    const r = withReplies([screen(CODEX_WORKING), receipt(['input_accepted'])], ['--text', 'main 을 합쳐라'])
    assert.equal(r.code, 0, r.stdout)
    assert.ok(r.stdout.startsWith('queued'), r.stdout)
    const [call, ...rest] = sends()
    assert.deepEqual(rest, [])
    assert.ok(call.includes('main 을 합쳐라'))
    assert.ok(!call.includes('--wait-submit'))
  })

  test('--text 를 입력 대기인 터미널에 넣으면 턴 시작을 기다린다', () => {
    const r = withReplies([screen(CLAUDE_IDLE), receipt(['input_accepted', 'turn_started'])], ['--text', '본문'])
    assert.equal(r.code, 0, r.stdout)
    assert.ok(r.stdout.startsWith('nudged'), r.stdout)
    assert.ok(sends()[0].includes('--wait-submit'))
  })

  test('- 로 시작하는 --text 도 그대로 넣는다', () => {
    const r = withReplies([screen(CODEX_WORKING), receipt(['input_accepted'])], ['--text', '-x 로 시작하는 글'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.ok(sends()[0].includes('-x 로 시작하는 글'))
  })

  test('--state 는 화면 상태 한 낱말만 낸다', () => {
    const r = withReplies([screen(CODEX_WORKING)], ['--state'])
    assert.deepEqual([r.code, r.stdout], [0, 'working\n'])
    assert.deepEqual(sends(), [])
  })

  test('orca 오류는 출력을 그대로 내고 5 다', () => {
    const r = runNudge([{ ok: false, error: { code: 'terminal_not_found' } }])
    assert.equal(r.code, 5, r.stdout)
    assert.match(r.stdout, /terminal_not_found/)
  })
})

describe('사용법', () => {
  test('--terminal 과 --msg-id 나 --text 중 하나가 없으면 2 다', () => {
    assert.equal(nudge([]).code, 2)
    assert.equal(nudge(['--terminal', 't']).code, 2)
    assert.equal(nudge(['--terminal', 't', '--msg-id', 'm', '--text', 'x']).code, 2)
  })

  test('--wait-submit 이 0 이면 2 다', () => {
    const r = nudge(['--terminal', 't', '--msg-id', 'm', '--wait-submit', '0'])
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /--wait-submit 은 0 보다 커야 한다/)
  })

  test('모르는 옵션은 2 다', () => {
    assert.equal(nudge(['--terminal', 't', '--msg-id', 'm', '--bogus']).code, 2)
  })
})
