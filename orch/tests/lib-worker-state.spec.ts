// lib/worker-state.ts 의 판정 갈래를 본다. 조회 없이 행, PR, 앞선 커밋 수, 화면 상태만 넘긴다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isFinished, isLive, judge, screenHandles } from '../scripts/lib/worker-state.ts'
import type { ScreenState } from '../scripts/lib/screen.ts'

type Row = Record<string, unknown>

function row(over: Row = {}, resource: Row = {}): Row {
  return {
    dispatchId: 'ctx_a',
    dispatchStatus: 'completed',
    workerState: 'succeeded',
    agentTerminalHandle: 'term_a',
    ...over,
    resource: { terminalHandle: 'term_a', ownershipState: 'owned', ...resource },
  }
}

const takeover = { ownershipState: 'user_owned', retainedReason: 'user_takeover' }
const screens = (state: ScreenState) => new Map<unknown, ScreenState>([['term_a', state]])

describe('행의 분류', () => {
  test('살아 있는 dispatch 와 끝난 dispatch 를 가른다', () => {
    assert.ok(isLive(row({ dispatchStatus: 'dispatched', workerState: 'ready' })))
    assert.ok(isLive(row({ workerState: 'working' })))
    assert.ok(!isLive(row({ dispatchStatus: 'dispatched', workerState: 'abandoned' })))
    for (const status of ['completed', 'failed', 'canceled']) assert.ok(isFinished(row({ dispatchStatus: status, workerState: 'fenced' })))
    assert.ok(isFinished(row({ dispatchStatus: 'dispatched', workerState: 'stopped', terminalState: 'released' })))
    assert.ok(!isFinished(row({ dispatchStatus: 'dispatched', workerState: 'stopped' })))
  })
})

describe('judge', () => {
  test('행이 없으면 판정하지 못한다', () => {
    assert.deepEqual(judge({ rows: [] }), { state: 'unknown', reason: '그 경로의 dispatch 를 모른다' })
  })

  test('살아 있는 dispatch 는 PR 을 보지 않아도 일하는 중이다', () => {
    const verdict = judge({ rows: [row({ dispatchStatus: 'running', workerState: 'working' })] })
    assert.equal(verdict.state, 'working')
    assert.match(verdict.reason, /살아 있는 dispatch ctx_a/)
  })

  test('user_takeover 표시라도 화면이 작업 중이면 일하는 중이고 근거를 남긴다', () => {
    for (const state of ['working', 'permission'] as const) {
      const verdict = judge({ rows: [row({ dispatchStatus: 'dispatched', workerState: 'ready' }, takeover)], screens: screens(state) })
      assert.equal(verdict.state, 'working')
      assert.match(verdict.reason, /user_takeover 표시지만 화면이 작업 중이다\(ctx_a, term_a\)/)
    }
  })

  test('user_takeover 표시이고 화면이 작업 중이 아니면 사용자가 넘겨받았다', () => {
    const live = row({ dispatchStatus: 'dispatched', workerState: 'ready' }, takeover)
    assert.equal(judge({ rows: [live], screens: screens('idle') }).state, 'taken_over')
    const unread = judge({ rows: [live] })
    assert.equal(unread.state, 'taken_over')
    assert.match(unread.reason, /화면 못 읽음/)
  })

  test('코디네이터 것으로 확인한 터미널은 소유 표시를 보지 않는다', () => {
    const live = row({ dispatchStatus: 'dispatched', workerState: 'ready' }, takeover)
    assert.equal(judge({ rows: [live], own: new Set(['term_a']) }).state, 'working')
  })

  test('끝난 dispatch 의 터미널을 사용자가 넘겨받았으면 PR 이 MERGED 여도 넘겨받음이다', () => {
    const verdict = judge({ rows: [row({}, takeover)], pr: { state: 'MERGED', number: 7 }, screens: screens('idle') })
    assert.equal(verdict.state, 'taken_over')
  })

  test('터미널이 없으면(화면이 없으면) 옛 소유 표시로 붙잡지 않는다', () => {
    assert.equal(judge({ rows: [row({}, takeover)], pr: { state: 'MERGED' } }).state, 'done')
  })

  test('끝난 dispatch 라도 화면이 작업 중이면 일하는 중이다', () => {
    const verdict = judge({ rows: [row({ dispatchStatus: 'failed', workerState: 'failed' })], pr: 'none', ahead: 0, screens: screens('working') })
    assert.equal(verdict.state, 'working')
    assert.match(verdict.reason, /failed 지만 화면이 작업 중이다/)
  })

  test('끊긴 dispatch 는 판정하지 못한다', () => {
    const verdict = judge({ rows: [row({ dispatchStatus: 'dispatched', workerState: 'abandoned' })], pr: { state: 'MERGED' } })
    assert.deepEqual(verdict, { state: 'unknown', reason: '끝나지 않은 dispatch ctx_a' })
  })

  test('completed, failed, released dispatch 이고 PR 이 MERGED 면 끝났다', () => {
    const rows = [
      row({ dispatchStatus: 'completed' }),
      row({ dispatchStatus: 'failed', workerState: 'failed' }),
      row({ dispatchStatus: 'dispatched', workerState: 'stopped', terminalState: 'released' }),
    ]
    for (const r of rows) {
      const verdict = judge({ rows: [r], pr: { state: 'MERGED', number: 3 } })
      assert.equal(verdict.state, 'done', JSON.stringify(r))
      assert.match(verdict.reason, /PR #3 MERGED/)
    }
  })

  test('끝난 dispatch 이고 PR 이 없고 앞선 커밋이 0 이면 끝났다', () => {
    assert.equal(judge({ rows: [row({ dispatchStatus: 'failed', workerState: 'failed' })], pr: 'none', ahead: 0 }).state, 'done')
  })

  test('PR 과 앞선 커밋에 따라 끝남이 아니다', () => {
    const r = [row()]
    const cases: [Parameters<typeof judge>[0], string, RegExp][] = [
      [{ rows: r }, 'unknown', /PR 을 보지 않았다/],
      [{ rows: r, pr: 'error' }, 'unknown', /PR 조회 실패/],
      [{ rows: r, pr: { state: 'OPEN', number: 4 } }, 'working', /PR #4 이 열려 있어/],
      [{ rows: r, pr: { state: 'CLOSED', number: 5 } }, 'unknown', /PR #5 이 머지 없이 CLOSED/],
      [{ rows: r, pr: 'none' }, 'unknown', /앞선 커밋을 세지 않았다/],
      [{ rows: r, pr: 'none', ahead: null }, 'unknown', /세지 못했다/],
      [{ rows: r, pr: 'none', ahead: 2 }, 'unknown', /base 보다 앞선 커밋 2 개/],
    ]
    for (const [facts, state, reason] of cases) {
      const verdict = judge(facts)
      assert.equal(verdict.state, state, JSON.stringify(facts))
      assert.match(verdict.reason, reason)
    }
  })
})

describe('screenHandles', () => {
  test('살아 있는 행은 넘겨받은 것만, 끝난 행은 살아 있는 터미널만 고른다', () => {
    const rows = [
      row({ dispatchId: 'ctx_1', dispatchStatus: 'dispatched', workerState: 'ready', agentTerminalHandle: 'term_1' }, { terminalHandle: 'term_1', ...takeover }),
      row({ dispatchId: 'ctx_2', dispatchStatus: 'dispatched', workerState: 'ready', agentTerminalHandle: 'term_2' }, { terminalHandle: 'term_2' }),
      row({ dispatchId: 'ctx_3', agentTerminalHandle: 'term_3' }, { terminalHandle: 'term_3' }),
      row({ dispatchId: 'ctx_4', agentTerminalHandle: 'term_4' }, { terminalHandle: 'term_4' }),
    ]
    assert.deepEqual(screenHandles(rows), ['term_1'])
    assert.deepEqual(screenHandles(rows, new Set(), new Set(['term_3'])), ['term_1', 'term_3'])
    assert.deepEqual(screenHandles(rows, new Set(['term_1'])), [])
  })
})
