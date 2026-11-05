import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nodeScript, runCommand, runCommandAsync } from '../command.ts'

const node = (code: string) => [process.execPath, '-e', code]

describe('runCommand', () => {
  it('종료 코드를 돌려준다', () => {
    const r = runCommand(node('process.exit(3)'))
    assert.equal(r.code, 3)
    assert.equal(r.timedOut, false)
  })

  it('신호로 끝나면 signal 이 있다', () => {
    const r = runCommand(node("process.kill(process.pid, 'SIGTERM')"))
    assert.equal(r.signal, 'SIGTERM')
    assert.equal(r.code, null)
  })

  it('stdin 을 그대로 돌려준다', () => {
    const r = runCommand(node("process.stdin.pipe(process.stdout)"), { input: 'hello' })
    assert.equal(r.stdout, 'hello')
  })

  it('시간 초과면 timedOut 이다', () => {
    const r = runCommand(node('setTimeout(() => {}, 30000)'), { timeoutMs: 200 })
    assert.equal(r.timedOut, true)
  })

  it('NODE_TEST_CONTEXT 를 자식에게 넘기지 않는다', () => {
    const r = runCommand(node("process.stdout.write(String(process.env.NODE_TEST_CONTEXT))"), {
      env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' },
    })
    assert.equal(r.stdout, 'undefined')
  })

  it('nodeScript 는 현재 node 로 스크립트를 부른다', () => {
    assert.deepEqual(nodeScript('a.ts', ['x']), [process.execPath, 'a.ts', 'x'])
  })
})

describe('runCommandAsync', () => {
  it('같은 꼴로 돌려준다', async () => {
    const r = await runCommandAsync(node("process.stdin.pipe(process.stdout); process.stderr.write('e')"), { input: 'in' })
    assert.deepEqual([r.code, r.stdout, r.stderr, r.timedOut], [0, 'in', 'e', false])
  })

  it('시간이 지나면 SIGKILL 하고 timedOut 이다', async () => {
    const r = await runCommandAsync(node('setTimeout(() => {}, 30000)'), { timeoutMs: 200 })
    assert.equal(r.timedOut, true)
    assert.equal(r.signal, 'SIGKILL')
  })
})
