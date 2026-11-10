import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { orderedMigrations } from '../scripts/queue/steps/migrations.ts'
import { FAKE_GH, FAKE_GIT, HAS_TOOLS, spawnDone, writeNodeBin } from './fixtures/merge-queue-fakes.ts'

const runner = fileURLToPath(new URL('./fixtures/merge-queue-run.ts', import.meta.url))
const cli = fileURLToPath(new URL('../scripts/queue/merge_queue.ts', import.meta.url))
const gate = fileURLToPath(new URL('../scripts/queue/gate.ts', import.meta.url))
const wrapper = fileURLToPath(new URL('../scripts/queue/merge-with-finish.ts', import.meta.url))
const migration = (version: number, module = 'app') => ({ module, version: [version], label: `V${version}`, path: `${module}/V${version}__x.sql` })
const item = (pr: number, version: number) => ({ pr, readyAt: new Date(pr).toISOString(), migrations: [migration(version)] })

test('번호로 만든 묶음과 수동 묶음이 모순되면 거절한다', () => {
  assert.throws(() => orderedMigrations([item(1, 8), item(2, 7)], [[1, 2]]), /--chain.*모순/)
})

test('수동 묶음과 자동 묶음이 이어지면 하나로 합쳐 선행 PR 을 기다린다', () => {
  const result = orderedMigrations([item(1, 8), item(2, 7), { pr: 3, readyAt: new Date(3).toISOString(), migrations: [] }], [[3, 2]])
  assert.deepEqual(result, { order: [3, 2, 1], chains: [[3, 2, 1]] })
})

test('모듈 둘을 바꾸는 PR 과 수동 묶음이 자동 묶음들을 하나로 합친다', () => {
  const mixed = { pr: 2, readyAt: new Date(2).toISOString(), migrations: [migration(8), migration(2, 'audit')] }
  const audit = { pr: 3, readyAt: new Date(3).toISOString(), migrations: [migration(3, 'audit')] }
  assert.deepEqual(orderedMigrations([audit, mixed, item(1, 7)], []), { order: [1, 2, 3], chains: [[1, 2, 3]] })
  const separate = [item(1, 7), item(2, 8), { ...audit, migrations: [migration(2, 'audit')] }, { ...audit, pr: 4 }]
  assert.deepEqual(orderedMigrations(separate, [[2, 3]]), { order: [1, 2, 3, 4], chains: [[1, 2, 3, 4]] })
})

function setup(t: TestContext, configured = true) {
  const dir = mkdtempSync(join(tmpdir(), 'queue-migrations-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeNodeBin(bin, 'gh', FAKE_GH)
  writeNodeBin(bin, 'git', FAKE_GIT)
  mkdirSync(join(dir, '.orch'))
  if (configured) writeFileSync(join(dir, '.orch', 'config.json'), JSON.stringify({ migrations: { dirs: { app: 'app' } } }))
  const stateFile = join(dir, 'state.json')
  const log = join(dir, 'calls.txt')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: stateFile, FAKE_LOG: log, FAKE_REMOTE_HEAD: 'abc', MERGE_QUEUE_FAKE_GIT: '1', MERGE_QUEUE_SLEEP_SCALE: '0', ORCH_GH_CACHE: '0' }
  delete env.ORCH_DIR
  delete env.GH
  const pr = (version: number) => ({ state: 'OPEN', headRefOid: 'abc', headRefName: 'feat', baseRefName: 'main', url: 'https://git.example.com/owner/repo/pull/1', isCrossRepository: false, statusCheckRollup: [], mergeable: 'MERGEABLE', files: [{ path: `app/V${version}__x.sql`, changeType: 'ADDED' }] })
  const write = (state: object) => writeFileSync(stateFile, JSON.stringify(state))
  const args = ['--repo', dir, '--threads-cmd', 'echo 0', '--no-sweep', '--keep-branch']
  return { dir, env, pr, write, args, log: () => existsSync(log) ? readFileSync(log, 'utf8') : '', run: (...items: string[]) => spawnDone([process.execPath, runner, ...args, ...items], { env }) }
}

test('뒤바뀐 두 PR 은 번호가 낮은 것부터 실제 머지한다', { skip: !HAS_TOOLS }, async (t) => {
  const c = setup(t)
  c.write({ 1: c.pr(8), 2: c.pr(7) })
  const result = await c.run('1:echo high', '2:echo low')
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /QUEUE-ORDER 2 1/)
  assert.deepEqual(c.log().match(/^pr merge \d+/gm), ['pr merge 2', 'pr merge 1'])
  assert.match(result.stdout, /머지 전 명령: echo low/)
})

test('낮은 번호 PR 이 보류되면 높은 번호 PR 도 머지하지 않는다', { skip: !HAS_TOOLS }, async (t) => {
  const c = setup(t)
  c.write({ 1: c.pr(8), 2: { ...c.pr(7), mergeable: 'CONFLICTING' } })
  const result = await c.run('1', '2')
  assert.equal(result.code, 1)
  assert.match(result.stdout, /SKIP 1 묶음의 앞 PR 2/)
  assert.doesNotMatch(c.log(), /^pr merge /m)
})

test('수동 순서와 번호 순서가 모순되면 머지 전에 거절하고 잠금을 푼다', { skip: !HAS_TOOLS }, async (t) => {
  const c = setup(t)
  c.write({ 1: c.pr(8), 2: c.pr(7) })
  const result = await c.run('--chain', '1,2', '1', '2')
  assert.equal(result.code, 2, result.stdout + result.stderr)
  assert.match(result.stderr, /--chain.*모순/)
  assert.doesNotMatch(c.log(), /^pr merge /m)
  assert.equal(existsSync(join(c.dir, '.orch', 'state', 'merge-queue.lock')), false)
})

test('죽은 큐가 남긴 잠금은 다음 큐가 회수하고 머지한다', { skip: !HAS_TOOLS }, async (t) => {
  const c = setup(t, false)
  c.write({ 1: c.pr(7) })
  const ended = spawnSync(process.execPath, ['-e', ''])
  assert.equal(ended.status, 0)
  const state = join(c.dir, '.orch', 'state')
  mkdirSync(state)
  writeFileSync(join(state, 'merge-queue.lock'), JSON.stringify({ pid: ended.pid, identity: '끝난 큐' }))
  const result = await c.run('1')
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(c.log(), /^pr merge 1/m)
})

test('프로세스 목록 조회 실패는 중복 큐와 구분하고 잠금을 남기지 않는다', { skip: !HAS_TOOLS }, async (t) => {
  const c = setup(t, false)
  c.write({ 1: c.pr(7) })
  c.env.PS = writeNodeBin(join(c.dir, 'bin'), 'ps', `const args=process.argv.slice(2); if(args.includes('-Ao')) process.exit(1); const r=require('node:child_process').spawnSync('ps',args,{env:{...process.env,PATH:${JSON.stringify(process.env.PATH)}},encoding:'utf8'}); process.stdout.write(r.stdout||''); process.exit(r.status??1)`)
  const result = await c.run('1')
  assert.equal(result.code, 2, result.stdout + result.stderr)
  assert.match(result.stderr, /QUEUE-CHECK-FAILED.*프로세스 목록/)
  assert.doesNotMatch(result.stderr, /QUEUE-BUSY/)
  assert.equal(existsSync(join(c.dir, '.orch', 'state', 'merge-queue.lock')), false)
  assert.doesNotMatch(c.log(), /^pr merge /m)
})

test('base 최고 이하인 번호는 머지하지 않고 gate 에도 새 번호 안내를 낸다', { skip: !HAS_TOOLS }, async (t) => {
  const c = setup(t)
  for (const version of [7, 8]) {
    c.write({ 1: c.pr(7), _tree_paths: [`app/V${version}__base.sql`] })
    const result = await c.run('1')
    assert.equal(result.code, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /base 최고 V[78] 이하.*orch queue reserve .*--again/)
    assert.match(result.stdout, /worker 에게 알리지 않는다\(Run 모름\)/)
    assert.doesNotMatch(c.log(), /^pr merge /m)
  }
  const result = await spawnDone([process.execPath, gate, ...c.args.filter((arg) => !['--no-sweep', '--keep-branch'].includes(arg)), '1'], { env: c.env })
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /--again/)
})

test('base 파일을 읽지 못하면 번호 검사를 건너뛰지 않고 보류한다', { skip: !HAS_TOOLS }, async (t) => {
  const c = setup(t)
  c.write({ 1: c.pr(7), _tree_fails: true })
  const result = await c.run('1')
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /base 마이그레이션 파일 조회 실패/)
  assert.doesNotMatch(c.log(), /^pr merge /m)
})

test('머지 전 명령이 실행되는 동안 base 가 바뀌어도 다시 번호를 확인한다', { skip: !HAS_TOOLS }, async (t) => {
  const c = setup(t)
  c.write({ 1: c.pr(7) })
  const update = join(c.dir, 'move-base.ts')
  writeFileSync(update, "import fs from 'node:fs'; const f=process.env.FAKE_STATE!; const s=JSON.parse(fs.readFileSync(f,'utf8')); s._tree_paths=['app/V8__base.sql']; fs.writeFileSync(f,JSON.stringify(s))")
  const result = await c.run(`1:${process.execPath} '${update}'`)
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /--again/)
  assert.doesNotMatch(c.log(), /^pr merge /m)
})

test('migrations 설정이 없으면 입력 순서를 유지하고 파일 조회도 더하지 않는다', { skip: !HAS_TOOLS }, async (t) => {
  const c = setup(t, false)
  c.write({ 1: c.pr(8), 2: c.pr(7) })
  const result = await c.run('1', '2')
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.deepEqual(c.log().match(/^pr merge \d+/gm), ['pr merge 1', 'pr merge 2'])
  assert.doesNotMatch(c.log(), /--json files|ls-tree/)
})

for (const entry of [[cli], [wrapper, '--no-finish']]) test(`${entry.length === 1 ? '직접 건 큐' : '루프가 쓰는 래퍼'}와 두 번째 큐는 겹쳐 돌지 않는다`, { skip: !HAS_TOOLS }, async (t) => {
  const c = setup(t, false)
  c.write({ 1: c.pr(7) })
  const hooks = join(c.dir, '.orch', 'hooks')
  mkdirSync(hooks)
  const started = join(c.dir, 'started')
  writeFileSync(join(hooks, 'before-merge.ts'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(started)},''); setInterval(()=>{},1000)`)
  const first = spawn(process.execPath, [...entry, ...c.args, '1'], { env: c.env, stdio: 'ignore' })
  const ended = new Promise((resolve) => first.on('exit', resolve))
  t.after(() => first.kill('SIGKILL'))
  const deadline = Date.now() + 15_000
  while (!existsSync(started) && Date.now() < deadline) await sleep(50)
  assert.ok(existsSync(started), '첫 큐의 머지 전 핸들러가 시작돼야 한다')
  const second = await c.run('1')
  assert.equal(second.code, 2, second.stdout + second.stderr)
  assert.match(second.stderr, /QUEUE-BUSY/)
  assert.doesNotMatch(c.log(), /^pr merge /m)
  const queuePid = JSON.parse(readFileSync(join(c.dir, '.orch', 'state', 'merge-queue.lock'), 'utf8')).pid
  process.kill(queuePid, 'SIGTERM')
  await ended
  assert.ok(!existsSync(join(c.dir, '.orch', 'state', 'merge-queue.lock')))
  rmSync(hooks, { recursive: true })
  assert.equal((await c.run('1')).code, 0)
})
