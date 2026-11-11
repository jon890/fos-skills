// lib/ownership.ts 를 가짜 orca 로 본다. 사용자 보유와 조회 실패는 삭제 허가로 바뀌지 않는다.

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin, FakeRule } from './fixtures/fake-bin.ts'
import { allWorkers, blocker, cached, rowHandles, workerSnapshot } from '../scripts/lib/ownership.ts'
import { WorkerRunCache } from '../scripts/lib/worker-run-cache.ts'
import type { WorkerRow } from '../scripts/lib/ownership.ts'

const KEPT = '사용자 보유 터미널'
const FAILED = '터미널 소유 상태 조회 실패'

test('같은 틱의 Run 정리는 전체 소유 목록을 함께 쓰고 삭제 직전에는 새로 확인한다', async () => {
  const file = join(tmp, 'tick-workers.json')
  const initial = row('worker', 'owned')
  initial.resource = { ...(initial.resource as object), worktreeId: `repo::${wt}` }
  orca.setRules(orcaRules([{ handle: 'worker', worktreePath: wt }], { run_a: [initial], run_b: [] }))
  const first = workerSnapshot(file)
  const before = await first.all()
  const reads = orca.calls().filter((call) => call.argv.includes('worker-list')).length
  const second = workerSnapshot(file)
  assert.deepEqual(await second.all(), before)
  assert.equal(orca.calls().filter((call) => call.argv.includes('worker-list')).length, reads)
  assert.deepEqual(await second.runIds(), ['run_a', 'run_b'])
  orca.setRules(orcaRules([{ handle: 'worker', worktreePath: wt }], { run_a: [row('worker', 'user_owned')], run_b: [] }))
  assert.equal(await blocker(wt, new Set(), () => second.forWorktree(wt)), KEPT)
  assert.ok(orca.calls().filter((call) => call.argv.includes('worker-list')).length > reads)
})

test('전체 소유 조회 실패는 같은 틱에서 반복하지 않고 다음 틱에 다시 확인한다', async () => {
  const file = join(tmp, 'failed-tick.json')
  orca.setRules(orcaRules([], { run_a: [], run_b: [] }, { failRun: 'run_b' }))
  await assert.rejects(workerSnapshot(file).all(), /Orca 조회 실패/)
  const reads = orca.calls().length
  await assert.rejects(workerSnapshot(file).all(), /Orca 조회 실패/)
  assert.equal(orca.calls().length, reads)
  orca.setRules(orcaRules([], { run_a: [], run_b: [] }))
  assert.deepEqual(await workerSnapshot(join(tmp, 'next-tick.json')).all(), [])
  assert.ok(orca.calls().length > reads)
})

let tmp: string
let wt: string
let orca: FakeBin

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ownership-')))
  wt = join(tmp, 'wt')
  // Orca 터미널 안에서 돌려도 이 변수가 가짜 orca 로 새지 않게 한다
  delete process.env.ORCA_TERMINAL_HANDLE
  orca = fakeBin(tmp, 'orca', [])
  process.env.ORCA = orca.path
  process.env.ORCH_MACHINE_DIR = join(tmp, 'machine')
})

afterEach(() => { delete process.env.ORCH_MACHINE_DIR; rmSync(tmp, { recursive: true, force: true }) })

const ok = (result: unknown) => JSON.stringify({ result })

function row(handle: string, state = 'owned', run = 'run_a'): WorkerRow {
  return { runId: run, terminalState: 'active', resource: { terminalHandle: handle, ownershipState: state } }
}

// 범위 없는 worker-list 는 scope 가 bound 면 첫 Run 만, all 이면 모든 Run 을 준다.
// run-list 는 한 페이지에 Run 하나씩 주고 cursor 로 잇는다. failRun 의 --run 조회는 실패한다.
function orcaRules(
  terminals: unknown[],
  runs: Record<string, WorkerRow[]>,
  opts: { scope?: string; failRun?: string } = {},
): FakeRule[] {
  const scope = opts.scope ?? 'bound'
  const ids = Object.keys(runs)
  const rules: FakeRule[] = [{ args: ['terminal', 'list'], stdout: ok({ terminals }) }]
  // 「args 가 모두 든 첫 규칙」 이 맞으므로 cursor 가 있는 페이지를 앞에 둔다
  for (let at = ids.length - 1; at >= 0; at--) {
    rules.push({
      args: ['run-list', ...(at ? ['--cursor', String(at)] : [])],
      stdout: ok({ runs: [{ id: ids[at] }], nextCursor: at + 1 < ids.length ? String(at + 1) : null }),
    })
  }
  for (const id of ids) {
    rules.push(
      id === opts.failRun
        ? { args: ['worker-list', '--run', id], code: 1, stderr: 'Orca 조회 실패' }
        : { args: ['worker-list', '--run', id], stdout: ok({ scope: { source: 'flag' }, workers: runs[id], page: { nextCursor: null } }) },
    )
  }
  const unscoped = scope === 'bound' ? runs[ids[0]] : Object.values(runs).flat()
  rules.push({ args: ['worker-list'], stdout: ok({ scope: { source: scope }, workers: unscoped, page: { nextCursor: null } }) })
  return rules
}

const calls = (word: string) => orca.calls().filter((c) => c.argv.includes(word))

describe('blocker', () => {
  test('뒤 페이지의 사용자 보유 행과 하위 경로의 터미널을 남긴다', async () => {
    orca.setRules([
      { args: ['terminal', 'list'], stdout: ok({ terminals: [{ handle: 't', worktreePath: join(wt, 'sub') }] }) },
      {
        args: ['worker-list', '--cursor', 'p'],
        stdout: ok({ scope: { source: 'all' }, workers: [{ resource: { terminalHandle: 't', ownershipState: 'user_owned' } }] }),
      },
      { args: ['worker-list'], stdout: ok({ scope: { source: 'all' }, workers: [], page: { nextCursor: 'p' } }) },
    ])
    assert.equal(await blocker(wt), KEPT)
  })

  const failures: [string, () => void][] = [
    // 출력은 빈 터미널 목록이라 종료 코드를 보지 않으면 허락으로 바뀐다
    ['orca 가 실패로 끝난다', () => orca.setRules([{ code: 1, stdout: ok({ terminals: [] }) }])],
    ['orca 실행 파일이 없다', () => (process.env.ORCA = join(tmp, 'no-orca'))],
    ['출력이 JSON 이 아니다', () => orca.setRules([{ stdout: 'not json' }])],
    ['응답에 터미널 목록이 없다', () => orca.setRules([{ stdout: ok({}) }])],
    ['응답이 실패를 알린다', () => orca.setRules([{ stdout: JSON.stringify({ ok: false, result: {} }) }])],
  ]
  for (const [name, arrange] of failures) {
    test(`조회 실패는 남긴다: ${name}`, async () => {
      arrange()
      assert.equal(await blocker(wt), FAILED)
    })
  }

  for (const scope of ['all', 'bound']) {
    test(`관리되지 않는 터미널은 모든 Run 을 읽은 뒤 허락한다: scope ${scope}`, async () => {
      orca.setRules(orcaRules([{ handle: 't', worktreePath: wt }], { run_a: [row('x')], run_b: [row('y', 'owned', 'run_b')] }, { scope }))
      assert.equal(await blocker(wt), '')
      assert.equal(calls('run-list').length, 2, 'run-list 를 부른 횟수')
    })
  }

  test('bound 범위면 다른 Run 의 사용자 보유 터미널을 찾는다', async () => {
    orca.setRules(orcaRules([{ handle: 't', worktreePath: wt }], { run_a: [row('x')], run_b: [row('t', 'user_owned', 'run_b')] }))
    assert.equal(await blocker(wt), KEPT)
  })

  test('bound 범위에서 한 Run 이라도 읽지 못하면 조회 실패다', async () => {
    orca.setRules(
      orcaRules([{ handle: 't', worktreePath: wt }], { run_a: [row('x')], run_b: [row('y', 'owned', 'run_b')] }, { failRun: 'run_b' }),
    )
    assert.equal(await blocker(wt), FAILED)
  })

  test('agent handle 이 resource handle 과 달라도 본다', async () => {
    const stale = { agentTerminalHandle: 't', resource: { terminalHandle: 'old', ownershipState: 'user_owned' } }
    orca.setRules(orcaRules([{ handle: 't', worktreePath: wt }], { run_a: [stale] }))
    assert.equal(await blocker(wt), KEPT)
  })

  test('released 인 resource 는 남긴다', async () => {
    orca.setRules([
      { args: ['terminal', 'list'], stdout: ok({ terminals: [{ handle: 't', worktreePath: wt }] }) },
      { args: ['worker-list'], stdout: ok({ scope: { source: 'all' }, workers: [{ agentTerminalHandle: 't', resource: { ownershipState: 'released' } }] }) },
    ])
    assert.equal(await blocker(wt), KEPT)
  })

  test('owned 가 아닌 소유 상태는 조회 실패로 남긴다', async () => {
    orca.setRules(orcaRules([{ handle: 't', worktreePath: wt }], { run_a: [row('t', 'external')] }, { scope: 'all' }))
    assert.equal(await blocker(wt), FAILED)
  })

  test('ignore 의 handle 은 소유 상태를 보지 않지만 다른 handle 은 막는다', async () => {
    const rules = (bState: string): FakeRule[] => [
      {
        args: ['terminal', 'list'],
        stdout: ok({ terminals: [{ handle: 'a', worktreePath: wt }, { handle: 'b', worktreePath: wt }] }),
      },
      {
        args: ['worker-list'],
        stdout: ok({
          scope: { source: 'all' },
          workers: [
            { resource: { terminalHandle: 'a', ownershipState: 'user_owned' } },
            { resource: { terminalHandle: 'b', ownershipState: bState } },
          ],
        }),
      },
    ]
    orca.setRules(rules('owned'))
    assert.equal(await blocker(wt, new Set(['a'])), '')
    assert.equal(await blocker(wt), KEPT)
    orca.setRules(rules('user_owned'))
    assert.equal(await blocker(wt, new Set(['a'])), KEPT)
  })

  test('경로 아래 터미널이 없으면 worker 행을 읽지 않고 허락한다. 이름만 겹치는 옆 경로는 아래가 아니다', async () => {
    orca.setRules(orcaRules([{ handle: 't', worktreePath: `${wt}-other` }, { handle: 'u' }], { run_a: [row('t', 'user_owned')] }))
    assert.equal(await blocker(wt), '')
    assert.equal(calls('worker-list').length, 0, 'worker-list 를 부른 횟수')
  })
})

describe('cached', () => {
  test('여러 경로를 볼 때 모든 Run 을 한 번만 읽는다', async () => {
    orca.setRules(
      orcaRules(
        [
          { handle: 't1', worktreePath: join(tmp, 'wt1') },
          { handle: 't2', worktreePath: join(tmp, 'wt2') },
        ],
        { run_a: [row('t1')], run_b: [row('t2', 'owned', 'run_b')] },
      ),
    )
    const workers = cached(allWorkers)
    assert.equal(await blocker(join(tmp, 'wt1'), new Set(), workers), '')
    assert.equal(await blocker(join(tmp, 'wt2'), new Set(), workers), '')
    // Run 마다 --run 한 번
    assert.equal(calls('worker-list').length, 2, 'worker-list 를 부른 횟수')
  })

  test('실패 뒤 다음 호출이 다시 읽고 성공한 목록은 재사용한다', async () => {
    orca.setRules(orcaRules([{ handle: 't', worktreePath: wt }], { run_a: [row('x')] }, { failRun: 'run_a' }))
    const workers = cached(allWorkers)
    assert.equal(await blocker(wt, new Set(), workers), FAILED)
    orca.setRules(orcaRules([{ handle: 't', worktreePath: wt }], { run_a: [row('t')] }))
    assert.equal(await blocker(wt, new Set(), workers), '')
    assert.equal(await blocker(wt, new Set(), workers), '')
    assert.equal(calls('--run').length, 2, '--run 조회 횟수')
  })

  test('maxAge 가 지나면 다시 읽는다', async () => {
    const terminals = [{ handle: 't', worktreePath: wt }]
    orca.setRules(orcaRules(terminals, { run_a: [row('t')] }))
    const workers = cached(allWorkers, 0)
    assert.equal(await blocker(wt, new Set(), workers), '')
    orca.setRules(orcaRules(terminals, { run_a: [row('t', 'user_owned')] }))
    assert.equal(await blocker(wt, new Set(), workers), KEPT)
  })

  test('LookupError 가 아닌 예외는 기억하지 않는다', async () => {
    let n = 0
    const workers = cached(async () => {
      n++
      if (n === 1) throw new RangeError('boom')
      return [row('t')]
    })
    await assert.rejects(workers(), RangeError)
    assert.deepEqual(await workers(), [row('t')])
  })
})

describe('rowHandles', () => {
  test('resource 와 agent 의 handle 을 모두 내고 빈 값은 뺀다', () => {
    assert.deepEqual(rowHandles({ agentTerminalHandle: 'a', resource: { terminalHandle: 'b' } }), new Set(['b', 'a']))
    assert.deepEqual(rowHandles({ agentTerminalHandle: 'a', resource: { terminalHandle: 'a' } }), new Set(['a']))
    assert.deepEqual(rowHandles({ agentTerminalHandle: '', resource: null }), new Set())
  })
})

describe('실행 단위 스냅샷과 끝난 Run 캐시', () => {
  const old = '2000-01-01T00:00:00Z'
  const finished = (handle: string, run = 'run_a'): WorkerRow => ({
    ...row(handle, 'owned', run), dispatchStatus: 'completed', workerState: 'succeeded',
  })

  test('60초가 지나고 동시에 다시 불러도 전체 목록은 실행 중 한 번만 읽는다', async (t) => {
    let count = 0
    const workers = cached(async () => { count++; return [row('t')] })
    let now = 0
    t.mock.method(performance, 'now', () => now)
    await Promise.all([workers(), workers()])
    now = 120_000
    await workers()
    assert.equal(count, 1)
  })

  test('오래된 Run 은 모든 dispatch 가 끝났을 때만 저장하고 살아 있는 handle 은 다시 읽는다', () => {
    const cache = new WorkerRunCache()
    const run = { id: 'run_a', updated_at: old }
    const rows = [finished('agent'), { ...finished('other'), resource: { terminalHandle: 'resource' } }]
    cache.remember(run, rows)
    assert.deepEqual(cache.read(run, new Set()), rows)
    for (const handle of ['agent', 'resource']) assert.equal(cache.read(run, new Set([handle])), null)
    assert.equal(cache.read({ ...run, updated_at: '2001-01-01T00:00:00Z' }, new Set()), null)
    for (const bad of [row('active'), { ...finished('ready'), workerState: 'ready' }]) {
      const other = { id: String(bad.agentTerminalHandle ?? 'unknown'), updated_at: old }
      cache.remember(other, [bad])
      assert.equal(cache.read(other, new Set()), null)
    }
    const abandoned = { id: 'run_abandoned', updated_at: old }
    const abandonedRows = [{ ...finished('gone'), dispatchStatus: 'abandoned', workerState: 'abandoned' }]
    cache.remember(abandoned, abandonedRows)
    assert.deepEqual(cache.read(abandoned, new Set()), abandonedRows)
    for (const updated_at of [undefined, 'bad', new Date().toISOString()]) {
      const other = { id: 'recent', updated_at }
      cache.remember(other, rows)
      assert.equal(cache.read(other, new Set()), null)
    }
  })

  test('캐시한 끝난 Run 을 다음 전체 조회에서 건너뛰고 넘겨받은 터미널이 살아나면 새로 읽어 막는다', async () => {
    const rules = (terminals: unknown[], state = 'owned'): FakeRule[] => [
      { args: ['terminal', 'list'], stdout: ok({ terminals }) },
      { args: ['run-list'], stdout: ok({ runs: [{ id: 'run_a', updated_at: old }] }) },
      { args: ['worker-list', '--run', 'run_a'], stdout: ok({ scope: { source: 'flag' }, workers: [
        { ...finished('t'), resource: { terminalHandle: 't', ownershipState: state } },
      ] }) },
      { args: ['worker-list'], stdout: ok({ scope: { source: 'bound' }, workers: [] }) },
    ]
    orca.setRules(rules([]))
    await allWorkers()
    await allWorkers()
    assert.equal(calls('--run').length, 1)
    orca.setRules(rules([{ handle: 't', worktreePath: wt }], 'user_owned'))
    assert.equal(await blocker(wt), KEPT)
    assert.equal(calls('--run').length, 2)
  })

  test('삭제 직전에는 해당 경로와 새로 생기거나 갱신된 Run 만 다시 읽어 넘겨받기를 찾는다', async () => {
    const info = (id: string, updated_at = old) => ({ id, updated_at })
    const rows = (run: string, path: string, state = 'owned') => [{ ...finished(run, run), resource: {
      terminalHandle: run, ownershipState: state, worktreeId: `repo::${path}`,
    } }]
    const rules = (changed: boolean): FakeRule[] => [
      { args: ['terminal', 'list'], stdout: ok({ terminals: [{ handle: 'run_a', worktreePath: wt }] }) },
      { args: ['run-list'], stdout: ok({ runs: [info('run_a'), info('run_b'), info('run_changed', changed ? '2001-01-01T00:00:00Z' : old), ...(changed ? [info('run_new')] : [])] }) },
      ...['run_a', 'run_b', 'run_changed', 'run_new'].map((id) => ({ args: ['worker-list', '--run', id], stdout: ok({
        scope: { source: 'flag' }, workers: rows(id, id === 'run_a' ? wt : `${wt}-other`, changed ? 'user_owned' : 'owned'),
      }) })),
      { args: ['worker-list'], stdout: ok({ scope: { source: 'bound' }, workers: [] }) },
    ]
    orca.setRules(rules(false))
    const snapshot = workerSnapshot()
    snapshot.seedRun('run_b', rows('run_b', `${wt}-other`))
    await snapshot.all()
    await snapshot.all()
    assert.equal(calls('--run').filter((c) => c.argv.includes('run_b')).length, 0, '이미 읽은 이 Run 은 되풀이하지 않는다')
    const before = calls('--run').length
    orca.setRules(rules(true))
    assert.equal(await blocker(wt, new Set(), () => snapshot.forWorktree(wt)), KEPT)
    const again = calls('--run').slice(before).map((c) => c.argv[c.argv.indexOf('--run') + 1]).sort()
    assert.deepEqual(again, ['run_a', 'run_changed', 'run_new'])
  })
})
