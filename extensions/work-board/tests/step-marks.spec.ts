import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStepMark, withStepMark } from '../hooks/step-marks.js'
import { parseEventTag } from '../hooks/event-tags.js'

test('단계 표시와 조건, 사건 꼬리표를 함께 읽는다', () => {
  for (const [text, number, mark, condition, body] of [
    ['2. [auto] PR4 (계획: a)', 2, 'auto', null, 'PR4 (계획: a)'],
    ['3) [ask] real 활성화', 3, 'ask', null, 'real 활성화'],
    ['4 [wait] 기획 답', 4, 'wait', null, '기획 답'],
    ['5. [wait: 2026-11-10 19:00] 회차', 5, 'wait', '2026-11-10 19:00', '회차'],
    ['✓ 2. [auto] PR4', 2, 'auto', null, 'PR4'],
  ]) assert.deepEqual(parseStepMark(text), { number, mark, condition, body })
  assert.equal(parseStepMark('5. [wait] 기획 답 (#665 merge)')?.mark, 'wait')
  assert.deepEqual(parseEventTag('5. [wait] 기획 답 (#665 merge)'), { pr: '665', event: 'merge' })
})

test('모르는 표시는 본문으로 남기고 단계가 아닌 입력은 거절한다', () => {
  for (const body of ['PR4', '[maybe] PR4', '[Auto] PR4', '[auto: x] PR4', '[wait:] x', '[auto]PR4', '[merge] 머지'])
    assert.deepEqual(parseStepMark(`2. ${body}`), { number: 2, mark: null, condition: null, body })
  for (const text of ['참고: [auto] 글', '9.머지', 3]) {
    assert.equal(parseStepMark(text), null)
    assert.equal(withStepMark(text, 'auto'), null)
  }
})

test('앞 번호와 본문을 보존하며 표시를 바꾼다', () => {
  assert.equal(withStepMark('2. [auto] PR4 (계획: a)', 'ask'), '2. [ask] PR4 (계획: a)')
  assert.equal(withStepMark('2. [auto] PR4 (계획: a)', null), '2. PR4 (계획: a)')
  assert.equal(withStepMark('2. PR4', 'wait', '2026-11-10 19:00'), '2. [wait: 2026-11-10 19:00] PR4')
  assert.equal(withStepMark('✓ 2. PR4', 'auto'), '✓ 2. [auto] PR4')
  for (const [mark, condition] of [['maybe', null], ['wait', ']'], ['wait', '\n'], ['auto', 'x']])
    assert.equal(withStepMark('2. PR4', mark, condition), null)
})
