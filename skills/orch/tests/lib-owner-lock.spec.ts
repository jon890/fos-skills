// lib/owner-lock.ts: 쥔 프로세스가 살아 있으면 오래된 잠금도 넘겨받지 않고, 죽었으면 회수한다. 회수 경합에서 새 주인의 잠금을 옮기지 않는다.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { OwnerLockBusy, peek, reclaimDead, withOwnerLock } from '../scripts/lib/owner-lock.ts'

function dir(t: TestContext): string {
  const made = mkdtempSync(join(tmpdir(), 'owner-lock-'))
  t.after(() => rmSync(made, { recursive: true, force: true }))
  return made
}

// 그 owner 로 잡힌 잠금 디렉터리를 만든다
function plant(lock: string, owner: string): void {
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner'), owner)
}

test('잡고 일한 뒤 내 잠금만 지운다', (t) => {
  const base = dir(t)
  const lock = join(base, 'a.lock')
  assert.equal(withOwnerLock(lock, () => readFileSync(join(lock, 'owner'), 'utf8').startsWith(`${process.pid} `)), true)
  assert.deepEqual(readdirSync(base), [])
})

test('쥔 프로세스가 살아 있으면 수정 시각이 오래돼도 넘겨받지 않는다', (t) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  const lock = join(dir(t), 'a.lock')
  plant(lock, `${child.pid} live-token`)
  const old = new Date(Date.now() - 120_000)
  utimesSync(lock, old, old)
  assert.throws(() => withOwnerLock(lock, () => 'ran', { waitMs: 200 }), OwnerLockBusy)
  assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), `${child.pid} live-token`)
})

test('쥔 프로세스가 죽었거나 깨졌거나 옛 파일 잠금이면 회수한다', (t) => {
  const base = dir(t)
  plant(join(base, 'dead.lock'), '999999 dead-token')
  mkdirSync(join(base, 'broken.lock'))
  writeFileSync(join(base, 'legacy.lock'), '12345-abcdef')
  for (const name of ['dead.lock', 'broken.lock', 'legacy.lock']) {
    assert.equal(withOwnerLock(join(base, name), () => 'ran', { waitMs: 200 }), 'ran', name)
    assert.equal(existsSync(join(base, name)), false, name)
  }
})

// 리뷰의 순서: A 와 B 가 같은 죽은 잠금을 읽고, B 가 먼저 회수해 일하는 동안 A 가 회수를 이어 가고, C 가 잡으려 한다
test('같은 죽은 잠금을 늦게 회수하는 쪽은 새 주인의 잠금을 옮기지 못하고, 세 번째 호출도 들어오지 못한다', (t) => {
  const lock = join(dir(t), 'a.lock')
  plant(lock, '999999 dead-token')
  const seenByA = peek(lock)!
  const inside = withOwnerLock(lock, () => {
    // B 가 일하는 중이다. A 가 처음 본 죽은 잠금으로 회수를 이어 간다
    const moved = reclaimDead(lock, seenByA)
    const owner = readFileSync(join(lock, 'owner'), 'utf8')
    // C 는 B 가 쥔 동안 잡지 못한다
    let third = 'entered'
    try { withOwnerLock(lock, () => null, { waitMs: 200 }) } catch (e) { third = e instanceof OwnerLockBusy ? 'busy' : String(e) }
    return { moved, owner, third }
  }, { waitMs: 200 })
  assert.equal(inside.moved, false)
  assert.match(inside.owner, new RegExp(`^${process.pid} `))
  assert.equal(inside.third, 'busy')
})

test('일하는 동안 남이 바꾼 잠금은 놓을 때 지우지 않는다', (t) => {
  const lock = join(dir(t), 'a.lock')
  withOwnerLock(lock, () => writeFileSync(join(lock, 'owner'), `${process.pid} other-token`))
  assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), `${process.pid} other-token`)
})
