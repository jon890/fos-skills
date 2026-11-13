import assert from 'node:assert/strict'
import { test } from 'node:test'
import { distinctPaths, getAt, parsePath, rejectedProblems, setAt, unsetAt } from '../scripts/core/config-edit.ts'

test('경로 문법과 서로 겹치는 경로를 거절한다', () => {
  assert.deepEqual(parsePath('hooks.timeouts.after-queue'), ['hooks', 'timeouts', 'after-queue'])
  for (const path of ['queue', '.queue.a', 'queue..a', 'queue.a.']) assert.throws(() => parsePath(path))
  assert.deepEqual(parsePath('queu', 1), ['queu'])
  assert.throws(() => distinctPaths([['queue', 'a'], ['queue', 'a']]))
  assert.throws(() => distinctPaths([['queue'], ['queue', 'a']]))
  distinctPaths([['queue', 'a'], ['queue', 'ab']])
})

test('객체만 따라가고 빈 부모를 지우며 프로토타입 속성은 다루지 않는다', () => {
  const raw = {}
  setAt(raw, ['hooks', 'timeouts', 'after-queue'], 30)
  assert.equal(getAt(raw, ['hooks', 'timeouts', 'after-queue']), 30)
  assert.equal(unsetAt(raw, ['hooks', 'timeouts', 'after-queue']), true)
  assert.deepEqual(raw, {})
  assert.equal(unsetAt(raw, ['hooks']), false)
  assert.equal(getAt(raw, ['constructor']), undefined)
  setAt(raw, ['__proto__', 'value'], 1)
  assert.equal(getAt(raw, ['__proto__', 'value']), 1)
  assert.equal(Object.getPrototypeOf(raw), Object.prototype)
  assert.equal(unsetAt(raw, ['__proto__', 'value']), true)
  for (const value of [null, 2, 'x', []]) {
    assert.throws(() => setAt({ x: value }, ['x', 'y'], true))
    assert.throws(() => unsetAt({ x: value }, ['x', 'y']))
    assert.equal(getAt({ x: value }, ['x', 'y']), undefined)
  }
})

test('바꾼 키와 관련 짝은 기존 오류여도 거절하고 기존의 다른 문제는 허용한다', () => {
  const typo = { path: 'queue.typo', reason: '모르는 키', kind: 'unknown' }
  const value = { path: 'queue.poll_min_sec', reason: '양수', kind: 'value' }
  const pair = { path: 'queue.poll_min_sec', reason: '최솟값 초과', kind: 'pair' }
  const pairs = { queue: [{ keys: ['poll_min_sec', 'poll_max_sec'] }] }
  assert.deepEqual(rejectedProblems([typo, value], [typo, value], [['queue', 'poll_min_sec']], pairs), [value])
  assert.deepEqual(rejectedProblems([typo, pair], [typo, pair], [['queue', 'poll_max_sec']], pairs), [pair])
  assert.deepEqual(rejectedProblems([typo], [typo, pair], [['queue', 'required']], pairs), [pair])
  assert.deepEqual(rejectedProblems([typo, pair], [typo, pair], [['pipeline', 'tick_sec']], pairs), [])
  assert.deepEqual(rejectedProblems([], [{ ...value, path: 'queue.auto_review.require[0]' }], [['queue', 'auto_review', 'pass']], {}), [{ ...value, path: 'queue.auto_review.require[0]' }])
})
