import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextCron, updateSchedules, visibleSchedules, scheduleLine, scheduleDetail, scheduleSoon, sortSchedules,
  cronText, promptTitle, whenText } from '../hooks/schedules.js'

let moduleIndex = 0
async function freshWatchSchedule() {
  const module = await import('../hooks/register.js?test=' + ++moduleIndex)
  return module.watchSchedule
}

const at = new Date(2026, 10, 20, 10, 0).getTime()
// Claude Code 2.1.329 plugin-authoring/types/claude-code.d.ts:
// ToolEnvelope(17695)와 CronCreate 인자(21879)는 한 객체에 펼쳐지고,
// ToolCallResult(17335)의 성공 값은 result 안에 든다.
const create = { tool: 'CronCreate', tool_use_id: 'test-create', cron: '*/5 * * * *',
  prompt: 'CI 결과를 확인한다\n자세한 안내', recurring: true }
const remove = { tool: 'CronDelete', tool_use_id: 'test-delete', id: 'job-1' }
const answer = { result: { id: 'job-1', humanSchedule: '5분마다', recurring: true, nextFireAt: at + 300000 } }

test('성공한 만들기와 지우기 결과만 예약 목록에 반영한다', () => {
  const rows = updateSchedules([], create, answer, at)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].next, at + 300000)
  assert.equal(scheduleLine(rows[0], at), '오늘 10:05  ↻ CI 결과를 확인한다 · 5분마다')
  assert.deepEqual(updateSchedules(rows, remove, { result: { id: 'job-1' } }, at), [])
  assert.equal(updateSchedules(rows, remove, { isError: true, result: { id: 'job-1' } }, at), rows)
})

test('실패와 모양이 다른 호출은 목록을 바꾸지 않는다', () => {
  assert.deepEqual(updateSchedules([], create, { deny: 'refused' }, at), [])
  assert.deepEqual(updateSchedules([], create, { isError: true, result: { id: 'job-1' } }, at), [])
  assert.deepEqual(updateSchedules([], { ...create, cron: { value: '* * * * *' } }, answer, at), [])
  assert.deepEqual(updateSchedules([], create, { result: { id: 3 } }, at), [])
  assert.deepEqual(updateSchedules([], remove, { result: { id: 'other' } }, at), [])
})

test('한 번만 도는 예약과 만료된 반복 예약은 사라진다', () => {
  const once = updateSchedules([], { ...create, recurring: false }, { result: { ...answer.result, recurring: false } }, at)
  assert.equal(visibleSchedules(once, at + 299999).length, 1)
  assert.deepEqual(visibleSchedules(once, at + 300000), [])
  const repeat = updateSchedules([], create, answer, at)
  assert.equal(visibleSchedules(repeat, at + 300000).length, 1)
  assert.deepEqual(visibleSchedules(repeat, at + 7 * 86400000), [])
  const shifted = updateSchedules([], create, { result: { ...answer.result, nextFireAt: at + 300000 + 30000 } }, at)
  assert.equal(visibleSchedules(shifted, at + 300000 + 30000)[0].next, at + 600000 + 30000)
})

test('cron 식은 로컬 시간의 범위·간격·요일을 읽는다', () => {
  assert.equal(nextCron('*/5 * * * *', at), at + 300000)
  assert.equal(nextCron('broken', at), null)
  assert.equal(nextCron('0 0 1 1 *', at), new Date(2027, 0, 1).getTime())
  assert.equal(nextCron('0 0 29 2 *', new Date(2027, 0, 1).getTime()), new Date(2028, 1, 29).getTime())
  assert.equal(nextCron('0 0 */2 * 1', at), new Date(2026, 10, 23).getTime())
  assert.equal(nextCron('0 9 */2 * 1', new Date(2026, 10, 24, 10).getTime()), new Date(2026, 11, 7, 9).getTime())
  assert.equal(nextCron('0 0 23 * */2', at), new Date(2027, 0, 23).getTime())
  assert.equal(nextCron('0 9 23 * */2', at), new Date(2027, 0, 23, 9).getTime())
  const friday = new Date(2026, 10, 20, 10, 0).getDay()
  assert.equal(nextCron(`0 11 * * ${friday}`, at), new Date(2026, 10, 20, 11, 0).getTime())
})

test('도구 훅은 원래 결과를 돌려주고 세션 상태만 갱신한다', async () => {
  const watchSchedule = await freshWatchSchedule()
  let stored = []
  let conflicts = 1
  const $ = { state: { get: async () => ({ value: stored, version: 1 }), set: async (ref, rows, options) => {
    assert.equal(ref.plugin, 'fos-skills')
    assert.equal(ref.key, 'board-schedules')
    assert.equal(options.ifVersion, 1)
    if (conflicts-- > 0) return { isSet: false }
    stored = rows
    return { isSet: true }
  } },
    clock: { now: async () => at }, ui: { invalidate: () => {} } }
  const result = await watchSchedule($, create, async () => answer)
  assert.equal(result, answer)
  assert.equal(stored[0].id, 'job-1')
  await watchSchedule($, remove, async () => ({ result: { id: 'job-1' } }))
  assert.deepEqual(stored, [])
  assert.equal(await watchSchedule({ ...$, state: undefined }, create, async () => answer), answer)
})

test('세션 상태 갱신이 계속 충돌하면 화면의 예약 목록은 유지한다', async () => {
  const watchFresh = await freshWatchSchedule()
  let attempts = 0
  let invalidations = 0
  const $ = {
    state: {
      get: async () => ({ value: [], version: attempts }),
      set: async () => { attempts++; return { isSet: false } },
    },
    clock: { now: async () => at },
    ui: { invalidate: () => { invalidations++ } },
  }
  assert.equal(await watchFresh($, create, async () => answer), answer)
  assert.equal(attempts, 3)
  assert.equal(invalidations, 1)
  await watchFresh({ ...$, state: undefined }, remove, async () => ({ result: { id: 'job-1' } }))
  assert.equal(invalidations, 2)
})

test('다음 도구 이벤트에서 실행이 끝난 예약을 세션 상태에서 지운다', async () => {
  const watchSchedule = await freshWatchSchedule()
  const oneShot = updateSchedules([], { ...create, recurring: false },
    { result: { ...answer.result, recurring: false } }, at)
  let stored = oneShot
  let writes = 0
  const $ = {
    state: {
      get: async () => ({ value: stored, version: 1 }),
      set: async (_ref, rows) => { stored = rows; writes++; return { isSet: true } },
    },
    clock: { now: async () => at + 300000 },
    ui: { invalidate: () => {} },
  }
  await watchSchedule($, { ...remove, id: 'other' }, async () => ({ result: { id: 'other' } }))
  assert.deepEqual(stored, [])
  assert.equal(writes, 1)
})

const row = (over = {}) => ({ id: 'job', cron: '47 7,19 * * *', prompt: '[회차 뒤 점검, 한국어로만 보고] 방금 끝난 회차를 본다\n둘째 줄',
  schedule: '47 7,19 * * *', recurring: true, next: at + 3600000, offset: 0, expires: at + 7 * 86400000, ...over })

test('줄은 다음 실행, 반복 표시, [...] 제목, 읽는 주기 순이고 본문 앞부분은 빠진다', () => {
  assert.equal(scheduleLine(row(), at), '오늘 11:00  ↻ 회차 뒤 점검, 한국어로만 보고 · 매일 07:47, 19:47')
  const once = row({ cron: '4 19 27 11 *', recurring: false, expires: null, next: new Date(2026, 10, 21, 19, 4).getTime(), prompt: '긴 첫 줄'.repeat(20) })
  assert.equal(scheduleLine(once, at), '내일 19:04  1회 ' + promptTitle(once.prompt) + ' · 한 번, 11/21 19:04')
  assert.equal(promptTitle(once.prompt).length, 40)
  assert.ok(promptTitle(once.prompt).endsWith('…'))
  assert.equal(promptTitle('첫 줄\n[둘째 줄 제목]'), '첫 줄')
})

test('다음 실행은 오늘, 내일, 그 뒤는 날짜로 쓴다', () => {
  assert.equal(whenText(new Date(2026, 10, 20, 19, 4).getTime(), at), '오늘 19:04')
  assert.equal(whenText(new Date(2026, 10, 21, 7, 47).getTime(), at), '내일 07:47')
  assert.equal(whenText(new Date(2026, 10, 22, 0, 0).getTime(), at), '11/22 00:00')
})

test('cron 식은 매일 시각과 한 번만 읽는 말로 바꾸고 그 밖은 도구의 말이나 원래 식이다', () => {
  assert.equal(cronText(row()), '매일 07:47, 19:47')
  assert.equal(cronText(row({ cron: '0,30 9 * * *' })), '매일 09:00, 09:30')
  assert.equal(cronText(row({ recurring: false, next: new Date(2026, 10, 27, 19, 4).getTime() })), '한 번, 11/27 19:04')
  assert.equal(cronText(row({ cron: '*/5 * * * *', schedule: '5분마다' })), '5분마다')
  assert.equal(cronText(row({ cron: '0 9 * * 1', schedule: '0 9 * * 1' })), '0 9 * * 1')
  assert.equal(cronText(row({ cron: '0 9-18 * * *', schedule: '0 9-18 * * *' })), '0 9-18 * * *')
})

test('다음 실행 순서로 세우고 한 시간 안에 도는 줄만 가깝다고 본다', () => {
  const rows = [row({ id: 'late', next: at + 7200000 }), row({ id: 'soon', next: at + 600000 }), row({ id: 'edge', next: at + 3600000 })]
  assert.deepEqual(sortSchedules(rows).map((r) => r.id), ['soon', 'edge', 'late'])
  assert.deepEqual(rows.map((r) => r.id), ['late', 'soon', 'edge'])
  assert.deepEqual(rows.map((r) => scheduleSoon(r, at)), [false, true, true])
})

test('펼친 자리에는 원래 식, 만료, 세션 한정 안내, 프롬프트 전문이 있다', () => {
  const detail = scheduleDetail(row())
  assert.equal(detail[0], 'cron 47 7,19 * * * · 만료 11/27 10:00')
  assert.match(detail[1], /세션이 끝나면 사라져요/)
  assert.equal(detail[2], row().prompt)
  assert.equal(scheduleDetail(row({ expires: null }))[0], 'cron 47 7,19 * * *')
})
