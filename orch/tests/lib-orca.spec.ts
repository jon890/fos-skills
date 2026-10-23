import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { orca, orcaBin, orcaJson } from '../scripts/lib/orca.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin } from './fixtures/fake-bin.ts'

let dir: string
let fake: FakeBin
const saved = { ORCA: process.env.ORCA, ORCA_CLI_COMMAND: process.env.ORCA_CLI_COMMAND }

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'lib-orca-'))
  fake = fakeBin(dir, 'orca', [
    { args: ['good'], stdout: JSON.stringify({ ok: true, result: { workers: [{ id: 'w1' }] } }) },
    { args: ['broken'], stdout: '{not json' },
    { args: ['fail'], stdout: '', stderr: 'boom', code: 3 },
    { args: ['notok'], stdout: JSON.stringify({ ok: false, error: { code: 'nope', message: '거부' } }) },
    { args: ['noresult'], stdout: JSON.stringify({ ok: true }) },
  ])
  process.env.ORCA = fake.path
  // ORCA_CLI_COMMAND 는 읽지 않는다. 엉뚱한 값을 두어 이 값이 쓰이지 않음을 본다.
  process.env.ORCA_CLI_COMMAND = join(dir, 'must-not-run')
})

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('orcaBin', () => {
  test('ORCA 가 있으면 그 값이고 없으면 orca 다', () => {
    assert.equal(orcaBin(), fake.path)
    delete process.env.ORCA
    try {
      assert.equal(orcaBin(), 'orca')
    } finally {
      process.env.ORCA = fake.path
    }
  })
})

describe('orca', () => {
  test('ORCA 의 실행 파일을 받은 인자 그대로 부른다', () => {
    const before = fake.calls().length
    const r = orca(['terminal', 'list'])
    assert.equal(r.code, 0)
    assert.deepEqual(fake.calls().slice(before).map((c) => c.argv), [['terminal', 'list']])
  })
})

describe('orcaJson', () => {
  test('--json 을 붙여 부르고 봉투의 result 를 data 로 낸다', () => {
    const before = fake.calls().length
    const r = orcaJson<{ workers: { id: string }[] }>(['orchestration', 'worker-list', 'good'])
    assert.deepEqual(r, { ok: true, data: { workers: [{ id: 'w1' }] } })
    assert.deepEqual(fake.calls().slice(before).map((c) => c.argv), [['orchestration', 'worker-list', 'good', '--json']])
  })

  test('깨진 JSON 은 ok: false 다', () => {
    const r = orcaJson(['broken'])
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.error : '', /JSON/)
  })

  test('0 이 아닌 종료 코드는 ok: false 와 stderr 다', () => {
    const r = orcaJson(['fail'])
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.error : '', /3.*boom/)
  })

  test('봉투의 ok: false 는 ok: false 다', () => {
    const r = orcaJson(['notok'])
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.error : '', /거부/)
  })

  test('봉투에 result 가 없으면 ok: false 다', () => {
    const r = orcaJson(['noresult'])
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.error : '', /result/)
  })
})
