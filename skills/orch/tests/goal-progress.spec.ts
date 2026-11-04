// goal-progress.ts 를 임시 보드와 인자를 기록하는 가짜 보드 명령으로 돌려 본다. orca 와 GitHub 에는 닿지 않는다.
// 기본 보드 명령(work-board/bin/board.ts)을 쓰는 사례 하나만 실제 보드 명령으로 임시 보드를 고친다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/goal-progress.ts', import.meta.url))

let tmp: string
let board: string
let calls: string
let fakeBin: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'goal-progress-')))
  board = join(tmp, 'board.json')
  calls = join(tmp, 'calls.json')
  fakeBin = join(tmp, 'board.py')
  writeFileSync(
    board,
    JSON.stringify({ items: [{ id: 'goal', status: 'goal', title: '목표' }, { id: 'a', status: 'done', title: 'A' }, { id: 'b', status: 'doing', title: 'B' }] }),
  )
  writeFileSync(fakeBin, `import json,sys\njson.dump(sys.argv[1:], open(${JSON.stringify(calls)}, 'w'))\n`)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function goal(args: string[], opts: { env?: Record<string, string> } = {}): { code: number | null; stdout: string; stderr: string } {
  // shim 은 PATH 의 node 를 부른다. 이 테스트를 도는 node 를 앞에 둔다
  const env = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter), ...opts.env }
  delete env.BOARD_BIN
  if (opts.env?.BOARD_BIN) env.BOARD_BIN = opts.env.BOARD_BIN
  const argv = [process.execPath, '--disable-warning=ExperimentalWarning', SCRIPT]
  const done = spawnSync(argv[0], [...argv.slice(1), ...args], { env, encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

const recorded = (): string[] => JSON.parse(readFileSync(calls, 'utf8')) as string[]

function writeGoal(details: unknown[]): void {
  writeFileSync(board, JSON.stringify({ items: [{ id: 'goal', status: 'goal', details }] }))
}

describe('goal-progress', () => {
  test('추적 항목 중 done 인 수를 세고 없는 항목은 끝나지 않은 것으로 알린다', () => {
    const r = goal(['goal', 'a', 'b', 'gone', '--board', board, '--board-bin', fakeBin, '--details', '--dry-run'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, 'goal 1/3\n  ✓ A\n  B\n  gone\n')
    assert.match(r.stderr, /보드에 없는 추적 항목\(끝나지 않은 것으로 셈\): gone/)
  })

  test('진행률과 하위 줄을 보드 명령으로 넣는다', () => {
    writeFileSync(join(tmp, 'items.txt'), '# 오늘\na\n\nb\n')
    const r = goal(['goal', '--items-file', join(tmp, 'items.txt'), '--board', board, '--board-bin', fakeBin, '--details'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(recorded(), ['set', 'goal', '--progress', '1/2', '--file', board, '--detail', '✓ A', '--detail', 'B'])
  })

  test('같은 추적 항목이 겹쳐도 한 번만 센다', () => {
    const r = goal(['goal', 'a', 'a', 'b', '--board', board, '--board-bin', fakeBin])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(recorded(), ['set', 'goal', '--progress', '1/2', '--file', board])
  })

  test('추적 항목이 없으면 목표 항목의 단계 줄을 세고 참고 줄은 세지 않는다', () => {
    writeGoal(['✓ 1. 구현', '2. 리뷰', '✓ 3. 머지', '참고: 메모', '✓ 완료한 참고'])
    const r = goal(['goal', '--board', board, '--board-bin', fakeBin, '--details'])
    assert.equal(r.code, 0, r.stderr)
    // 단계 줄이 곧 하위 줄이라 --details 를 줘도 하위 줄을 다시 쓰지 않는다
    assert.deepEqual(recorded(), ['set', 'goal', '--progress', '2/3', '--file', board])
  })

  test('객체 단계와 옛 문자열 단계를 함께 센다', () => {
    writeGoal([{ text: '1. 구현', done: true }, { text: '2. 리뷰', done: false }, '✓ 3. 머지', { text: '참고', done: true }])
    const r = goal(['goal', '--board', board, '--board-bin', fakeBin])
    assert.equal(r.code, 0, r.stderr)
    assert.ok(recorded().includes('2/3'), recorded().join(' '))
  })

  test('단계 줄이 없으면 진행률을 건드리지 않는다', () => {
    writeGoal(['참고: 메모'])
    const r = goal(['goal', '--board', board, '--board-bin', fakeBin])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /goal 단계 줄이 없어 진행률을 건드리지 않았다/)
    assert.equal(existsSync(calls), false)
  })

  test('--dry-run 은 보드 명령을 부르지 않는다', () => {
    const r = goal(['goal', 'a', '--board', board, '--board-bin', fakeBin, '--dry-run'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(existsSync(calls), false)
  })

  test('--board-bin 이 없으면 BOARD_BIN 환경 변수의 명령을 쓴다', () => {
    const r = goal(['goal', 'a', '--board', board], { env: { BOARD_BIN: fakeBin } })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(recorded(), ['set', 'goal', '--progress', '1/1', '--file', board])
  })

  test('--board-bin 과 BOARD_BIN 이 없으면 work-board/bin/board.ts 로 보드 파일을 고친다', () => {
    const r = goal(['goal', 'a', 'b', '--board', board])
    assert.equal(r.code, 0, r.stderr)
    const saved = JSON.parse(readFileSync(board, 'utf8')) as { items: { id: string; progress?: string }[] }
    assert.equal(saved.items.find((item) => item.id === 'goal')?.progress, '1/2', readFileSync(board, 'utf8'))
    assert.equal(existsSync(calls), false, '가짜 보드 명령이 불렸다')
  })

  test('보드 명령이 실패하면 1 이다', () => {
    writeFileSync(fakeBin, 'import sys\nsys.stderr.write("boom\\n")\nsys.exit(3)\n')
    const r = goal(['goal', 'a', '--board', board, '--board-bin', fakeBin])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /boom/)
  })

  test('목표 항목이 보드에 없으면 1 이다', () => {
    const r = goal(['nope', 'a', '--board', board, '--dry-run'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /목표 항목이 보드에 없다: nope/)
  })

  test('보드를 읽지 못하면 1 이고 목표 id 가 없으면 사용법 오류다', () => {
    assert.equal(goal(['goal', '--board', join(tmp, 'none.json')]).code, 1)
    assert.equal(goal([]).code, 2)
  })

})
