// launch-worker.ts 를 가짜 orca 와 가짜 make-worktree 로 본다. Orca 에는 닿지 않는다.
// before-launch 와 worker-launched 핸들러는 임시 저장소의 .orch/hooks/ 에 둔다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { linkBin } from '../../../modules/testkit/fake-bin.ts'
import { launchHistory, recordHistory } from '../scripts/lib/launch-history.ts'
import { recordLaunch } from '../scripts/lib/launched.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/worker/launch-worker.ts', import.meta.url))
const FUNCTION_RUNNER = fileURLToPath(new URL('./fixtures/launch-worker-run.ts', import.meta.url))

// 상태 파일로 움직이는 가짜 orca. 받은 인자를 한 줄씩 기록한다. 확장자가 없어 타입 문법 없이 쓴다.
// macOS 에서 파이프로 가는 process.stdout 쓰기는 비동기라 process.exit 가 출력을 자를 수 있어 writeSync 로 쓴다.
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2).filter((a) => a !== '--json' && a !== '--full')
fs.appendFileSync(process.env.FAKE_LOG, 'orca ' + args.join(' ') + '\\n')
// --full 없이 부른 orchestration 명령은 따로 적는다. Orca 1.4.246 의 줄인 보기는 판정에 쓰는 키를 뺀다
if (args[0] === 'orchestration' && !process.argv.includes('--full')) fs.appendFileSync(process.env.FAKE_LOG + '.concise', args.join(' ') + '\\n')
function out(result, code = 0) {
  fs.writeFileSync(file, JSON.stringify(state))
  fs.writeSync(1, JSON.stringify({ ok: code === 0, result }) + '\\n')
  process.exit(code)
}
function opt(name) {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : null
}
const is = (a, b) => args[0] === a && args[1] === b
if (state.fail) {
  fs.writeSync(1, 'boom\\n')
  process.exit(1)
}
const joined = args.filter((a) => a.startsWith('--') && a.includes(' '))
if (joined.length) {
  fs.writeSync(1, 'Unknown flag ' + joined[0] + '\\n')
  process.exit(1)
}
if (is('worktree', 'list')) {
  const lists = state.worktree_lists
  const paths = lists && lists.length ? lists.shift() : (process.env.FAKE_WT_DEFAULT || '').split(':').filter(Boolean)
  out({ worktrees: paths.map((p) => ({ path: p })) })
}
if (is('repo', 'show')) out({ repo: { externalWorktreeVisibility: state.visibility || 'hide' } })
if (is('terminal', 'list')) out({ terminals: state.terminals || [] })
if (is('terminal', 'read') && state.screen) out({ terminal: { tail: state.screen } })
if (is('terminal', 'close')) out({}, state.close_fails ? 1 : 0)
if (is('orchestration', 'worker-start')) {
  if (state.start_errors && state.start_errors.length) out({ error: state.start_errors.shift() }, 1)
  if (state.start_error_obj) {
    fs.writeSync(1, JSON.stringify({ ok: false, error: state.start_error_obj }) + '\\n')
    process.exit(1)
  }
  if (state.start_fails) out({ failedStage: 'agent_readiness' }, 1)
  const id = state.next_ids.shift()
  if (state.remove_spec) fs.unlinkSync(state.remove_spec)
  out({ dispatch: { id, taskId: 'task_1' }, launch: { effective: state.effective || {} } })
}
if (is('orchestration', 'worker-show')) {
  const d = state.dispatches[opt('--dispatch')]
  // worker 가 워크트리에 파일을 만든 것처럼 한다(일하는 흔적)
  if (state.touch) fs.writeFileSync(state.touch, 'x')
  // 줄인 보기처럼 단계를 맨 위 stage 에 둔다
  if ('flat' in d) out({ dispatchId: opt('--dispatch'), stage: d.flat })
  const stages = d.stages || []
  const stage = stages.length > 1 ? stages.shift() : stages[0] || 'input_accepted'
  out({ dispatch: d.dispatch, worker: Object.assign({}, d.worker || {}, { stage }), terminalResource: d.terminalResource || {} })
}
if (is('orchestration', 'worker-abandon')) out({})
if (is('orchestration', 'worker-list')) out({ workers: state.workers || [], scope: { source: 'all' } })
if (is('orchestration', 'task-list')) out({ tasks: state.tasks || [], scope: { source: 'all' } })
process.exit(3)
`

// CI 에는 git 작성자 설정이 없고, 로컬의 전역 설정은 결과를 바꿀 수 있어 고정한다.
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
let spec: string
let worktree: string
let log: string
let stateFile: string
let env: NodeJS.ProcessEnv

before(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'launch-worker-bin-')))
  linkBin(binDir, 'orca', FAKE_ORCA.replace(/^#![^\n]*\n/, ''))
  writeFileSync(join(binDir, 'spec-lint-ok.sh'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(binDir, 'spec-lint-ok.sh'), 0o755)
})
after(() => rmSync(binDir, { recursive: true, force: true }))

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'launch-worker-')))
  stateFile = join(tmp, 'state.json')
  log = join(tmp, 'log.txt')
  spec = join(tmp, 'spec.md')
  writeFileSync(spec, '# 일\n\n허락: push 와 draft PR 생성은 사용자가 허락했다.\n')
  worktree = join(tmp, 'wt')
  mkdirSync(worktree)
  const make = join(tmp, 'make-worktree.sh')
  writeFileSync(make, `echo "make $*" >> "$FAKE_LOG"; mkdir -p ${tmp}/new; echo ${tmp}/new\n`)
  env = {
    ...process.env,
    ...GIT_ENV,
    // 가짜 orca 의 #! 줄과 launch-worker 가 부르는 spec-line 이 이 테스트의 node 를 쓰게 한다
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    NODE_BIN: process.execPath,
    // 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다
    GIT_CEILING_DIRECTORIES: tmp,
    ORCA: join(binDir, 'orca'),
    // 실제 codex 의 모델 목록에 기대지 않게 없는 실행 파일로 고정한다(검사 불능이라 경고만 나온다)
    CODEX_BIN: join(tmp, 'no-codex'),
    FAKE_STATE: stateFile,
    FAKE_LOG: log,
    MAKE_WORKTREE: make,
    // 기본 spec-lint 는 막을 발견이 없는 가짜다. 막는 경우는 「spec-lint 관문」 에서 따로 본다
    SPEC_LINT: join(binDir, 'spec-lint-ok.sh'),
    // 실제 Orca 프로필에 기대지 않게 없는 폴더로 고정한다(Orca 없음이라 프로필 판정을 건너뛴다). 판정은 「claude 프로필 준비 판정」 에서 본다
    ORCA_CLAUDE_PROFILES: join(tmp, 'no-profiles'),
    LAUNCH_POLL: '0',
    LAUNCH_WT_POLL: '0',
    LAUNCH_WT_WAIT: '3',
    FAKE_WT_DEFAULT: `${worktree}:${tmp}/new:${tmp}/hookwt`,
  }
  delete env.ORCH_DIR
})

afterEach(() => {
  // 모든 테스트에서 orchestration 명령은 --full 로 불려야 한다(lib/orca.ts 의 withFull)
  const concise = `${log}.concise`
  const leaked = existsSync(concise) ? readFileSync(concise, 'utf8') : ''
  rmSync(tmp, { recursive: true, force: true })
  assert.equal(leaked, '', '--full 없이 부른 orchestration 명령')
})

function state(values: Record<string, unknown>): void {
  writeFileSync(stateFile, JSON.stringify(values))
}

function lines(prefix: string): string[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(prefix))
}

function resetLog(): void {
  if (existsSync(log)) unlinkSync(log)
}

function shown(...stages: string[]): Record<string, unknown> {
  return { dispatch: { id: 'x', status: 'dispatched' }, stages }
}

type Launch = { code: number | null; stdout: string; stderr: string }

// 지시서의 worker 선택 줄과 맞춰 넘기는 WORKER_ARGS. 선택 줄 대조 밖의 테스트가 쓴다
const CLAUDE = ['--agent', 'claude', '--model', 'm']
const CODEX = ['--agent', 'codex', '--model', 'm']

// 지시서에 worker 선택 줄이 없으면 WORKER_ARGS 의 --agent, --model 로 채운다. 선택 줄을 보는 테스트는 fill 을 끈다
function fillSelection(args: string[]): void {
  if (!existsSync(spec)) return
  const text = readFileSync(spec, 'utf8')
  if (text.includes('worker 선택')) return
  const passthru = args.slice(args.indexOf('--') + 1)
  const value = (name: string) => (passthru.includes(name) ? passthru[passthru.indexOf(name) + 1] : null)
  const agent = value('--agent') ?? (value('--terminal') ? 'codex' : null)
  const model = value('--model') ?? (value('--terminal') ? 'm' : null)
  if (!args.includes('--') || !agent || !model) return
  writeFileSync(spec, `${text}\nworker 선택: \`${agent}\` \`${model}\` effort \`${value('--effort') ?? '기본'}\`. 행: impl-planned. 비교: 다른 제공자. 이유: 테스트.\n`)
}

function launch(args: string[], shell = 'bash', fill = true, script = FUNCTION_RUNNER): Launch {
  if (fill) fillSelection(args)
  const done = spawnSync(shell, ['-c', 'exec "$NODE_BIN" --disable-warning=ExperimentalWarning "$@"', 'launch', script, '--spec', spec, ...args], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function hasShell(shell: string): boolean {
  return spawnSync(shell, ['-c', 'true']).status === 0
}

function both(r: Launch): string {
  return r.stdout + r.stderr
}

describe('거부와 사용법', () => {
  test('허락 줄이 없는 지시서는 worker-start 전에 거부한다', () => {
    writeFileSync(spec, '# 일\n')
    state({ next_ids: ['ctx_1'] })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stderr, /허락:/)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
  })

  test('기존 워크트리에 남은 터미널이 있으면 목록과 함께 거부한다', () => {
    state({
      next_ids: ['ctx_1'],
      terminals: [
        { handle: 'term_old', title: 'claude 앞 세션', worktreePath: worktree },
        { handle: 'term_other', worktreePath: '/elsewhere' },
      ],
    })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /터미널이 남아 있다/)
    assert.match(r.stdout, /term_old claude 앞 세션/)
    assert.doesNotMatch(r.stdout, /term_other/)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
  })

  test('기존 워크트리에 커밋 안 된 변경이 있으면 목록과 함께 거부하고 --dirty-ack 이면 이유를 남기고 띄운다', () => {
    spawnSync('git', ['init', '-q', worktree], { env })
    writeFileSync(join(worktree, 'kept.txt'), 'a\n')
    spawnSync('git', ['-C', worktree, 'add', 'kept.txt'], { env })
    spawnSync('git', ['-C', worktree, 'commit', '-q', '-m', 'init'], { env })
    writeFileSync(join(worktree, 'kept.txt'), 'b\n')
    mkdirSync(join(worktree, 'other'))
    writeFileSync(join(worktree, 'other', 'revert.ts'), 'x\n')
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /거부: 이 워크트리에 커밋 안 된 변경이 2개 있다/)
    assert.match(r.stdout, /^ M kept\.txt$/m)
    assert.match(r.stdout, /^\?\? other\/revert\.ts$/m)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
    const acked = launch(['--worktree', worktree, '--dirty-ack', '끊긴 worker 의 변경을 이어받는다', '--', ...CLAUDE])
    assert.equal(acked.code, 0, both(acked))
    assert.match(acked.stdout, /^dirty-ack: 끊긴 worker 의 변경을 이어받는다$/m)
    assert.equal(lines('orca orchestration worker-start').length, 1)
  })

  test('커밋 안 된 변경 검사는 launch 가 복사한 설정 파일과 --terminal 이어 쓰기를 보지 않는다', () => {
    spawnSync('git', ['init', '-q', worktree], { env })
    spawnSync('git', ['-C', worktree, 'commit', '-q', '--allow-empty', '-m', 'init'], { env })
    mkdirSync(join(worktree, '.claude'))
    writeFileSync(join(worktree, '.claude', 'settings.local.json'), '{}\n')
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    writeFileSync(join(worktree, 'wip.txt'), 'x\n')
    state({ next_ids: ['ctx_2'], terminals: [{ handle: 'term_old', worktreePath: worktree }], dispatches: { ctx_2: shown('input_accepted') } })
    const reused = launch(['--worktree', worktree, '--', '--terminal', 'term_old'])
    assert.equal(reused.code, 0, both(reused))
    assert.doesNotMatch(both(reused), /커밋 안 된 변경/)
  })

  test('--dirty-ack 에 빈 이유를 주면 사용법 오류다', () => {
    const r = launch(['--worktree', worktree, '--dirty-ack', ' ', '--', ...CLAUDE])
    assert.equal(r.code, 2, both(r))
    assert.match(r.stderr, /--dirty-ack 에는 그대로 띄우는 이유를 적는다/)
  })

  test('--terminal 로 이어 쓰는 터미널은 남은 터미널로 세지 않는다', () => {
    state({ next_ids: ['ctx_1'], terminals: [{ handle: 'term_old', worktreePath: worktree }], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', '--terminal', 'term_old'])
    assert.equal(r.code, 0, both(r))
    assert.ok(lines('orca orchestration worker-start')[0].includes(`--worktree path:${worktree} --terminal term_old`))
  })

  test('--terminal 과 --agent, --model, --effort 는 orca 를 부르기 전에 거부한다', () => {
    state({ next_ids: ['ctx_1'] })
    for (const opt of ['--agent', '--model', '--effort']) {
      const r = launch(['--worktree', worktree, '--', '--terminal', 'term_old', opt, 'x'])
      assert.equal(r.code, 1, both(r))
      assert.match(r.stderr, /함께 쓰지 못한다/)
      assert.ok(r.stderr.includes(opt), r.stderr)
    }
    assert.equal(existsSync(log), false)
  })

  test('이어 쓰는 터미널의 agent_unconfigured 는 터미널을 닫지 않고 3 이다', () => {
    state({
      next_ids: ['ctx_1'],
      terminals: [{ handle: 'term_old', worktreePath: worktree }],
      start_errors: ['agent_unconfigured: Terminal term_old is not running a recognized agent'],
    })
    const r = launch(['--worktree', worktree, '--', '--terminal', 'term_old'])
    assert.equal(r.code, 3, both(r))
    assert.match(r.stderr, /agent_unconfigured/)
    assert.match(r.stderr, /orca terminal close/)
    assert.deepEqual(lines('orca terminal close'), [])
    assert.equal(lines('orca orchestration worker-start').length, 1)
  })

  test('hooks review prompt 는 Codex 매니페스트 갱신 명령을 알린다', () => {
    state({ next_ids: ['ctx_1'], start_errors: ['Agent startup blocked: agent-hooks-review-prompt'] })
    const r = launch(['--worktree', worktree, '--', ...CODEX])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stderr, /codex plugin marketplace upgrade fos-skills/)
  })

  test('--terminal 없이 난 agent_unconfigured 는 보통 실패다', () => {
    state({ next_ids: ['ctx_1'], start_errors: ['agent_unconfigured: x'] })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
  })

  test('옮기기 전의 orch 폴더가 있으면 orca 전에 2 로 멈춘다', () => {
    const legacy = join(worktree, '.omc/orch')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'old.json'), '{}')
    const r = launch(['--worktree', `path:${worktree}`, '--', ...CODEX])
    assert.equal(r.code, 2, both(r))
    assert.match(r.stderr, /옮기기 전/)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
  })

  test('사용법 오류는 2 다', () => {
    for (const args of [[], ['--worktree', 'x', '--name', 'y'], ['--repo', 'x'], ['--worktree', 'x', '--agent', 'c'], ['--worktree', 'x', '--watch', '1.5']]) {
      assert.equal(launch(args).code, 2, JSON.stringify(args))
    }
  })

  test('옵션의 고유 접두는 펼치고 여러 옵션에 맞는 접두는 2 다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--work', worktree, '--wat=0', '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.ok(lines('orca orchestration worker-start')[0].includes(`--worktree path:${worktree} --agent claude`), lines('').join('\n'))
    // --re 는 --repo 와 --resume-remote 에 맞는다
    const ambiguous = launch(['--re', tmp, '--name', 'x', '--', ...CLAUDE])
    assert.equal(ambiguous.code, 2, both(ambiguous))
    assert.match(ambiguous.stderr, /--re 이 여러 옵션의 접두다: --retry-of, --repo, --resume-remote/)
  })
})

describe('worker 선택 줄 대조', () => {
  const SELECTED = '# 일\n허락: push\n- **worker 선택:** `codex` `gpt-6.1-sol` effort `low`. 행: impl-planned. 비교: Claude Sonnet 5.5. 이유: CI 리뷰가 Claude 다.\n'

  test('선택 줄이 없으면 orca 를 부르기 전에 형식과 함께 거부한다', () => {
    state({ next_ids: ['ctx_1'] })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE], 'bash', false)
    assert.equal(r.code, 1, both(r))
    assert.match(r.stderr, /`worker 선택:` 줄이 없다/)
    assert.match(r.stderr, /형식: worker 선택: `<에이전트>` `<모델>` effort/)
    assert.equal(existsSync(log), false)
  })

  test('비교나 이유가 빠진 선택 줄은 거부하고 --lint-ack 으로도 넘기지 못한다', () => {
    writeFileSync(spec, '# 일\n허락: push\nworker 선택: `codex` `gpt-6.1-sol` effort `low`\n')
    state({ next_ids: ['ctx_1'] })
    const r = launch(['--worktree', worktree, '--lint-ack', '의도', '--', '--agent', 'codex', '--model', 'gpt-6.1-sol'], 'bash', false)
    assert.equal(r.code, 1, both(r))
    assert.match(r.stderr, /행 가 빠졌거나 형식이 틀렸다; 비교 가 빠졌거나 형식이 틀렸다; 이유 가 빠졌거나 형식이 틀렸다/)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
  })

  test('--agent 나 --model 이 선택 줄과 다르면 둘 다 알리고 거부한다', () => {
    writeFileSync(spec, SELECTED)
    state({ next_ids: ['ctx_1'] })
    const r = launch(['--worktree', worktree, '--', '--agent', 'claude', '--model', 'claude-sonnet-5-5'], 'bash', false)
    assert.equal(r.code, 1, both(r))
    assert.match(r.stderr, /--agent claude, 지시서 codex; --model claude-sonnet-5-5, 지시서 gpt-6\.1-sol/)
    assert.equal(existsSync(log), false)
  })

  test('선택 줄과 effort 가 같으면 띄운다', () => {
    writeFileSync(spec, SELECTED)
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', '--agent', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'low'], 'bash', false)
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /LAUNCHED ctx_1/)
  })

  test('--terminal 로 이어 쓸 때도 선택 줄을 검사한다', () => {
    writeFileSync(spec, '# 일\n허락: push\n')
    state({ next_ids: ['ctx_1'], terminals: [{ handle: 'term_old', worktreePath: worktree }], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', '--terminal', 'term_old'], 'bash', false)
    assert.equal(r.code, 1, both(r))
  })
})

describe('선택 정책과 영구 이력', () => {
  const select = (agent = 'codex', model = 'gpt-6.1-sol', effort = 'medium', extra = '') =>
    writeFileSync(spec, `# 선택 검사\n허락: push\nworker 선택: \`${agent}\` \`${model}\` effort \`${effort}\`. 행: impl-planned. ${extra} 비교: 다른 모델. 이유: 테스트.\n`)
  const history = () => readFileSync(join(worktree, '.orch/state/launch-history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const prior = (extra = {}) => ({ dispatch: 'ctx_old', task: 'task_1', terminal: 'term_old', worktree, branch: 'feat/a', run: null, at: '2026-11-05T00:00:00Z', title: '이전 작업', row: 'impl-planned', agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', retry_of: null, ...extra })

  test('행 누락, Opus 근거 누락과 effort 불일치는 ack 으로도 새 워크트리를 만들기 전에 거부한다', () => {
    for (const kind of ['row', 'high', 'effort']) {
      select(kind === 'high' ? 'claude' : 'codex', kind === 'high' ? 'claude-opus-5-5' : 'gpt-6.1-sol', kind === 'high' ? 'high' : 'medium')
      if (kind === 'row') writeFileSync(spec, readFileSync(spec, 'utf8').replace('행: impl-planned.', ''))
      state({ next_ids: ['ctx_1'] })
      const r = launch(['--repo', tmp, '--name', 'new', '--lint-ack', '의도', '--', '--agent', kind === 'high' ? 'claude' : 'codex', '--model', kind === 'high' ? 'claude-opus-5-5' : 'gpt-6.1-sol', '--effort', 'low'], 'bash', false)
      assert.equal(r.code, 1, both(r))
      assert.deepEqual(lines('make'), [])
      assert.deepEqual(lines('orca orchestration worker-start'), [])
    }
  })

  test('요청 값, effective, 실험 이름과 행이 정리용 기록과 영구 이력에 남는다', () => {
    select()
    writeFileSync(spec, readFileSync(spec, 'utf8') + 'experiment: sample. 후보: `codex` `gpt-6.1-sol` effort `medium` / `claude` `claude-sonnet-5-5` effort `medium`.\n')
    const effective = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') }, effective })
    const r = launch(['--worktree', worktree, '--', '--agent', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'medium'], 'bash', false)
    assert.equal(r.code, 0, both(r))
    const record = JSON.parse(readFileSync(join(worktree, '.orch/state/launched-workers/ctx_1.json'), 'utf8'))
    assert.deepEqual([record.agent, record.model, record.effort, record.effective, record.experiment], ['codex', 'gpt-6.1-sol', 'medium', effective, 'sample'])
    assert.equal(history()[0].row, 'impl-planned')
    assert.equal(history()[0].title, '선택 검사')
    assert.equal(history()[0].retry_of, null)
  })

  test('띄운 뒤 지시서가 사라져도 이력을 남기고 성공을 유지한다', () => {
    select()
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') }, remove_spec: spec, effective: 'unknown' })
    const r = launch(['--worktree', worktree, '--', '--agent', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'medium'], 'bash', false)
    assert.equal(r.code, 0, both(r))
    assert.equal(history()[0].row, 'impl-planned')
    assert.equal(history()[0].effective, null)
  })

  test('experiment terminal 이어 쓰기는 다음 후보를 요구하지 않고 배정 수에서 제외한다', () => {
    select()
    writeFileSync(spec, readFileSync(spec, 'utf8') + 'experiment: continue-trial. 후보: `codex` `gpt-6.1-sol` effort `medium` / `claude` `claude-sonnet-5-5` effort `medium`.\n')
    recordHistory(worktree, prior({ experiment: 'continue-trial' }))
    state({ next_ids: ['ctx_1'], terminals: [{ handle: 'term_old', worktreePath: worktree }], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', '--terminal', 'term_old'], 'bash', false)
    assert.equal(r.code, 0, both(r))
    assert.equal(history()[1].retry_of, 'ctx_old')
    assert.equal(history().filter(row => row.experiment === 'continue-trial' && !row.retry_of).length, 1)
  })

  test('terminal 이어 쓰기는 마지막 이력의 요청값을 물려받는다', () => {
    select()
    recordHistory(worktree, prior())
    state({ next_ids: ['ctx_1'], terminals: [{ handle: 'term_old', worktreePath: worktree }], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', '--terminal', 'term_old'], 'bash', false)
    assert.equal(r.code, 0, both(r))
    assert.deepEqual([history()[1].agent, history()[1].model, history()[1].effort], ['codex', 'gpt-6.1-sol', 'medium'])
  })

  test('같은 Task 재시도는 이력의 워크트리를 쓰고 새 Task 나 배정을 만들지 않는다', () => {
    select()
    recordHistory(tmp, prior({ completion: 'none' }))
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--repo', tmp, '--task', 'task_1', '--retry-of', 'ctx_old', '--', '--agent', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'medium'], 'bash', false)
    assert.equal(r.code, 0, both(r))
    const call = lines('orca orchestration worker-start')[0]
    assert.match(call, /--task task_1 --retry-of ctx_old/)
    assert.doesNotMatch(call, /--spec/)
    assert.equal(JSON.parse(readFileSync(join(tmp, '.orch/state/launch-history.jsonl'), 'utf8').trim().split('\n')[1]).retry_of, 'ctx_old')
    assert.equal(JSON.parse(readFileSync(join(tmp, '.orch/state/launch-history.jsonl'), 'utf8').trim().split('\n')[1]).completion, 'none')
    assert.deepEqual(lines('make'), [])
  })

  test('ready Task 는 retry-of 없이도 이력에서 이어 띄운다', () => {
    select()
    recordHistory(tmp, prior())
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--repo', tmp, '--task', 'task_1', '--', '--agent', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'medium'], 'bash', false)
    assert.equal(r.code, 0, both(r))
    assert.match(lines('orca orchestration worker-start')[0], /--task task_1/)
    assert.doesNotMatch(lines('orca orchestration worker-start')[0], /--retry-of/)
  })

  test('같은 Task 를 열린 터미널에 다시 이을 때 선택 검사와 이력을 모두 거친다', () => {
    select()
    recordLaunch(tmp, prior())
    state({ next_ids: ['ctx_1'], terminals: [{ handle: 'term_new', worktreePath: worktree }], dispatches: { ctx_1: shown('input_accepted') } })
    const args = ['--repo', tmp, '--task', 'task_1', '--', '--terminal', 'term_new']
    writeFileSync(spec, readFileSync(spec, 'utf8').replace('행: impl-planned.', '행: unknown-row.'))
    const rejected = launch(args, 'bash', false)
    assert.equal(rejected.code, 1, both(rejected))
    assert.deepEqual(lines('orca orchestration worker-start'), [])
    select()
    const r = launch(args, 'bash', false)
    assert.equal(r.code, 0, both(r))
    assert.match(lines('orca orchestration worker-start')[0], /--task task_1 .*--terminal term_new/)
    const recorded = JSON.parse(readFileSync(join(tmp, '.orch/state/launch-history.jsonl'), 'utf8'))
    assert.equal(recorded.retry_of, 'ctx_old')
    assert.equal(recorded.row, 'impl-planned')
    assert.equal(recorded.terminal, 'term_new')
  })

  test('effort 기본은 --effort 를 생략한 경우에만 허용한다', () => {
    select('claude', 'haiku', '기본')
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const args = ['--worktree', worktree, '--', '--agent', 'claude', '--model', 'haiku']
    const rejected = launch([...args, '--effort', 'medium'], 'bash', false)
    assert.equal(rejected.code, 1, both(rejected))
    assert.deepEqual(lines('orca orchestration worker-start'), [])
    assert.equal(launch(args, 'bash', false).code, 0)
  })

  test('resume NEXT 새 터미널은 이전 dispatch 의 모델을 물려받고 잘못된 high 근거가 되지 않는다', () => {
    select('claude', 'claude-sonnet-5-5', 'medium')
    recordLaunch(tmp, prior({ agent: 'claude', model: 'claude-sonnet-5-5' }))
    state({ next_ids: ['ctx_1'], terminals: [{ handle: 'term_new', worktreePath: worktree }], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--repo', tmp, '--task', 'task_1', '--', '--terminal', 'term_new'], 'bash', false)
    assert.equal(r.code, 0, both(r))
    const recorded = JSON.parse(readFileSync(join(tmp, '.orch/state/launch-history.jsonl'), 'utf8'))
    assert.deepEqual([recorded.agent, recorded.model, recorded.effort], ['claude', 'claude-sonnet-5-5', 'medium'])
    select('claude', 'claude-opus-5-5', 'high', 'high 근거: medium 실패 ctx_1.')
    const raised = launch(['--repo', tmp, '--name', 'raised', '--', '--agent', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high'], 'bash', false)
    assert.equal(raised.code, 1, both(raised))
    assert.match(raised.stderr, /Opus medium/)
  })

  for (const mode of ['task-retry', 'resume-terminal', 'terminal'] as const) {
    test(`옛 선택 줄의 행 누락은 이미 띄운 지시서의 ${mode} 경로에서 호환한다`, () => {
      select()
      writeFileSync(spec, readFileSync(spec, 'utf8').replace('행: impl-planned.', ''))
      env.GIT_CEILING_DIRECTORIES = dirname(tmp)
      spawnSync('git', ['init', '-q', '-b', 'main', tmp], { env })
      writeFileSync(join(tmp, '.gitignore'), '*\n')
      spawnSync('git', ['-C', tmp, 'add', '-f', '.gitignore'], { env })
      spawnSync('git', ['-C', tmp, 'commit', '-qm', 'initial'], { env })
      spawnSync('git', ['-C', tmp, 'update-ref', 'refs/remotes/origin/main', 'HEAD'], { env })
      recordHistory(tmp, prior({ spec }))
      env.SPEC_LINT = fileURLToPath(new URL('../scripts/spec/spec-lint.ts', import.meta.url))
      const terminal = mode === 'resume-terminal' ? 'term_new' : 'term_old'
      state({ next_ids: ['ctx_1'], terminals: mode === 'task-retry' ? [] : [{ handle: terminal, worktreePath: worktree }], dispatches: { ctx_1: shown('input_accepted') } })
      const args = mode === 'terminal' ? ['--worktree', worktree, '--', '--terminal', terminal]
        : mode === 'resume-terminal' ? ['--repo', tmp, '--task', 'task_1', '--', '--terminal', terminal]
        : ['--repo', tmp, '--task', 'task_1', '--retry-of', 'ctx_old', '--', '--agent', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'medium']
      const r = launch(args, 'bash', false)
      assert.equal(r.code, 0, both(r))
      const recorded = readFileSync(join(tmp, '.orch/state/launch-history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1)
      assert.equal(recorded.row, null)
      assert.equal(recorded.retry_of, 'ctx_old')
    })
  }

  test('옛 지시서라도 모델을 바꿔 재시도하면 행이 필요하다', () => {
    select('claude', 'claude-sonnet-5-5', 'medium')
    writeFileSync(spec, readFileSync(spec, 'utf8').replace('행: impl-planned.', ''))
    recordHistory(tmp, prior({ spec }))
    const r = launch(['--repo', tmp, '--task', 'task_1', '--retry-of', 'ctx_old', '--', '--agent', 'claude', '--model', 'claude-sonnet-5-5', '--effort', 'medium'], 'bash', false)
    assert.equal(r.code, 1, both(r))
    assert.match(r.stderr, /행/)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
  })

  for (const change of ['effort', 'spec'] as const) {
    test(`옛 선택 줄도 ${change}를 바꿔 재시도하면 행이 필요하다`, () => {
      select('codex', 'gpt-6.1-sol', change === 'effort' ? 'high' : 'medium')
      writeFileSync(spec, readFileSync(spec, 'utf8').replace('행: impl-planned.', ''))
      recordHistory(tmp, prior({ spec: change === 'spec' ? join(tmp, 'previous-spec.md') : spec }))
      const r = launch(['--repo', tmp, '--task', 'task_1', '--retry-of', 'ctx_old', '--', '--agent', 'codex', '--model', 'gpt-6.1-sol', '--effort', change === 'effort' ? 'high' : 'medium'], 'bash', false)
      assert.equal(r.code, 1, both(r))
      assert.match(r.stderr, /행/)
      assert.deepEqual(lines('orca orchestration worker-start'), [])
    })
  }

  test('이력의 마지막 손상 줄은 경고하고 정상 dispatch 로 다시 띄운다', () => {
    select('claude', 'claude-opus-5-5', 'high', 'high 근거: medium 실패 ctx_old.')
    recordHistory(tmp, prior({ agent: 'claude', model: 'claude-opus-5-5' }))
    const file = join(tmp, '.orch/state/launch-history.jsonl')
    writeFileSync(file, readFileSync(file, 'utf8') + '{"dispatch":')
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--repo', tmp, '--task', 'task_1', '--retry-of', 'ctx_old', '--', '--agent', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high'], 'bash', false)
    assert.equal(r.code, 0, both(r))
    assert.match(r.stderr, /LAUNCH-HISTORY-SKIP/)
    assert.match(readFileSync(file, 'utf8'), /"dispatch":"ctx_1"/)
    assert.equal(launchHistory(tmp).at(-1)?.dispatch, 'ctx_1')
  })

  test('이전 dispatch 의 터미널이 열려 있으면 다른 에이전트를 같은 워크트리에 띄우지 않는다', () => {
    select()
    recordHistory(tmp, prior())
    state({ next_ids: ['ctx_1'], terminals: [{ handle: 'term_old', worktreePath: worktree }], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--repo', tmp, '--task', 'task_1', '--retry-of', 'ctx_old', '--', '--agent', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'medium'], 'bash', false)
    assert.equal(r.code, 1, both(r))
    assert.match(both(r), /터미널이 남아 있다/)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
  })

  test('모델 없는 옛 Launch 를 근거로 Opus high 를 띄울 수 있다', () => {
    select('claude', 'claude-opus-5-5', 'high', 'high 근거: medium 실패 ctx_old.')
    recordLaunch(worktree, { dispatch: 'ctx_old', terminal: null, worktree, run: null })
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', '--agent', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high'], 'bash', false)
    assert.equal(r.code, 0, both(r))
  })
})

describe('띄우기', () => {
  test('새 워크트리를 만들고 첫 지시 줄에 허락을 싣는다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--repo', tmp, '--name', 'feat', '--base', 'develop', '--run', 'run_x', '--', '--agent', 'codex', '--model', 'm'])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('make'), [`make --repo ${tmp} --spec ${spec} --name feat --base develop`])
    const start = lines('orca orchestration worker-start')[0]
    assert.ok(start.includes('--run run_x --spec 지시서 '), start)
    assert.ok(start.includes('push 와 draft PR 생성은 사용자가 허락했다.'), start)
    assert.ok(start.includes(`--worktree path:${tmp}/new --agent codex --model m`), start)
    assert.ok(r.stdout.trimEnd().endsWith(`LAUNCHED ctx_1 ${tmp}/new`), r.stdout)
  })

  test('--resume-remote 를 워크트리 만들기에 넘긴다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--repo', tmp, '--name', 'feat', '--resume-remote', '--', ...CODEX])
    assert.equal(r.code, 0, both(r))
    assert.ok(lines('make')[0].includes('--resume-remote'))
  })

  test('bash 와 zsh 에서 선택 옵션이 따로인 낱말로 간다', () => {
    // zsh 는 ${run:+--run "$run"} 를 나누지 않아 worker-start 가 Unknown flag --run run_x 로 실패한 일이 있다
    for (const shell of ['bash', 'zsh']) {
      if (!hasShell(shell)) continue
      resetLog()
      rmSync(join(tmp, 'new'), { recursive: true, force: true })
      state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
      const r = launch(['--repo', tmp, '--name', 'feat', '--base', 'develop', '--run', 'run_x', '--watch', '1', '--', ...CODEX], shell, true, SCRIPT)
      assert.equal(r.code, 0, `${shell}: ${both(r)}`)
      assert.deepEqual(lines('make'), [`make --repo ${tmp} --spec ${spec} --name feat --base develop`])
      const [first] = lines('orca orchestration worker-start')
      assert.ok(first.startsWith('orca orchestration worker-start --run run_x --spec '), first)
      assert.equal(lines('orca orchestration worker-start').length, 1)
    }
  })

  test('--run 과 --base 가 없으면 빈 낱말을 넘기지 않는다', () => {
    for (const shell of ['bash', 'zsh']) {
      if (!hasShell(shell)) continue
      resetLog()
      state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
      const r = launch(['--repo', tmp, '--name', 'feat', '--', ...CODEX], shell, true, SCRIPT)
      assert.equal(r.code, 0, `${shell}: ${both(r)}`)
      assert.deepEqual(lines('make'), [`make --repo ${tmp} --spec ${spec} --name feat`])
      assert.ok(lines('orca orchestration worker-start')[0].startsWith('orca orchestration worker-start --spec '))
    }
  })

  test('--worktree 는 path: 접두를 받는다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', `path:${worktree}`, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.ok(lines('orca orchestration worker-start')[0].includes(`--worktree path:${worktree} --agent claude`))
    assert.ok(r.stdout.trimEnd().endsWith(`LAUNCHED ctx_1 ${worktree}`), r.stdout)
  })

  test('워크트리를 만든 뒤 실패하면 이어 띄우는 명령을 알린다', () => {
    for (const shell of ['bash', 'zsh']) {
      if (!hasShell(shell)) continue
      state({ start_fails: true, terminals: [{ handle: 'term_left', title: 'codex hooks review', worktreePath: `${tmp}/new` }] })
      const r = launch(['--repo', tmp, '--name', 'feat', '--run', 'run_x', '--', '--agent', 'codex', '--model', 'gpt 6'], shell, true, SCRIPT)
      assert.equal(r.code, 1, both(r))
      assert.ok(r.stderr.includes(`워크트리는 남아 있다: ${tmp}/new`), r.stderr)
      // 사람이 그대로 붙여 넣는 명령이라 실행 규칙의 꼴(node 와 경고 끄기, 이 파일의 절대경로)이다
      const hint = `  node --disable-warning=ExperimentalWarning ${SCRIPT} --spec ${spec} --worktree ${tmp}/new --run run_x -- --agent codex --model 'gpt 6'`
      assert.ok(r.stderr.split('\n').includes(hint), r.stderr)
      assert.match(r.stderr, /term_left codex hooks review/)
    }
  })

  test('worker-start 가 성공한 뒤의 실패는 이어 띄우는 명령을 알리지 않는다', () => {
    // dispatch 가 이미 떠 있으면 --worktree 로 다시 띄우라고 하지 않는다. 같은 일의 task 가 하나 더 생긴다
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('worktree_creating') } })
    const r = launch(['--repo', tmp, '--name', 'feat', '--watch', '1', '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.doesNotMatch(r.stderr, /워크트리는 남아 있다/)
  })

  test('기존 워크트리의 실패와 성공은 이어 띄우는 명령을 알리지 않는다', () => {
    state({ start_fails: true })
    let r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.doesNotMatch(r.stderr, /워크트리는 남아 있다/)
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    r = launch(['--repo', tmp, '--name', 'feat', '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.doesNotMatch(r.stderr, /워크트리는 남아 있다/)
  })

  test('worktree_creating 에서 시간이 넘으면 멈춤만 알리고 abandon 과 재시도를 하지 않는다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('worktree_creating') } })
    const r = launch(['--worktree', worktree, '--watch', '3', '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.deepEqual(lines('orca orchestration worker-abandon'), [])
    assert.equal(lines('orca orchestration worker-start').length, 1)
    assert.match(r.stdout, /^STALLED-START ctx_1 worktree_creating watch=3s,no-signs-of-life terminal=- screen=unavailable$/m)
    assert.doesNotMatch(r.stdout, /LAUNCHED/)
  })

  test('worktree_creating 이어도 heartbeat 가 있으면 abandon 하지 않고 LAUNCHED 다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: { ...shown('worktree_creating'), dispatch: { lastHeartbeatAt: '2026-11-02T08:00:00Z' } } } })
    const r = launch(['--worktree', worktree, '--watch', '1', '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration worker-abandon'), [])
    assert.equal(lines('orca orchestration worker-start').length, 1)
    assert.match(r.stdout, /ctx_1 단계는 worktree_creating 지만 일하는 흔적이 있어\(heartbeat 2026-11-02T08:00:00Z\) 다시 띄우지 않는다/)
    assert.match(r.stdout, /LAUNCHED ctx_1/)
  })

  test('worktree_creating 이어도 워크트리가 바뀌었으면 abandon 하지 않는다', () => {
    spawnSync('git', ['init', '-q', worktree], { env })
    spawnSync('git', ['-C', worktree, 'commit', '-q', '--allow-empty', '-m', 'init'], { env })
    // 가짜 worker-show 가 불릴 때 워크트리에 파일이 생긴 것처럼, 첫 worker-show 앞에 미리 바꿔 둘 수 없어 단계 목록을 길게 둔다
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('worktree_creating') }, touch: join(worktree, 'made-by-worker.txt') })
    const r = launch(['--worktree', worktree, '--watch', '1', '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration worker-abandon'), [])
    assert.match(r.stdout, /일하는 흔적이 있어\(워크트리 변경\)/)
  })

  for (const sample of [
    { screen: ['›'], state: 'idle', stalled: true },
    { screen: undefined, state: 'unknown', stalled: true },
    { screen: ['• Working (1s • esc to interrupt)'], state: 'working', stalled: false },
    { screen: ['Do you want to proceed?'], state: 'permission', stalled: false },
  ]) test(`시작 확인 화면 ${sample.state} 의 관측을 남기고 자동 포기하지 않는다`, () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: { ...shown('worktree_creating'), worker: { agentTerminalHandle: 'term_wait' } } }, screen: sample.screen })
    const r = launch(['--worktree', worktree, '--watch', '1', '--', ...CLAUDE])
    assert.equal(r.code, sample.stalled ? 1 : 0, both(r))
    if (sample.stalled) {
      assert.match(r.stdout, new RegExp(`^STALLED-START ctx_1 worktree_creating .*terminal=term_wait screen=${sample.state}$`, 'm'))
      assert.doesNotMatch(r.stdout, /LAUNCHED/)
    } else {
      assert.match(r.stdout, /LAUNCHED ctx_1/)
      assert.match(r.stdout, new RegExp(`터미널 화면 ${sample.state}`))
    }
    assert.deepEqual(lines('orca orchestration worker-abandon'), [])
    assert.equal(lines('orca orchestration worker-start').length, 1)
  })

  test('줄인 보기의 stage 키도 단계로 읽는다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: { flat: 'input_accepted' } } })
    const r = launch(['--worktree', worktree, '--watch', '3', '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /ctx_1 단계: input_accepted/)
  })

  test('지켜보는 동안 단계가 넘어가면 그대로 둔다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('worktree_creating', 'agent_starting') } })
    const r = launch(['--worktree', worktree, '--watch', '5', '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration worker-abandon'), [])
    assert.match(r.stdout, /ctx_1 단계: agent_starting/)
  })

  describe('띄운 worker 의 기록', () => {
    const recordOf = (dispatch: string) => join(worktree, '.orch/state/launched-workers', `${dispatch}.json`)

    test('--no-pr 는 정리 기록과 영구 이력에 PR 없는 작업을 남긴다', () => {
      state({ next_ids: ['ctx_1'], dispatches: { ctx_1: { ...shown('input_accepted'), worker: { agentTerminalHandle: 'term_w' } } } })
      const r = launch(['--spec', spec, '--worktree', worktree, '--run', 'run_a', '--no-pr', '--watch', '0', '--', ...CLAUDE])
      assert.equal(r.code, 0, r.stderr + r.stdout)
      const entry = JSON.parse(readFileSync(join(worktree, '.orch', 'state', 'launched-workers', 'ctx_1.json'), 'utf8'))
      assert.equal(entry.completion, 'none')
      const history = readFileSync(join(worktree, '.orch', 'state', 'launch-history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.equal(history.at(-1).completion, 'none')
    })

    test('LAUNCHED 뒤 dispatch, Task, 터미널, 워크트리, 브랜치, 지시서를 상태 폴더에 남긴다', () => {
      const init = spawnSync('git', ['init', '-q', '-b', 'feature/record', worktree], { env, encoding: 'utf8' })
      assert.equal(init.status, 0, init.stderr)
      state({
        next_ids: ['ctx_1'],
        dispatches: { ctx_1: { ...shown('input_accepted'), worker: { agentTerminalHandle: 'term_w' } } },
      })
      const r = launch(['--worktree', worktree, '--run', 'run_a', '--', ...CLAUDE])
      assert.equal(r.code, 0, both(r))
      assert.deepEqual(JSON.parse(readFileSync(recordOf('ctx_1'), 'utf8')), {
        dispatch: 'ctx_1',
        task: 'task_1',
        terminal: 'term_w',
        branch: 'feature/record',
        worktree,
        run: 'run_a',
        spec: resolve(spec),
        agent: 'claude', model: 'm', effort: null, effective: {}, experiment: null,
      })
    })

    test('시간 초과도 재개용 기록을 남기고 같은 Task 의 워크트리를 다시 찾는다', () => {
      const board = join(worktree, '.omc/board.json')
      mkdirSync(dirname(board), { recursive: true })
      writeFileSync(board, JSON.stringify({ items: [] }))
      state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('worktree_creating') } })
      const r = launch(['--worktree', worktree, '--watch', '3', '--', ...CLAUDE])
      assert.equal(r.code, 1, both(r))
      assert.ok(existsSync(recordOf('ctx_1')))
      assert.ok(!existsSync(recordOf('ctx_2')))
      assert.ok(!existsSync(join(worktree, '.orch/state/launch-history.jsonl')))
      assert.equal(JSON.parse(readFileSync(board, 'utf8')).items[0].status, 'doing')
      resetLog()
      // 사용자가 포기를 결정해 기존 dispatch 를 정리한 뒤 ready Task 를 다시 띄우는 상황이다.
      state({ next_ids: ['ctx_2'], dispatches: { ctx_2: shown('input_accepted') } })
      const resumed = launch(['--repo', worktree, '--task', 'task_1', '--', ...CLAUDE])
      assert.equal(resumed.code, 0, both(resumed))
      assert.match(lines('orca orchestration worker-start')[0], /--task task_1 --worktree path:/)
      assert.doesNotMatch(lines('orca orchestration worker-start')[0], /--retry-of/)
      assert.ok(existsSync(recordOf('ctx_2')))
    })

    test('--terminal 이어 쓰기는 그 터미널을 기록한다', () => {
      state({ next_ids: ['ctx_1'], terminals: [{ handle: 'term_old', worktreePath: worktree }], dispatches: { ctx_1: shown('input_accepted') } })
      const r = launch(['--worktree', worktree, '--', '--terminal', 'term_old'])
      assert.equal(r.code, 0, both(r))
      assert.equal(JSON.parse(readFileSync(recordOf('ctx_1'), 'utf8')).terminal, 'term_old')
    })

    test('기록하지 못해도 LAUNCHED 와 종료 코드는 그대로다', () => {
      state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
      writeFileSync(join(worktree, '.orch'), '폴더가 아니라 파일이다')
      const r = launch(['--worktree', worktree, '--', ...CLAUDE])
      assert.equal(r.code, 0, both(r))
      assert.match(r.stdout, /LAUNCHED ctx_1/)
      assert.match(r.stderr, /띄운 worker 를 기록하지 못했다/)
    })
  })

  test('worker-start 의 오류 code 와 message 를 한 줄로 낸다', () => {
    state({ start_error_obj: { code: 'invalid_argument', message: 'Agent claude model haiku does not support effort low.' } })
    const r = launch(['--worktree', worktree, '--', '--agent', 'claude', '--model', 'haiku', '--effort', 'low'])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stderr, /^worker-start 오류: invalid_argument: Agent claude model haiku does not support effort low\.$/m)
  })

  test('실패한 worker-start 는 다시 띄우지 않는다', () => {
    state({ start_fails: true })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.equal(lines('orca orchestration worker-start').length, 1)
  })
})

describe('Orca 의 워크트리 인식', () => {
  test('orca worktree list 에 보일 때까지 기다린다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') }, worktree_lists: [[], [], [worktree]] })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.equal(lines('orca worktree list').length, 3)
    assert.match(r.stderr, /알아보기까지 2초 기다렸다/)
  })

  test('기다린 초는 옛 명령의 :g 꼴로 낸다', () => {
    // 0.1 을 세 번 더하면 0.30000000000000004 다. 옛 명령은 0.3 으로 냈다
    env.LAUNCH_WT_POLL = '0.1'
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') }, worktree_lists: [[], [], [], [worktree]] })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.match(r.stderr, /^Orca 가 워크트리를 알아보기까지 0\.3초 기다렸다$/m)
  })

  test('끝까지 보이지 않으면 띄우지 않고 멈춘다', () => {
    state({ next_ids: ['ctx_1'], worktree_lists: Array.from({ length: 20 }, () => []) })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stderr, /Orca 가 워크트리를 알아보지 못했다/)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
  })

  test('알아보지 못하면 표시 설정과 사용자 조치를 알린다', () => {
    const repo = join(tmp, 'proj')
    const git = (...args: string[]) => assert.equal(spawnSync('git', args, { env }).status, 0, args.join(' '))
    git('init', '-q', repo)
    git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'i')
    const wt = join(tmp, 'elsewhere', 'x')
    git('-C', repo, 'worktree', 'add', '-q', '-b', 'b', wt)
    state({ next_ids: ['ctx_1'], worktree_lists: Array.from({ length: 20 }, () => []), visibility: 'hide' })
    const r = launch(['--worktree', wt, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.ok(r.stderr.includes(`만든 경로: ${wt}`), r.stderr)
    assert.match(r.stderr, /externalWorktreeVisibility: hide/)
    assert.ok(r.stderr.includes(`orca repo set --repo path:${repo} --external-worktree-visibility show`), r.stderr)
    assert.deepEqual(lines('orca repo set'), [])
    assert.deepEqual(lines('orca orchestration worker-start'), [])
  })

  test('selector_not_found 는 한 번 다시 부른다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') }, start_errors: ['selector_not_found'] })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.equal(lines('orca orchestration worker-start').length, 2)
    assert.match(r.stdout, /LAUNCHED ctx_1/)
  })

  test('selector_not_found 가 두 번이면 실패하고 다른 오류는 다시 부르지 않는다', () => {
    state({ next_ids: ['ctx_1'], start_errors: ['selector_not_found', 'selector_not_found'] })
    let r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.equal(lines('orca orchestration worker-start').length, 2)
    resetLog()
    state({ next_ids: ['ctx_1'], start_errors: ['agent_not_found'] })
    r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.equal(lines('orca orchestration worker-start').length, 1)
  })
})

describe('before-launch 와 worker-launched', () => {
  let proj: string
  let hookWt: string

  // 핸들러를 둘 임시 저장소와, 그 저장소의 워크트리를 만드는 가짜 make-worktree. origin 이 없어 origin/HEAD 도 없다.
  beforeEach(() => {
    proj = join(tmp, 'proj')
    hookWt = join(tmp, 'hookwt')
    const git = (...args: string[]) => assert.equal(spawnSync('git', args, { env }).status, 0, args.join(' '))
    git('init', '-q', '-b', 'main', proj)
    git('-C', proj, 'commit', '-q', '--allow-empty', '-m', 'init')
    const make = join(tmp, 'make-hook-worktree.sh')
    writeFileSync(make, `echo "make $*" >> "$FAKE_LOG"\ngit -C ${proj} worktree add -q -b feature/hook ${hookWt} >/dev/null 2>&1 || exit 1\necho ${hookWt}\n`)
    env.MAKE_WORKTREE = make
  })

  function handler(event: string, body: string): void {
    const dir = join(proj, '.orch/hooks')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${event}.ts`), body)
  }

  // 받은 stdin 을 capture 에 쓰고 code 로 끝나는 핸들러
  function capture(event: string, code: number): string {
    const file = join(tmp, `${event}.json`)
    handler(event, `import { readFileSync, writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(file)}, readFileSync(0, 'utf8'))\nprocess.exitCode = ${code}\n`)
    return file
  }

  function launchNew(extra: string[] = [], passthru = ['--agent', 'claude', '--model', 'claude-sonnet', '--effort', 'medium']): Launch {
    return launch(['--repo', proj, '--name', 'hook', ...extra, '--', ...passthru])
  }

  // 로그 줄에서 명령 이름만 남긴다. 호출 순서를 본다.
  function order(): string[] {
    return lines('')
      .filter((line) => line)
      .map((line) => line.split(' ').slice(0, line.startsWith('orca ') ? 3 : 2).join(' '))
  }

  test('핸들러가 없으면 호출 순서가 그대로이고 0 이다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launchNew()
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(order(), ['orca orchestration worker-list', 'orca orchestration task-list', 'make --repo', 'orca worktree list', 'orca orchestration worker-start', 'orca orchestration worker-show'])
    assert.doesNotMatch(r.stdout, /HOOK-/)
  })

  test('before-launch 가 10 으로 거부하면 띄우지 않고 워크트리는 남긴다', () => {
    handler('before-launch', "console.log('동시 worker 상한을 넘었다')\nprocess.exitCode = 10\n")
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launchNew()
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /^HOOK-REJECT before-launch 동시 worker 상한을 넘었다$/m)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
    assert.deepEqual(lines('orca worktree list'), [])
    assert.ok(existsSync(hookWt))
    assert.ok(r.stderr.includes(`워크트리는 남아 있다: ${hookWt}`), r.stderr)
  })

  test('before-launch 가 1 로 끝나면 거부처럼 멈춘다', () => {
    handler('before-launch', 'process.exitCode = 1\n')
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launchNew()
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /^HOOK-FAIL before-launch 1$/m)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
  })

  test('before-launch 가 잡지 않은 예외로 죽어도 거부처럼 멈춘다', () => {
    handler('before-launch', "throw new Error('핸들러가 죽었다')\n")
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launchNew()
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /^HOOK-FAIL before-launch 1$/m)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
  })

  test('before-launch 입력에 워크트리, 지시서, 브랜치, 에이전트, --base 가 든다', () => {
    const file = capture('before-launch', 0)
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launchNew(['--base', 'develop', '--run', 'run_x'])
    assert.equal(r.code, 0, both(r))
    const input = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(input.worker, { task: null, dispatch: null, terminal: null, worktree: hookWt, spec })
    assert.equal(input.branch, 'feature/hook')
    assert.deepEqual([input.agent, input.model, input.effort], ['claude', 'claude-sonnet', 'medium'])
    assert.equal(input.base, 'develop')
    assert.equal(input.run, 'run_x')
    assert.equal(input.repo, proj)
    assert.equal(input.event, 'before-launch')
    assert.equal(lines('orca orchestration worker-start').length, 1)
  })

  test('--worktree 로 부르면 그 워크트리의 주 checkout 핸들러가 받고 --terminal 이 입력에 든다', () => {
    spawnSync('git', ['-C', proj, 'worktree', 'add', '-q', '-b', 'feature/old', hookWt], { env })
    const file = capture('before-launch', 0)
    state({ next_ids: ['ctx_1'], terminals: [{ handle: 'term_old', worktreePath: hookWt }], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', hookWt, '--', '--terminal', 'term_old'])
    assert.equal(r.code, 0, both(r))
    const input = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(input.repo, proj)
    assert.deepEqual(input.worker, { task: null, dispatch: null, terminal: 'term_old', worktree: hookWt, spec })
    assert.equal(input.branch, 'feature/old')
    assert.deepEqual([input.agent, input.model, input.effort], [null, null, null])
  })

  test('worker-launched 가 실패해도 0 이고 입력의 dispatch 는 LAUNCHED 의 id 다', () => {
    const file = capture('worker-launched', 1)
    state({
      next_ids: ['ctx_1'],
      dispatches: { ctx_1: { ...shown('input_accepted'), worker: { agentTerminalHandle: 'term_w' } } },
    })
    const r = launchNew()
    assert.equal(r.code, 0, both(r))
    const launched = r.stdout.indexOf(`LAUNCHED ctx_1 ${hookWt}`)
    const failed = r.stdout.search(/^HOOK-FAIL worker-launched 1$/m)
    assert.ok(launched >= 0 && failed > launched, r.stdout)
    const input = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(input.worker, { task: 'task_1', dispatch: 'ctx_1', terminal: 'term_w', worktree: hookWt, spec })
    assert.equal(input.event, 'worker-launched')
    assert.equal(input.branch, 'feature/hook')
  })

  test('시작 확인 시간이 넘어도 worker-launched 를 내고 종료 코드 1 을 유지한다', () => {
    const file = capture('worker-launched', 1)
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: { ...shown('worktree_creating'), worker: { agentTerminalHandle: 'term_w' } } } })
    const r = launchNew(['--watch', '1'])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /^STALLED-START ctx_1 /m)
    assert.doesNotMatch(r.stdout, /LAUNCHED/)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).worker.terminal, 'term_w')
    assert.ok(existsSync(join(proj, '.orch/state/launched-workers/ctx_1.json')))
  })

  test('--base 의 origin/ 은 떼고 핸들러에 넘긴다', () => {
    const file = capture('before-launch', 0)
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launchNew(['--base', 'origin/develop'])
    assert.equal(r.code, 0, both(r))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).base, 'develop')
  })

  test('worker-launched 를 내다 예외가 나도 LAUNCHED 뒤라 0 이고 이유를 stderr 에 남긴다', () => {
    // state 자리에 파일이 있어 이벤트 실행기가 기록과 잠금을 쓰지 못한다. 설정 오류가 아닌 예외다
    handler('worker-launched', 'process.exitCode = 0\n')
    writeFileSync(join(proj, '.orch/state'), '')
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launchNew()
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /^LAUNCHED ctx_1 /m)
    assert.match(r.stderr, /^launch-worker: worker-launched 를 내지 못했다: .+/m)
  })

  test('--base 가 없고 origin/HEAD 도 없으면 base 는 빈 문자열이다', () => {
    const file = capture('before-launch', 0)
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launchNew()
    assert.equal(r.code, 0, both(r))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).base, '')
  })

  test('before-launch 의 설정 파일 오류는 띄우기 전에 2 다', () => {
    handler('before-launch', 'process.exitCode = 0\n')
    writeFileSync(join(proj, '.orch/config.json'), JSON.stringify({ hooks: { timeouts: { 'before-launch': -1 } } }))
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launchNew()
    assert.equal(r.code, 2, both(r))
    assert.match(r.stderr, /hooks\.timeouts/)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
  })

  test('worker-launched 의 설정 파일 오류는 LAUNCHED 뒤라 종료 코드를 바꾸지 않는다', () => {
    // 띄운 뒤 2 로 끝나면 코디네이터가 띄우기 실패로 읽고 같은 일을 다시 띄운다
    handler('worker-launched', 'process.exitCode = 0\n')
    writeFileSync(join(proj, '.orch/config.json'), JSON.stringify({ hooks: { timeouts: { 'worker-launched': 'x' } } }))
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launchNew()
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /^LAUNCHED ctx_1 /m)
    assert.match(r.stderr, /worker-launched 를 내지 못했다: .*hooks\.timeouts/)
  })
})


test('LAUNCHED 뒤 지시서의 id, 제목과 마일스톤 단계로 항목을 만들고 할 일 줄은 올리지 않으며 기존 단계는 보존한다', () => {
  const file = join(worktree, '.omc', 'board.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ items: [] }))
  writeFileSync(spec, '# 자동 갱신\n허락: PR 생성\n보드 항목 id: `board-id`\n\n## 할 일\n1. 구현\n   설명\n2. 검증\n\n## 완료\n1. 다른 절\n')
  state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
  const r = launch(['--worktree', worktree, '--watch', '0', '--', ...CODEX])
  assert.equal(r.code, 0, both(r))
  let item = JSON.parse(readFileSync(file, 'utf8')).items[0]
  assert.equal(item.id, 'board-id')
  assert.equal(item.title, '자동 갱신')
  assert.equal(item.worktree, 'wt')
  assert.equal(item.status, 'doing')
  assert.deepEqual(item.details, [{ text: '1. PR', done: false }, { text: '2. 머지', done: false }])
  assert.equal(item.stages, 'pr=1,merge=2')
  item.details[0].done = true
  writeFileSync(file, JSON.stringify({ items: [item] }))
  state({ next_ids: ['ctx_2'] })
  assert.equal(launch(['--worktree', worktree, '--watch', '0', '--', ...CODEX]).code, 0)
  item = JSON.parse(readFileSync(file, 'utf8')).items[0]
  assert.equal(item.details[0].done, true)
})


test('설정이 보드를 가리키는데 파일이 없으면 LAUNCHED 는 두고 알린다', () => {
  mkdirSync(join(worktree, '.orch'), { recursive: true })
  writeFileSync(join(worktree, '.orch', 'config.json'), JSON.stringify({ finish: { board: '.omc/board.json' } }))
  state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
  const r = launch(['--worktree', worktree, '--watch', '0', '--', ...CODEX])
  assert.equal(r.code, 0, both(r))
  assert.match(r.stdout, /^LAUNCHED ctx_1 /m)
  assert.match(r.stderr, /보드를 갱신하지 못했다: 설정 파일에 finish\.board 이 있지만 보드 파일이 없다/)
  assert.equal(existsSync(join(worktree, '.omc', 'board.json')), false)
})

test('설정에 보드가 없고 파일도 없으면 알리지 않는다', () => {
  state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
  const r = launch(['--worktree', worktree, '--watch', '0', '--', ...CODEX])
  assert.equal(r.code, 0, both(r))
  assert.doesNotMatch(r.stderr, /보드/)
})

test('항목 id 가 없으면 --name 을 쓰고 단계가 없으면 기본 단계를 둔다', () => {
  const file = join(tmp, '.omc', 'board.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ items: [] }))
  state({ next_ids: ['ctx_1'] })
  const r = launch(['--repo', tmp, '--name', 'example', '--watch', '0', '--', ...CODEX])
  assert.equal(r.code, 0, both(r))
  const item = JSON.parse(readFileSync(file, 'utf8')).items[0]
  assert.equal(item.id, 'example')
  assert.equal(item.details.length, 2)
  assert.equal(item.worktree, 'new')
})

test('지시서에 항목 id 가 없으면 같은 워크트리의 끝나지 않은 항목을 이어 쓰고 새 항목을 만들지 않는다', () => {
  const file = join(worktree, '.omc', 'board.json')
  mkdirSync(dirname(file), { recursive: true })
  const first = { id: 'first', title: '처음 일', status: 'doing', worktree: 'wt', details: [{ text: '1. 구현', done: true }, { text: '2. 머지', done: false }] }
  writeFileSync(file, JSON.stringify({ items: [{ id: 'old', status: 'done', worktree: 'wt' }, first] }))
  writeFileSync(spec, '# 충돌 풀기\n허락: push\n\n## 할 일\n1. base 합치기\n')
  state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
  const r = launch(['--worktree', worktree, '--watch', '0', '--', ...CODEX])
  assert.equal(r.code, 0, both(r))
  const items = JSON.parse(readFileSync(file, 'utf8')).items
  assert.deepEqual(items.map((i: { id: string }) => i.id), ['old', 'first'])
  assert.deepEqual(items[1].details, first.details)
  assert.equal(items[1].worktree, 'wt')
  assert.equal(items[1].title, '처음 일')
})

test('보드 항목 id 가 가리키는 끝나지 않은 항목은 제목과 단계를 그대로 두고 워크트리와 브랜치만 바꾼다', () => {
  const file = join(worktree, '.omc', 'board.json')
  mkdirSync(dirname(file), { recursive: true })
  const milestone = { id: 'chart', title: '차트 코드별 분리', status: 'doing', worktree: 'old-wt', details: [{ text: '1. 구현', done: true }, { text: '2. 머지', done: false }] }
  writeFileSync(file, JSON.stringify({ items: [milestone] }))
  writeFileSync(spec, '# PR #9 를 develop 과 합친다\n허락: push\n보드 항목 id: chart\n\n## 할 일\n1. develop 합치기\n2. push\n')
  state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
  const r = launch(['--worktree', worktree, '--watch', '0', '--', ...CODEX])
  assert.equal(r.code, 0, both(r))
  assert.doesNotMatch(r.stderr, /보드를 갱신하지 못했다/)
  const items = JSON.parse(readFileSync(file, 'utf8')).items
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '차트 코드별 분리')
  assert.equal(items[0].status, 'doing')
  assert.equal(items[0].worktree, 'wt')
  assert.deepEqual(items[0].details, milestone.details)
})

test('보드 항목 id 뒤에 설명이 붙어도 공백 앞 첫 토큰의 항목을 이어 쓰고 가짜 항목을 만들지 않는다', () => {
  const file = join(worktree, '.omc', 'board.json')
  mkdirSync(dirname(file), { recursive: true })
  const milestone = { id: '326-eval-resume', title: '평가 이어하기', status: 'doing', worktree: 'old-wt', details: [{ text: '1. 구현', done: true }, { text: '2. 머지', done: false }] }
  writeFileSync(file, JSON.stringify({ items: [milestone] }))
  writeFileSync(spec, '# 5단계\n허락: push\n보드 항목 id: 326-eval-resume (이 PR 은 5단계)\n\n## 할 일\n1. 구현\n')
  state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
  const r = launch(['--worktree', worktree, '--watch', '0', '--', ...CODEX])
  assert.equal(r.code, 0, both(r))
  assert.doesNotMatch(r.stderr, /보드를 갱신하지 못했다/)
  const items = JSON.parse(readFileSync(file, 'utf8')).items
  assert.deepEqual(items.map((i: { id: string }) => i.id), ['326-eval-resume'])
  assert.equal(items[0].worktree, 'wt')
  assert.deepEqual(items[0].details, milestone.details)
})

test('보드 항목 id 뒤에 설명이 붙었는데 그 id 가 보드에 없으면 항목을 만들지 않고 알린다', () => {
  const file = join(worktree, '.omc', 'board.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ items: [] }))
  writeFileSync(spec, '# 5단계\n허락: push\n보드 항목 id: 327-trace (이 PR 은 5단계)\n\n## 할 일\n1. 구현\n')
  state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
  const r = launch(['--worktree', worktree, '--watch', '0', '--', ...CODEX])
  assert.equal(r.code, 0, both(r))
  assert.match(r.stderr, /보드를 갱신하지 못했다: .*327-trace.*보드에 없고 뒤에 설명이 붙어/)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).items, [])
})

test('단계도 진행률도 없는 기존 항목은 단계를 더하지 않고 status 도 그대로 둔다', () => {
  const file = join(worktree, '.omc', 'board.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ items: [{ id: 'later', title: '나중 일', status: 'wait' }] }))
  writeFileSync(spec, '# 다른 제목\n허락: push\n보드 항목 id: later\n\n## 할 일\n1. 구현\n')
  state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
  const r = launch(['--worktree', worktree, '--watch', '0', '--', ...CODEX])
  assert.equal(r.code, 0, both(r))
  assert.doesNotMatch(r.stderr, /보드를 갱신하지 못했다/)
  const [item] = JSON.parse(readFileSync(file, 'utf8')).items
  assert.equal(item.title, '나중 일')
  assert.equal(item.status, 'wait')
  assert.equal(item.worktree, 'wt')
  assert.equal('details' in item, false, JSON.stringify(item))
})

describe('리뷰 worker 준비', () => {
  let proj: string
  let reviewWt: string
  let prHead: string
  const git = (...args: string[]): string => {
    const done = spawnSync('git', args, { env, encoding: 'utf8' })
    assert.equal(done.status, 0, `${args.join(' ')}: ${done.stderr}`)
    return done.stdout.trim()
  }

  // origin 에 main 과 PR head(refs/pull/5/head)를 두고, 지시서의 브랜치로 origin/main 위에 워크트리를 만드는 가짜 make-worktree
  beforeEach(() => {
    const origin = join(tmp, 'origin.git')
    proj = join(tmp, 'proj')
    reviewWt = join(tmp, 'hookwt')
    git('init', '-q', '--bare', '-b', 'main', origin)
    git('clone', '-q', origin, proj)
    git('-C', proj, 'commit', '-q', '--allow-empty', '-m', 'init')
    git('-C', proj, 'push', '-q', 'origin', 'main')
    git('-C', proj, 'commit', '-q', '--allow-empty', '-m', 'pr 5')
    prHead = git('-C', proj, 'rev-parse', 'HEAD')
    git('-C', proj, 'push', '-q', 'origin', 'HEAD:refs/pull/5/head')
    git('-C', proj, 'reset', '-q', '--hard', 'origin/main')
    const make = join(tmp, 'make-review-worktree.sh')
    writeFileSync(make, `echo "make $*" >> "$FAKE_LOG"\ngit -C ${proj} worktree add -q -b review/pr-5 ${reviewWt} origin/main >/dev/null 2>&1 || exit 1\necho ${reviewWt}\n`)
    env.MAKE_WORKTREE = make
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
  })

  function reviewSpec(pr: number): void {
    writeFileSync(spec, `# PR #${pr} 리뷰\n\n리뷰 PR: #${pr}\n브랜치: \`review/pr-${pr}\`\n허락: 리뷰 회신까지 허락했다.\n`)
  }

  function config(value: Record<string, unknown>): void {
    mkdirSync(join(proj, '.orch'), { recursive: true })
    writeFileSync(join(proj, '.orch', 'config.json'), JSON.stringify(value))
  }

  function launchReview(): Launch {
    return launch(['--repo', proj, '--name', 'review-pr-5', '--', ...CLAUDE])
  }

  test('리뷰 PR 줄이 있으면 워크트리를 PR head 에 detached 로 두고 공유 저장소에 pr-N 브랜치를 만들지 않는다', () => {
    reviewSpec(5)
    const r = launchReview()
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, new RegExp(`^REVIEW-CHECKOUT #5 ${prHead}$`, 'm'))
    assert.equal(git('-C', reviewWt, 'rev-parse', 'HEAD'), prHead)
    assert.equal(git('-C', reviewWt, 'branch', '--show-current'), '')
    assert.equal(spawnSync('git', ['-C', proj, 'rev-parse', '--verify', '-q', 'refs/heads/pr-5'], { env }).status, 1)
    assert.doesNotMatch(r.stdout, /REVIEW-PREPARE/)
    assert.equal(lines('orca orchestration worker-start').length, 1)
  })

  test('review.prepare 를 PR head 의 워크트리에서 한 번 돌리고 결과 코드를 낸다', () => {
    reviewSpec(5)
    const seen = join(tmp, 'prepare.txt')
    config({ review: { prepare: `echo "$ORCH_REVIEW_PR $(pwd -P) $(git rev-parse HEAD)" >> ${seen}` } })
    const r = launchReview()
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /^REVIEW-PREPARE 0$/m)
    assert.deepEqual(readFileSync(seen, 'utf8').trim().split('\n'), [`5 ${realpathSync(reviewWt)} ${prHead}`])
  })

  test('review.prepare 가 실패해도 경고하고 띄운다', () => {
    reviewSpec(5)
    config({ review: { prepare: 'echo 생성기 실패; exit 3' } })
    const r = launchReview()
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /^REVIEW-PREPARE 3$/m)
    assert.match(r.stderr, /생성기 실패/)
    assert.match(r.stderr, /경고: 리뷰 생성물 준비가 종료 코드 3 로 끝났다/)
    assert.equal(lines('orca orchestration worker-start').length, 1)
  })

  test('PR head 를 받지 못하면 띄우지 않고 1 이며 임시 ref 를 남기지 않는다', () => {
    reviewSpec(9)
    const r = launchReview()
    assert.equal(r.code, 1, both(r))
    assert.match(r.stderr, /리뷰 PR head 를 받지 못했다\(#9\)/)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
    assert.equal(git('-C', proj, 'for-each-ref', 'refs/orch/'), '')
  })

  test('PR head 를 받지 못해 멈춘 워크트리를 --worktree 로 다시 띄우면 PR head 로 옮긴 뒤 띄운다', () => {
    reviewSpec(9)
    assert.equal(launchReview().code, 1)
    // 그사이 PR head 가 생겼다(일시 장애가 풀린 것과 같다)
    git('-C', proj, 'push', '-q', 'origin', `${prHead}:refs/pull/9/head`)
    const r = launch(['--worktree', reviewWt, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, new RegExp(`^REVIEW-CHECKOUT #9 ${prHead}$`, 'm'))
    assert.equal(git('-C', reviewWt, 'rev-parse', 'HEAD'), prHead)
  })

  test('이미 PR head 에 놓인 워크트리를 다시 띄우면 준비 명령을 다시 돌리지 않는다', () => {
    reviewSpec(5)
    const seen = join(tmp, 'prepare.txt')
    config({ review: { prepare: `echo run >> ${seen}` } })
    assert.equal(launchReview().code, 0)
    state({ next_ids: ['ctx_2'], dispatches: { ctx_2: shown('input_accepted') } })
    const r = launch(['--worktree', reviewWt, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, new RegExp(`^REVIEW-CHECKOUT #5 ${prHead} 이미 준비됨$`, 'm'))
    assert.deepEqual(readFileSync(seen, 'utf8').trim().split('\n'), ['run'])
  })

  test('워크트리에 커밋 안 된 변경이 있으면 PR head 로 옮기지 않고 1 이다', () => {
    reviewSpec(9)
    assert.equal(launchReview().code, 1)
    git('-C', proj, 'push', '-q', 'origin', `${prHead}:refs/pull/9/head`)
    writeFileSync(join(reviewWt, 'local.txt'), 'x')
    const r = launch(['--worktree', reviewWt, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stderr, /커밋 안 된 변경이 있어 PR head 로 옮기지 않는다/)
  })

  test('review.prepare 가 문자열이 아니면 설정 오류 2 다', () => {
    reviewSpec(5)
    config({ review: { prepare: ['pnpm', 'gen'] } })
    const r = launchReview()
    assert.equal(r.code, 2, both(r))
    assert.match(r.stderr, /review\.prepare 는 bash 명령 문자열이어야 한다/)
  })

  test('리뷰 PR 줄이 없으면 PR head 를 꺼내지 않는다', () => {
    config({ review: { prepare: 'exit 1' } })
    const r = launchReview()
    assert.equal(r.code, 0, both(r))
    assert.doesNotMatch(r.stdout, /REVIEW-/)
    assert.equal(git('-C', reviewWt, 'branch', '--show-current'), 'review/pr-5')
  })
})

describe('중간 과정과 다시 열기', () => {
  type Item = Record<string, unknown> & { id: string }
  let file: string

  beforeEach(() => {
    file = join(worktree, '.omc', 'board.json')
    mkdirSync(dirname(file), { recursive: true })
    state({ next_ids: ['ctx_1', 'ctx_2'], dispatches: { ctx_1: shown('input_accepted'), ctx_2: shown('input_accepted') } })
  })

  const items = (): Item[] => JSON.parse(readFileSync(file, 'utf8')).items
  const run = () => launch(['--worktree', worktree, '--watch', '0', '--', ...CODEX])

  test('중간 과정 지시서는 그 PR 의 항목에 줄 하나만 남기고 항목, 제목, status, 단계 완료 값은 그대로다', () => {
    const target = {
      id: 'feat',
      title: '기능',
      status: 'doing',
      pr: 7,
      worktree: 'old-wt',
      branch: 'feat/x',
      details: [{ text: '1. 구현', done: true }, { text: '2. 머지', done: false }],
    }
    const other = { id: 'other', title: '다른 일', status: 'doing', worktree: 'wt', details: [{ text: '1. 구현', done: false }] }
    writeFileSync(file, JSON.stringify({ items: [target, other] }))
    writeFileSync(spec, '# PR #7 CI 고치기\n허락: push\n중간 과정: PR #7\n\n## 할 일\n1. CI 고치기\n')
    for (let i = 0; i < 2; i++) {
      const r = run()
      assert.equal(r.code, 0, both(r))
      assert.doesNotMatch(r.stderr, /보드를 갱신하지 못했다/)
    }
    const after = items()
    assert.deepEqual(after.map((i) => i.id), ['feat', 'other'])
    const item = after[0]
    assert.equal(item.title, '기능')
    assert.equal(item.status, 'doing')
    assert.equal(item.pr, 7)
    assert.equal(item.worktree, 'wt')
    // 이 워크트리는 git 저장소가 아니라 브랜치를 읽지 못한다. 기존 branch 칸은 지우지 않는다
    assert.equal(item.branch, 'feat/x')
    assert.deepEqual(item.details, [...target.details, { text: '중간 과정: PR #7 CI 고치기', done: false }])
    assert.deepEqual(after[1], other)
  })

  test('중간 과정 지시서에 맞는 항목이 없으면 항목을 만들지 않고 알린다', () => {
    const done = { id: 'feat', title: '기능', status: 'done', pr: 7, worktree: 'wt', details: [{ text: '1. 구현', done: true }] }
    writeFileSync(file, JSON.stringify({ items: [done] }))
    writeFileSync(spec, '# PR #7 충돌 풀기\n허락: push\n중간 과정: PR #7\n')
    const r = run()
    assert.equal(r.code, 0, both(r))
    assert.match(r.stderr, /보드를 갱신하지 못했다: 중간 과정 지시서의 보드 항목을 찾지 못해 만들지 않는다/)
    assert.deepEqual(items(), [done])
  })

  test('PR 번호가 없는 중간 과정 지시서는 결정과 목표 항목을 빼고 같은 브랜치의 항목을 찾는다', () => {
    // 워크트리가 git 저장소여야 launch-worker 가 브랜치를 읽는다
    const git = (...args: string[]) => assert.equal(spawnSync('git', args, { env }).status, 0, args.join(' '))
    rmSync(worktree, { recursive: true, force: true })
    git('init', '-q', '-b', 'feat/x', worktree)
    // 실제 저장소처럼 보드와 orch 설정 폴더는 git 이 무시한다. 무시하지 않으면 커밋 안 된 변경으로 거부된다
    writeFileSync(join(worktree, '.git', 'info', 'exclude'), '.orch/\n.omc/\n')
    mkdirSync(dirname(file), { recursive: true })
    const target = { id: 'feat', title: '기능', status: 'doing', branch: 'feat/x', worktree: 'old-wt', details: [{ text: '1. 구현', done: false }] }
    const decide = { id: 'ask', title: '정할 것', status: 'decide', branch: 'feat/x', details: [{ text: '이름', done: false }] }
    const goal = { id: 'goal', title: '목표', status: 'goal', branch: 'feat/x' }
    writeFileSync(file, JSON.stringify({ items: [decide, goal, target] }))
    writeFileSync(spec, '# 리뷰 반영하기\n허락: push\n중간 과정: 리뷰 반영\n')
    const r = run()
    assert.equal(r.code, 0, both(r))
    assert.doesNotMatch(r.stderr, /보드를 갱신하지 못했다/)
    const after = items()
    assert.deepEqual(after.slice(0, 2), [decide, goal])
    assert.deepEqual(after[2].details, [...target.details, { text: '중간 과정: 리뷰 반영하기', done: false }])
    assert.equal(after[2].status, 'doing')
  })

  test('중간 과정 지시서에 맞는 항목이 둘 이상이면 보드를 쓰지 않고 알린다', () => {
    const one = { id: 'one', title: '하나', status: 'doing', pr: 7, details: [{ text: '1. 구현', done: false }] }
    const two = { id: 'two', title: '둘', status: 'wait', pr: '7, 8', details: [{ text: '1. 구현', done: false }] }
    writeFileSync(file, JSON.stringify({ items: [one, two] }))
    writeFileSync(spec, '# PR #7 CI 고치기\n허락: push\n중간 과정: PR #7\n')
    const r = run()
    assert.equal(r.code, 0, both(r))
    assert.match(r.stderr, /보드를 갱신하지 못했다: 중간 과정 지시서의 보드 항목을 찾지 못해 만들지 않는다: 항목이 둘 이상이다: one, two/)
    assert.deepEqual(items(), [one, two])
  })

  test('보드 항목 id 가 가리키는 done 항목은 다시 열고 남은 일과 중간 과정 줄을 빼고 details 와 next 의 마지막 번호 다음부터 마일스톤 단계를 붙인다', () => {
    const done = {
      id: 'a',
      title: '옛 제목',
      status: 'done',
      pr: 12,
      'merged-pr': 9,
      progress: '2/2',
      worktree: 'old-wt',
      branch: 'feat/a',
      details: [
        { text: '1. 구현', done: true },
        { text: '2. 머지', done: true },
        { text: '남은 일: PR #13', done: false },
        // 옛 문자열 줄은 앞에 완료 표시가 붙어 있다
        '✓ 중간 과정: PR #12 CI 고치기',
      ],
      next: ['5. 배포 확인'],
    }
    writeFileSync(file, JSON.stringify({ items: [done] }))
    writeFileSync(spec, '# 후속 기능\n허락: push\n보드 항목 id: a\n\n## 할 일\n1. 후속 구현\n\n## 보드 단계\n1. [pr] 후속 PR\n2. [merge] 후속 머지\n')
    const r = run()
    assert.equal(r.code, 0, both(r))
    assert.doesNotMatch(r.stderr, /보드를 갱신하지 못했다/)
    const [item] = items()
    assert.equal(item.status, 'doing')
    // 제목은 마일스톤이라 다시 연 지시서의 머리줄로 바꾸지 않는다
    assert.equal(item.title, '옛 제목')
    assert.equal(item.worktree, 'wt')
    assert.equal(item.branch, 'feat/a')
    assert.deepEqual(item.details, [
      { text: '1. 구현', done: true },
      { text: '2. 머지', done: true },
      { text: '6. 후속 PR', done: false },
      { text: '7. 후속 머지', done: false },
    ])
    assert.equal(item.stages, 'pr=6,merge=7')
    assert.equal('pr' in item, false, JSON.stringify(item))
    assert.equal(item['merged-pr'], '12, 9')
    assert.equal('progress' in item, false, JSON.stringify(item))
  })
})

describe('마일스톤 단계', () => {
  let file: string
  beforeEach(() => {
    file = join(worktree, '.omc', 'board.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ items: [] }))
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
  })
  const config = (body: unknown) => {
    mkdirSync(join(worktree, '.orch'), { recursive: true })
    writeFileSync(join(worktree, '.orch', 'config.json'), JSON.stringify(body))
  }
  const made = () => {
    const r = launch(['--worktree', worktree, '--watch', '0', '--', ...CODEX])
    assert.equal(r.code, 0, both(r))
    return { r, item: JSON.parse(readFileSync(file, 'utf8')).items[0] }
  }
  const texts = (item: { details: { text: string }[] }) => item.details.map((d) => d.text)

  test('배포 워크플로가 있어도 기본 단계에 배포 단계를 만들지 않는다', () => {
    config({ finish: { deploy_workflow: 'deploy.yml', deploy_branch: 'stage' } })
    const { item } = made()
    assert.deepEqual(texts(item), ['1. PR', '2. 머지'])
    assert.equal(item.stages, 'pr=1,merge=2')
  })

  test('board.steps 가 기본 단계를 바꾸고 꼬리표 없는 줄은 stages 에 넣지 않는다', () => {
    config({ board: { steps: ['[pr] 구현', 'QA 확인', '[merge] 기준 브랜치 머지'] } })
    const { item } = made()
    assert.deepEqual(texts(item), ['1. 구현', '2. QA 확인', '3. 기준 브랜치 머지'])
    assert.equal(item.stages, 'pr=1,merge=3')
  })

  test('지시서의 보드 단계 절이 설정보다 앞선다', () => {
    config({ board: { steps: ['[pr] 설정 단계'] } })
    writeFileSync(spec, '# 일\n허락: push\n보드 항목 id: s\n\n## 보드 단계\n1. [pr] 지시서 단계\n2. [release] 출시\n\n## 할 일\n1. 구현 세부\n')
    const { item } = made()
    assert.deepEqual(texts(item), ['1. 지시서 단계', '2. 출시'])
    assert.equal(item.stages, 'pr=1,release=2')
  })

  test('꼬리표가 틀리면 보드를 쓰지 않고 알린다', () => {
    config({ board: { steps: ['[qa] 확인'] } })
    const { r, item } = made()
    assert.equal(item, undefined)
    assert.match(r.stderr, /보드를 갱신하지 못했다: .*board\.steps/)
  })
})

test('보드가 없으면 LAUNCHED 뒤에도 파일을 만들지 않는다', () => {
  state({ next_ids: ['ctx_1'] })
  const r = launch(['--worktree', worktree, '--watch', '0', '--', ...CODEX])
  assert.equal(r.code, 0, both(r))
  assert.equal(existsSync(join(worktree, '.omc', 'board.json')), false)
  assert.doesNotMatch(r.stderr, /보드를 갱신하지 못했다/)
})

describe('보드 항목 제목과 같은 업무', () => {
  type Item = Record<string, unknown> & { id: string; title: string }
  let file: string
  beforeEach(() => {
    file = join(worktree, '.omc', 'board.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ items: [] }))
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
  })
  const items = (): Item[] => JSON.parse(readFileSync(file, 'utf8')).items
  const run = () => {
    const r = launch(['--worktree', worktree, '--watch', '0', '--', ...CODEX])
    assert.equal(r.code, 0, both(r))
    assert.doesNotMatch(r.stderr, /보드를 갱신하지 못했다/)
  }

  test('제목 줄이 없으면 목표 절의 첫 문장을 제목으로 쓴다', () => {
    writeFileSync(spec, '공통 지시서를 먼저 읽는다.\n허락: push\n\n## 목표\n\n- **보드가** 업무 목적을 보인다. 나머지 설명.\n\n## 할 일\n- 고친다\n')
    run()
    assert.equal(items()[0].title, '보드가 업무 목적을 보인다.')
  })

  test('업무 연결 줄만 있으면 그 줄의 제목 앞에 업무 번호를 붙인다', () => {
    writeFileSync(spec, '공통 지시서를 먼저 읽는다.\n허락: push\n두레이 업무: EXAMPLE-PROJECT/271 「일별 집계 끝내기」\n')
    run()
    assert.equal(items()[0].title, 'EXAMPLE-PROJECT/271 일별 집계 끝내기')
  })

  test('board.task_line 정규식이 업무 연결 줄의 꼴을 바꾼다', () => {
    mkdirSync(join(worktree, '.orch'), { recursive: true })
    writeFileSync(join(worktree, '.orch', 'config.json'), JSON.stringify({ board: { task_line: '^이슈: (?<number>#\\d+) (?<title>.+)$' } }))
    writeFileSync(spec, '# 이슈 고치기\n허락: push\n이슈: #12 로그인 실패\n')
    run()
    assert.equal(items()[0].title, '#12 이슈 고치기')
  })

  test('같은 업무 번호의 끝나지 않은 항목은 다른 워크트리여도 이어 쓰고 단계는 그대로 둔다', () => {
    const first = {
      id: 'attention',
      title: 'EXAMPLE-PROJECT/282 주의 확인 화면',
      status: 'doing',
      worktree: 'pr1-wt',
      branch: 'feat/pr1',
      stages: 'pr=1,merge=2',
      details: [{ text: '1. PR', done: true }, { text: '2. 머지', done: false }],
    }
    const other = { id: 'other', title: 'EXAMPLE-PROJECT/2821 다른 일', status: 'doing', worktree: 'x', details: [{ text: '1. PR', done: false }] }
    writeFileSync(file, JSON.stringify({ items: [other, first] }))
    writeFileSync(spec, '# 두 번째 PR\n허락: push\n두레이 업무: EXAMPLE-PROJECT/282\n')
    run()
    const after = items()
    assert.deepEqual(after.map((i) => i.id), ['other', 'attention'])
    assert.equal(after[1].worktree, 'wt')
    assert.equal(after[1].title, first.title)
    assert.deepEqual(after[1].details, first.details)
    assert.equal(after[0].worktree, 'x')
  })

  test('업무 번호도 제목 줄도 목표 절도 없으면 id 를 제목으로 쓰고 번호가 든 항목에 붙지 않는다', () => {
    writeFileSync(file, JSON.stringify({ items: [{ id: 'task', title: 'EXAMPLE-PROJECT/282 업무', status: 'doing', worktree: 'x', details: [{ text: '1. PR', done: false }] }] }))
    writeFileSync(spec, '공통 지시서를 먼저 읽는다.\n허락: push\n\n## 할 일\n- 고친다\n')
    run()
    const after = items()
    assert.equal(after.length, 2)
    assert.equal(after[1].id, 'wt')
    assert.equal(after[1].title, 'wt')
  })
})

describe('모델과 effort 검사', () => {
  const MODELS = {
    models: [
      { slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }] },
      { slug: 'gpt-6-luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'gpt-hidden', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
    ],
  }

  function fakeCodex(output: string, code = 0): void {
    const bin = join(tmp, 'codex')
    writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${output.replace(/'/g, `'\\''`)}'\nexit ${code}\n`)
    chmodSync(bin, 0o755)
    env.CODEX_BIN = bin
  }

  function launchCodex(...extra: string[]): Launch {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    return launch(['--worktree', worktree, '--', '--agent', 'codex', ...extra])
  }

  test('목록에 없는 모델은 4 로 거부하고 쓸 수 있는 목록을 내며 orca 를 부르지 않는다', () => {
    fakeCodex(JSON.stringify(MODELS))
    const r = launchCodex('--model', 'gpt-5.5')
    assert.equal(r.code, 4, both(r))
    assert.match(r.stderr, /codex 에 없는 모델이다: gpt-5.5/)
    assert.match(r.stderr, /gpt-6\.1-sol: low, high, ultra/)
    assert.doesNotMatch(r.stderr, /gpt-hidden/)
    assert.deepEqual(lines('orca '), [])
  })

  test('새 워크트리도 만들기 전에 멈춘다', () => {
    fakeCodex(JSON.stringify(MODELS))
    state({ next_ids: ['ctx_1'] })
    const r = launch(['--repo', tmp, '--name', 'x', '--', '--agent', 'codex', '--model', 'gpt-5.5'])
    assert.equal(r.code, 4, both(r))
    assert.deepEqual(lines('make '), [])
  })

  test('모델이 지원하지 않는 effort 는 4 로 거부한다', () => {
    fakeCodex(JSON.stringify(MODELS))
    const r = launchCodex('--model', 'gpt-6-luna', '--effort', 'ultra')
    assert.equal(r.code, 4, both(r))
    assert.match(r.stderr, /gpt-6-luna 이 지원하지 않는 effort 다: ultra/)
    assert.match(r.stderr, /gpt-6-luna 의 effort: low, high/)
  })

  test('있는 모델과 effort 는 통과한다. 숨긴 모델도 거절하지 않는다', () => {
    fakeCodex(JSON.stringify(MODELS))
    for (const model of ['gpt-6.1-sol', 'gpt-hidden']) {
      // 모델마다 선택 줄을 다시 채운다
      writeFileSync(spec, '# 일\n\n허락: push 와 draft PR 생성은 사용자가 허락했다.\n')
      const r = launchCodex('--model', model, '--effort', 'low')
      assert.equal(r.code, 0, both(r))
      assert.doesNotMatch(r.stderr, /경고/)
    }
  })

  test('조회 명령이 실패하면 경고만 내고 띄운다', () => {
    fakeCodex('', 1)
    const r = launchCodex('--model', 'gpt-5.5')
    assert.equal(r.code, 0, both(r))
    assert.match(r.stderr, /경고: .*종료 코드 1/)
  })

  test('조회 출력이 JSON 이 아니거나 목록이 없어도 경고만 내고 띄운다', () => {
    for (const output of ['not json', '{}']) {
      fakeCodex(output)
      const r = launchCodex('--model', 'gpt-5.5')
      assert.equal(r.code, 0, both(r))
      assert.match(r.stderr, /경고: /)
    }
  })

  test('claude 는 목록을 조회할 수 없어 경고만 내고 띄운다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', '--agent', 'claude', '--model', 'nonexistent'])
    assert.equal(r.code, 0, both(r))
    assert.match(r.stderr, /경고: claude 는 모델 목록을 조회하는 명령이 없어/)
  })

  test('--model 이 없으면 모델 검사 전에 선택 줄 대조가 거부한다', () => {
    env.CODEX_BIN = join(tmp, 'missing-codex')
    writeFileSync(spec, '# 일\n허락: push\nworker 선택: `codex` `gpt-6.1-sol` effort `low`. 행: impl-planned. 비교: Sonnet. 이유: 테스트.\n')
    const r = launchCodex()
    assert.equal(r.code, 1, both(r))
    assert.match(r.stderr, /--model \(없음\), 지시서 gpt-6\.1-sol/)
    assert.doesNotMatch(r.stderr, /경고/)
  })
})

describe('claude 프로필 준비 판정', () => {
  // 임시 프로필 폴더에 선택된 프로필 하나를 만든다. ready 면 plugins 링크와 settings.json 을 둔다
  function profiles(ready: boolean): string {
    const root = join(tmp, 'profiles')
    const home = join(root, 'p1', 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(root, 'selected-host'), `${home}\n`)
    if (ready) {
      mkdirSync(join(tmp, 'config', 'plugins'), { recursive: true })
      symlinkSync(join(tmp, 'config', 'plugins'), join(home, 'plugins'))
      writeFileSync(join(home, 'settings.json'), '{}')
    } else {
      mkdirSync(join(home, 'plugins'))
    }
    env.ORCA_CLAUDE_PROFILES = root
    return home
  }

  test('선택된 프로필에 plugins 링크와 settings.json 이 없으면 맞추는 명령을 내고 띄우지 않는다', () => {
    profiles(false)
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stderr, /프로필 p1 에 plugins 링크, settings\.json 가 없어/)
    assert.match(r.stderr, / worker link-profile p1 --apply$/m)
    assert.equal(existsSync(log), false)
  })

  test('갖춰진 프로필이면 띄운다', () => {
    profiles(true)
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /LAUNCHED ctx_1/)
  })

  test('codex 는 Claude 프로필을 보지 않는다', () => {
    profiles(false)
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', ...CODEX])
    assert.equal(r.code, 0, both(r))
  })

  test('Orca 프로필 폴더가 없으면 판정을 건너뛴다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.doesNotMatch(r.stderr, /link-claude-profile/)
  })
})

describe('spec-lint 관문', () => {
  // 받은 인자를 기록하고 FAKE_LINT_CODE 로 끝나는 가짜 spec-lint. 1 이면 발견 줄을 낸다
  function fakeLint(code: number): string {
    const file = join(tmp, 'spec-lint-fake.sh')
    writeFileSync(file, `#!/bin/sh\necho "lint $*" >> "$FAKE_LOG"\n[ ${code} = 1 ] && echo "spec.md:3: 겹침: 담당 경로가 겹친다"\n[ ${code} = 2 ] && echo "spec-lint: 저장소를 읽지 못했다" >&2\nexit ${code}\n`)
    chmodSync(file, 0o755)
    env.SPEC_LINT = file
    return file
  }

  test('막을 발견이 있으면 워크트리를 만들기 전에 발견 줄과 5 로 멈춘다', () => {
    fakeLint(1)
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--repo', tmp, '--name', 'x', '--', ...CLAUDE])
    assert.equal(r.code, 5, both(r))
    assert.match(r.stderr, /spec\.md:3: 겹침: 담당 경로가 겹친다/)
    assert.match(r.stderr, /--lint-ack/)
    assert.deepEqual(lines('make '), [])
    assert.deepEqual(lines('orca orchestration worker-start'), [])
  })

  test('--lint-ack 은 이유를 출력하고 띄운다. 이유는 worker 기록에 남는다', () => {
    fakeLint(1)
    const proj = join(tmp, 'proj')
    spawnSync('git', ['init', '-q', '-b', 'main', proj], { env })
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--repo', proj, '--name', 'x', '--lint-ack', '두 PR 이 plugin.json 버전 줄을 함께 고친다', '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /^lint-ack: 두 PR 이 plugin\.json 버전 줄을 함께 고친다$/m)
    assert.match(r.stdout, /LAUNCHED ctx_1/)
    const record = JSON.parse(readFileSync(join(proj, '.orch/state/launched-workers/ctx_1.json'), 'utf8'))
    assert.equal(record.lint_ack, '두 PR 이 plugin.json 버전 줄을 함께 고친다')
  })

  test('이유가 빈 --lint-ack 은 사용법 오류다', () => {
    fakeLint(1)
    for (const reason of ['', '  ']) {
      const r = launch(['--worktree', worktree, '--lint-ack', reason, '--', ...CLAUDE])
      assert.equal(r.code, 2, both(r))
      assert.match(r.stderr, /--lint-ack 에는 넘기는 이유/)
    }
  })

  test('발견이 없으면 그대로 띄우고 기록에 lint_ack 이 없다', () => {
    fakeLint(0)
    const proj = join(tmp, 'proj')
    spawnSync('git', ['init', '-q', '-b', 'main', proj], { env })
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--repo', proj, '--name', 'x', '--lint-ack', '쓰이지 않는 이유', '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.doesNotMatch(r.stdout, /lint-ack/)
    const record = JSON.parse(readFileSync(join(proj, '.orch/state/launched-workers/ctx_1.json'), 'utf8'))
    assert.equal('lint_ack' in record, false)
  })

  test('spec-lint 가 검사하지 못하면(2) 경고만 내고 띄운다', () => {
    fakeLint(2)
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.match(r.stderr, /경고: spec-lint 가 종료 코드 2 로 끝나/)
  })

  test('같은 폴더에서 살아 있는 dispatch 의 지시서만 함께 넘기고 자신과 공통 지시서는 뺀다', () => {
    fakeLint(0)
    const other = join(tmp, 'spec-other.md')
    const common = join(tmp, 'spec-common.md')
    const elsewhere = join(tmp, 'sub', 'spec-far.md')
    mkdirSync(join(tmp, 'sub'))
    for (const file of [other, common, elsewhere]) writeFileSync(file, '# 다른 일\n')
    state({
      next_ids: ['ctx_1'],
      dispatches: { ctx_1: shown('input_accepted') },
      tasks: [
        { id: 't1', status: 'running', spec: `다음 지시서를 읽는다: ${other}` },
        { id: 't2', status: 'running', spec: `${spec} 와 ${common}` },
        { id: 't3', status: 'running', spec: elsewhere },
        { id: 't4', status: 'completed', spec: join(tmp, 'spec-done.md') },
      ],
    })
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    const call = lines('lint ')[0]
    // 활성 지시서는 --active 로 넘겨 선택 검사를 하지 않게 한다
    assert.ok(call.endsWith(`--active ${other} ${spec}`), call)
    assert.ok(!call.includes('spec-common.md') && !call.includes('spec-far.md') && !call.includes('spec-done.md'), call)
  })

  test('다른 활성 지시서끼리만 겹치면 경고를 보이고 새 worker 를 띄운다', () => {
    env.SPEC_LINT = join(dirname(SCRIPT), '..', 'spec', 'spec-lint.ts')
    const proj = join(tmp, 'proj')
    spawnSync('git', ['init', '-q', '-b', 'main', proj], { env })
    const first = join(tmp, 'spec-first.md')
    const second = join(tmp, 'spec-second.md')
    for (const file of [first, second]) writeFileSync(file, '# 앞\n담당: `shared.txt`\n')
    writeFileSync(spec, '# 리뷰\n허락: push 는 허락했다.\n\n## 할 일\n루프 없이: 테스트 지시서다\n')
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') }, tasks: [
      { id: 't1', status: 'running', spec: first },
      { id: 't2', status: 'running', spec: second },
    ] })
    const r = launch(['--repo', proj, '--name', 'x', '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.match(r.stderr, /겹침 경고/)
    assert.match(r.stdout, /LAUNCHED ctx_1/)
    assert.doesNotMatch(r.stdout, /lint-ack/)
  })

  test('살아 있는 dispatch 의 지시서와 담당이 겹치면 진짜 spec-lint 가 막는다', () => {
    env.SPEC_LINT = join(dirname(SCRIPT), '..', 'spec', 'spec-lint.ts')
    const proj = join(tmp, 'proj')
    spawnSync('git', ['init', '-q', '-b', 'main', proj], { env })
    spawnSync('git', ['-C', proj, 'commit', '-q', '--allow-empty', '-m', 'i'], { env })
    const first = join(tmp, 'spec-first.md')
    writeFileSync(first, '# 앞\n\n담당: `plugin.json`, `CHANGELOG.md`\n')
    writeFileSync(spec, '# 일\n\n허락: push 는 허락했다.\n담당: `plugin.json`\n\n## 할 일\n루프 없이: 테스트 지시서다\n')
    state({ next_ids: ['ctx_1'], tasks: [{ id: 't1', status: 'running', spec: first }] })
    const r = launch(['--repo', proj, '--name', 'x', '--', ...CLAUDE])
    assert.equal(r.code, 5, both(r))
    assert.match(r.stderr, /겹침/)
    // 앞 지시서에는 선택 줄도 할 일 절도 없지만 이미 띄운 것이라 선택, 루프 발견을 내지 않는다
    assert.doesNotMatch(r.stderr, /선택:|루프:/)
    assert.deepEqual(lines('make '), [])
  })

  test('기준 브랜치와 상대경로 스펙을 읽을 곳을 spec-lint 에 넘긴다', () => {
    fakeLint(0)
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    let r = launch(['--repo', tmp, '--name', 'x', '--base', 'origin/release', '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.match(lines('lint ')[0], /^lint --repo \S+ --base release \S*spec\.md$/)
    // --base 가 없으면 origin/HEAD 의 브랜치다
    const proj = join(tmp, 'proj')
    spawnSync('git', ['init', '-q', '-b', 'main', proj], { env })
    spawnSync('git', ['-C', proj, 'commit', '-q', '--allow-empty', '-m', 'i'], { env })
    spawnSync('git', ['-C', proj, 'update-ref', 'refs/remotes/origin/develop', 'HEAD'], { env })
    spawnSync('git', ['-C', proj, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'], { env })
    resetLog()
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    r = launch(['--repo', proj, '--name', 'x', '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.match(lines('lint ')[0], /^lint --repo \S+ --base develop \S*spec\.md$/)
    // --resume-remote 면 지시서 브랜치의 원격 ref 에서 읽는다
    writeFileSync(spec, `${readFileSync(spec, 'utf8')}브랜치: \`feat/a\`\n`)
    resetLog()
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    r = launch(['--repo', proj, '--name', 'x', '--base', 'main', '--resume-remote', '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.match(lines('lint ')[0], /--base main --spec-ref origin\/feat\/a \S*spec\.md$/)
    // --worktree 면 그 워크트리 아래 디스크에서 읽는다
    resetLog()
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.ok(lines('lint ')[0].includes(`--spec-root ${worktree} `), lines('lint ')[0])
  })

  describe('할 일 첫 줄의 루프 선택(진짜 spec-lint)', () => {
    let proj: string

    beforeEach(() => {
      env.SPEC_LINT = join(dirname(SCRIPT), '..', 'spec', 'spec-lint.ts')
      proj = join(tmp, 'proj')
      spawnSync('git', ['init', '-q', '-b', 'main', proj], { env })
      mkdirSync(join(proj, 'docs/features/a'), { recursive: true })
      writeFileSync(join(proj, 'docs/features/a/spec.md'), '# 기능\n확인: 2026-11-02\n\n## 목표\n\n고친다\n')
      spawnSync('git', ['-C', proj, 'add', '-A'], { env })
      spawnSync('git', ['-C', proj, 'commit', '-q', '-m', 'i'], { env })
      spawnSync('git', ['-C', proj, 'update-ref', 'refs/remotes/origin/main', 'HEAD'], { env })
      state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    })

    test('확인받은 스펙이 없는 기능 지시서는 워크트리를 만들기 전에 5 로 멈춘다', () => {
      writeFileSync(spec, '# 일\n허락: push 는 허락했다.\n\n## 할 일\n1. 화면에 취소 단추를 더한다\n')
      const r = launch(['--repo', proj, '--name', 'x', '--base', 'main', '--', ...CLAUDE])
      assert.equal(r.code, 5, both(r))
      assert.match(r.stderr, /spec\.md:5: 루프: `## 할 일` 아래 첫 줄이 .* 가운데 하나가 아니다: 화면에 취소 단추를 더한다/)
      assert.match(r.stderr, /--lint-ack/)
      assert.deepEqual(lines('make '), [])
      assert.deepEqual(lines('orca orchestration worker-start'), [])
      // 작업 트리에만 있는 스펙을 상대경로로 적어도 막는다
      writeFileSync(join(proj, 'docs/features/a/draft.md'), '# 기능\n확인: 2026-11-02\n')
      writeFileSync(spec, '# 일\n허락: push 는 허락했다.\n\n## 할 일\n루프를 쓴다(스펙: docs/features/a/draft.md)\n')
      const draft = launch(['--repo', proj, '--name', 'x', '--base', 'main', '--', ...CLAUDE])
      assert.equal(draft.code, 5, both(draft))
      assert.match(draft.stderr, /루프: 스펙 `docs\/features\/a\/draft\.md` 이 origin\/main 에 없다/)
      assert.deepEqual(lines('make '), [])
    })

    test('기준 브랜치의 확인받은 스펙을 가리키면 띄운다', () => {
      writeFileSync(spec, '# 일\n허락: push 는 허락했다.\n\n## 할 일\n루프를 쓴다(스펙: docs/features/a/spec.md). plan 부터 한다\n')
      const r = launch(['--repo', proj, '--name', 'x', '--base', 'main', '--', ...CLAUDE])
      assert.equal(r.code, 0, both(r))
      assert.match(r.stdout, /LAUNCHED ctx_1/)
      assert.doesNotMatch(r.stderr, /루프:/)
    })

    test('`루프 없이: <이유>` 와 `스펙: 새로 쓴다` 도 띄운다', () => {
      for (const first of ['루프 없이: 오타만 고친다', '루프를 쓴다(스펙: 새로 쓴다)']) {
        resetLog()
        state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
        writeFileSync(spec, `# 일\n허락: push 는 허락했다.\n\n## 할 일\n${first}\n`)
        const r = launch(['--repo', proj, '--name', 'x', '--', ...CLAUDE])
        assert.equal(r.code, 0, `${first}\n${both(r)}`)
        assert.match(r.stdout, /LAUNCHED ctx_1/)
      }
    })
  })
})

describe('Codex worker 의 ssh-agent 설정', () => {
  let proj: string
  let wt: string

  const gitOut = (cwd: string, ...args: string[]) => spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' })

  // lib-ssh-agent.spec.ts 가 설정 함수를 따로 본다. 여기서는 launch-worker 가 Codex 에만 부르는지 본다.
  beforeEach(() => {
    proj = join(tmp, 'sshproj')
    wt = join(tmp, 'sshwt')
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', proj], { env }).status, 0)
    assert.equal(gitOut(proj, 'commit', '-q', '--allow-empty', '-m', 'init').status, 0)
    assert.equal(gitOut(proj, 'worktree', 'add', '-q', '-b', 'feature/ssh', wt).status, 0)
    env.FAKE_WT_DEFAULT = `${wt}`
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
  })

  test('codex 면 그 워크트리에만 core.sshCommand 를 두고 공유 설정은 그대로다', () => {
    env.SSH_AUTH_SOCK = '/tmp/agent.sock'
    const r = launch(['--worktree', wt, '--', ...CODEX])
    assert.equal(r.code, 0, both(r))
    assert.equal(gitOut(wt, 'config', '--worktree', '--get', 'core.sshCommand').stdout.trim(), 'ssh -o IdentityAgent=/tmp/agent.sock')
    assert.equal(gitOut(proj, 'config', '--local', '--get', 'core.sshCommand').status, 1)
    assert.equal(gitOut(proj, 'config', '--get', 'core.sshCommand').status, 1)
    assert.match(r.stdout, /SSH-AGENT/)
  })

  test('claude 면 설정하지 않는다', () => {
    env.SSH_AUTH_SOCK = '/tmp/agent.sock'
    const r = launch(['--worktree', wt, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    assert.equal(gitOut(wt, 'config', '--get', 'core.sshCommand').status, 1)
    assert.equal(gitOut(wt, 'config', '--local', '--get', 'extensions.worktreeConfig').status, 1)
  })

  test('SSH_AUTH_SOCK 이 없으면 codex 여도 설정하지 않는다', () => {
    delete env.SSH_AUTH_SOCK
    const r = launch(['--worktree', wt, '--', ...CODEX])
    assert.equal(r.code, 0, both(r))
    assert.equal(gitOut(wt, 'config', '--get', 'core.sshCommand').status, 1)
  })

  test('사용자가 정한 core.sshCommand 는 덮지 않고 알린다', () => {
    env.SSH_AUTH_SOCK = '/tmp/agent.sock'
    assert.equal(gitOut(proj, 'config', '--local', 'core.sshCommand', 'ssh -i /my/key').status, 0)
    const r = launch(['--worktree', wt, '--', ...CODEX])
    assert.equal(r.code, 0, both(r))
    assert.equal(gitOut(wt, 'config', '--get', 'core.sshCommand').stdout.trim(), 'ssh -i /my/key')
    assert.match(r.stderr, /SSH-AGENT 건너뜀/)
  })
})

describe('짧은 출력', () => {
  test('LAUNCHED 에 터미널을 넣고 worker-start JSON 대신 LAUNCH-EFFECTIVE 만 남기며 단계 줄을 내지 않는다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    env.ORCH_OUTPUT = 'short'
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 0, both(r))
    const out = r.stdout.trim().split('\n')
    assert.equal(out.length, 2, r.stdout)
    assert.equal(out[0], 'LAUNCH-EFFECTIVE {}')
    assert.match(out[1], new RegExp(`^LAUNCHED ctx_1 \\S+ ${worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  })

  test('시간 초과는 짧은 출력에도 STALLED-START 줄로 근거를 남긴다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('worktree_creating') } })
    env.ORCH_OUTPUT = 'short'
    const r = launch(['--worktree', worktree, '--watch', '2', '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /^STALLED-START ctx_1 worktree_creating watch=2s,no-signs-of-life terminal=- screen=unavailable$/m)
    assert.deepEqual(lines('orca orchestration worker-abandon'), [])
    assert.equal(lines('orca orchestration worker-start').length, 1)
    assert.doesNotMatch(r.stdout, /LAUNCHED/)
  })

  test('단계가 없어도 시간 초과로 abandon 하거나 재시도하지 않는다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: { flat: '' } } })
    env.ORCH_OUTPUT = 'short'
    const r = launch(['--worktree', worktree, '--watch', '1', '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /^STALLED-START ctx_1 - watch=1s,no-signs-of-life terminal=- screen=unavailable$/m)
    assert.deepEqual(lines('orca orchestration worker-abandon'), [])
    assert.equal(lines('orca orchestration worker-start').length, 1)
  })

  test('worker-start 가 실패하면 receipt 전체를 START-FAIL 한 줄로 남긴다', () => {
    state({ start_fails: true })
    env.ORCH_OUTPUT = 'short'
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    const line = r.stdout.split('\n').find((l) => l.startsWith('START-FAIL ')) ?? ''
    assert.deepEqual(JSON.parse(line.slice('START-FAIL '.length)), { ok: false, result: { failedStage: 'agent_readiness' } })
  })

  test('남은 터미널 거부는 REFUSED 한 줄이다', () => {
    state({ next_ids: ['ctx_1'], terminals: [{ handle: 'term_old', title: 'claude 앞 세션', worktreePath: worktree }] })
    env.ORCH_OUTPUT = 'short'
    const r = launch(['--worktree', worktree, '--', ...CLAUDE])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /^REFUSED 이 워크트리에 터미널이 남아 있다.*\n$/)
  })
})

// 실제 진입점에서 종료 코드 종류와 출력·상태를 fixture 와 대조한다.
describe('CLI 와 함수 진입점 대응', () => {
  for (const example of [
    { name: '성공', code: 0, values: { next_ids: ['ctx_cli'] } },
    { name: '실행 실패', code: 1, values: { next_ids: ['ctx_cli'], start_fails: true } },
    { name: '사용법 오류', code: 2, values: {}, extra: ['--unknown-option'] },
    { name: '이어 쓰기 실패', code: 3, values: { next_ids: ['ctx_cli'], start_errors: ['agent_unconfigured: missing'] }, terminal: true },
    { name: '모델 거부', code: 4, values: {}, models: true },
    { name: 'lint 거부', code: 5, values: {}, lint: true },
  ]) {
    test(`${example.name} 의 출력·종료·상태가 같다`, () => {
      if (example.models) env.CODEX_BIN = linkBin(tmp, 'codex', `console.log(JSON.stringify({ models: [{ slug: 'allowed', supported_reasoning_levels: [] }] }))`)
      if (example.lint) {
        const lint = join(tmp, 'lint.sh')
        writeFileSync(lint, '#!/bin/sh\nexit 1\n')
        env.SPEC_LINT = lint
      }
      const args = ['--worktree', worktree, '--watch', '0', ...(example.extra ?? []), '--', ...(example.terminal ? ['--terminal', 'term_cli'] : CODEX)]
      state(example.values)
      const real = launch(args, 'bash', true, SCRIPT)
      const realState = readFileSync(stateFile, 'utf8')
      const realLog = existsSync(log) ? readFileSync(log, 'utf8') : ''
      state(example.values)
      resetLog()
      const fake = launch(args)
      assert.equal(real.code, example.code, both(real))
      assert.deepEqual(fake, real)
      assert.equal(readFileSync(stateFile, 'utf8'), realState)
      assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : '', realLog)
    })
  }
})


describe('실제 spec-lint의 CLI와 함수 판정 대응', () => {
  for (const example of [{ name: '막음', code: 5 }, { name: '경로 경고', code: 0 }]) {
    test(`${example.name}의 launch 출력·종료·상태·호출 기록이 같다`, () => {
      assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', worktree], { env }).status, 0)
      assert.equal(spawnSync('git', ['-C', worktree, 'commit', '-q', '--allow-empty', '-m', 'init'], { env }).status, 0)
      env.SPEC_LINT = fileURLToPath(new URL('../scripts/spec/spec-lint.ts', import.meta.url))
      writeFileSync(spec, '# 일\n허락: push는 허락했다.\n\n## 할 일\n' +
        (example.code === 5 ? '화면에 취소 단추를 더한다\n' : '루프 없이: 테스트 지시서다\n`src/not-found.ts`를 만든다\n'))
      const args = ['--worktree', worktree, '--watch', '0', '--', ...CLAUDE]
      const values = { next_ids: ['ctx_spec'], dispatches: { ctx_spec: shown('input_accepted') } }
      state(values)
      const real = launch(args, 'bash', true, SCRIPT)
      assert.equal(real.code, example.code, both(real))
      assert.match(real.stderr, example.code === 5 ? /루프:/ : /경로:.*src\/not-found\.ts/)
      const realState = readFileSync(stateFile, 'utf8')
      const realLog = existsSync(log) ? readFileSync(log, 'utf8') : ''
      state(values)
      resetLog()
      const fake = launch(args)
      assert.deepEqual(fake, real)
      assert.equal(readFileSync(stateFile, 'utf8'), realState)
      assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : '', realLog)
    })
  }
})
