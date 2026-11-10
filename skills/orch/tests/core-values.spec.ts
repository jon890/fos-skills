// 순수 층은 입력 값으로 확인한다. 외부 실행 파일이나 환경을 바꾸지 않는다.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classify } from '../scripts/core/completion.ts'
import { autoMergeConfig } from '../scripts/core/auto-merge.ts'
import { ConfigError } from '../scripts/core/config.ts'
import { deployVerdict, parseRuns } from '../scripts/core/deploy.ts'
import { FINISH_KEYS, FINISH_OPTIONS } from '../scripts/core/finish-options.ts'
import { QUEUE_VALUE_OPTIONS } from '../scripts/core/queue-options.ts'
import { boardSettingsFromConfig } from '../scripts/core/milestones.ts'
import { isObject, jsonEqual, objectOr } from '../scripts/core/json.ts'

test('객체 기본값과 JSON 값 비교는 키 순서와 잘못된 입력을 구분한다', () => {
  assert.equal(isObject([]), false)
  assert.deepEqual(objectOr(null), {})
  assert.equal(objectOr([], null), null)
  const value = { a: [1, null], b: { x: true } }
  assert.equal(objectOr(value), value)
  assert.equal(jsonEqual(value, { b: { x: true }, a: [1, null] }), true)
  assert.equal(jsonEqual(value, { b: { x: false }, a: [1, null] }), false)
  assert.equal(jsonEqual([], {}), false)
})
test('설정의 정상 값과 잘못된 값은 외부 조회 없이 처리한다', () => {
  assert.equal(autoMergeConfig({}).enabled, false)
  assert.throws(() => autoMergeConfig({ queue: { auto_merge: 'yes' } }), ConfigError)
  assert.equal(boardSettingsFromConfig({}).steps, null)
  assert.throws(() => boardSettingsFromConfig({ board: { steps: [] } }), ConfigError)
  assert.ok(FINISH_OPTIONS.repo)
  assert.ok(FINISH_KEYS.includes('deploy_workflow'))
  assert.ok(QUEUE_VALUE_OPTIONS.includes('--repo'))
})
test('배포 결과와 완료 보고는 값만으로 정한다', () => {
  assert.equal(deployVerdict([{ headSha: 'a', status: 'completed', conclusion: 'success' }], 'a', (a, b) => a === b).verdict, 'success')
  assert.equal(deployVerdict([], 'a', () => false).verdict, 'wait')
  assert.deepEqual(parseRuns('broken'), [])
  const head = 'a'.repeat(40)
  const ready = { id: 'ready', type: 'status', task_id: 't', dispatch_id: 'd', from_handle: 'w', body: `준비됨 #1, head ${head}` }
  const done = { id: 'done', type: 'worker_done', task_id: 't', dispatch_id: 'd', from_handle: 'w' }
  assert.deepEqual(classify([ready, done])[1].completionVerification, { status: 'ready', pr: 1, head, statusMessageId: 'ready' })
})
