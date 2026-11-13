// 원인 줄과 연속 실패 알림을 임시 저장소의 실제 부모·틱 프로세스로 확인한다.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import { causeKey, tickCause } from '../scripts/loop/lifecycle.ts'

test('틱 원인 줄은 경고를 빼고 stderr 마지막 줄, stdout 오류 줄 순서로 고른다', () => {
  assert.equal(tickCause(['Error stdout'], ['first', 'last', ' ']), 'last')
  assert.equal(tickCause(['ok', 'orch-loop: 실패'], ['STALE-BUNDLE old']), 'orch-loop: 실패')
  assert.equal(tickCause(['ok'], []), null)
  assert.equal(tickCause([], ['x'.repeat(201)]), 'x'.repeat(200))
  assert.equal(causeKey('pid 123 at 10:20'), causeKey('pid 456 at 11:30'))
})

test('설정 오류는 세 번째 실패에 한 번 바로 알리고 성공 뒤 다시 센다', { timeout: 120_000 }, async t => {
  const root = tempDir('loop-tick-failure-', t)
  const repo = join(root, 'repo')
  const orch = join(root, 'orch')
  mkdirSync(repo)
  mkdirSync(orch)
  const config = join(orch, 'config.json')
  const good = { pipeline: { tick_sec: 0.2 } }
  writeFileSync(config, JSON.stringify(good))
  const reply = (data: unknown) => JSON.stringify({ ok: true, result: data })
  const orca = fakeBin(root, 'orca', [
    { args: ['send'], stdout: reply({ message: { id: 'n' } }) },
    { args: ['run-current'], stdout: reply({ run: null }) },
    { args: ['worker-list'], stdout: reply({ workers: [], page: {} }) },
    { args: ['task-list'], stdout: reply({ tasks: [] }) },
    { stdout: reply({ messages: [] }) },
  ])
  const gh = fakeBin(root, 'gh', [{ args: ['api', 'user'], stdout: 'me' }, { stdout: '[]' }])
  const noop = join(root, 'noop.ts')
  writeFileSync(noop, '')
  const script = fileURLToPath(new URL('../scripts/loop/orch-loop.ts', import.meta.url))
  const env = { ...process.env, ORCH_DIR: orch, ORCH_MACHINE_DIR: join(root, 'machine'), CLAUDE_CONFIG_DIR: join(root, 'cfg'), ORCA: orca.path, GH: gh.path, CLEANUP_SWEEP: noop, BOARD_SYNC: noop, ORCH_LOOP_BOUND: '{"run":null}', GIT_CEILING_DIRECTORIES: root }
  delete env.NODE_OPTIONS
  const child = spawn(process.execPath, [script, '--repo', repo, '--run', 'r', '--foreground'], { env, stdio: 'ignore' })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed })
  const stateFile = join(orch, 'state', 'loop.json')
  const state = () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null
  const wait = async (predicate: () => boolean) => {
    const until = Date.now() + 40_000
    while (!predicate()) {
      assert.ok(Date.now() < until, `기대한 틱 상태가 오지 않았다: ${JSON.stringify(state())}`)
      assert.equal(child.exitCode, null, '부모가 먼저 끝났다')
      await sleep(50)
    }
  }
  const notices = () => orca.calls().filter(c => c.argv.includes('send') && c.argv[c.argv.indexOf('--body') + 1]?.startsWith('tick: 종료 코드 2: orch-loop:'))
  await wait(() => state()?.ticks >= 1)
  writeFileSync(config, JSON.stringify({ ...good, unknown_section: {} }))
  await wait(() => notices().length === 1)
  assert.match(notices()[0].argv[notices()[0].argv.indexOf('--body') + 1], /모르는 절/)
  const third = state().ticks
  await wait(() => state()?.ticks >= third + 2)
  assert.equal(notices().length, 1)
  writeFileSync(config, JSON.stringify(good))
  await wait(() => state()?.errors['tick@r'] === null)
  writeFileSync(config, JSON.stringify({ ...good, unknown_section: {} }))
  await wait(() => notices().length === 2)
})
