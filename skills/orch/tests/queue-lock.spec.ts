import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { acquireQueueLock, ownsQueueLock, releaseQueueLock } from '../scripts/lib/queue-lock.ts'

function lockFile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'queue-lock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'queue.lock')
}

test('살아 있는 같은 프로세스의 잠금은 거절하고 소유자만 푼다', (t) => {
  const file = lockFile(t)
  const token = acquireQueueLock(file)!
  assert.ok(token)
  assert.equal(acquireQueueLock(file), null)
  releaseQueueLock(file, '다른 소유자')
  assert.ok(ownsQueueLock(file, token))
  releaseQueueLock(file, token)
  assert.equal(existsSync(file), false)
})

test('죽은 프로세스의 잠금은 다음 큐가 회수한다', (t) => {
  const file = lockFile(t)
  const ended = spawnSync(process.execPath, ['-e', ''])
  assert.equal(ended.status, 0)
  writeFileSync(file, JSON.stringify({ pid: ended.pid, identity: '끝난 프로세스' }))
  const token = acquireQueueLock(file)!
  assert.ok(token)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid)
  releaseQueueLock(file, token)
})

test('PID 가 살아 있어도 시작 시각이나 명령줄이 다르면 회수한다', (t) => {
  const file = lockFile(t)
  writeFileSync(file, JSON.stringify({ pid: process.pid, identity: '과거 프로세스의 시작 시각과 명령줄' }))
  const token = acquireQueueLock(file)!
  assert.ok(token)
  assert.ok(ownsQueueLock(file, token))
  releaseQueueLock(file, token)
})

test('PID 만 든 옛 잠금도 다른 명령이 쓰는 PID 면 회수한다', (t) => {
  const file = lockFile(t)
  writeFileSync(file, String(process.pid))
  const token = acquireQueueLock(file)!
  assert.ok(token)
  releaseQueueLock(file, token)
})
