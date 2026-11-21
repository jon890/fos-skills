// loop/takeover.ts 의 worker 옮기기를 임시 저장소, 실제 git 워크트리, 가짜 orca 로 본다. Orca 에는 닿지 않는다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { readLaunch, recordLaunch } from '../scripts/lib/launched.ts'
import { moveWorkers, notifyOldWorkers, oldWorkerReports, pendingRuns, settlePending, writePending } from '../scripts/loop/takeover.ts'

const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_DIR + '/calls.jsonl', JSON.stringify(argv) + '\\n')
const st = JSON.parse(fs.readFileSync(process.env.FAKE_DIR + '/orca.json', 'utf8'))
const say = (v) => process.stdout.write(JSON.stringify(v) + '\\n')
const value = (flag) => argv[argv.indexOf(flag) + 1]
if (argv[0] === 'terminal' && argv[1] === 'list') say({ ok: true, result: { terminals: st.terminals } })
else if (argv[0] === 'terminal' && argv[1] === 'read') say({ ok: true, result: { terminal: { tail: st.screens[value('--terminal')] || [] } } })
else if (argv[1] === 'worker-list') {
  const rows = st.workers[value('--run')]
  if (!rows) { say({ ok: false, error: { code: 'x', message: 'offline' } }); process.exitCode = 1 }
  else say({ ok: true, result: { workers: rows, page: {} } })
}
else if (argv[1] === 'inbox') say({ ok: true, result: { messages: (st.inboxes?.[value('--terminal')] || []).slice(0, Number(value('--limit'))) } })
else if (argv[1] === 'send') say({ ok: true, result: { message: { id: 'msg_1' } } })
else if (argv[1] === 'worker-start' && argv.includes('--help')) process.stdout.write('Usage: worker-start --terminal <handle> --worktree <sel>\\n')
else if (argv[1] === 'worker-abandon') say({ ok: true, result: { dispatch: { id: value('--dispatch'), status: 'abandoned' } } })
else if (argv[1] === 'worker-start') say({ ok: true, result: { dispatch: { id: 'new_' + value('--terminal'), taskId: 'task_new' } } })
else { say({ ok: false, error: { code: 'x', message: argv.join(' ') } }); process.exitCode = 1 }
`

const IDLE = ['⏺ 끝났다.', '───────────────', '❯', '───────────────', '  ⏵⏵ auto mode on']
const WORKING = ['⏺ 고치는 중이다.', '✻ Cooking… (12s · esc to interrupt)']

type Json = Record<string, any>
let tmp: string
let repo: string
const saved = { ORCA: process.env.ORCA, FAKE_DIR: process.env.FAKE_DIR, ORCH_DIR: process.env.ORCH_DIR, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES, BOARD_BIN: process.env.BOARD_BIN }

function git(...args: string[]): void {
  const done = spawnSync('git', ['-C', repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } })
  assert.equal(done.status, 0, String(done.stderr))
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'takeover-')))
  repo = join(tmp, 'repo')
  mkdirSync(repo)
  process.env.GIT_CEILING_DIRECTORIES = tmp
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'init')
  for (const name of ['a', 'b']) git('worktree', 'add', '-q', join(repo, 'worktrees', name), '-b', `feat/${name}`)
  writeFileSync(join(tmp, 'orca'), FAKE_ORCA, { mode: 0o755 })
  process.env.ORCA = join(tmp, 'orca')
  process.env.FAKE_DIR = tmp
  delete process.env.ORCH_DIR
  delete process.env.BOARD_BIN
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const row = (dispatch: string, path: string, handle: string): Json => ({ dispatchId: dispatch, taskId: `task_${dispatch}`, dispatchStatus: 'running', agentTerminalHandle: handle, resource: { worktreeId: `w::${path}` } })

function calls(): string[][] {
  return readFileSync(join(tmp, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function scene(): string {
  const spec = join(tmp, 'spec-a.md')
  writeFileSync(spec, '# a\n브랜치: `feat/a`\n')
  const a = join(repo, 'worktrees', 'a')
  const b = join(repo, 'worktrees', 'b')
  recordLaunch(repo, { dispatch: 'd1', task: 'task_d1', terminal: 'h1', worktree: a, run: 'r_old', spec, branch: 'feat/a' })
  mkdirSync(join(repo, '.omc'), { recursive: true })
  writeFileSync(join(repo, '.omc/board.json'), JSON.stringify({ items: [{ id: 'item-a', status: 'doing', title: 'a', progress: '0/1',
    workers: [{ role: 'impl', dispatch: 'd1', worktree: 'a', branch: 'feat/a', pr: null, status: 'working', at: '2026-11-17T00:00:00Z', endedAt: null }] }] }))
  writeFileSync(join(tmp, 'orca.json'), JSON.stringify({
    terminals: [{ handle: 'h1', agentIdentity: 'claude' }, { handle: 'h2', agentIdentity: 'claude' }, { handle: 'h3', agentIdentity: 'codex' }],
    screens: { h1: IDLE, h2: WORKING, h3: IDLE },
    workers: { r_old: [row('d1', a, 'h1'), row('d2', b, 'h2'), row('d3', join(tmp, 'other', 'wt'), 'h3'), { ...row('d4', a, 'h1'), dispatchStatus: 'completed' }] },
  }))
  return a
}

test('쉬는 worker 는 앞 dispatch 를 끊고 새 Run 에 이어 붙이며, 작업 중이거나 다른 저장소 worker 는 옮기지 않는다', () => {
  const a = scene()
  const moved = moveWorkers(repo, ['r_old'], 'r_new')
  assert.deepEqual(moved.lines, [
    'WORKER-MOVED h1 d1 new_h1',
    'WORKER-NOT-MOVED h2 d2 작업 중(working)',
    `WORKER-OTHER-REPO h3 d3 ${join(tmp, 'other', 'wt')}`,
  ])
  assert.deepEqual(moved.remaining, ['r_old'])
  const all = calls()
  const abandon = all.filter((argv) => argv[1] === 'worker-abandon')
  assert.deepEqual(abandon.map((argv) => argv[argv.indexOf('--dispatch') + 1]), ['d1'])
  const start = all.find((argv) => argv[1] === 'worker-start' && !argv.includes('--help'))!
  assert.equal(start[start.indexOf('--terminal') + 1], 'h1')
  assert.equal(start[start.indexOf('--worktree') + 1], `path:${a}`)
  assert.equal(start[start.indexOf('--run') + 1], 'r_new')
  // 띄우기 기록과 보드의 worker 줄이 새 dispatch 를 가리킨다
  assert.equal(readLaunch(repo, 'd1'), null)
  assert.equal(readLaunch(repo, 'new_h1')?.run, 'r_new')
  const item = (JSON.parse(readFileSync(join(repo, '.omc/board.json'), 'utf8')).items as Json[])[0]
  assert.ok(item.workers.some((w: Json) => w.dispatch === 'new_h1' && w.status === 'working'), JSON.stringify(item.workers))
})

test('지시서를 모르는 worker 는 끊지 않는다', () => {
  scene()
  rmSync(join(tmp, 'spec-a.md'))
  const moved = moveWorkers(repo, ['r_old'], 'r_new')
  assert.equal(moved.lines[0], 'WORKER-NOT-MOVED h1 d1 지시서 모름')
  assert.equal(calls().some((argv) => argv[1] === 'worker-abandon'), false)
})

test('현재 띄우기 기록이 없으면 같은 브랜치와 워크트리의 이전 지시서를 찾는다', () => {
  const a = scene()
  const previous = readLaunch(repo, 'd1')!
  rmSync(join(repo, '.orch/state/launched-workers/d1.json'))
  recordLaunch(repo, { ...previous, dispatch: 'd_before' })
  const moved = moveWorkers(repo, ['r_old'], 'r_new')
  assert.equal(moved.lines[0], 'WORKER-MOVED h1 d1 new_h1')
  assert.equal(readLaunch(repo, 'new_h1')?.spec, previous.spec)
})

test('브랜치나 워크트리가 다른 이전 지시서는 사용하지 않는다', () => {
  scene()
  const previous = readLaunch(repo, 'd1')!
  rmSync(join(repo, '.orch/state/launched-workers/d1.json'))
  recordLaunch(repo, { ...previous, dispatch: 'd_wrong_branch', branch: 'feat/b' })
  recordLaunch(repo, { ...previous, dispatch: 'd_wrong_worktree', worktree: join(repo, 'worktrees', 'b') })
  assert.equal(moveWorkers(repo, ['r_old'], 'r_new').lines[0], 'WORKER-NOT-MOVED h1 d1 지시서 모름')
  assert.ok(!calls().some(argv => argv[1] === 'worker-abandon'))
})

test('옛 Run 에 남은 worker 의 마지막 보고를 보여 주고 새 메인에 바뀐 보고만 알린다', () => {
  scene()
  const moved = moveWorkers(repo, ['r_old'], 'r_new')
  settlePending(repo, ['r_old'], moved.remaining, moved.workers)
  const file = join(tmp, 'orca.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  // 마무리 직후에도 옛 Run 에 남은 완료 보고를 읽는다.
  state.workers.r_old = state.workers.r_old.filter((worker: Json) => worker.dispatchId !== 'd1')
  state.workers.r_old[0].dispatchStatus = 'completed'
  state.inboxes = { 'run:r_old': [
    ...Array.from({ length: 200 }, () => ({ type: 'status', dispatch_id: 'd3', body: '다른 저장소' })),
    { type: 'escalation', dispatch_id: 'd2', payload: { stopReason: 'finished' }, body: 'Orca 가 만든 대기 알림' },
    { type: 'heartbeat', dispatch_id: 'd2', body: '보고가 아님' },
    { id: 'msg_done', type: 'worker_done', payload: { dispatchId: 'd2' }, body: '준비됨 #42' },
    { type: 'status', dispatch_id: 'd2', body: '오래된 보고' },
  ] }
  writeFileSync(file, JSON.stringify(state))
  const report = oldWorkerReports(repo)
  assert.deepEqual(report.errors, [])
  assert.equal(report.lines.length, 1)
  assert.match(report.lines[0], /^OLD-RUN-WORKER run=r_old dispatch=d2 worktree=.*\/b" 마지막 보고=worker_done msg_done 준비됨 #42$/)
  assert.deepEqual(notifyOldWorkers(repo, 'r_new'), [])
  assert.deepEqual(notifyOldWorkers(repo, 'r_new'), [])
  assert.equal(calls().filter(argv => argv[1] === 'send').length, 1)
  state.inboxes['run:r_old'].unshift({ id: 'msg_ready', type: 'status', from_handle: 'h2', body: '새 보고' })
  writeFileSync(file, JSON.stringify(state))
  assert.deepEqual(notifyOldWorkers(repo, 'r_new'), [])
  const sends = calls().filter(argv => argv[1] === 'send')
  assert.equal(sends.length, 2)
  assert.equal(sends[1][sends[1].indexOf('--to') + 1], 'run:r_new')
  assert.match(sends[1][sends[1].indexOf('--body') + 1], /msg_ready 새 보고/)
  // 같은 터미널을 앞 dispatch 가 썼다면 id 가 빠진 보고를 어느 쪽에도 붙이지 않는다.
  state.workers.r_old.push({ ...row('d_before', join(repo, 'worktrees', 'b'), 'h2'), dispatchStatus: 'completed' })
  writeFileSync(file, JSON.stringify(state))
  assert.match(oldWorkerReports(repo).lines[0], /worker_done msg_done 준비됨 #42$/)
  assert.ok(!calls().some(argv => argv[1] === 'check'))
})

test('앞 Run 의 worker 목록을 읽지 못하면 그 Run 을 남겨 다시 옮긴다', () => {
  scene()
  writePending(repo, ['r_gone', 'r_keep'])
  const moved = moveWorkers(repo, ['r_gone'], 'r_new')
  assert.match(moved.lines[0], /^WORKER-LIST-FAIL r_gone /)
  settlePending(repo, ['r_gone'], moved.remaining)
  assert.deepEqual(pendingRuns(repo).sort(), ['r_gone', 'r_keep'])
  settlePending(repo, ['r_gone'], [])
  assert.deepEqual(pendingRuns(repo), ['r_keep'])
  assert.equal(existsSync(join(repo, '.orch/state/takeover.json')), true)
})
