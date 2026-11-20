import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextCron, updateSchedules, visibleSchedules, scheduleLine } from '../hooks/schedules.js'
import { watchSchedule } from '../hooks/register.js'

const at = new Date(2026, 10, 20, 10, 0).getTime()
const create = { tool: 'CronCreate', cron: '*/5 * * * *', prompt: 'CI 결과를 확인한다\n자세한 안내', recurring: true }
const answer = { result: { id: 'job-1', humanSchedule: '5분마다', recurring: true, nextFireAt: at + 300000 } }

test('성공한 만들기와 지우기 결과만 예약 목록에 반영한다', () => {
  const rows = updateSchedules([], create, answer, at)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].next, at + 300000)
  assert.match(scheduleLine(rows[0]), /5분마다 · CI 결과를 확인한다 · 다음 .* · 만료 /)
  assert.deepEqual(updateSchedules(rows, { tool: 'CronDelete', id: 'job-1' }, { result: { id: 'job-1' } }, at), [])
  assert.equal(updateSchedules(rows, { tool: 'CronDelete', id: 'job-1' }, { isError: true, result: { id: 'job-1' } }, at), rows)
})

test('실패와 모양이 다른 호출은 목록을 바꾸지 않는다', () => {
  assert.deepEqual(updateSchedules([], create, { deny: 'refused' }, at), [])
  assert.deepEqual(updateSchedules([], create, { isError: true, result: { id: 'job-1' } }, at), [])
  assert.deepEqual(updateSchedules([], { ...create, cron: { value: '* * * * *' } }, answer, at), [])
  assert.deepEqual(updateSchedules([], create, { result: { id: 3 } }, at), [])
  assert.deepEqual(updateSchedules([], { tool: 'CronDelete', id: 'job-1' }, { result: { id: 'other' } }, at), [])
})

test('한 번만 도는 예약과 만료된 반복 예약은 사라진다', () => {
  const once = updateSchedules([], { ...create, recurring: false }, { result: { ...answer.result, recurring: false } }, at)
  assert.equal(visibleSchedules(once, at + 299999).length, 1)
  assert.deepEqual(visibleSchedules(once, at + 300000), [])
  const repeat = updateSchedules([], create, answer, at)
  assert.equal(visibleSchedules(repeat, at + 300000).length, 1)
  assert.deepEqual(visibleSchedules(repeat, at + 7 * 86400000), [])
})

test('cron 식은 로컬 시간의 범위·간격·요일을 읽는다', () => {
  assert.equal(nextCron('*/5 * * * *', at), at + 300000)
  assert.equal(nextCron('broken', at), null)
  const friday = new Date(2026, 10, 20, 10, 0).getDay()
  assert.equal(nextCron(`0 11 * * ${friday}`, at), new Date(2026, 10, 20, 11, 0).getTime())
})

test('도구 훅은 원래 결과를 돌려주고 세션 상태만 갱신한다', async () => {
  let stored = []
  const $ = { state: { get: async () => ({ value: stored, version: 1 }), set: async (_ref, rows) => { stored = rows; return { isSet: true } } },
    clock: { now: async () => at }, ui: { invalidate: () => {} } }
  const result = await watchSchedule($, create, async () => answer)
  assert.equal(result, answer)
  assert.equal(stored[0].id, 'job-1')
  await watchSchedule($, { tool: 'CronDelete', id: 'job-1' }, async () => ({ result: { id: 'job-1' } }))
  assert.deepEqual(stored, [])
  assert.equal(await watchSchedule({ ...$, state: undefined }, create, async () => answer), answer)
})
