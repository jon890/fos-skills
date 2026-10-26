// launch-worker.ts 를 가짜 orca 와 가짜 make-worktree 로 본다. Orca 에는 닿지 않는다.
// before-launch 와 worker-launched 핸들러는 임시 저장소의 .orch/hooks/ 에 둔다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/launch-worker.ts', import.meta.url))

// 상태 파일로 움직이는 가짜 orca. 받은 인자를 한 줄씩 기록한다. 확장자가 없어 타입 문법 없이 쓴다.
// macOS 에서 파이프로 가는 process.stdout 쓰기는 비동기라 process.exit 가 출력을 자를 수 있어 writeSync 로 쓴다.
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2).filter((a) => a !== '--json')
fs.appendFileSync(process.env.FAKE_LOG, 'orca ' + args.join(' ') + '\\n')
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
if (is('terminal', 'close')) out({}, state.close_fails ? 1 : 0)
if (is('orchestration', 'worker-start')) {
  if (state.start_errors && state.start_errors.length) out({ error: state.start_errors.shift() }, 1)
  if (state.start_fails) out({ failedStage: 'agent_readiness' }, 1)
  const id = state.next_ids.shift()
  out({ dispatch: { id, taskId: 'task_1' }, launch: { effective: {} } })
}
if (is('orchestration', 'worker-show')) {
  const d = state.dispatches[opt('--dispatch')]
  const stages = d.stages || []
  const stage = stages.length > 1 ? stages.shift() : stages[0] || 'input_accepted'
  out({ dispatch: d.dispatch, worker: Object.assign({}, d.worker || {}, { stage }), terminalResource: d.terminalResource || {} })
}
if (is('orchestration', 'worker-abandon')) out({})
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
  writeFileSync(join(binDir, 'orca'), FAKE_ORCA)
  chmodSync(join(binDir, 'orca'), 0o755)
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
    FAKE_STATE: stateFile,
    FAKE_LOG: log,
    MAKE_WORKTREE: make,
    LAUNCH_POLL: '0',
    LAUNCH_WT_POLL: '0',
    LAUNCH_WT_WAIT: '3',
    FAKE_WT_DEFAULT: `${worktree}:${tmp}/new:${tmp}/hookwt`,
  }
  delete env.ORCH_DIR
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

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

function launch(args: string[], shell = 'bash'): Launch {
  const done = spawnSync(shell, ['-c', 'exec "$NODE_BIN" --disable-warning=ExperimentalWarning "$@"', 'launch', SCRIPT, '--spec', spec, ...args], {
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
    const r = launch(['--worktree', worktree, '--', '--agent', 'claude'])
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
    const r = launch(['--worktree', worktree, '--', '--agent', 'claude'])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /터미널이 남아 있다/)
    assert.match(r.stdout, /term_old claude 앞 세션/)
    assert.doesNotMatch(r.stdout, /term_other/)
    assert.deepEqual(lines('orca orchestration worker-start'), [])
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
    const r = launch(['--worktree', worktree, '--', '--agent', 'codex'])
    assert.equal(r.code, 1, both(r))
    assert.match(r.stderr, /codex plugin marketplace upgrade fos-skills/)
  })

  test('--terminal 없이 난 agent_unconfigured 는 보통 실패다', () => {
    state({ next_ids: ['ctx_1'], start_errors: ['agent_unconfigured: x'] })
    const r = launch(['--worktree', worktree, '--', '--agent', 'claude'])
    assert.equal(r.code, 1, both(r))
  })

  test('옮기기 전의 orch 폴더가 있으면 orca 전에 2 로 멈춘다', () => {
    const legacy = join(worktree, '.omc/orch')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'old.json'), '{}')
    const r = launch(['--worktree', `path:${worktree}`, '--', '--agent', 'codex'])
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
    const r = launch(['--work', worktree, '--wat=0', '--', '--agent', 'claude'])
    assert.equal(r.code, 0, both(r))
    assert.ok(lines('orca orchestration worker-start')[0].includes(`--worktree path:${worktree} --agent claude`), lines('').join('\n'))
    // --re 는 --repo 와 --resume-remote 에 맞는다
    const ambiguous = launch(['--re', tmp, '--name', 'x', '--', '--agent', 'claude'])
    assert.equal(ambiguous.code, 2, both(ambiguous))
    assert.match(ambiguous.stderr, /--re 이 여러 옵션의 접두다: --repo, --resume-remote/)
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
    const r = launch(['--repo', tmp, '--name', 'feat', '--resume-remote', '--', '--agent', 'codex'])
    assert.equal(r.code, 0, both(r))
    assert.ok(lines('make')[0].includes('--resume-remote'))
  })

  test('bash 와 zsh 에서 선택 옵션이 따로인 낱말로 간다', () => {
    // zsh 는 ${run:+--run "$run"} 를 나누지 않아 worker-start 가 Unknown flag --run run_x 로 실패한 일이 있다
    for (const shell of ['bash', 'zsh']) {
      if (!hasShell(shell)) continue
      resetLog()
      rmSync(join(tmp, 'new'), { recursive: true, force: true })
      state({ next_ids: ['ctx_1', 'ctx_2'], dispatches: { ctx_1: shown('worktree_creating'), ctx_2: shown('input_accepted') } })
      const r = launch(['--repo', tmp, '--name', 'feat', '--base', 'develop', '--run', 'run_x', '--watch', '1', '--', '--agent', 'codex'], shell)
      assert.equal(r.code, 0, `${shell}: ${both(r)}`)
      assert.deepEqual(lines('make'), [`make --repo ${tmp} --spec ${spec} --name feat --base develop`])
      const [first, retry] = lines('orca orchestration worker-start')
      assert.ok(first.startsWith('orca orchestration worker-start --run run_x --spec '), first)
      assert.ok(retry.includes('--run run_x --task task_1 --retry-of ctx_1'), retry)
    }
  })

  test('--run 과 --base 가 없으면 빈 낱말을 넘기지 않는다', () => {
    for (const shell of ['bash', 'zsh']) {
      if (!hasShell(shell)) continue
      resetLog()
      state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
      const r = launch(['--repo', tmp, '--name', 'feat', '--', '--agent', 'codex'], shell)
      assert.equal(r.code, 0, `${shell}: ${both(r)}`)
      assert.deepEqual(lines('make'), [`make --repo ${tmp} --spec ${spec} --name feat`])
      assert.ok(lines('orca orchestration worker-start')[0].startsWith('orca orchestration worker-start --spec '))
    }
  })

  test('--worktree 는 path: 접두를 받는다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', `path:${worktree}`, '--', '--agent', 'claude'])
    assert.equal(r.code, 0, both(r))
    assert.ok(lines('orca orchestration worker-start')[0].includes(`--worktree path:${worktree} --agent claude`))
    assert.ok(r.stdout.trimEnd().endsWith(`LAUNCHED ctx_1 ${worktree}`), r.stdout)
  })

  test('워크트리를 만든 뒤 실패하면 이어 띄우는 명령을 알린다', () => {
    for (const shell of ['bash', 'zsh']) {
      if (!hasShell(shell)) continue
      state({ start_fails: true, terminals: [{ handle: 'term_left', title: 'codex hooks review', worktreePath: `${tmp}/new` }] })
      const r = launch(['--repo', tmp, '--name', 'feat', '--run', 'run_x', '--', '--agent', 'codex', '--model', 'gpt 6'], shell)
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
    state({ next_ids: ['ctx_1', 'ctx_2'], dispatches: { ctx_1: shown('worktree_creating'), ctx_2: shown('worktree_creating') } })
    const r = launch(['--repo', tmp, '--name', 'feat', '--watch', '1', '--', '--agent', 'claude'])
    assert.equal(r.code, 1, both(r))
    assert.doesNotMatch(r.stderr, /워크트리는 남아 있다/)
  })

  test('기존 워크트리의 실패와 성공은 이어 띄우는 명령을 알리지 않는다', () => {
    state({ start_fails: true })
    let r = launch(['--worktree', worktree, '--', '--agent', 'claude'])
    assert.equal(r.code, 1, both(r))
    assert.doesNotMatch(r.stderr, /워크트리는 남아 있다/)
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
    r = launch(['--repo', tmp, '--name', 'feat', '--', '--agent', 'claude'])
    assert.equal(r.code, 0, both(r))
    assert.doesNotMatch(r.stderr, /워크트리는 남아 있다/)
  })

  test('worktree_creating 에서 멈추면 abandon 하고 한 번 다시 띄운다', () => {
    state({ next_ids: ['ctx_1', 'ctx_2'], dispatches: { ctx_1: shown('worktree_creating'), ctx_2: shown('input_accepted') } })
    const r = launch(['--worktree', worktree, '--watch', '3', '--', '--agent', 'claude'])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration worker-abandon'), ['orca orchestration worker-abandon --dispatch ctx_1'])
    const retry = lines('orca orchestration worker-start')[1]
    assert.ok(retry.includes(`--task task_1 --retry-of ctx_1 --worktree path:${worktree} --agent claude`), retry)
    assert.ok(!retry.includes('--spec'), retry)
    assert.match(r.stdout, /LAUNCHED ctx_2/)
  })

  test('다시 띄워도 멈추면 실패다', () => {
    state({ next_ids: ['ctx_1', 'ctx_2'], dispatches: { ctx_1: shown('worktree_creating'), ctx_2: shown('worktree_creating') } })
    const r = launch(['--worktree', worktree, '--watch', '2', '--', '--agent', 'claude'])
    assert.equal(r.code, 1, both(r))
    assert.equal(lines('orca orchestration worker-start').length, 2)
    assert.doesNotMatch(r.stdout, /LAUNCHED/)
  })

  test('지켜보는 동안 단계가 넘어가면 그대로 둔다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('worktree_creating', 'agent_starting') } })
    const r = launch(['--worktree', worktree, '--watch', '5', '--', '--agent', 'claude'])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(lines('orca orchestration worker-abandon'), [])
    assert.match(r.stdout, /ctx_1 단계: agent_starting/)
  })

  test('실패한 worker-start 는 다시 띄우지 않는다', () => {
    state({ start_fails: true })
    const r = launch(['--worktree', worktree, '--', '--agent', 'claude'])
    assert.equal(r.code, 1, both(r))
    assert.equal(lines('orca orchestration worker-start').length, 1)
  })
})

describe('Orca 의 워크트리 인식', () => {
  test('orca worktree list 에 보일 때까지 기다린다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') }, worktree_lists: [[], [], [worktree]] })
    const r = launch(['--worktree', worktree, '--', '--agent', 'claude'])
    assert.equal(r.code, 0, both(r))
    assert.equal(lines('orca worktree list').length, 3)
    assert.match(r.stderr, /알아보기까지 2초 기다렸다/)
  })

  test('기다린 초는 옛 명령의 :g 꼴로 낸다', () => {
    // 0.1 을 세 번 더하면 0.30000000000000004 다. 옛 명령은 0.3 으로 냈다
    env.LAUNCH_WT_POLL = '0.1'
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') }, worktree_lists: [[], [], [], [worktree]] })
    const r = launch(['--worktree', worktree, '--', '--agent', 'claude'])
    assert.equal(r.code, 0, both(r))
    assert.match(r.stderr, /^Orca 가 워크트리를 알아보기까지 0\.3초 기다렸다$/m)
  })

  test('끝까지 보이지 않으면 띄우지 않고 멈춘다', () => {
    state({ next_ids: ['ctx_1'], worktree_lists: Array.from({ length: 20 }, () => []) })
    const r = launch(['--worktree', worktree, '--', '--agent', 'claude'])
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
    const r = launch(['--worktree', wt, '--', '--agent', 'claude'])
    assert.equal(r.code, 1, both(r))
    assert.ok(r.stderr.includes(`만든 경로: ${wt}`), r.stderr)
    assert.match(r.stderr, /externalWorktreeVisibility: hide/)
    assert.ok(r.stderr.includes(`orca repo set --repo path:${repo} --external-worktree-visibility show`), r.stderr)
    assert.deepEqual(lines('orca repo set'), [])
    assert.deepEqual(lines('orca orchestration worker-start'), [])
  })

  test('selector_not_found 는 한 번 다시 부른다', () => {
    state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') }, start_errors: ['selector_not_found'] })
    const r = launch(['--worktree', worktree, '--', '--agent', 'claude'])
    assert.equal(r.code, 0, both(r))
    assert.equal(lines('orca orchestration worker-start').length, 2)
    assert.match(r.stdout, /LAUNCHED ctx_1/)
  })

  test('selector_not_found 가 두 번이면 실패하고 다른 오류는 다시 부르지 않는다', () => {
    state({ next_ids: ['ctx_1'], start_errors: ['selector_not_found', 'selector_not_found'] })
    let r = launch(['--worktree', worktree, '--', '--agent', 'claude'])
    assert.equal(r.code, 1, both(r))
    assert.equal(lines('orca orchestration worker-start').length, 2)
    resetLog()
    state({ next_ids: ['ctx_1'], start_errors: ['agent_not_found'] })
    r = launch(['--worktree', worktree, '--', '--agent', 'claude'])
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
    assert.deepEqual(order(), ['make --repo', 'orca worktree list', 'orca orchestration worker-start', 'orca orchestration worker-show'])
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

  test('--worktree 로 부르면 그 워크트리의 주 checkout 핸들러가 받고 --task, --terminal 이 입력에 든다', () => {
    spawnSync('git', ['-C', proj, 'worktree', 'add', '-q', '-b', 'feature/old', hookWt], { env })
    const file = capture('before-launch', 0)
    state({ next_ids: ['ctx_1'], terminals: [{ handle: 'term_old', worktreePath: hookWt }], dispatches: { ctx_1: shown('input_accepted') } })
    const r = launch(['--worktree', hookWt, '--', '--task', 'task_9', '--terminal', 'term_old'])
    assert.equal(r.code, 0, both(r))
    const input = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(input.repo, proj)
    assert.deepEqual(input.worker, { task: 'task_9', dispatch: null, terminal: 'term_old', worktree: hookWt, spec })
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


test('LAUNCHED 뒤 지시서의 id, 제목, 할 일로 항목을 만들고 기존 단계는 보존한다', () => {
  const file = join(worktree, '.omc', 'board.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ items: [] }))
  writeFileSync(spec, '# 자동 갱신\n허락: PR 생성\n보드 항목 id: `board-id`\n\n## 할 일\n1. 구현\n   설명\n2. 검증\n\n## 완료\n1. 다른 절\n')
  state({ next_ids: ['ctx_1'], dispatches: { ctx_1: shown('input_accepted') } })
  const r = launch(['--worktree', worktree, '--watch', '0', '--', '--agent', 'codex'])
  assert.equal(r.code, 0, both(r))
  let item = JSON.parse(readFileSync(file, 'utf8')).items[0]
  assert.equal(item.id, 'board-id')
  assert.equal(item.title, '자동 갱신')
  assert.equal(item.worktree, 'wt')
  assert.equal(item.status, 'doing')
  assert.deepEqual(item.details, [{ text: '1. 구현', done: false }, { text: '2. 검증', done: false }])
  item.details[0].done = true
  writeFileSync(file, JSON.stringify({ items: [item] }))
  state({ next_ids: ['ctx_2'] })
  assert.equal(launch(['--worktree', worktree, '--watch', '0', '--', '--agent', 'codex']).code, 0)
  item = JSON.parse(readFileSync(file, 'utf8')).items[0]
  assert.equal(item.details[0].done, true)
})


test('항목 id 가 없으면 --name 을 쓰고 단계가 없으면 기본 단계를 둔다', () => {
  const file = join(tmp, '.omc', 'board.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ items: [] }))
  state({ next_ids: ['ctx_1'] })
  const r = launch(['--repo', tmp, '--name', 'example', '--watch', '0', '--', '--agent', 'codex'])
  assert.equal(r.code, 0, both(r))
  const item = JSON.parse(readFileSync(file, 'utf8')).items[0]
  assert.equal(item.id, 'example')
  assert.equal(item.details.length, 3)
  assert.equal(item.worktree, 'new')
})

test('보드가 없으면 LAUNCHED 뒤에도 파일을 만들지 않는다', () => {
  state({ next_ids: ['ctx_1'] })
  const r = launch(['--worktree', worktree, '--watch', '0', '--', '--agent', 'codex'])
  assert.equal(r.code, 0, both(r))
  assert.equal(existsSync(join(worktree, '.omc', 'board.json')), false)
  assert.doesNotMatch(r.stderr, /보드를 갱신하지 못했다/)
})
