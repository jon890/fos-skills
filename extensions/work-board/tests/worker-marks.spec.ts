// bin/worker-marks.ts 가 orch 상주 루프와 같은 판정(lib/movement.ts 의 judgeWorker)과 같은 기다림 입력으로 멈춤을 내는지 본다.
// 스펙: docs/features/board-decision-box/spec.md 의 R4, R5. 워크트리는 임시 폴더다.
//
// 실행: node --test extensions/work-board/tests/worker-marks.spec.ts

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readBoardWorkerMarks } from '../../../skills/orch/scripts/lib/board-queries/board-worker-marks.ts'
import { fakeBin } from '../../../modules/testkit/fake-bin.ts'

const SCRIPT = fileURLToPath(new URL('../bin/worker-marks.ts', import.meta.url))
const NOW = Date.parse('2026-11-02T12:00:00Z')
let tmp: string
let tree: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'worker-marks-')))
  tree = join(tmp, 'wt-a')
  mkdirSync(tree)
  // 커밋 없는 저장소로 둔다. 임시 폴더가 다른 git 작업 트리 안에 있어도 그 저장소의 커밋 시각을 읽지 않는다
  spawnSync('git', ['init', '-q', tree])
})
afterEach(() => {
  mock.restoreAll()
  rmSync(tmp, { recursive: true, force: true })
})

// 워크트리의 파일 하나를 minutes 분 전에 바뀐 것으로 둔다. 커밋이 없어 커밋 시각은 없다(.git 폴더는 훑지 않는다)
function touched(minutes: number): number {
  const file = join(tree, 'a.txt')
  writeFileSync(file, 'x')
  const at = NOW - minutes * 60_000
  utimesSync(file, at / 1000, at / 1000)
  return at
}

const row = (extra: Record<string, unknown> = {}) => ({
  dispatchId: 'd1', dispatchStatus: 'dispatched', agentTerminalHandle: 't1', resource: { worktreeId: 'x::' + tree }, ...extra,
})
const workerOutput = (rows: unknown[]) => JSON.stringify({ ok: true, result: { workers: rows } })

function mark({ rows = [row()], screens = {}, ...waiting }: {
  rows?: Record<string, unknown>[]
  screens?: Record<string, { hash: string; changedAt: number }>
  asking?: string[]
  merging?: string[]
  questionsUnknown?: boolean
} = {}) {
  const orca = fakeBin(tmp, 'orca', [{ stdout: workerOutput(rows) }])
  const orchDir = join(tmp, '.orch')
  mkdirSync(join(orchDir, 'state'), { recursive: true })
  writeFileSync(join(orchDir, 'state/movement.json'), JSON.stringify({ screens }))
  const previous = { ORCA: process.env.ORCA, ORCH_DIR: process.env.ORCH_DIR }
  process.env.ORCA = orca.path
  process.env.ORCH_DIR = orchDir
  const clock = mock.method(Date, 'now', () => NOW)
  try {
    const result = readBoardWorkerMarks({ repo: tree, run: 'r', ...waiting })
    assert.equal(result.ok, true)
    return result.view.workers
  } finally {
    clock.mock.restore()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('마지막 움직임이 idle_min 넘게 지난 worker 만 멈춤이다 (R4)', () => {
  const at = touched(40)
  assert.deepEqual(mark(), [{ dispatch: 'd1', terminal: 't1', worktree: tree, reason: 'idle', idleMin: 40, movedAt: at, workedAt: at, waiting: null }])
  touched(5)
  assert.equal(mark()[0].reason, null)
})

test('질문의 답이나 머지를 기다리는 worker 는 멈춤이 아니다. 문구는 루프와 같다 (R4)', () => {
  touched(40)
  for (const [input, waiting] of [
    [{ asking: ['d1'] }, '질문의 답을 기다린다'],
    [{ asking: ['t1'] }, '질문의 답을 기다린다'],
    [{ merging: ['d1'] }, 'CI 를 통과해 머지를 기다린다'],
    [{ questionsUnknown: true }, '질문을 읽지 못했다'],
  ] satisfies [Parameters<typeof mark>[0], string][]) {
    const [got] = mark(input)
    assert.equal(got.reason, null, waiting)
    assert.equal(got.waiting, waiting)
  }
})

test('화면이 바뀌었으면 멈춤이 아니고, workedAt 은 파일과 커밋 시각만 본다 (R4, R5)', () => {
  const at = touched(40)
  const [got] = mark({ screens: { d1: { hash: 'h', changedAt: NOW - 2 * 60_000 } } })
  assert.equal(got.reason, null)
  assert.equal(got.movedAt, NOW - 2 * 60_000)
  assert.equal(got.workedAt, at)
})

test('터미널이 끝났으면 질문을 기다려도 멈춤이고, 닫힌 dispatch 는 내지 않는다 (R4)', () => {
  touched(1)
  const [got] = mark({ rows: [row({ projection: { liveness: { verdict: 'exited' } } })], asking: ['d1'] })
  assert.equal(got.reason, 'exited')
  assert.deepEqual(mark({ rows: [row({ dispatchStatus: 'failed' })] }), [])
})

test('워크트리 폴더가 없으면 움직임을 모르는 것이라 멈춤이 아니다 (R4)', () => {
  const [got] = mark({ rows: [row({ resource: { worktreeId: 'x::' + join(tmp, 'gone') } })] })
  assert.deepEqual([got.reason, got.movedAt, got.workedAt], [null, null, null])
})

// 물려받은 ORCH_DIR 가 절대경로면 실제 설정 파일을 읽으므로 지운다
function runScript(repo: string, args: string[] = [], orca?: string) {
  const env = { ...process.env, ...(orca ? { ORCA: orca } : {}) }
  delete env.ORCH_DIR
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, ...args], { encoding: 'utf8', env })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

test('명령은 Run 이 없으면 설정만 내고, 설정이 틀리면 종료 코드 2 다 (R4)', () => {
  const repo = join(tmp, 'repo')
  mkdirSync(repo)
  spawnSync('git', ['init', '-q', repo])
  let r = runScript(repo)
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { settings: { idleMin: 30, exited: true }, workers: [], error: null })
  mkdirSync(join(repo, '.orch'))
  writeFileSync(join(repo, '.orch', 'config.json'), JSON.stringify({ pipeline: { idle_min: 45, idle_exited: false } }))
  r = runScript(repo)
  assert.deepEqual(JSON.parse(r.stdout).settings, { idleMin: 45, exited: false })
  writeFileSync(join(repo, '.orch', 'config.json'), JSON.stringify({ pipeline: { idle_min: -1 } }))
  r = runScript(repo)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /idle_min/)
})

test('명령은 worker 목록과 멈춤 상태를 내고, 조회 실패는 JSON 안에 남긴다', () => {
  const args = ['--run', 'r', '--asking', 't1']
  const ok = fakeBin(tmp, 'orca', [{ stdout: workerOutput([row()]) }])
  const found = runScript(tree, args, ok.path)
  assert.equal(found.code, 0, found.stderr)
  const settings = { idleMin: 30, exited: true }
  assert.deepEqual(JSON.parse(found.stdout), {
    settings,
    workers: [{ dispatch: 'd1', terminal: 't1', worktree: tree, reason: null, idleMin: null, movedAt: null, workedAt: null, waiting: '질문의 답을 기다린다' }],
    error: null,
  })
  const broken = fakeBin(tmp, 'orca', [{ code: 1, stderr: '조회 실패' }])
  const failed = runScript(tree, args, broken.path)
  assert.equal(failed.code, 0, failed.stderr)
  assert.deepEqual(JSON.parse(failed.stdout), {
    settings, workers: [], error: 'orca orchestration worker-list --run r --limit 100 가 종료 코드 1 로 끝났다: 조회 실패',
  })
})
