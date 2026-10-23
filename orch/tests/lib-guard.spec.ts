import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { check } from '../scripts/lib/guard/guard.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin } from './fixtures/fake-bin.ts'

const GUARD = fileURLToPath(new URL('../scripts/lib/guard', import.meta.url))
const SHIM = { orca: join(GUARD, 'orca'), gh: join(GUARD, 'gh') }

let tmp: string
let fake: { orca: FakeBin; gh: FakeBin }

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lib-guard-')))
  fake = {
    orca: fakeBin(tmp, 'orca', [{ stdout: 'orca-out\n', code: 0 }]),
    gh: fakeBin(tmp, 'gh', [{ args: ['view'], stdout: 'gh-out\n', code: 3 }, { code: 0 }]),
  }
})

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// shim 을 이 테스트의 node 로 띄운다. shim 의 #! 줄이 PATH 의 node 를 고르므로, PATH 맨 앞에 이 node 의 폴더를 둔다.
function shim(tool: 'orca' | 'gh', argv: string[], env: Record<string, string | undefined> = {}, input = '') {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ORCH_REAL_ORCA: fake.orca.path,
    ORCH_REAL_GH: fake.gh.path,
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  const done = spawnSync(SHIM[tool], argv, { env: merged, input, encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

// 진짜 실행 파일이 이 argv 로 불렸는지. 가짜 bin 의 호출 기록은 테스트 전체에 쌓이므로 argv 로 찾는다.
function called(bin: FakeBin, argv: string[]): boolean {
  return bin.calls().some((call) => JSON.stringify(call.argv) === JSON.stringify(argv))
}

describe('통과하는 호출은 진짜 실행 파일로 간다', () => {
  const allowed: Array<['orca' | 'gh', string[]]> = [
    ['gh', ['pr', 'view', '1']],
    ['gh', ['api', 'repos/o/r/pulls/1/merge']],
    ['gh', ['api', 'graphql', '-f', 'query={viewer{login}}']],
    ['orca', ['terminal', 'list']],
  ]
  for (const [tool, argv] of allowed) {
    test(`${tool} ${argv.join(' ')}`, () => {
      const r = shim(tool, argv)
      assert.equal(called(fake[tool], argv), true, `진짜 ${tool} 가 ${JSON.stringify(argv)} 로 불리지 않았다. stderr: ${r.stderr}`)
      assert.equal(r.code, tool === 'gh' && argv.includes('view') ? 3 : 0, `종료 코드가 진짜 실행 파일의 것이 아니다: ${r.stderr}`)
      assert.equal(r.stdout, tool === 'gh' && argv.includes('view') ? 'gh-out\n' : tool === 'orca' ? 'orca-out\n' : '')
    })
  }

  test('stdin 을 진짜 실행 파일에 넘긴다', () => {
    const cat = join(tmp, 'cat-gh')
    symlinkSync('/bin/cat', cat)
    const r = shim('gh', [], { ORCH_REAL_GH: cat }, '입력 한 줄\n')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, '입력 한 줄\n')
  })
})

describe('거부 표의 호출은 126 이고 진짜 실행 파일을 부르지 않는다', () => {
  const denied: Array<['orca' | 'gh', string[]]> = [
    ['orca', ['terminal', 'send', '--terminal', 'term_1', '--text', 'hi']],
    ['orca', ['--json', 'x', 'terminal', 'send', '--text', 'hi']],
    ['gh', ['pr', 'merge', '1']],
    ['gh', ['pr', '-R', 'o/r', 'merge', '1']],
    ['gh', ['-R', 'o/r', 'pr', 'merge', '1']],
    ['gh', ['pr', 'update-branch', '7']],
    ['gh', ['api', 'repos/o/r/pulls/1/update-branch']],
    ['gh', ['api', '-X', 'GET', '/repos/o/r/pulls/1/update-branch']],
    ['gh', ['api', '-X', 'PUT', 'repos/o/r/pulls/1/merge']],
    ['gh', ['api', '-XPUT', 'repos/o/r/pulls/1/merge']],
    ['gh', ['api', '--method=PUT', 'repos/{owner}/{repo}/pulls/1/merge']],
    ['gh', ['api', 'repos/o/r/pulls/1/merge', '-f', 'merge_method=squash']],
    ['gh', ['api', 'repos/o/r/merges', '-f', 'base=main', '-f', 'head=feat']],
    ['gh', ['api', 'graphql', '-f', 'query=mutation { mergePullRequest(input: {}) { clientMutationId } }']],
    ['gh', ['api', 'graphql', '-f', 'query=mutation { updatePullRequestBranch(input: {}) { clientMutationId } }']],
    ['gh', ['api', 'graphql', '-F', 'query=mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }']],
    ['gh', ['api', 'graphql', '--input', 'body.json']],
    ['gh', ['api', 'graphql', '-F', 'query=@mutation.graphql']],
    ['gh', ['api', 'graphql', '--field=query=@mutation.graphql']],
    ['gh', ['api', 'graphql', '-fquery=@mutation.graphql']],
    ['gh', ['api', 'graphql', '--raw-field', '@body']],
    ['orca', ['terminal', '--x', 'y', 'send']],
  ]
  for (const [tool, argv] of denied) {
    test(`${tool} ${argv.join(' ')}`, () => {
      const r = shim(tool, argv)
      assert.equal(r.code, 126, `거부되지 않았다: ${r.stderr}`)
      assert.match(r.stderr, /코어 명령을 쓴다/)
      assert.equal(called(fake[tool], argv), false, `거부했는데 진짜 ${tool} 가 불렸다`)
    })
  }
})

describe('진짜 실행 파일 경로 검사', () => {
  test('ORCH_REAL_GH 가 없으면 126 이다', () => {
    const r = shim('gh', ['pr', 'view', '9'], { ORCH_REAL_GH: undefined })
    assert.equal(r.code, 126)
    assert.match(r.stderr, /ORCH_REAL_GH/)
  })

  test('ORCH_REAL_GH 가 상대경로면 126 이고 그 파일을 부르지 않는다', () => {
    const argv = ['pr', 'view', '10']
    const r = shim('gh', argv, { ORCH_REAL_GH: 'gh' })
    assert.equal(r.code, 126)
    assert.match(r.stderr, /절대경로/)
    assert.equal(called(fake.gh, argv), false)
  })

  test('ORCH_REAL_GH 가 가드 폴더의 gh 를 가리키면 126 이다', () => {
    const r = shim('gh', ['pr', 'view', '11'], { ORCH_REAL_GH: SHIM.gh })
    assert.equal(r.code, 126)
    assert.match(r.stderr, /가드 폴더/)
  })

  test('가드 폴더의 gh 를 가리키는 링크도 실경로로 보아 126 이다', () => {
    const link = join(tmp, 'link-to-shim')
    symlinkSync(SHIM.gh, link)
    const r = shim('gh', ['pr', 'view', '12'], { ORCH_REAL_GH: link })
    assert.equal(r.code, 126)
    assert.match(r.stderr, /가드 폴더/)
  })
})

describe('check', () => {
  test('플래그 값과 -- 뒤의 낱말은 하위 명령으로 읽지 않는다', () => {
    assert.equal(check('gh', ['pr', 'view', '--json', 'merge']), null)
    assert.equal(check('gh', ['--repo', 'merge', 'pr', 'view']), null)
    assert.notEqual(check('gh', ['pr', '--', 'merge']), null)
  })

  test('merge 경로의 GET 은 통과하고 필드가 있으면 POST 로 보아 거부한다', () => {
    assert.equal(check('gh', ['api', 'repos/o/r/pulls/1/merge', '--jq', '.merged']), null)
    assert.equal(check('gh', ['api', '-X', 'get', 'repos/o/r/pulls/1/merge']), null)
    assert.notEqual(check('gh', ['api', 'repos/o/r/pulls/1/merge', '--raw-field', 'sha=abc']), null)
  })

  test('orca 는 플래그를 건너뛴 낱말 열에서 terminal 뒤에 send 가 있을 때 거부한다', () => {
    assert.equal(check('orca', ['terminal', 'read', '--terminal', 'term_1']), null)
    assert.equal(check('orca', ['orchestration', 'send', '--to', 'terminal']), null)
    assert.notEqual(check('orca', ['x', 'terminal', 'send']), null)
    assert.notEqual(check('orca', ['terminal', 'read', '--terminal', 'send']), null)
  })

  test('graphql 의 @ 값이 아닌 필드는 통과한다', () => {
    assert.equal(check('gh', ['api', 'graphql', '-f', 'query={viewer{login}}', '-F', 'n=1', '-f', 'email=a@b.c']), null)
  })
})
