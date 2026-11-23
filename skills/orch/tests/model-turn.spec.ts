import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { tempDir } from '../../../modules/testkit/temp.ts'

const run = promisify(execFile)
const moduleUrl = new URL('../scripts/lib/model-turn.ts', import.meta.url).href

test('REQ2: 다른 저장소의 동시 실행도 같은 등급의 차례를 한 번씩 받는다', async t => {
  const root = tempDir('model-turn-', t)
  const repos = ['alpha', 'beta'].map(name => join(root, name))
  for (const repo of repos) mkdirSync(repo)
  const env = { ...process.env, ORCH_MACHINE_DIR: join(root, 'machine') }
  async function take(repo: string, grade: string) {
    const source = `import { takeModelTurn } from ${JSON.stringify(moduleUrl)}; console.log(takeModelTurn(${JSON.stringify(grade)}).agent)`
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', source], { cwd: repo, env })
    return stdout.trim()
  }
  const first = await Promise.all(repos.map(repo => take(repo, 'opus')))
  assert.deepEqual(first.sort(), ['claude', 'codex'])
  assert.equal(await take(repos[0], 'opus'), 'codex')
  assert.equal(await take(repos[1], 'fable'), 'codex')
  assert.equal(await take(repos[1], 'opus'), 'claude')
})
