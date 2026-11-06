import assert from 'node:assert/strict'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeBin, linkBin } from '../../../modules/testkit/fake-bin.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { runProcess } from '../scripts/lib/proc.ts'
import { statefulRun } from './fixtures/orch-loop-run.ts'

test('gh 함수와 실행 파일의 규칙·환경·cwd·기록·종료가 같다', (t) => {
  const dir = tempDir('loop-run-gh-', t)
  const gh = fakeBin(dir, 'gh', [{ args: ['fail'], code: 7, stdout: 'out\n', stderr: 'err\n' }], { recordEnv: ['LOOP_TEST', 'LOOP_MISSING'] })
  const opts = { cwd: dir, env: { GH: gh.path, LOOP_TEST: 'value', LOOP_MISSING: undefined } }
  for (const args of [['pr', 'list'], ['fail']]) {
    const real = runProcess([gh.path, ...args], opts)
    const fake = statefulRun([gh.path, ...args], opts)
    assert.deepEqual(fake, real)
  }
  const calls = gh.calls()
  assert.deepEqual(calls[0], calls[1])
  assert.deepEqual(calls[2], calls[3])
  assert.deepEqual(calls[0].env, { LOOP_TEST: 'value', LOOP_MISSING: null })
})

test('orca 와 ps 는 같은 본문으로 성공·실패·상태 변화를 관측한다', (t) => {
  const dir = tempDir('loop-run-state-', t)
  writeFileSync(join(dir, 'orca.json'), '{}')
  for (const command of ['ORCA', 'PS']) {
    const bin = linkBin(dir, command.toLowerCase(), `
      const fs = require('node:fs')
      const file = process.env.FAKE_DIR + '/state.json'
      const state = JSON.parse(fs.readFileSync(file, 'utf8'))
      fs.writeFileSync(file, JSON.stringify({ ...state, calls: state.calls + 1 }))
      process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n')
      process.stderr.write(state.code ? 'offline\\n' : '')
      process.exit(state.code)
    `)
    const opts = { cwd: dir, env: { [command]: bin, FAKE_DIR: dir } }
    for (const code of [0, 1]) {
      const reset = () => writeFileSync(join(dir, 'state.json'), JSON.stringify({ code, calls: 0 }))
      reset()
      const real = runProcess([bin, 'check'], opts)
      const realState = readFileSync(join(dir, 'state.json'), 'utf8')
      reset()
      assert.deepEqual(statefulRun([bin, 'check'], opts), real)
      assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), realState)
    }
  }
})

test('가짜 본문 예외는 명령 실패로 돌려주고 실제 명령은 기존 실행으로 넘긴다', (t) => {
  const dir = tempDir('loop-run-error-', t)
  const gh = linkBin(dir, 'gh', "throw new Error('broken fake')")
  const done = statefulRun([gh], { env: { GH: gh } })
  assert.equal(done.code, 1)
  assert.match(done.stderr, /broken fake/)
  assert.equal(done.timedOut, false)
  assert.deepEqual(statefulRun([process.execPath, '-e', 'process.stdout.write("real")']), runProcess([process.execPath, '-e', 'process.stdout.write("real")']))
})

test('지연 판정용 상태가 깨져도 runner 밖으로 예외를 던지지 않는다', (t) => {
  const dir = tempDir('loop-run-broken-state-', t)
  writeFileSync(join(dir, 'orca.json'), '{')
  const orca = linkBin(dir, 'orca', "JSON.parse(require('node:fs').readFileSync(process.env.FAKE_DIR + '/orca.json', 'utf8'))")
  const opts = { env: { ORCA: orca, FAKE_DIR: dir } }
  assert.deepEqual(statefulRun([orca], opts), runProcess([orca], opts))
})

test('셸 ps 와 지연된 orca 는 실제 실행과 시간 제한을 유지한다', (t) => {
  const dir = tempDir('loop-run-process-', t)
  const ps = join(dir, 'ps')
  writeFileSync(ps, '#!/bin/sh\nprintf "shell\\n"\nexit 7\n')
  chmodSync(ps, 0o755)
  assert.deepEqual(statefulRun([ps], { env: { PS: ps } }), runProcess([ps]))
  writeFileSync(join(dir, 'orca.json'), '{"sleep": 1}')
  const orca = linkBin(dir, 'orca', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)')
  const done = statefulRun([orca], { env: { ORCA: orca, FAKE_DIR: dir }, timeoutMs: 30 })
  assert.equal(done.code, 124)
  assert.equal(done.timedOut, true)
})

test('없는 파일과 실행 권한·셰뱅이 없는 파일은 실제 실행 결과를 유지한다', (t) => {
  const dir = tempDir('loop-run-invalid-', t)
  const notExecutable = join(dir, 'not-executable')
  writeFileSync(notExecutable, `#!${process.execPath}\nprocess.exitCode = 0\n`)
  const noShebang = join(dir, 'no-shebang')
  writeFileSync(noShebang, 'process.exitCode = 0\n')
  chmodSync(noShebang, 0o755)
  for (const bin of [join(dir, 'missing'), notExecutable, noShebang]) {
    const opts = { cwd: dir, env: { GH: bin } }
    assert.deepEqual(statefulRun([bin], opts), runProcess([bin], opts), bin)
  }
})

test('인자 없는 exit 은 앞서 정한 exitCode 를 유지한다', (t) => {
  const dir = tempDir('loop-run-exit-', t)
  const gh = linkBin(dir, 'gh', 'process.exitCode = 3; process.exit()')
  const opts = { env: { GH: gh } }
  assert.deepEqual(statefulRun([gh], opts), runProcess([gh], opts))
})

test('console 의 동기 출력은 가짜 stdout 과 stderr 에 모인다', (t) => {
  const dir = tempDir('loop-run-console-', t)
  const gh = linkBin(dir, 'gh', "console.log('value %d', 3); console.info({ ok: true }); console.warn('warn'); console.error('error')")
  const opts = { env: { GH: gh } }
  assert.deepEqual(statefulRun([gh], opts), runProcess([gh], opts))
})

test('상대 실행 경로는 opts.cwd 에서 실제 명령으로 실행한다', (t) => {
  const dir = tempDir('loop-run-relative-', t)
  linkBin(dir, 'gh', "process.stdout.write('relative\\n')")
  const opts = { cwd: dir, env: { GH: './gh' } }
  assert.deepEqual(statefulRun(['./gh'], opts), runProcess(['./gh'], opts))
})
