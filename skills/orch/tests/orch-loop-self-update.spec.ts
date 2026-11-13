// 실제 부모·자식과 임시 설치 캐시로 잠금 인계를 본다. 사용자 프로필과 실제 상주 루프는 건드리지 않는다.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import { alive } from '../scripts/lib/process.ts'
import { loopStatus } from '../scripts/lib/loop.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const entry = (bundle: string) => join(bundle, 'skills/orch/scripts/loop/orch-loop.ts')

async function scene(t: TestContext) {
  const root = tempDir('loop-handover-')
  const repo = join(root, 'repo')
  const orch = join(root, 'orch')
  const cfg = join(root, 'cfg with space')
  const bundles = ['1.0.0', '2.0.0'].map(v => join(cfg, 'plugins/cache/fos-skills/fos-skills', v))
  mkdirSync(repo)
  mkdirSync(orch)
  for (const bundle of bundles) {
    mkdirSync(join(bundle, 'skills'), { recursive: true })
    cpSync(join(REPO, 'skills/orch'), join(bundle, 'skills/orch'), { recursive: true })
    cpSync(join(REPO, 'extensions/work-board'), join(bundle, 'extensions/work-board'), { recursive: true })
    cpSync(join(REPO, 'modules'), join(bundle, 'modules'), { recursive: true })
    cpSync(join(REPO, '.claude-plugin'), join(bundle, '.claude-plugin'), { recursive: true })
    const file = join(bundle, '.claude-plugin/plugin.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), version: basename(bundle) }))
    symlinkSync(join(REPO, 'node_modules'), join(bundle, 'node_modules'), 'dir')
  }
  const install = (bundle: string) => writeFileSync(join(cfg, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'fos-skills@fos-skills': [{ scope: 'user', installPath: bundle }] } }))
  install(bundles[0])
  writeFileSync(join(orch, 'config.json'), JSON.stringify({ pipeline: { tick_sec: 0.3 } }))
  const reply = (data: unknown) => JSON.stringify({ ok: true, result: data })
  const orca = fakeBin(root, 'orca', [
    { args: ['send'], stdout: reply({ message: { id: 'n' } }) },
    { args: ['worker-list'], stdout: reply({ workers: [], page: {} }) },
    { args: ['task-list'], stdout: reply({ tasks: [] }) },
    { stdout: reply({ messages: [] }) },
  ])
  const gh = fakeBin(root, 'gh', [{ args: ['api', 'user'], stdout: 'me' }, { stdout: '[]' }])
  const ps = fakeBin(root, 'ps', [{ stdout: '' }])
  const noop = join(root, 'noop.ts')
  writeFileSync(noop, '')
  const env: NodeJS.ProcessEnv = { ...process.env, ORCH_DIR: orch, CLAUDE_CONFIG_DIR: cfg, ORCH_MACHINE_DIR: join(root, 'machine'), ORCA: orca.path, GH: gh.path, PS: ps.path, CLEANUP_SWEEP: noop, BOARD_SYNC: noop, ORCH_LOOP_ALIVE_SEC: '1', ORCH_LOOP_BOUND: '{"run":null}', GIT_CEILING_DIRECTORIES: root }
  delete env.NODE_OPTIONS
  delete env.ORCH_LOOP_HANDOVER
  const previousOrch = process.env.ORCH_DIR
  process.env.ORCH_DIR = orch
  const children: ChildProcess[] = []
  const stateFile = join(orch, 'state/loop.json')
  const logFile = join(orch, 'state/loop.log')
  const text = (file: string) => existsSync(file) ? readFileSync(file, 'utf8') : ''
  const state = () => text(stateFile) ? JSON.parse(text(stateFile)) : null
  const log = () => text(logFile)
  const lock = () => Number(text(join(orch, 'state/loop.lock')))
  const foregrounds = () => spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n')
    .filter(line => line.includes(root) && line.includes('orch-loop.ts') && line.includes('--foreground'))
  const wait = async (predicate: () => boolean, message = '기대한 상태가 오지 않았다') => {
    const until = Date.now() + 40_000
    while (!predicate()) {
      assert.ok(Date.now() < until, `${message}\n${log()}`)
      await sleep(50)
    }
  }
  t.after(async () => {
    for (const row of foregrounds()) {
      const pid = Number(/^\s*(\d+)/.exec(row)?.[1])
      if (pid > 0) { try { process.kill(pid, 'SIGTERM') } catch { /* 끝났다 */ } }
    }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const until = Date.now() + 7000
    while (foregrounds().length && Date.now() < until) await sleep(100)
    for (const row of foregrounds()) { try { process.kill(Number(/^\s*(\d+)/.exec(row)?.[1]), 'SIGKILL') } catch { /* 끝났다 */ } }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (previousOrch === undefined) delete process.env.ORCH_DIR
    else process.env.ORCH_DIR = previousOrch
  })
  const start = async () => {
    const child = spawn(process.execPath, [entry(bundles[0]), '--repo', repo, '--run', 'r1', '--foreground'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let output = ''
    child.stderr?.on('data', chunk => { output += String(chunk) })
    children.push(child)
    await wait(() => { assert.equal(child.exitCode, null, output); return state()?.ticks >= 2 }, '옛 루프가 두 틱을 끝내지 못했다')
    const runFile = join(orch, 'state/loop-runs/r2.json')
    writeFileSync(runFile, JSON.stringify({ run: 'r2', specs_dir: null, registered_at: new Date().toISOString(), coordinator_terminal: null }))
    return child
  }
  const finish = () => {
    const child = spawn('sleep', ['60'])
    children.push(child)
    const file = join(orch, 'queue/finish-9.pid')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, String(child.pid))
    return child
  }
  const notices = (kind: string) => orca.calls().filter(c => c.argv.includes('send') && c.argv[c.argv.indexOf('--subject') + 1]?.startsWith(`${kind} `))
  const cli = (args: string[]) => spawnSync(process.execPath, [entry(bundles[0]), '--repo', repo, ...args], { env, encoding: 'utf8' })
  // stop 을 동기로 기다리면 이 테스트가 띄운 옛 자식의 종료 회수가 막혀 zombie 를 살아 있다고 읽는다.
  const cliAsync = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry(bundles[0]), '--repo', repo, ...args], { env })
    children.push(child)
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
  return { root, repo, orch, bundles, env, install, start, finish, wait, state, log, lock, foregrounds, notices, cli, cliAsync }
}

test('넘기기는 Run 전부와 명의를 보존하고 새 상태를 쓴 뒤 옛 루프를 끝낸다', { timeout: 90_000 }, async t => {
  const s = await scene(t)
  const file = entry(s.bundles[1])
  writeFileSync(file, "await new Promise(resolve => setTimeout(resolve, 2000))\n" + readFileSync(file, 'utf8'))
  const old = await s.start()
  const live: boolean[] = []
  const during: boolean[] = []
  const monitor = setInterval(() => {
    const value = loopStatus(s.repo, Date.now()).alive
    live.push(value)
    if (s.lock() > 0 && s.lock() !== old.pid && s.state()?.pid === old.pid) during.push(value)
  }, 20)
  t.after(() => clearInterval(monitor))
  s.install(s.bundles[1])
  await s.wait(() => s.log().includes('LOOP-HANDOVER') && !alive(old.pid!))
  assert.equal(s.state().bundle_version, '2.0.0')
  assert.notEqual(s.state().pid, old.pid)
  assert.equal(s.state().bound_run, null)
  assert.deepEqual(s.state().runs, ['r1', 'r2'])
  assert.equal(s.foregrounds().length, 1)
  assert.ok(live.length > 0)
  assert.ok(live.every(Boolean), '넘기는 동안 죽은 루프로 보였다')
  assert.ok(during.length >= 2, '새 루프의 시작을 기다리는 동안 생존을 반복 확인해야 한다')
  assert.ok(during.every(Boolean))
  assert.equal(s.notices('LOOP-DEAD').length, 0, '넘기는 동안 LOOP-DEAD 를 보내지 않는다')
  clearInterval(monitor)
  const status = s.cli(['--status'])
  assert.equal(status.status, 0, status.stderr)
  assert.match(status.stdout, / bundle=2\.0\.0$/m)
  assert.equal(s.log().split('\n').filter(line => line.startsWith('LOOP-STALE ')).length, 1)
  assert.equal(s.log().split('\n').filter(line => line.startsWith('LOOP-HANDOVER ')).length, 1)
  const calls = s.notices('LOOP-UPDATED')
  assert.deepEqual(calls.map(c => c.argv[c.argv.indexOf('--to') + 1]).sort(), ['run:r1', 'run:r2'])
  for (const call of calls) assert.match(call.argv[call.argv.indexOf('--body') + 1], /repo 루프: 1\.0\.0 → 2\.0\.0/)
  await s.wait(() => s.state()?.ticks >= 1)
  assert.ok(!s.log().includes('STALE-BUNDLE '))
})

test('기다림 동안 경고를 쌓지 않고 마무리가 끝난 다음 틱 뒤 넘긴다', { timeout: 90_000 }, async t => {
  const s = await scene(t)
  await s.start()
  const finishing = s.finish()
  s.install(s.bundles[1])
  await s.wait(() => s.log().includes('LOOP-STALE-WAIT 마무리 PR 9'))
  const ticks = s.state().ticks
  await s.wait(() => s.state()?.ticks >= ticks + 2)
  assert.equal(s.state().bundle_version, '1.0.0')
  assert.equal(s.log().split('\n').filter(line => line.startsWith('LOOP-STALE ')).length, 1)
  assert.equal(s.log().split('\n').filter(line => line.startsWith('LOOP-STALE-WAIT ')).length, 1)
  assert.ok(!s.log().includes('STALE-BUNDLE '))
  assert.ok(alive(finishing.pid!))
  finishing.kill('SIGTERM')
  await s.wait(() => s.log().includes('LOOP-HANDOVER'))
  assert.equal(s.state().bundle_version, '2.0.0')
})

test('설정 오류인 틱은 마무리를 끊지 않고 바로 넘긴다', { timeout: 90_000 }, async t => {
  const s = await scene(t)
  const marker = join(s.root, 'bad-config')
  const oldEntry = entry(s.bundles[0])
  writeFileSync(oldEntry, `if (process.argv.includes('--tick') && (await import('node:fs')).existsSync(${JSON.stringify(marker)})) { process.stderr.write('orch-loop: 모르는 절이 있다: adr\\n'); process.exit(2) }\n` + readFileSync(oldEntry, 'utf8'))
  await s.start()
  const finishing = s.finish()
  writeFileSync(marker, '')
  s.install(s.bundles[1])
  await s.wait(() => s.log().includes('LOOP-HANDOVER'))
  assert.ok(!s.log().includes('LOOP-STALE-WAIT'))
  assert.ok(s.log().includes('WATCH-ERROR tick: 종료 코드 2: orch-loop: 모르는 절이 있다: adr'))
  await s.wait(() => s.state()?.bundle_version === '2.0.0' && s.state()?.last_tick !== null)
  assert.ok(alive(finishing.pid!))
})

test('실패하면 잠금을 되찾고 Run 마다 한 번 알린 뒤 같은 진입점은 다시 시도하지 않는다', { timeout: 90_000 }, async t => {
  const s = await scene(t)
  writeFileSync(entry(s.bundles[1]), 'process.exit(1)\n')
  const old = await s.start()
  s.install(s.bundles[1])
  await s.wait(() => s.notices('LOOP-UPDATE-FAIL').length === 2)
  assert.equal(s.lock(), old.pid)
  assert.equal(s.state().pid, old.pid)
  assert.ok(alive(old.pid!))
  const ticks = s.state().ticks
  await s.wait(() => s.state()?.ticks >= ticks + 3)
  assert.equal(s.notices('LOOP-UPDATE-FAIL').length, 2)
  assert.equal(s.log().split('\n').filter(line => line.startsWith('LOOP-UPDATE-FAIL ')).length, 1)
  for (const call of s.notices('LOOP-UPDATE-FAIL')) assert.match(call.argv[call.argv.indexOf('--body') + 1], /종료 코드 1/)
  assert.equal(s.foregrounds().length, 1)
})

test('넘기는 사이 stop 은 옛 루프와 새 루프를 모두 끝낸다', { timeout: 90_000 }, async t => {
  const s = await scene(t)
  const file = entry(s.bundles[1])
  writeFileSync(file, "await new Promise(resolve => setTimeout(resolve, 2000))\n" + readFileSync(file, 'utf8'))
  const old = await s.start()
  s.install(s.bundles[1])
  await s.wait(() => s.lock() > 0 && s.lock() !== old.pid)
  const stopped = await s.cliAsync(['--stop', '--all'])
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr)
  assert.match(stopped.stdout, /LOOP-STOPPED/)
  await s.wait(() => s.foregrounds().length === 0, '넘겨받는 루프가 남았다')
})

test('넘기는 사이 뺀 Run 은 새 루프가 다시 등록하지 않는다', { timeout: 90_000 }, async t => {
  const s = await scene(t)
  const file = entry(s.bundles[1])
  writeFileSync(file, "await new Promise(resolve => setTimeout(resolve, 2000))\n" + readFileSync(file, 'utf8'))
  const old = await s.start()
  s.install(s.bundles[1])
  await s.wait(() => s.lock() > 0 && s.lock() !== old.pid)
  const left = await s.cliAsync(['--stop', '--run', 'r1'])
  assert.equal(left.status, 0, left.stdout + left.stderr)
  assert.match(left.stdout, /LOOP-LEFT/)
  await s.wait(() => s.log().includes('LOOP-HANDOVER'))
  assert.deepEqual(s.state().runs, ['r2'])
  assert.ok(!existsSync(join(s.orch, 'state/loop-runs/r1.json')))
})

for (const mode of ['진입점이 없다', '시작 대기 한도를 넘겼다']) {
  test(`${mode}: 새 루프를 남기지 않고 옛 루프가 계속 돈다`, { timeout: 90_000 }, async t => {
    const s = await scene(t)
    if (mode === '진입점이 없다') unlinkSync(entry(s.bundles[1]))
    else {
      s.env.ORCH_LOOP_START_WAIT_SEC = '0.3'
      writeFileSync(entry(s.bundles[1]), "await new Promise(resolve => setTimeout(resolve, 10000))\n")
    }
    const old = await s.start()
    s.install(s.bundles[1])
    await s.wait(() => s.notices('LOOP-UPDATE-FAIL').length === 2)
    assert.equal(s.lock(), old.pid)
    assert.equal(s.state().pid, old.pid)
    const body = s.notices('LOOP-UPDATE-FAIL')[0].argv
    assert.match(body[body.indexOf('--body') + 1], mode === '진입점이 없다' ? /진입점이 없다/ : /0\.3초 안에 loop.json 을 쓰지 않았다/)
    assert.equal(s.foregrounds().length, 1)
  })
}
