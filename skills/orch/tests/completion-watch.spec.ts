import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin, type FakeBin } from './fixtures/fake-bin.ts'
import { watchCompletions } from '../scripts/loop/completion-watch.ts'
import { recordLaunch } from '../scripts/lib/launched.ts'
let repo: string, bin: FakeBin
const saved = { ...process.env }
const envelope = (messages: unknown[]) => JSON.stringify({ ok: true, result: { messages } })
const done = (id: string, dispatch = id, at = '2026-11-10T00:01:00Z') => ({ id, type: 'worker_done', run_id: 'R', task_id: 'task', dispatch_id: dispatch, from_handle: 'worker', created_at: at })
beforeEach(t => {
  repo = tempDir('completion-watch-', t); process.env.ORCH_DIR = join(repo, '.orch'); process.env.GIT_CEILING_DIRECTORIES = repo
  bin = fakeBin(repo, 'orca', []); process.env.ORCA = bin.path
  mkdirSync(join(repo, '.orch', 'state', 'done-seen'), { recursive: true })
  writeFileSync(join(repo, '.orch', 'state', 'done-seen', 'R.json'), JSON.stringify({ ids: ['old'], last: '2026-11-10T00:00:00Z', suspects: [], events: [] }))
})
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved) })
function rules(dones: unknown[], statuses: unknown[] = [], inbox: unknown[] = [], failSend = false) {
  bin.setRules([
    { args: ['check', 'worker_done'], stdout: envelope(dones) }, { args: ['check', 'status'], stdout: envelope(statuses) },
    { args: ['inbox'], stdout: envelope(inbox) },
    { args: ['send'], stdout: failSend ? '' : JSON.stringify({ ok: true, result: { message: { id: 'notice' } } }), code: failSend ? 1 : 0 },
  ])
}
const notices = () => bin.calls().filter(c => c.argv.includes('send'))
const state = () => JSON.parse(readFileSync(join(repo,'.orch','state','done-seen','R.json'),'utf8'))
test('의심 완료는 dispatch 별 한 번 보내고 실패 전송은 다음 틱이 다시 시도한다', async () => {
  rules([done('d1')], [], [], true)
  await assert.rejects(watchCompletions(repo,'R','main'), /NOTICE-FAIL/)
  assert.deepEqual(state().ids, ['old'])
  rules([done('d1')]); await watchCompletions(repo,'R','main')
  rules([done('d1'), done('d2','d1','2026-11-10T00:02:00Z')]); await watchCompletions(repo,'R','main')
  assert.equal(notices().length, 2); assert.equal(state().ids.length, 3)
})
test('PR 없는 작업과 실패 보고는 의심 알림을 보내지 않는다', async () => {
  recordLaunch(repo, { dispatch:'none', terminal:'worker', worktree:repo, run:'R', completion:'none' })
  rules([done('none'), { ...done('failed'), outcome:'failed' }]); await watchCompletions(repo,'R','main')
  assert.equal(notices().length, 0)
})
test('최초 틱은 기존 보고를 본 것으로만 기록한다', async () => {
  process.env.ORCH_DIR = join(repo,'fresh')
  rules([done('past')]); await watchCompletions(repo,'R','main')
  assert.equal(notices().length,0)
})
test('100행에 밀린 완료를 inbox 에서 보충하고 도달 못 하면 seen 을 진행하지 않는다', async () => {
  const batch = Array.from({length:100},(_,i)=>done(`d${i}`))
  rules(batch, [], batch)
  await assert.rejects(watchCompletions(repo,'R','main'), /일부를 읽지 못했다/)
  assert.deepEqual(state().ids,['old'])
  rules(batch, [], [done('old','old','2026-11-10T00:00:00Z'), ...batch])
  await watchCompletions(repo,'R','main'); assert.equal(state().ids.length,101)
})
test('status 100행 뒤의 준비 상태는 inbox 에서 읽어 ready 이벤트와 보드 PR 연결에 쓴다', async () => {
  const sha = 'a'.repeat(40)
  const ready = { id:'ready', type:'status', run_id:'R', task_id:'task', dispatch_id:'d', from_handle:'worker', body:`준비됨 #7, head ${sha}`, created_at:'2026-11-10T00:00:30Z' }
  rules([done('d')], Array.from({length:100},(_,i)=>({id:`s${i}`,type:'status'})), [ready])
  const gh = fakeBin(repo,'gh',[{stdout:JSON.stringify({number:7,headRefName:'feat/x',headRefOid:sha,title:'제목',url:'url'})}]); process.env.GH=gh.path; process.env.ORCH_GH_CACHE='0'
  mkdirSync(join(repo,'.omc')); writeFileSync(join(repo,'.omc','board.json'),JSON.stringify({items:[{id:'item',title:'작업',branch:'feat/x'}]}))
  await watchCompletions(repo,'R','main')
  assert.equal(notices().length,0)
  assert.equal(JSON.parse(readFileSync(join(repo,'.omc','board.json'),'utf8')).items[0].pr,7)
})
