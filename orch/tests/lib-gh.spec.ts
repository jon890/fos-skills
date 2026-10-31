import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { ConfigError } from '../scripts/lib/config.ts'
import { apiTarget, cancelledOnly, checkSnapshot, ciState, currentUser, gh, ghBin, ghJson, isOwnPr, ownAuthors, requiredNames, ruleChecks, updateBranch } from '../scripts/lib/gh.ts'
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

  test('host 와 expectedHead 를 주면 --hostname 을 앞에, expected_head_sha 를 끝에 붙인다', () => {
    const calls = newCalls(() => updateBranch('o/r', { number: 7, isDraft: false }, 'merge-turn', { host: 'ghe.example.com', expectedHead: 'abc123' }))
    assert.deepEqual(calls.map((c) => c.argv), [
      ['api', '--hostname', 'ghe.example.com', '-X', 'PUT', 'repos/o/r/pulls/7/update-branch', '-f', 'expected_head_sha=abc123'],
    ])
  })

  test('host 만 주면 expected_head_sha 가 없고, expectedHead 만 주면 --hostname 이 없다', () => {
    const hostOnly = newCalls(() => updateBranch('o/r', { number: 7, isDraft: false }, 'merge-turn', { host: 'ghe.example.com' }))
    assert.deepEqual(hostOnly.map((c) => c.argv), [['api', '--hostname', 'ghe.example.com', '-X', 'PUT', 'repos/o/r/pulls/7/update-branch']])
    const headOnly = newCalls(() => updateBranch('o/r', { number: 7, isDraft: false }, 'merge-turn', { expectedHead: 'abc123' }))
    assert.deepEqual(headOnly.map((c) => c.argv), [['api', '-X', 'PUT', 'repos/o/r/pulls/7/update-branch', '-f', 'expected_head_sha=abc123']])
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

// 롤업 행. 체크 실행은 name, status, conclusion, detailsUrl 을, 커밋 상태는 context, state, targetUrl 을 갖는다
function run(name: string, conclusion: string | null, status = 'COMPLETED') {
  return { __typename: 'CheckRun', name, status, conclusion, detailsUrl: `https://ci.example.com/${name}` }
}
function commitStatus(context: string, state: string) {
  return { __typename: 'StatusContext', context, state, targetUrl: `https://status.example.com/${context}` }
}

describe('ciState', () => {
  test('실제 스냅샷은 pending 60초·completed 300초로 만료하고 TTL 0 도 따른다', (t) => {
    const originalNow = Date.now
    const savedTtl = process.env.ORCH_GH_CACHE_TTL_SECONDS
    let now = originalNow()
    Date.now = () => now
    process.env.ORCH_GH_CACHE = '1'
    delete process.env.ORCH_GH_CACHE_TTL_SECONDS
    t.after(() => {
      Date.now = originalNow
      process.env.ORCH_GH_CACHE = '0'
      if (savedTtl === undefined) delete process.env.ORCH_GH_CACHE_TTL_SECONDS
      else process.env.ORCH_GH_CACHE_TTL_SECONDS = savedTtl
      fake.setRules(RULES)
    })
    const repo = mkdtempSync(join(dir, 'snapshot-ttl-'))
    const set = (status: string, conclusion: string | null) => fake.setRules([{ stdout: JSON.stringify({ headRefOid: 'head', statusCheckRollup: [run('test', conclusion, status)] }) }])
    const read = () => checkSnapshot(repo, '7', 'head')
    set('IN_PROGRESS', null)
    assert.ok(read().ok)
    set('COMPLETED', 'SUCCESS')
    now += 59_000
    assert.ok(read().ok)
    assert.equal(fake.calls().filter((call) => call.cwd === repo).length, 1)
    now += 1000
    assert.ok(read().ok)
    now += 299_000
    assert.ok(read().ok)
    assert.equal(fake.calls().filter((call) => call.cwd === repo).length, 2)
    now += 1000
    assert.ok(read().ok)
    assert.equal(fake.calls().filter((call) => call.cwd === repo).length, 3)
    process.env.ORCH_GH_CACHE_TTL_SECONDS = '0'
    assert.ok(read().ok)
    assert.ok(read().ok)
    assert.equal(fake.calls().filter((call) => call.cwd === repo).length, 5)
  })
  test('HEAD 키로 옛 캐시를 격리하고 같은 HEAD 재실행은 refresh 로 읽어 캐시도 갱신한다', (t) => {
    process.env.ORCH_GH_CACHE = '1'
    t.after(() => { process.env.ORCH_GH_CACHE = '0'; fake.setRules(RULES) })
    const repo = mkdtempSync(join(dir, 'snapshots-'))
    const set = (head: string, conclusion: string) => fake.setRules([{ args: ['pr', 'view'], stdout: JSON.stringify({ headRefOid: head, statusCheckRollup: [run('test', conclusion)] }) }])
    set('old', 'FAILURE')
    const old = checkSnapshot(repo, '7', 'old')
    assert.ok(old.ok)
    set('new', 'SUCCESS')
    const newer = checkSnapshot(repo, '7', 'new')
    assert.ok(newer.ok)
    assert.equal(ciState(newer.data.statusCheckRollup, ['test'], false, 'new').state, 'passed')
    set('new', 'FAILURE')
    const cached = checkSnapshot(repo, '7', 'new')
    assert.ok(cached.ok)
    assert.equal(ciState(cached.data.statusCheckRollup, ['test'], false, 'new').state, 'passed')
    const fresh = checkSnapshot(repo, '7', 'new', true)
    assert.ok(fresh.ok)
    assert.equal(ciState(fresh.data.statusCheckRollup, ['test'], false, 'new').state, 'failed')
    const updated = checkSnapshot(repo, '7', 'new')
    assert.deepEqual(updated, fresh)
    assert.equal(fake.calls().filter((call) => call.cwd === repo).length, 3)
  })
  const attempt = (conclusion: string | null, startedAt: string, workflow = 'CI', status = 'COMPLETED', headSha = 'head') => ({
    ...run('test', conclusion, status), startedAt, headSha, checkSuite: { workflowRun: { workflow: { name: workflow } } },
  })
  test('같은 HEAD 와 workflow 의 새 실행이 있으면 옛 취소를 세지 않는다', () => {
    const old = attempt('CANCELLED', '2026-10-30T01:00:00Z')
    const newer = attempt('SUCCESS', '2026-10-30T02:00:00Z')
    assert.equal(ciState([newer, old], ['test'], false, 'head').state, 'passed')
    assert.equal(ciState([old, { ...newer, conclusion: null, status: 'IN_PROGRESS' }], ['test'], false, 'head').state, 'pending')
    assert.equal(ciState([old, { ...newer, conclusion: 'FAILURE' }], ['test'], false, 'head').state, 'failed')
    // gh pr view 의 실제 JSON 은 checkSuite 대신 workflowName 으로 낸다.
    assert.equal(ciState([
      { ...run('test', 'CANCELLED'), workflowName: 'CI', startedAt: '2026-10-30T01:00:00Z' },
      { ...run('test', 'SUCCESS'), workflowName: 'CI', startedAt: '2026-10-30T02:00:00Z' },
    ], ['test'], false, 'head').state, 'passed')
  })
  test('다른 HEAD 결과와 다른 workflow 로 취소 실패를 덮지 않는다', () => {
    const old = attempt('CANCELLED', '2026-10-30T01:00:00Z')
    assert.equal(ciState([old, attempt('SUCCESS', '2026-10-30T02:00:00Z', 'Other')], ['test'], false, 'head').state, 'failed')
    assert.equal(ciState([old, attempt('SUCCESS', '2026-10-30T02:00:00Z', 'CI', 'COMPLETED', 'old-head')], ['test'], false, 'head').state, 'failed')
    assert.equal(ciState([attempt('FAILURE', '2026-10-30T01:00:00Z', 'CI', 'COMPLETED', 'old-head')], ['test'], false, 'head').state, 'pending')
    assert.equal(ciState([old, attempt('SUCCESS', 'invalid')], ['test'], false, 'head').state, 'failed')
    assert.equal(ciState([run('test', 'CANCELLED'), run('test', 'SUCCESS')], ['test'], false, 'head').state, 'failed')
  })
  test('필수 체크가 모두 나타나 성공으로 끝나고 실패가 없으면 passed 이고 checks 는 나타난 체크 전부다', () => {
    const got = ciState([run('test', 'SUCCESS'), run('lint', 'SUCCESS'), run('extra', 'NEUTRAL')], ['test', 'lint'], false)
    assert.equal(got.state, 'passed')
    assert.deepEqual(
      got.checks.map((c) => c.name),
      ['test', 'lint', 'extra'],
    )
  })

  test('필수가 아닌 체크가 실패하면 failed 다(머지 큐의 기본 판정과 같다)', () => {
    assert.equal(ciState([run('test', 'SUCCESS'), run('extra', 'FAILURE')], ['test'], false).state, 'failed')
    assert.equal(ciState([run('test', 'SUCCESS'), commitStatus('ci/extra', 'ERROR')], ['test'], false).state, 'failed')
  })

  test('필수가 아닌 체크가 아직 돌면 머지 큐처럼 기다리므로 pending 이다', () => {
    assert.equal(ciState([run('test', 'SUCCESS'), run('extra', null, 'IN_PROGRESS')], ['test'], false).state, 'pending')
  })

  test('체크 실행의 실패 결론마다 failed 다', () => {
    for (const conclusion of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']) {
      assert.equal(ciState([run('test', conclusion), run('lint', null, 'IN_PROGRESS')], ['test', 'lint'], false).state, 'failed', conclusion)
    }
  })

  test('커밋 상태는 name 이 없어 context 로 찾고, state 가 FAILURE 나 ERROR 면 failed 다', () => {
    for (const state of ['FAILURE', 'ERROR']) {
      const got = ciState([commitStatus('ci/legacy', state)], ['ci/legacy'], false)
      assert.equal(got.state, 'failed', state)
      assert.deepEqual(got.checks, [{ name: 'ci/legacy', status: state, conclusion: null, url: 'https://status.example.com/ci/legacy' }])
    }
    assert.equal(ciState([commitStatus('ci/legacy', 'SUCCESS')], ['ci/legacy'], false).state, 'passed')
    assert.equal(ciState([commitStatus('ci/legacy', 'PENDING')], ['ci/legacy'], false).state, 'pending')
  })

  test('필수 체크 하나가 아직 나타나지 않았거나 끝나지 않았으면 pending 이다', () => {
    assert.equal(ciState([run('test', 'SUCCESS')], ['test', 'lint'], false).state, 'pending')
    assert.equal(ciState([run('test', 'SUCCESS'), run('lint', null, 'IN_PROGRESS')], ['test', 'lint'], false).state, 'pending')
  })

  test('필수 목록이 비면 나타난 체크 전부로 판정하고, 체크가 하나도 없으면 pending 이다', () => {
    assert.equal(ciState([run('a', 'SUCCESS'), run('b', 'SUCCESS')], [], false).state, 'passed')
    assert.equal(ciState([run('a', 'SUCCESS'), run('b', 'FAILURE')], [], false).state, 'failed')
    assert.equal(ciState([], [], false).state, 'pending')
    assert.equal(ciState(null, [], false).state, 'pending')
  })

  test('skippedIsMissing 이면 SKIPPED 인 필수 체크는 나타나지 않은 것이고, 아니면 통과로 본다', () => {
    assert.equal(ciState([run('test', 'SKIPPED')], ['test'], true).state, 'pending')
    assert.equal(ciState([run('test', 'SKIPPED')], ['test'], false).state, 'passed')
  })
})

describe('cancelledOnly', () => {
  const row = (conclusion: string | null, status: string | null = 'COMPLETED') => ({ name: 'test', status, conclusion, url: null })
  test('실패한 체크가 모두 CANCELLED 일 때만 참이다', () => {
    assert.equal(cancelledOnly([row('CANCELLED'), row('CANCELLED')]), true)
    assert.equal(cancelledOnly([row('CANCELLED'), row('FAILURE')]), false)
    assert.equal(cancelledOnly([row('TIMED_OUT')]), false)
    assert.equal(cancelledOnly([row(null, 'FAILURE')]), false)
    assert.equal(cancelledOnly([]), false)
  })
})

describe('requiredNames', () => {
  function repoWith(config: unknown): string {
    const repo = mkdtempSync(join(dir, 'req-'))
    mkdirSync(join(repo, '.orch'))
    writeFileSync(join(repo, '.orch/config.json'), JSON.stringify(config))
    return repo
  }

  test('queue.required 문자열은 쉼표로 나누고 규칙 API 를 부르지 않는다. 다른 queue 키가 있어도 된다', () => {
    const repo = repoWith({ queue: { required: 'test,lint', method: 'squash', docs_glob: ['docs/**'] } })
    const calls = newCalls(() => assert.deepEqual(requiredNames(repo, 'ghe.example.com', 'o/r', 'main'), { ok: true, names: ['test', 'lint'] }))
    assert.deepEqual(calls, [])
  })

  test('queue.required 목록은 그대로다', () => {
    const repo = repoWith({ queue: { required: ['test', 'lint'] } })
    assert.deepEqual(requiredNames(repo, 'ghe.example.com', 'o/r', 'main'), { ok: true, names: ['test', 'lint'] })
  })

  test('queue.required 가 문자열이나 문자열 목록이 아니면 ConfigError 다', () => {
    const repo = repoWith({ queue: { required: 3 } })
    assert.throws(() => requiredNames(repo, 'ghe.example.com', 'o/r', 'main'), ConfigError)
  })

  test('queue.required 가 없으면 --hostname 과 함께 base 의 규칙을 읽는다', () => {
    const repo = repoWith({ queue: { method: 'squash' } })
    fake.setRules([{ args: ['repos/o/r/rules/branches/main'], stdout: '["lint","test"]\n' }])
    try {
      const calls = newCalls(() => assert.deepEqual(requiredNames(repo, 'ghe.example.com', 'o/r', 'main'), { ok: true, names: ['lint', 'test'] }))
      assert.deepEqual(
        calls.map((c) => c.argv.slice(0, 4)),
        [['api', '--hostname', 'ghe.example.com', 'repos/o/r/rules/branches/main']],
      )
    } finally {
      fake.setRules(RULES)
    }
  })
})

describe('ruleChecks', () => {
  test('플랜 제한(HTTP 403 과 Upgrade to GitHub Pro)은 빈 목록이고 그 밖의 실패는 ok: false 다', () => {
    fake.setRules([{ args: ['repos/o/r/rules/branches/main'], code: 1, stderr: 'Upgrade to GitHub Pro or make this repository public (HTTP 403)\n' }])
    try {
      assert.deepEqual(ruleChecks('github.com', 'o/r', 'main'), { ok: true, names: [] })
      fake.setRules([{ args: ['repos/o/r/rules/branches/main'], code: 1, stderr: 'HTTP 404: Not Found\n' }])
      const got = ruleChecks('github.com', 'o/r', 'main')
      assert.equal(got.ok, false)
      assert.match(got.ok ? '' : got.error, /HTTP 404/)
    } finally {
      fake.setRules(RULES)
    }
  })
})
