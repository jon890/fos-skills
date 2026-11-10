import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { claimFile, claimStale, LockTimeout, peekLock, replaceStale, withFileLock } from '../bin/file-lock.ts'
import { tempBoard } from './board-run.ts'

const old = (file: string, seconds = 40) => { const time = new Date(Date.now() - seconds * 1000); utimesSync(file, time, time) }
test('잠금의 반환값, 예외와 남의 표지를 보존한다', () => {
  const t = tempBoard(), file = `${t.file}.lock`
  try {
    assert.equal(withFileLock(t.file, (lock) => { assert.ok(lock.held()); assert.ok(existsSync(file)); return 7 }), 7)
    assert.ok(!existsSync(file))
    const error = new Error('work failed')
    assert.throws(() => withFileLock(t.file, () => { throw error }), (got) => got === error)
    assert.ok(!existsSync(file))
    withFileLock(t.file, (lock) => { writeFileSync(file, 'other'); assert.ok(!lock.held()) })
    assert.equal(readFileSync(file, 'utf8'), 'other')
  } finally { t.cleanup() }
})
test('새 잠금과 10초 된 잠금은 기다림 실패, 40초 된 잠금은 넘겨받는다', () => {
  const t = tempBoard(), file = `${t.file}.lock`
  try {
    for (const seconds of [0, 10]) {
      writeFileSync(file, 'other'); old(file, seconds)
      assert.throws(() => withFileLock(t.file, () => assert.fail('must not run'), { waitMs: 20, pollMs: 5 }), LockTimeout)
      assert.equal(readFileSync(file, 'utf8'), 'other')
    }
    old(file)
    withFileLock(t.file, (lock) => assert.ok(lock.held()))
    assert.deepEqual(readdirSync(t.dir), [])
  } finally { t.cleanup() }
})
test('같은 낡은 잠금을 본 늦은 경쟁자는 먼저 넘겨받은 표지를 덮지 못한다', () => {
  const t = tempBoard(), file = `${t.file}.lock`
  try {
    writeFileSync(file, 'old'); old(file)
    const a = peekLock(file, 30000)!, b = peekLock(file, 30000)!
    assert.equal(a.key, b.key); assert.ok(a.stale && b.stale)
    assert.ok(claimStale(file, a, 'A')); assert.ok(replaceStale(file, a, 'A'))
    assert.equal(claimStale(file, b, 'B'), false)
    assert.equal(readFileSync(file, 'utf8'), 'A'); assert.equal(peekLock(file, 30000)!.stale, false)
    unlinkSync(claimFile(file, a.key)); unlinkSync(file); writeFileSync(file, 'C')
    assert.ok(claimStale(file, b, 'B')); assert.equal(replaceStale(file, b, 'B'), false)
    assert.equal(readFileSync(file, 'utf8'), 'C'); assert.ok(!existsSync(claimFile(file, b.key)))
  } finally { t.cleanup() }
})
test('넘겨받다가 남긴 낡은 권리 파일은 지울 경로를 알리고 보존한다', () => {
  const t = tempBoard(), file = `${t.file}.lock`
  try {
    writeFileSync(file, 'old'); old(file)
    const seen = peekLock(file, 30000)!, claim = claimFile(file, seen.key)
    assert.ok(claimStale(file, seen, 'dead')); old(claim)
    assert.throws(() => withFileLock(t.file, () => assert.fail(), { waitMs: 0 }), (error: Error) => error instanceof LockTimeout && error.message.includes(claim) && error.message.includes('지운다'))
    assert.ok(existsSync(file) && existsSync(claim))
  } finally { t.cleanup() }
})
