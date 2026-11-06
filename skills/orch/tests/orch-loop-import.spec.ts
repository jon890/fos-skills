import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

test('루프를 import 하면 CLI 를 실행하거나 신호 처리기를 걸지 않고 main 을 내보낸다', () => {
  const url = new URL('../scripts/loop/orch-loop.ts', import.meta.url).href
  const done = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const events = ['SIGTERM', 'SIGINT', 'SIGHUP', 'uncaughtException', 'unhandledRejection']
    const before = events.map((event) => process.listenerCount(event))
    const { main } = await import(${JSON.stringify(url)})
    if (typeof main !== 'function' || JSON.stringify(before) !== JSON.stringify(events.map((event) => process.listenerCount(event)))) process.exitCode = 1
  `], { encoding: 'utf8' })
  assert.equal(done.status, 0, done.stderr)
  assert.equal(done.stdout, '')
  assert.equal(done.stderr, '')
})
