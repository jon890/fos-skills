import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test, beforeEach, afterEach } from 'node:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
test('지시서가 PR 없는 일로 정한 완료 보고는 첫 줄이 완료일 때 DONE-SUSPECT 에서 뺀다', async () => {
  const instructions = [
    '허락: PR 은 열지 않는다.\n## 완료 기준\n- 설계 결과를 전달한다.',
    '허락: 내보내기 결과를 다른 저장소에 만들고 이 저장소에서는 PR 은 열지 않는다.\n## 완료 기준\n- 결과를 확인한다.',
  ]
  const reports = instructions.map((text, i) => {
    const dispatch = `no-pr-${i}`
    const spec = join(repo, `${dispatch}.md`)
    writeFileSync(spec, text)
    const launch = { dispatch, terminal: 'worker', worktree: repo, run: 'R', spec }
    recordLaunch(repo, launch)
    recordHistory(repo, { ...launch, at: `2026-11-10T00:00:1${i}Z`, title: null, row: null, retry_of: null })
    return { ...done(dispatch, dispatch), subject: '완료: 결과를 전달했다' }
  })
  rules(reports); await watchCompletions(repo, 'R', 'main')
  assert.equal(notices().length, 0)
  assert.deepEqual(state().suspects, [])
})
test('다른 저장소에 띄운 dispatch 는 완료 기준에 PR 이 없어도 첫 줄 완료 보고를 인정한다', async () => {
  const otherRepo = join(repo, 'other-repo')
  mkdirSync(otherRepo)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['init', '-q', otherRepo])
  const spec = join(repo, 'export.md')
  writeFileSync(spec, '## 완료 기준\n- 내보낸 결과를 확인한다.')
  const launch = { dispatch: 'export', terminal: 'worker', worktree: otherRepo, run: 'R', spec }
  recordLaunch(repo, launch)
  recordHistory(repo, { ...launch, at: '2026-11-10T00:00:10Z', title: null, row: null, retry_of: null })
  rules([{ ...done('export'), subject: '완료: 결과를 내보냈다' }]); await watchCompletions(repo, 'R', 'main')
  assert.equal(notices().length, 0)
  assert.deepEqual(state().suspects, [])
})
test('지시서를 읽지 못한 완료는 의심으로 남기고 원인을 알린다', async () => {
  const launch = { dispatch: 'missing-spec', terminal: 'worker', worktree: repo, run: 'R', spec: join(repo, 'missing.md') }
  recordLaunch(repo, launch)
  recordHistory(repo, { ...launch, at: '2026-11-10T00:00:10Z', title: null, row: null, retry_of: null })
  rules([done('missing-spec')]); await watchCompletions(repo, 'R', 'main')
  assert.equal(notices().length, 1)
  assert.match(notices()[0].argv.join(' '), /지시서를 읽지 못했다/)
  assert.deepEqual(state().suspects, ['missing-spec'])
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

// 머지 전 완료 보고: PR 이 열린 채 온 worker_done 은 알리기 전에 같은 워크트리의 worker 에게 되돌린다
function bounceSetup(options: { sendCode?: number; open?: boolean; dispatch?: string } = {}) {
  const dispatch = options.dispatch ?? 'd1'
  const spec = join(repo, 'spec-x.md'); writeFileSync(spec, '# 작업\n\n브랜치: `feat/x`\n허락: PR 생성까지 허락했다.\n')
  const launch = { dispatch, terminal: 'worker', worktree: repo, run: 'R', spec, branch: 'feat/x', task: 'task' }
  recordLaunch(repo, launch)
  recordHistory(repo, { ...launch, at: '2026-11-10T00:00:10Z', title: null, row: null, retry_of: null })
  const gh = fakeBin(repo, 'gh', [{ args: ['list'], stdout: JSON.stringify(options.open === false ? [] : [{ number: 7, title: '제목', url: 'https://x/7', headRefName: 'feat/x' }]) }])
  process.env.GH = gh.path
  const send = join(repo, 'send.ts')
  writeFileSync(send, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(join(repo, 'send.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n')\nconsole.log('FOLLOW-UP d1 d2 task2')\nprocess.exitCode = ${options.sendCode ?? 0}\n`)
  process.env.SEND_TO_WORKER = send
  return () => existsSync(join(repo, 'send.log')) ? readFileSync(join(repo, 'send.log'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]) : []
}
function bounceRules(dones: unknown[], statuses: unknown[] = [], status = 'completed') {
  bin.setRules([
    { args: ['check', 'worker_done'], stdout: envelope(dones) }, { args: ['check', 'status'], stdout: envelope(statuses) },
    { args: ['inbox'], stdout: envelope([]) },
    { args: ['worker-show'], stdout: JSON.stringify({ ok: true, result: { dispatch: { id: 'd1', status } } }) },
    { args: ['send'], stdout: JSON.stringify({ ok: true, result: { message: { id: 'notice' } } }) },
  ])
}
const kinds = () => notices().map(c => c.argv[c.argv.indexOf('--subject') + 1].split(' ')[0])

test('PR 이 열린 채 온 근거 없는 완료는 worker 에게 되돌리고 DONE-SUSPECT 대신 DONE-RETURNED 를 알린다', async () => {
  const sent = bounceSetup()
  bounceRules([done('d1')]); await watchCompletions(repo, 'R', 'main')
  assert.deepEqual(kinds(), ['DONE-RETURNED'])
  const [args] = sent()
  assert.deepEqual(args.slice(0, 4), ['--dispatch', 'd1', '--spec', join(repo, 'spec-x.md')])
  assert.match(args[args.indexOf('--note') + 1], /PR #7 이 아직 열려 있다.*머지될 때까지 이 worker 가 맡는다/)
  assert.deepEqual(args.slice(-2), ['--run', 'R'])
  assert.deepEqual(state().returned, ['d1', 'pr:7']); assert.deepEqual(state().suspects, [])
  assert.match(notices()[0].argv.join(' '), /새 dispatch d2/)
})
test('같은 PR 은 한 번만 되돌리고 이어 맡은 worker 가 또 일찍 끝내면 DONE-SUSPECT 로 알린다', async () => {
  const sent = bounceSetup()
  bounceRules([done('d1')]); await watchCompletions(repo, 'R', 'main')
  bounceSetup({ dispatch: 'd2' })
  bounceRules([done('d1'), { ...done('m2', 'd2', '2026-11-10T00:03:00Z') }]); await watchCompletions(repo, 'R', 'main')
  assert.deepEqual(kinds(), ['DONE-RETURNED', 'DONE-SUSPECT'])
  assert.match(notices()[1].argv.join(' '), /이미 한 번 되돌렸다/)
  assert.equal(sent().length, 1, '두 번째 완료는 보내지 않는다')
})
test('열린 PR 이 없으면 되돌리지 않고 DONE-SUSPECT 만 알린다', async () => {
  const sent = bounceSetup({ open: false })
  bounceRules([done('d1')]); await watchCompletions(repo, 'R', 'main')
  assert.deepEqual(kinds(), ['DONE-SUSPECT']); assert.deepEqual(sent(), [])
})
test('아직 살아 있는 dispatch 는 되돌리지 않는다', async () => {
  const sent = bounceSetup()
  bounceRules([done('d1')], [], 'running'); await watchCompletions(repo, 'R', 'main')
  assert.deepEqual(kinds(), ['DONE-SUSPECT']); assert.deepEqual(sent(), [])
})
test('보내기가 실패하면 이유와 orch worker continue 명령을 DONE-SUSPECT 에 적는다', async () => {
  bounceSetup({ sendCode: 1 })
  bounceRules([done('d1')]); await watchCompletions(repo, 'R', 'main')
  assert.deepEqual(kinds(), ['DONE-SUSPECT'])
  assert.match(notices()[0].argv.join(' '), /이어 맡기지 못했다.*orch worker continue --dispatch d1/)
  assert.equal(state().returned, undefined); assert.deepEqual(state().suspects, ['d1'])
})
test('준비됨 뒤에도 PR 이 열려 있으면 되돌리고 머지된 PR 이면 그대로 둔다', async () => {
  const sha = 'c'.repeat(40)
  const ready = { id: 'r1', type: 'status', run_id: 'R', task_id: 'task', dispatch_id: 'd1', from_handle: 'worker', body: `준비됨 #7, head ${sha}`, created_at: '2026-11-10T00:00:30Z' }
  const sent = bounceSetup()
  for (const state of ['MERGED', 'OPEN']) {
    const view = fakeBin(repo, 'gh', [{ args: ['view'], stdout: JSON.stringify({ number: 7, headRefName: 'feat/x', headRefOid: sha, title: '제목', url: 'u', state }) },
      { args: ['list'], stdout: JSON.stringify([{ number: 7, title: '제목', url: 'u', headRefName: 'feat/x' }]) }])
    process.env.GH = view.path
    bounceRules([done(`done-${state}`, 'd1', state === 'MERGED' ? '2026-11-10T00:01:00Z' : '2026-11-10T00:02:00Z')], [ready]); await watchCompletions(repo, 'R', 'main')
    if (state === 'MERGED') assert.deepEqual(sent(), [])
  }
  assert.equal(sent().length, 1); assert.deepEqual(kinds(), ['DONE-RETURNED'])
})
test('한 번 되돌린 PR 의 후속 worker 가 준비됨 뒤 또 일찍 끝내면 DONE-SUSPECT 로 알린다', async () => {
  const sha = 'd'.repeat(40)
  const ready = (dispatch: string) => ({ id: `r-${dispatch}`, type: 'status', run_id: 'R', task_id: 'task', dispatch_id: dispatch, from_handle: 'worker', body: `준비됨 #7, head ${sha}`, created_at: '2026-11-10T00:00:30Z' })
  const sent = bounceSetup()
  const gh = fakeBin(repo, 'gh', [])
  const openRules = [{ args: ['view'], stdout: JSON.stringify({ number: 7, headRefName: 'feat/x', headRefOid: sha, title: '제목', url: 'u', state: 'OPEN' }) },
    { args: ['list'], stdout: JSON.stringify([{ number: 7, title: '제목', url: 'u', headRefName: 'feat/x' }]) }]
  gh.setRules(openRules); process.env.GH = gh.path
  bounceRules([done('d1')], [ready('d1')]); await watchCompletions(repo, 'R', 'main')
  bounceSetup({ dispatch: 'd2' }); gh.setRules(openRules); process.env.GH = gh.path
  bounceRules([done('d1'), done('d2', 'd2', '2026-11-10T00:03:00Z')], [ready('d1'), { ...ready('d2'), created_at: '2026-11-10T00:02:30Z' }]); await watchCompletions(repo, 'R', 'main')
  assert.deepEqual(kinds(), ['DONE-RETURNED', 'DONE-SUSPECT'])
  assert.match(notices()[1].argv.join(' '), /PR 이 열린 채 완료 보고가 왔다.*이미 한 번 되돌렸다/)
  assert.equal(sent().length, 1)
})
test('DONE-RETURNED 전송이 실패하면 다시 되돌리지 않고 알림만 다음 틱에 다시 보낸다', async () => {
  const sent = bounceSetup()
  bounceRules([done('d1')])
  bin.setRules([
    { args: ['check', 'worker_done'], stdout: envelope([done('d1')]) }, { args: ['check', 'status'], stdout: envelope([]) }, { args: ['inbox'], stdout: envelope([]) },
    { args: ['worker-show'], stdout: JSON.stringify({ ok: true, result: { dispatch: { id: 'd1', status: 'completed' } } }) },
    { args: ['send'], stdout: '', code: 1 },
  ])
  await assert.rejects(watchCompletions(repo, 'R', 'main'), /NOTICE-FAIL DONE-RETURNED/)
  assert.equal(sent().length, 1); assert.ok(!state().ids.includes('d1'))
  bounceRules([done('d1')]); await watchCompletions(repo, 'R', 'main')
  assert.equal(sent().length, 1, '두 번째 틱은 되돌리지 않는다')
  assert.ok(state().ids.includes('d1')); assert.deepEqual(state().returnNotes, {})
  assert.equal(kinds().filter(k => k === 'DONE-RETURNED').length, 2, '실패한 시도 하나와 성공 하나')
  assert.ok(!kinds().includes('DONE-SUSPECT'))
})

// 2026-11-19 오탐: 준비됨을 보내고 머지된 worker 에게 DONE-SUSPECT 가 두 번 갔다.
// 한 번은 띄우지 않은 저장소의 루프가, 한 번은 지시서를 지운 뒤 띄운 저장소의 루프가 보냈다
test('dispatch 없이 터미널에서 보낸 준비됨도 같은 Task 와 발신자면 근거로 보고 머지된 PR 은 알리지 않는다', async () => {
  const sha = 'e'.repeat(40)
  const ready = { id: 'r346', type: 'status', run_id: 'R', from_handle: 'worker', payload: { taskId: 'task' }, body: `준비됨 #346, head ${sha}`, created_at: '2026-11-10T00:00:30Z' }
  const gh = fakeBin(repo, 'gh', [{ args: ['view'], stdout: JSON.stringify({ number: 346, headRefName: 'fix/x', headRefOid: sha, title: '제목', url: 'u', state: 'MERGED' }) }])
  process.env.GH = gh.path
  recordLaunch(repo, { dispatch: 'd346', terminal: 'worker', worktree: repo, run: 'R', branch: 'fix/x' })
  rules([done('d346')], [ready]); await watchCompletions(repo, 'R', 'main')
  assert.equal(notices().length, 0)
  assert.deepEqual(state().suspects, [])
})
test('지시서를 지운 뒤 온 근거 없는 완료도 띄우기 기록의 브랜치 PR 이 MERGED 면 알리지 않는다', async () => {
  const launch = { dispatch: 'merged', terminal: 'worker', worktree: join(repo, 'gone'), run: 'R', spec: join(repo, 'removed.md'), branch: 'fix/merged' }
  recordLaunch(repo, launch)
  recordHistory(repo, { ...launch, at: '2026-11-10T00:00:10Z', title: null, row: null, retry_of: null })
  forgetLaunch(repo, 'merged')
  const gh = fakeBin(repo, 'gh', [{ args: ['list'], stdout: JSON.stringify([{ number: 785, state: 'MERGED' }]) }])
  process.env.GH = gh.path
  rules([done('merged')]); await watchCompletions(repo, 'R', 'main')
  assert.equal(notices().length, 0)
  assert.deepEqual(state().suspects, [])
  assert.ok(state().ids.includes('merged'))
})
test('같은 브랜치에 열린 PR 이 남았거나 PR 조회가 실패하면 머지된 PR 이 있어도 알린다', async () => {
  for (const [i, rule] of [{ stdout: JSON.stringify([{ number: 2, state: 'OPEN' }, { number: 1, state: 'MERGED' }]) }, { stderr: 'boom', code: 1 }].entries()) {
    const dispatch = `still-${i}`
    recordHistory(repo, { dispatch, terminal: 'worker', worktree: join(repo, 'gone'), run: 'R', spec: join(repo, 'removed.md'), branch: `fix/${dispatch}`, at: '2026-11-10T00:00:10Z', title: null, row: null, retry_of: null })
    const gh = fakeBin(repo, 'gh', [{ args: ['list'], ...rule }])
    process.env.GH = gh.path
    rules([done(dispatch, dispatch, `2026-11-10T00:0${i + 1}:00Z`)]); await watchCompletions(repo, 'R', 'main')
  }
  assert.equal(notices().length, 2)
  assert.deepEqual(state().suspects, ['still-0', 'still-1'])
})
test('띄우기 기록이 없고 Orca 의 worker 워크트리가 다른 저장소면 그 저장소의 루프에 맡기고 알리지 않는다', async t => {
  const other = tempDir('completion-watch-other-', t)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['init', '-q', other])
  bin.setRules([
    { args: ['check', 'worker_done'], stdout: envelope([done('foreign-done', 'foreign')]) }, { args: ['check', 'status'], stdout: envelope([]) },
    { args: ['inbox'], stdout: envelope([]) },
    { args: ['worker-show'], stdout: JSON.stringify({ ok: true, result: { dispatch: { id: 'foreign', status: 'completed' }, worker: { worktreeId: `repo::${other}` } } }) },
    { args: ['send'], stdout: JSON.stringify({ ok: true, result: { message: { id: 'notice' } } }) },
  ])
  await watchCompletions(repo, 'R', 'main')
  assert.equal(notices().length, 0)
  assert.deepEqual(state().suspects, [])
  assert.ok(state().ids.includes('foreign-done'))
})
test('띄우기 기록이 없어도 Orca 가 이 저장소의 워크트리라고 하거나 조회가 실패하면 그대로 알린다', async () => {
  execFileSync('git', ['init', '-q', repo])
  bin.setRules([
    { args: ['check', 'worker_done'], stdout: envelope([done('here')]) }, { args: ['check', 'status'], stdout: envelope([]) },
    { args: ['inbox'], stdout: envelope([]) },
    { args: ['worker-show'], stdout: JSON.stringify({ ok: true, result: { dispatch: { id: 'here', status: 'completed' }, worker: { worktreeId: `repo::${join(repo, 'worktrees', 'gone')}` } } }) },
    { args: ['send'], stdout: JSON.stringify({ ok: true, result: { message: { id: 'notice' } } }) },
  ])
  await watchCompletions(repo, 'R', 'main')
  assert.deepEqual(state().suspects, ['here'])
})
