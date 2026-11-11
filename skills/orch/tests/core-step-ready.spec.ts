import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LIMITED_PAUSE_MS as PAUSE, readyNotices, waitTimeMs } from '../scripts/core/step-ready.ts'
import type { ReadyNotice, ReadyStep } from '../scripts/core/step-ready.ts'

const now = 2_000_000_000
const step: ReadyStep = { id: 'a', active: true, done: false, step: '2. [auto] 다음', mark: 'auto', busy: false, launched: false }
const notice: ReadyNotice = { step: step.step!, mark: 'auto', at: now, again: null }

test('새 단계는 알리고 같은 글은 유지한다. 성공 전에는 기록하지 않는다', () => {
  const first = readyNotices({}, [step], now, null)
  assert.deepEqual(first.records, {})
  assert.deepEqual(first.fire, [{ id: 'a', notice }])
  const same = readyNotices({ a: notice }, [step], now + 1, null)
  assert.deepEqual(same, { records: { a: notice }, fire: [] })
  assert.equal(readyNotices({ a: notice }, [{ ...step, step: '2. [auto] 다른 일' }], now + 1, null).fire.length, 1)
})

test('worker 가 떠도 기록은 유지하고, 글이 바뀌거나 항목이 끝나면 지운다', () => {
  assert.deepEqual(readyNotices({ a: notice }, [{ ...step, busy: true }], now, null), { records: { a: notice }, fire: [] })
  assert.deepEqual(readyNotices({ a: notice }, [{ ...step, step: '3. 다른 단계', mark: null }], now, null).records, {})
  assert.deepEqual(readyNotices({ a: notice }, [{ ...step, done: true }], now, null).records, {})
  assert.deepEqual(readyNotices({ a: notice }, [], now, null).records, {})
})

test('조회 실패는 auto 기록을 그대로 두고 ask 는 worker·PR 에 관계없이 알린다', () => {
  const unknown = { ...step, busy: null, step: '2. [auto] 바뀐 글' }
  assert.deepEqual(readyNotices({ a: notice }, [unknown], now, null), { records: { a: notice }, fire: [] })
  for (const busy of [true, null]) assert.equal(readyNotices({}, [{ ...step, mark: 'ask', busy }], now, null).fire.length, 1)
  for (const row of [{ ...step, active: false }, { ...step, mark: 'wait' as const }, { ...step, mark: null }])
    assert.equal(readyNotices({}, [row], now, null).fire.length, 0)
})

test('한도 30분 경계에서 기존 미실행 auto 만 한 번 더 알린다', () => {
  const previous = { a: notice }
  assert.deepEqual(readyNotices(previous, [step], now + PAUSE - 1, now).fire, [])
  const again = readyNotices(previous, [step], now + PAUSE, now).fire
  assert.deepEqual(again, [{ id: 'a', notice: { ...notice, at: now + PAUSE, again: now } }])
  assert.deepEqual(readyNotices({ a: again[0].notice }, [step], now + PAUSE + 1, now).fire, [])
  assert.deepEqual(readyNotices(previous, [{ ...step, launched: true }], now + PAUSE, now).fire, [])
  assert.deepEqual(readyNotices(previous, [{ ...step, mark: 'ask' }], now + PAUSE, now).fire, [])
  const late = { ...notice, at: now + PAUSE }
  assert.deepEqual(readyNotices({ a: late }, [step], now + PAUSE + 1, now).fire, [])
  const newerLimit = now + PAUSE
  assert.equal(readyNotices({ a: again[0].notice }, [step], newerLimit + PAUSE, newerLimit).fire.length, 1)
})

test('시각은 로컬 시간으로 읽으며 자동 보정된 날짜와 글 조건은 거절한다', () => {
  const parsed = waitTimeMs('2026-11-12 19:05')!
  const local = new Date(parsed)
  assert.deepEqual([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes()], [2026, 10, 12, 19, 5])
  for (const value of [null, '내일 아침', '2026-02-30 19:00', '2026-13-01 19:00', '2026-11-12 24:00', '2026-11-12 19:60', '2026-1-12 19:00'])
    assert.equal(waitTimeMs(value), null, String(value))
})
