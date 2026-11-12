import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { test } from 'node:test'
import { saveBoard } from '../bin/board.ts'
import { run, tempBoard, write } from './board-run.ts'

test('엄격 삭제는 상태를 확인하고 성공한 경우에만 사본을 남긴다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', status: 'doing' }, { id: 'b', status: 'done' }, { id: 99, status: 'done' })
    const before = readFileSync(t.file, 'utf8')
    const refused = run(t.file, ['del-done', 'a'])
    assert.equal(refused.code, 1); assert.match(refused.stderr, /--force/); assert.equal(readFileSync(t.file, 'utf8'), before); assert.equal(existsSync(`${t.file}.bak`), false)
    assert.equal(run(t.file, ['del-done', '']).code, 1)
    assert.equal(run(t.file, ['del-done']).code, 2)
    assert.equal(run(t.file, ['del-done', 'b', '--all']).code, 2)
    assert.equal(run(t.file, ['del', 'missing', '--exact']).code, 1)
    assert.deepEqual(JSON.parse(run(t.file, ['del-done', '--all']).stdout), { deleted: ['b', 99] })
    assert.equal(readFileSync(`${t.file}.bak`, 'utf8'), before)
    const after = readFileSync(t.file, 'utf8')
    assert.deepEqual(JSON.parse(run(t.file, ['del-done', '--all']).stdout), { deleted: [] })
    assert.equal(readFileSync(t.file, 'utf8'), after); assert.equal(readFileSync(`${t.file}.bak`, 'utf8'), before)
    assert.deepEqual(JSON.parse(run(t.file, ['del', 'a', '--exact']).stdout), { deleted: ['a'] })
    assert.equal(readFileSync(`${t.file}.bak`, 'utf8'), after)
    writeFileSync(`${t.file}.bak`, 'old backup')
    assert.equal(saveBoard(t.file, { items: [] }, { held: () => false }, true), false)
    assert.equal(readFileSync(`${t.file}.bak`, 'utf8'), 'old backup')
  } finally { t.cleanup() }
})

test('저장 뒤 사본을 옮기지 못해도 삭제 결과와 경고를 낸다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', status: 'done' })
    mkdirSync(`${t.file}.bak`)
    const result = run(t.file, ['del-done', 'a'])
    assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), { deleted: ['a'] })
    assert.match(result.stderr, /보드는 저장했지만 사본을 옮기지 못했다/)
    assert.deepEqual(JSON.parse(readFileSync(t.file, 'utf8')).items, [])
  } finally { t.cleanup() }
})
