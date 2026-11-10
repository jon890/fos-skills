import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin } from './fixtures/fake-bin.ts'

test('옛 명령과 NEXT_WAIT 직접 경로는 Orca 조회 없이 한 줄과 2 로 끝난다', t => {
  const bin = fakeBin(tempDir('retired-', t), 'orca', [{ code: 9 }])
  const dir = resolve('skills/orch/scripts')
  const cases = [
    ['skills/orch/bin/orch.ts', 'wait'], ['skills/orch/bin/orch.ts', 'wait', 'ack-lost'],
    ['skills/orch/bin/orch.ts', 'wait', 'questions'], ['skills/orch/bin/orch.ts', 'wait', 'triage'],
    ['skills/orch/bin/orch.ts', 'wait', 'user-active'], ['skills/orch/bin/orch.ts', 'worker', 'nudge'],
    ['skills/orch/bin/orch.ts', 'wait-important', '--run', 'R'],
    ['skills/orch/bin/orch.ts', 'nudge-worker', '--text', 'old'],
    ...['wait-important','watch-questions','triage-messages','user-active'].map(name => [`${dir}/wait/${name}.ts`, '--run', 'R', '--ack', 'old']),
    [`${dir}/worker/nudge-worker.ts`, '--terminal', 'T', '--text', 'old'],
  ]
  for (const args of cases) {
    const got = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { encoding: 'utf8', env: { ...process.env, ORCH_SCRIPTS_DIR: dir, ORCA: bin.path } })
    assert.equal(got.status, 2, JSON.stringify(args) + got.stderr)
    assert.equal(got.stderr.trim().split('\n').length, 1, got.stderr)
    assert.match(got.stderr, /^RETIRED .*없어졌다.*Orca.*읽을 문서/)
  }
  assert.deepEqual(bin.calls(), [])
})
