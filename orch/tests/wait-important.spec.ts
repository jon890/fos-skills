// wait-important.ts 를 가짜 orca, ps, gh 로 본다. Orca 와 GitHub 에는 닿지 않는다.
// worker-done, worker-lost 핸들러는 작업 디렉터리(임시 폴더)의 .orch/hooks/ 에 둔다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeBin } from './fixtures/fake-bin.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/wait-important.ts', import.meta.url))
const SHIM = fileURLToPath(new URL('../scripts/wait-important.py', import.meta.url))
const TRIAGE = fileURLToPath(new URL('../scripts/triage-messages.ts', import.meta.url))
const SHA = 'a'.repeat(40)

// 차례로 응답을 하나씩 낸다. 부를 때마다 인자를 기록한다. 확장자 없는 실행 파일이라 타입 문법을 쓰지 않는다.
// workers 는 worker-list 응답의 차례다. 마지막 것은 되풀이하고, 값이 "fail" 이면 실패로 답한다.
// 값이 { workers, nextCursor } 이면 그 행과 page.nextCursor 를 낸다. FAKE_PID 가 있으면 check --wait 의 pid 를 그 파일에 적는다.
// latest 의 값은 dispatch id 이거나 dispatch-show 의 dispatch 그대로다.
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_STATE
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
const argv = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(argv) + '\\n')
process.stderr.write('{"_keepalive":true}\\n')
const save = () => fs.writeFileSync(file, JSON.stringify(st))
const print = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
if (argv.includes('worker-list')) {
  const lists = st.workers || []
  const rows = lists.length > 1 ? lists.shift() : lists[0] || []
  save()
  if (rows === 'fail') {
    print({ ok: false, error: { code: 'runtime_unavailable' } })
    process.exit(1)
  }
  if (Array.isArray(rows)) print({ ok: true, result: { workers: rows } })
  else print({ ok: true, result: { workers: rows.workers, page: { nextCursor: rows.nextCursor } } })
} else if (argv.includes('task-list')) {
  print({ ok: true, result: { tasks: st.tasks || [] } })
} else if (argv.includes('dispatch-show')) {
  const latest = (st.latest || {})[argv[argv.indexOf('--task') + 1]]
  print({ ok: true, result: latest ? { dispatch: typeof latest === 'object' ? latest : { id: latest } } : {} })
} else if (argv.includes('--all')) {
  print({ ok: !st.history_fail, result: { messages: st.history || [] } })
} else {
  if (process.env.FAKE_PID) fs.appendFileSync(process.env.FAKE_PID, process.pid + '\\n')
  const reply = st.replies.length ? st.replies.shift() : { ok: true, result: { deliveryId: null, messages: [], timedOut: true } }
  save()
  const wait = reply.sleep || 0
  delete reply.sleep
  setTimeout(() => {
    print(reply)
    process.exitCode = reply.ok ? 0 : 1
  }, wait * 1000)
}
`

type Json = Record<string, unknown>
type Result = { code: number | null; stdout: string; stderr: string }

let binDir: string
let orcaPath: string
let psPath: string
let tmp: string
let stateFile: string
let log: string
let psRows: string
let lostState: string
let env: NodeJS.ProcessEnv

before(() => {
  // macOS 는 새로 만든 실행 파일을 처음 실행할 때 검사하느라 몇 초를 쓴다(부하가 높으면 더 길다).
  // 테스트마다 가짜를 새로 만들면 첫 check 호출이 시간 한도 테스트의 한도를 넘긴다. 한 번 만들고 한 번 실행해 둔다
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'wait-important-bin-')))
  orcaPath = join(binDir, 'orca')
  psPath = join(binDir, 'ps')
  writeFileSync(orcaPath, FAKE_ORCA)
  // ps 는 FAKE_PS 파일의 내용을 낸다. 파일이 없으면 아무것도 내지 않는다
  writeFileSync(psPath, '#!/bin/sh\ncat "$FAKE_PS" 2>/dev/null\n')
  for (const fake of [orcaPath, psPath]) {
    chmodSync(fake, 0o755)
    spawnSync(fake, [], { env: { PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` } })
  }
})
after(() => rmSync(binDir, { recursive: true, force: true }))

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wait-important-')))
  stateFile = join(tmp, 'state.json')
  log = join(tmp, 'log.txt')
  psRows = join(tmp, 'ps.txt')
  lostState = join(tmp, 'lost.json')
  env = {
    ...process.env,
    // 가짜 orca 의 #! 줄과 이벤트 핸들러가 이 테스트의 node 를 쓰게 한다
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ORCA: orcaPath,
    PS: psPath,
    FAKE_STATE: stateFile,
    FAKE_LOG: log,
    FAKE_PS: psRows,
    // 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다
    GIT_CEILING_DIRECTORIES: dirname(tmp),
  }
  delete env.ORCH_DIR
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

type WaitOptions = { workers?: unknown[]; tasks?: Json[]; latest?: Json; history?: Json[]; contract?: string; historyFail?: boolean }

function wait(replies: Json[], args: string[] = [], opts: WaitOptions = {}, extraEnv: NodeJS.ProcessEnv = {}): Result {
  writeFileSync(
    stateFile,
    JSON.stringify({
      replies,
      workers: opts.workers ?? [],
      tasks: opts.tasks ?? [],
      latest: opts.latest ?? {},
      history: opts.history ?? [],
      history_fail: opts.historyFail ?? false,
    }),
  )
  const argv = ['--disable-warning=ExperimentalWarning', SCRIPT, '--run', 'run_x', '--lost-state', lostState, '--completion-contract', opts.contract ?? 'none', ...args]
  const done = spawnSync(process.execPath, argv, { env: { ...env, ...extraEnv }, cwd: tmp, encoding: 'utf8', timeout: 120_000 })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function allCalls(): string[][] {
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line)
        .map((line) => JSON.parse(line) as string[])
    : []
}

// 대기 호출만. worker-list, task-list, dispatch-show 는 대기 호출이 아니다
function calls(): string[][] {
  const skip = ['worker-list', 'task-list', 'dispatch-show']
  return allCalls().filter((c) => !skip.some((s) => c.includes(s)))
}

function ackOf(call: string[]): string | null {
  const at = call.indexOf('--ack')
  return at >= 0 ? call[at + 1] : null
}

function batch(delivery: string, ...types: string[]): Json {
  return { ok: true, result: { deliveryId: delivery, timedOut: false, messages: types.map((t, i) => ({ id: `${delivery}-${i}`, type: t })) } }
}

function sleeping(reply: Json, seconds: number): Json {
  return { ...reply, sleep: seconds }
}

function worker(dispatch: string, state: string, status: string, detail: string, task = 't1'): Json {
  return { dispatchId: dispatch, taskId: task, workerState: state, dispatchStatus: status, agentTerminalHandle: `term_${dispatch}`, projection: { stage: { detail } } }
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line)
}

function lastLine(text: string): string {
  return lines(text).at(-1) ?? ''
}

function lostEntries(): Json {
  return JSON.parse(readFileSync(lostState, 'utf8')).run_x as Json
}

// 시작할 때 이미 failed/abandoned 인 ctx_bad 하나가 있는 Run 에 대기를 건다
function lostAtStart(args: string[] = [], opts: { taskStatus?: string; result?: unknown; latest?: unknown } = {}): Result {
  const rows = [worker('ctx_bad', 'abandoned', 'failed', 'terminal_missing')]
  const tasks = [{ id: 't1', status: opts.taskStatus ?? 'dispatched', result: opts.result ?? null }]
  return wait([batch('d1', 'worker_done')], ['--lost-interval-sec', '0.3', ...args], {
    workers: [rows],
    tasks,
    latest: { t1: opts.latest === undefined ? 'ctx_bad' : opts.latest },
  })
}

const LIVE = [worker('ctx_a', 'ready', 'dispatched', 'input_accepted')]
const GONE = [worker('ctx_a', 'abandoned', 'failed', 'terminal_missing')]

describe('끊긴 worker', () => {
  test('살아 있던 worker 가 대기 중에 abandoned 가 되면 대기를 끝낸다', () => {
    const settled = worker('ctx_done', 'succeeded', 'completed', 'settled')
    const r = wait([sleeping(batch('d9', 'worker_done'), 5)], ['--lost-interval-sec', '0.3', '--ack', 'd0'], {
      workers: [
        [...LIVE, settled],
        [...LIVE, settled],
        [...GONE, settled],
      ],
    })
    assert.equal(r.code, 5, r.stdout + r.stderr)
    assert.deepEqual(lines(r.stdout), ['WORKER_LOST ctx_a stage=terminal_missing', 'LAST_DELIVERY d0'])
  })

  test('끝난 dispatch 만 있으면 대기를 끝내지 않는다', () => {
    const r = wait([sleeping(batch('d1', 'worker_done'), 1)], ['--lost-interval-sec', '0.3'], { workers: [[worker('ctx_old', 'succeeded', 'completed', 'settled')]] })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(lastLine(r.stdout), 'LAST_DELIVERY d1')
    assert.doesNotMatch(r.stdout, /WORKER_LOST/)
  })

  test('터미널이 사라졌어도 정산된 dispatch 는 끊긴 것이 아니다', () => {
    for (const status of ['completed', 'abandoned']) {
      const r = wait([batch('d1', 'status')], [], {
        workers: [[worker('ctx_old', 'abandoned', status, 'terminal_missing')]],
        tasks: [{ id: 't1', status: 'dispatched' }],
        latest: { t1: 'ctx_old' },
      })
      assert.equal(r.code, 0, status + r.stdout + r.stderr)
      assert.doesNotMatch(r.stdout, /WORKER_LOST/)
    }
  })

  test('camelCase 의 worker_report 실패는 끊긴 것이 아니다', () => {
    const r = lostAtStart([], { latest: { id: 'ctx_bad', lastFailure: { provenance: 'worker_report' } } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /WORKER_LOST/)
  })

  test('명시적 포기는 끊긴 것이 아니지만 복구 뒤 터미널을 잃은 것은 끊긴 것이다', () => {
    const r = lostAtStart([], { latest: { id: 'ctx_bad', lastFailure: 'abandoned' } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /WORKER_LOST/)
    unlinkSync(lostState)
    const lost = lostAtStart([], { latest: { id: 'ctx_bad', lastFailure: 'The assigned worker terminal is no longer live after orchestration recovery.' } })
    assert.equal(lost.code, 5, lost.stdout + lost.stderr)
  })

  test('대기 중에 완료된 dispatch 는 끊긴 것이 되지 않는다', () => {
    const done = [worker('ctx_a', 'abandoned', 'completed', 'terminal_missing')]
    const r = wait([sleeping(batch('d1', 'worker_done'), 1)], ['--lost-interval-sec', '0.3'], { workers: [LIVE, LIVE, done] })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /WORKER_LOST/)
  })

  test('시작할 때 처리하지 않은 끊긴 dispatch 가 있으면 check 없이 끝낸다', () => {
    const r = lostAtStart(['--ack', 'd0'])
    assert.equal(r.code, 5, r.stdout + r.stderr)
    assert.deepEqual(lines(r.stdout), ['WORKER_LOST ctx_bad stage=terminal_missing', 'LAST_DELIVERY d0'])
    assert.deepEqual(calls(), [])
  })

  test('같은 task 에 나중 dispatch 가 있으면 뺀다', () => {
    const r = lostAtStart([], { latest: 'ctx_new' })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /WORKER_LOST/)
  })

  test('--ignore-lost 로 준 dispatch 는 뺀다', () => {
    const r = lostAtStart(['--ignore-lost', 'ctx_other', '--ignore-lost', 'ctx_bad'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /WORKER_LOST/)
  })

  test('완료되거나 취소된 task 의 끊긴 dispatch 는 뺀다', () => {
    for (const [status, result] of [
      ['completed', '{}'],
      ['failed', 'cancelled'],
    ]) {
      const r = lostAtStart([], { taskStatus: status, result })
      assert.equal(r.code, 0, status + r.stdout + r.stderr)
    }
    const failed = lostAtStart([], { taskStatus: 'failed', result: 'circuit broken' })
    assert.equal(failed.code, 5, failed.stdout + failed.stderr)
  })

  test('끊긴 dispatch 는 한 번만 알리고, 다음 대기는 stderr 에만 남긴다', () => {
    const r = lostAtStart()
    assert.equal(r.code, 5, r.stdout + r.stderr)
    assert.deepEqual(Object.keys(lostEntries()), ['ctx_bad'])
    assert.match(String(lostEntries().ctx_bad), /^lost \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    const again = lostAtStart()
    assert.equal(again.code, 0, again.stdout + again.stderr)
    assert.doesNotMatch(again.stdout, /WORKER_LOST/)
    assert.match(again.stderr, /아직 처리되지 않았다: ctx_bad/)
  })

  test('알린 기록은 Run 별로 남는다', () => {
    writeFileSync(lostState, JSON.stringify({ run_other: { ctx_bad: '2026-10-22T00:00:00Z' } }))
    const r = lostAtStart()
    assert.equal(r.code, 5, r.stdout + r.stderr)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(lostState, 'utf8'))).sort(), ['run_other', 'run_x'])
  })

  test('--ack-lost 는 대기 없이 handled 로 적고 다음 대기의 경고도 없앤다', () => {
    assert.equal(lostAtStart().code, 5)
    unlinkSync(log)
    const r = wait([], ['--ack-lost', 'ctx_bad', '--ack-lost', 'ctx_other'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, 'ACK_LOST ctx_bad ctx_other\n')
    assert.equal(existsSync(log), false, '확인 기록만 할 때 Orca 를 호출했다')
    const entry = lostEntries()
    for (const d of ['ctx_bad', 'ctx_other']) assert.match(String(entry[d]), /^handled /)
    const again = lostAtStart()
    assert.equal(again.code, 0, again.stdout + again.stderr)
    assert.doesNotMatch(again.stderr, /아직 처리되지 않았다/)
    assert.doesNotMatch(again.stdout, /WORKER_LOST/)
  })

  test('--ack-lost 는 다른 Run 과 확인하지 않은 dispatch 를 바꾸지 않는다', () => {
    writeFileSync(lostState, JSON.stringify({ run_other: { ctx_bad: 'lost old' }, run_x: { ctx_unhandled: 'lost old' } }))
    assert.equal(wait([], ['--ack-lost', 'ctx_bad']).code, 0)
    const data = JSON.parse(readFileSync(lostState, 'utf8'))
    assert.equal(data.run_other.ctx_bad, 'lost old')
    assert.equal(data.run_x.ctx_unhandled, 'lost old')
  })

  test('--ack-lost 가 기록하지 못하면 성공이 아니다', () => {
    mkdirSync(lostState)
    const r = wait([], ['--ack-lost', 'ctx_bad'])
    assert.equal(r.code, 1, r.stderr)
    assert.doesNotMatch(r.stdout, /ACK_LOST/)
  })

  test('읽지 못한 기록 파일이면 다시 알린다', () => {
    writeFileSync(lostState, 'not json')
    const r = lostAtStart()
    assert.equal(r.code, 5, r.stdout + r.stderr)
    assert.ok(Object.hasOwn(lostEntries(), 'ctx_bad'))
  })

  test('코디네이터가 닫았거나 worker 가 실패를 알린 dispatch 는 끊긴 것이 아니고 판정을 적어 다시 조회하지 않는다', () => {
    const closed = { id: 'ctx_bad', termination_reason: 'operator_close' }
    const reported = { id: 'ctx_bad', termination_reason: null, last_failure: JSON.stringify({ provenance: 'worker_report', outcome: 'failed' }) }
    for (const [latest, reason] of [
      [closed, 'operator_close'],
      [reported, 'worker_report'],
    ] as const) {
      rmSync(lostState, { force: true })
      const r = lostAtStart([], { taskStatus: 'ready', latest })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.doesNotMatch(r.stdout, /WORKER_LOST/)
      assert.ok(String(lostEntries().ctx_bad).startsWith(`${reason} `), JSON.stringify(lostEntries()))
    }
    unlinkSync(log)
    const r = lostAtStart([], { taskStatus: 'ready', latest: reported })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.deepEqual(
      allCalls().filter((c) => c.includes('dispatch-show')),
      [],
    )
    assert.doesNotMatch(r.stderr, /아직 처리되지 않았다/)
    unlinkSync(lostState)
    const missing = { id: 'ctx_bad', termination_reason: null, last_failure: 'The assigned worker terminal is no longer live' }
    assert.equal(lostAtStart([], { taskStatus: 'ready', latest: missing }).code, 5)
  })

  test('대기 중에 코디네이터가 닫은 worker 는 대기를 끝내지 않고 다시 묻지 않는다', () => {
    const closed = [worker('ctx_a', 'failed', 'failed', 'process_exited')]
    const r = wait([sleeping(batch('d9', 'worker_done'), 2)], ['--lost-interval-sec', '0.3'], {
      workers: [LIVE, LIVE, closed],
      tasks: [{ id: 't1', status: 'ready' }],
      latest: { t1: { id: 'ctx_a', termination_reason: 'operator_close' } },
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /WORKER_LOST/)
    assert.equal(lastLine(r.stdout), 'LAST_DELIVERY d9')
    assert.equal(allCalls().filter((c) => c.includes('dispatch-show')).length, 1)
  })

  test('대기 중에 끊긴 dispatch 도 기록한다', () => {
    const r = wait([sleeping(batch('d9', 'worker_done'), 5)], ['--lost-interval-sec', '0.3'], { workers: [LIVE, LIVE, GONE] })
    assert.equal(r.code, 5, r.stdout + r.stderr)
    assert.deepEqual(Object.keys(lostEntries()), ['ctx_a'])
  })

  test('최신 dispatch 를 읽지 못하면 시작할 때 지켜보지 않는다', () => {
    assert.equal(lostAtStart([], { latest: null }).code, 0)
  })

  test('간격이 0 이면 worker 상태를 보지 않는다', () => {
    const r = wait([batch('d1', 'worker_done')], ['--lost-interval-sec', '0'], { workers: [LIVE] })
    assert.equal(r.code, 0)
    assert.deepEqual(
      allCalls().filter((c) => c.includes('worker-list')),
      [],
    )
  })

  test('worker-list 는 --limit 100 으로 부르고 다음 페이지를 이어 읽는다', () => {
    assert.equal(wait([batch('d1', 'status')], ['--lost-interval-sec', '0.3']).code, 0)
    const list = allCalls().find((c) => c.includes('worker-list')) ?? []
    assert.equal(list[list.indexOf('--limit') + 1], '100', JSON.stringify(list))
  })

  test('nextCursor 를 둘째 호출의 --cursor 로 넘기고 둘째 페이지의 끊긴 worker 도 알린다', () => {
    const bad = worker('ctx_bad', 'abandoned', 'failed', 'terminal_missing')
    const r = wait([batch('d1', 'worker_done')], ['--lost-interval-sec', '0.3'], {
      workers: [{ workers: LIVE, nextCursor: 'c2' }, [bad]],
      tasks: [{ id: 't1', status: 'dispatched', result: null }],
      latest: { t1: 'ctx_bad' },
    })
    assert.equal(r.code, 5, r.stdout + r.stderr)
    assert.deepEqual(lines(r.stdout), ['WORKER_LOST ctx_bad stage=terminal_missing', 'LAST_DELIVERY -'])
    const pages = allCalls().filter((c) => c.includes('worker-list'))
    assert.equal(pages.length, 2, JSON.stringify(pages))
    assert.ok(!pages[0].includes('--cursor'), JSON.stringify(pages[0]))
    assert.equal(pages[1][pages[1].indexOf('--cursor') + 1], 'c2', JSON.stringify(pages[1]))
  })
})

describe('WATCH-ERROR', () => {
  test('시작 때 worker-list 가 실패하고 묶음이 오면 WATCH-ERROR 가 LAST_DELIVERY 앞이고 0 이다', () => {
    const r = wait([batch('d1', 'status')], ['--lost-interval-sec', '0.3'], { workers: ['fail'] })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const out = lines(r.stdout)
    const error = out.findIndex((line) => line.startsWith('WATCH-ERROR '))
    assert.ok(error >= 0 && error < out.indexOf('LAST_DELIVERY d1'), r.stdout)
    assert.equal(lastLine(r.stdout), 'LAST_DELIVERY d1')
    assert.match(r.stderr, /WATCH-ERROR /)
  })

  test('worker-list 의 nextCursor 가 되풀이되면 WATCH-ERROR 를 내고 대기는 이어 간다', () => {
    const page = { workers: LIVE, nextCursor: 'c2' }
    const r = wait([batch('d1', 'status')], ['--lost-interval-sec', '0.3'], { workers: [page, page] })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const out = lines(r.stdout)
    const error = out.indexOf('WATCH-ERROR 끊긴 worker 를 확인하지 못했다: worker-list 의 다음 페이지가 앞 페이지와 같다')
    assert.ok(error >= 0 && error < out.indexOf('LAST_DELIVERY d1'), r.stdout)
  })

  test('대기 중 worker-list 실패는 같은 이유를 한 번만 낸다', () => {
    const r = wait([sleeping(batch('d1', 'status'), 1.5)], ['--lost-interval-sec', '0.2'], { workers: [LIVE, 'fail', 'fail', 'fail', LIVE] })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(lines(r.stdout).filter((line) => line.startsWith('WATCH-ERROR ')).length, 1, r.stdout)
    assert.equal(lastLine(r.stdout), 'LAST_DELIVERY d1')
  })

  test('check --wait 가 실패하면 JSON, WATCH-ERROR, LAST_DELIVERY 순이고 남은 ack 를 지킨다', () => {
    const r = wait([batch('d1', 'heartbeat'), { ok: false, error: { code: 'runtime_unavailable' } }])
    assert.equal(r.code, 1)
    const out = lines(r.stdout)
    assert.match(out[0], /runtime_unavailable/)
    assert.match(out[1], /^WATCH-ERROR check --wait 가 실패했다: .*runtime_unavailable/)
    assert.equal(out[2], 'LAST_DELIVERY d1')
    assert.equal(out.length, 3)
  })
})

describe('대기', () => {
  test('worker_done 이 올 때까지 heartbeat 묶음을 ack 한다', () => {
    const r = wait([batch('d1', 'heartbeat', 'heartbeat'), batch('d2', 'heartbeat'), batch('d3', 'heartbeat', 'worker_done')])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(calls().map(ackOf), [null, 'd1', 'd2'])
    assert.equal(lastLine(r.stdout), 'LAST_DELIVERY d3')
    assert.equal(JSON.parse(lines(r.stdout)[0]).result.deliveryId, 'd3')
  })

  test('묶음 줄은 옛 명령과 같은 꼴의 JSON 한 줄이다', () => {
    const r = wait([batch('d1', 'status')])
    assert.equal(lines(r.stdout)[0], '{"ok": true, "result": {"deliveryId": "d1", "timedOut": false, "messages": [{"id": "d1-0", "type": "status"}]}}')
  })

  test('깨어나는 종류마다 대기가 끝난다', () => {
    for (const kind of ['question', 'escalation', 'status', 'worker_done']) {
      const r = wait([batch('d1', kind)], ['--ack', 'd0'])
      assert.equal(r.code, 0, kind)
      assert.match(r.stdout, /LAST_DELIVERY d1/)
      assert.equal(ackOf(calls().at(-1) ?? []), 'd0')
    }
  })

  test('--types 가 깨어나는 종류를 바꾼다', () => {
    const r = wait([batch('d1', 'status'), batch('d2', 'worker_done')], ['--types', 'worker_done'])
    assert.equal(r.code, 0)
    assert.deepEqual(calls().map(ackOf), [null, 'd1'])
    assert.match(r.stdout, /LAST_DELIVERY d2/)
    const first = calls()[0]
    assert.equal(first[first.indexOf('--types') + 1], 'worker_done')
  })

  test('heartbeat 를 ack 한 뒤 시간 한도가 지나면 남은 것이 없다', () => {
    const r = wait([batch('d1', 'heartbeat')], ['--timeout-ms', '1500'])
    assert.equal(r.code, 3)
    assert.equal(ackOf(calls()[1]), 'd1')
    assert.equal(lastLine(r.stdout), 'TIMEOUT LAST_DELIVERY -')
  })

  test('시간 한도에 걸린 heartbeat 묶음은 다음 대기에 남긴다', () => {
    const r = wait([sleeping(batch('d1', 'heartbeat'), 0.6)], ['--timeout-ms', '300'])
    assert.equal(r.code, 3)
    assert.equal(calls().length, 1)
    assert.equal(lastLine(r.stdout), 'TIMEOUT LAST_DELIVERY d1')
  })

  test('delivery 없이 시간 한도가 지난다', () => {
    const r = wait([], ['--timeout-ms', '300'])
    assert.equal(r.code, 3)
    assert.match(r.stdout, /TIMEOUT LAST_DELIVERY -/)
  })

  test('출력을 triage-messages 가 읽는다', () => {
    const r = wait([batch('d1', 'heartbeat', 'worker_done')])
    const file = join(tmp, 'out.txt')
    writeFileSync(file, `${r.stdout}\n[exited with code 0]\n`)
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', TRIAGE, file], { encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
    assert.match(done.stdout, /worker_done/)
  })

  test('사용법 오류는 2 다', () => {
    assert.equal(spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT], { env, cwd: tmp }).status, 2)
    assert.equal(wait([], ['--types', '']).code, 2)
    assert.equal(wait([], ['--timeout-ms', '1.5']).code, 2)
    assert.equal(wait([], ['--completion-contract', 'maybe']).code, 2)
  })
})

describe('신호', () => {
  test('SIGTERM 을 받으면 check --wait 자식을 끝내고 143 으로 나간다', { timeout: 60_000 }, async () => {
    const pidFile = join(tmp, 'check.pid')
    writeFileSync(stateFile, JSON.stringify({ replies: [sleeping(batch('d1', 'worker_done'), 30)], workers: [], tasks: [], latest: {}, history: [] }))
    const argv = ['--disable-warning=ExperimentalWarning', SCRIPT, '--run', 'run_x', '--lost-state', lostState, '--completion-contract', 'none', '--lost-interval-sec', '0']
    const child = spawn(process.execPath, argv, { env: { ...env, FAKE_PID: pidFile }, cwd: tmp })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    const until = async (done: () => boolean, what: string) => {
      const deadline = Date.now() + 20_000
      while (!done()) {
        assert.ok(Date.now() < deadline, what)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'), 'check --wait 가 뜨지 않았다')
    const orcaPid = Number(readFileSync(pidFile, 'utf8').trim())
    child.kill('SIGTERM')
    assert.equal(await closed, 143, stderr)
    assert.match(stderr, /SIGTERM 를 받아 check --wait 를 끝내고 나간다/)
    const gone = () => {
      try {
        process.kill(orcaPid, 0)
        return false
      } catch {
        return true
      }
    }
    await until(gone, `check --wait(pid ${orcaPid})가 남았다`)
  })
})

describe('남은 대기', () => {
  const WAITER_EXISTS = { ok: false, error: { code: 'waiter_exists', message: 'Run run_x already has an active actionable waiter.' } }

  function psLine(pid: number, ppid: number, command: string): string {
    return `${String(pid).padStart(5)} ${String(ppid).padStart(5)} Tue Oct 20 10:00:00 2026     ${command}`
  }

  function sleeper(): ChildProcess {
    return spawn('sleep', ['30'], { stdio: 'ignore' })
  }

  async function reap(...procs: ChildProcess[]): Promise<void> {
    for (const proc of procs) {
      if (proc.exitCode === null && proc.signalCode === null) {
        const closed = new Promise((resolve) => proc.once('exit', resolve))
        proc.kill('SIGKILL')
        await closed
      }
    }
  }

  function exited(proc: ChildProcess, ms: number): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  test('waiter_exists 를 받으면 바로 멈추고 남은 대기를 보인다', () => {
    writeFileSync(
      psRows,
      [
        psLine(101, 1, '/bin/zsh -c python3 wait-important.py --run run_x'),
        psLine(102, 101, 'python3 wait-important.py --run run_x'),
        psLine(103, 102, 'node orca orchestration check --run run_x --wait --json'),
        psLine(201, 900, 'node orca orchestration check --run run_x --wait --json'),
        psLine(301, 1, 'node orca orchestration check --run run_other --wait --json'),
        psLine(302, 1, 'node orca orchestration check --run run_x_extra --wait --json'),
        psLine(401, 1, 'node orca orchestration check --run run_x --json'),
      ].join('\n') + '\n',
    )
    const r = wait([WAITER_EXISTS, batch('d1', 'worker_done')], ['--ack', 'd0'])
    assert.equal(r.code, 4, r.stderr)
    assert.equal(calls().length, 1, 'waiter_exists 를 받고 다시 걸었다')
    assert.equal(lastLine(r.stdout), 'LAST_DELIVERY d0')
    assert.doesNotMatch(r.stdout, /WATCH-ERROR/)
    for (const pid of ['101', '102', '103', '201']) assert.ok(r.stderr.includes(`PID ${pid}`), pid)
    for (const pid of ['301', '302', '401']) assert.ok(!r.stderr.includes(`PID ${pid}`), pid)
    assert.match(r.stderr, /kill 101 102 103/)
    assert.match(r.stderr, /부모 900 살아 있음/)
  })

  test('메시지만으로도 waiter_exists 를 알아본다', () => {
    const r = wait([{ ok: false, error: { code: 'conflict', message: 'Run run_x already has an active actionable waiter.' } }])
    assert.equal(r.code, 4)
    assert.match(r.stderr, /찾지 못했다/)
  })

  test('--kill-stale 은 고아 대기만 종료한다', async () => {
    const orphan = sleeper()
    const live = sleeper()
    try {
      writeFileSync(
        psRows,
        [psLine(orphan.pid ?? 0, 1, 'node orca orchestration check --run run_x --wait --json'), psLine(live.pid ?? 0, 900, 'node orca orchestration check --run run_x --wait --json')].join('\n') + '\n',
      )
      const r = wait([WAITER_EXISTS], ['--kill-stale'])
      assert.equal(r.code, 4, r.stderr)
      assert.equal(await exited(orphan, 5000), true)
      assert.equal(live.exitCode, null)
      assert.ok(r.stderr.includes(`PID ${orphan.pid} 를 종료했다`), r.stderr)
    } finally {
      await reap(orphan, live)
    }
  })

  test('--kill-stale 은 대기가 아닌 고아 셸 조상도 따라간다', async () => {
    const orphan = sleeper()
    try {
      writeFileSync(
        psRows,
        [psLine(501, 1, '/bin/zsh'), psLine(502, 501, '/bin/bash -c runner'), psLine(orphan.pid ?? 0, 502, 'node orca orchestration check --run run_x --wait --json')].join('\n') + '\n',
      )
      const r = wait([WAITER_EXISTS], ['--kill-stale'])
      assert.equal(r.code, 4, r.stderr)
      assert.equal(await exited(orphan, 5000), true)
      assert.ok(r.stderr.includes(`PID ${orphan.pid} 를 종료했다`), r.stderr)
      assert.ok(!r.stderr.includes('PID 501 를 종료했다'), r.stderr)
    } finally {
      await reap(orphan)
    }
  })

  test('--kill-stale 은 살아 있는 앱 밑의 대기를 남긴다', async () => {
    const live = sleeper()
    try {
      writeFileSync(
        psRows,
        [psLine(501, 1, '/Applications/Orca.app/Contents/MacOS/Orca'), psLine(502, 501, '/bin/zsh'), psLine(live.pid ?? 0, 502, 'node orca orchestration check --run run_x --wait --json')].join('\n') + '\n',
      )
      const r = wait([WAITER_EXISTS], ['--kill-stale'])
      assert.equal(r.code, 4, r.stderr)
      assert.equal(live.exitCode, null)
      assert.doesNotMatch(r.stderr, /를 종료했다/)
    } finally {
      await reap(live)
    }
  })
})

describe('완료 계약', () => {
  const ids = { task_id: 'task_a', dispatch_id: 'ctx_a', from_handle: 'term_a' }
  const readyStatus = { type: 'status', subject: `준비됨 #123, head ${SHA}`, created_at: '2026-10-23T00:00:00Z', ...ids }

  function done(extra: Json = {}): Json {
    const reply = batch('d_done', 'worker_done')
    const messages = (reply.result as Json).messages as Json[]
    Object.assign(messages[0], ids, { created_at: '2026-10-23T00:00:01Z', payload: { outcome: 'succeeded' } }, extra)
    return reply
  }

  function capture(event: string, code = 0): string {
    const file = join(tmp, `${event}.json`)
    mkdirSync(join(tmp, '.orch/hooks'), { recursive: true })
    writeFileSync(
      join(tmp, `.orch/hooks/${event}.ts`),
      `import { readFileSync, writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(file)}, readFileSync(0, 'utf8'))\nconsole.log('확인했다')\nprocess.exitCode = ${code}\n`,
    )
    return file
  }

  function gh() {
    const pr = { number: 123, title: '기능', headRefName: 'feat/x', headRefOid: SHA, author: { login: 'jon' }, isDraft: false, url: 'https://example.test/pr/123' }
    const fake = fakeBin(tmp, 'gh', [{ args: ['pr', 'view', '123'], stdout: JSON.stringify(pr) }])
    env.GH = fake.path
    return fake
  }

  test('근거 없는 완료는 ack 하지 않고 6 이다', () => {
    const r = wait([batch('d_child', 'worker_done')], ['--lost-interval-sec', '0'], { contract: 'ready', historyFail: true })
    assert.equal(r.code, 6, r.stdout + r.stderr)
    assert.match(r.stdout, /의심스러운 worker_done/)
    assert.match(r.stdout, /suspicious_worker_done/)
    assert.equal(lastLine(r.stdout), 'LAST_DELIVERY d_child')
    assert.ok(calls().every((c) => !c.includes('--ack')))
    assert.doesNotMatch(r.stdout, /WATCH-ERROR/)
  })

  test('이미 ack 한 준비 상태를 이력에서 읽는다', () => {
    const r = wait([done()], ['--lost-interval-sec', '0'], { contract: 'ready', history: [readyStatus] })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /"status": "ready"/)
    assert.ok(calls().some((c) => c.includes('--all') && !c.includes('--wait')))
  })

  test('준비 상태가 있는 worker_done 은 worker-done 에 ready 와 gh 의 PR 을 넘기고 핸들러 줄이 JSON 앞이다', () => {
    const file = capture('worker-done')
    const fake = gh()
    const r = wait([done()], ['--lost-interval-sec', '0'], { contract: 'ready', history: [readyStatus] })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const out = lines(r.stdout)
    const json = out.findIndex((line) => line.startsWith('{'))
    assert.ok(out.indexOf('[hook worker-done] 확인했다') >= 0 && out.indexOf('[hook worker-done] 확인했다') < json, r.stdout)
    assert.equal(lastLine(r.stdout), 'LAST_DELIVERY d_done')
    const input = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(input.event, 'worker-done')
    assert.equal(input.run, 'run_x')
    assert.equal(input.evidence, 'ready')
    assert.equal(input.outcome, 'succeeded')
    assert.deepEqual(input.worker, { task: 'task_a', dispatch: 'ctx_a', terminal: 'term_a', worktree: null, spec: null })
    assert.deepEqual(input.pr, { number: 123, title: '기능', branch: 'feat/x', head: SHA, author: 'jon', draft: false, url: 'https://example.test/pr/123' })
    assert.equal(fake.calls()[0].cwd, tmp)
  })

  test('준비 상태가 없는 worker_done 은 suspicious 이고 pr 은 null, 6 이다', () => {
    const file = capture('worker-done')
    const fake = gh()
    const r = wait([done()], ['--lost-interval-sec', '0'], { contract: 'ready' })
    assert.equal(r.code, 6, r.stdout + r.stderr)
    const input = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(input.evidence, 'suspicious')
    assert.equal(input.pr, null)
    assert.deepEqual(fake.calls(), [])
  })

  test('실패 보고와 --completion-contract none 은 worker-done 을 내지 않는다', () => {
    const file = capture('worker-done')
    const failed = wait([done({ payload: { outcome: 'failed' } })], ['--lost-interval-sec', '0'], { contract: 'ready' })
    assert.equal(failed.code, 0, failed.stdout + failed.stderr)
    const none = wait([done()], ['--lost-interval-sec', '0'], { contract: 'none' })
    assert.equal(none.code, 0, none.stdout + none.stderr)
    assert.equal(existsSync(file), false)
    assert.doesNotMatch(failed.stdout + none.stdout, /\[hook worker-done\]/)
  })

  test('worker-done 핸들러가 실패해도 종료 코드는 그대로이고 HOOK-FAIL 줄을 남긴다', () => {
    capture('worker-done', 1)
    gh()
    const r = wait([done()], ['--lost-interval-sec', '0'], { contract: 'ready', history: [readyStatus] })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^HOOK-FAIL worker-done 1$/m)
    assert.equal(lastLine(r.stdout), 'LAST_DELIVERY d_done')
  })

  test('gh 가 PR 을 읽지 못하면 pr 은 null 이다', () => {
    const file = capture('worker-done')
    env.GH = fakeBin(tmp, 'gh', [{ stderr: 'not found', code: 1 }]).path
    assert.equal(wait([done()], ['--lost-interval-sec', '0'], { contract: 'ready', history: [readyStatus] }).code, 0)
    const input = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(input.evidence, 'ready')
    assert.equal(input.pr, null)
  })
})

describe('worker-lost', () => {
  test('WORKER_LOST 를 처음 낼 때 worker-lost 핸들러가 worker-list 행과 단계를 받는다', () => {
    const file = join(tmp, 'lost.json.input')
    mkdirSync(join(tmp, '.orch/hooks'), { recursive: true })
    writeFileSync(join(tmp, '.orch/hooks/worker-lost.ts'), `import { readFileSync, writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(file)}, readFileSync(0, 'utf8'))\nprocess.exitCode = 1\n`)
    const r = lostAtStart(['--ack', 'd0'])
    assert.equal(r.code, 5, r.stdout + r.stderr)
    const out = lines(r.stdout)
    assert.equal(out[0], 'WORKER_LOST ctx_bad stage=terminal_missing')
    assert.ok(out.includes('HOOK-FAIL worker-lost 1'), r.stdout)
    assert.equal(lastLine(r.stdout), 'LAST_DELIVERY d0')
    const input = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(input.event, 'worker-lost')
    assert.equal(input.stage, 'terminal_missing')
    assert.deepEqual(input.worker, { task: 't1', dispatch: 'ctx_bad', terminal: 'term_ctx_bad', worktree: null, spec: null })
    // 다음 대기는 다시 알리지 않으므로 핸들러도 다시 부르지 않는다
    rmSync(file)
    assert.equal(lostAtStart().code, 0)
    assert.equal(existsSync(file), false)
  })
})

describe('상주 루프', () => {
  function stateDir(): string {
    return join(tmp, '.orch', 'state')
  }

  // 살아 있는 루프다. pid 는 이 테스트 프로세스이고 alive_at 은 방금이다
  function loopJson(fields: Json = {}): void {
    mkdirSync(stateDir(), { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      join(stateDir(), 'loop.json'),
      JSON.stringify({ pid: process.pid, run: 'run_x', repo: tmp, tick_sec: 300, started_at: now, alive_at: now, last_tick: null, ticks: 0, errors: {}, ...fields }),
    )
  }

  function loopEvents(rows: Json[], cursor?: number): void {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(join(stateDir(), 'loop-events.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''))
    if (cursor !== undefined) writeFileSync(join(stateDir(), 'loop-events.cursor'), `${cursor}\n`)
  }

  function event(seq: number, kind: string, pr: number | null, text: string): Json {
    return { seq, time: '2026-10-25T00:00:00.000Z', kind, pr, text }
  }

  function cursor(): string {
    return readFileSync(join(stateDir(), 'loop-events.cursor'), 'utf8').trim()
  }

  const NEVER = () => [sleeping(batch('d9', 'worker_done'), 60)]

  test('커서 뒤의 두 줄을 LOOP-EVENT 로 내고 커서를 옮긴 뒤 7 이고, 다시 걸면 그 줄을 내지 않는다', () => {
    loopJson()
    loopEvents([event(1, 'REMINDER', null, '읽은 줄'), event(2, 'WATCH-ERROR', null, 'questions: offline'), event(3, 'CI-FAILED', 7, 'ci 실패')], 1)
    const r = wait(NEVER(), ['--ack', 'd0', '--lost-interval-sec', '0.2', '--loop-repo', tmp])
    assert.equal(r.code, 7, r.stdout + r.stderr)
    assert.deepEqual(lines(r.stdout), ['LOOP-EVENT WATCH-ERROR - questions: offline', 'LOOP-EVENT CI-FAILED 7 ci 실패', 'LAST_DELIVERY d0'])
    assert.equal(cursor(), '3')
    // 시작할 때 깨어났으므로 check 를 부르지 않았다. 넘긴 ack 는 그대로 남는다
    assert.deepEqual(calls(), [])
    const again = wait([batch('d1', 'status')], ['--lost-interval-sec', '0.2', '--loop-repo', tmp])
    assert.equal(again.code, 0, again.stdout + again.stderr)
    assert.ok(!again.stdout.includes('LOOP-EVENT'), again.stdout)
    assert.equal(lastLine(again.stdout), 'LAST_DELIVERY d1')
  })

  test('잘려 잃은 구간은 GAP 줄로 먼저 낸다', () => {
    loopJson()
    loopEvents([event(6, 'REMINDER', null, 'r')], 2)
    const r = wait(NEVER(), ['--lost-interval-sec', '0', '--loop-repo', tmp])
    assert.equal(r.code, 7, r.stdout + r.stderr)
    assert.deepEqual(lines(r.stdout), ['LOOP-EVENT GAP - seq 3..5 를 잃었다', 'LOOP-EVENT REMINDER - r', 'LAST_DELIVERY -'])
    assert.equal(cursor(), '6')
  })

  test('대기 중에 알림이 생기면 check --wait 를 끝내고 7 이다', { timeout: 60_000 }, async () => {
    loopJson()
    const pidFile = join(tmp, 'check.pid')
    writeFileSync(stateFile, JSON.stringify({ replies: NEVER(), workers: [], tasks: [], latest: {}, history: [] }))
    const argv = ['--disable-warning=ExperimentalWarning', SCRIPT, '--run', 'run_x', '--lost-state', lostState, '--completion-contract', 'none', '--lost-interval-sec', '0.2', '--loop-repo', tmp]
    const child = spawn(process.execPath, argv, { env: { ...env, FAKE_PID: pidFile }, cwd: tmp })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    const deadline = Date.now() + 20_000
    while (!(existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'))) {
      assert.ok(Date.now() < deadline, 'check --wait 가 뜨지 않았다')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const orcaPid = Number(readFileSync(pidFile, 'utf8').trim())
    loopEvents([event(1, 'HOOK-FAIL', null, 'tick 1')])
    assert.equal(await closed, 7, stdout)
    assert.deepEqual(lines(stdout), ['LOOP-EVENT HOOK-FAIL - tick 1', 'LAST_DELIVERY -'])
    assert.equal(cursor(), '1')
    const gone = () => {
      try {
        process.kill(orcaPid, 0)
        return false
      } catch {
        return true
      }
    }
    const until = Date.now() + 20_000
    while (!gone()) {
      assert.ok(Date.now() < until, `check --wait(pid ${orcaPid})가 남았다`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })

  test('alive_at 이 오래된 루프는 LOOP-DEAD 와 8 이다', () => {
    // pid 는 이 테스트 프로세스라 루프 프로세스가 아니다. 다시 보지 않고 바로 죽음이다
    loopJson({ alive_at: new Date(Date.now() - 3600_000).toISOString(), tick_sec: 10 })
    const r = wait(NEVER(), ['--ack', 'd0', '--lost-interval-sec', '0', '--loop-repo', tmp])
    assert.equal(r.code, 8, r.stdout + r.stderr)
    const out = lines(r.stdout)
    assert.match(out[0], new RegExp(`^LOOP-DEAD ${tmp} alive_at \\S+ 이후 응답 없음$`))
    assert.deepEqual(out.slice(1), ['LAST_DELIVERY d0'])
  })

  // 명령줄에 orch-loop 가 든 살아 있는 프로세스다. loop.json 의 pid 로 쓰면 루프 프로세스로 보인다
  async function fakeLoop(t: TestContext): Promise<number> {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'orch-loop'], { stdio: 'ignore' })
    t.after(() => child.kill('SIGKILL'))
    await new Promise((resolve) => child.once('spawn', resolve))
    return child.pid as number
  }

  // 생존 타이머 간격 1초에 여유 1.5초다. 운영 기본은 30초에 5초다
  const RECHECK_MS = 2_500
  const LOOP_ENV = { ORCH_LOOP_ALIVE_SEC: '1', ORCH_LOOP_RECHECK_MARGIN_SEC: '1.5' }

  test('루프 pid 가 살아 있으면 오래된 alive_at 은 다시 본 뒤에야 LOOP-DEAD 와 8 이다. 간격이 0 이어도 다시 본다', { timeout: 60_000 }, async (t) => {
    loopJson({ pid: await fakeLoop(t), alive_at: new Date(Date.now() - 3600_000).toISOString(), tick_sec: 10 })
    const started = Date.now()
    const r = wait(NEVER(), ['--ack', 'd0', '--lost-interval-sec', '0', '--loop-repo', tmp], {}, LOOP_ENV)
    const elapsed = Date.now() - started
    assert.equal(r.code, 8, r.stdout + r.stderr)
    assert.ok(elapsed >= RECHECK_MS, `다시 보기 전에 끝났다: ${elapsed}ms`)
    const out = lines(r.stdout)
    assert.match(out[0], new RegExp(`^LOOP-DEAD ${tmp} alive_at \\S+ 이후 응답 없음$`))
    assert.deepEqual(out.slice(1), ['LAST_DELIVERY d0'])
  })

  test('오래된 alive_at 이지만 루프 pid 가 살아 있고 기다리는 사이 alive_at 이 새로 써지면 LOOP-DEAD 가 아니다', { timeout: 60_000 }, async (t) => {
    loopJson({ pid: await fakeLoop(t), alive_at: new Date(Date.now() - 3600_000).toISOString(), tick_sec: 10 })
    const pid = JSON.parse(readFileSync(join(stateDir(), 'loop.json'), 'utf8')).pid as number
    // 다시 보는 시각 뒤에 묶음이 온다
    writeFileSync(stateFile, JSON.stringify({ replies: [sleeping(batch('d1', 'status'), RECHECK_MS / 1000 + 3)], workers: [], tasks: [], latest: {}, history: [] }))
    const argv = ['--disable-warning=ExperimentalWarning', SCRIPT, '--run', 'run_x', '--lost-state', lostState, '--completion-contract', 'none', '--lost-interval-sec', '0.2', '--loop-repo', tmp]
    const child = spawn(process.execPath, argv, { env: { ...env, ...LOOP_ENV }, cwd: tmp })
    t.after(() => child.kill('SIGKILL'))
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    // 잠들었다 깬 루프의 생존 타이머가 다시 쓴 것이다
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    loopJson({ pid })
    assert.equal(await closed, 0, stdout)
    assert.doesNotMatch(stdout, /LOOP-DEAD/)
    assert.equal(lastLine(stdout), 'LAST_DELIVERY d1')
  })

  test('알림 줄이 있으면 죽음보다 먼저 내고, 다음 대기가 죽음을 낸다', () => {
    loopEvents([event(1, 'REMINDER', null, 'r')])
    assert.equal(wait(NEVER(), ['--lost-interval-sec', '0', '--loop-repo', tmp]).code, 7)
    const r = wait(NEVER(), ['--lost-interval-sec', '0', '--loop-repo', tmp])
    assert.equal(r.code, 8, r.stdout + r.stderr)
    assert.deepEqual(lines(r.stdout), [`LOOP-DEAD ${tmp} 없음`, 'LAST_DELIVERY -'])
  })

  describe('여러 Run', () => {
    function runEvents(run: string, rows: Json[]): void {
      mkdirSync(join(stateDir(), 'loop-events'), { recursive: true })
      writeFileSync(join(stateDir(), 'loop-events', `${run}.jsonl`), rows.map((row) => `${JSON.stringify(row)}\n`).join(''))
    }

    function register(run: string): void {
      mkdirSync(join(stateDir(), 'loop-runs'), { recursive: true })
      writeFileSync(join(stateDir(), 'loop-runs', `${run}.json`), JSON.stringify({ run, specs_dir: null, registered_at: '2026-10-25T00:00:00.000Z' }))
    }

    test('다른 Run 의 알림에는 깨어나지 않고 자기 Run 의 알림만 내며 커서도 자기 Run 의 파일에 쓴다', () => {
      loopJson({ runs: ['run_other', 'run_x'] })
      register('run_other')
      register('run_x')
      runEvents('run_other', [event(1, 'CI-FAILED', 7, '남의 실패')])
      const quiet = wait([batch('d1', 'status')], ['--lost-interval-sec', '0.2', '--loop-repo', tmp])
      assert.equal(quiet.code, 0, quiet.stdout + quiet.stderr)
      assert.ok(!quiet.stdout.includes('LOOP-'), quiet.stdout)
      runEvents('run_x', [event(1, 'REMINDER', null, '내 질문')])
      const r = wait(NEVER(), ['--ack', 'd0', '--lost-interval-sec', '0.2', '--loop-repo', tmp])
      assert.equal(r.code, 7, r.stdout + r.stderr)
      assert.deepEqual(lines(r.stdout), ['LOOP-EVENT REMINDER - 내 질문', 'LAST_DELIVERY d0'])
      assert.equal(readFileSync(join(stateDir(), 'loop-events', 'run_x.cursor'), 'utf8').trim(), '1')
      assert.ok(!existsSync(join(stateDir(), 'loop-events', 'run_other.cursor')))
    })

    test('Run 등록을 아는 살아 있는 루프에 이 Run 이 없으면 미등록 LOOP-DEAD 와 8 이다', () => {
      loopJson({ runs: ['run_other'] })
      register('run_other')
      const r = wait(NEVER(), ['--ack', 'd0', '--lost-interval-sec', '0.2', '--loop-repo', tmp])
      assert.equal(r.code, 8, r.stdout + r.stderr)
      assert.deepEqual(lines(r.stdout), [`LOOP-DEAD ${tmp} run run_x 미등록`, 'LAST_DELIVERY d0'])
    })

    test('옛 루프(runs 가 없다)에는 미등록 판정을 하지 않고, 다른 Run 의 옛 루프 알림에는 깨어나지 않고 커서도 옮기지 않는다', () => {
      loopJson({ run: 'run_other' })
      loopEvents([event(1, 'CI-FAILED', 7, '남의 옛 알림')])
      const quiet = wait([batch('d1', 'status')], ['--lost-interval-sec', '0.2', '--loop-repo', tmp])
      assert.equal(quiet.code, 0, quiet.stdout + quiet.stderr)
      assert.ok(!quiet.stdout.includes('LOOP-'), quiet.stdout)
      assert.ok(!existsSync(join(stateDir(), 'loop-events.cursor')))
    })

    test('이 Run 이나 Run 없이 띄운 옛 루프의 알림은 옛 파일에서 읽는다', () => {
      for (const run of ['run_x', null]) {
        loopJson({ run })
        loopEvents([event(1, 'REMINDER', null, '옛 알림')], 0)
        const r = wait(NEVER(), ['--ack', 'd0', '--lost-interval-sec', '0.2', '--loop-repo', tmp])
        assert.equal(r.code, 7, r.stdout + r.stderr)
        assert.deepEqual(lines(r.stdout), ['LOOP-EVENT REMINDER - 옛 알림', 'LAST_DELIVERY d0'])
        assert.equal(cursor(), '1')
      }
    })

    test('Run 없이 띄운 새 루프(runs 가 빈 목록)의 알림도 옛 파일에서 읽는다', () => {
      loopJson({ runs: [] })
      loopEvents([event(1, 'WATCH-ERROR', null, 'prs: offline')], 0)
      const r = wait(NEVER(), ['--ack', 'd0', '--lost-interval-sec', '0.2', '--loop-repo', tmp])
      assert.equal(r.code, 7, r.stdout + r.stderr)
      assert.deepEqual(lines(r.stdout), ['LOOP-EVENT WATCH-ERROR - prs: offline', 'LAST_DELIVERY d0'])
      assert.equal(cursor(), '1')
    })
  })

  test('--loop-repo 가 없으면 알림 파일과 루프 상태를 보지 않는다', () => {
    loopEvents([event(1, 'REMINDER', null, 'r')])
    const r = wait([batch('d1', 'status')], ['--lost-interval-sec', '0.2'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.ok(!r.stdout.includes('LOOP-'), r.stdout)
    assert.ok(!existsSync(join(stateDir(), 'loop-events.cursor')))
  })
})

describe('wait-important.py shim', () => {
  test('옛 경로가 같은 줄과 종료 코드로 넘긴다', () => {
    const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(stateFile, JSON.stringify({ replies: [batch('d1', 'status')], workers: [] }))
    const done = spawnSync(python, [SHIM, '--run', 'run_x', '--lost-state', lostState, '--lost-interval-sec', '0'], { env, cwd: tmp, encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
    assert.equal(lastLine(done.stdout), 'LAST_DELIVERY d1')
    assert.equal(spawnSync(python, [SHIM], { env, cwd: tmp }).status, 2)
  })
})
