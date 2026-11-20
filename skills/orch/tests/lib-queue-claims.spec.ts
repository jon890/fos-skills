// lib/queue-claims.ts 의 「이미 맡은 PR」 판정과 머지 큐 인자에서 빼기를 순수 함수로 본다.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claimedPrs, dropTaken } from '../scripts/lib/queue-claims.ts'
import type { QueueTurn } from '../scripts/lib/queue-turn.ts'

const turn = (pid: number, prs: number[], pr: number | null = prs[0] ?? null, held: number[] = []): QueueTurn =>
  ({ pid, prs, pr, phase: '체크 대기', since: '2026-11-20T00:00:00Z', held: held.map((n) => ({ pr: n, reason: 'STOP' })) })

test('다른 큐의 맡은 PR 기록과 차례 기록에 든 PR 은 맡은 것이다', () => {
  const taken = claimedPrs([793, 798, 800], [{ pid: 11, prs: [793] }], [turn(22, [798])], 99)
  assert.deepEqual([...taken], [[798, 22], [793, 11]])
})

test('내 기록과 다른 PR 은 맡은 것으로 보지 않는다', () => {
  assert.equal(claimedPrs([793], [{ pid: 99, prs: [793] }, { pid: 11, prs: [1] }], [], 99).size, 0)
})

test('도는 큐가 이번 실행에서 뺀 PR 은 다시 걸 수 있다. 다른 큐의 남은 PR 이면 맡은 것이다', () => {
  assert.equal(claimedPrs([793], [{ pid: 11, prs: [793, 794] }], [turn(12, [794], 794, [793])], 99).size, 0)
  assert.deepEqual([...claimedPrs([793], [{ pid: 11, prs: [793] }], [turn(12, [], null, [793]), turn(13, [793])], 99)], [[793, 13]])
})

test('맡은 PR 과 그 표시 인자를 빼고 값을 받는 옵션 뒤의 숫자는 남긴다', () => {
  const got = dropTaken(['--last-of-task', '793', '--poll-min-sec', '793', '793:./backup.sh', '800', '--sweep-arg', '--run'], new Map([[793, 11]]))
  assert.deepEqual(got.queue, ['--poll-min-sec', '793', '800', '--sweep-arg', '--run'])
  assert.deepEqual(got.skipped, [{ pr: 793, pid: 11, reason: 'pid 11 의 머지 큐가 이미 맡았다' }])
})

test('묶음에 맡은 PR 이 있으면 묶음 전체를 뺀다', () => {
  const got = dropTaken(['--chain', '101,102', '--chain=103,104', '101', '102', '103', '104'], new Map([[101, 7]]))
  assert.deepEqual(got.queue, ['--chain=103,104', '103', '104'])
  assert.deepEqual(got.skipped.map((s) => s.pr), [101, 102])
  assert.match(got.skipped[1].reason, /묶음의 #101/)
})

test('맡은 PR 이 없으면 인자를 그대로 둔다', () => {
  const queue = ['101', '102']
  assert.equal(dropTaken(queue, new Map()).queue, queue)
})
