// 상태 있는 가짜 orca 와 임시 git 저장소로 orch worker resume 의 대상 판정, 단계 순서, 단계별 실패를 검증한다.
// 가짜 orca 는 FAKE_STATE(JSON)로 답하고 호출마다 FAKE_LOG 에 인자와 그때 요청 폴더에 go 가 있었는지를 적는다.
// terminal create 는 사례가 정한 found.json 을 요청 폴더에 쓰고 새 터미널을 목록에 더한다(실행기 대신). 실제 Orca 에는 닿지 않는다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readLaunch, recordLaunch } from '../scripts/lib/launched.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/worker/resume-worker.ts', import.meta.url))

// 확장자 없는 실행 파일은 타입 제거 대상이 아니라 타입 문법을 쓰지 않는다
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const file = process.env.FAKE_STATE
const s = JSON.parse(fs.readFileSync(file, 'utf8'))
const save = () => fs.writeFileSync(file, JSON.stringify(s))
const args = process.argv.slice(2)
const go = fs.existsSync(path.join(s.reqDir, 'go'))
const entry = { args, go }
const val = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const say = (result) => { fs.writeSync(1, JSON.stringify({ ok: true, result }) + '\\n') }
const fail = (text) => { fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\\n'); fs.writeSync(1, JSON.stringify({ ok: false, error: { message: text } }) + '\\n'); process.exit(1) }
const has = (...words) => words.every((w) => args.includes(w))
if (has('terminal', 'create')) {
  if (s.fail.create) fail('create failed')
  entry.request = JSON.parse(fs.readFileSync(path.join(s.reqDir, 'request.json'), 'utf8'))
  fs.writeFileSync(path.join(s.reqDir, 'found.json'), JSON.stringify(s.found))
  s.terminals.push({ handle: s.newHandle, worktreePath: s.worktree, agentIdentity: null, connected: true })
  save()
}
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\\n')
if (has('terminal', 'create')) say({ terminal: { handle: s.newHandle } })
else if (has('terminal', 'list')) say({ terminals: s.terminals.map((t) => t.handle === s.newHandle && go ? { ...t, agentIdentity: s.newIdentity } : t) })
else if (has('terminal', 'read')) {
  const h = val('--terminal')
  say({ terminal: { source: 'screen', tail: h === s.newHandle ? (go ? s.newScreen : ['$']) : (s.screens[h] || []) } })
} else if (has('terminal', 'close')) {
  const h = val('--terminal')
  if (s.fail.close && h !== s.newHandle) fail('close failed')
  s.terminals = s.terminals.filter((t) => t.handle !== h)
  save(); say({ closed: h })
} else if (has('worker-abandon')) {
  if (s.fail.abandon) fail('abandon failed')
  s.dispatch.status = 'abandoned'; save(); say({ dispatch: s.dispatch })
} else if (has('worker-show')) say({ dispatch: s.dispatch, worker: s.worker })
else if (has('task-list')) say({ tasks: s.tasks })
else if (has('dispatch-show')) say({ dispatch: { id: s.latest, status: s.dispatch.status } })
else if (has('worker-start')) {
  if (s.fail.start) fail('outcome_unknown')
  say({ dispatch: { id: 'ctx_new', taskId: s.dispatch.taskId } })
} else { fs.writeSync(2, 'unknown ' + args.join(' ')); process.exit(9) }
`

// 가짜 ps. -E 목록에는 환경이 붙은 claude 줄을, -p 에는 환경 없는 실행 줄을 낸다
const FAKE_PS = `#!/usr/bin/env node
const args = process.argv.slice(2)
const view = process.env.FAKE_VIEW
if (args.includes('-E')) {
  process.stdout.write('  10 /bin/zsh -l ORCA_TERMINAL_HANDLE=term_old\\n')
  process.stdout.write('  11 claude --plugin-dir ' + view + ' --model m ORCA_TERMINAL_HANDLE=term_other\\n')
  process.stdout.write('  12 claude --plugin-dir ' + view + ' --permission-mode auto --model m HOME=/h ORCA_TERMINAL_HANDLE=term_old SECRET_TOKEN=x\\n')
} else if (args.includes('-p') && args[args.indexOf('-p') + 1] === '12') {
  process.stdout.write('claude --plugin-dir ' + view + ' --permission-mode auto --model m\\n')
}
`

const bin = realpathSync(mkdtempSync(join(tmpdir(), 'resume-worker-bin-')))
writeFileSync(join(bin, 'orca'), FAKE_ORCA); chmodSync(join(bin, 'orca'), 0o755)
writeFileSync(join(bin, 'ps'), FAKE_PS); chmodSync(join(bin, 'ps'), 0o755)
after(() => rmSync(bin, { recursive: true, force: true }))

let root: string, repo: string, worktree: string, stateFile: string, logFile: string, reqDir: string, view: string
type State = Record<string, any>

function baseState(): State {
  return {
    reqDir, worktree,
    dispatch: { id: 'ctx_old', runId: 'run_a', taskId: 'task_a', status: 'running', assigneeHandle: 'term_old' },
    worker: { agentTerminalHandle: 'term_old', worktreeId: `ws::${worktree}`,
      startOptions: { mode: { mode: 'terminal' }, launch: { effective: { agent: 'claude', model: 'claude-haiku-5-5', effort: 'low' } } } },
    tasks: [{ id: 'task_a', status: 'dispatched' }],
    latest: 'ctx_old',
    terminals: [{ handle: 'term_old', worktreePath: worktree, agentIdentity: 'claude', connected: true }],
    screens: { term_old: ["⎿ You've hit your weekly limit · resets 9am", '❯'] },
    newHandle: 'term_new', newIdentity: 'claude', newScreen: ['⎿ API Error: limit', '❯'],
    found: { ok: true, session: 'sess-1', home: '/h', terminal: 'term_new' },
    fail: {},
  }
}

function setState(patch: (s: State) => void): void {
  const s = baseState()
  patch(s)
  writeFileSync(stateFile, JSON.stringify(s))
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'resume-worker-')))
  repo = join(root, 'repo'); mkdirSync(repo)
  const git = (...args: string[]) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr) }
  git('init', '-b', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial')
  worktree = join(repo, 'worktrees', 'old')
  git('worktree', 'add', '-b', 'feat/old', worktree)
  reqDir = join(repo, '.orch', 'state', 'resume', 'ctx_old')
  stateFile = join(root, 'state.json'); logFile = join(root, 'log.jsonl')
  view = join(root, 'agent view', 'orca-agent-view')
  setState(() => {})
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function run(args: string[] = ['--dispatch', 'ctx_old']) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, ...args], {
    encoding: 'utf8', env: { ...process.env, ORCA: join(bin, 'orca'), FAKE_STATE: stateFile, FAKE_LOG: logFile, FAKE_VIEW: view,
      CLAUDE_CONFIG_DIR: join(root, 'config'), ORCH_OUTPUT: '', PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH}` },
  })
}

type Entry = { args: string[]; go: boolean; request?: Record<string, unknown> }
function log(): Entry[] {
  return existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
}
const is = (e: Entry, ...words: string[]) => words.every((w) => e.args.includes(w))
const calls = (...words: string[]) => log().filter((e) => is(e, ...words))
const writes = () => log().filter((e) => is(e, 'terminal', 'create') || is(e, 'worker-abandon') || is(e, 'terminal', 'close') || is(e, 'worker-start'))

test('limited Claude: 새 터미널, abandon, 옛 터미널 닫기, 잇기 순서이고 정리는 go 전에 한다', () => {
  recordLaunch(repo, { dispatch: 'ctx_old', task: 'task_a', terminal: 'term_old', worktree, branch: 'feat/old', run: 'run_a', spec: '/specs/old.md' })
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const order = writes()
  assert.deepEqual(order.map((e) => e.args.slice(0, 2).join(' ')), ['terminal create', 'orchestration worker-abandon', 'terminal close', 'orchestration worker-start'])
  assert.equal(order[0].go, false); assert.equal(order[1].go, false); assert.equal(order[2].go, false)
  assert.equal(order[2].args[order[2].args.indexOf('--terminal') + 1], 'term_old')
  assert.equal(order[3].go, true)
  const start = order[3].args
  assert.equal(start[start.indexOf('--terminal') + 1], 'term_new')
  assert.equal(start[start.indexOf('--task') + 1], 'task_a')
  assert.equal(start[start.indexOf('--run') + 1], 'run_a')
  assert.equal(start[start.indexOf('--worktree') + 1], `path:${worktree}`)
  assert.ok(!start.includes('--retry-of') && !start.includes('--agent') && !start.includes('--model'))
  assert.match(r.stdout, new RegExp(`^RESUME-TARGET ctx_old kind=limited task=task_a worktree=${worktree} agent=claude$`, 'm'))
  assert.match(r.stdout, /^RESUME-SCREEN\n {2}⎿ You've hit your weekly limit/m)
  assert.match(r.stdout, /^RESUME-SESSION sess-1 home=\/h terminal=term_new$/m)
  assert.match(r.stdout, /^RESUMED ctx_new term_new sess-1$/m)
  // 출력 순서: 화면과 세션이 정리보다 앞이다(정리 호출은 출력이 없으므로 줄 순서로 본다)
  assert.ok(r.stdout.indexOf('RESUME-SCREEN') < r.stdout.indexOf('RESUME-SESSION'))
  assert.equal(order[0].request!.pluginDir, view)
  assert.equal(order[0].request!.agent, 'claude')
  assert.equal(order[0].request!.model, 'claude-haiku-5-5')
  const command = order[0].args[order[0].args.indexOf('--command') + 1]
  assert.match(command, /resume-exec\.ts'? '?[^ ]*ctx_old'? && \. '?[^ ]*ctx_old\/launch\.sh'?$/)
  assert.ok(command.includes(process.execPath))
  const launch = readLaunch(repo, 'ctx_new')!
  assert.equal(launch.branch, 'feat/old'); assert.equal(launch.spec, '/specs/old.md'); assert.equal(launch.terminal, 'term_new')
  // 다음 resume 이 쓸 실행 설정을 옮겨 적는다
  assert.equal(launch.agent, 'claude'); assert.equal(launch.model, 'claude-haiku-5-5'); assert.equal(launch.effort, 'low')
  assert.ok(!existsSync(reqDir), '성공하면 요청 폴더를 지운다')
  // ps -E 의 환경 문자열은 출력과 요청 파일에 남지 않는다
  assert.doesNotMatch(r.stdout + r.stderr + JSON.stringify(order[0].request), /SECRET_TOKEN|HOME=\/h/)
})

test('limited Codex: 같은 흐름이고 pluginDir 이 null 이다. 앞 기록이 없으면 RESUME-WARN', () => {
  setState((s) => {
    s.worker.startOptions.launch.effective = { agent: 'codex', model: 'gpt-6-luna', effort: 'medium' }
    s.terminals[0].agentIdentity = 'codex'; s.newIdentity = 'codex'; s.newScreen = ['› ']
  })
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const create = calls('terminal', 'create')[0]
  assert.equal(create.request!.agent, 'codex'); assert.equal(create.request!.pluginDir, null)
  assert.match(r.stdout, /^RESUME-WARN spec 기록 없음$/m)
  assert.match(r.stdout, /^RESUMED ctx_new term_new sess-1$/m)
})

test('resume 으로 이은 dispatch 는 Orca 의 launch 가 비어도 기록의 실행 설정으로 다시 resume 한다', () => {
  // worker-start --terminal 로 이은 dispatch 처럼 launch 와 agent 가 없다
  setState((s) => {
    s.dispatch.status = 'failed'; s.tasks[0].status = 'ready'; s.terminals = []
    s.worker.startOptions = { mode: { mode: 'terminal' } }
    s.newIdentity = 'codex'; s.newScreen = ['› ']
  })
  recordLaunch(repo, { dispatch: 'ctx_old', task: 'task_a', terminal: 'term_old', worktree, branch: 'feat/old', run: 'run_a', spec: null,
    agent: 'codex', model: 'gpt-6-luna', effort: 'high' })
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /agent=codex/)
  const req = calls('terminal', 'create')[0].request!
  assert.equal(req.model, 'gpt-6-luna'); assert.equal(req.effort, 'high')
  assert.equal(readLaunch(repo, 'ctx_new')!.model, 'gpt-6-luna')
})

test('restart: 터미널 없는 failed dispatch 는 abandon 과 닫기 없이 잇고, 옛 터미널이 열려 있으면 거부한다', () => {
  setState((s) => { s.dispatch.status = 'failed'; s.tasks[0].status = 'ready'; s.terminals = [] })
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /kind=restart/)
  assert.equal(calls('worker-abandon').length, 0)
  assert.equal(calls('terminal', 'close').length, 0)
  assert.doesNotMatch(r.stdout, /RESUME-SCREEN/)
  assert.ok(!calls('worker-start')[0].args.includes('--retry-of'))
  rmSync(logFile)
  setState((s) => { s.dispatch.status = 'failed'; s.tasks[0].status = 'ready' })
  const open = run()
  assert.equal(open.status, 3)
  assert.match(open.stdout, /^RESUME-FAIL target /m)
  assert.equal(calls('terminal', 'create').length, 0)
})

test('settled: abandoned dispatch 를 받고 Task 가 failed 면 --retry-of 를 붙인다', () => {
  setState((s) => { s.dispatch.status = 'abandoned'; s.tasks[0].status = 'failed'; s.terminals = [] })
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /kind=settled/)
  const start = calls('worker-start')[0].args
  assert.equal(start[start.indexOf('--retry-of') + 1], 'ctx_old')
})

test('정상 작업 중인 dispatch, 구조화 worker, 다른 에이전트, 더 새 dispatch, 다른 --run 은 target 에서 거부한다', () => {
  const cases: [string, (s: State) => void, string[]?][] = [
    ['working', (s) => { s.screens.term_old = ['⏺ 고친다.', '✳ Thinking… (4s · esc to interrupt)'] }],
    ['structured', (s) => { s.worker.startOptions.mode.mode = 'structured' }],
    ['cursor', (s) => { s.worker.startOptions.launch.effective.agent = 'cursor' }],
    ['newer', (s) => { s.latest = 'ctx_newer' }],
    ['run', () => {}, ['--dispatch', 'ctx_old', '--run', 'run_b']],
  ]
  for (const [name, patch, args] of cases) {
    setState(patch)
    rmSync(logFile, { force: true })
    const r = run(args)
    assert.equal(r.status, 3, `${name}: ${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /^RESUME-FAIL target /m, name)
    assert.match(r.stdout, /^NEXT /m, name)
    assert.equal(writes().length, 0, name)
  }
})

test('잘못된 --dispatch 는 2 이고 요청 폴더를 만들지 않는다', () => {
  for (const bad of ['../x', '.hidden', '']) {
    const r = run(['--dispatch', bad])
    assert.equal(r.status, 2, bad)
  }
  assert.ok(!existsSync(join(repo, '.orch', 'state', 'resume')))
})

test('find 실패: 새 터미널을 닫고 옛 dispatch 를 건드리지 않는다', () => {
  setState((s) => { s.found = { ok: false, reason: '세션 기록이 없다' } })
  const r = run()
  assert.equal(r.status, 3)
  assert.match(r.stdout, /^RESUME-FAIL find 세션 기록이 없다$/m)
  assert.match(r.stdout, /^NEXT 계정을 옛 worker 의 계정으로 되돌린 뒤 .*worker resume --dispatch ctx_old/m)
  assert.equal(calls('worker-abandon').length, 0)
  const closed = calls('terminal', 'close')
  assert.deepEqual(closed.map((e) => e.args[e.args.indexOf('--terminal') + 1]), ['term_new'])
  assert.ok(existsSync(join(reqDir, 'request.json')), '실패하면 진단을 위해 남긴다')
})

test('cleanup 실패: abandon 이 실패하면 새 터미널을 닫고 go 를 쓰지 않는다', () => {
  setState((s) => { s.fail.abandon = true })
  const r = run()
  assert.equal(r.status, 3)
  assert.match(r.stdout, /^RESUME-FAIL cleanup /m)
  assert.ok(!existsSync(join(reqDir, 'go')))
  assert.deepEqual(calls('terminal', 'close').map((e) => e.args[e.args.indexOf('--terminal') + 1]), ['term_new'])
  assert.equal(calls('worker-start').length, 0)
})

test('cleanup 실패: 옛 터미널 닫기가 실패하면 그 닫기부터 하라는 NEXT 를 낸다', () => {
  setState((s) => { s.fail.close = true })
  const r = run()
  assert.equal(r.status, 3, r.stdout + r.stderr)
  assert.match(r.stdout, /^RESUME-FAIL cleanup 옛 터미널을 닫지 못했다/m)
  assert.match(r.stdout, /^NEXT orca terminal close --terminal term_old && .*worker resume --dispatch ctx_old$/m)
  assert.ok(!existsSync(join(reqDir, 'go')))
  assert.ok(calls('terminal', 'close').some((e) => e.args.includes('term_new')))
})

test('새 터미널을 열지 못하면 find 실패로 옛 dispatch 를 건드리지 않는다', () => {
  setState((s) => { s.fail.create = true })
  const r = run()
  assert.equal(r.status, 3, r.stdout + r.stderr)
  assert.match(r.stdout, /^RESUME-FAIL find 새 터미널을 열지 못했다/m)
  assert.equal(calls('worker-abandon').length, 0)
  assert.equal(calls('terminal', 'close').length, 0)
})

test('start-agent: 화면이 계속 working 이면 닫고 3, error 화면은 통과한다', () => {
  setState((s) => { s.newScreen = ['✳ Thinking… (4s · esc to interrupt)'] })
  const r = run(['--dispatch', 'ctx_old', '--timeout-ms', '2500'])
  assert.equal(r.status, 3, r.stdout + r.stderr)
  assert.match(r.stdout, /^RESUME-FAIL start-agent .*마지막 상태 working/m)
  assert.match(r.stdout, /^ {2}✳ Thinking/m)
  assert.ok(calls('terminal', 'close').some((e) => e.args.includes('term_new')))
  assert.equal(calls('worker-start').length, 0)
})

test('link 실패: 새 터미널을 남기고 worker-start 명령 하나를 낸다. 같은 명령은 잠금으로 거부한다', () => {
  setState((s) => { s.fail.start = true })
  const r = run()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /^RESUME-FAIL link /m)
  assert.match(r.stdout, /^NEXT orca orchestration worker-start --task task_a --terminal term_new --worktree '?path:\S+ --run run_a --json$/m)
  assert.ok(!calls('terminal', 'close').some((e) => e.args.includes('term_new')))
  const again = run()
  assert.equal(again.status, 3)
  assert.match(again.stdout, /^RESUME-FAIL target 앞 실행이 진행 중이거나 결과 터미널 term_new 이 열려 있다/m)
})
