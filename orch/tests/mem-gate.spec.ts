// mem-gate.ts 를 가짜 memory_pressure, sysctl, sleep 으로 본다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/mem-gate.ts', import.meta.url))
const KEYS = ['EASY_FREE_PCT', 'MIN_FREE_PCT', 'MAX_SWAP_MB', 'MAX_WAIT', 'POLL']

let tmp: string
let bin: string
let state: string

function tool(name: string, body: string): void {
  const file = join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
  for (const key of KEYS) delete out[key]
  return { ...out, ...extra }
}

function sleeps(): number {
  const file = join(tmp, 'sleeps')
  return existsSync(file) ? readFileSync(file, 'utf8').split('slept').length - 1 : 0
}

// frees 는 memory_pressure 가 차례로 낼 free 값이다. 마지막 값은 계속 낸다
function gate(frees: number[], swapMb: number, args: string[] = [], extra: Record<string, string> = {}) {
  writeFileSync(state, `${frees.join('\n')}\n`)
  tool('sysctl', `echo "total = 20480.00M  used = ${swapMb}.25M  free = 100.00M  (encrypted)"`)
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], {
    env: env({ POLL: '1', ...extra }),
    encoding: 'utf8',
  })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr, sleeps: sleeps() }
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mem-gate-')))
  bin = join(tmp, 'bin')
  mkdirSync(bin)
  state = join(tmp, 'free')
  tool(
    'memory_pressure',
    `v=$(head -1 "${state}"); [ "$(wc -l < "${state}")" -gt 1 ] && sed -i.bak 1d "${state}"\necho "System-wide memory free percentage: \${v}%"`,
  )
  tool('sleep', `echo slept >> "${tmp}/sleeps"`)
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('mem-gate', () => {
  test('free 가 EASY_FREE_PCT 이상이면 swap 이 커도 통과한다', () => {
    const r = gate([40], 30000)
    assert.deepEqual([r.code, r.sleeps], [0, 0], r.stderr)
    assert.ok(r.stderr.includes('mem-gate: ok free=40% swap=30000MB'), r.stderr)
  })

  test('free 와 swap 이 기준 안에 들 때까지 기다린다', () => {
    const r = gate([20, 30, 36], 5000)
    assert.deepEqual([r.code, r.sleeps], [0, 2], r.stderr)
    assert.equal(r.stderr.split('mem-gate: waiting').length - 1, 2, r.stderr)
  })

  test('free 가 EASY_FREE_PCT 아래이고 swap 이 크면 시간을 넘긴 뒤 명령을 실행하지 않는다', () => {
    const marker = join(tmp, 'ran')
    const r = gate([36], 20000, ['--', 'touch', marker], { MAX_WAIT: '2' })
    assert.equal(r.code, 1, r.stderr)
    assert.ok(r.stderr.includes('mem-gate: timeout'), r.stderr)
    assert.equal(existsSync(marker), false)
  })

  test('통과하면 명령을 실행하고 그 종료 코드와 출력을 낸다', () => {
    const r = gate([50], 0, ['--', 'sh', '-c', 'echo hi; exit 7'])
    assert.deepEqual([r.code, r.stdout], [7, 'hi\n'], r.stderr)
  })

  test('없는 명령은 127 이다', () => {
    const r = gate([50], 0, ['--', join(tmp, 'missing')])
    assert.equal(r.code, 127, r.stderr)
    assert.ok(r.stderr.includes('mem-gate: command not found: '), r.stderr)
  })

  test('실행할 수 없는 명령은 126 이다', () => {
    const command = join(tmp, 'no-exec')
    writeFileSync(command, '#!/bin/sh\nexit 0\n')
    const r = gate([50], 0, ['--', command])
    assert.equal(r.code, 126, r.stderr)
    assert.ok(r.stderr.includes('mem-gate: command is not executable: '), r.stderr)
  })

  test('메모리를 읽지 못하면 명령을 실행하지 않고 1 이다', () => {
    tool('memory_pressure', 'exit 1')
    tool('sysctl', 'echo invalid')
    const marker = join(tmp, 'ran')
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--', 'touch', marker], {
      env: env(),
      encoding: 'utf8',
    })
    assert.equal(done.status, 1, done.stderr)
    assert.ok(done.stderr.includes('memory probe failed'), done.stderr)
    assert.equal(existsSync(marker), false)
  })

  test('정수가 아닌 기준값은 명령을 실행하지 않고 1 이다', () => {
    const marker = join(tmp, 'ran')
    const r = gate([50], 0, ['--', 'touch', marker], { MIN_FREE_PCT: 'many' })
    assert.equal(r.code, 1, r.stderr)
    assert.ok(r.stderr.includes('MIN_FREE_PCT 는 정수여야 한다: many'), r.stderr)
    assert.equal(existsSync(marker), false)
  })
})
