// modules/kit 이 원본으로 삼은 orch 의 lib/args.ts, lib/py.ts 와 같은 입력에 같은 글자를 내는지 본다.
// orch 는 이번에 kit 을 쓰지 않는다(docs/features/node-runtime/design.md DECISION9). 두 벌이 갈라지면 여기서 걸린다.
// 스킬·도구의 kit 복사본이 생기면 그 PR 이 복사본과 원본의 바이트 대조를 이 파일에 더한다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as kitArgs from '../../modules/kit/args.ts'
import * as kitPy from '../../modules/kit/py.ts'
import * as orchArgs from '../../skills/orch/scripts/lib/args.ts'
import * as orchPy from '../../skills/orch/scripts/lib/py.ts'

function outcome(fn: () => unknown): unknown {
  try {
    return { value: fn() }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

describe('kit 과 orch 의 같은 이름 함수', () => {
  const options = { worktree: { type: 'string' as const }, work: { type: 'boolean' as const }, body: { type: 'string' as const }, help: { type: 'boolean' as const } }
  const argvs = [['--wor', 'x'], ['--worktree=x'], ['--wo'], ['--bo', '-x'], ['--', '--wor'], ['-h'], ['--he'], ['--nope'], ['--work']]
  for (const argv of argvs) {
    test(`expandArgs ${argv.join(' ')}`, () => {
      assert.deepEqual(
        outcome(() => kitArgs.expandArgs(argv, options, ['body'])),
        outcome(() => orchArgs.expandArgs(argv, options, ['body'])),
      )
    })
  }

  const values: unknown[] = [null, undefined, true, false, 0, 1.5, '한글 "따옴표"', [1, 'a', null], { a: { b: [true] }, '키': '값' }]
  for (const value of values) {
    test(`pyStr, pyJson ${JSON.stringify(value)}`, () => {
      assert.equal(kitPy.pyStr(value), orchPy.pyStr(value))
      assert.equal(kitPy.pyJson(value), orchPy.pyJson(value))
    })
  }

  for (const word of ['', 'plain/path-1.txt', "it's", 'a b', '한글', '$HOME']) {
    test(`shQuote ${JSON.stringify(word)}`, () => assert.equal(kitPy.shQuote(word), orchPy.shQuote(word)))
  }

  for (const text of ['a b  c', "'a b' \"c \\\" d\"", 'x\\ y', "''", '"open', 'end\\']) {
    test(`shSplit ${JSON.stringify(text)}`, () => assert.deepEqual(outcome(() => kitPy.shSplit(text)), outcome(() => orchPy.shSplit(text))))
  }
})
