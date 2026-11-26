import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ciState, currentChecks, judgeChecks, requiredCiState } from '../scripts/core/checks.ts'

const success = { name: 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS' }
const options = { required: ['Tests'], allowNoChecks: true }

test('큐 체크 판단은 실패 행의 수를 보존하고 허용한 이름은 실패에서 뺀다', () => {
  const review = { name: 'Review, Bot', status: 'COMPLETED', conclusion: 'FAILURE' }
  const lint = { context: 'lint', state: 'ERROR' }
  const result = judgeChecks([success, review, lint, lint], { ...options, allowFail: ['Review, Bot'] })
  assert.equal(result.state, 'failed')
  assert.deepEqual(result.failed, ['lint', 'lint'])
  assert.deepEqual(result.allowedFailed, ['Review, Bot'])
  assert.equal(judgeChecks([success, review], { ...options, allowFail: ['Review'] }).state, 'failed')
  assert.equal(judgeChecks([success, review], { ...options, allowFail: ['Review, Bot'] }).state, 'passed')
})

test('SKIPPED 를 나타난 체크로 세고 EXPECTED 는 진행 중으로 센다', () => {
  const skipped = { ...success, conclusion: 'SKIPPED' }
  const expected = { context: 'commit status', state: 'EXPECTED' }
  const result = judgeChecks([skipped, expected], options)
  assert.equal(result.state, 'pending')
  assert.equal(result.pending, 1)
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.checks.map(({ name }) => name), ['Tests', 'commit status'])
  assert.equal(judgeChecks([skipped], options).state, 'passed')
  assert.deepEqual(ciState([skipped, expected], options.required).checks.map(({ name }) => name), ['Tests', 'commit status'])
})

test('빈 롤업을 허용해도 필수 이름이 빠지면 기다린다', () => {
  const noRequired = { ...options, required: [] }
  const empty = judgeChecks([], noRequired)
  assert.equal(empty.none, true)
  assert.equal(empty.state, 'passed')
  assert.equal(judgeChecks([], { ...noRequired, allowNoChecks: false }).state, 'pending')
  assert.deepEqual(judgeChecks([], options).missing, ['Tests'])
  assert.equal(judgeChecks([], options).state, 'pending')
  assert.equal(ciState([], []).state, 'pending')
  const oldHead = [{ ...success, headSha: 'previous' }]
  assert.deepEqual(ciState(oldHead, [], 'current', true), { state: 'passed', checks: [] })
  assert.equal(ciState(oldHead, options.required, 'current', true).state, 'pending')
  assert.equal(requiredCiState(oldHead, [], 'current', true), 'passed')
})

test('같은 워크플로의 새 실행과 현재 HEAD 를 기준으로 판정한다', () => {
  const workflowName = 'CI'
  const old = { ...success, workflowName, conclusion: 'CANCELLED', startedAt: '2026-11-24T01:00:00Z', headSha: 'current' }
  const latest = { ...success, workflowName, startedAt: '2026-11-24T02:00:00Z', headSha: 'current' }
  const otherHead = { ...old, headSha: 'previous' }
  const unrelatedFailure = { context: 'review', state: 'FAILURE' }
  const rows = [old, latest, otherHead, unrelatedFailure]
  assert.deepEqual(currentChecks(rows, 'current'), [latest, unrelatedFailure])
  assert.equal(ciState(rows, ['Tests'], 'current').state, 'failed')
  assert.equal(requiredCiState(rows, ['Tests'], 'current'), 'passed')
})
