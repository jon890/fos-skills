import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { join } from 'node:path'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { recordWorkerLimited, workerLimitedAt } from '../scripts/lib/worker-limited.ts'

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
