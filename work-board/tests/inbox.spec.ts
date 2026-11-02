// 알림 상자가 쓰는 순수 함수를 본다. 화면은 pane.test.ts 가 본다.
//
// 실행: node --test work-board/tests/inbox.spec.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dismissArgv, INBOX_PROMPT, inboxBoxVisible, inboxRows, inboxSourceLabel, inboxSummary, inboxTag, parseInbox, replyPrompt, statusLine, withoutItems } from '../hooks/register.js'

const ITEM = {
  id: 'dooray:task:comment:c1', adapter: 'dooray', source: 'task', kind: 'mention', title: '어드민개발/81 어드민 권한 정리',
  url: '', scope: [], from: { id: '1', name: '김철수' }, at: '2026-11-02T05:00:00.000Z', excerpt: '', target: {}, state: 'new',
}

test('설정이 없으면 알림을 그리지 않고 상태 줄에도 넣지 않는다 (R6)', () => {
  assert.deepEqual(inboxSummary({ enabled: false }), { show: false, newCount: 0 })
  assert.deepEqual(inboxSummary(null), { show: false, newCount: 0 })
  assert.equal(statusLine([], {}, { enabled: false }), '')
})

test('새 알림이 있으면 상태 줄 맨 앞에 「알림 n」 을 붙인다', () => {
  const state = { enabled: true, newCount: 2, items: [] }
  assert.deepEqual(inboxSummary(state), { show: true, newCount: 2 })
  assert.equal(statusLine([{ status: 'doing' }], { workers: [] }, state), '알림 2 · worker 0 · 진행 1   /board')
  assert.equal(statusLine([], {}, { ...state, newCount: 0 }), '')
})

test('inbox.ts 출력을 읽고 형식이 다르면 던진다', () => {
  assert.equal(parseInbox('{"enabled":false}').enabled, false)
  assert.equal(parseInbox(JSON.stringify({ enabled: true, items: [ITEM] })).items.length, 1)
  assert.throws(() => parseInbox('{}'), /enabled/)
  assert.throws(() => parseInbox('{"enabled":true}'), /items/)
  assert.throws(() => parseInbox('not json'))
})

test('출처와 머리말을 사람이 읽는 이름으로 바꾼다 (R7)', () => {
  assert.equal(inboxSourceLabel('dooray:messenger'), '두레이 메신저')
  assert.equal(inboxSourceLabel('dooray:task'), '두레이 업무')
  assert.equal(inboxSourceLabel('slack:channel'), 'slack:channel')
  assert.equal(inboxTag(ITEM), '두레이')
  assert.equal(inboxTag({ ...ITEM, source: 'messenger' }), '메신저')
  assert.equal(inboxTag({ ...ITEM, adapter: 'slack' }), 'slack')
})

test('답변 요청문은 맥락, 초안, 미리보기, 확인 뒤 등록 순서를 담는다 (R4)', () => {
  const text = replyPrompt(ITEM)
  const order = ['inbox.ts context dooray:task:comment:c1', '초안', '--yes 없이', '확인 전에는 등록하지 마', '--yes 를 붙여']
  let at = -1
  for (const part of order) {
    const next = text.indexOf(part)
    assert.ok(next > at, part)
    at = next
  }
  assert.ok(text.includes('김철수의 멘션'))
  assert.ok(INBOX_PROMPT.includes('확인 전에는 등록하지 마'))
  assert.ok(INBOX_PROMPT.includes('inbox.ts dismiss'))
})

test('알림함이 켜진 것을 본 뒤에만 명령 실패를 상자로 보인다 (R6, R7)', () => {
  assert.equal(inboxBoxVisible({ enabled: false }, '', false), false)
  assert.equal(inboxBoxVisible(null, 'node 없음', false), false)
  assert.equal(inboxBoxVisible(null, 'node 없음', true), true)
  assert.equal(inboxBoxVisible({ enabled: true, items: [] }, '', false), true)
  assert.equal(inboxSourceLabel('dooray:auth'), '두레이 인증')
})

test('답한 알림은 목록에서 빼고 수만 센다', () => {
  const answered = { ...ITEM, id: 'a', state: 'answered' }
  assert.deepEqual(inboxRows([ITEM, answered]), { shown: [ITEM], answered: 1 })
  assert.deepEqual(inboxRows(undefined), { shown: [], answered: 0 })
})

test('넘긴 알림을 빼고 새 알림 수를 줄인다', () => {
  const answered = { ...ITEM, id: 'a', state: 'answered' }
  const other = { ...ITEM, id: 'b' }
  const state = { enabled: true, newCount: 2, items: [ITEM, other, answered] }
  assert.deepEqual(withoutItems(state, [ITEM.id, 'a']), { enabled: true, newCount: 1, items: [other] })
  assert.equal(withoutItems(null, ['x']), null)
  assert.deepEqual(withoutItems({ enabled: false }, ['x']), { enabled: false })
})

test('넘김은 inbox.ts dismiss 를 부르고 되돌리기는 --undo 를 붙인다', () => {
  assert.deepEqual(dismissArgv('/p/inbox.ts', 'id1'), ['node', '--disable-warning=ExperimentalWarning', '/p/inbox.ts', 'dismiss', 'id1'])
  assert.deepEqual(dismissArgv('/p/inbox.ts', 'id1', true).slice(-2), ['id1', '--undo'])
})
