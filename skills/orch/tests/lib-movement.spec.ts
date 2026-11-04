// lib/movement.ts 의 판정 함수와 조회를 임시 폴더와 임시 저장소로 본다. Orca 에는 닿지 않는다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { ConfigError } from '../scripts/lib/config.ts'
import {
  collectWorkers,
  DEFAULT_IDLE_MIN,
  idleNotices,
  judgeWorker,
  lastCommitMs,
  latestMtime,
  markScreen,
  movementSettings,
  pendingStep,
  readRecords,
  stageNotices,
  stalledStages,
  tailHash,
} from '../scripts/lib/movement.ts'
import type { WorkerVerdict } from '../scripts/lib/movement.ts'

type Json = Record<string, unknown>

const MIN = 60_000
const NOW = Date.parse('2026-11-02T12:00:00Z')
const ON = { idleMin: 30, exited: true }

let tmp: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lib-movement-')))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function row(dispatch: string, opts: { path?: string; status?: string; liveness?: string } = {}): Json {
  return {
    dispatchId: dispatch,
    dispatchStatus: opts.status ?? 'running',
    agentTerminalHandle: `term_${dispatch}`,
    resource: { worktreeId: `repo::${opts.path ?? `/work/${dispatch}`}` },
    ...(opts.liveness ? { projection: { liveness: { verdict: opts.liveness } } } : {}),
  }
}

function touch(file: string, ms: number): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, 'x')
  utimesSync(file, ms / 1000, ms / 1000)
}

function verdict(dispatch: string, reason: WorkerVerdict['reason'], movedAt: number | null, run = 'A'): WorkerVerdict {
  return { run, dispatch, terminal: `term_${dispatch}`, worktree: null, liveness: null, movedAt, idleMin: null, reason, waiting: null }
}

describe('movementSettings', () => {
  test('설정이 없으면 기본 30분과 exited 를 본다', () => {
    assert.deepEqual(movementSettings(tmp), { idleMin: DEFAULT_IDLE_MIN, exited: true })
  })

  test('pipeline.idle_min 과 pipeline.idle_exited 를 읽고, 틀린 값은 ConfigError 다', () => {
    mkdirSync(join(tmp, '.orch'))
    const write = (pipeline: Json) => writeFileSync(join(tmp, '.orch', 'config.json'), JSON.stringify({ pipeline }))
    write({ idle_min: 0, idle_exited: false })
    assert.deepEqual(movementSettings(tmp), { idleMin: 0, exited: false })
    for (const bad of [{ idle_min: -1 }, { idle_min: '30' }, { idle_exited: 'yes' }]) {
      write(bad)
      assert.throws(() => movementSettings(tmp), ConfigError, JSON.stringify(bad))
    }
  })
})

describe('judgeWorker', () => {
  const judge = (opts: { mtime?: number | null; commit?: number | null; screen?: number; liveness?: string; waiting?: string; settings?: typeof ON }) =>
    judgeWorker({
      run: 'A',
      row: row('d1', { liveness: opts.liveness }),
      now: NOW,
      settings: opts.settings ?? ON,
      mtime: opts.mtime ?? null,
      commit: opts.commit ?? null,
      screen: opts.screen === undefined ? undefined : { hash: 'h', changedAt: opts.screen },
      waiting: opts.waiting ?? null,
    })

  test('파일, 커밋, 화면 가운데 가장 늦은 움직임으로 분을 내고 기준 분이 지나면 idle 이다', () => {
    const v = judge({ mtime: NOW - 50 * MIN, commit: NOW - 40 * MIN, screen: NOW - 31 * MIN })
    assert.equal(v.movedAt, NOW - 31 * MIN)
    assert.equal(v.idleMin, 31)
    assert.equal(v.reason, 'idle')
    assert.equal(v.worktree, '/work/d1')
    assert.equal(judge({ mtime: NOW - 50 * MIN, screen: NOW - 5 * MIN }).reason, null)
  })

  test('움직임을 하나도 모르면 멈춤으로 보지 않는다', () => {
    const v = judge({})
    assert.equal(v.movedAt, null)
    assert.equal(v.reason, null)
  })

  test('liveness 가 exited 면 기다리는 이유가 있어도 exited 다. idle_exited 가 false 면 보지 않는다', () => {
    assert.equal(judge({ liveness: 'exited', waiting: '질문의 답을 기다린다' }).reason, 'exited')
    assert.equal(judge({ liveness: 'exited', settings: { idleMin: 30, exited: false } }).reason, null)
  })

  test('기다리는 이유가 있으면 오래 멈춰도 멈춤이 아니고 이유를 남긴다', () => {
    const v = judge({ mtime: NOW - 90 * MIN, waiting: 'CI 를 통과해 머지를 기다린다' })
    assert.equal(v.reason, null)
    assert.equal(v.waiting, 'CI 를 통과해 머지를 기다린다')
  })

  test('idle_min 이 0 이면 idle 을 보지 않는다', () => {
    assert.equal(judge({ mtime: NOW - 900 * MIN, settings: { idleMin: 0, exited: true } }).reason, null)
  })
})

describe('워크트리 움직임', () => {
  test('latestMtime 은 SKIP_DIRS 의 폴더를 보지 않고, 폴더가 없으면 null 이다', () => {
    touch(join(tmp, 'src', 'a.ts'), NOW - 40 * MIN)
    touch(join(tmp, 'node_modules', 'x', 'b.js'), NOW - MIN)
    touch(join(tmp, '.git', 'index'), NOW - MIN)
    assert.equal(latestMtime(tmp), NOW - 40 * MIN)
    assert.equal(latestMtime(join(tmp, 'none')), null)
  })

  test('latestMtime 은 상한만큼의 파일만 본다', () => {
    touch(join(tmp, 'a'), NOW - 40 * MIN)
    touch(join(tmp, 'b'), NOW - 10 * MIN)
    const seen = latestMtime(tmp, 1)
    assert.ok(seen === NOW - 40 * MIN || seen === NOW - 10 * MIN)
  })

  test('lastCommitMs 는 마지막 커밋 시각이고, 저장소가 아니면 null 이다', () => {
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: tmp, GIT_COMMITTER_DATE: '2026-11-02T11:00:00Z', GIT_AUTHOR_DATE: '2026-11-02T11:00:00Z' }
    const repo = join(tmp, 'repo')
    mkdirSync(repo)
    for (const args of [['init', '-q'], ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']]) {
      assert.equal(spawnSync('git', args, { cwd: repo, env }).status, 0)
    }
    assert.equal(lastCommitMs(repo), Date.parse('2026-11-02T11:00:00Z'))
    const plain = join(tmp, 'plain')
    mkdirSync(plain)
    const before = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = tmp
    try {
      assert.equal(lastCommitMs(plain), null)
    } finally {
      if (before === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = before
    }
  })

  test('markScreen 은 같은 hash 면 앞 기록을 두고, 다르거나 처음이면 지금 바뀐 것으로 본다', () => {
    const hash = tailHash(['a', 'b'])
    assert.notEqual(hash, tailHash(['a', 'c']))
    const first = markScreen(undefined, hash, NOW - 50 * MIN)
    assert.deepEqual(first, { hash, changedAt: NOW - 50 * MIN })
    assert.equal(markScreen(first, hash, NOW), first)
    assert.deepEqual(markScreen(first, tailHash(['a', 'c']), NOW), { hash: tailHash(['a', 'c']), changedAt: NOW })
  })
})

describe('collectWorkers', () => {
  test('열린 dispatch 만 판정하고, 읽지 못한 Run 은 errors 에 두며, 있는 워크트리만 live 에 든다', () => {
    const path = join(tmp, 'wt')
    touch(join(path, 'f'), NOW - 45 * MIN)
    const rows: Record<string, Json[]> = { A: [row('d1', { path }), row('d2', { status: 'completed' }), row('d3')] }
    const got = collectWorkers({
      runs: ['A', 'B'],
      rowsOf: (run) => (rows[run] ? { ok: true, rows: rows[run] } : { ok: false, error: 'offline' }),
      settings: ON,
      now: NOW,
      waiting: (_run, r) => (r.dispatchId === 'd3' ? '질문의 답을 기다린다' : null),
    })
    assert.deepEqual(got.verdicts.map((v) => [v.dispatch, v.reason, v.idleMin, v.waiting]), [
      ['d1', 'idle', 45, null],
      ['d3', null, null, '질문의 답을 기다린다'],
    ])
    assert.deepEqual([...got.read], ['A'])
    assert.deepEqual([...got.errors], [['B', 'offline']])
    assert.deepEqual([...got.live], [path])
  })
})

describe('stalledStages', () => {
  const item = (id: string, extra: Json): Json => ({ id, status: 'doing', details: [{ text: '구현', done: true }, { text: '평가 결과 확인', done: false }], ...extra })
  const none = () => false

  test('doing 항목의 worktree 나 branch 에 살아 있는 worker 가 없으면 끝나지 않은 첫 단계를 낸다', () => {
    const items = [item('a', { worktree: 'wt-a' }), item('b', { branch: 'feat/b' })]
    assert.deepEqual(stalledStages(items, new Set(), new Map(), none), [
      { id: 'a', step: '평가 결과 확인', worktree: 'wt-a', branch: null },
      { id: 'b', step: '평가 결과 확인', worktree: null, branch: 'feat/b' },
    ])
  })

  test('살아 있는 worker 가 이름이나 branch 로 맞으면 내지 않는다', () => {
    const live = new Set(['/work/wt-a', '/work/wt-b'])
    const branches = new Map([['feat/b', '/work/wt-b']])
    assert.deepEqual(stalledStages([item('a', { worktree: '/somewhere/wt-a' }), item('b', { branch: 'feat/b' })], live, branches, none), [])
  })

  test('doing 이 아니거나, 단계가 다 끝났거나, worktree 와 branch 가 모두 없으면 내지 않는다', () => {
    const items = [
      item('todo', { status: 'todo', worktree: 'x' }),
      item('wait', { status: 'wait', worktree: 'x' }),
      { id: 'done-steps', status: 'doing', worktree: 'x', details: [{ text: '끝', done: true }] },
      item('mine', {}),
    ]
    assert.deepEqual(stalledStages(items, new Set(), new Map(), none), [])
  })

  test('그 워크트리가 최근에 바뀌었으면 내지 않는다', () => {
    const branches = new Map([['feat/b', '/work/wt-b']])
    const recent = (path: string) => path === '/work/wt-b'
    assert.deepEqual(stalledStages([item('a', { worktree: 'wt-b' }), item('b', { branch: 'feat/b' })], new Set(), branches, recent), [])
  })

  test('pendingStep 은 done 이 아닌 첫 글이고, 없으면 null 이다', () => {
    assert.equal(pendingStep({ details: [{ text: ' ', done: false }, { text: '다음', done: false }] }), '다음')
    assert.equal(pendingStep({ details: 'x' }), null)
  })
})

describe('알림 기록', () => {
  test('idleNotices 는 같은 멈춤을 다시 알리지 않고, 이유가 바뀌거나 그 뒤에 움직였다 다시 멈추면 다시 알린다', () => {
    const first = idleNotices({}, [verdict('d1', 'idle', NOW - 40 * MIN)], new Set(['A']))
    assert.deepEqual(first.fire.map((v) => v.dispatch), ['d1'])
    const same = idleNotices(first.records, [verdict('d1', 'idle', NOW - 40 * MIN)], new Set(['A']))
    assert.deepEqual(same.fire, [])
    const exited = idleNotices(same.records, [verdict('d1', 'exited', NOW - 40 * MIN)], new Set(['A']))
    assert.deepEqual(exited.fire.map((v) => v.reason), ['exited'])
    const moved = idleNotices(same.records, [verdict('d1', 'idle', NOW - 31 * MIN)], new Set(['A']))
    assert.deepEqual(moved.fire.map((v) => v.dispatch), ['d1'])
  })

  test('idleNotices 는 지금 멈추지 않은 기록을 지우고, 읽지 못한 Run 의 기록은 둔다', () => {
    const previous = { d1: { run: 'A', reason: 'idle' as const, movedAt: 1 }, d2: { run: 'B', reason: 'idle' as const, movedAt: 1 } }
    const got = idleNotices(previous, [verdict('d1', null, NOW)], new Set(['A']))
    assert.deepEqual(got.records, { d2: previous.d2 })
  })

  test('stageNotices 는 처음 본 뒤 idle_min 분이 지나면 한 번 알리고, 단계 글이 바뀌면 새로 센다', () => {
    const stage = { id: 'a', step: '평가 결과 확인', worktree: 'wt', branch: null }
    const seen = stageNotices({}, [stage], NOW, 30)
    assert.deepEqual(seen.fire, [])
    const later = stageNotices(seen.records, [stage], NOW + 30 * MIN, 30)
    assert.deepEqual(later.fire.map((s) => [s.id, s.minutes]), [['a', 30]])
    assert.deepEqual(stageNotices(later.records, [stage], NOW + 90 * MIN, 30).fire, [])
    const changed = stageNotices(later.records, [{ ...stage, step: '배포 확인' }], NOW + 90 * MIN, 30)
    assert.deepEqual(changed.fire, [])
    assert.equal(changed.records.a.since, NOW + 90 * MIN)
    assert.deepEqual(stageNotices(later.records, [], NOW, 30).records, {})
  })

  test('readRecords 는 형식이 맞는 항목만 남긴다', () => {
    const got = readRecords({
      screens: { d1: { hash: 'h', changedAt: 1 }, d2: { hash: 3 } },
      workers: { d1: { run: 'A', reason: 'idle', movedAt: 2 }, d2: { run: 'A', reason: 'busy' } },
      stages: { a: { step: 's', since: 1, fired: false }, b: { step: 's' } },
    })
    assert.deepEqual(got, {
      screens: { d1: { hash: 'h', changedAt: 1 } },
      workers: { d1: { run: 'A', reason: 'idle', movedAt: 2 } },
      stages: { a: { step: 's', since: 1, fired: false } },
    })
    assert.deepEqual(readRecords('broken'), { screens: {}, workers: {}, stages: {} })
  })
})
