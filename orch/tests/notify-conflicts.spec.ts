// notify-conflicts.ts 를 가짜 orca, gh, send-to-worker 와 임시 git 저장소(bare origin 과 clone)로 본다. Orca 와 GitHub 에는 닿지 않는다.
// pr-conflict 핸들러는 임시 저장소의 .orch/hooks/ 에 두고, 받은 입력을 HOOK_LOG 파일에 적게 한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/notify-conflicts.ts', import.meta.url))

// 상태 파일의 workers 를 worker-list 로 내는 가짜 orca. 확장자가 없어 타입 문법 없이 쓴다.
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'))
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, 'orca ' + args.join(' ') + '\\n')
if (state.orca_fails) {
  fs.writeSync(1, 'boom\\n')
  process.exit(1)
}
if (args[0] === 'orchestration' && args[1] === 'worker-list') {
  fs.writeSync(1, JSON.stringify({ ok: true, result: { workers: state.workers || [] } }) + '\\n')
  process.exit(0)
}
process.exit(3)
`

// pr list 에 prs.json 을, api user 에 me 를 내는 가짜 gh.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (process.env.GH_FAILS) process.exit(1)
if (args[0] === 'api' && args[1] === 'user') fs.writeSync(1, 'me\\n')
else if (args[0] === 'pr' && args[1] === 'list') fs.writeSync(1, fs.readFileSync(process.env.FAKE_PRS, 'utf8'))
else process.exit(3)
`

// send-to-worker 대역. 받은 인자를 SEND_LOG 에 JSON 한 줄로 적고 FAKE_OUT 을 내고 FAKE_EXIT 로 끝난다.
const FAKE_SEND = [
  "import { appendFileSync } from 'node:fs'",
  "appendFileSync(process.env.SEND_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')",
  "if (process.env.FAKE_OUT) console.log(process.env.FAKE_OUT)",
  "process.exitCode = Number(process.env.FAKE_EXIT || '0')",
].join('\n')

// stdin 의 입력을 HOOK_LOG 에 한 줄로 적고 code 로 끝나는 핸들러.
function recordingHook(code: number): string {
  return [
    "import { appendFileSync, readFileSync } from 'node:fs'",
    "appendFileSync(process.env.HOOK_LOG, JSON.stringify(JSON.parse(readFileSync(0, 'utf8'))) + '\\n')",
    `process.exitCode = ${code}`,
  ].join('\n')
}

// CI 에는 git 작성자 설정이 없고, 로컬의 전역 설정은 결과를 바꿀 수 있어 고정한다.
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

let tmp: string
let repo: string
let env: NodeJS.ProcessEnv
let sendLog: string
let hookLog: string

function git(cwd: string, ...args: string[]): string {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
  return done.stdout.trim()
}

function commit(cwd: string, files: Record<string, string>, message: string): void {
  for (const [name, body] of Object.entries(files)) writeFileSync(join(cwd, name), body)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', message)
}

// origin/main 위에 브랜치를 만들어 워크트리에 커밋하고 push 한다.
function branch(name: string, files: Record<string, string>): { path: string; head: string } {
  const path = join(tmp, name)
  git(repo, 'worktree', 'add', '-q', '-b', name, path, 'origin/main')
  commit(path, files, name)
  git(path, 'push', '-q', 'origin', name)
  return { path, head: git(path, 'rev-parse', 'HEAD') }
}

function advanceMain(files: Record<string, string>): void {
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'pull', '-q', 'origin', 'main')
  commit(repo, files, 'main')
  git(repo, 'push', '-q', 'origin', 'main')
}

type Row = [number, string, string, string?]

function prs(...rows: Row[]): void {
  const list = rows.map(([number, name, head, author]) => ({
    number,
    title: `PR ${number}`,
    headRefName: name,
    headRefOid: head,
    isCrossRepository: false,
    isDraft: false,
    author: { login: author ?? 'me' },
    url: `https://ghe.example.com/owner/repo/pull/${number}`,
  }))
  writeFileSync(join(tmp, 'prs.json'), JSON.stringify(list))
}

function workers(...rows: { id: string; status: string; path: string }[]): void {
  const list = rows.map((row) => ({
    dispatchId: row.id,
    dispatchStatus: row.status,
    taskId: `task_${row.id}`,
    agentTerminalHandle: `term_${row.id}`,
    resource: { worktreeId: `repo::${row.path}` },
  }))
  writeFileSync(join(tmp, 'state.json'), JSON.stringify({ workers: list }))
}

function notify(...args: string[]) {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--base', 'main', ...args], { encoding: 'utf8', env })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr, both: `${done.stdout}\n${done.stderr}` }
}

function sent(): string[][] {
  return existsSync(sendLog)
    ? readFileSync(sendLog, 'utf8')
        .split('\n')
        .filter((line) => line)
        .map((line) => JSON.parse(line) as string[])
    : []
}

function hookInputs(): Record<string, unknown>[] {
  return existsSync(hookLog)
    ? readFileSync(hookLog, 'utf8')
        .split('\n')
        .filter((line) => line)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
}

function hook(code: number): void {
  mkdirSync(join(repo, '.orch/hooks'), { recursive: true })
  writeFileSync(join(repo, '.orch/hooks/pr-conflict.ts'), recordingHook(code))
}

function commonSpec(): string {
  const file = join(repo, '.orch/specs/spec-common.md')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '# 공통\n')
  return file
}

function specFiles(): string[] {
  const dir = join(repo, '.orch/specs')
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('spec-conflict-')) : []
}

function stateFile(): string {
  return join(repo, '.orch/state/notify-conflicts.json')
}

function baseSha(): string {
  return git(repo, 'rev-parse', 'origin/main')
}

// feat 는 base 와 a.txt 에서 충돌하고 other 는 충돌하지 않는다. feat 워크트리에 끝난 dispatch 와 살아 있는 dispatch 가 있다.
function setupConflict(): string {
  const feat = branch('feat', { 'a.txt': '1\nfeat\n3\n', 'c.txt': 'c\n' })
  const other = branch('other', { 'd.txt': 'd\n' })
  advanceMain({ 'a.txt': '1\nmain\n3\n' })
  prs([7, 'feat', feat.head], [8, 'other', other.head])
  workers({ id: 'ctx_old', status: 'completed', path: feat.path }, { id: 'ctx_live', status: 'dispatched', path: feat.path })
  return feat.path
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'notify-conflicts-')))
  sendLog = join(tmp, 'send.jsonl')
  hookLog = join(tmp, 'hooks.jsonl')
  for (const [name, body] of [
    ['orca', FAKE_ORCA],
    ['gh', FAKE_GH],
  ]) {
    writeFileSync(join(tmp, name), body)
    chmodSync(join(tmp, name), 0o755)
  }
  writeFileSync(join(tmp, 'send.ts'), FAKE_SEND)
  writeFileSync(join(tmp, 'state.json'), '{}')
  env = {
    ...process.env,
    ...GIT_ENV,
    // 가짜 orca 와 gh 의 #! 줄이 이 테스트의 node 를 쓰게 한다
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    GIT_CEILING_DIRECTORIES: tmp,
    ORCA: join(tmp, 'orca'),
    GH: join(tmp, 'gh'),
    SEND_TO_WORKER: join(tmp, 'send.ts'),
    FAKE_STATE: join(tmp, 'state.json'),
    FAKE_LOG: join(tmp, 'orca.log'),
    FAKE_PRS: join(tmp, 'prs.json'),
    SEND_LOG: sendLog,
    HOOK_LOG: hookLog,
  }
  delete env.ORCH_DIR
  delete env.GH_HOST
  git(tmp, 'init', '-q', '--bare', '-b', 'main', join(tmp, 'origin.git'))
  repo = join(tmp, 'repo')
  git(tmp, 'clone', '-q', join(tmp, 'origin.git'), repo)
  commit(repo, { 'a.txt': '1\n2\n3\n', 'b.txt': 'b\n' }, 'init')
  git(repo, 'push', '-q', 'origin', 'HEAD:main')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('살아 있는 dispatch', () => {
  test('충돌한 PR 을 내고 그 워크트리의 살아 있는 worker 에게 한 번만 알린다', () => {
    setupConflict()
    const r = notify('--run', 'run_x')
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /^#7 CONFLICTING feat: a\.txt$/m)
    assert.doesNotMatch(r.stdout, /#8/)
    assert.match(r.stdout, /^ {2}ctx_live 에 알렸다$/m)
    const calls = sent()
    assert.equal(calls.length, 1, JSON.stringify(calls))
    const [args] = calls
    assert.deepEqual(args.slice(0, 3), ['--dispatch', 'ctx_live', '--body'])
    assert.ok(args[3].startsWith('PR #7 이 base main('), args[3])
    assert.match(args[3], /충돌 파일: a\.txt\./)
    assert.deepEqual(args.slice(4), ['--run', 'run_x'])
    const r2 = notify('--run', 'run_x')
    assert.equal(r2.code, 1, r2.both)
    assert.match(r2.stdout, /이미 알렸다\(ctx_live\)/)
    assert.equal(sent().length, 1)
  })

  test('base 가 움직이면 다시 알린다', () => {
    setupConflict()
    notify()
    advanceMain({ 'b.txt': 'b2\n' })
    notify()
    assert.equal(sent().length, 2)
  })

  test('send-to-worker 가 1 이면 reply 는 남았으니 기록하고 두 번째 실행은 보내지 않는다', () => {
    setupConflict()
    env.FAKE_EXIT = '1'
    const r = notify()
    assert.match(r.stdout, /ctx_live 에 알렸다\(깨우지 못했다, 종료 코드 1\)/)
    env.FAKE_EXIT = '0'
    notify()
    assert.equal(sent().length, 1)
    assert.equal(JSON.parse(readFileSync(stateFile(), 'utf8'))[`7@${baseSha()}`], 'ctx_live')
  })

  test('send-to-worker 가 4 면 깨우지 못했다고 붙이고 기록한다', () => {
    setupConflict()
    env.FAKE_EXIT = '4'
    const r = notify()
    assert.match(r.stdout, /ctx_live 에 알렸다\(깨우지 못했다, 종료 코드 4\)/)
    notify()
    assert.equal(sent().length, 1)
  })

  test('send-to-worker 가 5 면 기록하지 않아 두 번째 실행이 다시 보낸다', () => {
    setupConflict()
    hook(0)
    env.FAKE_EXIT = '5'
    const r = notify()
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /ctx_live 에 보내지 못했다\(send-to-worker 종료 코드 5\)/)
    assert.match(r.stderr, /기록하지 않는다/)
    assert.deepEqual(hookInputs(), [])
    env.FAKE_EXIT = '0'
    notify()
    assert.equal(sent().length, 2)
  })

  test('send-to-worker 가 3 이면 CONFLICT-ORPHAN 을 내고 기록해 두 번째 실행이 보내지 않는다', () => {
    setupConflict()
    hook(0)
    env.FAKE_EXIT = '3'
    const r = notify()
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /^CONFLICT-ORPHAN 7 /m)
    const [input] = hookInputs()
    assert.equal(input.action, 'orphan')
    assert.equal((input.worker as Record<string, unknown>).dispatch, 'ctx_live')
    env.FAKE_EXIT = '0'
    const r2 = notify()
    assert.match(r2.stdout, /이미 알렸다\(orphan\)/)
    assert.equal(sent().length, 1)
  })

  test('send-to-worker 가 2 면 그 자리에서 멈추고 2 다', () => {
    setupConflict()
    env.FAKE_EXIT = '2'
    const r = notify()
    assert.equal(r.code, 2, r.both)
    assert.equal(existsSync(stateFile()), false)
  })
})

describe('끝난 dispatch', () => {
  function setupEnded(): string {
    const path = setupConflict()
    workers({ id: 'ctx_old', status: 'completed', path })
    return path
  }

  test('후속 지시서를 써서 --body 없이 --spec 으로 보내고 resumed 로 pr-conflict 를 낸다', () => {
    const path = setupEnded()
    const common = commonSpec()
    hook(0)
    const r = notify('--run', 'run_x')
    assert.equal(r.code, 1, r.both)
    const sha = baseSha()
    const spec = join(repo, '.orch/specs', `spec-conflict-7-${sha.slice(0, 8)}.md`)
    assert.deepEqual(specFiles(), [`spec-conflict-7-${sha.slice(0, 8)}.md`])
    const text = readFileSync(spec, 'utf8')
    assert.ok(text.split('\n')[0].includes(common), text)
    assert.match(text, /^브랜치: `feat`$/m)
    assert.match(text, /^허락: push 는 허락됐다\. PR 은 이미 있으므로 새로 열지 않는다$/m)
    assert.match(text, /origin\/main/)
    assert.match(text, /^- a\.txt$/m)
    assert.deepEqual(sent(), [['--dispatch', 'ctx_old', '--spec', spec, '--run', 'run_x']])
    const [input] = hookInputs()
    assert.equal(input.action, 'resumed')
    assert.equal(input.base_head, sha)
    assert.deepEqual(input.files, ['a.txt'])
    assert.equal(input.run, 'run_x')
    assert.deepEqual(input.worker, { task: 'task_ctx_old', dispatch: 'ctx_old', terminal: 'term_ctx_old', worktree: path, spec })
    assert.equal((input.pr as Record<string, unknown>).number, 7)
    assert.equal(JSON.parse(readFileSync(stateFile(), 'utf8'))[`7@${sha}`], 'ctx_old')
  })

  test('공통 지시서가 없으면 stderr 에 경고하고 지시서에 그 줄을 넣지 않는다', () => {
    setupEnded()
    const r = notify()
    assert.match(r.stderr, /공통 지시서가 없어/)
    const [name] = specFiles()
    const text = readFileSync(join(repo, '.orch/specs', name), 'utf8')
    assert.doesNotMatch(text, /spec-common\.md/)
    assert.match(text.split('\n')[0], /^# PR #7/)
  })

  test('send-to-worker 가 1 이고 다시 띄운 흔적이 없으면 기록하지 않아 두 번째 실행이 다시 보낸다', () => {
    setupEnded()
    env.FAKE_EXIT = '1'
    env.FAKE_OUT = 'relaunch: 끝난 ctx_old 의 터미널 term_ctx_old 에 새 Task 로 띄운다'
    const r = notify()
    assert.match(r.stdout, /ctx_old 에 보내지 못했다\(send-to-worker 종료 코드 1\)/)
    notify()
    assert.equal(sent().length, 2)
  })

  test('send-to-worker 가 1 이어도 stdout 에 LAUNCHED 가 있으면 resumed 로 기록한다', () => {
    setupEnded()
    hook(0)
    env.FAKE_EXIT = '1'
    env.FAKE_OUT = `LAUNCHED ctx_new ${tmp}/feat`
    const r = notify()
    assert.match(r.stdout, /ctx_old 에 알렸다\(다시 띄운 뒤 종료 코드 1 로 끝났다\)/)
    assert.equal(hookInputs()[0].action, 'resumed')
    notify()
    assert.equal(sent().length, 1)
  })

  test('send-to-worker 가 1 이고 stdout 에 restart: 만 있으면 기록하지 않아 두 번째 실행이 다시 보낸다', () => {
    setupEnded()
    env.FAKE_EXIT = '1'
    env.FAKE_OUT = 'restart: term_ctx_old 을 닫고 같은 워크트리에 새 worker 를 띄운다'
    const r = notify()
    assert.match(r.stdout, /ctx_old 에 보내지 못했다\(send-to-worker 종료 코드 1\)/)
    notify()
    assert.equal(sent().length, 2)
  })
})

describe('worker 를 찾지 못함', () => {
  test('워크트리가 없으면 보내지 않고 CONFLICT-ORPHAN 과 action orphan, worker null 로 기록한다', () => {
    const feat = branch('feat', { 'a.txt': '1\nfeat\n3\n' })
    advanceMain({ 'a.txt': '1\nmain\n3\n' })
    git(repo, 'worktree', 'remove', '--force', feat.path)
    prs([7, 'feat', feat.head])
    hook(0)
    const r = notify()
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /^CONFLICT-ORPHAN 7 워크트리 없음/m)
    assert.deepEqual(sent(), [])
    const [input] = hookInputs()
    assert.equal(input.action, 'orphan')
    assert.equal(input.worker, null)
    assert.match(notify().stdout, /이미 알렸다\(orphan\)/)
  })

  test('그 워크트리의 dispatch 가 없으면 orphan 이다', () => {
    setupConflict()
    workers()
    const r = notify()
    assert.match(r.stdout, /^CONFLICT-ORPHAN 7 그 워크트리의 dispatch 없음/m)
    assert.deepEqual(sent(), [])
  })

  test('worker 목록을 읽지 못하면 알리지도 기록하지도 않는다', () => {
    setupConflict()
    writeFileSync(join(tmp, 'state.json'), JSON.stringify({ orca_fails: true }))
    const r = notify()
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /worker 목록을 읽지 못해 알리지 않았다/)
    assert.deepEqual(sent(), [])
    assert.equal(existsSync(stateFile()), false)
  })
})

describe('그 밖', () => {
  test('다른 작성자의 PR 은 줄도 알림도 없고, 그것만 충돌하면 0 이다', () => {
    const feat = branch('feat', { 'a.txt': '1\nfeat\n3\n' })
    advanceMain({ 'a.txt': '1\nmain\n3\n' })
    prs([7, 'feat', feat.head, 'someone'])
    workers({ id: 'ctx_live', status: 'dispatched', path: feat.path })
    const r = notify()
    assert.equal(r.code, 0, r.both)
    assert.doesNotMatch(r.stdout, /#7/)
    assert.deepEqual(sent(), [])
  })

  test('--dry-run 은 지시서, 기록 파일, 핸들러 실행을 남기지 않는다', () => {
    const path = setupConflict()
    hook(0)
    commonSpec()
    let r = notify('--dry-run')
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /ctx_live 에 알릴 것: PR #7/)
    workers({ id: 'ctx_old', status: 'completed', path })
    r = notify('--dry-run')
    assert.match(r.stdout, new RegExp(`ctx_old 에 이어 쓸 것: .*spec-conflict-7-${baseSha().slice(0, 8)}\\.md`))
    assert.deepEqual(sent(), [])
    assert.deepEqual(specFiles(), [])
    assert.equal(existsSync(stateFile()), false)
    assert.deepEqual(hookInputs(), [])
  })

  test('pr-conflict 가 1 로 끝나면 HOOK-FAIL 줄이 나고 종료 코드는 1 그대로다', () => {
    setupConflict()
    hook(1)
    const r = notify()
    assert.equal(r.code, 1, r.both)
    assert.match(r.stdout, /^HOOK-FAIL pr-conflict 1$/m)
    assert.equal(sent().length, 1)
  })

  test('충돌이 없으면 0 이다', () => {
    const other = branch('other', { 'd.txt': 'd\n' })
    prs([8, 'other', other.head])
    const r = notify()
    assert.equal(r.code, 0, r.both)
    assert.match(r.stdout, /충돌한 열린 PR 이 없다/)
  })

  test('gh 가 실패하면 2 다', () => {
    prs()
    env.GH_FAILS = '1'
    assert.equal(notify().code, 2)
  })
})
