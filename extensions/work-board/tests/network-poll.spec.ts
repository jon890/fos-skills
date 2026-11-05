import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IDLE_MS, PR_MS, createNetworkPoll } from '../hooks/network-poll.js'
import { register } from '../hooks/register.js'

test('PR 주기 경계 전에는 멈추고 경계에서는 읽는다', async () => {
  const poll = createNetworkPoll()
  let calls = 0
  const tasks = [{ key: 'prs', every: PR_MS, read: async () => { calls++ } }]
  poll.input(0)
  await poll.poll(0, true, tasks)
  await poll.poll(PR_MS - 1, true, tasks)
  assert.equal(calls, 1)
  await poll.poll(PR_MS, true, tasks)
  assert.equal(calls, 2)
})

test('숨김과 무입력 기한에서는 멈추고, 다시 보거나 입력하면 기한이 지난 조회만 재개한다', async () => {
  const poll = createNetworkPoll()
  let calls = 0
  const tasks = [{ key: 'prs', every: PR_MS, read: async () => { calls++ } }]
  await poll.poll(0, true, tasks)
  assert.equal(calls, 0)
  poll.input(0)
  await poll.poll(0, false, tasks)
  assert.equal(calls, 0)
  await poll.poll(0, true, tasks)
  await poll.poll(IDLE_MS, true, tasks)
  assert.equal(calls, 1)
  poll.input(IDLE_MS)
  await poll.poll(IDLE_MS, false, tasks)
  assert.equal(calls, 1)
  await poll.poll(IDLE_MS, true, tasks)
  assert.equal(calls, 2)
  await poll.poll(IDLE_MS + 1, true, tasks)
  assert.equal(calls, 2)
})

test('응답 완료부터 주기를 재서 다음 조회가 아직 유효한 옛 캐시에 걸리지 않는다', async () => {
  const poll = createNetworkPoll()
  let at = 0
  let calls = 0
  const tasks = [{ key: 'prs', every: PR_MS, read: async () => { calls++; at += 5000 } }]
  const clock = async () => at
  poll.input(0)
  await poll.poll(at, true, tasks, false, clock)
  at = PR_MS
  await poll.poll(at, true, tasks, false, clock)
  assert.equal(calls, 1)
  at += 5000
  await poll.poll(at, true, tasks, false, clock)
  assert.equal(calls, 2)
})

test('명시적 열기는 숨김·무입력·주기와 관계없이 읽지만, 진행 중인 조회는 겹치지 않는다', async () => {
  const poll = createNetworkPoll()
  let calls = 0
  let finish = () => {}
  const tasks = [{ key: 'prs', every: PR_MS, read: async () => {
    calls++
    await new Promise<void>((resolve) => { finish = resolve })
  } }]
  const pending = poll.poll(0, false, tasks, true)
  await poll.poll(0, false, tasks, true)
  assert.equal(calls, 1)
  finish()
  await pending
  const again = poll.poll(1, false, tasks, true)
  assert.equal(calls, 2)
  finish()
  await again
})

test('실패해도 자동 재시도는 주기를 지키고, 다른 종류의 조회는 계속한다', async () => {
  const poll = createNetworkPoll()
  let attempts = 0
  let other = 0
  const tasks = [
    { key: 'prs', every: PR_MS, read: async () => { attempts++; throw Error('offline') } },
    { key: 'inbox', every: 60_000, read: async () => { other++ } },
  ]
  poll.input(0)
  await assert.rejects(poll.poll(0, true, tasks), /offline/)
  await poll.poll(60_000, true, tasks)
  assert.equal(attempts, 1)
  assert.equal(other, 2)
  await assert.rejects(poll.poll(PR_MS, true, tasks), /offline/)
  assert.equal(attempts, 2)
})

// 실제 register 의 타이머와 입력 이벤트를 연결한다. 외부 서비스는 모의 process.run 만 받는다.
test('등록 훅은 창 표시와 사람 입력을 확인하고, PR 을 로컬 45초 조회에서 분리한다', async () => {
  const hooks = new Map<string, Function>()
  const timers = new Map<number, Function[]>()
  const calls: string[][] = []
  let at = 0
  let panes: object[] = []
  register((event, filter, handler) => { hooks.set(event, handler || filter) })
  const $ = {
    plugin: { root: '/plugin', name: 'fos-skills' },
    session: { cwd: async () => '/repo' },
    clock: { now: async () => at, every: (ms, fn) => timers.set(ms, [...(timers.get(ms) || []), fn]) },
    fs: { exists: async () => false, read: async () => { throw Error('missing') } },
    command: { register: async () => {} },
    ui: { invalidate: () => {}, status: () => {}, panes: async () => panes, open: async () => ({ isPlaced: true }) },
    process: { run: async (argv: string[]) => {
      calls.push(argv)
      return { exitCode: 0, stdout: argv.at(-1) === 'prs' ? '[]' : '', stderr: '' }
    } },
  }
  const next = async (e) => e
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const tick = (ms) => Promise.all(timers.get(ms)!.map((fn) => fn()))
  const prs = () => calls.filter((a) => a[2]?.endsWith('/github.ts') && a[3] === 'prs').length
  await hooks.get('session.start')!($, {}, next)
  await flush()
  assert.equal(prs(), 1, '세션 시작은 숨김 상태여도 한 번 읽는다')
  at = PR_MS
  await tick(5000)
  assert.equal(prs(), 1, '창이 닫혔으면 읽지 않는다')
  panes = [{ id: 'work-board', isPlaced: true, isShown: false }]
  await tick(5000)
  assert.equal(prs(), 1, '다른 창에 가려지면 읽지 않는다')
  panes = [{ id: 'work-board', isPlaced: true, isShown: true }]
  await tick(5000)
  assert.equal(prs(), 2)
  at += 45_000
  await tick(45000)
  assert.equal(prs(), 2, 'Orca 로컬 갱신은 gh 를 읽지 않는다')
  at = IDLE_MS
  await hooks.get('prompt.change')!($, { origin: { kind: 'plugin' } }, next)
  await tick(5000)
  assert.equal(prs(), 2, '프로그램 입력은 무입력 기한을 늘리지 않는다')
  await hooks.get('prompt.change')!($, { origin: { kind: 'person' } }, next)
  await tick(5000)
  assert.equal(prs(), 3)
  at++
  await hooks.get('command.run')!($, {})
  await flush()
  assert.equal(prs(), 4, '/board 는 주기 안에서도 캐시를 읽는다')
  assert.equal(calls.some((a) => a[0] === 'gh'), false, '직접 gh 로 우회하지 않는다')
})
