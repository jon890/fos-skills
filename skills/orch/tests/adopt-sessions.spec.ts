// 가짜 Orca 와 임시 git 저장소로 발견, 읽기 전용 기본값, 명시적 재연결 경계를 검증한다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { orchWord } from '../scripts/lib/commands.ts'
import { activeHandles, handover, matchingSpecs } from '../scripts/lib/sessions.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin, FakeRule } from './fixtures/fake-bin.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/worker/adopt-sessions.ts', import.meta.url))
const envelope = (result: unknown) => JSON.stringify({ ok: true, result })
let root: string, repo: string, worktree: string, spec: string, orca: FakeBin, gh: FakeBin
let rules: FakeRule[]
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'adopt-sessions-')))
  repo = join(root, 'my repo'); mkdirSync(repo)
  const git = (...args: string[]) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr) }
  git('init', '-b', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial')
  worktree = join(repo, 'worktrees', 'my repo', 'old')
  git('worktree', 'add', '-b', 'feat/old', worktree)
  mkdirSync(join(repo, '.orch', 'specs'), { recursive: true })
  spec = join(repo, '.orch', 'specs', 'old.md')
  writeFileSync(spec, '브랜치: `feat/old`\n허락: 커밋과 push.\n')
  rules = [
    { args: ['terminal', 'list'], stdout: envelope({ terminals: [
      { handle: 'term_live', worktreePath: worktree, agentIdentity: 'codex' },
      { handle: 'term_old', worktreePath: worktree, agentIdentity: 'claude' },
      { handle: 'term_human', worktreePath: worktree, agentIdentity: null },
      { handle: 'term_other', worktreePath: join(root, 'other'), agentIdentity: 'codex' },
    ] }) },
    { args: ['worker-list'], stdout: envelope({ scope: { source: 'all' }, workers: [
      { agentTerminalHandle: 'term_live', dispatchStatus: 'running', dispatchId: 'ctx_live' },
      { agentTerminalHandle: 'term_old', dispatchStatus: 'failed', dispatchId: 'ctx_failed', taskId: 'task_old' },
    ] }) },
    { args: ['terminal', 'read'], stdout: envelope({ terminal: { source: 'screen', tail: ['승인 대기', '❯'] } }) },
    { args: ['worker-start', '--help'], stdout: 'worker-start --terminal HANDLE --worktree SELECTOR' },
    { args: ['worker-start'], stdout: envelope({ dispatchId: 'ctx_new', taskId: 'task_new' }) },
  ]
  orca = fakeBin(root, 'orca', rules)
  gh = fakeBin(root, 'gh', [{ stdout: JSON.stringify([{ number: 8, url: 'https://example.com/pr/8', headRefName: 'feat/old' }]) }])
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH}`
function run(args: string[] = []) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, ...args], {
    encoding: 'utf8', env: { ...process.env, ORCA: orca.path, GH: gh.path, CLAUDE_CONFIG_DIR: join(root, 'config'),
      PATH, ORCH_GH_CACHE: '0' },
  })
}
test('살아 있는 dispatch, 끝난 dispatch, 사람 셸을 구분하고 기본 실행은 읽기만 한다', () => {
  const r = run(['--json'])
  assert.equal(r.status, 0, r.stderr)
  const sessions = JSON.parse(r.stdout).sessions
  assert.deepEqual(sessions.map((s: { terminal: string }) => s.terminal), ['term_old', 'term_human'])
  assert.equal(sessions[0].branch, 'feat/old'); assert.equal(sessions[0].state, 'idle')
  assert.deepEqual(sessions[0].specs, [spec]); assert.equal(sessions[0].prs[0].number, 8)
  assert.equal(sessions[0].previous[0].dispatch, 'ctx_failed')
  assert.ok(orca.calls().every((c) => ['list', 'read', 'worker-list'].includes(c.argv[1])))
})
test('짧은 출력의 SESSION 은 상태, 브랜치, 지시서 후보를 한 줄로 내고 JSON 을 내지 않는다', () => {
  process.env.ORCH_OUTPUT = 'short'
  try {
    const r = run([])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`^SESSION term_old idle feat/old specs=${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.doesNotMatch(r.stdout, /[{}]/)
  } finally {
    delete process.env.ORCH_OUTPUT
  }
})
test('브랜치 줄로만 지시서를 짝짓고 resource handle 의 살아 있는 dispatch 도 제외한다', () => {
  writeFileSync(join(dirname(spec), 'spec-old.md'), '브랜치: `feat/other`\n')
  assert.deepEqual(matchingSpecs(dirname(spec), 'feat/old'), [spec])
  assert.deepEqual([...activeHandles([{ dispatchStatus: 'pending', resource: { terminalHandle: 'term_resource' } }, { dispatchStatus: 'failed', agentTerminalHandle: 'term_dead' }])], ['term_resource'])
})
test('apply 만 기존 에이전트 터미널과 정확한 워크트리를 새 Run 에 연결한다', () => {
  const r = run(['--apply', 'term_old', '--run', 'run_new'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /ADOPTED term_old/)
  const calls = orca.calls().filter((c) => c.argv.includes('worker-start') && !c.argv.includes('--help'))
  assert.equal(calls.length, 1)
  const args = calls[0].argv
  assert.equal(args[args.indexOf('--terminal') + 1], 'term_old')
  assert.equal(args[args.indexOf('--worktree') + 1], `path:${worktree}`)
  assert.equal(args[args.indexOf('--run') + 1], 'run_new')
  assert.ok(!args.includes('--model') && !args.includes('--agent'))
  const handoverPath = /^ADOPTED term_old (.+)$/m.exec(r.stdout)![1]
  assert.match(readFileSync(handoverPath, 'utf8'), /ctx_failed|승인 대기/)
  rmSync(dirname(handoverPath), { recursive: true })
})
test('사람 셸, 살아 있는 worker, 잘못된 지시서, Run 누락은 연결하지 않는다', () => {
  for (const args of [ ['--apply', 'term_human', '--run', 'r'], ['--apply', 'term_live', '--run', 'r'], ['--apply', 'term_old', '--run', 'r', '--spec', '/missing.md'], ['--apply', 'term_old'] ]) {
    assert.notEqual(run(args).status, 0)
  }
  assert.ok(!orca.calls().some((c) => c.argv.includes('worker-start')))
})
test('다른 Run 의 살아 있는 dispatch 와 둘째 페이지의 worker 도 가져오지 않는다', () => {
  orca.setRules([
    { args: ['worker-list', '--run', 'run_old', '--cursor', 'page2'], stdout: envelope({ scope: { source: 'flag' }, workers: [{ dispatchStatus: 'running', resource: { terminalHandle: 'term_old' } }] }) },
    { args: ['worker-list', '--run', 'run_old'], stdout: envelope({ scope: { source: 'flag' }, workers: [], page: { nextCursor: 'page2' } }) },
    { args: ['worker-list'], stdout: envelope({ scope: { source: 'bound' }, workers: [] }) },
    { args: ['run-list'], stdout: envelope({ runs: [{ id: 'run_old' }] }) }, ...rules,
  ])
  const r = run(['--json'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!JSON.parse(r.stdout).sessions.some((s: { terminal: string }) => s.terminal === 'term_old'))
})
test('apply 직전에 다른 dispatch 가 생기면 재검증으로 멈춘다', () => {
  const original = orca.path
  const wrapper = join(root, 'racy-orca')
  const counter = join(root, 'count')
  writeFileSync(wrapper, `#!/usr/bin/env node
const fs = require('node:fs')
const cp = require('node:child_process')
const args = process.argv.slice(2)
let output = cp.execFileSync(${JSON.stringify(original)}, args, { encoding: 'utf8' })
if (args.includes('worker-list')) {
  const count = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1 : 1
  fs.writeFileSync(${JSON.stringify(counter)}, String(count))
  if (count > 1) {
    const result = JSON.parse(output)
    result.result.workers.push({ agentTerminalHandle: 'term_old', dispatchStatus: 'running' })
    output = JSON.stringify(result)
  }
}
process.stdout.write(output)
`)
  chmodSync(wrapper, 0o755)
  orca = { ...orca, path: wrapper }
  assert.equal(run(['--apply', 'term_old', '--run', 'r']).status, 3)
  assert.ok(!orca.calls().some((c) => c.argv.includes('worker-start')))
})
test('작업/권한/초안 화면과 잘린 터미널 목록, 조회 실패는 안전하게 거부한다', () => {
  for (const tail of [['• Working (2s)'], ['Do you want to proceed?'], ['❯ draft']]) {
    orca.setRules([{ args: ['read'], stdout: envelope({ terminal: { tail } }) }, ...rules])
    assert.equal(run(['--apply', 'term_old', '--run', 'r']).status, 3)
  }
  orca.setRules([{ args: ['terminal', 'list'], stdout: envelope({ terminals: [], truncated: true }) }, ...rules])
  assert.equal(run().status, 1)
  orca.setRules([{ args: ['worker-list'], code: 1 }, ...rules])
  assert.equal(run().status, 1)
  assert.ok(!orca.calls().some((c) => c.argv.includes('worker-start')))
})
test('기능이 없는 CLI 는 이어받기 뼈대와 안내만 만들고 닫거나 입력하지 않는다', () => {
  orca.setRules([{ args: ['worker-start', '--help'], stdout: 'old CLI' }, ...rules])
  const r = run(['--apply', 'term_old', '--run', 'r'])
  assert.equal(r.status, 3, r.stderr)
  const file = /^ADOPT-MANUAL (.+)$/m.exec(r.stdout)![1]
  assert.match(readFileSync(file, 'utf8'), /feat\/old/)
  rmSync(dirname(file), { recursive: true })
  assert.ok(!orca.calls().some((c) => c.argv.includes('close') || c.argv.includes('send') || (c.argv.includes('worker-start') && !c.argv.includes('--help'))))
})
test('worker-start 실패는 receipt 를 보존하고 자동 재시도하지 않는다', () => {
  orca.setRules([
    rules[3],
    { args: ['worker-start'], code: 1, stdout: JSON.stringify({ ok: false, result: { stage: 'outcome_unknown', residualResources: { terminal: 'term_old' }, requestId: 'request_test' } }) },
    ...rules,
  ])
  const r = run(['--apply', 'term_old', '--run', 'r'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /outcome_unknown.*residualResources.*request_test/)
  assert.equal(orca.calls().filter((call) => call.argv.includes('worker-start') && !call.argv.includes('--help')).length, 1)
  const file = /이어받기 지시서: (.+)\. 자동/.exec(r.stderr)![1]
  rmSync(dirname(file), { recursive: true })
})
test('이어받기 문서의 화면 백틱이 코드 블록을 깨지 않는다', () => {
  const doc = handover({ terminal: 'term_x', worktree, branch: 'feat/old', agent: 'codex', state: 'idle', lines: ['```', '기록'], specs: [], prs: [], previous: [] }, null)
  assert.match(doc, /````\n```\n기록\n````/)
})
test('살아 있는 dispatch 의 화면이 사용 한도 안내면 LIMITED 와 다시 띄울 명령을 낸다', () => {
  const live = { agentTerminalHandle: 'term_live', dispatchStatus: 'running', dispatchId: 'ctx_live', taskId: 'task_live', runId: 'run_a',
    resource: { worktreeId: `ws::${worktree}`, terminalHandle: 'term_live' }, projection: { provider: { id: 'claude', model: 'claude-opus-5-5' } } }
  orca.setRules([
    { args: ['worker-list'], stdout: envelope({ scope: { source: 'all' }, workers: [live] }) },
    { args: ['terminal', 'read', '--terminal', 'term_live'], stdout: envelope({ terminal: { source: 'screen', tail: ["⎿ You've hit your weekly limit · resets 9am", '❯'] } }) },
    ...rules,
  ])
  const r = run()
  assert.equal(r.status, 0, r.stderr)
  const out = r.stdout.split('\n')
  const at = out.indexOf(`LIMITED term_live dispatch=ctx_live task=task_live run=run_a branch=feat/old`)
  assert.ok(at >= 0, r.stdout)
  assert.equal(out[at + 1], `  ${orchWord(PATH)} worker resume --dispatch ctx_live`)
  assert.ok(!out[at + 2]?.startsWith('  '), '들여 쓴 명령 줄은 하나다')
  // 한도 안내가 없거나 작업 중이면 내지 않는다
  for (const tail of [['⏺ 고친다.', '❯'], ['Usage limit reached', '✳ Thinking… (4s · esc to interrupt)']]) {
    orca.setRules([
      { args: ['worker-list'], stdout: envelope({ scope: { source: 'all' }, workers: [live] }) },
      { args: ['terminal', 'read', '--terminal', 'term_live'], stdout: envelope({ terminal: { source: 'screen', tail } }) },
      ...rules,
    ])
    const quiet = run(['--json'])
    assert.equal(quiet.status, 0, quiet.stderr)
    assert.deepEqual(JSON.parse(quiet.stdout).limited, [], tail.join('/'))
  }
  assert.ok(!orca.calls().some((c) => c.argv.includes('worker-abandon') || c.argv.includes('close') || (c.argv.includes('worker-start') && !c.argv.includes('--help'))))
})
test('Task 가 ready 이고 마지막 dispatch 가 failed 면 RESTART 와 --retry-of 없는 명령을 낸다', () => {
  const failed = { agentTerminalHandle: 'term_gone', dispatchStatus: 'failed', dispatchId: 'ctx_f2', taskId: 'task_r', runId: 'run_a',
    resource: { worktreeId: `ws::${worktree}` }, projection: { provider: { id: 'codex', model: 'gpt-6.1-sol' } } }
  const older = { ...failed, dispatchId: 'ctx_f1' }
  const other = { ...failed, dispatchId: 'ctx_x', taskId: 'task_blocked' }
  const workers = [older, failed, other]
  orca.setRules([
    { args: ['worker-list'], stdout: envelope({ scope: { source: 'all' }, workers }) },
    { args: ['task-list', '--run', 'run_a'], stdout: envelope({ tasks: [{ id: 'task_r', status: 'ready' }, { id: 'task_blocked', status: 'failed' }] }) },
    { args: ['dispatch-show', '--task', 'task_r'], stdout: envelope({ dispatch: { id: 'ctx_f2', status: 'failed' } }) },
    ...rules,
  ])
  const r = run(['--json'])
  assert.equal(r.status, 0, r.stderr)
  const found = JSON.parse(r.stdout).restartable
  assert.equal(found.length, 1, r.stdout)
  assert.equal(found[0].dispatch, 'ctx_f2')
  assert.deepEqual(found[0].commands, [`${orchWord(PATH)} worker resume --dispatch ctx_f2`])
  assert.equal(orca.calls().filter((c) => c.argv.includes('task-list')).length, 1)
  // 같은 Task 에 살아 있는 dispatch 가 있으면 다시 띄우지 않는다
  orca.setRules([
    { args: ['worker-list'], stdout: envelope({ scope: { source: 'all' }, workers: [failed, { ...failed, dispatchId: 'ctx_live2', dispatchStatus: 'running' }] }) },
    ...rules,
  ])
  const text = run()
  assert.equal(text.status, 0, text.stderr)
  assert.doesNotMatch(text.stdout, /^RESTART/m)
  // 마지막 failed dispatch 의 터미널이 열려 있으면 resume 한 세션과 겹치므로 내지 않는다
  orca.setRules([
    { args: ['terminal', 'list'], stdout: envelope({ terminals: [{ handle: 'term_gone', worktreePath: worktree, agentIdentity: 'codex' }] }) },
    { args: ['worker-list'], stdout: envelope({ scope: { source: 'all' }, workers }) },
    { args: ['task-list', '--run', 'run_a'], stdout: envelope({ tasks: [{ id: 'task_r', status: 'ready' }] }) },
    { args: ['dispatch-show', '--task', 'task_r'], stdout: envelope({ dispatch: { id: 'ctx_f2', status: 'failed' } }) },
    ...rules,
  ])
  const open = run(['--json'])
  assert.equal(open.status, 0, open.stderr)
  assert.deepEqual(JSON.parse(open.stdout).restartable, [])
})
