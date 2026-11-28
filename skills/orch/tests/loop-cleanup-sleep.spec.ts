// 상주 루프의 정리 단계가 잠자기로 끊긴 실패를 WATCH-ERROR 로 알리지 않는지 본다(loop/steps/cleanup.ts 머리 주석의 「잠자기」)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SLEEP_GAP_MS, sweepVerdict } from '../scripts/loop/steps/cleanup.ts'

const MIN = 60_000

test('성공하면 잠자기 여부와 상관없이 ok 다', () => {
  assert.deepEqual(sweepVerdict({ code: 0, timedOut: false }, 30 * MIN, 1 * MIN, null, true), { kind: 'ok' })
})

test('벽시계가 단조 시계보다 크게 앞서면 잠자기로 넘기고 분을 적는다', () => {
  assert.deepEqual(sweepVerdict({ code: 124, timedOut: true }, 26 * MIN, 10 * MIN, 'remote-branches', false), { kind: 'slept', reason: '종료 코드 124 (잠자기 16분)' })
  assert.equal(sweepVerdict({ code: 2, timedOut: false }, 20 * MIN, 2 * MIN, null, false).kind, 'slept')
})

test('앞 회차가 잠자기로 넘긴 실패면 이번 실패는 알린다', () => {
  assert.deepEqual(sweepVerdict({ code: 124, timedOut: true }, 26 * MIN, 10 * MIN, null, true), { kind: 'error', reason: '종료 코드 124 (잠자기 뒤 다시 실패)' })
})

test('잠자기가 아닌 시간 초과는 그때 돌던 단계를 적는다', () => {
  assert.deepEqual(sweepVerdict({ code: 124, timedOut: true }, 10 * MIN, 10 * MIN, 'remote-branches', false), { kind: 'error', reason: '종료 코드 124 (시간 초과, 단계 remote-branches)' })
  assert.deepEqual(sweepVerdict({ code: 124, timedOut: true }, 10 * MIN, 10 * MIN, null, false), { kind: 'error', reason: '종료 코드 124 (시간 초과)' })
  assert.deepEqual(sweepVerdict({ code: 2, timedOut: false }, 1 * MIN, 1 * MIN, null, false), { kind: 'error', reason: '종료 코드 2' })
})

test('시계 차이가 기준값 이하면 잠자기로 보지 않는다', () => {
  assert.equal(sweepVerdict({ code: 2, timedOut: false }, 5 * MIN + SLEEP_GAP_MS, 5 * MIN, null, false).kind, 'error')
})
