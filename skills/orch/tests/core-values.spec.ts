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
import { mergeNotice } from '../scripts/core/merge-notice.ts'
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

import { judgeLoop, type LoopState } from '../scripts/core/loop.ts'
import { judgeWorker } from '../scripts/core/movement.ts'
import { unanswered, ageSeconds } from '../scripts/core/questions.ts'
import { decisionEntries } from '../scripts/core/decisions.ts'
import { notifiedKey } from '../scripts/core/conflicts.ts'
import { retriedLost } from '../scripts/core/lost-workers.ts'
import { inFlight } from '../scripts/core/refresh.ts'

test('루프의 만료와 프로세스 확인 삼상태를 입력으로 보존한다', () => {
  const state: LoopState = { pid: 10, run: 'r', repo: '/repo', tick_sec: 1, started_at: '', alive_at: '2026-01-01T00:00:00Z', last_tick: null, ticks: 0, errors: {} }
  const now = Date.parse('2026-01-02T00:00:00Z')
  assert.deepEqual(judgeLoop(null, now, false), { alive: false, reason: '없음' })
  for (const status of [true, null]) assert.equal((judgeLoop(state, now, true, status) as { recheck?: boolean }).recheck, true)
  assert.equal((judgeLoop(state, now, true, false) as { recheck?: boolean }).recheck, undefined)
  assert.deepEqual(judgeLoop(state, now, false), { alive: false, reason: 'pid 10 종료' })
})
test('미답변과 멈춤, 결정은 외부 조회 없이 구분한다', () => {
  const asked = { id: 'q', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'w', dispatch_id: 'd', created_at: '2026-01-01T00:00:00Z' }
  assert.deepEqual(unanswered([asked], 'r'), [asked])
  assert.deepEqual(unanswered([asked, { ...asked, id: 'a', thread_id: 'q', to_handle: 'w', type: 'status' }], 'r'), [])
  assert.equal(ageSeconds(asked, Date.parse('2026-01-01T00:10:00Z') / 1000), 600)
  assert.equal(judgeWorker({ run: 'r', row: { dispatchId: 'd' }, now: 120_000, settings: { idleMin: 1, exited: true }, mtime: 0, commit: null }).reason, 'idle')
  assert.deepEqual(decisionEntries([], [{ id: 'x', status: 'decide', details: [{ text: '끝남', done: true }] }], []), [])
  assert.equal(notifiedKey(1, 'head', ['b', 'a']), notifiedKey(1, 'head', ['a', 'b']))
  assert.deepEqual([...retriedLost([{ taskId: 't', dispatchId: 'old' }, { taskId: 't', dispatchId: 'new', dispatchStatus: 'running' }], [['old', 'exited']])], ['old'])
  assert.equal(inFlight({ base: 'base', from: 'head', at: '2026-01-01T00:00:00Z', action: 'update', value: 'updated' }, 'new-head', 'passed', Date.parse('2026-01-02T00:00:00Z')), false)
})

test('머지 알림 글은 조건 없이 끝내라고 하지 않고 머지 뒤 할 일이 남은 경우를 말한다', () => {
  const text = mergeNotice(7, 'abc123')
  assert.match(text, /PR #7 이 MERGED 됐다\(머지 커밋 abc123\)/)
  assert.match(text, /머지 뒤에 할 일이 남았으면 그 일을 마친 뒤에, 없으면 바로 worker_done/)
  assert.doesNotMatch(text, /다음 PR/)
  assert.doesNotMatch(mergeNotice(7, ''), /머지 커밋/)
})
