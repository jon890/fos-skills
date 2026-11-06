// modules/kit 이 원본으로 삼은 orch 의 lib/args.ts, lib/py.ts 와 같은 입력에 같은 글자를 내는지 본다.
// orch 는 이번에 kit 을 쓰지 않는다(docs/features/node-runtime/design.md DECISION9). 두 벌이 갈라지면 여기서 걸린다.
// 스킬·도구의 kit 복사본은 scripts/sync-kit.ts 가 원본과 맞추고, 아래 마지막 묶음이 바이트까지 같은지 본다.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import * as kitArgs from '../../modules/kit/args.ts'
import * as kitPy from '../../modules/kit/py.ts'
import * as orchArgs from '../../skills/orch/scripts/lib/args.ts'
import * as orchPy from '../../skills/orch/scripts/lib/py.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { addCopies, differing, kitCopies, syncKit } from '../sync-kit.ts'

const REPO_ROOT = join(import.meta.dirname, '..', '..')

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

describe('스킬·도구의 kit 복사본', () => {
  const policy = (folders: unknown) => JSON.stringify({ kit_sources: folders })

  function fixture(t: { after(fn: () => void): void }, copyText = 'export const a = 1\n') {
    const root = tempDir('kit-copies-', t)
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'scripts/runtime-policy.json'), policy(['modules/kit/']))
    mkdirSync(join(root, 'modules/kit'), { recursive: true })
    writeFileSync(join(root, 'modules/kit/args.ts'), 'export const a = 1\n')
    mkdirSync(join(root, 'skills/demo/scripts/kit'), { recursive: true })
    writeFileSync(join(root, 'skills/demo/scripts/kit/args.ts'), copyText)
    return root
  }

  test('저장소의 모든 복사본이 원본과 바이트까지 같다', () => {
    assert.deepEqual(
      differing(REPO_ROOT).map(({ copy }) => copy),
      [],
    )
  })

  test('복사본이 원본과 다르면 파일 이름과 함께 낸다', (t) => {
    const root = fixture(t, 'export const a = 2\n')
    assert.deepEqual(differing(root), [{ copy: 'skills/demo/scripts/kit/args.ts', source: 'modules/kit/args.ts' }])
  })

  test('sync-kit 이 다른 복사본을 원본으로 덮어쓴다', (t) => {
    const root = fixture(t, 'export const a = 2\n')
    assert.deepEqual(syncKit(root), ['skills/demo/scripts/kit/args.ts'])
    assert.equal(readFileSync(join(root, 'skills/demo/scripts/kit/args.ts'), 'utf8'), 'export const a = 1\n')
    assert.deepEqual(differing(root), [])
  })

  test('원본이 없는 복사본은 던진다', (t) => {
    const root = fixture(t)
    writeFileSync(join(root, 'skills/demo/scripts/kit/ghost.ts'), '')
    assert.throws(() => kitCopies(root), /ghost\.ts 의 원본이 kit_sources 에 없다/)
  })

  test('--add 가 단위의 scripts/kit 에 복사본을 만든다', (t) => {
    const root = fixture(t)
    assert.deepEqual(addCopies(root, 'skills/other', ['args.ts']), ['skills/other/scripts/kit/args.ts'])
    assert.equal(readFileSync(join(root, 'skills/other/scripts/kit/args.ts'), 'utf8'), 'export const a = 1\n')
    assert.throws(() => addCopies(root, 'skills/other', ['none.ts']), /원본이 없다: none\.ts/)
  })

  test('kit_sources 가 없으면 던진다', (t) => {
    const root = fixture(t)
    writeFileSync(join(root, 'scripts/runtime-policy.json'), '{}')
    assert.throws(() => kitCopies(root), /kit_sources/)
  })
})
