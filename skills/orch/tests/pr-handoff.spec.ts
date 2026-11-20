import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanupPrHandoff } from '../scripts/lib/pr-handoff.ts'

test('머지된 PR 폴더만 휴지통으로 옮기고 옛 파일은 개수만 센다', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-handoff-'))
  const old = process.env.ORCH_DIR
  try {
    process.env.ORCH_DIR = join(root, 'orch')
    const handoff = join(root, 'orch', 'handoff')
    mkdirSync(join(handoff, 'pr-77'), { recursive: true })
    mkdirSync(join(handoff, 'pr-78'))
    mkdirSync(join(handoff, 'measurements'))
    mkdirSync(join(handoff, 'pending'))
    writeFileSync(join(handoff, 'pr-77', 'body.md'), '본문')
    writeFileSync(join(handoff, 'pr-77', 'reply.tsv'), '대응')
    writeFileSync(join(handoff, 'old-body.md'), '옛 파일')
    const trash = join(root, 'trash')
    const result = cleanupPrHandoff(root, '77', trash)
    assert.deepEqual(result, { moved: true, legacy: 1, trash: join(trash, 'handoff', 'pr-77') })
    assert.equal(readFileSync(join(trash, 'handoff', 'pr-77', 'body.md'), 'utf8'), '본문')
    assert.equal(readFileSync(join(trash, 'handoff', 'pr-77', 'reply.tsv'), 'utf8'), '대응')
    assert.ok(existsSync(join(handoff, 'pr-78')))
    assert.ok(existsSync(join(handoff, 'measurements')))
    assert.ok(existsSync(join(handoff, 'pending')))
    assert.ok(existsSync(join(handoff, 'old-body.md')))
    assert.deepEqual(cleanupPrHandoff(root, '77', trash), { moved: false, legacy: 1, trash: null })
  } finally {
    if (old === undefined) delete process.env.ORCH_DIR
    else process.env.ORCH_DIR = old
    rmSync(root, { recursive: true, force: true })
  }
})

test('같은 휴지통 이름이 있으면 덮어쓰지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-handoff-'))
  const old = process.env.ORCH_DIR
  try {
    process.env.ORCH_DIR = join(root, 'orch')
    const handoff = join(root, 'orch', 'handoff', 'pr-77')
    const trash = join(root, 'trash', 'handoff', 'pr-77')
    mkdirSync(handoff, { recursive: true })
    mkdirSync(trash, { recursive: true })
    writeFileSync(join(trash, 'body.md'), '기존')
    writeFileSync(join(handoff, 'body.md'), '새것')
    assert.equal(cleanupPrHandoff(root, '77', join(root, 'trash')).trash, `${trash}.2`)
    assert.equal(readFileSync(join(trash, 'body.md'), 'utf8'), '기존')
    assert.equal(readFileSync(join(`${trash}.2`, 'body.md'), 'utf8'), '새것')
  } finally {
    if (old === undefined) delete process.env.ORCH_DIR
    else process.env.ORCH_DIR = old
    rmSync(root, { recursive: true, force: true })
  }
})
