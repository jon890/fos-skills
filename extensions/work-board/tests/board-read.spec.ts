import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { GET_FIELDS } from '../bin/board.ts'
import { run, tempBoard, write } from './board-run.ts'

test('get, item, items 는 잠금 없이 저장된 값과 단계 값을 읽는다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', status: 'doing', pr: 555, details: ['✓ 1. 구현', '2. [ask] 머지 (#70 merge)'] }, { id: 'b', status: 'done', title: '' }, { id: 99, status: 'done' })
    writeFileSync(`${t.file}.lock`, 'other')
    const before = readFileSync(t.file, 'utf8')
    for (const field of ['status', 'title', 'owner', 'pr', 'merged-pr', 'branch', 'worktree', 'task', 'stages', 'progress', 'step']) assert.ok(GET_FIELDS.includes(field as typeof GET_FIELDS[number]))
    const get = (id: string, field: string, ...rest: string[]) => run(t.file, ['get', id, field, ...rest])
    assert.equal(JSON.parse(get('a', 'pr').stdout).value, '555')
    assert.equal(JSON.parse(get('a', 'title').stdout).value, 'a')
    assert.equal(JSON.parse(get('a', 'progress').stdout).value, '1/2')
    assert.deepEqual(JSON.parse(get('a', 'step', '2').stdout), { id: 'a', field: 'step', number: 2, value: '2. [ask] 머지 (#70 merge)' })
    assert.equal(get('b', 'title').code, 4); assert.equal(JSON.parse(get('b', 'title').stdout).value, null)
    const view = JSON.parse(run(t.file, ['view', 'a']).stdout), item = JSON.parse(run(t.file, ['item', 'a']).stdout)
    assert.deepEqual(item.lines, view.lines); assert.equal(item.pr, 555); assert.ok(!('rev' in item)); assert.ok(!('title' in item))
    assert.deepEqual(JSON.parse(run(t.file, ['items', 'done']).stdout).map((row: { id: unknown }) => row.id), ['b', 99])
    for (const args of [['items', ''], ['items', 'doing,'], ['item', '99'], ['get', 'missing', 'pr']]) assert.equal(run(t.file, args).code, 1)
    for (const args of [['get', 'a'], ['get', 'a', 'foo'], ['get', 'a', 'step'], ['get', 'a', 'pr', '1'], ['item', 'a', 'b']]) assert.equal(run(t.file, args).code, 2)
    assert.equal(readFileSync(t.file, 'utf8'), before)
  } finally { t.cleanup() }
})
