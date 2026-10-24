import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { ConfigError } from '../scripts/lib/config.ts'
import { apiTarget, currentUser, gh, ghBin, ghJson, isOwnPr, ownAuthors, updateBranch } from '../scripts/lib/gh.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin } from './fixtures/fake-bin.ts'

let dir: string
let fake: FakeBin
const saved = { GH: process.env.GH, GH_HOST: process.env.GH_HOST, ORCH_DIR: process.env.ORCH_DIR, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES }
const RULES = [
  { args: ['api', 'user'], stdout: 'octo\n' },
  { args: ['pr', 'list'], stdout: JSON.stringify([{ number: 7 }]) },
  { args: ['broken'], stdout: '{not json' },
]

before(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lib-gh-')))
  fake = fakeBin(dir, 'gh', RULES, { recordEnv: ['GH_HOST'] })
  process.env.GH = fake.path
  delete process.env.GH_HOST
  // ownAuthors 가 읽는 저장소는 git 밖 폴더라 주 checkout 이 그 폴더 자신이다. 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다
  process.env.GIT_CEILING_DIRECTORIES = dir
  delete process.env.ORCH_DIR
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

describe('apiTarget', () => {
  test('GHE URL 에서 호스트와 owner/repo 를 읽는다', () => {
    assert.deepEqual(apiTarget('https://ghe.example.com/owner/repo/pull/7'), { host: 'ghe.example.com', slug: 'owner/repo' })
  })

  test('조각이 모자라거나 빈 URL 은 null 이다', () => {
    assert.equal(apiTarget('https://ghe.example.com/owner'), null)
    assert.equal(apiTarget('https:///owner/repo/pull/7'), null)
    assert.equal(apiTarget(''), null)
  })
})

describe('ownAuthors', () => {
  function repoWith(config: unknown): string {
    const repo = mkdtempSync(join(dir, 'repo-'))
    if (config !== undefined) {
      mkdirSync(join(repo, '.orch'))
      writeFileSync(join(repo, '.orch/config.json'), JSON.stringify(config))
    }
    return repo
  }

  test('pipeline.authors 가 있으면 그 목록이고 gh 를 부르지 않는다. 다른 pipeline 키가 함께 있어도 된다', () => {
    const repo = repoWith({ pipeline: { enabled: true, authors: ['alice', 'bob'] } })
    const calls = newCalls(() => assert.deepEqual(ownAuthors(repo, 'ghe.example.com'), ['alice', 'bob']))
    assert.deepEqual(calls, [])
  })

  test('pipeline.authors 가 없으면 GH_HOST=<host> 로 api user 를 부른다', () => {
    const repo = repoWith(undefined)
    const calls = newCalls(() => assert.deepEqual(ownAuthors(repo, 'ghe.example.com'), ['octo']))
    assert.deepEqual(
      calls.map((c) => [c.argv.slice(0, 2), c.env.GH_HOST]),
      [[['api', 'user'], 'ghe.example.com']],
    )
  })

  test('현재 사용자도 읽지 못하면 null 이다', () => {
    const repo = repoWith({ pipeline: { enabled: true } })
    fake.setRules([{ code: 1, stderr: 'auth' }])
    try {
      assert.equal(ownAuthors(repo, 'ghe.example.com'), null)
    } finally {
      fake.setRules(RULES)
    }
  })

  test('authors 가 문자열 목록이 아니면 ConfigError 다', () => {
    const repo = repoWith({ pipeline: { authors: 'alice' } })
    assert.throws(() => ownAuthors(repo, 'ghe.example.com'), ConfigError)
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
