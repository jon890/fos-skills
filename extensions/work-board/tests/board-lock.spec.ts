import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import { saveBoard } from '../bin/board.ts'
import { item, run, runAsync, tempBoard, write } from './board-run.ts'

test('기다림 뒤 읽고 쓰므로 잠금 중 생긴 항목도 보존한다', async () => {
  const t = tempBoard()
  try {
    write(t.file); writeFileSync(`${t.file}.lock`, 'other')
    const pending = runAsync(t.file, ['set', 'b', 'wait'], { BOARD_LOCK_WAIT_MS: '3000' })
    await setTimeout(1000)
    write(t.file, { id: 'a', status: 'wait' }); unlinkSync(`${t.file}.lock`)
    assert.equal((await pending).code, 0); assert.ok(item(t.file, 'a')); assert.ok(item(t.file, 'b'))
  } finally { t.cleanup() }
})
test('잠금을 잃으면 쓰지 않고 임시 파일을 정리한다', () => {
  const t = tempBoard()
  try {
    write(t.file); const before = readFileSync(t.file, 'utf8')
    assert.equal(saveBoard(t.file, { items: [1] }, { held: () => false }), false)
    assert.equal(readFileSync(t.file, 'utf8'), before)
    assert.ok(!readdirSync(t.dir).some((name) => name.endsWith('.tmp')))
    assert.ok(saveBoard(t.file, { items: [1] }, { held: () => true }))
    assert.equal(readFileSync(t.file, 'utf8'), JSON.stringify({ items: [1] }, null, 1))
  } finally { t.cleanup() }
})
for (const stale of [false, true]) test(`함께 쓴 항목을 모두 보존한다: stale=${stale}`, async () => {
  const t = tempBoard(), count = stale ? 8 : 12
  try {
    write(t.file)
    if (stale) { writeFileSync(`${t.file}.lock`, 'old'); const old = new Date(Date.now() - 40000); utimesSync(`${t.file}.lock`, old, old) }
    const results = await Promise.all(Array.from({ length: count }, (_, n) => runAsync(t.file, ['set', `a${n}`, 'wait'])))
    for (const result of results) assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(readFileSync(t.file, 'utf8')).items.length, count)
    assert.ok(!readdirSync(t.dir).some((name) => name.endsWith('.lock') || name.includes('.claim.')))
  } finally { t.cleanup() }
})
test('잠금 실패는 바이트 보존, 읽기는 잠금 없이, 거절은 새 폴더까지 정리한다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', details: ['1. 구현'] }); const before = readFileSync(t.file, 'utf8')
    writeFileSync(`${t.file}.lock`, 'other')
    const result = run(t.file, ['set', 'a', 'wait'], { BOARD_LOCK_WAIT_MS: '20' })
    assert.equal(result.code, 1); assert.ok(result.stderr.includes(`${t.file}.lock`))
    assert.equal(readFileSync(t.file, 'utf8'), before)
    for (const args of [['list'], ['steps', 'a']]) assert.equal(run(t.file, args).code, 0)
    unlinkSync(`${t.file}.lock`)
    assert.equal(run(t.file, ['step', 'a', '9']).code, 1); assert.ok(!existsSync(`${t.file}.lock`))
    for (const folder of ['none', 'x/y']) {
      assert.equal(run(join(t.dir, folder, 'board.json'), ['step', 'a', '1']).code, 1)
      assert.ok(!existsSync(join(t.dir, folder.split('/')[0])))
    }
    assert.equal(run(t.file, ['set', 'a', 'wait'], { BOARD_LOCK_WAIT_MS: '0' }).code, 0)
    writeFileSync(`${t.file}.lock`, 'old'); const old = new Date(Date.now() - 40000); utimesSync(`${t.file}.lock`, old, old)
    assert.equal(run(t.file, ['set', 'a', 'wait']).code, 0)
    assert.ok(!readdirSync(t.dir).some((name) => name.includes('.claim.') || name.endsWith('.lock')))
  } finally { t.cleanup() }
})

test('삭제를 기다리는 동안 상태가 바뀌면 잠금 뒤 새 상태로 거절한다', async () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', status: 'done' }); writeFileSync(`${t.file}.lock`, 'other')
    const pending = runAsync(t.file, ['del-done', 'a'], { BOARD_LOCK_WAIT_MS: '3000' })
    await setTimeout(1000)
    write(t.file, { id: 'a', status: 'doing' }); unlinkSync(`${t.file}.lock`)
    const result = await pending
    assert.equal(result.code, 1); assert.match(result.stderr, /지금 doing/); assert.equal(item(t.file, 'a').status, 'doing')
  } finally { t.cleanup() }
})
