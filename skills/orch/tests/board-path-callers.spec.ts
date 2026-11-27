import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readBoard, registerBoard } from '../scripts/lib/board.ts'
import { collectStages, movementSettings } from '../scripts/lib/movement.ts'
import { context, initialState } from '../scripts/loop/steps/context.ts'
import type { StepContext } from '../scripts/loop/steps/context.ts'
import { syncBoard } from '../scripts/loop/steps/board.ts'
import { racingBoard } from './fixtures/board-race.ts'
import { writeNodeBin } from './fixtures/merge-queue-fakes.ts'

let repo: string
let chosen: string
let fallback: string
let saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = { ...process.env }
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'board-callers-')))
  chosen = join(repo, 'chosen.json')
  fallback = join(repo, '.orch/board.json')
  mkdirSync(join(repo, '.orch'))
  process.env.HOME = repo
  delete process.env.ORCH_DIR
  delete process.env.BOARD_BIN
  process.env.GIT_CEILING_DIRECTORIES = repo
  writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ finish: { board: 'chosen.json' } }))
  writeFileSync(fallback, JSON.stringify({ items: [{ id: 'fallback', status: 'doing', details: ['1. 기본 보드'] }] }))
  writeNodeBin(repo, 'gh', `require('node:fs').writeSync(1, process.argv.includes('body,headRefOid,headRefName') ? '{}' : process.argv.includes('list') ? '[]' : 'MERGED')`)
  process.env.GH = join(repo, 'gh')
})
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(repo, { recursive: true, force: true })
})
function cli(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/${script}.ts`, import.meta.url)), ...args], { cwd: repo, env: process.env, encoding: 'utf8' })
}
function board(items: Record<string, unknown>[]) { writeFileSync(chosen, JSON.stringify({ items })) }
function items() { return JSON.parse(readFileSync(chosen, 'utf8')).items }

for (const [script, args, prefix] of [
  ['board/board-sync', ['--repo'], 'board-sync'],
  ['board/board-release', ['--repo', '--pr', '1'], 'board-release'],
  ['paths/orch_paths', ['--repo', 'board'], 'orch_paths'],
  ['cleanup/handoff-cleanup', ['--repo'], 'handoff-cleanup'],
] as const) {
  for (const invalid of ['number', 'broken'] as const) {
    test(`${script}: ${invalid} 설정 오류는 한 줄과 종료 코드 2 이며 기본 보드를 고치지 않는다`, () => {
      const before = readFileSync(fallback, 'utf8')
      writeFileSync(join(repo, '.orch/config.json'), invalid === 'number' ? JSON.stringify({ finish: { board: 3 } }) : '{broken')
      const argv = args.flatMap((arg) => arg === '--repo' ? [arg, repo] : [arg])
      const done = cli(script, argv)
      assert.equal(done.status, 2, done.stderr)
      assert.equal(done.stderr.trim().split('\n').length, 1, done.stderr)
      assert.match(done.stderr, new RegExp(`^${prefix}: `))
      assert.match(done.stderr, invalid === 'number' ? /finish.board 는 문자열이어야 한다/ : /설정 파일을 읽지 못했다/)
      assert.equal(done.stdout, '')
      assert.equal(readFileSync(fallback, 'utf8'), before)
    })
  }
}

test('sync, release, paths 는 설정 보드만 읽거나 고친다', () => {
  const original = readFileSync(fallback, 'utf8')
  board([{ id: 'sync', status: 'doing', pr: '#7', details: ['1. 구현 #7'] }])
  let done = cli('board/board-sync', ['--repo', repo])
  assert.equal(done.status, 0, done.stderr)
  assert.equal(items()[0].status, 'done')
  board([{ id: 'release', status: 'doing', pr: '#7', stages: 'release=1', details: ['1. 릴리스', '남은 일: 옛 줄'] }])
  done = cli('board/board-release', ['--repo', repo, '--pr', '7'])
  assert.equal(done.status, 0, done.stderr)
  assert.equal(items()[0].status, 'done')
  done = cli('paths/orch_paths', ['--repo', repo, 'board'])
  assert.equal(done.status, 0, done.stderr)
  assert.equal(done.stdout.trim(), chosen)
  assert.equal(readFileSync(fallback, 'utf8'), original)
})

test('기본 보드가 없어도 루프가 지정 보드의 동기화를 실행한다', async () => {
  rmSync(fallback)
  board([{ id: 'a', status: 'doing', pr: '#7', details: ['1. 구현 #7'] }])
  const ctx: StepContext = { ...context(repo, undefined, undefined), tick: 1, runs: [], primary: null, loaded: null, previous: {}, lookup: { runs: [], rows: new Map() }, completions: new Map() }
  const result = await syncBoard(ctx, initialState())
  assert.deepEqual(result.errors, { board: null })
  assert.equal(items()[0].status, 'done')
  assert.equal(existsSync(fallback), false)
})

test('루프가 이미 읽은 dispatch 끝남을 보드 줄에 넘긴다', async () => {
  board([{ id: 'a', status: 'done', workers: [{ role: 'review', worktree: 'r', dispatch: 'd', status: 'working', at: '2026-01-01', pr: 7 }] }])
  const ctx: StepContext = { ...context(repo, undefined, undefined), tick: 1, runs: [{ run: 'run1' } as any], primary: null, loaded: null, previous: {}, lookup: { runs: [], rows: new Map([['run1', { ok: true, rows: [{ dispatchId: 'd', projection: { outcome: 'succeeded' } }] }]]) }, completions: new Map() }
  const result = await syncBoard(ctx, initialState())
  assert.deepEqual(result.errors, { board: null })
  assert.equal(items()[0].workers[0].status, 'done')
})

// 같은 보드로 틱을 이어서 돌린다. 줄은 임시 상태(liveness exited)에서 lost 로 적히고, 다음 틱의 Orca 행이 줄을 고친다
test('루프가 띄운 직후 잠깐 끊김으로 적은 줄을 다음 틱에 되살리고 진짜 끊긴 줄은 끊김으로 둔다', async () => {
  const workers = ['live', 'ok', 'dead'].map((name) => ({ role: 'impl', worktree: name, dispatch: `d-${name}`, status: 'working', at: '2026-01-01', pr: null }))
  board([{ id: 'a', status: 'doing', details: ['1. 남음'], workers }])
  const tick = async (rows: Record<string, unknown>[]) => {
    const ctx: StepContext = { ...context(repo, undefined, undefined), tick: 1, runs: [{ run: 'run1' } as any], primary: null, loaded: null, previous: {}, lookup: { runs: [], rows: new Map([['run1', { ok: true, rows }]]) }, completions: new Map() }
    assert.deepEqual((await syncBoard(ctx, initialState())).errors, { board: null })
    return (items()[0].workers as Record<string, unknown>[]).map((row) => row.status)
  }
  const open = (name: string, verdict: string) => ({ dispatchId: `d-${name}`, dispatchStatus: 'dispatched', workerState: 'ready', projection: { outcome: 'in_progress', liveness: { verdict } } })
  // 1틱: 띄운 직후 세 줄 모두 프로세스가 잠깐 exited 로 보여 lost 로 적힌다
  assert.deepEqual(await tick(['live', 'ok', 'dead'].map((name) => open(name, 'exited'))), ['lost', 'lost', 'lost'])
  // 2틱: 첫 줄은 live 로 돌아왔고, 둘째 줄은 succeeded 로 끝났고, 셋째 줄은 터미널이 닫혀 dispatch 가 failed 로 닫혔다
  assert.deepEqual(await tick([
    open('live', 'live'),
    { dispatchId: 'd-ok', dispatchStatus: 'completed', workerState: 'succeeded', projection: { outcome: 'succeeded', liveness: { verdict: 'exited' } } },
    { dispatchId: 'd-dead', dispatchStatus: 'failed', workerState: 'failed', projection: { outcome: 'failed', liveness: { verdict: 'exited' } } },
  ]), ['working', 'done', 'lost'])
  // 3틱: 다시 보아도 되살린 줄이 흔들리지 않고 진짜 끊긴 줄은 끊김으로 남는다
  assert.deepEqual(await tick([
    open('live', 'live'),
    { dispatchId: 'd-ok', dispatchStatus: 'completed', workerState: 'succeeded', projection: { outcome: 'succeeded' } },
    { dispatchId: 'd-dead', dispatchStatus: 'failed', workerState: 'failed', projection: { outcome: 'failed' } },
  ]), ['working', 'done', 'lost'])
})

test('단계 멈춤 조회와 등록도 지정 보드를 쓰고 기본 보드 글은 보존한다', () => {
  const original = readFileSync(fallback, 'utf8')
  board([{ id: 'a', status: 'doing', branch: 'feat/x', details: [{ text: '1. 구현', done: false }] }])
  assert.equal(collectStages(repo, new Set(), movementSettings(repo), Date.now())[0].id, 'a')
  const spec = join(repo, 'spec.md')
  writeFileSync(spec, '# 다음 작업\n보드 항목 id: a\n')
  registerBoard(repo, spec, join(repo, 'wt'), 'a', 'feat/x')
  assert.equal(items()[0].worktree, 'wt')
  assert.equal(readFileSync(fallback, 'utf8'), original)
})

test('status 는 지정 보드를 세고 잘못된 경로 설정은 SKIP-BOARD 로 알린다', () => {
  board([{ id: 'a', status: 'decide', details: ['정할 것'] }])
  let done = cli('status/orch-status', ['--repo', repo])
  assert.equal(done.status, 0, done.stderr)
  assert.match(done.stdout, /BOARD doing=0 decide=1/)
  writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ finish: { board: 42 } }))
  done = cli('status/orch-status', ['--repo', repo])
  assert.equal(done.status, 1)
  assert.match(done.stdout, /SKIP-BOARD finish.board 는 문자열이어야 한다/)
})

test('done 항목 다시 열기도 거절 뒤 새 글과 완료 값을 읽어 한 번 재시도한다', () => {
  board([{ id: 'a', status: 'done', details: [{ text: '1. 구현', done: true }] }])
  const spec = join(repo, 'spec.md')
  writeFileSync(spec, '# 다음 PR\n보드 항목 id: a\n')
  process.env.BOARD_BIN = racingBoard(repo)
  registerBoard(repo, spec, join(repo, 'wt'), 'a', 'feat/x')
  assert.match(items()[0].details[0].text, /사용자가 고친 글/)
  assert.equal(items()[0].details[0].done, true)
  assert.equal(items()[0].details[1].text.startsWith('2.'), true)
})

test('앞 PR 이 머지돼 단계가 모두 끝난 항목에 새 브랜치 worker 를 띄우면 새 PR 단계를 잇고, 같은 브랜치 재시도는 더하지 않는다', () => {
  const done = (text: string) => ({ text, done: true })
  board([{ id: 'a', status: 'doing', branch: 'feat/pr1', worktree: 'wt1', 'merged-pr': '7', stages: 'pr=1,merge=2', details: [done('1. PR'), done('2. 머지'), '남은 일: PR2'] }])
  const spec = join(repo, 'spec.md')
  writeFileSync(spec, '# PR2\n보드 항목 id: a\n')
  registerBoard(repo, spec, join(repo, 'wt2'), 'a', 'feat/pr2')
  const row = items()[0]
  assert.equal(row.branch, 'feat/pr2')
  // 다시 연 단계는 지금 기본 단계(「PR 머지」 한 줄)다
  assert.equal(row.stages, 'merge=3')
  assert.deepEqual(row.details.slice(0, 2).map((d: { done: boolean }) => d.done), [true, true])
  assert.equal(row.details.length, 3)
  assert.deepEqual(row.details[2], { text: '3. PR 머지', done: false })
  registerBoard(repo, spec, join(repo, 'wt2'), 'a', 'feat/pr2')
  assert.equal(items()[0].details.length, 3)
  assert.equal(items()[0].stages, 'merge=3')
})

test('끝나지 않은 단계가 남았거나 merged-pr 이 없는 항목은 새 브랜치여도 단계를 더하지 않는다', () => {
  const spec = join(repo, 'spec.md')
  writeFileSync(spec, '# PR2\n보드 항목 id: a\n')
  board([{ id: 'a', status: 'doing', branch: 'feat/pr1', 'merged-pr': '7', stages: 'pr=1,merge=2', details: [{ text: '1. PR', done: true }, { text: '2. 머지', done: false }] }])
  registerBoard(repo, spec, join(repo, 'wt2'), 'a', 'feat/pr2')
  assert.equal(items()[0].details.length, 2)
  board([{ id: 'a', status: 'doing', branch: 'feat/pr1', stages: 'pr=1,merge=2', details: [{ text: '1. PR', done: true }, { text: '2. 머지', done: true }] }])
  registerBoard(repo, spec, join(repo, 'wt2'), 'a', 'feat/pr2')
  assert.equal(items()[0].details.length, 2)
})

test('sync 는 옛 자동 줄 삭제와 남은 일 줄 변경을 통째 저장 하나로 합친다', () => {
  writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ finish: { board: 'chosen.json', task_pattern: '^\\[(PROJ-[0-9]+)\\]' } }))
  writeNodeBin(repo, 'gh', `require('node:fs').writeSync(1, process.argv.includes('body,headRefOid,headRefName') ? '{}' : process.argv.some((arg) => arg.startsWith('title,headRefName')) ? '{"title":"[PROJ-1] 작업","headRefName":"feat/a"}' : process.argv.includes('list') ? '[]' : 'MERGED')`)
  board([{ id: 'a', status: 'doing', pr: '#7', stages: 'pr=1,merge=2', details: ['1. PR', '2. 머지', '자동: 옛 줄', '남은 일: 옛 줄'] }])
  const done = cli('board/board-sync', ['--repo', repo, '--dry-run'])
  assert.equal(done.status, 0, done.stderr)
  assert.equal(done.stdout.split('--if-rev').length - 1, 1)
  assert.doesNotMatch(done.stdout, /--detail 자동:|--detail 남은 일:/)
  assert.match(done.stdout, /a -> done\n  set a --detail 1. PR --detail 2. 머지 --if-rev/)
})

for (const mode of ['once', 'always', 'error'] as const) {
  test(`등록의 중간 과정 저장: ${mode} 경쟁과 일반 실패`, () => {
    board([{ id: 'a', status: 'doing', pr: '#7', details: ['1. 구현'] }])
    const spec = join(repo, 'spec.md')
    writeFileSync(spec, '# CI 고침\n중간 과정: PR #7\n')
    const bin = racingBoard(repo, mode)
    process.env.BOARD_BIN = bin
    const run = () => registerBoard(repo, spec, join(repo, 'wt'), 'a', 'feat/x')
    if (mode === 'once') {
      run()
      assert.match(items()[0].details[0].text, /사용자가 고친 글/)
      assert.equal(items()[0].details[1].text, '중간 과정: CI 고침')
    } else assert.throws(run, mode === 'always' ? /줄이 바뀌어/ : /일반 쓰기 실패/)
    const calls = readFileSync(bin + '.log', 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(calls.filter((args) => args[0] === 'set').length, mode === 'error' ? 1 : 2)
    assert.ok(calls.some((args) => args[0] === 'worker-add'))
  })
}

for (const command of ['sync', 'release']) {
  test(`${command} 는 오래된 목록을 거절한 항목을 건너뛰고 다음 항목을 처리한다`, () => {
    const row = (id: string) => ({ id, status: 'doing', pr: '#7', ...(command === 'release' ? { stages: 'release=1' } : {}), details: ['1. 구현 #7', '남은 일: 옛 줄'] })
    board([row('a'), row('b')])
    process.env.ORCH_OUTPUT = 'short'
    const bin = racingBoard(repo)
    const done = cli(`board/board-${command}`, ['--repo', repo, '--board-bin', bin, ...(command === 'release' ? ['--pr', '7'] : [])])
    assert.equal(done.status, command === 'sync' ? 0 : 1, done.stderr)
    assert.match(done.stdout, /BOARD a stale/)
    assert.equal(items()[0].status, 'doing')
    assert.equal(typeof items()[0].details[0] === 'string' ? items()[0].details[0] : items()[0].details[0].text, '1. 사용자가 고친 글 0')
    assert.equal(items()[1].status, 'done')
    assert.match(done.stdout, new RegExp(`BOARD-${command.toUpperCase()} 1`))
  })
}

test('공유 보드 읽기는 목록과 객체의 옛 목표 상태를 진행 중으로 읽고 파일은 보존한다', () => {
  const old = { id: 'old', status: 'goal', progress: '1/2', details: ['1. 구현', '2. 리뷰'] }
  for (const rows of [[old], { old }]) {
    const source = JSON.stringify({ items: rows })
    writeFileSync(chosen, source)
    assert.deepEqual(readBoard(chosen), [{ ...old, status: 'doing' }])
    assert.equal(readFileSync(chosen, 'utf8'), source)
  }
})
