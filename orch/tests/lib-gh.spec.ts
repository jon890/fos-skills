import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { currentUser, gh, ghBin, ghJson, isOwnPr, updateBranch } from '../scripts/lib/gh.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin } from './fixtures/fake-bin.ts'

let dir: string
let fake: FakeBin
const saved = { GH: process.env.GH, GH_HOST: process.env.GH_HOST }
const RULES = [
  { args: ['api', 'user'], stdout: 'octo\n' },
  { args: ['pr', 'list'], stdout: JSON.stringify([{ number: 7 }]) },
  { args: ['broken'], stdout: '{not json' },
]

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'lib-gh-'))
  fake = fakeBin(dir, 'gh', RULES, { recordEnv: ['GH_HOST'] })
  process.env.GH = fake.path
  delete process.env.GH_HOST
})

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

function newCalls(action: () => void) {
  const start = fake.calls().length
  action()
  return fake.calls().slice(start)
}

describe('gh', () => {
  test('GH 가 있으면 그 실행 파일을 부른다', () => {
    assert.equal(ghBin(), fake.path)
  })

  test('host 를 주면 GH_HOST 로 가고 주지 않으면 GH_HOST 가 없다', () => {
    const withHost = newCalls(() => gh(['pr', 'list'], { host: 'github.example.com' }))
    assert.deepEqual(withHost.map((c) => c.env.GH_HOST), ['github.example.com'])
    const without = newCalls(() => gh(['pr', 'list']))
    assert.deepEqual(without.map((c) => c.env.GH_HOST), [null])
  })

  test('ghJson 은 stdout 을 JSON 으로 읽고 깨진 JSON 은 ok: false 다', () => {
    assert.deepEqual(ghJson(['pr', 'list']), { ok: true, data: [{ number: 7 }] })
    assert.equal(ghJson(['broken']).ok, false)
  })
})

describe('currentUser', () => {
  test('gh api user 의 login 을 낸다', () => {
    const calls = newCalls(() => assert.equal(currentUser('github.example.com'), 'octo'))
    assert.deepEqual(calls.map((c) => c.env.GH_HOST), ['github.example.com'])
  })

  test('gh 가 실패하면 null 이다', () => {
    fake.setRules([{ code: 1, stderr: 'auth' }])
    try {
      assert.equal(currentUser(), null)
    } finally {
      fake.setRules(RULES)
    }
  })
})

describe('isOwnPr', () => {
  test('작성자가 목록에 있으면 내 PR 이다. 로그인은 대소문자를 가리지 않는다', () => {
    assert.equal(isOwnPr({ author: { login: 'Octo' } }, ['other', 'octo']), true)
    assert.equal(isOwnPr({ author: { login: 'octo' } }, ['other']), false)
  })

  test('작성자 목록이 비면 내 PR 이 아니다', () => {
    assert.equal(isOwnPr({ author: { login: 'octo' } }, []), false)
  })
})

describe('updateBranch', () => {
  test('gh api -X PUT repos/<repo>/pulls/<번호>/update-branch 를 부른다', () => {
    const calls = newCalls(() => assert.equal(updateBranch('o/r', { number: 7, isDraft: false }, 'merge-turn').code, 0))
    assert.deepEqual(calls.map((c) => c.argv), [['api', '-X', 'PUT', 'repos/o/r/pulls/7/update-branch']])
  })

  test('draft 인 PR 은 behind-draft 로 부를 수 있다', () => {
    const calls = newCalls(() => updateBranch('o/r', { number: 8, isDraft: true }, 'behind-draft'))
    assert.deepEqual(calls.map((c) => c.argv), [['api', '-X', 'PUT', 'repos/o/r/pulls/8/update-branch']])
  })

  test('draft 가 아닌 PR 에 behind-draft 로 부르면 gh 를 부르지 않고 2 로 거부한다', () => {
    let code = -1
    let stderr = ''
    const calls = newCalls(() => {
      const r = updateBranch('o/r', { number: 7, isDraft: false }, 'behind-draft')
      code = r.code
      stderr = r.stderr
    })
    assert.equal(code, 2)
    assert.match(stderr, /draft/)
    assert.deepEqual(calls, [])
  })
})
