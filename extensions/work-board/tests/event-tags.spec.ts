import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseEventTag } from '../bin/board.ts'
import { hideEventTag, stageTag, withEventTag } from '../hooks/event-tags.js'
import { stepRows } from '../hooks/register.js'

test('번호 단계 끝의 PR 과 알려진 사건만 읽는다', () => {
  for (const event of ['pr', 'merge', 'deploy', 'release']) {
    assert.deepEqual(parseEventTag(`✓ 3. 반영 (#665 ${event})`), { pr: '665', event })
  }
  for (const text of ['3. 반영', '3. 반영 (#665 build)', '참고 (#665 merge)', '3. 반영 (#0 merge)', '3. 반영 (#665 merge) 뒤']) assert.equal(parseEventTag(text), null, text)
})

test('창은 꼬리표만 숨기고 원본과 완료 값을 보존한다', () => {
  const item = { details: [{ text: '3. 반영 (#665 merge)', done: false }] }
  assert.equal(stepRows(item)[0].text, '3. 반영')
  assert.equal(stepRows(item)[0].state, 'now')
  assert.equal(item.details[0].text, '3. 반영 (#665 merge)')
  assert.equal(hideEventTag('참고 (#665 merge)'), '참고 (#665 merge)')
})

test('단계 번호 뒤의 알려진 사건 표시만 읽는다', () => {
  assert.equal(stageTag('2. [merge] 머지'), 'merge')
  assert.equal(stageTag('✓ 2. [Deploy] 배포'), 'deploy')
  for (const text of ['2. [auto] PR4', '2. 머지', '참고 [merge]', '2. [x] 확인']) assert.equal(stageTag(text), null)
})

test('줄 끝 꼬리표를 붙이거나 바꾸고 원래 글을 되찾는다', () => {
  for (const text of ['3. 머지', '3. 머지 (#1 pr)']) {
    const tagged = withEventTag(text, '1455', 'merge')
    assert.equal(tagged, '3. 머지 (#1455 merge)')
    assert.deepEqual(parseEventTag(tagged), { pr: '1455', event: 'merge' })
    assert.equal(hideEventTag(tagged), '3. 머지')
  }
})
