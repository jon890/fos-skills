import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { pyRegExp } from '../scripts/lib/py.ts'

describe('pyRegExp', () => {
  test('(?P<이름> 은 JS 의 이름 붙은 묶음이 된다', () => {
    const m = pyRegExp('(?P<unit>modules/[^/]+)/').exec('modules/core/a.ts')
    assert.equal(m?.groups?.unit, 'modules/core')
  })

  test('(?P=이름) 은 같은 이름의 역참조가 된다', () => {
    const re = pyRegExp('^(?P<w>[a-z]+)-(?P=w)$')
    assert.equal(re.test('ab-ab'), true)
    assert.equal(re.test('ab-cd'), false)
  })

  test('\\A 는 문자열 처음, \\Z 는 문자열 끝이다', () => {
    const re = pyRegExp('\\Abuild\\.gradle\\Z')
    assert.equal(re.test('build.gradle'), true)
    assert.equal(re.test('x/build.gradle'), false)
    assert.equal(re.test('build.gradle.kts'), false)
  })

  test('앞의 역슬래시가 짝수 개인 \\\\A 는 이스케이프된 역슬래시와 A 라 그대로다', () => {
    const re = pyRegExp('\\\\A')
    assert.equal(re.source, '\\\\A')
    assert.equal(re.test('x\\Ay'), true)
    assert.equal(re.test('A'), false)
  })

  test('바꿀 글자가 없으면 원문과 같은 정규식이다', () => {
    const source = '^(modules/common/|build\\.gradle$|\\.github/)'
    assert.equal(pyRegExp(source).source, new RegExp(source).source)
  })

  test('JS 가 읽지 못하는 인라인 플래그 (?i)abc 는 원문을 담은 Error 다', () => {
    assert.throws(() => pyRegExp('(?i)abc'), (e: unknown) => e instanceof Error && e.message.includes('"(?i)abc"'))
  })
})
