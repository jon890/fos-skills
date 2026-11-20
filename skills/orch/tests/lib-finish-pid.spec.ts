// lib/finish-pid.ts: 마무리 pid 파일과 다시 돌기 요청을 한 잠금 안에서 주고받고, 내 pid 가 적힌 파일만 지운다.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { claimPid, nextOrRelease, releaseOwnPid, rerunFile, startOrQueue } from '../scripts/lib/finish-pid.ts'

function pidFile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'finish-pid-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'finish-77.pid')
}

function liveChild(t: TestContext): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  return child.pid!
}

const read = (file: string) => readFileSync(file, 'utf8').trim()

test('끝난 마무리가 pid 파일을 놓은 뒤 새 마무리가 뜨면, 끝난 쪽은 새 pid 파일을 지우지 않는다', (t) => {
  const file = pidFile(t)
  claimPid(file)
  // 끝나는 마무리: 요청이 없어 내 pid 파일을 놓는다
  assert.equal(nextOrRelease(file), false)
  assert.equal(existsSync(file), false)
  // 그 사이 followup done 이 새 마무리를 띄웠다
  const fresh = liveChild(t)
  assert.equal(startOrQueue(file, () => fresh), 'started')
  // 끝나는 마무리의 finally 는 새 pid 파일을 지우지 않는다
  releaseOwnPid(file)
  assert.equal(read(file), String(fresh))
  assert.equal(nextOrRelease(file), false)
  assert.equal(read(file), String(fresh))
})

test('도는 마무리가 살아 있으면 요청을 남기고, 그 마무리가 끝날 때 가져가 pid 를 지킨 채 한 번 더 돈다', (t) => {
  const file = pidFile(t)
  writeFileSync(file, String(liveChild(t)))
  let called = false
  assert.equal(startOrQueue(file, () => { called = true; return 1 }), 'queued')
  assert.equal(called, false)
  assert.equal(existsSync(rerunFile(file)), true)
  assert.equal(nextOrRelease(file), true)
  assert.equal(read(file), String(process.pid))
  assert.equal(existsSync(rerunFile(file)), false)
  assert.equal(nextOrRelease(file), false)
  assert.equal(existsSync(file), false)
})

test('띄우지 못하면 failed 이고 pid 파일을 쓰지 않는다', (t) => {
  const file = pidFile(t)
  assert.equal(startOrQueue(file, () => null), 'failed')
  assert.equal(existsSync(file), false)
})
