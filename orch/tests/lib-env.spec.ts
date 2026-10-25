// lib/env.ts 가 양수 초 환경 변수를 ms 로 읽고, 없거나 잘못된 값이면 기본값을 쓰는지 본다.

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { envMs, killGraceMs } from '../scripts/lib/env.ts'

const NAME = 'ORCH_TEST_ENV_SEC'

afterEach(() => {
  delete process.env[NAME]
  delete process.env.ORCH_KILL_GRACE_SEC
})

describe('envMs', () => {
  test('없으면 기본값을 ms 로 돌려준다', () => {
    assert.equal(envMs(NAME, 30), 30_000)
  })

  test('양수 초는 소수까지 ms 로 바꾼다', () => {
    process.env[NAME] = '1.5'
    assert.equal(envMs(NAME, 30), 1_500)
  })

  test('0, 음수, 숫자가 아닌 값, 빈 값은 기본값이다', () => {
    for (const value of ['0', '-1', 'abc', '']) {
      process.env[NAME] = value
      assert.equal(envMs(NAME, 30), 30_000, value)
    }
  })

  test('부를 때마다 읽는다', () => {
    process.env[NAME] = '2'
    assert.equal(envMs(NAME, 30), 2_000)
    process.env[NAME] = '3'
    assert.equal(envMs(NAME, 30), 3_000)
  })
})

describe('killGraceMs', () => {
  test('기본은 10초이고 ORCH_KILL_GRACE_SEC 로 바꾼다', () => {
    assert.equal(killGraceMs(), 10_000)
    process.env.ORCH_KILL_GRACE_SEC = '1'
    assert.equal(killGraceMs(), 1_000)
  })
})
