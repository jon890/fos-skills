import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { finishStarted, markFinishStarted } from '../scripts/lib/finish-marks.ts'

let repo: string
const saved = process.env.ORCH_DIR

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'finish-marks-')))
  spawnSync('git', ['init', '-q', repo])
  delete process.env.ORCH_DIR
})
afterEach(() => {
  if (saved === undefined) delete process.env.ORCH_DIR
  else process.env.ORCH_DIR = saved
  rmSync(repo, { recursive: true, force: true })
})

describe('finish-marks', () => {
  test('남긴 PR 만 마무리가 돈 것으로 본다', () => {
    assert.equal(finishStarted(repo, 12), false)
    markFinishStarted(repo, '12')
    assert.equal(finishStarted(repo, 12), true)
    assert.equal(finishStarted(repo, '13'), false)
    const file = join(repo, '.orch', 'state', 'finish-started', '12')
    assert.ok(existsSync(file))
    assert.match(readFileSync(file, 'utf8'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/)
  })

  test('PR 번호가 아니면 남기지 않고 본 적 없는 것으로 본다', () => {
    assert.throws(() => markFinishStarted(repo, '../x'), /PR 번호가 아니다/)
    assert.equal(finishStarted(repo, '../x'), false)
  })
})
