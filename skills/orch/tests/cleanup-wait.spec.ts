// cleanup-sweep.ts 의 대기 간격과 짧은 대기를 실제로 쉬거나 프로세스를 띄우지 않고 본다.
// 프로세스 조회, 쉬기, 신호 보내기는 Host 대역으로 바꾼다. 인자 검사는 명령을 띄워 가짜 orca 를 부르지 않는지 본다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { stopHolders, waitFree } from '../scripts/cleanup-sweep.ts'
import type { Host } from '../scripts/cleanup-sweep.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/cleanup-sweep.ts', import.meta.url))

// holders 의 답을 차례로 내고, 다 쓰면 마지막 답을 되풀이한다. 부른 횟수와 쉰 시간, 보낸 신호를 기록한다
function fakeHost(holders: string[][]) {
  const seen = { holderChecks: 0, sleeps: [] as number[], kills: [] as [string, string[]][] }
  const host: Host = {
    holderCwds: () => {
      const pids = holders[Math.min(seen.holderChecks, holders.length - 1)]
      seen.holderChecks += 1
      return new Map(pids.map((pid) => [pid, '/unused']))
    },
    psRows: () => new Map([['123', ['1', 'claude']]]),
    sleep: async (seconds) => {
      seen.sleeps.push(seconds)
    },
    kill: (signal, pids) => {
      seen.kills.push([signal, pids])
    },
  }
  return { host, seen }
}

describe('waitFree', () => {
  test('기본 간격은 대기 전체를 1초씩 쉬고 마지막에 한 번 더 본다', async () => {
    const { host, seen } = fakeHost([['123']])
    assert.deepEqual(await waitFree('/unused', 3, undefined, host), ['123'])
    assert.deepEqual(seen.sleeps, [1, 1, 1])
    assert.equal(seen.holderChecks, 4)
  })

  test('소수 대기는 마지막의 짧은 간격까지 쉰다', async () => {
    const { host, seen } = fakeHost([['123']])
    assert.deepEqual(await waitFree('/unused', 0.025, 0.01, host), ['123'])
    assert.equal(seen.sleeps.length, 3, `쉰 시간: ${seen.sleeps.join(', ')}`)
    const total = seen.sleeps.reduce((sum, s) => sum + s, 0)
    assert.ok(Math.abs(total - 0.025) < 1e-9, `쉰 시간의 합이 0.025 가 아니다: ${total}`)
    assert.equal(seen.holderChecks, 4)
  })

  test('쥔 프로세스가 빠지면 바로 그친다', async () => {
    const { host, seen } = fakeHost([['123'], []])
    assert.deepEqual(await waitFree('/unused', 5, 0.01, host), [])
    assert.deepEqual(seen.sleeps, [0.01])
    assert.equal(seen.holderChecks, 2)
  })

  test('대기가 0 이면 쉬지 않고 한 번만 본다', async () => {
    const { host, seen } = fakeHost([['123']])
    assert.deepEqual(await waitFree('/unused', 0, undefined, host), ['123'])
    assert.equal(seen.holderChecks, 1)
    assert.deepEqual(seen.sleeps, [])
  })
})

describe('stopHolders', () => {
  for (const interval of [1, 0.01]) {
    test(`신호 뒤 대기는 최소 한 간격이다: 간격 ${interval}`, async () => {
      // 고르기(123), 대기 첫 확인(123), 한 간격 뒤 확인(없음), 다시 고르기(없음), 마지막 확인(없음)
      const { host, seen } = fakeHost([['123'], ['123'], []])
      const lines: string[] = []
      assert.deepEqual(await stopHolders('/unused', [], 0, (line) => lines.push(line), interval, host), [])
      assert.deepEqual(seen.kills, [['TERM', ['123']]])
      assert.deepEqual(seen.sleeps, [interval])
      assert.deepEqual(lines, ['  TERM 를 보낸다: 123 claude'])
    })
  }
})

describe('대기 인자 검사', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cleanup-wait-'))
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  const cases: [string, string][] = [
    ['--wait', '-1'],
    ['--wait', 'nan'],
    ['--wait', 'inf'],
    ['--poll-interval', '0'],
    ['--poll-interval', '-1'],
    ['--poll-interval', 'nan'],
    ['--poll-interval', 'inf'],
  ]
  for (const [flag, value] of cases) {
    test(`${flag} ${value} 는 외부 명령을 부르기 전에 사용법 오류다`, () => {
      const log = join(tmp, 'orca.log')
      const orca = join(tmp, 'orca')
      writeFileSync(orca, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`)
      chmodSync(orca, 0o755)
      const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', '/unused', flag, value], {
        env: { ...process.env, ORCA: orca },
        encoding: 'utf8',
      })
      assert.equal(done.status, 2, done.stdout + done.stderr)
      assert.equal(existsSync(log), false, 'orca 를 불렀다')
    })
  }
})
