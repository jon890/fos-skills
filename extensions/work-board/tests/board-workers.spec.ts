import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { tempBoard, run, write, item } from './board-run.ts'

test('worker 줄의 추가, 재시도, 끝남과 대표 칸', () => {
  const b = tempBoard()
  try {
    write(b.file, { id: 'a', status: 'doing', stepAt: 'old', details: ['1. 구현'] })
    const call = (...args: string[]) => { const r = run(b.file, args); assert.equal(r.code, 0, r.stderr); return r }
    const rev = JSON.parse(call('view', 'a').stdout).rev
    call('worker-add', 'a', 'impl', '--worktree', 'w1', '--branch', 'b1', '--dispatch', 'd1')
    call('worker-add', 'a', 'follow', '--worktree', 'w2', '--branch', 'b2', '--dispatch', 'd2')
    call('worker-add', 'a', 'review', '--worktree', 'r1', '--pr', '#5')
    assert.equal(item(b.file, 'a').worktree, 'w2')
    assert.equal(item(b.file, 'a').stepAt, 'old')
    assert.equal(JSON.parse(call('view', 'a').stdout).rev, rev)
    call('worker-add', 'a', 'verify', '--worktree', 'w2', '--branch', 'b9', '--dispatch', 'd3')
    const rows = () => item(b.file, 'a').workers as Record<string, unknown>[]
    assert.equal(rows().length, 3)
    assert.equal(rows()[1].role, 'follow')
    assert.equal(rows()[1].branch, 'b9')
    assert.equal(JSON.parse(call('item', 'a').stdout).workers.length, 3)
    call('worker-end', 'a', 'done', '--dispatch', 'd3')
    assert.equal(item(b.file, 'a').worktree, 'w1')
    const before = readFileSync(b.file, 'utf8')
    call('worker-end', 'a', 'done', '--dispatch', 'missing')
    assert.equal(readFileSync(b.file, 'utf8'), before)
    call('worker-end', 'a', 'lost', '--worktree', 'w1', '--clear')
    assert.equal(item(b.file, 'a').worktree, undefined)
    call('set', 'a', 'done', '--title', 'T')
    call('worker-add', 'a', 'review', '--worktree', 'r2')
    call('step', 'a', '1')
    assert.equal(item(b.file, 'a').status, 'done')
    assert.equal(rows().length, 4)
  } finally { b.cleanup() }
})

test('옛 대표를 옮기고 역할과 dispatch 를 보존한다', () => {
  const b = tempBoard()
  try {
    for (const [role, dispatch, worktree, expected] of [
      ['impl', 'd0', 'old', 'working'], ['impl', '', 'old', 'done'], ['review', 'd0', 'old', 'working'],
    ]) {
      write(b.file, { id: 'a', status: 'done', worktree, branch: 'feat/old' })
      const r = run(b.file, ['worker-add', 'a', 'follow', '--worktree', 'new', '--keep-current', role, ...(dispatch ? ['--keep-dispatch', dispatch] : [])])
      assert.equal(r.code, 0, r.stderr)
      const rows = item(b.file, 'a').workers as Record<string, unknown>[]
      assert.equal(rows[0].role, role)
      assert.equal(rows[0].status, expected)
      assert.equal(rows[0].dispatch, dispatch || null)
      assert.equal(rows.length, 2)
    }
    write(b.file, { id: 'a', worktree: 'old' })
    assert.equal(run(b.file, ['worker-add', 'a', 'follow', '--worktree', 'old', '--keep-current', 'impl']).code, 0)
    assert.equal((item(b.file, 'a').workers as unknown[]).length, 1)
  } finally { b.cleanup() }
})

test('대표가 빈 옛 항목에는 빈 구현 줄을 만들지 않는다', () => {
  const b = tempBoard()
  try {
    write(b.file, { id: 'a', status: 'done', worktree: '', branch: 'old' })
    const r = run(b.file, ['worker-add', 'a', 'review', '--worktree', 'review', '--keep-current', 'impl', '--keep-dispatch', 'old'])
    assert.equal(r.code, 0, r.stderr)
    const rows = item(b.file, 'a').workers as Record<string, unknown>[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0].role, 'review')
    assert.equal(rows[0].worktree, 'review')
  } finally { b.cleanup() }
})

test('끝난 옛 대표는 dispatch 를 이어받지 않으면 끝난 줄로 남는다', () => {
  const b = tempBoard()
  try {
    write(b.file, { id: 'a', status: 'doing', worktree: 'old', details: ['1. 구현'] })
    const r = run(b.file, ['worker-add', 'a', 'review', '--worktree', 'review', '--keep-current', 'impl'])
    assert.equal(r.code, 0, r.stderr)
    const rows = item(b.file, 'a').workers as Record<string, unknown>[]
    assert.equal(rows[0].status, 'done')
    assert.equal(rows[0].dispatch, null)
    assert.equal(typeof rows[0].endedAt, 'string')
  } finally { b.cleanup() }
})

test('worker 명령의 잘못된 옵션을 거절한다', () => {
  const b = tempBoard()
  try {
    write(b.file, { id: 'a' })
    for (const args of [
      ['worker-add', 'a', 'unknown', '--worktree', 'w'], ['worker-add', 'a', 'impl'],
      ['worker-add', 'a', 'impl', '--worktree', 'w', '--keep-current', 'unknown'],
      ['worker-end', 'a', 'done', '--dispatch', 'd', '--worktree', 'w'],
      ['set', 'a', '--dispatch', 'd'], ['worker-add', 'a', 'impl', '--worktree', 'w', '--clear'],
    ]) assert.equal(run(b.file, args).code, 2, args.join(' '))
  } finally { b.cleanup() }
})

test('대표로 바뀐 줄의 브랜치가 없으면 옛 브랜치를 지운다', () => {
  const b = tempBoard()
  try {
    write(b.file, { id: 'a', branch: 'old' })
    assert.equal(run(b.file, ['worker-add', 'a', 'impl', '--worktree', 'w1', '--dispatch', 'd1']).code, 0)
    assert.equal(item(b.file, 'a').branch, undefined)
    assert.equal(run(b.file, ['worker-add', 'a', 'follow', '--worktree', 'w2', '--branch', 'b2', '--dispatch', 'd2']).code, 0)
    assert.equal(item(b.file, 'a').branch, 'b2')
    assert.equal(run(b.file, ['worker-end', 'a', 'done', '--dispatch', 'd2']).code, 0)
    assert.equal(item(b.file, 'a').worktree, 'w1')
    assert.equal(item(b.file, 'a').branch, undefined)
  } finally { b.cleanup() }
})
