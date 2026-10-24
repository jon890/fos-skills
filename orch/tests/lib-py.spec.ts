import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { pyRegExp, shSplit } from '../scripts/lib/py.ts'

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

describe('shSplit', () => {
  test('업무 완료 명령 틀을 셸 없이 나누고 작은따옴표를 벗긴다', () => {
    assert.deepEqual(shSplit("task-cli complete {number} --state 'Done'"), ['task-cli', 'complete', '{number}', '--state', 'Done'])
  })

  test('작은따옴표 안은 공백, 역슬래시, 큰따옴표를 글자 그대로 둔다', () => {
    assert.deepEqual(shSplit(`a 'b c\\d"e' f`), ['a', 'b c\\d"e', 'f'])
  })

  test('큰따옴표 안은 shlex 처럼 \\" 와 \\\\ 의 역슬래시만 떼고 \\` \\$ \\n 의 역슬래시는 남긴다', () => {
    // 기대값은 Python shlex.split('"a b\\" \\\\ \\` \\$ \\n"') 의 결과다
    assert.deepEqual(shSplit('"a b\\" \\\\ \\` \\$ \\n"'), ['a b" \\ \\` \\$ \\n'])
  })

  test('큰따옴표 안의 줄바꿈 앞 역슬래시는 shlex 처럼 남긴다', () => {
    assert.deepEqual(shSplit('"a\\\nb"'), ['a\\\nb'])
  })

  test('따옴표 밖의 역슬래시는 다음 글자를 그대로 둔다', () => {
    assert.deepEqual(shSplit('a\\ b c\\\'d'), ['a b', "c'd"])
  })

  test('빈 따옴표는 빈 인자이고 이어 붙은 따옴표는 한 인자다', () => {
    assert.deepEqual(shSplit(`x '' "" a'b'"c"`), ['x', '', '', 'abc'])
  })

  test('공백, 탭, 줄바꿈이 겹쳐도 빈 인자를 만들지 않는다', () => {
    assert.deepEqual(shSplit('  a\t\tb\n c  '), ['a', 'b', 'c'])
    assert.deepEqual(shSplit(''), [])
  })

  test('닫히지 않은 따옴표와 끝의 역슬래시는 Error 다', () => {
    assert.throws(() => shSplit("task-cli 'complete {number}"), /닫히지 않은 따옴표/)
    assert.throws(() => shSplit('task-cli "complete {number}'), /닫히지 않은 따옴표/)
    assert.throws(() => shSplit('task-cli {number} \\'), /끝의 역슬래시/)
  })
})
