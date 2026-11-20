// pipeline.slow_sec 이 있으면 느린 단계(정리, 보드 동기화)를 따로 돈다(orch-loop.ts 머리 주석의 「느린 단계」).
// 임시 저장소의 실제 부모·틱 프로세스로, 정리가 오래 걸려도 빠른 틱이 계속 돌고 정리는 slow_sec 마다 한 번만 도는지 본다.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin } from './fixtures/fake-bin.ts'

test('느린 정리가 도는 동안에도 빠른 틱이 계속 돌고, 정리는 slow_sec 안에 한 번만 돈다', { timeout: 120_000 }, async t => {
  const root = tempDir('loop-slow-tick-', t)
  const repo = join(root, 'repo')
  const orch = join(root, 'orch')
  mkdirSync(repo)
  mkdirSync(orch)
  writeFileSync(join(orch, 'config.json'), JSON.stringify({ pipeline: { tick_sec: 0.2, slow_sec: 3600 } }))
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
  // 정리 대역: 시작을 적고 끝내라는 표시가 생길 때까지 기다린 뒤 끝을 적는다
  const sweeps = join(root, 'sweeps.log')
  const release = join(root, 'release')
  const sweep = join(root, 'sweep.ts')
  writeFileSync(sweep, `import { appendFileSync, existsSync } from 'node:fs'
appendFileSync(${JSON.stringify(sweeps)}, 'start\\n')
const until = Date.now() + 60_000
while (!existsSync(${JSON.stringify(release)}) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
appendFileSync(${JSON.stringify(sweeps)}, 'end\\n')
`)
  const script = fileURLToPath(new URL('../scripts/loop/orch-loop.ts', import.meta.url))
  const env = { ...process.env, ORCH_DIR: orch, ORCH_MACHINE_DIR: join(root, 'machine'), CODEX_BIN: join(root, 'no-codex'), CLAUDE_CONFIG_DIR: join(root, 'cfg'), ORCA: orca.path, GH: gh.path, CLEANUP_SWEEP: sweep, BOARD_SYNC: noop, ORCH_LOOP_BOUND: '{"run":null}', GIT_CEILING_DIRECTORIES: root }
  delete env.NODE_OPTIONS
  const child = spawn(process.execPath, [script, '--repo', repo, '--run', 'r', '--foreground'], { env, stdio: 'ignore' })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed })
  const stateFile = join(orch, 'state', 'loop.json')
  const state = () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null
  const log = () => existsSync(sweeps) ? readFileSync(sweeps, 'utf8').split('\n').filter(Boolean) : []
  const wait = async (predicate: () => boolean, what: string) => {
    const until = Date.now() + 40_000
    while (!predicate()) {
      assert.ok(Date.now() < until, `${what}: ${JSON.stringify(state())} ${JSON.stringify(log())}`)
      assert.equal(child.exitCode, null, '부모가 먼저 끝났다')
      await sleep(50)
    }
  }
  await wait(() => log().length >= 1, '정리가 시작되지 않았다')
  // 정리가 끝나지 않은 채로 빠른 틱이 여러 번 돈다
  await wait(() => state()?.ticks >= 4, '정리가 도는 동안 빠른 틱이 돌지 않았다')
  assert.deepEqual(log(), ['start'])
  writeFileSync(release, '')
  await wait(() => log().length === 2, '정리가 끝나지 않았다')
  const after = state().ticks
  await wait(() => state()?.ticks >= after + 3, '정리 뒤 빠른 틱이 돌지 않았다')
  // slow_sec(3600초)이 지나지 않아 정리를 다시 띄우지 않았다
  assert.deepEqual(log(), ['start', 'end'])
  assert.equal(state().errors['slow-tick@r'], null)
  assert.equal(state().errors['cleanup@r'], null)
})
