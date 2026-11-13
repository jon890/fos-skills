import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin, type FakeBin } from './fixtures/fake-bin.ts'
import { watchCompletions } from '../scripts/loop/completion-watch.ts'
import { forgetLaunch, recordLaunch } from '../scripts/lib/launched.ts'
import { recordHistory } from '../scripts/lib/launch-history.ts'
import { skipsPrReady } from '../scripts/lib/spec.ts'
import { prReadyCases } from './fixtures/pr-ready-cases.ts'
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
for (const sample of prReadyCases) for (const cleaned of [false, true]) test(`${sample.name}의 준비 보고 없는 완료${cleaned ? '는 정리 뒤 영구 이력' : '는 띄우기 기록'}으로 알림 여부를 정한다`, async () => {
  const launch = { dispatch: 'd', terminal: 'worker', worktree: repo, run: 'R', ...(skipsPrReady(sample.text) ? { completion: 'none' as const } : {}) }
  recordLaunch(repo, launch)
  recordHistory(repo, { ...launch, at: '2026-11-10T00:00:10Z', title: null, row: null, retry_of: null })
  if (cleaned) forgetLaunch(repo, 'd')
  rules([done('d')]); await watchCompletions(repo, 'R', 'main')
  assert.equal(notices().length, sample.skip ? 0 : 1)
  assert.deepEqual(state().suspects, sample.skip ? [] : ['d'])
  assert.ok(state().ids.includes('d'))
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
  writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ finish: { board: 'chosen.json' } }))
  writeFileSync(join(repo, 'chosen.json'), JSON.stringify({ items: [{ id: 'item', title: '작업', branch: 'feat/x' }] }))
  await watchCompletions(repo,'R','main')
  assert.equal(notices().length,0)
  assert.equal(JSON.parse(readFileSync(join(repo, 'chosen.json'), 'utf8')).items[0].pr, 7)
})
test('띄우기 기록이 지워져도 영구 이력의 리뷰 지시서와 첫 판정 status 로 리뷰 worker 완료를 의심하지 않는다', async () => {
  const spec = join(repo, 'spec-review.md'); writeFileSync(spec, '# 리뷰\n\n리뷰 PR: #9\n')
  recordHistory(repo, { dispatch: 'rv', terminal: 'worker', worktree: repo, run: 'R', spec, at: '2026-11-10T00:00:10Z', title: null, row: null, retry_of: null })
  const verdict = { id: 'v', type: 'status', run_id: 'R', task_id: 'task', dispatch_id: 'rv', from_handle: 'worker', subject: '리뷰 결과', body: '판정: 머지 가능, 차단 0건, 권장 3건', created_at: '2026-11-10T00:00:30Z' }
  const other = { ...verdict, id: 'v2', dispatch_id: 'unknown' }
  rules([done('rv'), done('unknown')], [verdict, other]); await watchCompletions(repo, 'R', 'main')
  assert.equal(notices().length, 0)
  assert.deepEqual(state().suspects, [])
})
test('같은 dispatch 의 의심 알림은 틱과 다시 시작을 지나도 상태 파일의 suspects 로 한 번만 보낸다', async () => {
  rules([done('d1')]); await watchCompletions(repo, 'R', 'main')
  for (let tick = 0; tick < 3; tick++) { rules([done('d1'), done(`again${tick}`, 'd1', `2026-11-10T00:0${2 + tick}:00Z`)]); await watchCompletions(repo, 'R', 'main') }
  assert.equal(notices().length, 1); assert.deepEqual(state().suspects, ['d1'])
})
test('이 저장소가 띄우지 않은 dispatch 의 PR 조회가 실패하면 건너뛰고, 띄운 dispatch 의 실패는 다시 시도한다', async () => {
  const sha = 'b'.repeat(40)
  const ready = (dispatch: string) => ({ id: `r-${dispatch}`, type: 'status', run_id: 'R', task_id: 'task', dispatch_id: dispatch, from_handle: 'worker', body: `준비됨 #414, head ${sha}`, created_at: '2026-11-10T00:00:30Z' })
  const gh = fakeBin(repo, 'gh', [{ stderr: 'Could not resolve to a PullRequest', code: 1 }]); process.env.GH = gh.path; process.env.ORCH_GH_CACHE = '0'
  rules([done('foreign')], [ready('foreign')]); await watchCompletions(repo, 'R', 'main')
  assert.ok(state().ids.includes('foreign'))
  recordLaunch(repo, { dispatch: 'mine', terminal: 'worker', worktree: repo, run: 'R' })
  rules([done('mine', 'mine', '2026-11-10T00:02:00Z')], [ready('mine')])
  await assert.rejects(watchCompletions(repo, 'R', 'main'), /Could not resolve|gh/)
  assert.ok(!state().ids.includes('mine'))
})

for (const urlOnly of [false, true]) test(`준비 보고의 PR 제목 번호를 연결하며 주소만 있는 칸은 지킨다: ${urlOnly}`, async () => {
  const sha = 'a'.repeat(40)
  rules([done('d')], [{ id: 'ready', type: 'status', run_id: 'R', task_id: 'task', dispatch_id: 'd', from_handle: 'worker', body: `준비됨 #7, head ${sha}`, created_at: '2026-11-10T00:00:30Z' }])
  const gh = fakeBin(repo, 'gh', [{ stdout: JSON.stringify({ number: 7, headRefName: 'feat/x', headRefOid: sha, title: '[P/458] 제목', url: 'url' }) }]); process.env.GH = gh.path; process.env.ORCH_GH_CACHE = '0'
  writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ finish: { board: 'chosen.json', task_pattern: String.raw`\[([^\]]+)\]` } }))
  writeFileSync(join(repo, 'chosen.json'), JSON.stringify({ items: [{ id: 'item', status: 'wait', branch: 'feat/x', ...(urlOnly ? { task: 'https://x/1' } : {}) }] }))
  await watchCompletions(repo, 'R', 'main')
  const row = JSON.parse(readFileSync(join(repo, 'chosen.json'), 'utf8')).items[0]
  assert.equal(row.pr, 7); assert.equal(row['task-ref'], urlOnly ? undefined : 'P/458')
})
