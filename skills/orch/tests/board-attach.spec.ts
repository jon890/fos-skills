import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, test } from 'node:test'
import { registerBoard } from '../scripts/lib/board.ts'
import { writeNodeBin } from './fixtures/merge-queue-fakes.ts'
import { recordHistory } from '../scripts/lib/launch-history.ts'

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
  recordHistory(repo, { at: '2026-01-02', dispatch: 'old-dispatch', worktree: join(repo, 'old') } as any)
  launch('보드 항목 id: a')
  assert.equal(items()[0].workers[0].dispatch, 'old-dispatch')
  assert.equal(items()[0].workers[0].status, 'working')
  board({ ...legacy, id: 'review-pr-480' })
  launch('보드 항목 id: review-pr-480\n리뷰 PR: #480')
  assert.equal(items()[0].workers[0].role, 'review')
})

test('worker-add 실패면 기존 대표 칸 쓰기로 돌아간다', () => {
  board(base())
  const real = new URL('../../../extensions/work-board/bin/board.ts', import.meta.url).pathname
  writeNodeBin(repo, 'board-wrapper.ts', `import { spawnSync } from 'node:child_process'; if(process.argv[2]==='worker-add') {process.stderr.write('줄 쓰기 실패');process.exit(1)}; const r=spawnSync(process.execPath,[${JSON.stringify(real)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status)`)
  process.env.BOARD_BIN = join(repo, 'board-wrapper.ts')
  assert.equal(launch('보드 항목 id: a')?.attached, false)
  assert.equal(items()[0].worktree, 'new')
})
