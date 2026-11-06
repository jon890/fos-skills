// 새 fixture 가 실제 명령과 같은 출력·종료·파일 변화를 내고 지연을 실제 실행으로 넘기는지 본다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { linkBin } from '../../../modules/testkit/fake-bin.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { runProcess } from '../scripts/lib/proc.ts'
import { statefulRun as launchRun } from './fixtures/launch-worker-run.ts'
import { statefulRun as doctorRun } from './fixtures/orch-doctor-run.ts'

test('launch·doctor 가짜의 성공·실패·상태·출력이 실제 명령과 같다', (t) => {
  const dir = tempDir('worker-doctor-run-', t)
  const state = join(dir, 'state.json')
  const bin = linkBin(dir, 'orca', `const fs = require('node:fs')
const file = process.env.STATE
fs.writeFileSync(file, String(Number(fs.readFileSync(file, 'utf8')) + 1))
console.log(process.argv.slice(2).join(':'))
console.error('diagnostic')
fs.writeSync(1, process.cwd() + '\\n')
process.exitCode = process.argv.includes('fail') ? 3 : 0
process.exit()`)
  for (const run of [launchRun, doctorRun]) {
    for (const args of [['ok'], ['fail']]) {
      const opts = { cwd: dir, env: { ORCA: bin, STATE: state } }
      writeFileSync(state, '0')
      const real = runProcess([bin, ...args], opts)
      const realState = readFileSync(state, 'utf8')
      writeFileSync(state, '0')
      assert.deepEqual(run([bin, ...args], opts), real)
      assert.equal(readFileSync(state, 'utf8'), realState)
    }
  }
})

test('doctor 의 지연 가짜는 실제 프로세스 시간 제한으로 끝낸다', (t) => {
  const dir = tempDir('doctor-delay-', t)
  const bin = linkBin(dir, 'orca', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000)')
  const done = doctorRun([bin], { env: { ORCA: bin, FAKE_SLEEP: '10' }, timeoutMs: 30 })
  assert.equal(done.code, 124)
  assert.equal(done.timedOut, true)
})

for (const [entry, fixture, prefix] of [
  ['worker/launch-worker', 'launch-worker-run', 'launch-worker'],
  ['doctor/orch-doctor', 'orch-doctor-run', 'orch-doctor'],
]) {
  test(`${prefix} fixture 는 실제 CLI 와 같은 오류 처리기를 쓴다`, (t) => {
    const dir = tempDir('worker-doctor-error-', t)
    const preload = join(dir, 'error.cjs')
    writeFileSync(preload, "process.stdout.write = () => { throw new Error('forced-output-error') }")
    for (const relative of [`../scripts/${entry}.ts`, `./fixtures/${fixture}.ts`]) {
      const script = fileURLToPath(new URL(relative, import.meta.url))
      const done = spawnSync(process.execPath, [script, '--help'], {
        encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
      })
      assert.equal(done.status, 1, done.stderr)
      assert.match(done.stderr, new RegExp(`${prefix}: Error: forced-output-error`))
    }
  })
}
