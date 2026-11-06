import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { MAX_MESSAGE_LIMIT, MESSAGE_LIMIT, dispatchesFor, recordRouting, reviewCounts, writeRoutingRecord } from '../scripts/lib/routing-log.ts'
import { fixture, launch, msg, PR } from './fixtures/routing-fakes.ts'

let f: ReturnType<typeof fixture>
beforeEach(() => { f = fixture(); f.history(launch()); f.config() })
afterEach(() => f.close())

test('필수 관측값과 요청·effective·행을 보존하며 본문과 비용은 남기지 않는다', async () => {
  f.state.inbox['run:run_a'] = [msg('ready', { body: `준비됨 #7, head ${'a'.repeat(40)}` })]
  f.save()
  f.usage('codex', [{ firstTimestamp: '2026-11-06T01:01:00Z', primaryWorktreeId: 'wt_a', totalInputTokens: 100, totalCachedInputTokens: 40, totalOutputTokens: 30 }])
  await recordRouting(f.dir, 7, 'merged')
  const row = f.rows()[0]
  assert.equal(row.version, 1)
  assert.equal(row.outcome, 'merged')
  assert.equal(row.repo, 'test/repo')
  assert.equal(row.closed_at, null)
  assert.equal(row.task_row, 'impl-explore')
  assert.equal(row.dispatches[0].opened_pr, true)
  assert.equal(row.minutes_to_ready, 30)
  assert.equal(row.minutes_waiting_user, 0)
  assert.deepEqual(row.first_review, { P1: 0, P2: 1, P3: 2, P4: 0, P5: 0 })
  assert.equal(row.size_grade, 'B')
  assert.equal(row.fix_commits_after_review, 1)
  assert.equal(row.ci_failures, 1)
  assert.deepEqual(row.tokens, { input: 60, output: 30, cache_read: 40, cache_write: 0 })
  const raw = readFileSync(join(f.dir, '.orch/state/routing-log.jsonl'), 'utf8')
  for (const forbidden of ['준비됨', 'PR 크기 등급', '지시서', 'cost', 'body']) assert.ok(!raw.includes(forbidden), forbidden)
})

test('같은 결과는 수집도 반복하지 않고 closed 다음 merged는 한 줄을 바꾼다', async () => {
  Object.assign(f.state.pr, { state: 'CLOSED', mergedAt: null, closedAt: PR.mergedAt }); f.save()
  await recordRouting(f.dir, 7, 'closed')
  const count = f.calls().length
  await recordRouting(f.dir, 7, 'closed')
  assert.equal(f.calls().length, count)
  assert.equal(f.rows()[0].merged_at, null)
  Object.assign(f.state.pr, PR); f.save()
  await recordRouting(f.dir, 7, 'merged')
  assert.equal(f.rows().length, 1)
  assert.equal(f.rows()[0].outcome, 'merged')
  await recordRouting(f.dir, 7, 'closed')
  assert.equal(f.rows()[0].outcome, 'merged')
})

test('수집기 실패는 그 키만 null이고 리뷰와 CI를 보존한다', async () => {
  f.state.fail = 'inbox'; f.save()
  await recordRouting(f.dir, 7, 'merged')
  assert.equal(f.rows()[0].questions, null)
  assert.equal(f.rows()[0].tokens, null)
  assert.equal(f.rows()[0].ci_failures, 1)
  assert.equal(f.rows()[0].first_review?.P2, 1)
  assert.equal(f.rows()[0].dispatches[0].opened_pr, true)
})

test('리뷰 조회 실패는 CI 수집을 막지 않는다', async () => {
  f.state.fail = '/comments'; f.save()
  await recordRouting(f.dir, 7, 'merged')
  const row = f.rows()[0]
  assert.equal(row.first_review, null)
  assert.equal(row.fix_commits_after_review, null)
  assert.equal(row.ci_failures, 1)
})

test('routing 절이 없으면 리뷰와 크기는 null이다', async () => {
  writeFileSync(join(f.dir, '.orch/config.json'), '{}')
  await recordRouting(f.dir, 7, 'merged')
  assert.equal(f.rows()[0].first_review, null)
  assert.equal(f.rows()[0].size_grade, null)
})

test('브랜치 재사용과 종료 뒤 dispatch는 제외하고 PR 뒤 재시도는 포함한다', () => {
  const previous = { ...PR, number: 6, createdAt: '2026-11-05T00:00:00Z', mergedAt: '2026-11-06T00:59:00Z' }
  const rows = dispatchesFor(PR, [previous, PR], [launch({ dispatch: 'old', at: '2026-11-05T00:00:00Z' }), launch(),
    launch({ dispatch: 'fix', at: '2026-11-06T01:45:00Z', retry_of: 'ctx_a' }), launch({ dispatch: 'future', at: '2026-11-06T02:01:00Z' })])
  assert.deepEqual(rows.map(row => row.dispatch), ['ctx_a', 'fix'])
})

test('사람이 연 PR과 앞 PR만 만든 이력은 기록하지 않는다', async () => {
  f.state.pr.headRefName = 'human'; f.save()
  await recordRouting(f.dir, 7, 'merged')
  assert.deepEqual(f.rows(), [])
})

test('각 dispatch의 Run을 읽고 준비를 처음 알린 dispatch의 행을 쓴다', async () => {
  f.history(launch({ dispatch: 'ctx_b', terminal: 'term_b', run: 'run_b', at: '2026-11-06T01:05:00Z', row: 'hard-design', retry_of: 'ctx_a' }))
  const question = msg('question', { type: 'question', created_at: '2026-11-06T01:08:00Z', body: 'PRIVATE' })
  const ready = msg('ready', { dispatch_id: 'ctx_b', run_id: 'run_b', from_handle: 'term_b', body: `준비됨 #7, head ${'a'.repeat(40)}` })
  f.state.inbox['run:run_a'] = [question]
  f.state.inbox['dispatch:ctx_a'] = [msg('reply', { from_handle: 'term_coordinator', to_handle: 'dispatch:ctx_a', thread_id: 'question', created_at: '2026-11-06T01:18:00Z' })]
  f.state.inbox['run:run_b'] = [ready, msg('escalation', { type: 'escalation', dispatch_id: 'ctx_b', from_handle: 'term_b', run_id: 'run_b', created_at: '2026-11-06T01:35:00Z' })]
  f.save()
  await recordRouting(f.dir, 7, 'merged')
  const row = f.rows()[0]
  assert.equal(row.questions, 1)
  assert.equal(row.escalations, 1)
  assert.equal(row.minutes_waiting_user, 10)
  assert.equal(row.coordinator_messages, 1)
  assert.equal(row.task_row, 'hard-design')
  assert.equal(row.dispatches[1].opened_pr, true)
  assert.ok(!JSON.stringify(row).includes('PRIVATE'))
})

test('메시지 한도 안에 창 밖의 과거 시각이 있으면 그대로 쓴다', async () => {
  f.state.inbox['run:run_a'] = [msg('ready', { body: `준비됨 #7, head ${'a'.repeat(40)}` }),
    ...Array.from({ length: MESSAGE_LIMIT - 1 }, (_, i) => msg(`old_${i}`, { created_at: '2026-11-05T00:00:00Z' }))]
  f.save()
  await recordRouting(f.dir, 7, 'merged')
  assert.equal(f.rows()[0].questions, 0)
  assert.equal(f.rows()[0].minutes_to_ready, 30)
  const reads = f.calls().filter(args => args.includes('run:run_a'))
  assert.equal(reads.length, 1)
})

test('창 안에서 메시지 한도에 닿으면 넓혀서 오래된 질문과 첫 준비까지 읽는다', async () => {
  f.state.inbox['run:run_a'] = [
    ...Array.from({ length: MESSAGE_LIMIT }, (_, i) => msg(`later_${i}`, { created_at: '2026-11-06T01:40:00Z' })),
    msg('question', { type: 'question', created_at: '2026-11-06T01:10:00Z' }),
    msg('ready', { body: `준비됨 #7, head ${'a'.repeat(40)}` }),
  ]
  f.save()
  await recordRouting(f.dir, 7, 'merged')
  assert.equal(f.rows()[0].questions, 1)
  assert.equal(f.rows()[0].minutes_to_ready, 30)
  const limits = f.calls().filter(args => args.includes('run:run_a')).map(args => Number(args[args.indexOf('--limit') + 1]))
  assert.deepEqual(limits, [MESSAGE_LIMIT, MESSAGE_LIMIT * 2])
})


test('사용량의 알려지지 않은 형식과 위치 혼합은 null이다', async () => {
  f.usage('codex', [{ firstTimestamp: '2026-11-06T01:01:00Z', primaryWorktreeId: 'wt_a', hasMixedLocations: true, totalInputTokens: 100, totalCachedInputTokens: 40, totalOutputTokens: 30 }])
  await recordRouting(f.dir, 7, 'merged')
  assert.equal(f.rows()[0].tokens, null)
})

test('동시 저장은 다른 PR을 보존하고 잠금을 반납한다', async () => {
  await recordRouting(f.dir, 7, 'merged')
  const row = f.rows()[0]
  await Promise.all([writeRoutingRecord(f.dir, { ...row, pr: 8 }), writeRoutingRecord(f.dir, { ...row, pr: 9 })])
  assert.deepEqual(f.rows().map(row => row.pr).sort(), [7, 8, 9])
  assert.equal(existsSync(join(f.dir, '.orch/state/routing-log.lock')), false)
})

test('리뷰 표와 사용자 정규식은 P1부터 P5까지 읽는다', () => {
  assert.deepEqual(reviewCounts('counts: 1,2,3,4,5', 'counts: (\\d+),(\\d+),(\\d+),(\\d+),(\\d+)'), { P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 })
  assert.equal(reviewCounts('리뷰를 시작합니다'), null)
})

test('이전 CI head와 실패 뒤 성공한 재실행의 앞 시도도 센다', async () => {
  f.state.runs.head1 = [{ id: 1, conclusion: 'failure' }]
  f.state.runs.head2 = [{ id: 2, conclusion: 'success', run_attempt: 2 }]
  f.state.attempts['2/attempts/1'] = { conclusion: 'failure' }
  f.save()
  await recordRouting(f.dir, 7, 'merged')
  assert.equal(f.rows()[0].ci_failures, 2)
  assert.ok(f.calls().some(args => args.some(arg => arg.includes('branch=feat%2Fa') && arg.includes('created='))))
})

test('잘못된 크기 정규식은 첫 리뷰 집계를 지우지 않는다', async () => {
  writeFileSync(join(f.dir, '.orch/config.json'), JSON.stringify({ routing: { review_author: 'review-bot', size_pattern: '[' } }))
  await recordRouting(f.dir, 7, 'merged')
  assert.equal(f.rows()[0].first_review?.P2, 1)
  assert.equal(f.rows()[0].size_grade, null)
})

test('대기 구간은 합집합이고 문자열 payload 공지는 코디네이터 지시에서 뺀다', async () => {
  f.state.inbox['run:run_a'] = [
    msg('q1', { type: 'question', created_at: '2026-11-06T01:05:00Z' }),
    msg('q2', { type: 'question', created_at: '2026-11-06T01:06:00Z' }),
    msg('ready', { body: `준비됨 #7, head ${'b'.repeat(40)}` }),
  ]
  f.state.inbox['dispatch:ctx_a'] = [
    msg('a1', { from_handle: 'coordinator', to_handle: 'dispatch:ctx_a', thread_id: 'q1', created_at: '2026-11-06T01:08:00Z' }),
    msg('a2', { from_handle: 'coordinator', to_handle: 'dispatch:ctx_a', thread_id: 'q2', created_at: '2026-11-06T01:10:00Z' }),
    msg('notice', { from_handle: 'coordinator', to_handle: '@all' }),
    msg('notice2', { from_handle: 'coordinator', to_handle: 'dispatch:ctx_a', payload: JSON.stringify({ broadcast: true }) }),
  ]
  f.save()
  await recordRouting(f.dir, 7, 'merged')
  assert.equal(f.rows()[0].minutes_waiting_user, 5)
  assert.equal(f.rows()[0].coordinator_messages, 2)
})

test('Claude 사용량은 다음 dispatch 시작 전 세션만 합친다', async () => {
  // 현재 PR 종료 뒤 같은 워크트리에서 띄운 세션은 다른 PR의 것이다.
  f.history(launch({ dispatch: 'ctx_claude', at: '2026-11-06T01:10:00Z', agent: 'claude', effective: { agent: 'claude' } }),
    launch({ dispatch: 'ctx_next', at: '2026-11-06T02:01:00Z' }))
  f.usage('codex', [])
  f.usage('claude', [
    { firstTimestamp: '2026-11-06T01:11:00Z', lastCwd: '/temp/worktree', totalInputTokens: 10, totalOutputTokens: 20, totalCacheReadTokens: 30, totalCacheWriteTokens: 40 },
    { firstTimestamp: '2026-11-06T02:02:00Z', lastCwd: '/temp/worktree', totalInputTokens: 1000, totalOutputTokens: 2000, totalCacheReadTokens: 3000, totalCacheWriteTokens: 4000 },
  ])
  await recordRouting(f.dir, 7, 'merged')
  assert.deepEqual(f.rows()[0].tokens, { input: 10, output: 20, cache_read: 30, cache_write: 40 })
})

test('커밋 조회 한도는 리뷰 뒤 커밋만 null로 두고 CI를 보존한다', async () => {
  f.state.commits = Array.from({ length: 250 }, (_, i) => ({ sha: String(i), commit: { committer: { date: '2026-11-06T01:40:00Z' } } }))
  f.save()
  await recordRouting(f.dir, 7, 'merged')
  assert.equal(f.rows()[0].fix_commits_after_review, null)
  assert.equal(f.rows()[0].ci_failures, 1)
})

test('effective 응답에 추가 필드가 있어도 실행 설정만 기록한다', async () => {
  writeFileSync(join(f.dir, '.orch/state/launch-history.jsonl'), JSON.stringify({ ...launch(), effective: { ...launch().effective, private_note: 'PRIVATE' } }) + '\n')
  await recordRouting(f.dir, 7, 'merged')
  assert.deepEqual(Object.keys(f.rows()[0].dispatches[0].effective!).sort(), ['agent', 'effort', 'model'])
  assert.ok(!JSON.stringify(f.rows()).includes('PRIVATE'))
})

test('조회 상한까지 창 안에서 가득 차면 값을 0으로 꾸미지 않는다', async () => {
  f.state.inbox['run:run_a'] = Array.from({ length: MAX_MESSAGE_LIMIT }, (_, i) => msg(String(i)))
  f.save()
  await recordRouting(f.dir, 7, 'merged')
  assert.equal(f.rows()[0].questions, null)
  assert.equal(f.rows()[0].minutes_to_ready, null)
})

test('push에 밀려 취소되거나 stale인 실행은 CI 실패에서 뺀다', async () => {
  f.state.runs.head1 = ['failure', 'timed_out', 'startup_failure', 'cancelled', 'stale', 'action_required', 'success'].map((conclusion, i) => ({ id: i + 10, conclusion }))
  f.save()
  await recordRouting(f.dir, 7, 'merged')
  assert.equal(f.rows()[0].ci_failures, 3)
})
