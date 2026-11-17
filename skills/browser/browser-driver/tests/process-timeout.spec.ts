import assert from 'node:assert/strict'
import { spawn, type spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'
import { main } from '../browser_driver.ts'
import { withRuntime } from '../driver/runtime.ts'
import { run } from '../driver/shell.ts'
import { DriverError } from '../driver/errors.ts'
import { Box, egoOut, write } from './helpers.ts'

test('ego 명령의 대기 시간에 정리 여유를 더해 프로세스를 제한한다', (t) => {
  const box = new Box(t)
  box.fake('ego-browser')
  const cases: [string[], number][] = [
    [['waitjs', '1:p1', 'true'], 15_000],
    [['waitjs', '1:p1', 'true', '40000'], 45_000],
    [['ready', '1:p1'], 35_000],
    [['ready', '1:p1', '99'], 5_099],
    [['open', 'about:blank', '70000'], 75_000],
    [['nav', '1:p1', 'about:blank', '70000'], 75_000],
    [['js', '1:p1', '1'], 20_000],
    [['js', '1:p1', '1', '--timeout', '45000'], 50_000],
    [['waitjs', '1:p1', 'true', '0'], 35_000],
    [['url', '1:p1'], 35_000],
  ]
  const source = write(join(box.root, 'script.js'), '1')
  cases.push([['jsfile', '1:p1', source, '--timeout', '45000'], 50_000])
  for (const [args, timeout] of cases) {
    const calls: any[] = []
    const code = main(args, {
      env: box.childEnv({ BROWSER_DRIVER: 'ego' }), write() {},
      spawn: ((_binary: string, _argv: string[], options: any) => {
        calls.push(options)
        return { status: 0, signal: null, stdout: Buffer.from(egoOut('1:p1\tDefault\tPersonal\twork')), stderr: Buffer.alloc(0) }
      }) as typeof spawnSync,
    })
    assert.equal(code, 0, args.join(' '))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].timeout, timeout, args.join(' '))
    assert.equal(calls[0].killSignal, 'SIGKILL')
  }
})

test('시간을 넘긴 실제 프로세스는 SIGTERM 을 무시해도 끝나고 다른 자식은 남는다', async (t) => {
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => other.kill('SIGKILL'))
  await once(other, 'spawn')
  const box = new Box(t)
  const pidFile = join(box.root, 'pid')
  const source = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
  assert.throws(() => run([process.execPath, '-e', source], { timeoutMs: 500 }), (error: unknown) => {
    assert.ok(error instanceof DriverError)
    assert.match(error.message, /500ms/)
    return true
  })
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.doesNotThrow(() => process.kill(other.pid!, 0))
})

test('waitjs 의 내부 대기가 멈춰도 CLI 는 실패로 끝나고 실행한 ego 만 종료한다', (t) => {
  const box = new Box(t)
  const pidFile = join(box.root, 'ego.pid')
  write(join(box.bin, 'ego-browser'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`, 0o755)
  const result = box.run(['waitjs', '1:p1', 'true', '1'], { BROWSER_DRIVER: 'ego' })
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /5001ms/)
  assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' })
})

test('프로세스 오류와 정상 출력은 기존대로 전달한다', () => {
  assert.equal(run([process.execPath, '-e', 'process.stdout.write("ok")'], { timeoutMs: 1000 }), 'ok')
  assert.throws(() => run(['/missing-browser-driver-binary'], { timeoutMs: 100 }), { code: 'ENOENT' })
  withRuntime({ env: {}, write() {}, spawn: (() => ({ error: Object.assign(new Error('other'), { code: 'EACCES' }) })) as typeof spawnSync }, () => {
    assert.throws(() => run(['fake'], { timeoutMs: 100 }), { code: 'EACCES' })
  })
})
