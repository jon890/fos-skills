// core/followups.ts 의 배포 뒤 할 일 목록 규칙을 순수 함수로 본다.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dueFollowups, followupLine, markDone, markNotified, noticeText, parseFollowups, pruneFollowups, undeployedFollowups, upsertFollowup,
} from '../scripts/core/followups.ts'
import type { Followup } from '../scripts/core/followups.ts'

const AT = '2026-11-20T01:00:00.000Z'
const entry = (pr: number, deploy: Followup['deploy'] = 'success') => ({ pr, title: `제목 ${pr}`, text: `배포 후 smoke ${pr}`, merge_commit: 'a'.repeat(40), deploy })

test('새 PR 은 더하고, 끝나지 않은 같은 PR 은 알림 기록을 지키며 글만 바꾼다', () => {
  const first = upsertFollowup([], entry(787), AT)
  assert.equal(first.result, 'added')
  const notified = markNotified(first.items, [787], AT)
  const again = upsertFollowup(notified, { ...entry(787), text: '새 글' }, '2026-11-21T00:00:00.000Z')
  assert.equal(again.result, 'updated')
  assert.equal(again.items.length, 1)
  assert.equal(again.items[0].text, '새 글')
  assert.equal(again.items[0].notified_at, AT)
  assert.equal(again.items[0].added_at, AT)
})

test('이미 끝낸 PR 은 다시 옮기지 않는다', () => {
  const done = markDone(upsertFollowup([], entry(787), AT).items, 787, AT, '확인')
  assert.equal(done.result, 'done')
  const again = upsertFollowup(done.items, entry(787), AT)
  assert.equal(again.result, 'done')
  assert.equal(again.items, done.items)
})

test('배포를 확인한 항목이 다시 옮겨질 때 배포 결과를 timeout 으로 되돌리지 않는다', () => {
  const items = upsertFollowup([], entry(1, 'success'), AT).items
  assert.equal(upsertFollowup(items, entry(1, 'timeout'), AT).items[0].deploy, 'success')
})

test('알릴 항목은 배포를 확인했고(success, none) 알리지 않았고 끝나지 않은 것뿐이다', () => {
  let items = [entry(1, 'success'), entry(2, 'none'), entry(3, 'timeout'), entry(4, 'failure'), entry(5, 'success')]
    .reduce((list, one) => upsertFollowup(list, one, AT).items, [] as Followup[])
  items = markNotified(items, [5], AT)
  items = markDone(items, 2, AT, null).items
  assert.deepEqual(dueFollowups(items).map((item) => item.pr), [1])
  assert.deepEqual(undeployedFollowups(items).map((item) => item.pr), [3, 4])
})

test('끝내기는 없는 PR 과 이미 끝난 PR 을 구분한다', () => {
  const items = upsertFollowup([], entry(1), AT).items
  assert.equal(markDone(items, 2, AT, null).result, 'missing')
  const done = markDone(items, 1, AT, null)
  assert.equal(markDone(done.items, 1, AT, null).result, 'already')
})

test('끝난 지 30일이 지난 항목만 뺀다', () => {
  let items = [entry(1), entry(2), entry(3)].reduce((list, one) => upsertFollowup(list, one, AT).items, [] as Followup[])
  items = markDone(items, 1, '2026-10-01T00:00:00.000Z', null).items
  items = markDone(items, 2, '2026-11-10T00:00:00.000Z', null).items
  assert.deepEqual(pruneFollowups(items, Date.parse(AT)).map((item) => item.pr), [2, 3])
})

test('배포 설정이 없는 항목은 알림에서 배포를 확인하지 않았다고 쓴다', () => {
  const mixed = [entry(787), { ...entry(789), deploy: 'none' as const }].reduce((list, one) => upsertFollowup(list, one, AT).items, [] as Followup[])
  const text = noticeText(mixed)
  assert.match(text, /^- #789 .*\(머지됨, 배포는 확인하지 않음: 배포 설정 없음\)/m)
  assert.doesNotMatch(text.split('\n').find((line) => line.startsWith('- #787')) ?? '', /배포는 확인하지 않음/)
  const only = noticeText(mixed.filter((item) => item.pr === 789))
  assert.match(only, /^배포 뒤 할 일 1건이 머지됐다\. 배포 설정이 없어/)
  assert.doesNotMatch(only, /배포까지 끝났다/)
})

test('파일 값의 형식이 틀린 항목은 버리고 모르는 배포 값은 timeout 으로 읽는다', () => {
  const items = parseFollowups({ items: [{ pr: 'x', text: 'a' }, { pr: 3, text: '' }, { pr: 4, text: '글', deploy: '???' }, null] })
  assert.deepEqual(items.map((item) => [item.pr, item.deploy]), [[4, 'timeout']])
  assert.deepEqual(parseFollowups(null), [])
})

test('묶은 알림은 건수와 PR 마다 한 줄, 끝내는 명령을 담는다', () => {
  const items = [entry(787), entry(789)].reduce((list, one) => upsertFollowup(list, one, AT).items, [] as Followup[])
  const text = noticeText(items)
  assert.match(text, /^배포 뒤 할 일 2건/)
  assert.match(text, /orch followup done <PR>/)
  assert.match(text, /^- #787 제목 787: 배포 후 smoke 787$/m)
  assert.match(text, /^- #789 /m)
  assert.equal(followupLine(items[0]), 'FOLLOWUP #787 배포 확인 배포 후 smoke 787')
})
