// 임시 저장소와 가짜 Orca 로 실제 명령 경계의 거절·우회·기존 기록 호환을 본다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { guardWrite, mainDoctorLines } from '../scripts/lib/main-guard.ts'
import { allLaunches, forgetLaunch, readLaunch, recordLaunch } from '../scripts/lib/launched.ts'
import { registerRun } from '../scripts/lib/loop.ts'
import { pathOf } from '../scripts/lib/paths.ts'
import { withRun } from '../scripts/lib/proc.ts'
import type { RunResult } from '../scripts/lib/proc.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-main-guard-')))
const source = fileURLToPath(new URL('..', import.meta.url))
const originalEnv = { ...process.env }
const orca = join(root, 'orca')
const state = join(root, 'state.json')
const log = join(root, 'calls.jsonl')
writeFileSync(orca, `#!/usr/bin/env node
const fs = require('node:fs')
const a = process.argv.slice(2)
const s = JSON.parse(fs.readFileSync(process.env.GUARD_STATE, 'utf8'))
fs.appendFileSync(process.env.GUARD_LOG, JSON.stringify(a) + '\\n')
if (a[1] === 'worker-show' && s.showFailOnce) { s.showFailOnce = false; fs.writeFileSync(process.env.GUARD_STATE, JSON.stringify(s)); fs.writeSync(1, JSON.stringify({ ok: false, error: 'transient' })); process.exit(1) }
let result = {}
if (a[1] === 'run-list') result = { runs: [{ id: 'main', coordinator_handle: 'tm' }, { id: 'other', coordinator_handle: 'to' }] }
else if (a[0] === 'terminal' && a[1] === 'list') result = { terminals: [{ handle: 'tm', agentIdentity: 'codex' }, { handle: 'to', agentIdentity: 'codex' }] }
else if (a[1] === 'run-current') result = { run: s.caller === null ? null : { id: s.caller } }
else if (a[1] === 'send') result = { message: { id: 'notice' } }
else if (a[1] === 'worker-show') result = { dispatch: { id: 'old', runId: 'other', status: 'running' }, worker: { worktreeId: s.worktree, agentTerminalHandle: 'tw' } }
if (s.offline || s.fail === a[1]) { fs.writeSync(1, JSON.stringify({ ok: false, error: 'fake failure' })); process.exit(1) }
fs.writeSync(1, JSON.stringify({ ok: true, result }))
`)
chmodSync(orca, 0o755)
let repo: string
let counter = 0
const settings = (extra: Record<string, unknown> = {}) => writeFileSync(state, JSON.stringify({ caller: 'other', worktree: repo, ...extra }))
const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]) : []
const result = (data: unknown, code = 0): RunResult => ({ code, stdout: JSON.stringify(data), stderr: '', timedOut: false })

beforeEach(() => {
  repo = join(root, `repo-${counter++}`)
  mkdirSync(repo)
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
  registerRun(repo, 'main', null, false, 'tm', '2026-11-17T00:00:00Z')
  registerRun(repo, 'other', null, false, 'to', '2026-11-17T01:00:00Z')
  settings()
  writeFileSync(log, '')
  process.env.ORCA_TERMINAL_HANDLE = 'bound-coordinator'
  process.env.ORCA = orca
  process.env.GUARD_STATE = state
  process.env.GUARD_LOG = log
})
after(() => { process.env = originalEnv; rmSync(root, { recursive: true, force: true }) })

function cli(script: string, args: string[]) {
  return spawnSync(process.execPath, [join(source, 'scripts', script), ...args], { encoding: 'utf8', env: process.env, timeout: 20_000 })
}

test('다른 Run 의 쓰기는 메인과 요청 명령을 알리고 쓰기 없이 거절한다', () => {
  const gate = guardWrite(repo, 'worker launch', undefined)
  assert.equal(gate.code, 1)
  assert.equal(calls().some(a => a[1] === 'send'), false)
  assert.deepEqual(allLaunches(repo), [])
})

test('메인과 Run 없는 사람 셸은 통과하며 메인 조회 실패도 사람 셸은 막지 않는다', () => {
  for (const caller of ['main', null]) {
    settings({ caller })
    assert.equal(guardWrite(repo, 'board set', undefined).code, 0)
  }
  settings({ caller: null, fail: 'run-list' })
  assert.equal(guardWrite(repo, 'board set', undefined).code, 0)
})

test('등록 없는 저장소는 Orca 조회 없이 허용하고 새 기록 표지의 main 은 null 이다', () => {
  const empty = join(root, 'empty')
  mkdirSync(empty, { recursive: true })
  const gate = guardWrite(empty, 'worker launch', undefined)
  assert.equal(gate.code, 0)
  if (gate.code === 0) assert.equal(gate.stamp.main, null)
  assert.deepEqual(calls(), [])
})

test('Run 이 묶인 세션의 메인 조회 실패와 호출자 조회 실패는 쓰기를 막는다', () => {
  settings({ fail: 'run-list' })
  assert.equal(guardWrite(repo, 'board set', undefined).code, 1)
  settings({ fail: 'run-current' })
  assert.equal(guardWrite(repo, 'board set', undefined).code, 1)
})

test('Orca 가 꺼져도 터미널 handle 없는 사람 셸의 쓰기는 통과한다', () => {
  delete process.env.ORCA_TERMINAL_HANDLE
  settings({ offline: true })
  assert.equal(guardWrite(repo, 'board set', undefined).code, 0)
  assert.equal(guardWrite(repo, 'board set', '복구 작업').code, 0)
  const board = join(repo, '.omc', 'board.json')
  mkdirSync(dirname(board), { recursive: true })
  writeFileSync(board, JSON.stringify({ items: [{ id: 'item', title: '일', status: 'wait', details: [], next: [] }] }))
  const done = cli('board/board-edit.ts', ['set', 'item', 'done', '--repo', repo])
  assert.equal(done.status, 0, done.stderr)
  assert.equal(JSON.parse(readFileSync(board, 'utf8')).items[0].status, 'done')
})

test('공백 이유와 다음 옵션을 이유로 준 우회는 거절한다', () => {
  for (const reason of ['', '   ', '--repo']) assert.equal(guardWrite(repo, 'board set', reason).code, 2)
  assert.deepEqual(calls(), [])
})

test('우회는 가짜 dispatch 없이 이유를 저장하고 메인 Run 에 알린다', () => {
  const gate = guardWrite(repo, 'board set', '긴급 복구')
  assert.equal(gate.code, 0)
  const dir = join(pathOf('state', repo), 'launched-workers', 'not-main')
  const files = readdirSync(dir)
  assert.equal(files.length, 1)
  const saved = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
  assert.deepEqual({ ...saved, at: null }, { repo, caller_run: 'other', main_run: 'main', command: 'board set', reason: '긴급 복구', at: null, notified: true })
  assert.ok(Number.isFinite(Date.parse(saved.at)))
  assert.deepEqual(allLaunches(repo), [])
  const sent = calls().find(a => a[1] === 'send')!
  assert.ok(sent.includes('run:main'))
  assert.match(sent[sent.indexOf('--body') + 1], /긴급 복구/)
})

test('메인에게 알림을 보내지 못하면 기록을 남기고 쓰기는 거절한다', () => {
  settings({ fail: 'send' })
  assert.equal(guardWrite(repo, 'queue merge', '복구').code, 1)
  const dir = join(pathOf('state', repo), 'launched-workers', 'not-main')
  assert.equal(JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')).notified, false)
})

function launch(dispatch: string, run = 'other', main?: string | null) {
  recordLaunch(repo, { dispatch, terminal: 'tw', worktree: repo, branch: dispatch, run, spec: join(repo, 'spec.md'),
    ...(main === undefined ? {} : { main_guard: { version: 1, main, caller_repo: root, target_repo: repo } }) })
}

test('옛 worker 와 메인 없을 때 띄운 worker 의 원래 Run 만 지시·정리할 수 있다', () => {
  launch('old')
  assert.equal(guardWrite(repo, 'worker send', undefined, { dispatch: 'old' }).code, 0)
  assert.equal(guardWrite(repo, 'cleanup worktree', undefined, { worktree: repo }).code, 0)
  launch('bootstrap', 'other', null)
  assert.equal(guardWrite(repo, 'worker send', undefined, { dispatch: 'bootstrap' }).code, 0)
  launch('someone', 'someone')
  assert.equal(guardWrite(repo, 'worker send', undefined, { dispatch: 'someone' }).code, 1)
  launch('new', 'other', 'main')
  assert.equal(guardWrite(repo, 'worker send', undefined, { dispatch: 'new' }).code, 1)
})

test('worker 예외는 보드 쓰기와 새 worker 생성 권한이 되지 않는다', () => {
  launch('old')
  assert.equal(guardWrite(repo, 'board set', undefined).code, 1)
  assert.equal(guardWrite(repo, 'worker launch', undefined).code, 1)
  const gate = guardWrite(repo, 'cleanup sweep', undefined, { sweepRun: 'other' })
  assert.equal(gate.code, 0)
  if (gate.code === 0) assert.deepEqual([...gate.worktrees!], [repo])
  assert.equal(guardWrite(repo, 'cleanup sweep', undefined, { sweepRun: 'main' }).code, 1)
})

test('PR 예외는 지정한 모든 PR 의 브랜치가 원래 Run worker 여야 한다', async () => {
  launch('owned')
  const runner = (argv: string[]) => argv[0] === 'gh'
    ? result({ headRefName: argv[3] === '1' ? 'owned' : 'foreign' })
    : (() => { const done = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' }); return { code: done.status ?? 1, stdout: done.stdout, stderr: done.stderr, timedOut: false } })()
  await withRun(runner, () => {
    assert.equal(guardWrite(repo, 'queue merge', undefined, { prs: [1] }).code, 0)
    assert.equal(guardWrite(repo, 'queue merge', undefined, { prs: [1, 2] }).code, 1)
  })
})

test('실제 보드 명령은 --run 사칭 대신 실제 호출 Run 을 보고 읽기는 통과한다', () => {
  const denied = cli('board/board-edit.ts', ['set', 'item', 'doing', '--repo', repo])
  assert.equal(denied.status, 1, denied.stderr)
  assert.match(denied.stderr, /NOT-MAIN main=main caller=other/)
  assert.match(denied.stderr, /orch request send --to/)
  const request = cli('request/orch-request.ts', ['accept', '--id', 'R1', '--run', 'main', '--repo', repo])
  assert.equal(request.status, 1, request.stderr)
  assert.match(request.stderr, /caller=other/)
  const read = cli('board/board-edit.ts', ['list', '--repo', repo])
  assert.doesNotMatch(read.stderr, /NOT-MAIN/)
  assert.equal(calls().some(a => a[1] === 'send'), false)
})

test('직접 스크립트의 빈 우회·이유 없는 우회와 help 는 사용법 경계를 지킨다', () => {
  for (const args of [['--not-main'], ['--not-main='], ['--not-main', '   ']]) {
    assert.equal(cli('board/board-edit.ts', ['set', 'item', 'doing', '--repo', repo, ...args]).status, 2)
  }
  const help = cli('board/board-edit.ts', ['--help'])
  assert.equal(help.status, 0)
  assert.doesNotMatch(help.stderr, /NOT-MAIN/)
})

test('worker·큐·정리·보드 쓰기의 실제 진입점은 부수 효과 전에 거절한다', () => {
  const spec = join(repo, 'spec.md')
  writeFileSync(spec, '# 테스트\n브랜치: `feat/test`\n허락: 고치기\n')
  const cases: [string, string[]][] = [
    ['worker/launch-worker.ts', ['--repo', repo, '--name', 'test', '--spec', spec]],
    ['worker/make-worktree.ts', ['--repo', repo, '--name', 'test', '--spec', spec]],
    ['worker/send-to-worker.ts', ['--dispatch', 'old', '--body', '지시']],
    ['worker/continue-worker.ts', ['--repo', repo, '--dispatch', 'old']],
    ['worker/resume-worker.ts', ['--repo', repo, '--dispatch', 'old']],
    ['worker/adopt-sessions.ts', ['--repo', repo, '--apply', 'tw', '--run', 'other']],
    ['queue/merge-with-finish.ts', ['--repo', repo, '123']],
    ['queue/merge_queue.ts', ['--repo', repo, '123']],
    ['queue/finish-pr.ts', ['--repo', repo, '123']],
    ['queue/ci-ready.ts', ['--repo', repo, '123']],
    ['queue/notify-conflicts.ts', ['--repo', repo]],
    ['queue/reserve-migration.ts', ['--repo', repo, '--prune']],
    ['cleanup/cleanup-sweep.ts', ['--repo', repo, '--apply']],
    ['cleanup/remove-worktree.ts', [repo]],
    ['cleanup/handoff-cleanup.ts', ['--repo', repo, '--apply']],
    ['board/board-sync.ts', ['--repo', repo]],
    ['board/board-release.ts', ['--repo', repo, '--pr', '123']],
    ['board/board-approval.ts', ['add', 'id', '--repo', repo]],
  ]
  for (const [script, args] of cases) {
    const done = cli(script, args)
    assert.equal(done.status, 1, `${script}\n${done.stderr}\n${done.stdout}`)
    assert.match(done.stderr, /NOT-MAIN main=main caller=other/, script)
  }
  assert.equal(calls().some(a => ['send', 'worker-start', 'reply', 'close', 'release'].includes(a[1])), false)
  assert.deepEqual(allLaunches(repo), [])
})

test('새 CLI 와 옛 CLI 이름도 같은 스크립트에서 거절한다', () => {
  const entry = join(source, 'bin', 'orch.ts')
  for (const args of [['board', 'set'], ['board-edit', 'set']]) {
    const done = spawnSync(process.execPath, [entry, ...args, 'id', 'doing', '--repo', repo], {
      encoding: 'utf8', env: { ...process.env, ORCH_SCRIPTS_DIR: join(source, 'scripts') }, timeout: 20_000,
    })
    assert.equal(done.status, 1, done.stderr)
    assert.match(done.stderr, /NOT-MAIN main=main caller=other/)
  }
})

test('doctor 는 Run 옵션 없이 비메인 등록과 옛·다른 저장소 worker 의 경로를 알린다', () => {
  launch('old')
  launch('cross', 'main', null)
  const lines = mainDoctorLines(repo).join('\n')
  assert.match(lines, /NON-MAIN-RUN other main=main/)
  assert.match(lines, /FOREIGN-WORKER old run=other/)
  assert.match(lines, /FOREIGN-WORKER cross run=main/)
  assert.ok(lines.includes(`worktree=${repo} spec=${join(repo, 'spec.md')}`))
  forgetLaunch(repo, 'old')
  assert.doesNotMatch(mainDoctorLines(repo).join('\n'), /FOREIGN-WORKER old /)
  settings({ fail: 'run-list' })
  assert.match(mainDoctorLines(repo).join('\n'), /SKIP-MAIN/)
})

test('명시한 repo 보다 실제 dispatch 대상과 명시·설정 보드의 소유 저장소를 검사한다', () => {
  const other = join(root, 'other-repo')
  mkdirSync(other, { recursive: true })
  assert.equal(spawnSync('git', ['init', '-q', other]).status, 0)
  launch('old', 'main', 'main')
  for (const script of ['worker/resume-worker.ts', 'worker/continue-worker.ts']) {
    const done = cli(script, ['--repo', other, '--dispatch', 'old'])
    assert.equal(done.status, 1, done.stderr + done.stdout)
    assert.match(done.stderr, /NOT-MAIN main=main caller=other/)
  }
  const board = join(repo, '.omc', 'board.json')
  const explicit = cli('board/board-edit.ts', ['set', 'id', 'doing', '--repo', other, '--board', board])
  assert.equal(explicit.status, 1)
  assert.match(explicit.stderr, /NOT-MAIN main=main/)
  mkdirSync(join(other, '.orch'), { recursive: true })
  writeFileSync(join(other, '.orch', 'config.json'), JSON.stringify({ finish: { board } }))
  const configured = cli('board/board-edit.ts', ['set', 'id', 'doing', '--repo', other])
  assert.equal(configured.status, 1)
  assert.match(configured.stderr, /NOT-MAIN main=main/)
})

test('worker-show 의 첫 조회가 실패하면 repo 로 대신하지 않고 재개를 거절한다', () => {
  settings({ showFailOnce: true })
  const done = cli('worker/resume-worker.ts', ['--repo', root, '--dispatch', 'old'])
  assert.equal(done.status, 1)
  assert.match(done.stderr, /MAIN-TARGET-UNKNOWN/)
  assert.equal(calls().filter(a => a[1] === 'worker-show').length, 1)
  assert.equal(calls().some(a => ['worker-start', 'create', 'close'].includes(a[1])), false)
})

test('깨진 최신 main_guard 표지가 같은 워크트리의 옛 소유 예외를 되살리지 않는다', () => {
  launch('old')
  const file = join(pathOf('state', repo), 'launched-workers', 'newer.json')
  writeFileSync(file, JSON.stringify({ dispatch: 'newer', worktree: repo, run: 'other', main_guard: { version: 1 } }))
  assert.equal(readLaunch(repo, 'newer')?.invalid_main_guard, true)
  assert.equal(guardWrite(repo, 'cleanup worktree', undefined, { worktree: repo }).code, 1)
  assert.equal(guardWrite(repo, 'worker send', undefined, { dispatch: 'newer' }).code, 1)
})

test('띄우기 기록의 표지와 우회 이유는 다시 읽어도 보존된다', () => {
  const stamp = { version: 1 as const, main: 'main', caller_repo: root, target_repo: repo }
  recordLaunch(repo, { dispatch: 'd', run: 'other', terminal: null, worktree: repo, main_guard: stamp, not_main: '승인받은 복구' })
  assert.deepEqual(readLaunch(repo, 'd')?.main_guard, stamp)
  assert.equal(readLaunch(repo, 'd')?.not_main, '승인받은 복구')
})
