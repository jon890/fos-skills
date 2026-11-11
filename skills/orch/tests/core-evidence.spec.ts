import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvidence, withoutEvidence } from '../scripts/core/evidence.ts'
import { prSteps } from '../scripts/core/board.ts'

test('스펙·계획·앞 사건 근거만 읽고 같은 괄호를 뗀다', () => {
  assert.deepEqual(parseEvidence('PR4 (계획: docs/a/tasks/pr4)'), [{ kind: 'plan', path: 'docs/a/tasks/pr4', text: '계획: docs/a/tasks/pr4' }])
  assert.deepEqual(parseEvidence('x (스펙: /abs/spec.md) (앞 사건: #665 merge)'), [
    { kind: 'spec', path: '/abs/spec.md', text: '스펙: /abs/spec.md' },
    { kind: 'event', pr: '665', event: 'merge', text: '앞 사건: #665 merge' },
  ])
  assert.equal(parseEvidence('x (앞 사건: 665 deploy)')[0]?.kind, 'event')
  for (const text of ['x (#665 merge)', 'x (계획: )', 'x (앞 사건: #665 build)', 'x (앞 사건: #0 merge)', 'x (메모: y)', 'x (계획: docs/(a))']) {
    assert.deepEqual(parseEvidence(text), [])
    assert.equal(withoutEvidence(text), text)
  }
  assert.equal(withoutEvidence('4. [auto] PR4 (앞 사건: #665 merge)'), '4. [auto] PR4 ')
  for (const text of ['3. 머지 (#665 merge)', '2. PR #665 리뷰 반영']) assert.equal(withoutEvidence(text), text)
})

test('PR 참조를 고를 때 근거 번호는 제외하고 일반 참조는 보존한다', () => {
  const steps = [
    { number: 1, done: false, text: '1. PR #665 구현' },
    { number: 2, done: false, text: '2. [auto] PR4 (앞 사건: #665 merge)' },
    { number: 3, done: true, text: '3. PR4 (#665 이어서)' },
    { number: 4, done: false, text: '4. [auto] 다음 (계획 : docs/#665)' },
  ]
  assert.deepEqual(prSteps(steps, '665'), [1])
  assert.deepEqual(prSteps(steps, '665', true), [1, 3])
})
