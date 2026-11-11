import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { registerBoard } from '../scripts/lib/board.ts'
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
  fallback = join(repo, '.omc/board.json')
  mkdirSync(join(repo, '.orch'))
  mkdirSync(join(repo, '.omc'))
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
  ['board/goal-progress', ['goal'], 'goal-progress'],
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

test('sync, release, goal, paths 는 설정 보드만 읽거나 고친다', () => {
  const original = readFileSync(fallback, 'utf8')
  board([{ id: 'sync', status: 'doing', pr: '#7', details: ['1. 구현 #7'] }])
  let done = cli('board/board-sync', ['--repo', repo])
  assert.equal(done.status, 0, done.stderr)
  assert.equal(items()[0].status, 'done')
  board([{ id: 'release', status: 'doing', pr: '#7', stages: 'release=1', details: ['1. 릴리스', '남은 일: 옛 줄'] }])
  done = cli('board/board-release', ['--repo', repo, '--pr', '7'])
  assert.equal(done.status, 0, done.stderr)
  assert.equal(items()[0].status, 'done')
  board([{ id: 'goal', status: 'goal', details: ['sync'] }, { id: 'sync', status: 'done' }])
  done = cli('board/goal-progress', ['goal', 'sync'])
  assert.equal(done.status, 0, done.stderr)
  assert.equal(items()[0].progress, '1/1')
  done = cli('paths/orch_paths', ['--repo', repo, 'board'])
  assert.equal(done.status, 0, done.stderr)
  assert.equal(done.stdout.trim(), chosen)
  assert.equal(readFileSync(fallback, 'utf8'), original)
})

test('기본 보드가 없어도 루프가 지정 보드의 동기화를 실행한다', async () => {
  rmSync(fallback)
  board([{ id: 'a', status: 'doing', pr: '#7', details: ['1. 구현 #7'] }])
  const ctx: StepContext = { ...context(repo, undefined, undefined), tick: 1, runs: [], primary: null, loaded: null, previous: {}, lookup: { runs: [], rows: new Map() } }
  const result = await syncBoard(ctx, initialState())
  assert.deepEqual(result.errors, { board: null })
  assert.equal(items()[0].status, 'done')
  assert.equal(existsSync(fallback), false)
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

test('sync 는 옛 자동 줄 삭제와 남은 일 줄 변경을 통째 저장 하나로 합친다', () => {
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
    assert.equal(calls.length, mode === 'error' ? 1 : 2)
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
