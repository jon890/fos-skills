import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { waiterPids } from '../scripts/lib/waiters.ts'

let dir: string
const saved = process.env.PS

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'lib-waiters-'))
})
after(() => {
  if (saved === undefined) delete process.env.PS
  else process.env.PS = saved
  rmSync(dir, { recursive: true, force: true })
})

function fakePs(out: string, code = 0): void {
  const bin = join(dir, 'ps')
  writeFileSync(join(dir, 'ps.out'), out)
  writeFileSync(bin, `#!/bin/sh\ncat "${join(dir, 'ps.out')}"\nexit ${code}\n`)
  chmodSync(bin, 0o755)
  process.env.PS = bin
}

describe('waiterPids', () => {
  test('그 Run 의 wait-important 와 watch-questions 만 고르고 자식 check 와 셸은 뺀다', () => {
    fakePs([
      '  10 node /x/wait-important.ts --run run_a --loop-repo /r',
      '  11 orca orchestration check --run run_a --wait --types worker_done',
      '  12 /bin/zsh -c node /x/wait-important.ts --run run_a',
      '  13 node /x/watch-questions.ts --run run_a',
      '  14 node /x/wait-important.ts --run run_ab',
      '  15 node /x/wait-important.ts --run run_b',
    ].join('\n'))
    assert.deepEqual(waiterPids('run_a'), { ok: true, pids: [10, 13] })
  })

  test('ps 를 읽지 못하면 ok 가 false 다', () => {
    fakePs('', 1)
    const got = waiterPids('run_a')
    assert.equal(got.ok, false)
  })
})
