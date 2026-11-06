// 명령 경계로 볼 수 없는 내부 함수 사례. WORD_START_PREFIXES 에 글자가 둘 이상일 때 각각의 글자로 시작하는 금지어에 경계가 걸린다.
// checker-maintenance.md 가 말하는 「막아야 하는 구절과 통과해야 하는 합성어를 함께 넣는다」 의 예시다.
// 실제 규칙 파일의 금지어를 쓰지 않으려고 접두사와 금지어를 바꿔 넣는다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildMatchers } from '../scripts/korean-style-check.ts'

describe('buildMatchers', () => {
  const matchers = Object.fromEntries(buildMatchers(['가나', '다라', '마바'], ['가', '다']))

  test('등록한 접두사마다 낱말 시작 경계가 걸린다', () => {
    for (const term of ['가나', '다라']) {
      assert.ok(matchers[term](`새 ${term} 를 쓴다`), term)
      assert.equal(matchers[term](`초${term} 를 쓴다`), null, term)
    }
  })
  test('등록한 접두사로 시작하지 않는 금지어는 부분 문자열로 찾는다', () => assert.ok(matchers['마바']('초마바 를 쓴다')))
  test('정규식 특수 문자가 든 금지어는 글자 그대로 찾는다', () => {
    const [[, search]] = buildMatchers(['a.b(c'])
    assert.ok(search('x a.b(c y'))
    assert.equal(search('x aXb(c y'), null)
  })
})
