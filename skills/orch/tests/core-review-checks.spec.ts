// core/review-checks.ts 의 리뷰 체크 판정을 본다.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewCheckPassed, reviewRunning } from '../scripts/core/review-checks.ts'

const run = (over: Record<string, unknown>) => ({ __typename: 'CheckRun', name: 'claude-review', ...over })

test('가장 늦게 시작한 실행으로 정한다', () => {
  const rollup = [
    run({ status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-24T00:00:00Z' }),
    run({ status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-24T01:00:00Z' }),
  ]
  assert.equal(reviewCheckPassed(rollup, 'claude-review'), true)
  assert.equal(reviewRunning(rollup, 'claude-review'), false)
  assert.equal(reviewCheckPassed(rollup.slice(0, 1), 'claude-review'), false)
})

// PR 619 리뷰: 대기 중인 재실행은 startedAt 이 없다. 옛 success 가 가리면 통과로 보이고 최신화가 HEAD 를 옮긴다
test('시작 시각이 없는 대기 중 재실행은 옛 success 보다 늦은 것으로 본다', () => {
  const rollup = [
    run({ status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-24T01:00:00Z' }),
    run({ status: 'QUEUED', conclusion: null }),
  ]
  assert.equal(reviewCheckPassed(rollup, 'claude-review'), false)
  assert.equal(reviewRunning(rollup, 'claude-review'), true)
  assert.equal(reviewCheckPassed([rollup[1], rollup[0]], 'claude-review'), false)
})

test('StatusContext 는 context 와 state 로 읽고, 체크가 없으면 통과도 진행 중도 아니다', () => {
  assert.equal(reviewCheckPassed([{ context: 'claude-review', state: 'SUCCESS' }], 'claude-review'), true)
  assert.equal(reviewRunning([{ context: 'claude-review', state: 'PENDING' }], 'claude-review'), true)
  assert.equal(reviewCheckPassed([], 'claude-review'), false)
  assert.equal(reviewRunning(null, 'claude-review'), false)
})
