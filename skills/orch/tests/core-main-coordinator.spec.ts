// core/main-coordinator.ts 의 메인 판정, 답 대상, 요청 상태 전이를 값만으로 본다.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ackOverdue, boardIds, isClosed, judgeMain, needsReason, nextRequestState, replyKind, replyTarget } from '../scripts/core/main-coordinator.ts'
import type { TerminalFact } from '../scripts/core/main-coordinator.ts'
import type { RunEntry } from '../scripts/core/loop.ts'

const entry = (run: string, terminal: string | null = null, at = '2026-11-17T00:00:00.000Z'): RunEntry => ({ run, specs_dir: null, registered_at: at, coordinator_terminal: terminal })
const fact = (handle: string, agent: boolean, connected = true): [string, TerminalFact] => [handle, { handle, agent, connected }]

test('메인은 등록 순서로 첫 Run 가운데 코디네이터 터미널에서 에이전트가 실행 중인 Run 이다', () => {
  const coordinators = new Map([['r1', 't1'], ['r2', 't2']])
  const terminals = new Map([fact('t1', false), fact('t2', true)])
  assert.deepEqual(judgeMain([entry('r1'), entry('r2')], coordinators, terminals), { kind: 'main', run: 'r2', terminal: 't2', alive: ['r2'] })
})

test('셸만 남은 터미널, 끊긴 터미널, 목록에 없는 터미널은 살아 있지 않다', () => {
  const coordinators = new Map([['r1', 't1'], ['r2', 't2'], ['r3', 't3']])
  const terminals = new Map([fact('t1', false), fact('t2', true, false)])
  assert.deepEqual(judgeMain([entry('r1'), entry('r2'), entry('r3')], coordinators, terminals), { kind: 'none', stale: ['r1', 'r2', 'r3'] })
})

test('같은 Run 에 묶인 다른 터미널(등록 파일의 코디네이터 터미널)도 메인으로 본다', () => {
  const coordinators = new Map([['r1', 't1']])
  const terminals = new Map([fact('t1', false), fact('t9', true)])
  assert.deepEqual(judgeMain([entry('r1', 't9')], coordinators, terminals), { kind: 'main', run: 'r1', terminal: 't9', alive: ['r1'] })
})

test('살아 있는 Run 이 여럿이면 앞 Run 이 메인이고 alive 에 모두 담는다', () => {
  const coordinators = new Map([['r1', 't1'], ['r2', 't2']])
  const terminals = new Map([fact('t1', true), fact('t2', true)])
  assert.deepEqual(judgeMain([entry('r1'), entry('r2')], coordinators, terminals), { kind: 'main', run: 'r1', terminal: 't1', alive: ['r1', 'r2'] })
})

test('등록이 없으면 메인이 없다', () => {
  assert.deepEqual(judgeMain([], new Map(), new Map()), { kind: 'none', stale: [] })
})

test('답은 보낸 Run 이 살아 있으면 그 Run, 아니면 보낸 저장소의 메인, 그것도 없으면 보낸 Run 으로 간다', () => {
  assert.equal(replyTarget('a', true, 'm'), 'a')
  assert.equal(replyTarget('a', false, 'm'), 'm')
  assert.equal(replyTarget('a', false, null), 'a')
})

test('요청 상태 전이와 이유가 필요한 동작', () => {
  assert.equal(nextRequestState('sent', 'accept'), 'accepted')
  assert.equal(nextRequestState('held', 'reject'), 'rejected')
  assert.equal(nextRequestState('accepted', 'done'), 'done')
  assert.equal(nextRequestState('accepted', 'accept'), null)
  assert.equal(nextRequestState('accepted', 'reject'), null)
  for (const closed of ['rejected', 'done', 'failed'] as const) {
    assert.equal(isClosed(closed), true)
    assert.equal(nextRequestState(closed, 'done'), null)
  }
  assert.deepEqual(['accept', 'hold', 'reject', 'done', 'fail'].filter((a) => needsReason(a as never)), ['hold', 'reject', 'fail'])
  assert.equal(replyKind('held'), 'REQUEST-HELD')
})

test('보드 항목 id 는 받는 쪽 req-<n>, 다른 저장소면 보낸 쪽 req-<받는 저장소 이름>-<n>', () => {
  assert.deepEqual(boardIds(12, 'fos-skills', false), { to: 'req-12', from: 'req-fos-skills-12' })
  assert.deepEqual(boardIds(3, 'my repo', true), { to: 'req-3', from: null })
})

test('답 없음 알림은 sent 이고 알리지 않았고 기한이 지났을 때만이다', () => {
  const created = '2026-11-17T00:00:00.000Z'
  const at = Date.parse(created)
  assert.equal(ackOverdue('sent', created, null, at + 1799_000, 1800), false)
  assert.equal(ackOverdue('sent', created, null, at + 1800_000, 1800), true)
  assert.equal(ackOverdue('sent', created, '2026-11-17T00:31:00.000Z', at + 3600_000, 1800), false)
  assert.equal(ackOverdue('accepted', created, null, at + 3600_000, 1800), false)
})
