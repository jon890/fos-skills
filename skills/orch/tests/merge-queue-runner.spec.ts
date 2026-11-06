import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeRun } from '../../../modules/testkit/fake-run.ts'
import { run, runProcess, withRun } from '../scripts/lib/proc.ts'
import { main } from '../scripts/queue/merge_queue.ts'

test('주입은 비동기 호출 범위에만 남고 실제 실행으로 넘길 수 있다', async () => {
  const left = fakeRun({ probe: [{ stdout: 'left' }] })
  const right = fakeRun({ probe: [{ stdout: 'right' }] })
  const invoke = (runner: typeof run) => withRun(runner, async () => {
    await new Promise((resolve) => setImmediate(resolve))
    return run(['probe']).stdout
  })
  assert.deepEqual(await Promise.all([invoke(left.run), invoke(right.run)]), ['left', 'right'])
  const actual = withRun(() => runProcess([process.execPath, '-e', 'process.stdout.write("actual")']), () => run(['probe']))
  assert.equal(actual.stdout, 'actual')
  assert.equal(run(['probe']).code, 127)
})

test('큐를 import 하면 CLI 와 신호 처리기를 실행하지 않는다', () => {
  assert.equal(typeof main, 'function')
  assert.equal(process.listeners('SIGTERM').some((listener) => listener.name === 'onSignal'), false)
  assert.equal(process.listeners('SIGINT').some((listener) => listener.name === 'onSignal'), false)
})
