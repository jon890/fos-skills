// ci-ready.ts 를 가짜 gh 와 임시 git 저장소(bare origin 과 clone)로 본다. GitHub 에는 닿지 않는다.
// 충돌 판정은 merge-tree 라, 가짜 gh 의 headRefOid 에는 임시 저장소의 실제 커밋을 넣는다.
// before-ready 와 pr-ready 핸들러는 임시 저장소의 .orch/hooks/ 에 두고, 받은 입력을 HOOK_LOG 파일에 적게 한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/ci-ready.ts', import.meta.url))

// 상태 파일로 움직이는 가짜 gh. 받은 인자를 한 줄씩 기록한다. 확장자가 없어 타입 문법 없이 쓴다.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, args.join(' ') + '\\n')
const prs = state.prs
const say = (text) => fs.writeSync(1, text + '\\n')
if (args[0] === 'api' && args[1] === 'user') {
  say(state.user || 'me')
  process.exit(0)
}
if (args[0] === 'api') {
  if (state.api_fails) process.exit(1)
  const number = args.find((a) => a.startsWith('repos/')).split('/')[4]
  say(prs[number]._files.join('\\n'))
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view') {
  say(JSON.stringify(prs[args[2]]))
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'list') {
  if (state.list_fails) process.exit(1)
  const base = args[args.indexOf('--base') + 1]
  say(JSON.stringify(Object.values(prs).filter((p) => p.state === 'OPEN' && p.baseRefName === base)))
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'ready') {
  prs[args[2]].isDraft = false
  fs.writeFileSync(file, JSON.stringify(state))
  process.exit(0)
}
process.exit(3)
`

// CI 에는 git 작성자 설정이 없고, 로컬의 전역 설정은 결과를 바꿀 수 있어 고정한다.
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

type Pr = Record<string, unknown>

let tmp: string
let repo: string
let origin: string
let stateFile: string
let log: string
let hookLog: string
let env: NodeJS.ProcessEnv
let clean: string

function git(cwd: string, ...args: string[]): string {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
  return done.stdout.trim()
}

// origin/main 위에 files 를 커밋해 origin 의 ref 로 push 하고 커밋 SHA 를 낸다.
// local 이 false 면 따로 둔 clone 에서 만들어, ci-ready 가 도는 저장소에는 그 커밋이 없다.
function pushCommit(ref: string, files: Record<string, string>, local = true): string {
  const cwd = local ? repo : join(tmp, 'fork')
  if (!local && !existsSync(cwd)) git(tmp, 'clone', '-q', origin, cwd)
  git(cwd, 'fetch', '-q', 'origin')
  git(cwd, 'checkout', '-q', '--detach', 'origin/main')
  for (const [name, body] of Object.entries(files)) writeFileSync(join(cwd, name), body)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', ref)
  git(cwd, 'push', '-q', 'origin', `HEAD:${ref.startsWith('refs/') ? ref : `refs/heads/${ref}`}`)
  const sha = git(cwd, 'rev-parse', 'HEAD')
  git(cwd, 'checkout', '-q', 'main')
  return sha
}

function advanceMain(files: Record<string, string>): void {
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'pull', '-q', 'origin', 'main')
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body)
  git(repo, 'commit', '-q', '-am', 'main')
  git(repo, 'push', '-q', 'origin', 'main')
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ci-ready-')))
  stateFile = join(tmp, 'state.json')
  log = join(tmp, 'gh.log')
  hookLog = join(tmp, 'hooks.jsonl')
  writeFileSync(join(tmp, 'gh'), FAKE_GH)
  chmodSync(join(tmp, 'gh'), 0o755)
  env = {
    ...process.env,
    ...GIT_ENV,
    // 가짜 gh 의 #! 줄이 이 테스트의 node 를 쓰게 한다
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    GIT_CEILING_DIRECTORIES: tmp,
    GH: join(tmp, 'gh'),
    FAKE_STATE: stateFile,
    FAKE_LOG: log,
    HOOK_LOG: hookLog,
  }
  delete env.ORCH_DIR
  delete env.GH_HOST
  origin = join(tmp, 'origin.git')
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
  repo = join(tmp, 'repo')
  git(tmp, 'clone', '-q', origin, repo)
  writeFileSync(join(repo, 'a.txt'), '1\n2\n3\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'push', '-q', 'origin', 'HEAD:main')
  clean = pushCommit('clean', { 'clean.txt': 'c\n' })
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function pr(number: number, files: string[], over: Pr = {}): Pr {
  return {
    number,
    state: 'OPEN',
    isDraft: true,
    mergeable: 'MERGEABLE',
    baseRefName: 'main',
    url: `https://ghe.example.com/owner/repo/pull/${number}`,
    title: `PR ${number}`,
    author: { login: 'me' },
    headRefName: 'clean',
    headRefOid: clean,
    isCrossRepository: false,
    _files: files,
    ...over,
  }
}

function ready(prs: Pr[], args: string[], extra: Record<string, unknown> = {}) {
  writeFileSync(stateFile, JSON.stringify({ prs: Object.fromEntries(prs.map((p) => [String(p.number), p])), ...extra }))
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, ...args], { encoding: 'utf8', env })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr, both: `${done.stdout}\n${done.stderr}` }
}

function ghLines(): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line) : []
}

function readied(): string[] {
  return ghLines()
    .filter((line) => line.startsWith('pr ready '))
    .map((line) => line.split(' ')[2])
}

function hook(event: string, body: string): void {
  mkdirSync(join(repo, '.orch/hooks'), { recursive: true })
  writeFileSync(join(repo, `.orch/hooks/${event}.ts`), body)
}

// stdin 의 입력을 HOOK_LOG 에 한 줄로 적고 code 로 끝나는 핸들러.
function recordingHook(code: number, reason = ''): string {
  return [
    "import { appendFileSync, readFileSync } from 'node:fs'",
    "appendFileSync(process.env.HOOK_LOG, JSON.stringify(JSON.parse(readFileSync(0, 'utf8'))) + '\\n')",
    reason ? `console.log(${JSON.stringify(reason)})` : '',
    `process.exitCode = ${code}`,
  ].join('\n')
}

function hookInputs(): Record<string, unknown>[] {
  if (!existsSync(hookLog)) return []
  return readFileSync(hookLog, 'utf8')
    .split('\n')
    .filter((line) => line)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function config(body: unknown): void {
  mkdirSync(join(repo, '.orch'), { recursive: true })
  writeFileSync(join(repo, '.orch/config.json'), JSON.stringify(body))
}

describe('ci-ready 판정', () => {
  test('겹치지 않은 draft 를 ready 로 바꾼다', () => {
    const r = ready([pr(1, ['a.py']), pr(2, ['b.py'], { isDraft: false })], ['1'])
    assert.equal(r.code, 0, r.both)
    assert.match(r.stdout, /^1 ready 로 바꿈\(CI 시작\)$/m)
    assert.deepEqual(readied(), ['1'])
  })

  test('ready PR 과 겹치면 보류한다', () => {
    const r = ready([pr(1, ['a.py', 'c.py']), pr(2, ['a.py'], { isDraft: false })], ['1'])
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /^1 보류: ready PR 과 겹친다 #2\(a\.py\)$/m)
    assert.deepEqual(readied(), [])
  })

  test('draft 나 다른 base 의 PR 과 겹치는 것은 막지 않는다', () => {
    const r = ready([pr(1, ['a.py']), pr(2, ['a.py']), pr(3, ['a.py'], { isDraft: false, baseRefName: 'develop' })], ['1'])
    assert.equal(r.code, 0, r.both)
    assert.deepEqual(readied(), ['1'])
  })

  test('겹침은 작성자와 관계없이 본다', () => {
    const r = ready([pr(1, ['a.py']), pr(2, ['a.py'], { isDraft: false, author: { login: 'someone' } })], ['1'])
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /1 보류: ready PR 과 겹친다 #2\(a\.py\)/)
  })

  test('같은 실행에서 앞서 ready 로 바꾼 PR 이 다음 PR 을 막는다', () => {
    const r = ready([pr(1, ['a.py']), pr(2, ['a.py'])], ['1', '2'])
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /^2 보류: ready PR 과 겹친다 #1\(a\.py\)$/m)
    assert.deepEqual(readied(), ['1'])
  })

  test('--dry-run 은 바꿀 PR 도 ready 로 세지만 아무것도 부르지 않는다', () => {
    const r = ready([pr(1, ['a.py']), pr(2, ['a.py'])], ['--dry-run', '1', '2'])
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /^1 ready 로 바꿀 것$/m)
    assert.match(r.stdout, /^2 보류/m)
    assert.deepEqual(readied(), [])
  })

  test('이미 ready 인 PR 은 건너뛰고 OPEN 이 아닌 PR 은 보류한다', () => {
    const r = ready([pr(1, ['a.py'], { isDraft: false }), pr(2, ['b.py'], { state: 'MERGED' })], ['1', '2'])
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /^1 이미 ready$/m)
    assert.match(r.stdout, /^2 보류: state=MERGED$/m)
    assert.deepEqual(readied(), [])
  })

  test('바뀐 파일은 GraphQL 이 아니라 PR URL 호스트의 REST 로 읽는다', () => {
    // 오버레이가 GraphQL 2차 한도 때문에 `--json files` 를 금지한다
    const r = ready([pr(1, ['a.py']), pr(2, ['b.py'], { isDraft: false })], ['1'])
    assert.equal(r.code, 0, r.both)
    const lines = ghLines()
    assert.deepEqual(lines.filter((line) => line.startsWith('pr ') && line.includes('files')), [])
    const api = lines.filter((line) => line.startsWith('api ') && !line.startsWith('api user'))
    assert.ok(api.includes('api --hostname ghe.example.com repos/owner/repo/pulls/1/files?per_page=100 --paginate --jq .[].filename'), api.join('\n'))
    assert.ok(api.some((line) => line.includes('pulls/2/files')), api.join('\n'))
  })

  test('바뀐 파일이 300 개면 모두 비교한다', () => {
    const many = Array.from({ length: 300 }, (_, i) => `f${i}.py`)
    const r = ready([pr(1, many), pr(2, ['f299.py'], { isDraft: false })], ['1'])
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /1 보류: ready PR 과 겹친다 #2\(f299\.py\)/)
  })

  test('바뀐 파일이 300 개를 넘으면 보류한다', () => {
    const r = ready([pr(1, Array.from({ length: 301 }, (_, i) => `f${i}.py`))], ['1'])
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /301 개로 300 개를 넘는다/)
  })

  test('바뀐 파일을 읽지 못하면 2 다', () => {
    const r = ready([pr(1, ['a.py'])], ['1'], { api_fails: true })
    assert.equal(r.code, 2, r.both)
    assert.match(r.stderr, /파일을 읽지 못했다/)
    assert.deepEqual(readied(), [])
  })

  test('ready PR 목록을 읽지 못하면 2 다', () => {
    const r = ready([pr(1, ['a.py'])], ['1'], { list_fails: true })
    assert.equal(r.code, 2, r.both)
    assert.deepEqual(readied(), [])
  })

  test('origin 을 받지 못하면 조회 실패 2 다', () => {
    git(repo, 'remote', 'set-url', 'origin', join(tmp, 'missing.git'))
    const r = ready([pr(1, ['a.py'])], ['1'])
    assert.equal(r.code, 2, r.both)
    assert.match(r.stderr, /1 조회 실패: git fetch origin 실패/)
    assert.deepEqual(readied(), [])
  })

  test('PR 번호가 아니면 사용법 오류다', () => {
    assert.equal(ready([], ['abc']).code, 2)
  })
})

describe('ci-ready 충돌 판정', () => {
  test('gh 가 MERGEABLE 이어도 merge-tree 가 충돌이면 보류하고 ready 로 바꾸지 않는다', () => {
    const head = pushCommit('feat', { 'a.txt': '1\nfeat\n3\n' })
    advanceMain({ 'a.txt': '1\nmain\n3\n' })
    const r = ready([pr(1, ['a.txt'], { headRefName: 'feat', headRefOid: head, mergeable: 'MERGEABLE' })], ['1'])
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /^1 보류: base 와 충돌한다\. worker 가 base 를 합친 뒤 다시 돌린다$/m)
    assert.deepEqual(readied(), [])
  })

  test('gh 가 CONFLICTING 이어도 merge-tree 가 충돌이 아니면 ready 로 바꾼다', () => {
    const r = ready([pr(1, ['clean.txt'], { mergeable: 'CONFLICTING' })], ['1'])
    assert.equal(r.code, 0, r.both)
    assert.deepEqual(readied(), ['1'])
  })

  test('PR HEAD 가 로컬에 없는 cross repo PR 은 refs/pull/<번호>/head 를 받아 판정한다', () => {
    const head = pushCommit('refs/pull/5/head', { 'fork.txt': 'f\n' }, false)
    assert.notEqual(spawnSync('git', ['-C', repo, 'cat-file', '-e', `${head}^{commit}`], { env }).status, 0, '커밋이 이미 로컬에 있다')
    const r = ready([pr(5, ['fork.txt'], { headRefName: 'fork-branch', headRefOid: head, isCrossRepository: true })], ['5'])
    assert.equal(r.code, 0, r.both)
    assert.deepEqual(readied(), ['5'])
  })

  test('받을 수 없는 headRefOid 는 충돌 여부를 판정하지 못했다로 보류하고 1 이다', () => {
    const r = ready([pr(1, ['a.py'], { headRefName: 'gone', headRefOid: 'f'.repeat(40) })], ['1'])
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /^1 보류: 충돌 여부를 판정하지 못했다: /m)
    assert.deepEqual(readied(), [])
  })
})

describe('ci-ready 내 PR 판정', () => {
  test('다른 작성자의 PR 은 보류한다. 작성자 목록은 PR URL 호스트의 현재 사용자다', () => {
    const r = ready([pr(1, ['a.py'], { author: { login: 'someone' } })], ['1'])
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /^1 보류: 내 PR 이 아니다\(작성자 someone\)$/m)
    assert.deepEqual(readied(), [])
    assert.ok(ghLines().includes('api user --jq .login'), ghLines().join('\n'))
  })

  test('pipeline.authors 에 든 작성자의 PR 은 ready 로 바꾸고 gh 의 현재 사용자를 묻지 않는다', () => {
    config({ pipeline: { enabled: true, authors: ['someone'] } })
    const r = ready([pr(1, ['a.py'], { author: { login: 'Someone' } })], ['1'])
    assert.equal(r.code, 0, r.both)
    assert.deepEqual(readied(), ['1'])
    assert.deepEqual(ghLines().filter((line) => line.startsWith('api user')), [])
  })

  test('pipeline 절에 모르는 키가 있으면 사용법 오류 2 다', () => {
    config({ pipeline: { authorz: ['someone'] } })
    const r = ready([pr(1, ['a.py'])], ['1'])
    assert.equal(r.code, 2, r.both)
    assert.match(r.stderr, /authorz/)
  })
})

describe('ci-ready 이벤트', () => {
  test('before-ready 가 10 으로 거부하면 HOOK-REJECT 줄과 보류이고 ready 로 바꾸지 않는다', () => {
    hook('before-ready', recordingHook(10, '지금은 CI 를 돌리지 않는다'))
    const r = ready([pr(1, ['a.py'])], ['1'])
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /^HOOK-REJECT before-ready 지금은 CI 를 돌리지 않는다$/m)
    assert.match(r.stdout, /^1 보류: before-ready 가 막았다$/m)
    assert.deepEqual(readied(), [])
  })

  test('before-ready 와 pr-ready 는 pr, ready_count, slots 를 받는다', () => {
    config({ pipeline: { ready_slots: 2 } })
    hook('before-ready', recordingHook(0))
    hook('pr-ready', recordingHook(0))
    const r = ready([pr(1, ['a.py']), pr(2, ['b.py'], { isDraft: false }), pr(3, ['c.py'], { isDraft: false, author: { login: 'someone' } })], ['1'])
    assert.equal(r.code, 0, r.both)
    const [before, after] = hookInputs()
    assert.equal(before.event, 'before-ready')
    assert.equal(before.base, 'main')
    assert.equal(before.run, null)
    assert.deepEqual(before.pr, { number: 1, title: 'PR 1', branch: 'clean', head: clean, author: 'me', draft: true, url: 'https://ghe.example.com/owner/repo/pull/1' })
    // 이미 ready 인 내 PR 은 #2 하나다. 다른 작성자의 #3 은 세지 않는다
    assert.equal(before.ready_count, 1)
    assert.equal(before.slots, 2)
    assert.equal(after.event, 'pr-ready')
    assert.equal((after.pr as Record<string, unknown>).draft, false)
    assert.equal(after.ready_count, 2)
  })

  test('pr-ready 가 1 로 끝나면 HOOK-FAIL 줄이 나고 종료 코드는 0 이다', () => {
    hook('pr-ready', recordingHook(1))
    const r = ready([pr(1, ['a.py'])], ['1'])
    assert.equal(r.code, 0, r.both)
    assert.match(r.stdout, /^HOOK-FAIL pr-ready 1$/m)
    assert.deepEqual(readied(), ['1'])
  })

  test('--dry-run 은 핸들러를 부르지 않는다', () => {
    hook('before-ready', recordingHook(0))
    hook('pr-ready', recordingHook(0))
    const r = ready([pr(1, ['a.py'])], ['--dry-run', '1'])
    assert.equal(r.code, 0, r.both)
    assert.match(r.stdout, /^1 ready 로 바꿀 것$/m)
    assert.deepEqual(hookInputs(), [])
  })
})
