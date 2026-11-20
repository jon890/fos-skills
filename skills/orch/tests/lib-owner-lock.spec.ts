// lib/owner-lock.ts: 쥔 프로세스가 살아 있으면 오래된 잠금도 넘겨받지 않고, 죽었으면 회수한다.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { OwnerLockBusy, withOwnerLock } from '../scripts/lib/owner-lock.ts'

function dir(t: TestContext): string {
  const made = mkdtempSync(join(tmpdir(), 'owner-lock-'))
  t.after(() => rmSync(made, { recursive: true, force: true }))
  return made
}

test('잡고 일한 뒤 내 잠금만 지운다', (t) => {
  const file = join(dir(t), 'a.lock')
  assert.equal(withOwnerLock(file, () => existsSync(file)), true)
  assert.equal(existsSync(file), false)
})

test('쥔 프로세스가 살아 있으면 수정 시각이 오래돼도 넘겨받지 않는다', (t) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  const file = join(dir(t), 'a.lock')
  writeFileSync(file, `${child.pid} live-token`)
  const old = new Date(Date.now() - 120_000)
  utimesSync(file, old, old)
  assert.throws(() => withOwnerLock(file, () => 'ran', { waitMs: 200 }), OwnerLockBusy)
  assert.equal(existsSync(file), true)
})

test('쥔 프로세스가 죽었거나 내용이 깨졌으면 회수하고, 회수 흔적을 남기지 않는다', (t) => {
  const base = dir(t)
  for (const [name, text] of [['dead.lock', '999999 dead-token'], ['broken.lock', 'garbage']]) {
    const file = join(base, name)
    writeFileSync(file, text)
    assert.equal(withOwnerLock(file, () => 'ran', { waitMs: 200 }), 'ran')
  }
  assert.deepEqual(readdirSync(base), [])
})

test('일하는 동안 남이 바꾼 잠금은 놓을 때 지우지 않는다', (t) => {
  const file = join(dir(t), 'a.lock')
  withOwnerLock(file, () => writeFileSync(file, `${process.pid} other-token`))
  assert.equal(existsSync(file), true)
})
