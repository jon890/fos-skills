// lib/args.ts 의 고유 접두 펼치기와 값 이어 붙이기를 본다. 옛 Python(argparse) 명령의 줄여 쓰기와 같아야 한다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseArgs } from 'node:util'
import { expandArgs } from '../scripts/lib/args.ts'

const OPTIONS = {
  repo: { type: 'string' },
  'resume-remote': { type: 'boolean' },
  worktree: { type: 'string' },
  body: { type: 'string' },
  'body-file': { type: 'string' },
  help: { type: 'boolean' },
} as const

describe('expandArgs', () => {
  test('고유 접두를 온 이름으로 펼치고 = 뒤의 값은 그대로 둔다', () => {
    assert.deepEqual(expandArgs(['--work', '/w', '--res', '--he'], OPTIONS), ['--worktree', '/w', '--resume-remote', '--help'])
    assert.deepEqual(expandArgs(['--work=/w=x'], OPTIONS), ['--worktree=/w=x'])
    // 펼친 인자를 parseArgs 가 그대로 읽는다
    assert.deepEqual({ ...parseArgs({ args: expandArgs(['--rep', 'x'], OPTIONS), options: OPTIONS }).values }, { repo: 'x' })
  })

  test('이름과 똑같은 옵션은 다른 옵션의 접두여도 그 옵션이다', () => {
    assert.deepEqual(expandArgs(['--body', 'x'], OPTIONS), ['--body', 'x'])
  })

  test('여러 옵션에 맞는 접두는 그 옵션들을 적어 던진다', () => {
    assert.throws(() => expandArgs(['--re', 'x'], OPTIONS), /--re 이 여러 옵션의 접두다: --repo, --resume-remote/)
    assert.throws(() => expandArgs(['--bo=x'], OPTIONS), /--bo 이 여러 옵션의 접두다: --body, --body-file/)
  })

  test('맞는 옵션이 없는 인자, 짧은 옵션, 위치 인자, -- 뒤는 건드리지 않는다', () => {
    assert.deepEqual(expandArgs(['--bogus', '-h', 'file', '-', '--', '--re', '--work'], OPTIONS), ['--bogus', '-h', 'file', '-', '--', '--re', '--work'])
  })

  test('join 의 옵션은 - 로 시작하는 값도 붙여 받고 그 값은 펼치지 않는다', () => {
    assert.deepEqual(expandArgs(['--body', '-x', '--body-f', '--he'], OPTIONS, ['body', 'body-file']), ['--body=-x', '--body-file=--he'])
    assert.deepEqual({ ...parseArgs({ args: expandArgs(['--body', '- 첫 항목'], OPTIONS, ['body']), options: OPTIONS }).values }, { body: '- 첫 항목' })
    // 값이 없는 마지막 인자는 붙이지 않는다. parseArgs 가 값이 없다고 거부한다
    assert.deepEqual(expandArgs(['--body'], OPTIONS, ['body']), ['--body'])
  })
})
