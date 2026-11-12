import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { LIMIT_CHECK_MS, notifyLimitChecks, recordWorkerLimited, workerLimitedAt } from '../scripts/lib/worker-limited.ts'

test('머신 한도 시각은 더 늦은 값만 저장하고 여러 프로세스가 함께 써도 되돌아가지 않는다', async t => {
  const saved = process.env.ORCH_MACHINE_DIR
  process.env.ORCH_MACHINE_DIR = join(tempDir('worker-limited-', t), 'machine')
  t.after(() => { if (saved === undefined) delete process.env.ORCH_MACHINE_DIR; else process.env.ORCH_MACHINE_DIR = saved })
  assert.equal(workerLimitedAt(), null)
  recordWorkerLimited(100)
  recordWorkerLimited(90)
  assert.equal(workerLimitedAt(), 100)
  const module = new URL('../scripts/lib/worker-limited.ts', import.meta.url).href
  await Promise.all([200, 500, 300, 400].map(at => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {recordWorkerLimited} from ${JSON.stringify(module)}; for(let i=0;i<10;i++) recordWorkerLimited(${at}+i);`], { env: process.env, stdio: 'pipe' })
    let stderr = ''
    child.stderr.on('data', value => { stderr += value })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)))
  })))
  assert.equal(workerLimitedAt(), 509)
})

test('한 시간 전에는 알리지 않고 성공한 주기는 재시작 뒤에도 중복 없이 알린다', async t => {
  const saved = process.env.ORCH_MACHINE_DIR
  process.env.ORCH_MACHINE_DIR = join(tempDir('limit-check-', t), 'machine')
  t.after(() => { if (saved === undefined) delete process.env.ORCH_MACHINE_DIR; else process.env.ORCH_MACHINE_DIR = saved })
  recordWorkerLimited(100, { run: 'A', provider: 'claude' })
  recordWorkerLimited(101, { run: 'B', provider: 'codex' })
  const sent: string[] = []
  const notify = (check: { provider: string }) => { sent.push(check.provider) }
  notifyLimitChecks(['A'], 100 + LIMIT_CHECK_MS - 1, notify)
  assert.deepEqual(sent, [])
  notifyLimitChecks(['A'], 100 + LIMIT_CHECK_MS, notify)
  assert.deepEqual(sent, ['claude'])
  const module = new URL('../scripts/lib/worker-limited.ts', import.meta.url).href
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {notifyLimitChecks} from ${JSON.stringify(module)}; notifyLimitChecks(['A'], ${100 + LIMIT_CHECK_MS}, () => process.exit(9));`], { env: process.env, stdio: 'pipe' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('재시작 뒤 같은 주기 알림을 보냈다')))
  })
  notifyLimitChecks(['A'], 100 + 2 * LIMIT_CHECK_MS, notify)
  assert.deepEqual(sent, ['claude', 'claude'])
  assert.throws(() => notifyLimitChecks(['B'], 101 + LIMIT_CHECK_MS, () => { throw new Error('전송 실패') }), /전송 실패/)
  notifyLimitChecks(['B'], 101 + LIMIT_CHECK_MS, notify)
  assert.deepEqual(sent, ['claude', 'claude', 'codex'])
  recordWorkerLimited(200 + 2 * LIMIT_CHECK_MS, { run: 'A', provider: 'claude' })
  notifyLimitChecks(['A'], 200 + 3 * LIMIT_CHECK_MS - 1, notify)
  assert.equal(sent.length, 3)
  notifyLimitChecks(['A'], 200 + 3 * LIMIT_CHECK_MS, notify)
  assert.equal(sent.length, 4)
})

test('서로 다른 루프 프로세스도 같은 Run·제공자의 확인 알림을 한 번만 보낸다', async t => {
  const saved = process.env.ORCH_MACHINE_DIR
  const root = tempDir('limit-check-peer-', t)
  process.env.ORCH_MACHINE_DIR = join(root, 'machine')
  t.after(() => { if (saved === undefined) delete process.env.ORCH_MACHINE_DIR; else process.env.ORCH_MACHINE_DIR = saved })
  recordWorkerLimited(100, { run: 'A', provider: 'claude' })
  recordWorkerLimited(100, { run: 'A', provider: 'codex' })
  const module = new URL('../scripts/lib/worker-limited.ts', import.meta.url).href
  const output = join(root, 'sent')
  const code = `import {notifyLimitChecks} from ${JSON.stringify(module)}; import {appendFileSync} from 'node:fs'; notifyLimitChecks(['A'], ${100 + LIMIT_CHECK_MS}, check => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); appendFileSync(${JSON.stringify(output)}, check.provider + '\\n'); });`
  await Promise.all([1, 2].map(() => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, stdio: 'pipe' })
    let stderr = ''
    child.stderr.on('data', value => { stderr += value })
    child.once('error', reject)
    child.once('exit', value => value === 0 ? resolve() : reject(new Error(stderr)))
  })))
  assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n').sort(), ['claude', 'codex'])
})
