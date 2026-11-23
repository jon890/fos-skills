// relaunch-worker.ts 를 임시 저장소와 상태 파일로 움직이는 가짜 orca 로 본다. 자식 launch-worker 도 실제로 돌린다. Orca 에는 닿지 않는다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { linkBin } from '../../../modules/testkit/fake-bin.ts'
import { recordLaunch } from '../scripts/lib/launched.ts'
import { fixedSelectionLine } from '../scripts/worker/relaunch-worker.ts'
import { claudeProfile, codexUsage, CREATOR } from './fixtures/usage-limits.ts'
import { workerPathWithOrch } from './fixtures/worker-orch.ts'
import { GIT_ISOLATION } from '../../../modules/testkit/git.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/worker/relaunch-worker.ts', import.meta.url))

// 상태 파일로 움직이는 가짜 orca. 받은 인자를 한 줄씩 기록한다. 확장자가 없어 타입 문법 없이 쓴다.
// worker-abandon 은 dispatch 를 abandoned 로, Task 를 after_abandon 상태로 바꾼다. terminal close 는 목록에서 뺀다.
// terminal read 는 state.screen 을 화면으로 낸다. 기본은 사용 한도 안내다
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2).filter((a) => a !== '--json' && a !== '--full')
fs.appendFileSync(process.env.FAKE_LOG, 'orca ' + args.join(' ') + '\\n')
function out(result, code = 0) {
  fs.writeFileSync(file, JSON.stringify(state))
  fs.writeSync(1, JSON.stringify({ ok: code === 0, result, ...(code ? { error: { code: 'boom', message: 'boom' } } : {}) }) + '\\n')
  process.exit(code)
}
function opt(name) {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : null
}
const is = (a, b) => args[0] === a && args[1] === b
if (is('account', 'list') && state.accounts?.[opt('--agent')]) out(state.accounts[opt('--agent')])
if (is('worktree', 'list')) out({ worktrees: [{ path: state.worktree }] })
if (is('terminal', 'list')) out({ terminals: state.terminals })
if (is('terminal', 'read')) out({ terminal: { tail: state.screen } })
if (is('terminal', 'close')) {
  if (state.close_fails) { state.close_fails = false; out({}, 1) }
  state.terminals = state.terminals.filter((t) => t.handle !== opt('--terminal'))
  // Orca 는 worker 터미널을 닫으면 그 탭에 빈 셸을 다시 연다
  if (state.reopen_shell && opt('--terminal') === 'term_old') state.terminals.push({ handle: 'term_shell', title: 'Terminal 1', worktreePath: state.worktree })
  out({})
}
if (is('orchestration', 'worker-show')) {
  const id = opt('--dispatch')
  const d = state.dispatches[id]
  if (!d) out({}, 1)
  out({ dispatch: Object.assign({ id }, d), worker: { agentTerminalHandle: d.terminal, worktreeId: 'repo::' + state.worktree, stage: 'input_accepted' } })
}
if (is('orchestration', 'dispatch-show')) out({ dispatch: { id: state.latest, status: (state.dispatches[state.latest] || {}).status } })
if (is('orchestration', 'task-list')) {
  if (state.task_list_fails) { state.task_list_fails = false; out({}, 1) }
  out({ tasks: [{ id: 'task_1', status: state.task }] })
}
if (is('orchestration', 'worker-abandon')) {
  if (state.abandon_fails) out({}, 1)
  if (state.abandon_errors_after) {
    state.dispatches[opt('--dispatch')].status = 'abandoned'
    out({}, 1)
  }
  state.dispatches[opt('--dispatch')].status = 'abandoned'
  state.task = state.after_abandon
  if (state.accounts_after_abandon) state.accounts = state.accounts_after_abandon
  out({})
}
if (is('orchestration', 'worker-start')) {
  if (state.start_fails) out({ failedStage: 'agent_readiness' }, 1)
  const id = state.next_ids.shift()
  state.dispatches[id] = { runId: 'run_1', taskId: 'task_1', status: 'dispatched', terminal: 'term_new' }
  state.latest = id
  out({ dispatch: { id, taskId: 'task_1' }, launch: { effective: {} } })
}
process.exit(3)
`

// LAUNCH_WORKER 로 바꿔 끼우는 가짜 launch-worker. --preflight 는 통과하고, 띄우기는 FAKE_LAUNCH_OUT 을 내고 FAKE_LAUNCH_CODE 로 끝난다
const FAKE_LAUNCHER = `import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, 'launcher ' + args.join(' ') + '\\n')
if (args.includes('--preflight')) { console.log('PREFLIGHT-OK'); process.exit(0) }
if (process.env.FAKE_LAUNCH_OUT) console.log(process.env.FAKE_LAUNCH_OUT)
process.exit(Number(process.env.FAKE_LAUNCH_CODE || '0'))
`

const GIT_ENV: Record<string, string> = {
  ...GIT_ISOLATION,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

let binDir: string
let tmp: string
let repo: string
let wt: string
let spec: string
let log: string
let stateFile: string
let env: NodeJS.ProcessEnv

// 테스트 프로세스가 쓰는 띄우기 기록이 임시 저장소의 .orch 에 가게 한다
delete process.env.ORCH_DIR

before(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'relaunch-bin-')))
  linkBin(binDir, 'orca', FAKE_ORCA.replace(/^#![^\n]*\n/, ''))
  writeFileSync(join(binDir, 'fake-launcher.ts'), FAKE_LAUNCHER)
  writeFileSync(join(binDir, 'spec-lint-ok.sh'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(binDir, 'spec-lint-ok.sh'), 0o755)
})
after(() => rmSync(binDir, { recursive: true, force: true }))

function git(...args: string[]): void {
  const done = spawnSync('git', args, { env, encoding: 'utf8' })
  assert.equal(done.status, 0, done.stderr)
}

// impl-explore 행의 worker 는 codex 다. 사용 한도로 바꾼 claude 는 후보 밖 이유를 단다
const selectionLine = (agent: string, model: string, effort: string) =>
  `worker 선택: \`${agent}\` \`${model}\` effort \`${effort}\`. 행: impl-explore. 이유: 테스트.${agent === 'codex' ? '' : ' 후보 밖: codex 사용 한도.'}`

function writeSpec(agent: string, model: string, effort: string): void {
  writeFileSync(spec, `# 일\n\n브랜치: \`feat/a\`\n허락: push 와 draft PR 생성은 사용자가 허락했다.\n${selectionLine(agent, model, effort)}\n`)
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'relaunch-')))
  repo = join(tmp, 'repo')
  wt = join(tmp, 'wt')
  spec = join(tmp, 'spec.md')
  log = join(tmp, 'log.txt')
  stateFile = join(tmp, 'state.json')
  env = {
    ...process.env,
    ...GIT_ENV,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    GIT_CEILING_DIRECTORIES: tmp,
    ORCA: join(binDir, 'orca'),
    CODEX_BIN: join(tmp, 'no-codex'),
    // Orca 계정 조회(orca account list)를 부르지 않고 셸의 codex 환경을 쓴다. 계정 홈 판정은 lib-model-generation.spec.ts 가 본다
    ORCH_WORKER_CODEX_HOME: '',
    // 감지 기록도 이 기계의 것을 읽지 않는다
    ORCH_MACHINE_DIR: join(tmp, 'machine'),
    FAKE_STATE: stateFile,
    FAKE_LOG: log,
    SPEC_LINT: join(binDir, 'spec-lint-ok.sh'),
    ORCA_CLAUDE_PROFILES: join(tmp, 'no-profiles'),
    ORCH_WORKER_PATH: workerPathWithOrch(tmp),
    LAUNCH_POLL: '0',
    // 실제 Claude 세션 기록을 기다리지 않는다. 계열 이름으로 띄운 뒤의 모델 ID 읽기는 「모델 세대」 에서 본다
    LAUNCH_MODEL_WAIT: '0',
    LAUNCH_WT_POLL: '0',
    LAUNCH_WT_WAIT: '3',
    RELAUNCH_SHELL_WAIT_MS: '0',
  }
  delete env.ORCH_DIR
  delete env.ORCH_OUTPUT
  git('init', '-q', '-b', 'main', repo)
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('-C', repo, 'add', 'a.txt')
  git('-C', repo, 'commit', '-qm', 'init')
  git('-C', repo, 'worktree', 'add', '-q', wt, '-b', 'feat/a')
  writeSpec('codex', 'gpt-6.1-sol', 'medium')
  recordLaunch(repo, { dispatch: 'ctx_old', task: 'task_1', terminal: 'term_old', worktree: wt, branch: 'feat/a', run: 'run_1', spec, agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' })
  state({})
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function state(values: Record<string, unknown>): void {
  writeFileSync(stateFile, JSON.stringify({
    worktree: wt,
    terminals: [{ handle: 'term_old', worktreePath: wt }],
    dispatches: { ctx_old: { runId: 'run_1', taskId: 'task_1', status: 'running', terminal: 'term_old' } },
    latest: 'ctx_old',
    task: 'dispatched',
    after_abandon: 'ready',
    screen: ['작업 로그', "You've hit your usage limit. Upgrade to Pro or try again in 3 hours."],
    next_ids: ['ctx_new'],
    ...values,
  }))
}

function relaunch(extra: string[] = [], worker = ['--agent', 'claude', '--model', 'claude-opus-5-5', '--effort', 'medium']) {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--dispatch', 'ctx_old', '--run', 'run_1', ...extra, '--', ...worker], { env, encoding: 'utf8', timeout: 60_000 })
  return { code: done.status, out: done.stdout + done.stderr, stdout: done.stdout }
}

// 자식 launch-worker 를 가짜로 바꿔 부른다
function relaunchFake(output: string, code: number, extra: string[] = []) {
  const saved = env
  env = { ...env, LAUNCH_WORKER: join(binDir, 'fake-launcher.ts'), FAKE_LAUNCH_OUT: output, FAKE_LAUNCH_CODE: String(code) }
  try {
    return relaunch(extra)
  } finally {
    env = saved
  }
}


function orcaCalls(): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('orca ')) : []
}

const holdFile = () => join(repo, '.orch/state/relaunch-hold/ctx_old.json')
const touched = (calls: string[]) => calls.filter((c) => /worker-abandon|terminal close|worker-start/.test(c))

describe('띄우기 전 확인', () => {
  test('지시서의 worker 선택 줄이 새 인자와 다르면 고칠 줄을 내고 옛 worker 를 건드리지 않는다', () => {
    const r = relaunch()
    assert.equal(r.code, 1, r.out)
    assert.match(r.stdout, new RegExp(`^RELAUNCH-FIX ${spec}:5 worker 선택: \`claude\` \`claude-opus-5-5\` effort \`medium\`\\. 행: impl-explore\\. 이유: 테스트\\.$`, 'm'))
    assert.deepEqual(touched(orcaCalls()), [])
    assert.ok(!existsSync(holdFile()))
  })

  test('다른 Run 의 dispatch 는 거부한다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ dispatches: { ctx_old: { runId: 'run_other', taskId: 'task_1', status: 'running', terminal: 'term_old' } } })
    const r = relaunch()
    assert.equal(r.code, 3, r.out)
    assert.match(r.stdout, /^RELAUNCH-REFUSED .*Run run_other 의 worker 다/m)
    assert.deepEqual(touched(orcaCalls()), [])
  })

  test('이 저장소에 띄우기 기록이 없으면 거부한다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    rmSync(join(repo, '.orch/state/launched-workers'), { recursive: true })
    const r = relaunch()
    assert.equal(r.code, 3, r.out)
    assert.match(r.stdout, /^RELAUNCH-REFUSED .*띄우기 기록이 없다/m)
    assert.deepEqual(touched(orcaCalls()), [])
  })

  test('같은 Task 에 더 새 dispatch 가 있거나 completed 면 거부한다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ latest: 'ctx_newer' })
    assert.match(relaunch().stdout, /^RELAUNCH-REFUSED 같은 Task 에 더 새 dispatch ctx_newer/m)
    state({ dispatches: { ctx_old: { runId: 'run_1', taskId: 'task_1', status: 'completed', terminal: 'term_old' } } })
    const r = relaunch()
    assert.equal(r.code, 3, r.out)
    assert.match(r.stdout, /worker continue --dispatch/)
    assert.deepEqual(touched(orcaCalls()), [])
  })

  test('옛 터미널 밖의 터미널이 있으면 목록을 내고 거부한다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ terminals: [{ handle: 'term_old', worktreePath: wt }, { handle: 'term_user', title: '사람 셸', worktreePath: wt }] })
    const r = relaunch()
    assert.equal(r.code, 3, r.out)
    assert.match(r.stdout, /^ {2}term_user 사람 셸$/m)
    assert.deepEqual(touched(orcaCalls()), [])
  })

  test('커밋 안 된 변경은 --dirty-ack 없이 거부하고, 주면 이유를 넘겨 띄운다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    writeFileSync(join(wt, 'draft.md'), '초안\n')
    const refused = relaunch()
    assert.equal(refused.code, 3, refused.out)
    assert.match(refused.stdout, /커밋 안 된 변경이 1개/)
    assert.match(refused.stdout, /^ {2}\?\? draft\.md$/m)
    assert.deepEqual(touched(orcaCalls()), [])
    const r = relaunch(['--dirty-ack', '앞 worker 의 스펙 초안을 이어받는다'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.stdout, /dirty-ack: 앞 worker 의 스펙 초안을 이어받는다/)
  })

  test('같은 Task 의 더 새 dispatch 가 살아 있으면 새 worker 가 이미 떠 있다고 알린다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ latest: 'ctx_newer', dispatches: { ctx_old: { runId: 'run_1', taskId: 'task_1', status: 'abandoned', terminal: 'term_old' }, ctx_newer: { runId: 'run_1', taskId: 'task_1', status: 'running', terminal: 'term_n' } } })
    const r = relaunch()
    assert.equal(r.code, 3, r.out)
    assert.match(r.stdout, /^RELAUNCH-REFUSED 새 worker 가 이미 떠 있다\(같은 Task 의 dispatch ctx_newer, 상태 running\)/m)
  })

  test('살아 있는 dispatch 의 화면이 사용 한도가 아니면 거부하고, --working-ack 이면 넘긴다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ screen: ['테스트를 고치는 중', '• Working (12s • esc to interrupt)'] })
    const refused = relaunch()
    assert.equal(refused.code, 3, refused.out)
    assert.match(refused.stdout, /^RELAUNCH-REFUSED 살아 있는 dispatch 가 사용 한도 화면에서 멈춰 있지 않다/m)
    assert.match(refused.stdout, /^ {2}테스트를 고치는 중$/m)
    assert.deepEqual(touched(orcaCalls()), [])
    const r = relaunch(['--working-ack', '사용자가 모델을 바꾸라고 했다'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.stdout, /^working-ack: 사용자가 모델을 바꾸라고 했다$/m)
  })

  test('codex 에 없는 모델은 abandon 전에 거부한다', () => {
    writeSpec('codex', 'gpt-6.2-sol', 'medium')
    writeFileSync(join(tmp, 'codex'), `#!/bin/sh\necho '{"models":[{"slug":"gpt-6-luna","visibility":"list","supported_reasoning_levels":[{"effort":"medium"}]}]}'\n`)
    chmodSync(join(tmp, 'codex'), 0o755)
    env = { ...env, CODEX_BIN: join(tmp, 'codex') }
    const r = relaunch([], ['--agent', 'codex', '--model', 'gpt-6.2-sol', '--effort', 'medium'])
    assert.equal(r.code, 3, r.out)
    assert.match(r.stdout, /^RELAUNCH-REFUSED MODEL-UNAVAILABLE gpt-6\.2-sol/m)
    assert.deepEqual(touched(orcaCalls()), [])
  })

  test('사전 모델 검사는 launch 가 세대를 바꾼 뒤의 모델을 본다', () => {
    // 목록에 새 세대만 남아도 옛 세대가 적힌 지시서를 MODEL-UNAVAILABLE 로 거부하지 않는다
    writeSpec('codex', 'gpt-6.2-sol', 'medium')
    writeFileSync(join(tmp, 'codex'), `#!/bin/sh\necho '{"models":[{"slug":"gpt-6.3-sol","visibility":"list","description":"New.","supported_reasoning_levels":[{"effort":"medium"}]}]}'\n`)
    chmodSync(join(tmp, 'codex'), 0o755)
    env = { ...env, CODEX_BIN: join(tmp, 'codex') }
    const r = relaunch([], ['--agent', 'codex', '--model', 'gpt-6.2-sol', '--effort', 'medium'])
    assert.doesNotMatch(r.out, /MODEL-UNAVAILABLE/)
    assert.equal(r.code, 0, r.out)
  })

  test('`후보 밖:` 으로 직접 고른 옛 세대는 abandon 전에 MODEL-OUTDATED 로 거부한다', () => {
    writeFileSync(spec, `# 일\n\n브랜치: \`feat/a\`\n허락: push 와 draft PR 생성은 사용자가 허락했다.\nworker 선택: \`codex\` \`gpt-6.1-sol\` effort \`medium\`. 행: impl-explore. 이유: 테스트. 후보 밖: 옛 세대.\n`)
    writeFileSync(join(tmp, 'codex'), `#!/bin/sh\necho '{"models":[{"slug":"gpt-6.2-sol","visibility":"list","description":"New.","supported_reasoning_levels":[{"effort":"medium"}]},{"slug":"gpt-6.1-sol","visibility":"list","description":"Previous generation.","supported_reasoning_levels":[{"effort":"medium"}]}]}'\n`)
    chmodSync(join(tmp, 'codex'), 0o755)
    env = { ...env, CODEX_BIN: join(tmp, 'codex') }
    const r = relaunch([], ['--agent', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'medium'])
    assert.equal(r.code, 3, r.out)
    assert.match(r.stdout, /^RELAUNCH-REFUSED MODEL-OUTDATED gpt-6\.1-sol → gpt-6\.2-sol/m)
    assert.deepEqual(touched(orcaCalls()), [])
  })

  test('두 제공자가 모두 소진되면 preflight 가 abandon 전에 멈춘다', () => {
    writeSpec('codex', 'gpt-6.2-sol', 'medium')
    env.ORCH_SYSTEM_CODEX_HOME = join(tmp, 'codex-home')
    codexUsage(env.ORCH_SYSTEM_CODEX_HOME, 100)
    state({ accounts: {
      codex: { activeAccountId: null, systemDefault: { providerAccountId: CREATOR } },
      claude: claudeProfile(env.ORCA_CLAUDE_PROFILES!, 100),
    } })
    const r = relaunch([], ['--agent', 'codex', '--model', 'gpt-6.2-sol', '--effort', 'medium'])
    assert.equal(r.code, 3, r.out)
    assert.match(r.stdout, /^RELAUNCH-REFUSED 같은 등급/m)
    assert.match(r.stdout, /^USAGE-RESET /m)
    assert.deepEqual(touched(orcaCalls()), [])
    assert.ok(!existsSync(holdFile()))
  })

  test('사전 검사 뒤 계정이 바뀌어 소진됐으면 새 실행을 멈추고 재시도 경로를 남긴다', () => {
    writeSpec('codex', 'gpt-6.2-sol', 'medium')
    env.ORCH_SYSTEM_CODEX_HOME = join(tmp, 'codex-home')
    codexUsage(env.ORCH_SYSTEM_CODEX_HOME, 100)
    const claude = claudeProfile(env.ORCA_CLAUDE_PROFILES!, 100)
    const account = (id: string) => ({ activeAccountId: null, systemDefault: { providerAccountId: id } })
    state({
      accounts: { codex: account('creator-before'), claude },
      accounts_after_abandon: { codex: account(CREATOR), claude },
    })
    const r = relaunch([], ['--agent', 'codex', '--model', 'gpt-6.2-sol', '--effort', 'medium'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.stdout, /^USAGE-RESET /m)
    assert.match(r.stdout, /^RELAUNCH-FAIL launch .*NEXT /m)
    assert.equal(touched(orcaCalls()).filter(line => line.includes('worker-abandon')).length, 1)
    assert.ok(!touched(orcaCalls()).some(line => line.includes('worker-start')))
    assert.ok(existsSync(holdFile()))
  })

  test('launch-worker 의 띄우기 전 검사에 걸리면 옛 worker 를 건드리지 않는다', () => {
    writeFileSync(spec, `# 일\n\n브랜치: \`feat/a\`\n${selectionLine('claude', 'claude-opus-5-5', 'medium')}\n`)
    const r = relaunch()
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /허락:/)
    assert.match(r.stdout, /^RELAUNCH-REFUSED launch-worker 의 띄우기 전 검사가 종료 코드 1 로 멈췄다/m)
    assert.deepEqual(touched(orcaCalls()), [])
    assert.ok(!existsSync(holdFile()))
  })

  test('같은 dispatch 를 다시 띄우는 다른 실행이 살아 있으면 거부한다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    mkdirSync(join(repo, '.orch/state/relaunch-lock'), { recursive: true })
    writeFileSync(join(repo, '.orch/state/relaunch-lock/ctx_old.lock'), `${process.pid}\n`)
    const r = relaunch()
    assert.equal(r.code, 3, r.out)
    assert.match(r.stdout, new RegExp(`^RELAUNCH-REFUSED 같은 dispatch 를 다시 띄우는 다른 실행\\(pid ${process.pid}\\)`, 'm'))
    assert.deepEqual(touched(orcaCalls()), [])
    // 죽은 pid 의 잠금은 치우고 띄운다
    writeFileSync(join(repo, '.orch/state/relaunch-lock/ctx_old.lock'), '999999\n')
    assert.equal(relaunch().code, 0)
    assert.ok(!existsSync(join(repo, '.orch/state/relaunch-lock/ctx_old.lock')))
  })
})

describe('다시 띄우기', () => {
  test('살아 있는 dispatch 는 abandon, 터미널 닫기 뒤 같은 워크트리의 같은 Task 로 띄우고 보존 표시를 지운다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    const r = relaunch()
    assert.equal(r.code, 0, r.out)
    assert.match(r.stdout, /^LAUNCHED ctx_new /m)
    assert.match(r.stdout, /^RELAUNCHED ctx_old ctx_new$/m)
    const order = touched(orcaCalls())
    assert.equal(order.length, 3, order.join('\n'))
    assert.match(order[0], /worker-abandon --dispatch ctx_old/)
    assert.match(order[1], /terminal close --terminal term_old/)
    // abandon 뒤 Task 가 ready 라 --retry-of 를 붙이지 않는다
    assert.match(order[2], /worker-start --run run_1 --task task_1 --worktree path:.*--agent claude --model claude-opus-5-5 --effort medium/)
    assert.doesNotMatch(order[2], /--retry-of/)
    assert.ok(!existsSync(holdFile()))
  })

  test('꺼진 채 목록에 남은 옛 터미널도 닫는다. 자식 launch-worker 가 상태와 상관없이 남은 터미널로 세기 때문이다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ terminals: [{ handle: 'term_old', worktreePath: wt, status: 'exited', connected: false }] })
    const r = relaunch()
    assert.equal(r.code, 0, r.out)
    assert.ok(orcaCalls().some((c) => /terminal close --terminal term_old/.test(c)))
  })

  test('Task 가 failed 면 --retry-of 로 띄운다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ dispatches: { ctx_old: { runId: 'run_1', taskId: 'task_1', status: 'failed', terminal: 'term_old' } }, task: 'failed', terminals: [] })
    const r = relaunch()
    assert.equal(r.code, 0, r.out)
    const order = touched(orcaCalls())
    assert.deepEqual(order.map((c) => c.split(' ').slice(1, 3).join(' ')), ['orchestration worker-start'])
    assert.match(order[0], /--task task_1 --retry-of ctx_old/)
  })

  test('띄우지 못하면 보존 표시를 남기고, 같은 명령을 다시 부르면 abandon 을 건너뛰고 띄운다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ start_fails: true })
    const failed = relaunch()
    assert.equal(failed.code, 1, failed.out)
    assert.match(failed.stdout, /^RELAUNCH-FAIL launch .*NEXT .*worker relaunch --dispatch ctx_old -- --agent claude/m)
    const hold = JSON.parse(readFileSync(holdFile(), 'utf8'))
    assert.equal(hold.worktree, wt)
    assert.equal(hold.spec, spec)
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    writeFileSync(stateFile, JSON.stringify({ ...saved, start_fails: false }))
    writeFileSync(log, '')
    const r = relaunch()
    assert.equal(r.code, 0, r.out)
    assert.match(r.stdout, /^RELAUNCH-TARGET ctx_old task=task_1 status=abandoned/m)
    const order = touched(orcaCalls())
    assert.equal(order.length, 1, order.join('\n'))
    assert.match(order[0], /worker-start/)
    assert.ok(!existsSync(holdFile()))
  })

  test('abandon 이 실패하면 보존 표시를 거두고 아무것도 띄우지 않는다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ abandon_fails: true })
    const r = relaunch()
    assert.equal(r.code, 1, r.out)
    assert.match(r.stdout, /^RELAUNCH-FAIL abandon /m)
    assert.ok(!existsSync(holdFile()))
    assert.ok(!orcaCalls().some((c) => /terminal close|worker-start/.test(c)))
  })
})

describe('다시 띄우기의 갈래', () => {
  test('Task 가 blocked 면 --retry-of 로 띄운다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ dispatches: { ctx_old: { runId: 'run_1', taskId: 'task_1', status: 'failed', terminal: 'term_old' } }, task: 'blocked', terminals: [] })
    const r = relaunch()
    assert.equal(r.code, 0, r.out)
    assert.match(touched(orcaCalls())[0], /--task task_1 --retry-of ctx_old/)
  })

  test('자식이 STALLED-START 로 끝나면 표시를 지우고 자식의 종료 코드를 낸다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    const r = relaunchFake('STALLED-START ctx_new - watch=90s,no-signs-of-life', 1)
    assert.equal(r.code, 1, r.out)
    assert.match(r.stdout, /^STALLED-START ctx_new/m)
    assert.doesNotMatch(r.stdout, /RELAUNCHED|RELAUNCH-FAIL/)
    assert.ok(!existsSync(holdFile()))
  })

  test('자식이 띄우지 못하면 자식의 종료 코드를 그대로 낸다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    const r = relaunchFake('REFUSED before-launch', 5)
    assert.equal(r.code, 5, r.out)
    assert.match(r.stdout, /^RELAUNCH-FAIL launch launch-worker 가 종료 코드 5 로/m)
    assert.ok(existsSync(holdFile()))
  })

  test('터미널을 닫지 못하면 멈추고, 다시 부르면 abandon 없이 닫고 띄운다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ close_fails: true })
    const failed = relaunch()
    assert.equal(failed.code, 1, failed.out)
    assert.match(failed.stdout, /^RELAUNCH-FAIL close 옛 터미널 term_old .*NEXT orca terminal close --terminal term_old 뒤 .*worker relaunch/m)
    assert.ok(existsSync(holdFile()))
    writeFileSync(log, '')
    const r = relaunch()
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(touched(orcaCalls()).map((c) => c.split(' ').slice(1, 3).join(' ')), ['terminal close', 'orchestration worker-start'])
  })

  test('옛 터미널을 닫은 뒤 Orca 가 다시 연 빈 셸을 닫고 띄운다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ reopen_shell: true })
    const r = relaunch()
    assert.equal(r.code, 0, r.out)
    assert.match(r.stdout, /^RELAUNCH-SHELL term_shell /m)
    assert.deepEqual(touched(orcaCalls()).map((c) => c.split(' ').slice(1, 4).join(' ')), ['orchestration worker-abandon --dispatch', 'terminal close --terminal', 'terminal close --terminal', 'orchestration worker-start --run'])
    assert.match(r.stdout, /^RELAUNCHED ctx_old ctx_new$/m)
  })

  test('Task 목록을 읽지 못하면 멈추고 표시를 남긴다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ task_list_fails: true })
    const r = relaunch()
    assert.equal(r.code, 1, r.out)
    assert.match(r.stdout, /^RELAUNCH-FAIL task Task task_1 의 상태를 읽지 못했다/m)
    assert.ok(existsSync(holdFile()))
    assert.ok(!orcaCalls().some((c) => /worker-start/.test(c)))
  })

  test('Task 가 다시 띄울 수 없는 상태면 자식을 부르지 않는다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ after_abandon: 'completed' })
    const r = relaunch()
    assert.equal(r.code, 1, r.out)
    assert.match(r.stdout, /^RELAUNCH-FAIL task Task task_1 의 상태 completed 에서는 다시 띄울 수 없다/m)
    assert.ok(!orcaCalls().some((c) => /worker-start/.test(c)))
  })

  test('abandon 이 오류를 냈어도 dispatch 가 끝났으면 표시를 남긴다', () => {
    writeSpec('claude', 'claude-opus-5-5', 'medium')
    state({ abandon_errors_after: true })
    const r = relaunch()
    assert.equal(r.code, 1, r.out)
    assert.match(r.stdout, /^RELAUNCH-FAIL abandon .*dispatch 상태 abandoned\. 워크트리 보존 표시는 남겼다/m)
    assert.ok(existsSync(holdFile()))
  })
})

describe('사용법', () => {
  test('새 worker 인자가 없거나 relaunch 가 정하는 옵션을 주면 사용법 오류다', () => {
    assert.equal(relaunch([], []).code, 2)
    assert.equal(relaunch([], ['--agent', 'claude', '--model', 'm', '--terminal', 't']).code, 2)
    assert.deepEqual(orcaCalls(), [])
  })

  test('고칠 줄은 에이전트, 모델, effort 만 바꾸고 나머지 칸은 그대로 둔다', () => {
    const line = 'worker 선택: `codex` `gpt-6.1-sol` effort `high`. 행: impl-explore. 이유: x. 후보 밖: y.'
    assert.equal(fixedSelectionLine(line, 'claude', 'claude-sonnet-5-5', null), 'worker 선택: `claude` `claude-sonnet-5-5` effort `기본`. 행: impl-explore. 이유: x. 후보 밖: y.')
    assert.equal(fixedSelectionLine('worker 선택: 없음', 'claude', 'm', null), null)
  })
})
