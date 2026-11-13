import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, afterEach, test } from 'node:test'
import { registerBoard } from '../scripts/lib/board.ts'
import { writeNodeBin } from './fixtures/merge-queue-fakes.ts'
import { recordHistory } from '../scripts/lib/launch-history.ts'
import { fakeBin } from './fixtures/fake-bin.ts'

let repo: string, file: string, spec: string, saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = { ...process.env }
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'board-attach-')))
  mkdirSync(join(repo, '.omc'))
  mkdirSync(join(repo, '.orch'))
  process.env.ORCH_DIR = join(repo, '.orch')
  process.env.GIT_CEILING_DIRECTORIES = repo
  delete process.env.BOARD_BIN
  file = join(repo, '.omc/board.json')
  spec = join(repo, 'spec.md')
  writeNodeBin(repo, 'gh', 'process.stdout.write(JSON.stringify({headRefName:"feat/a"}))')
  process.env.GH = join(repo, 'gh')
})
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(repo, { recursive: true, force: true })
})
const row = (role = 'impl', worktree = 'old') => ({ role, worktree, branch: 'feat/a', dispatch: 'd0', pr: null, status: 'working', at: '2026-01-01', endedAt: null })
const orcaShape = { taskId: 'task', agentTerminalHandle: 'term', resource: { worktreeId: 'repo::old', ownershipState: 'agent_owned' } }
const base = (extra = {}) => ({ id: 'a', status: 'doing', pr: 7, worktree: 'old', branch: 'feat/a', details: [{ text: '1. 구현', done: false }], workers: [row()], ...extra })
function board(...items: object[]) { writeFileSync(file, JSON.stringify({ items })) }
function items(): any[] { return JSON.parse(readFileSync(file, 'utf8')).items }
function launch(text: string, wt = 'new', branch = 'feat/new', dispatch = 'd1') {
  writeFileSync(spec, '# 테스트\n' + text)
  return registerBoard(repo, spec, join(repo, wt), wt, branch, dispatch)
}

test('리뷰는 열린 항목과 완료 항목의 상태·단계·대표를 보존한다', () => {
  for (const status of ['doing', 'done']) {
    const original = base({ status, ...(status === 'done' ? { pr: null, 'merged-pr': 7 } : {}) })
    board(original)
    assert.deepEqual(launch('리뷰 PR: #7'), { item: 'a', role: 'review', attached: true })
    assert.equal(items().length, 1)
    assert.deepEqual({ ...items()[0], workers: original.workers }, original)
    assert.equal(items()[0].workers[1].pr, 7)
    assert.equal(items()[0].workers[1].role, 'review')
  }
  board(base())
  assert.equal(launch('보드 항목 id: a\n리뷰 PR: #7')?.role, 'review')
})

test('PR 필드 우선, 최근 항목 우선, head 브랜치 대체 찾기', () => {
  board(base({ id: 'merged', pr: null, 'merged-pr': 7 }), base({ id: 'older', stepAt: '2026-01-01' }), base({ stepAt: '2026-02-01' }))
  assert.equal(launch('리뷰 PR: #7')?.item, 'a')
  board(base({ pr: null }))
  assert.equal(launch('리뷰 PR: #7')?.item, 'a')
  writeNodeBin(repo, 'gh-fail', 'process.exit(1)')
  process.env.GH = join(repo, 'gh-fail')
  board(base({ pr: null }))
  assert.equal(launch('리뷰 PR: #99')?.attached, false)
  assert.equal(items().length, 2)
  assert.equal(items()[1].workers[0].role, 'review')
  assert.equal(items()[1].worktree, 'new')
})

test('검증, 업무 후속, 같은 워크트리 재시도와 새 항목 요청', () => {
  board(base())
  assert.equal(launch('worker 역할: 검증', 'verify', 'feat/a')?.role, 'verify')
  board(base({ 'task-ref': 'P/123' }))
  assert.deepEqual(launch('두레이 업무: P/123 「테스트」'), { item: 'a', role: 'follow', attached: true })
  assert.equal(items()[0].workers[0].dispatch, 'd0')
  assert.equal(items()[0].worktree, 'new')
  assert.equal(launch('', 'old', 'feat/a', 'd9')?.attached, false)
  assert.equal(items()[0].workers.length, 2)
  assert.equal(items()[0].workers[0].dispatch, 'd9')
  board(base({ 'task-ref': 'P/123' }))
  assert.equal(launch('보드 항목: 새로\n두레이 업무: P/123 「테스트」')?.attached, false)
  assert.equal(items().length, 2)
  launch('보드 항목: 새로\n두레이 업무: P/123 「테스트」')
  assert.equal(items().length, 2)
})

test('옛 대표를 보존하고 현재 리뷰 이력은 옛 역할 판정에서 뺀다', () => {
  const legacy: any = base()
  delete legacy.workers
  board(legacy)
  writeFileSync(spec, '# 리뷰\n보드 항목 id: a\n리뷰 PR: #7')
  recordHistory(repo, { at: '2026-01-01', dispatch: 'd1', worktree: join(repo, 'new'), spec } as any)
  registerBoard(repo, spec, join(repo, 'new'), 'new', 'review/pr-7', 'd1')
  assert.equal(items()[0].workers[0].role, 'impl')
  assert.equal(items()[0].workers[0].status, 'done')
  board(legacy)
  mkdirSync(join(repo, 'old'))
  process.env.ORCA = fakeBin(repo, 'orca', [{ stdout: JSON.stringify({ ok: true, result: { workers: [{ ...orcaShape, dispatchId: 'old-dispatch', dispatchStatus: 'running', workerState: 'working' }] } }) }]).path
  recordHistory(repo, { at: '2026-01-02', dispatch: 'old-dispatch', worktree: join(repo, 'old'), run: 'run-old' } as any)
  launch('보드 항목 id: a')
  assert.equal(items()[0].workers[0].dispatch, 'old-dispatch')
  assert.equal(items()[0].workers[0].status, 'working')
  board({ ...legacy, id: 'review-pr-480', pr: null })
  launch('보드 항목 id: review-pr-480\n리뷰 PR: #480')
  assert.equal(items()[0].workers[0].role, 'review')
})

test('끝난 Orca dispatch 나 사라진 워크트리의 옛 대표를 되살리지 않는다', () => {
  const legacy: any = base()
  delete legacy.workers
  const old = join(repo, 'old')
  mkdirSync(old)
  recordHistory(repo, { at: '2026-01-02', dispatch: 'old-dispatch', worktree: old, run: 'run-old' } as any)
  const orca = fakeBin(repo, 'orca', [])
  process.env.ORCA = orca.path
  for (const outcome of ['succeeded', 'failed', null]) {
    board(legacy)
    orca.setRules([{ stdout: JSON.stringify({ ok: true, result: { workers: [{ ...orcaShape, dispatchId: 'old-dispatch', dispatchStatus: outcome ? 'completed' : 'running', workerState: outcome ? 'stopped' : 'working', projection: { outcome } }] } }) }])
    if (!outcome) rmSync(old, { recursive: true })
    launch('보드 항목 id: a')
    assert.equal(items()[0].workers[0].status, 'done', String(outcome))
    assert.equal(items()[0].workers[0].dispatch, null)
  }
})

test('Orca 조회 실패와 형식 오류는 옛 대표를 작업 중으로 남겨 다시 확인한다', () => {
  const legacy: any = base()
  delete legacy.workers
  mkdirSync(join(repo, 'old'))
  recordHistory(repo, { at: '2026-01-02', dispatch: 'old-dispatch', worktree: join(repo, 'old'), run: 'run-old' } as any)
  const orca = fakeBin(repo, 'orca', [])
  process.env.ORCA = orca.path
  for (const rule of [{ code: 1, stderr: '조회 실패' }, { stdout: JSON.stringify({ ok: true, result: {} }) }]) {
    board(legacy)
    orca.setRules([rule])
    launch('보드 항목 id: a')
    assert.equal(items()[0].workers[0].status, 'working')
    assert.equal(items()[0].workers[0].dispatch, 'old-dispatch')
  }
})

test('worker-add 실패면 기존 대표 칸 쓰기로 돌아간다', () => {
  board(base())
  const real = new URL('../../../extensions/work-board/bin/board.ts', import.meta.url).pathname
  writeNodeBin(repo, 'board-wrapper.ts', `import { spawnSync } from 'node:child_process'; if(process.argv[2]==='worker-add') {process.stderr.write('줄 쓰기 실패');process.exit(1)}; const r=spawnSync(process.execPath,[${JSON.stringify(real)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status)`)
  process.env.BOARD_BIN = join(repo, 'board-wrapper.ts')
  assert.equal(launch('보드 항목 id: a')?.attached, false)
  assert.equal(items()[0].worktree, 'new')
})

const milestone = (extra = {}) => base({
  stages: 'pr=1,merge=2', details: [{ text: '1. PR', done: true }, { text: '2. 머지', done: false }], workers: [row()], ...extra,
})
const texts = (item: any) => item.details.map((d: any) => d.text)

test('앞 PR 이 열린 항목에 새 브랜치 후속을 붙이면 PR·머지 두 단계를 더하고 줄에 번호를 적는다', () => {
  board(milestone({ 'task-ref': 'P/123' }))
  assert.deepEqual(launch('두레이 업무: P/123 「테스트」', 'wb', 'feat/b'), { item: 'a', role: 'follow', attached: true })
  const [item] = items()
  assert.deepEqual(texts(item), ['1. PR', '2. 머지', '3. PR (wb)', '4. 머지 (wb)'])
  assert.equal(item.stages, 'pr=1,merge=2')
  assert.equal(item.workers[1].role, 'follow')
  assert.equal(item.workers[1].stages, 'pr=3,merge=4')
  assert.equal(item.worktree, 'wb')
  assert.equal(item.pr, 7)
})

test('같은 워크트리나 같은 브랜치로 다시 띄우거나 리뷰를 붙이면 단계를 더하지 않는다', () => {
  board(milestone({ 'task-ref': 'P/123' }))
  launch('두레이 업무: P/123 「테스트」', 'wb', 'feat/b')
  launch('두레이 업무: P/123 「테스트」', 'wb', 'feat/b', 'd2')
  assert.equal(items()[0].details.length, 4)
  assert.equal(items()[0].workers.length, 2)
  // 대표 브랜치와 같은 브랜치(줄 없는 옛 항목의 원격 이어받기)
  board(milestone({ 'task-ref': 'P/123', workers: undefined }))
  launch('두레이 업무: P/123 「테스트」', 'wc', 'feat/a')
  assert.equal(items()[0].details.length, 2)
  assert.equal(items()[0].workers.find((one: any) => one.worktree === 'wc').stages, undefined)
  // 리뷰는 단계를 더하지 않는다
  board(milestone())
  assert.equal(launch('리뷰 PR: #7', 'review', 'feat/a')?.role, 'review')
  assert.equal(items()[0].details.length, 2)
})

test('앞 PR 이 없거나 머지된 항목은 단계를 더하지 않고 다시 열기는 지금처럼 마일스톤 전체를 붙인다', () => {
  board(milestone({ pr: undefined, 'task-ref': 'P/123' }))
  launch('두레이 업무: P/123 「테스트」', 'wb', 'feat/b')
  assert.equal(items()[0].details.length, 2)
  assert.equal(items()[0].workers.find((one: any) => one.worktree === 'wb').stages, undefined)
  // 앞 PR 이 머지됐지만 단계가 남은 항목
  board(milestone({ pr: undefined, 'merged-pr': 7, 'task-ref': 'P/123' }))
  launch('두레이 업무: P/123 「테스트」', 'wb', 'feat/b')
  assert.equal(items()[0].details.length, 2)
  // 단계를 모두 끝낸 doing 항목: 마일스톤 전체
  board(milestone({ pr: undefined, 'merged-pr': 7, 'task-ref': 'P/123', details: [{ text: '1. PR', done: true }, { text: '2. 머지', done: true }] }))
  launch('두레이 업무: P/123 「테스트」', 'wb', 'feat/b')
  assert.deepEqual(texts(items()[0]), ['1. PR', '2. 머지', '3. PR', '4. 머지'])
  assert.equal(items()[0].stages, 'pr=3,merge=4')
  assert.equal(items()[0].workers.find((one: any) => one.worktree === 'wb').stages, undefined)
})

test('단계 항목이 아닌 옛 항목은 열린 PR 이 있어도 단계를 더하지 않는다', () => {
  board(base({ 'task-ref': 'P/123' }))
  launch('두레이 업무: P/123 「테스트」', 'wb', 'feat/b')
  assert.equal(items()[0].details.length, 1)
})

test('보드 단계 설정의 pr·merge 글을 쓰고 지시서 절이 있으면 그 글을 쓴다', () => {
  writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ board: { steps: ['[pr] 리뷰 요청', '[merge] 반영', '[deploy] 배포'] } }))
  board(milestone({ 'task-ref': 'P/123', stages: 'pr=1,merge=2,deploy=3', details: [{ text: '1. 리뷰 요청', done: true }, { text: '2. 반영', done: false }, { text: '3. 배포', done: false }] }))
  launch('두레이 업무: P/123 「테스트」', 'wb', 'feat/b')
  assert.deepEqual(texts(items()[0]).slice(3), ['4. 리뷰 요청 (wb)', '5. 반영 (wb)'])
  assert.equal(items()[0].workers[1].stages, 'pr=4,merge=5')
  board(milestone({ 'task-ref': 'P/123' }))
  launch('두레이 업무: P/123 「테스트」\n\n## 보드 단계\n1. [pr] 올림\n2. [merge] 합침', 'wb', 'feat/b')
  assert.deepEqual(texts(items()[0]).slice(2), ['3. 올림 (wb)', '4. 합침 (wb)'])
})

test('단계를 더하지 못하면 줄은 stages 없이 붙고 항목 단계는 그대로다', () => {
  const real = fileURLToPath(new URL('../../../extensions/work-board/bin/board.ts', import.meta.url))
  const wrapper = join(repo, 'board-wrapper.ts')
  writeFileSync(wrapper, `import {spawnSync} from 'node:child_process'; const args=process.argv.slice(2); if(args[0]==='step-add'){process.stderr.write('거절\\n');process.exit(1)} const r=spawnSync(process.execPath,[${JSON.stringify(real)},...args],{stdio:'inherit'}); process.exitCode=r.status`)
  process.env.BOARD_BIN = wrapper
  board(milestone({ 'task-ref': 'P/123' }))
  assert.deepEqual(launch('두레이 업무: P/123 「테스트」', 'wb', 'feat/b'), { item: 'a', role: 'follow', attached: true })
  assert.equal(items()[0].details.length, 2)
  assert.equal(items()[0].workers[1].worktree, 'wb')
  assert.equal(items()[0].workers[1].stages, undefined)
})
