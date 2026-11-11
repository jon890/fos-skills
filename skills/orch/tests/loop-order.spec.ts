import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runLoopOrder } from './fixtures/loop-order-run.ts'

test('Run 이 둘인 틱에서 로그 줄, 결과 줄, 바깥 호출의 순서가 기록과 같다', () => runLoopOrder())

test('끝난 dispatch 가 남은 틱도 Run 마다 worker 목록은 한 번 읽고 답변 메일함은 읽지 않는다', () => {
  const result = JSON.parse(readFileSync(new URL('./loop-order/settled-dispatches/result.json', import.meta.url), 'utf8'))
  const calls: string[][] = result.calls.orca
  assert.equal(calls.filter((call) => call.includes('worker-list')).length, 2)
  assert.equal(calls.filter((call) => call.includes('inbox')).length, 0)
})
