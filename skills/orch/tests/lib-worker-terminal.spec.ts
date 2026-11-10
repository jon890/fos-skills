import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { APPROVAL_STATES, LIVE_STATES, lookupWorkerTerminals } from '../scripts/lib/worker-terminal.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import { linkBin } from '../../../modules/testkit/fake-bin.ts'
const envelope = (result: unknown) => JSON.stringify({ ok: true, result })
const rows = (handles: string[], scope = 'all', next: string | null = null) => envelope({ workers: handles.map(agentTerminalHandle => ({ agentTerminalHandle, dispatchId: 'd' })), scope: { source: scope }, page: { nextCursor: next } })
test('approval 은 released 를 읽고 hook 상태 목록은 읽지 않는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-terminal-'))
  const old = process.env.ORCA
  const fake = fakeBin(dir, 'orca', [{ args: ['released'], stdout: rows(['term_w']) }, { stdout: rows([]) }])
  process.env.ORCA = fake.path
  try {
    const hook = await lookupWorkerTerminals(['term_w'], { states: LIVE_STATES })
    assert.ok(hook.ok && !hook.found.has('term_w'))
    const approval = await lookupWorkerTerminals(['term_w'], { states: APPROVAL_STATES })
    assert.ok(approval.ok && approval.found.has('term_w'))
  } finally { if (old === undefined) delete process.env.ORCA; else process.env.ORCA = old; rmSync(dir, { recursive: true, force: true }) }
})
test('bound 조회는 다른 Run 의 모든 상태와 페이지를 읽는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-terminal-'))
  const old = process.env.ORCA
  const fake = fakeBin(dir, 'orca', [
    { args: ['run-list'], stdout: envelope({ runs: [{ id: 'other' }], nextCursor: null }) },
    { args: ['--run', 'other', '--cursor', 'next'], stdout: rows(['term_w'], 'flag') },
    { args: ['--run', 'other'], stdout: rows([], 'flag', 'next') },
    { stdout: rows([], 'bound') },
  ])
  process.env.ORCA = fake.path
  try {
    const result = await lookupWorkerTerminals(['term_w'], { states: LIVE_STATES })
    assert.ok(result.ok && result.found.has('term_w'))
    assert.ok(fake.calls().some(c => c.argv.includes('other') && !c.argv.includes('--terminal-state')))
    fake.setRules([{ code: 1, stderr: 'fail' }])
    assert.equal((await lookupWorkerTerminals(['term_w'], { states: APPROVAL_STATES })).ok, false)
    const timed = await lookupWorkerTerminals(['term_w'], { states: APPROVAL_STATES, deadline: Date.now() - 1 })
    assert.ok(!timed.ok && timed.timeout)
    fake.setRules([{ stdout: envelope({ workers: {} }) }])
    assert.equal((await lookupWorkerTerminals(['term_w'], { states: APPROVAL_STATES })).ok, false)
    process.env.ORCA = linkBin(dir, 'slow-orca', 'setTimeout(() => console.log(JSON.stringify({result:{workers:[],scope:{source:"all"}}})), 300)')
    const slow = await lookupWorkerTerminals(['term_w'], { states: APPROVAL_STATES, deadline: Date.now() + 100 })
    assert.ok(!slow.ok && slow.timeout)
  } finally { if (old === undefined) delete process.env.ORCA; else process.env.ORCA = old; rmSync(dir, { recursive: true, force: true }) }
})
