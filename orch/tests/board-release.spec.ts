// board-release.ts 를 임시 git 저장소, 임시 보드, 가짜 gh, 저장소의 실제 work-board/bin/board.ts 로 돌려 본다. GitHub 에는 닿지 않는다.
//
// 가짜 gh 는 작업 폴더의 state.json 에서 `pr view N` 의 JSON 을 state[N] 으로 읽는다. 없는 번호는 조회 실패다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { writeNodeBin } from './fixtures/merge-queue-fakes.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/board-release.ts', import.meta.url))

const FAKE_GH = `const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync('state.json', 'utf8'))
const args = process.argv.slice(2)
fs.appendFileSync('gh-calls.log', args[2] + '\\n')
if (args[0] === 'pr' && args[1] === 'view' && state[args[2]]) fs.writeSync(1, JSON.stringify(state[args[2]]) + '\\n')
else process.exit(1)
`

type Json = Record<string, unknown>
type Result = { code: number | null; stdout: string; stderr: string }

let bindir: string
before(() => {
  bindir = realpathSync(mkdtempSync(join(tmpdir(), 'board-release-bin-')))
  writeNodeBin(bindir, 'gh', FAKE_GH)
})
after(() => rmSync(bindir, { recursive: true, force: true }))

let tmp: string
let board: string
let states: Record<string, unknown>
let commits: Record<string, string>
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'board-release-')))
  board = join(tmp, 'board.json')
  states = {}
  // feature 는 릴리스 전에 머지한 PR, release 는 릴리스 PR 의 머지, later 는 릴리스 뒤에 머지한 PR 이다
  git('init', '-q', '-b', 'main')
  commits = {}
  for (const name of ['feature', 'release', 'later']) {
    git('commit', '-q', '--allow-empty', '-m', name)
    commits[name] = git('rev-parse', 'HEAD')
  }
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function git(...args: string[]): string {
  const done = spawnSync('git', ['-C', tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
  assert.equal(done.status, 0, done.stderr)
  return done.stdout.trim()
}

function release(items: Json[], args: string[]): { code: number | null; board: Record<string, Json>; result: Result } {
  writeFileSync(join(tmp, 'state.json'), JSON.stringify(states))
  writeFileSync(board, JSON.stringify({ items }))
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter), GH: join(bindir, 'gh'), GIT_CEILING_DIRECTORIES: dirname(tmp) }
  delete env.BOARD_BIN
  delete env.ORCH_DIR
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--board', board, '--repo', tmp, ...args], { env, cwd: tmp, encoding: 'utf8' })
  const result = { code: done.status, stdout: done.stdout, stderr: done.stderr }
  const loaded = (JSON.parse(readFileSync(board, 'utf8')) as { items: Json[] }).items
  return { code: result.code, board: Object.fromEntries(loaded.map((item) => [String(item.id), item])), result }
}

const step = (text: string, done: boolean): Json => ({ text, done })
const four = (doneUpTo: number) => ['1. PR', '2. 머지', '3. 배포', '4. 릴리스'].map((text, i) => step(text, i < doneUpTo))
const STAGES = 'pr=1,merge=2,deploy=3,release=4'

describe('board-release', () => {
  test('같은 PR 이 여러 항목에 있어도 한 번만 조회한다', () => {
    states['100'] = { state: 'MERGED', mergeCommit: { oid: commits.release } }
    states['7'] = { state: 'MERGED', mergeCommit: { oid: commits.feature } }
    const r = release([
      { id: 'a', status: 'doing', pr: 7, stages: STAGES, details: four(3) },
      { id: 'b', status: 'goal', details: [step('1. 릴리스 (#7 release)', false)] },
    ], ['--release', '100', '--dry-run'])
    assert.equal(r.code, 0, r.result.stderr)
    assert.match(r.result.stdout, /step a 4/)
    assert.match(r.result.stdout, /step b 1/)
    assert.deepEqual(readFileSync(join(tmp, 'gh-calls.log'), 'utf8').trim().split('\n'), ['100', '7'])
  })
  test('릴리스 PR 의 커밋이 품은 PR 의 항목만 [release] 단계까지 끝내고 done 으로 바꾼다', () => {
    states['100'] = { state: 'MERGED', mergeCommit: { oid: commits.release }, headRefOid: commits.release }
    states['7'] = { state: 'MERGED', mergeCommit: { oid: commits.feature } }
    states['8'] = { state: 'MERGED', mergeCommit: { oid: commits.later } }
    states['9'] = { state: 'OPEN', mergeCommit: null }
    const r = release(
      [
        { id: 'in', status: 'doing', pr: 7, 'merged-pr': 7, stages: STAGES, details: [...four(2), step('남은 일: PR #6', false)] },
        { id: 'after', status: 'doing', pr: 8, stages: STAGES, details: four(2) },
        { id: 'open', status: 'doing', pr: 9, stages: STAGES, details: four(1) },
        { id: 'legacy', status: 'doing', pr: 7, details: [step('1. 구현', false)] },
      ],
      ['--release', '#100'],
    )
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.in.status, 'done')
    assert.deepEqual(r.board.in.details, four(4))
    assert.equal(r.board.after.status, 'doing')
    assert.deepEqual(r.board.after.details, four(2))
    assert.deepEqual(r.board.open.details, four(1))
    assert.deepEqual(r.board.legacy.details, [step('1. 구현', false)])
    assert.match(r.result.stdout, /board-release: in$/m)
  })

  test('--pr 은 pr 칸이나 merged-pr 칸에 그 번호가 든 항목을 끝낸다', () => {
    const r = release(
      [
        { id: 'a', status: 'doing', 'merged-pr': '5, 7', stages: STAGES, details: four(3) },
        { id: 'b', status: 'doing', pr: 8, stages: STAGES, details: four(3) },
      ],
      ['--pr', '7'],
    )
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'done')
    assert.equal(r.board.b.status, 'doing')
  })

  test('--dry-run 은 보드를 고치지 않고 부를 명령을 낸다', () => {
    const r = release([{ id: 'a', status: 'doing', pr: 7, stages: STAGES, details: four(3) }], ['--pr', '7', '--dry-run'])
    assert.equal(r.code, 0, r.result.stderr)
    assert.deepEqual(r.board.a.details, four(3))
    assert.match(r.result.stdout, /^a -> done \(PR #7\)\n {2}step a 4\n/)
  })

  test('--release 와 --pr 을 함께 주거나 둘 다 주지 않으면 사용법 오류다', () => {
    for (const args of [[], ['--release', '1', '--pr', '2'], ['--pr', 'x']]) {
      const r = release([], args)
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.result.stderr}`)
    }
  })

  test('릴리스 PR 을 읽지 못하면 1 로 끝나고 보드를 고치지 않는다', () => {
    const r = release([{ id: 'a', status: 'doing', pr: 7, stages: STAGES, details: four(3) }], ['--release', '100'])
    assert.equal(r.code, 1)
    assert.deepEqual(r.board.a.details, four(3))
  })

  test('설정 파일의 board 절이 틀리면 사용법 오류다', () => {
    mkdirSync(join(tmp, '.orch'), { recursive: true })
    writeFileSync(join(tmp, '.orch', 'config.json'), JSON.stringify({ board: { done_after: 'later' } }))
    const r = release([], ['--pr', '7'])
    assert.equal(r.code, 2, r.result.stderr)
  })
})

describe('손으로 쓴 release 단계', () => {
  const details = [step('1. 반영 (#7 release)', false), step('2. 다른 반영 (#8 release)', false), step('3. 사람이 확인', false)]
  test('--pr 은 goal 과 next 의 지정 PR 단계만 끝낸다', () => {
    const r = release([{ id: 'g', status: 'goal', next: details }, { id: 'a', status: 'doing', pr: 9, details }], ['--pr', '7'])
    assert.equal(r.code, 0, r.result.stderr)
    const want = details.map((d, i) => ({ ...d, done: i === 0 }))
    assert.deepEqual(r.board.g.next, want)
    assert.deepEqual(r.board.a.details, want)
    assert.equal(r.board.g.status, 'goal')
    assert.equal(r.board.a.status, 'doing')
  })
  test('--release 는 릴리스 커밋이 포함한 PR 의 단계만 끝낸다', () => {
    states['100'] = { state: 'MERGED', mergeCommit: { oid: commits.release } }
    states['7'] = { state: 'MERGED', mergeCommit: { oid: commits.feature } }
    states['8'] = { state: 'MERGED', mergeCommit: { oid: commits.later } }
    const r = release([{ id: 'g', status: 'goal', details }], ['--release', '100'])
    assert.equal(r.code, 0, r.result.stderr)
    assert.deepEqual(r.board.g.details, details.map((d, i) => ({ ...d, done: i === 0 })))
  })
  test('dry-run 은 보드를 바꾸지 않는다', () => {
    const r = release([{ id: 'g', status: 'goal', details }], ['--pr', '7', '--dry-run'])
    assert.equal(r.code, 0, r.result.stderr)
    assert.deepEqual(r.board.g.details, details)
    assert.match(r.result.stdout, /step g 1/)
  })
})
