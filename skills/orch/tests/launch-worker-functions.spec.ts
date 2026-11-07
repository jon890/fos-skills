import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runCommand } from '../../../modules/testkit/command.ts'

test('판정 명령을 import해도 인자·출력·종료 코드·신호 처리기를 건드리지 않는다', () => {
  for (const name of ['spec/spec-line', 'spec/spec-lint', 'wait/wait-important']) {
    const url = new URL(`../scripts/${name}.ts`, import.meta.url).href
    const done = runCommand([process.execPath, '--input-type=module', '-e', `
      process.argv.push('--invalid-import-option')
      process.exitCode = 7
      const signals = ['SIGTERM', 'SIGINT', 'SIGHUP']
      const counts = signals.map(signal => process.listenerCount(signal))
      const module = await import(${JSON.stringify(url)})
      if (typeof module.main !== 'function') throw new Error('main missing')
      if (signals.some((signal, index) => process.listenerCount(signal) !== counts[index])) throw new Error('signal handler installed')
      console.log('imported')
    `])
    assert.equal(done.code, 7)
    assert.equal(done.stdout, 'imported\n')
    assert.equal(done.stderr, '')
  }
})
