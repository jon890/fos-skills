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
import { workerPathWithOrch } from './fixtures/worker-orch.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/worker/relaunch-worker.ts', import.meta.url))

// 상태 파일로 움직이는 가짜 orca. 받은 인자를 한 줄씩 기록한다. 확장자가 없어 타입 문법 없이 쓴다.
// worker-abandon 은 dispatch 를 abandoned 로, Task 를 after_abandon 상태로 바꾼다. terminal close 는 목록에서 뺀다
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
if (is('worktree', 'list')) out({ worktrees: [{ path: state.worktree }] })
if (is('terminal', 'list')) out({ terminals: state.terminals })
if (is('terminal', 'close')) {
  state.terminals = state.terminals.filter((t) => t.handle !== opt('--terminal'))
  out({})
}
if (is('orchestration', 'worker-show')) {
  const id = opt('--dispatch')
  const d = state.dispatches[id]
  if (!d) out({}, 1)
  out({ dispatch: Object.assign({ id }, d), worker: { agentTerminalHandle: d.terminal, worktreeId: 'repo::' + state.worktree, stage: 'input_accepted' } })
}
if (is('orchestration', 'dispatch-show')) out({ dispatch: { id: state.latest } })
if (is('orchestration', 'task-list')) out({ tasks: [{ id: 'task_1', status: state.task }] })
if (is('orchestration', 'worker-abandon')) {
  if (state.abandon_fails) out({}, 1)
  state.dispatches[opt('--dispatch')].status = 'abandoned'
  state.task = state.after_abandon
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

const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
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
    FAKE_STATE: stateFile,
    FAKE_LOG: log,
    SPEC_LINT: join(binDir, 'spec-lint-ok.sh'),
    ORCA_CLAUDE_PROFILES: join(tmp, 'no-profiles'),
    ORCH_WORKER_PATH: workerPathWithOrch(tmp),
    LAUNCH_POLL: '0',
    LAUNCH_WT_POLL: '0',
    LAUNCH_WT_WAIT: '3',
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
    next_ids: ['ctx_new'],
    ...values,
  }))
}

function relaunch(extra: string[] = [], worker = ['--agent', 'claude', '--model', 'claude-opus-5-5', '--effort', 'medium']) {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--dispatch', 'ctx_old', '--run', 'run_1', ...extra, '--', ...worker], { env, encoding: 'utf8', timeout: 60_000 })
  return { code: done.status, out: done.stdout + done.stderr, stdout: done.stdout }
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
