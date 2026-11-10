import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { boardPath } from '../scripts/lib/board-file.ts'
import { ConfigError } from '../scripts/lib/config.ts'

let repo: string
let saved: string | undefined
beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'board-file-')))
  saved = process.env.ORCH_DIR
  delete process.env.ORCH_DIR
})
afterEach(() => {
  if (saved === undefined) delete process.env.ORCH_DIR
  else process.env.ORCH_DIR = saved
  rmSync(repo, { recursive: true, force: true })
})
function config(board: unknown, dir = '.orch') {
  mkdirSync(join(repo, dir), { recursive: true })
  writeFileSync(join(repo, dir, 'config.json'), JSON.stringify({ finish: { board } }))
}
test('명시 값, finish.board, 옛 위치를 포함한 기본 위치 순서로 고른다', () => {
  assert.equal(boardPath(repo), join(repo, '.omc/board.json'))
  mkdirSync(join(repo, '.omc/handoffs'), { recursive: true })
  writeFileSync(join(repo, '.omc/handoffs/board.json'), '{}')
  assert.equal(boardPath(repo), join(repo, '.omc/handoffs/board.json'))
  config('custom/board.json')
  assert.equal(boardPath(repo), join(repo, 'custom/board.json'))
  assert.equal(boardPath(repo, 'explicit.json'), join(repo, 'explicit.json'))
  assert.equal(boardPath(repo, '/absolute.json'), '/absolute.json')
  assert.equal(boardPath(repo, '~/board.json'), join(homedir(), 'board.json'))
  config('')
  assert.equal(boardPath(repo), join(repo, '.omc/handoffs/board.json'))
})
test('깨진 설정과 문자열이 아닌 값은 기본 파일로 바꾸지 않고 거절한다', () => {
  for (const value of [null, 1, false, [], {}]) {
    config(value)
    assert.throws(() => boardPath(repo), ConfigError)
  }
  writeFileSync(join(repo, '.orch/config.json'), '{broken')
  assert.throws(() => boardPath(repo), ConfigError)
  assert.equal(boardPath(repo, 'explicit.json'), join(repo, 'explicit.json'))
})
test('ORCH_DIR 의 상대경로와 절대경로에서 설정을 읽는다', () => {
  config('chosen.json', 'other')
  process.env.ORCH_DIR = 'other'
  assert.equal(boardPath(repo), join(repo, 'chosen.json'))
  process.env.ORCH_DIR = join(repo, 'other')
  assert.equal(boardPath(repo), join(repo, 'chosen.json'))
})
test('워크트리의 설정과 상대 보드 경로는 주 checkout 기준이고 설정 없는 기본 위치는 받은 작업 트리다', () => {
  const git = (...args: string[]) => {
    const done = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
  }
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'init')
  const wt = join(repo, 'wt')
  git('worktree', 'add', '-q', '-b', 'feat/test', wt)
  config('chosen.json')
  assert.equal(boardPath(wt), join(repo, 'chosen.json'))
  assert.equal(boardPath(wt, 'explicit.json'), join(repo, 'explicit.json'))
  config('')
  assert.equal(boardPath(wt), join(wt, '.omc/board.json'))
})
