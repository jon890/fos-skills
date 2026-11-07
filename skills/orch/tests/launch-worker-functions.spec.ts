import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from '../../../modules/testkit/command.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { linkBin } from '../../../modules/testkit/fake-bin.ts'
import { runAsync, scriptCommand } from '../scripts/lib/proc.ts'
import { asyncRun, captureMain } from './fixtures/launch-worker-run.ts'
import { statefulRun as waitRun } from './fixtures/wait-important-run.ts'

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

test('spec 명령의 함수 출력과 실제 CLI 출력이 같다', async () => {
  for (const name of ['spec-line', 'spec-lint']) {
    const script = fileURLToPath(new URL(`../scripts/spec/${name}.ts`, import.meta.url))
    const argv = scriptCommand(script, ['--help'])
    assert.deepEqual(await asyncRun(argv), await runAsync(argv))
  }
})

test('판정 명령은 심볼릭 링크로 직접 실행해도 CLI를 실행한다', (t) => {
  const dir = tempDir('spec-main-links-', t)
  for (const name of ['spec/spec-line', 'spec/spec-lint', 'wait/wait-important']) {
    const script = fileURLToPath(new URL(`../scripts/${name}.ts`, import.meta.url))
    const link = join(dir, `${name.replaceAll('/', '-')}.ts`)
    symlinkSync(script, link)
    const done = runCommand(scriptCommand(link, ['--help']))
    assert.equal(done.code, 0)
    assert.match(done.stdout, /사용법:/)
    assert.equal(done.stderr, '')
  }
})

test('동기 main의 부분 출력·오류와 출력 함수 복구를 보존한다', () => {
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  const done = captureMain((argv) => {
    assert.deepEqual(argv, ['input'])
    process.stdout.write(Buffer.from('before'))
    process.stderr.write('warning\n')
    throw new Error('main failed')
  }, ['input'])
  assert.equal(done.code, 1)
  assert.equal(done.stdout, 'before')
  assert.match(done.stderr, /^warning\nError: main failed/)
  assert.equal(process.stdout.write, stdout)
  assert.equal(process.stderr.write, stderr)
})

test('spec 실행에 별도 env를 주면 실제 프로세스에서 적용한다', async (t) => {
  const dir = tempDir('spec-options-', t)
  const preload = join(dir, 'preload.mjs')
  writeFileSync(preload, "process.stdout.write('preloaded\\n')")
  const script = fileURLToPath(new URL('../scripts/spec/spec-line.ts', import.meta.url))
  const done = await asyncRun(scriptCommand(script, ['--help']), { env: { NODE_OPTIONS: `--import=${preload}` } })
  assert.equal(done.code, 0)
  assert.match(done.stdout, /^preloaded\n사용법:/)
})

test('wait의 동기 조회는 함수로 호출하고 check --wait의 비동기 자식은 실제 실행한다', (t) => {
  const dir = tempDir('wait-functions-', t)
  const bin = linkBin(dir, 'orca', `
    if (process.argv.includes('--wait')) setTimeout(() => console.log('waited'), 20)
    else console.log(process.ppid)
  `)
  const opts = { env: { ORCA: bin } }
  assert.equal(waitRun([bin, 'orchestration', 'worker-list'], opts).stdout.trim(), String(process.pid))
  assert.equal(waitRun([bin, 'orchestration', 'check', '--wait'], opts).stdout, 'waited\n')
})
