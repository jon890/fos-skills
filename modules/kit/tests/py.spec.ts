// kit 의 py.ts 에만 있는 함수가 Python 과 같은 값을 내는지 본다. 기대값은 Python 3.12 의 실측이다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { pyDecode, pyHead, pyInt, pyLen, pyPathCompare, pySplitLines } from '../py.ts'

describe('pySplitLines', () => {
  const cases: [string, boolean, string[]][] = [
    ['a\r\nb\x1cc\x0bd\n', true, ['a\r\n', 'b\x1c', 'c\x0b', 'd\n']],
    ['a\r\nb\x1cc\x0bd\n', false, ['a', 'b', 'c', 'd']],
    ['', false, []],
    ['a\n', false, ['a']],
    ['\n\n', true, ['\n', '\n']],
    ['a\rb c\x85d\fe', false, ['a', 'b', 'c', 'd', 'e']],
    ['끝 줄바꿈 없음', true, ['끝 줄바꿈 없음']],
  ]
  for (const [text, keepends, expected] of cases) {
    test(`${JSON.stringify(text)} keepends=${keepends}`, () => assert.deepEqual(pySplitLines(text, keepends), expected))
  }
})

describe('pyLen 과 pyHead', () => {
  test('코드 포인트 단위로 센다', () => {
    assert.equal(pyLen('가나😀'), 3)
    assert.equal(pyHead('가😀나다', 2), '가😀')
    assert.equal(pyHead('ab', 5), 'ab')
  })
})

describe('pyPathCompare', () => {
  test('경로 조각 단위로 견준다', () => {
    const paths = ['a-c.md', 'a/b.md', 'NOTE.md', 'a/b/c.md', 'a.md', 'b']
    assert.deepEqual([...paths].sort(pyPathCompare), ['NOTE.md', 'a/b/c.md', 'a/b.md', 'a-c.md', 'a.md', 'b'])
  })

  test('BMP 밖 글자는 코드 포인트 순이다', () => {
    // U+FF61 < U+1F600 이다. UTF-16 단위로는 서로게이트(0xD83D)가 더 작아 거꾸로 된다
    assert.ok(pyPathCompare('｡', '😀') < 0)
  })
})

describe('pyInt 와 pyDecode', () => {
  test('유니코드 숫자를 Python int() 처럼 읽는다', () => {
    assert.equal(pyInt('123'), 123)
    assert.equal(pyInt('١٢٣'), 123) // 아랍 숫자
    assert.equal(pyInt('𝟗𝟘'), 90) // 수학 굵은 9 와 겹선 0, 이어진 숫자 줄 다섯 개 안의 것
    assert.throws(() => pyInt('1a'))
  })

  test('UTF-8 이 아니면 던지고 BOM 은 남긴다', () => {
    assert.throws(() => pyDecode(Uint8Array.from([0x61, 0xff])))
    assert.equal(pyDecode(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])), '\ufeffa')
  })
})
