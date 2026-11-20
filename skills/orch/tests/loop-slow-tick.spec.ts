// pipeline.slow_sec 이 있으면 느린 단계(정리, 보드 동기화)를 따로 돈다(orch-loop.ts 머리 주석의 「느린 단계」).
// 임시 저장소의 실제 부모·틱 프로세스로 본다. 정리 대역은 시작과 끝을 파일에 적고, 끝내라는 표시가 생길 때까지 기다린다.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import { queuedNotices } from './fixtures/queued-notices.ts'

function startLoop(t: TestContext, pipeline: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  // t.after 는 등록한 차례로 돈다. 루프를 멈추는 정리를 임시 폴더 정리보다 먼저 등록한다(loop-tick-failure.spec.ts 와 같다)
  let stop = async () => {}
  t.after(() => stop())
  const root = tempDir('loop-slow-tick-', t)
  const repo = join(root, 'repo')
  const orch = join(root, 'orch')
  mkdirSync(repo)
  mkdirSync(orch)
  writeFileSync(join(orch, 'config.json'), JSON.stringify({ pipeline }))
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
  const env = { ...process.env, ORCH_DIR: orch, ORCH_MACHINE_DIR: join(root, 'machine'), CODEX_BIN: join(root, 'no-codex'), CLAUDE_CONFIG_DIR: join(root, 'cfg'), ORCA: orca.path, GH: gh.path, CLEANUP_SWEEP: sweep, BOARD_SYNC: noop, ORCH_LOOP_BOUND: '{"run":null}', GIT_CEILING_DIRECTORIES: root, ...extraEnv }
  delete env.NODE_OPTIONS
  const child = spawn(process.execPath, [script, '--repo', repo, '--run', 'r', '--foreground'], { env, stdio: 'ignore' })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed }
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
  // WATCH-ERROR 는 모아 보내기(DIGEST)로 쌓인다(lib/notice-digest.ts)
  const notices = () => queuedNotices(orch).filter((row) => row.kind === 'WATCH-ERROR').map((row) => String(row.text))
  return { state, log, wait, notices, release: () => writeFileSync(release, '') }
}

test('느린 정리가 도는 동안에도 빠른 틱이 계속 돌고, 정리는 slow_sec 안에 한 번만 돈다', { timeout: 120_000 }, async t => {
  const loop = startLoop(t, { tick_sec: 0.2, slow_sec: 3600 })
  await loop.wait(() => loop.log().length >= 1, '정리가 시작되지 않았다')
  // 정리가 끝나지 않은 채로 빠른 틱이 여러 번 돈다
  await loop.wait(() => loop.state()?.ticks >= 4, '정리가 도는 동안 빠른 틱이 돌지 않았다')
  assert.deepEqual(loop.log(), ['start'])
  loop.release()
  await loop.wait(() => loop.log().length === 2, '정리가 끝나지 않았다')
  const after = loop.state().ticks
  await loop.wait(() => loop.state()?.ticks >= after + 3, '정리 뒤 빠른 틱이 돌지 않았다')
  // slow_sec(3600초)이 지나지 않아 정리를 다시 띄우지 않았다
  assert.deepEqual(loop.log(), ['start', 'end'])
  assert.equal(loop.state().errors['slow-tick@r'], null)
  assert.equal(loop.state().errors['cleanup@r'], null)
})

test('slow_sec 이 지나면 정리를 다시 돈다', { timeout: 120_000 }, async t => {
  const loop = startLoop(t, { tick_sec: 0.2, slow_sec: 1 })
  loop.release()
  await loop.wait(() => loop.log().filter((line) => line === 'start').length >= 2, '정리가 다시 돌지 않았다')
})

test('느린 틱이 시간 상한을 넘기면 끊고 WATCH-ERROR slow-tick 을 알린다', { timeout: 120_000 }, async t => {
  const loop = startLoop(t, { tick_sec: 0.2, slow_sec: 3600 }, { ORCH_SLOW_TICK_LIMIT_SEC: '1' })
  await loop.wait(() => typeof loop.state()?.errors?.['slow-tick@r'] === 'string', '끊긴 느린 틱이 기록되지 않았다')
  assert.match(loop.state().errors['slow-tick@r'], /^1초를 넘겨 끊었다$/)
  await loop.wait(() => loop.notices().some((body) => body.startsWith('slow-tick: 1초를 넘겨 끊었다')), 'WATCH-ERROR slow-tick 을 모아 보내기에 쌓지 않았다')
  assert.deepEqual(loop.log(), ['start'])
})
