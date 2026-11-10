import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import { registerRun } from '../scripts/lib/loop.ts'
import { notifyRun } from '../scripts/lib/run-notice.ts'
import { migrateLegacyNotices } from '../scripts/cleanup/legacy-notices.ts'

const ok = JSON.stringify({ ok: true, result: { message: { id: 'm' } } })
test('Run 메시지와 환경을 유지하고 consumer_fenced 만 발신자 없이 재시도한다', t => {
  const saved = { ...process.env }
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved) })
  const dir = tempDir('run-notice-', t)
  const bin = fakeBin(dir, 'orca', [{ args: ['--from'], stdout: JSON.stringify({ ok: false, error: { code: 'consumer_fenced' } }), code: 1 }, { stdout: ok }], { recordEnv: ['ORCA_TERMINAL_HANDLE'] })
  process.env.ORCA = bin.path; process.env.ORCA_TERMINAL_HANDLE = 'term_caller'
  assert.deepEqual(notifyRun('R', 'CI-FAILED', 'test failed', 3), { ok: true, id: 'm' })
  assert.equal(bin.calls().length, 2)
  const [first, retry] = bin.calls()
  assert.ok(first.argv.includes('run:R')); assert.ok(first.argv.includes('--from'))
  assert.ok(!retry.argv.includes('--from')); assert.equal(retry.env.ORCA_TERMINAL_HANDLE, 'term_caller')
  assert.deepEqual(JSON.parse(first.argv[first.argv.indexOf('--payload') + 1]), { source: 'orch-loop', kind: 'CI-FAILED', pr: 3 })
  bin.setRules([{ code: 1, stderr: 'offline' }])
  assert.equal(notifyRun('B', 'ERROR', 'offline').ok, false)
  assert.equal(bin.calls().length, 3)
})

test('옛 알림은 전송 실패하면 보존하고 성공 뒤 cursor 와 함께 휴지통으로 옮긴다', t => {
  const dir = tempDir('legacy-notice-', t)
  const saved = { ...process.env }
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved) })
  process.env.ORCH_DIR = join(dir, 'orch')
  process.env.GIT_CEILING_DIRECTORIES = dir
  const state = join(dir, 'orch', 'state'); const events = join(state, 'loop-events')
  mkdirSync(events, { recursive: true }); mkdirSync(join(state, 'wait'))
  const file = join(events, 'R.jsonl'); const cursor = join(events, 'R.cursor')
  writeFileSync(file, [1, 2].map(seq => JSON.stringify({ seq, kind: 'OLD', text: `row ${seq}` })).join('\n'))
  writeFileSync(cursor, '1')
  const bin = fakeBin(dir, 'orca', [{ code: 1, stderr: 'offline' }]); process.env.ORCA = bin.path
  registerRun(dir, 'R', null)
  const trash = join(dir, 'trash')
  migrateLegacyNotices(dir, trash, true, () => {})
  assert.equal(existsSync(file), true); assert.equal(existsSync(cursor), true)
  assert.equal(existsSync(join(state, 'wait')), false)
  bin.setRules([{ stdout: ok }]); migrateLegacyNotices(dir, trash, true, () => {})
  assert.equal(existsSync(file), false); assert.equal(existsSync(cursor), false)
  const args = bin.calls().at(-1)!.argv; assert.equal(args[args.indexOf('--body') + 1], 'OLD row 2')
})

test('실제 Run 을 알 수 없는 옛 파일과 Run 없는 단일 파일은 보내거나 버리지 않는다', t => {
  const dir = tempDir('legacy-unknown-', t), saved = { ...process.env }
  t.after(() => { for(const k of Object.keys(process.env)) if(!(k in saved)) delete process.env[k]; Object.assign(process.env,saved) })
  process.env.ORCH_DIR = join(dir,'orch'); process.env.GIT_CEILING_DIRECTORIES=dir
  const state=join(dir,'orch','state');mkdirSync(join(state,'loop-events'),{recursive:true})
  const file=join(state,'loop-events','run_special_name.jsonl'), single=join(state,'loop-events.jsonl')
  const row=JSON.stringify({seq:1,kind:'OLD',text:'unread'})
  writeFileSync(file,row);writeFileSync(single,row)
  const bin=fakeBin(dir,'orca',[{stdout:ok}]);process.env.ORCA=bin.path
  migrateLegacyNotices(dir,join(dir,'trash'),true,()=>{})
  assert.equal(existsSync(file),true);assert.equal(existsSync(single),true);assert.equal(bin.calls().length,0)
})
