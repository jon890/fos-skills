// cleanup-sweep.ts 를 실제 git 저장소와 가짜 gh, orca, lsof, ps, kill 로 본다. GitHub 와 Orca 에는 닿지 않는다.
//
// 가짜 실행 파일은 모든 테스트가 함께 쓰고(macOS 의 첫 실행 검사를 테스트마다 치르지 않게 한다), 상태와 호출 기록은
// 테스트마다 따로 둔다. 가짜는 FAKE_STATE 의 JSON 을 읽어 답하고 FAKE_LOG 에 `<이름> <인자>` 한 줄을 더한다.
// 프로세스의 pid 가 SWEEP 이면 cleanup-sweep.ts 자신이다. lsof 와 ps 가짜는 그 명령이 바로 띄우므로 부모 pid 가 곧 그 pid 다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, before, beforeEach, afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/cleanup-sweep.ts', import.meta.url))
const SHIM = fileURLToPath(new URL('../scripts/cleanup-sweep.py', import.meta.url))
const REMOVE = fileURLToPath(new URL('../scripts/remove-worktree.ts', import.meta.url))
const HOOK = 'node /x/oh-my-claudecode/dist/hooks/session-end/worker.js --omc-session-end-worker {}'

type Row = Record<string, unknown>
type Proc = { pid: number | 'SWEEP'; ppid?: number; cwd: string; command: string; terminal?: string; ignores?: string[] }
type Shell = { handle: string; path: string; processes: Proc[] }

let bin: string
let tmp: string
let repo: string
let wts: string
let logFile: string
let hookLog: string
let env: NodeJS.ProcessEnv

// 테스트마다 새로 두는 가짜의 상태. save 가 FAKE_STATE 로 옮긴다
let prs: Record<string, unknown[]>
let workers: Row[]
let terminals: Row[]
let held: string[]
let allWorkers: Row[]
let scope: string
let processes: Proc[]
let spawnOnRelease: Shell | null
let ghRaw: Record<string, string>
let openBases: string[]
let orcaFail: boolean
let ghFail: boolean
let closeNoop: boolean
let tasks: Row[]
let tasksFail: boolean
let prCommits: Record<string, string[]>
// Run 마다 worker 행. null 이면 run-list 가 실패하고 worker-list --run 은 workers 를 준다
let runs: Record<string, Row[] | null> | null
let pageSize: number
// --remote-branches 가 읽는 닫힌 PR. author 로 가짜가 고른다
let closedPrs: Row[]
// gh api user 가 줄 로그인. 빈 값이면 그 조회가 실패한다
let ghUser: string
// --head 조회의 PR 작성자. 브랜치 이름에서 로그인으로
let prAuthors: Record<string, string>
let openHeads: string[]
// gh 인자를 이은 문자열에 이 조각이 들면 그 호출이 실패한다
let ghFailOn: string[]

const FAKE_HEAD = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_STATE
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
const a = process.argv.slice(2)
const save = () => fs.writeFileSync(file, JSON.stringify(st))
const has = (...xs) => xs.every((x, i) => a[i] === x)
`

const FAKES: Record<string, string> = {
  gh: `if (st.gh_fail) process.exit(1)
if (st.gh_fail_on.some((part) => a.join(' ').includes(part))) process.exit(1)
if (has('repo', 'view')) {
  console.log(JSON.stringify({ url: 'https://github.example/owner/repo' }))
} else if (has('api', 'user')) {
  if (!st.gh_user) process.exit(1)
  console.log(st.gh_user)
} else if (has('pr', 'list') && a.includes('--head')) {
  const b = a[a.indexOf('--head') + 1]
  const p = st.prs[b]
  const author = b in st.pr_authors ? { login: st.pr_authors[b] } : undefined
  if (b in st.gh_raw) console.log(st.gh_raw[b])
  else console.log(JSON.stringify(p ? [{ number: 1, state: p[0], headRefOid: p[1], headRefName: b, isCrossRepository: p.length > 2 && p[2], author }] : []))
} else if (has('pr', 'list') && a.includes('--base')) {
  console.log(st.open_bases.includes(a[a.indexOf('--base') + 1]) ? 1 : 0)
} else if (has('pr', 'list') && a.includes('--author')) {
  // 닫힌 PR 목록. 작성자 필드는 판정 입력이 아니라 이 가짜가 고르는 데만 쓴다
  const who = a[a.indexOf('--author') + 1]
  console.log(JSON.stringify(st.closed_prs.filter((p) => p.author === who).map(({ author, ...rest }) => rest)))
} else if (has('pr', 'list') && a[a.indexOf('--state') + 1] === 'open') {
  const rows = [...st.open_bases.map((b) => ({ baseRefName: b, headRefName: 'open-head' })), ...st.open_heads.map((h) => ({ baseRefName: 'main', headRefName: h }))]
  console.log(JSON.stringify(rows))
} else if (has('pr', 'view') && a[2] in st.pr_commits) {
  console.log(JSON.stringify({ commits: st.pr_commits[a[2]].map((oid) => ({ oid })) }))
}
`,
  orca: `if (st.orca_fail) process.exit(1)
const out = (x) => console.log(JSON.stringify(x))
const page = () => {
  const at = a.includes('--cursor') ? Number(a[a.indexOf('--cursor') + 1]) : 0
  return [at, st.page_size]
}
if (has('terminal', 'list')) {
  out({ result: { terminals: st.terminals } })
} else if (has('orchestration', 'worker-list') && !a.includes('--run')) {
  // 모든 Run 범위 조회. 묶인 터미널 handle 이 넘어오면 범위가 그 Run 으로 좁혀진다
  const source = process.env.ORCA_TERMINAL_HANDLE ? 'bound' : st.scope || 'all'
  for (const row of st.all_workers) {
    if (!('resource' in row)) row.resource = { ownershipState: 'owned' }
    if (!('terminalState' in row)) row.terminalState = 'active'
  }
  out({ result: { workers: st.all_workers, scope: { source }, page: { nextCursor: null } } })
} else if (has('orchestration', 'run-list') && st.runs != null) {
  // st.page_size 개씩 나눠 cursor 로 잇는다
  const [at, size] = page()
  const ids = Object.keys(st.runs)
  const more = at + size < ids.length
  out({ result: { runs: ids.slice(at, at + size).map((id) => ({ id })), nextCursor: more ? String(at + size) : null } })
} else if (has('orchestration', 'task-list') && st.tasks_fail) {
  process.exit(1)
} else if (has('orchestration', 'task-list')) {
  out({ result: { tasks: st.tasks || [] } })
} else if (has('orchestration', 'worker-list')) {
  const run = a[a.indexOf('--run') + 1]
  if (st.runs != null && st.runs[run] == null) process.exit(1)
  const rows = st.runs == null ? st.workers : st.runs[run]
  for (const row of rows) {
    if (!('runId' in row)) row.runId = run
    if (!('resource' in row)) row.resource = {}
    if (!('ownershipState' in row.resource)) row.resource.ownershipState = 'owned'
    if (!('terminalState' in row)) row.terminalState = 'active'
  }
  const [at, size] = page()
  const more = at + size < rows.length
  out({ result: { workers: rows.slice(at, at + size), scope: { source: 'flag', run }, page: { nextCursor: more ? String(at + size) : null, hasMore: more } } })
} else if (has('terminal', 'close') && st.close_noop) {
  out({ ok: true, result: {} })
} else if (has('terminal', 'close')) {
  const h = a[a.indexOf('--terminal') + 1]
  st.terminals = st.terminals.filter((t) => t.handle !== h)
  st.processes = st.processes.filter((q) => q.terminal !== h)
  save()
  out({ ok: true, result: {} })
} else if (has('orchestration', 'worker-release') && st.spawn_on_release) {
  // worker 를 반납하면 Orca 가 그 워크트리에 빈 셸 터미널을 띄운다
  const sp = st.spawn_on_release
  st.spawn_on_release = null
  st.terminals.push({ handle: sp.handle, worktreePath: sp.path })
  st.processes.push(...sp.processes)
  save()
  out({ ok: true, result: {} })
} else {
  out({ ok: true, result: {} })
}
`,
  lsof: `for (const q of st.processes) console.log('p' + (q.pid === 'SWEEP' ? process.ppid : q.pid) + '\\nn' + q.cwd)
`,
  ps: `for (const q of st.processes) console.log((q.pid === 'SWEEP' ? process.ppid : q.pid) + ' ' + (q.ppid ?? 1) + ' ' + q.command)
`,
  // 신호를 받은 프로세스를 지운다. ignores 에 든 신호는 무시한다(로그인 셸은 TERM 을 무시한다)
  kill: `const sig = a[0].replace(/^-+/, '')
st.processes = st.processes.filter((q) => !a.slice(1).includes(String(q.pid)) || (q.ignores || []).includes(sig))
save()
`,
}

before(() => {
  bin = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-sweep-bin-')))
  for (const [name, body] of Object.entries(FAKES)) {
    const head = FAKE_HEAD + `fs.appendFileSync(process.env.FAKE_LOG, ['${name}', ...a].join(' ') + '\\n')\n`
    writeFileSync(join(bin, name), head + body)
    chmodSync(join(bin, name), 0o755)
  }
})

after(() => rmSync(bin, { recursive: true, force: true }))

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-sweep-')))
  logFile = join(tmp, 'calls.log')
  hookLog = join(tmp, 'hooks.jsonl')
  env = {
    ...process.env,
    // 가짜 실행 파일은 PATH 의 node 로 돈다. 이 테스트의 node 폴더를 가짜 다음에 둔다
    PATH: [bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    FAKE_STATE: join(tmp, 'state.json'),
    FAKE_LOG: logFile,
    HOOK_LOG: hookLog,
    ORCA: join(bin, 'orca'),
    GH: join(bin, 'gh'),
    ORCH_KILL: join(bin, 'kill'),
  }
  // Orca 터미널에서 돌려도 가짜 orca 가 bound 범위로 답하지 않게 한다. bound 는 테스트가 직접 켠다.
  // orch 루트와 hook 대기 시간도 테스트가 정한다
  delete env.ORCA_TERMINAL_HANDLE
  delete env.ORCH_DIR
  delete env.ORCH_HOOK_WAIT
  prs = {}
  workers = []
  terminals = []
  held = []
  allWorkers = []
  scope = 'all'
  processes = []
  spawnOnRelease = null
  ghRaw = {}
  openBases = []
  orcaFail = false
  ghFail = false
  closeNoop = false
  tasks = []
  tasksFail = false
  prCommits = {}
  runs = null
  pageSize = 100
  closedPrs = []
  ghUser = ''
  prAuthors = {}
  openHeads = []
  ghFailOn = []
  repo = makeRepo('repo')
  wts = join(tmp, 'wts')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function sh(cmd: string, ...args: string[]): string {
  const done = spawnSync(cmd, args, { env, encoding: 'utf8' })
  assert.equal(done.status, 0, `${cmd} ${args.join(' ')} 실패: ${done.stderr}`)
  return done.stdout.trim()
}

function git(...args: string[]): string {
  return sh('git', ...args)
}

function makeRepo(name: string): string {
  const origin = join(tmp, `${name}-origin.git`)
  const dir = join(tmp, name)
  git('init', '-q', '--bare', '-b', 'main', origin)
  git('clone', '-q', origin, dir)
  git('-C', dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  git('-C', dir, 'push', '-q', '-u', 'origin', 'main')
  return dir
}

function save(): void {
  writeFileSync(
    join(tmp, 'state.json'),
    JSON.stringify({
      prs,
      workers,
      terminals,
      processes: [...processes, ...held.map((cwd, i) => ({ pid: 900 + i, cwd, command: 'node server.js' }))],
      spawn_on_release: spawnOnRelease,
      gh_raw: ghRaw,
      open_bases: openBases,
      all_workers: allWorkers,
      scope,
      orca_fail: orcaFail,
      gh_fail: ghFail,
      close_noop: closeNoop,
      tasks,
      tasks_fail: tasksFail,
      pr_commits: prCommits,
      runs,
      page_size: pageSize,
      closed_prs: closedPrs,
      gh_user: ghUser,
      pr_authors: prAuthors,
      open_heads: openHeads,
      gh_fail_on: ghFailOn,
    }),
  )
}

function worktree(name: string, opts: { push?: boolean; commits?: number; repo?: string } = {}): string {
  const target = opts.repo ?? repo
  const path = join(wts, name)
  git('-C', target, 'worktree', 'add', '-q', '-b', name, path, 'origin/main')
  for (let i = 0; i < (opts.commits ?? 1); i++) {
    writeFileSync(join(path, `${name.replaceAll('/', '-')}${i}.txt`), name)
    git('-C', path, 'add', '-A')
    git('-C', path, 'commit', '-q', '-m', `${name} ${i}`)
  }
  if (opts.push ?? true) git('-C', path, 'push', '-q', '-u', 'origin', name)
  return path
}

// 원격에서 squash 머지하고 브랜치를 지운 것처럼 만든다. 로컬 커밋은 원격 어디에도 없게 된다.
function squashMerge(name: string, path: string): string {
  const head = git('-C', path, 'rev-parse', 'HEAD')
  git('-C', repo, 'push', '-q', 'origin', '--delete', name)
  prs[name] = ['MERGED', head]
  return head
}

type Swept = { stdout: string; stderr: string }

function runSweepFull(args: string[] = [], opts: { code?: number; repos?: string[] } = {}): Swept {
  save()
  const flags = (opts.repos ?? [repo]).flatMap((r) => ['--repo', r])
  const done = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', SCRIPT, ...flags, '--wait', '0.01', '--poll-interval', '0.01', ...args],
    { env, encoding: 'utf8' },
  )
  assert.equal(done.status, opts.code ?? 0, `종료 코드가 다르다\nstdout:\n${done.stdout}\nstderr:\n${done.stderr}`)
  return { stdout: done.stdout, stderr: done.stderr }
}

function runSweep(args: string[] = [], opts: { code?: number; repos?: string[] } = {}): string {
  return runSweepFull(args, opts).stdout
}

function branches(): Set<string> {
  return new Set(git('-C', repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean))
}

function remoteBranches(): Set<string> {
  const refs = git('-C', repo, 'ls-remote', '--heads', 'origin').split(/\s+/).filter(Boolean)
  return new Set(refs.filter((_, i) => i % 2 === 1).map((ref) => ref.replace(/^refs\/heads\//, '')))
}

function calls(): string {
  return existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
}

function sweepCalls(needle: string): string[] {
  return calls()
    .split('\n')
    .filter((line) => line.includes(needle))
}

function has(text: string, part: string): void {
  assert.ok(text.includes(part), `「${part}」 가 없다:\n${text}`)
}

function lacks(text: string, part: string): void {
  assert.ok(!text.includes(part), `「${part}」 가 있으면 안 된다:\n${text}`)
}

function exists(path: string, out: string): void {
  assert.ok(existsSync(path), `${path} 가 남아 있어야 한다:\n${out}`)
}

function gone(path: string, out: string): void {
  assert.ok(!existsSync(path), `${path} 가 지워져야 한다:\n${out}`)
}

// 막 만든 브랜치. base 와 같고 커밋 0 이며 upstream 이 gone 이라 cherry 판정을 통과한다.
function freshGoneBranch(name: string): string {
  const path = worktree(name, { commits: 0 })
  git('-C', repo, 'push', '-q', 'origin', '--delete', name)
  return path
}

function mergedWorkerWithTerminal(name: string, state: string, status: string): string {
  const path = worktree(name)
  squashMerge(name, path)
  workers = [{ dispatchId: 'ctx_s', workerState: state, dispatchStatus: status, agentTerminalHandle: 'term_s', resource: { worktreeId: `x::${path}` } }]
  terminals = [{ handle: 'term_s', worktreePath: path }]
  return path
}

describe('머지 판정과 기본 정리', () => {
  test('squash 머지된 worktree 를 터미널, dispatch, 지시서와 함께 정리한다', () => {
    const path = worktree('feat-a')
    squashMerge('feat-a', path)
    terminals = [{ handle: 'term_a', worktreePath: path }]
    workers = [{ dispatchId: 'ctx_a', workerState: 'succeeded', resource: { worktreeId: `x::${path}`, releaseState: 'retained' } }]
    const specs = join(repo, '.orch/specs')
    mkdirSync(specs, { recursive: true })
    writeFileSync(join(specs, 'spec-feat-a.md'), 'x')
    writeFileSync(join(specs, 'spec-other.md'), 'x')
    const out = runSweep(['--run', 'run_x', '--specs-dir', '.orch/specs', '--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-a'))
    assert.ok(!existsSync(join(specs, 'spec-feat-a.md')))
    assert.ok(existsSync(join(specs, 'spec-other.md')))
    has(calls(), 'orca terminal close --terminal term_a')
    has(calls(), 'orca orchestration worker-release --dispatch ctx_a')
  })

  test('dry-run 은 아무것도 바꾸지 않는다', () => {
    const path = worktree('feat-a')
    squashMerge('feat-a', path)
    const out = runSweep()
    has(out, '정리')
    exists(path, out)
    assert.ok(branches().has('feat-a'))
  })

  test('OPEN PR 의 worktree 는 남긴다', () => {
    const path = worktree('feat-b')
    prs['feat-b'] = ['OPEN', git('-C', path, 'rev-parse', 'HEAD')]
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '남김')
    assert.ok(remoteBranches().has('feat-b'))
  })

  test('커밋 안 된 변경이 있는 worktree 는 건너뛴다', () => {
    const path = worktree('feat-c')
    squashMerge('feat-c', path)
    writeFileSync(join(path, 'new.txt'), 'x')
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '커밋 안 된 변경')
  })

  test('머지된 PR HEAD 뒤에 커밋이 더해진 worktree 는 남긴다', () => {
    const path = worktree('feat-d')
    squashMerge('feat-d', path)
    writeFileSync(join(path, 'later.txt'), 'x')
    git('-C', path, 'add', '-A')
    git('-C', path, 'commit', '-q', '-m', 'later')
    const out = runSweep(['--apply'])
    exists(path, out)
    // 끝 커밋이 PR HEAD 의 조상이 아니므로 그 PR 의 브랜치로 보지 않고, base 에 없는 커밋이 있어 남긴다
    has(out, '남김')
    assert.ok(branches().has('feat-d'))
  })

  test('살아 있는 worker 의 worktree 는 건너뛴다', () => {
    const path = worktree('feat-e')
    squashMerge('feat-e', path)
    workers = [{ dispatchId: 'ctx_e', workerState: 'working', resource: { worktreeId: `x::${path}` } }]
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '살아 있는 worker ctx_e')
  })

  test('프로세스가 쥔 경로는 다음 실행에서 다시 시도한다', () => {
    const path = worktree('feat-f')
    squashMerge('feat-f', path)
    held = [path]
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '다음 실행에서 다시 시도')
    held = []
    const again = runSweep(['--apply'])
    gone(path, again)
  })

  test('upstream 이 gone 이고 커밋이 base 에 있으면 PR 없이도 정리한다', () => {
    const path = worktree('feat-g')
    git('-C', repo, 'merge', '-q', '--no-ff', '-m', 'merge g', 'feat-g')
    git('-C', repo, 'push', '-q', 'origin', 'main')
    git('-C', repo, 'push', '-q', 'origin', '--delete', 'feat-g')
    const out = runSweep(['--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-g'))
  })

  test('upstream 이 gone 이어도 base 에 없는 커밋이 있으면 남긴다', () => {
    const path = worktree('feat-h')
    git('-C', repo, 'push', '-q', 'origin', '--delete', 'feat-h')
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, 'base 에 없는 커밋 1 개')
  })

  test('worktree 없는 로컬 브랜치를 원격과 함께 지운다', () => {
    const path = worktree('feat-i')
    const head = git('-C', path, 'rev-parse', 'HEAD')
    git('-C', repo, 'worktree', 'remove', path)
    prs['feat-i'] = ['MERGED', head]
    const out = runSweep(['--apply'])
    assert.ok(!branches().has('feat-i'), out)
    assert.ok(!remoteBranches().has('feat-i'))
  })

  test('release 브랜치는 건드리지 않는다', () => {
    const path = worktree('release/1.0')
    squashMerge('release/1.0', path)
    const out = runSweep(['--apply'])
    exists(path, out)
  })

  test('cherry 로 판정한 브랜치는 succeeded dispatch 의 터미널이 살아 있으면 살아 있는 worker 다', () => {
    const path = freshGoneBranch('prompt-fix')
    workers = [{ dispatchId: 'ctx_p', workerState: 'succeeded', agentTerminalHandle: 'term_p', resource: { worktreeId: `x::${path}` } }]
    terminals = [{ handle: 'term_p', worktreePath: path }]
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '살아 있는 worker ctx_p')
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
  })

  test('PR 이 MERGED 이고 worker 가 끝났으면 남은 터미널을 닫고 정리한다', () => {
    const path = mergedWorkerWithTerminal('sensor-fail', 'succeeded', 'completed')
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    has(calls(), 'terminal close --terminal term_s')
  })

  test('PR 이 MERGED 여도 working worker 의 worktree 는 남긴다', () => {
    const path = mergedWorkerWithTerminal('sensor-busy', 'working', 'dispatched')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '살아 있는 worker ctx_s')
    lacks(calls(), 'terminal close')
  })

  test('cherry 로 판정한 브랜치는 completed dispatch 의 터미널이 있으면 남긴다', () => {
    const path = freshGoneBranch('fresh-done')
    workers = [{ dispatchId: 'ctx_s', workerState: 'succeeded', dispatchStatus: 'completed', agentTerminalHandle: 'term_s', resource: { worktreeId: `x::${path}` } }]
    terminals = [{ handle: 'term_s', worktreePath: path }]
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '살아 있는 worker ctx_s')
    lacks(calls(), 'terminal close')
  })
})

// 머지 큐가 원격 PR 에 base 를 합치고(update-branch), 저장소가 merge commit 으로 머지한 상태를 만든다.
// PR HEAD 는 원격의 머지 커밋이라 로컬 브랜치 끝 커밋보다 앞서 가고, 머지 뒤 로컬 커밋은 모두 base 에 들어간다.
function updateBranchThenMergeCommit(name: string, path: string): void {
  const tip = git('-C', path, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'other.txt'), 'x')
  git('-C', repo, 'add', '-A')
  git('-C', repo, 'commit', '-q', '-m', 'base moved')
  git('-C', repo, 'push', '-q', 'origin', 'main')
  const other = join(tmp, 'queue-clone')
  git('clone', '-q', '-b', name, join(tmp, 'repo-origin.git'), other)
  git('-C', other, 'merge', '-q', '--no-ff', '-m', 'update branch', 'origin/main')
  git('-C', other, 'push', '-q', 'origin', name)
  const head = git('-C', other, 'rev-parse', 'HEAD')
  git('-C', repo, 'fetch', '-q', 'origin')
  git('-C', repo, 'merge', '-q', '--no-ff', '-m', 'merge pr', `origin/${name}`)
  git('-C', repo, 'push', '-q', 'origin', 'main')
  git('-C', repo, 'push', '-q', 'origin', '--delete', name)
  prs[name] = ['MERGED', head]
  prCommits['1'] = [tip, head]
  assert.equal(git('-C', repo, 'rev-list', '--count', `origin/main..${name}`), '0')
}

describe('PR 커밋 목록으로 브랜치 인정', () => {
  const finished = (path: string) => {
    workers = [{ dispatchId: 'ctx_s', workerState: 'succeeded', dispatchStatus: 'completed', agentTerminalHandle: 'term_s', resource: { worktreeId: `x::${path}` } }]
    terminals = [{ handle: 'term_s', worktreePath: path }]
  }

  test('update-branch 뒤 merge commit 으로 머지된 브랜치를 PR 커밋 목록으로 알아본다', () => {
    const path = worktree('feat-um')
    updateBranchThenMergeCommit('feat-um', path)
    finished(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    has(out, 'PR MERGED')
    gone(path, out)
    has(calls(), 'terminal close --terminal term_s')
    assert.ok(!branches().has('feat-um'))
  })

  test('옛 같은 이름 PR 이 있는 막 만든 브랜치는 알아보지 않는다', () => {
    const path = freshGoneBranch('feat-fresh')
    const oldHead = '0'.repeat(40)
    prs['feat-fresh'] = ['MERGED', oldHead]
    prCommits['1'] = [oldHead]
    finished(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '살아 있는 worker ctx_s')
    has(calls(), 'pr view 1 --json commits')
    lacks(calls(), 'terminal close')
  })

  test('PR 커밋 목록을 읽지 못하면 막 만든 브랜치를 남긴다', () => {
    const path = freshGoneBranch('feat-fresh2')
    prs['feat-fresh2'] = ['MERGED', '0'.repeat(40)]
    finished(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
  })

  test('끝 커밋이 PR HEAD 와 같으면 커밋 목록을 읽지 않고 알아본다', () => {
    const path = mergedWorkerWithTerminal('feat-same', 'succeeded', 'completed')
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    has(calls(), 'terminal close --terminal term_s')
    lacks(calls(), 'pr view')
  })
})

// 머지된 워크트리에 다른 Run 의 worker 터미널이 붙어 있다. 이 Run 은 그 worker 를 모른다.
function foreignTerminalAt(name: string): string {
  const path = worktree(name)
  squashMerge(name, path)
  terminals = [{ handle: 'term_codex', worktreePath: path }]
  allWorkers = [{ runId: 'run_other', dispatchId: 'ctx_o', agentTerminalHandle: 'term_codex' }]
  return path
}

// 코디네이터 터미널에서 부른다. 범위 없는 worker-list 는 bound 만 주고, Run 은 run-list 로 하나씩 읽는다.
function boundToCoordinator(ownPath: string, other: Row[] = []): void {
  env.ORCA_TERMINAL_HANDLE = 'term_coordinator'
  pageSize = 1
  const own = { dispatchId: 'ctx_a', workerState: 'succeeded', agentTerminalHandle: 'term_mine', resource: { worktreeId: `x::${ownPath}`, terminalHandle: 'term_mine' } }
  workers = [own]
  runs = { run_x: [own, { dispatchId: 'ctx_old', workerState: 'succeeded' }], run_other: other, run_idle: [] }
}

describe('다른 Run 의 터미널', () => {
  test('다른 Run 의 터미널은 닫지 않는다', () => {
    const path = foreignTerminalAt('feat-o1')
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    exists(path, out)
    has(out, '다른 Run 의 worker 터미널 term_codex')
    lacks(calls(), 'terminal close')
    assert.ok(branches().has('feat-o1'))
  })

  test('다른 곳의 다른 Run worker 는 이 경로를 막지 않는다', () => {
    const path = foreignTerminalAt('feat-o2')
    allWorkers.push({ runId: 'run_x', dispatchId: 'ctx_a', agentTerminalHandle: 'term_mine' })
    terminals = [
      { handle: 'term_mine', worktreePath: path },
      { handle: 'term_codex', worktreePath: join(tmp, 'elsewhere') },
    ]
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    has(calls(), 'orca terminal close --terminal term_mine')
    lacks(calls(), '--terminal term_codex')
  })

  test('bound 범위면 Run 마다 읽어 정리하되 정리 한 번에 한 번만 읽는다', () => {
    const path = worktree('feat-b1')
    squashMerge('feat-b1', path)
    terminals = [
      { handle: 'term_mine', worktreePath: path },
      { handle: 'term_codex', worktreePath: join(tmp, 'elsewhere') },
    ]
    boundToCoordinator(path, [{ dispatchId: 'ctx_o', agentTerminalHandle: 'term_codex' }])
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    lacks(out, '터미널 소유 상태 조회 실패')
    has(calls(), 'orca terminal close --terminal term_mine')
    // Run 목록과 Run 마다의 페이지를 끝까지 따라가되, 정리 한 번에 한 번만 읽는다
    assert.equal(sweepCalls('run-list').length, 3, calls())
    assert.equal(sweepCalls('--run run_other').length, 1, calls())
  })

  test('bound 범위에서도 다른 Run 의 터미널은 남긴다', () => {
    const path = worktree('feat-b2')
    squashMerge('feat-b2', path)
    terminals = [{ handle: 'term_codex', worktreePath: path }]
    boundToCoordinator(path, [{ dispatchId: 'ctx_o', agentTerminalHandle: 'term_codex' }])
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '다른 Run 의 worker 터미널 term_codex')
    lacks(calls(), 'terminal close')
  })

  test('bound 범위에서 다른 Run 의 사용자 보유 터미널은 남긴다', () => {
    const path = worktree('feat-b3')
    squashMerge('feat-b3', path)
    terminals = [{ handle: 'term_user', worktreePath: path }]
    boundToCoordinator(path, [
      { dispatchId: 'ctx_o', agentTerminalHandle: 'term_user', terminalState: 'retained', resource: { terminalHandle: 'term_user', ownershipState: 'user_owned' } },
    ])
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '남김: 사용자 보유 터미널')
    lacks(calls(), 'terminal close')
  })

  test('bound 범위에서 Run 하나를 읽지 못하면 경로를 남긴다', () => {
    const path = worktree('feat-b4')
    squashMerge('feat-b4', path)
    terminals = [{ handle: 'term_mine', worktreePath: path }]
    boundToCoordinator(path)
    ;(runs as Record<string, Row[] | null>).run_other = null
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })

  test('Run 목록을 읽지 못하면 모르는 터미널을 남긴다', () => {
    const path = foreignTerminalAt('feat-o3')
    scope = 'bound'
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })

  test('--run 이 없으면 예전처럼 경로로 터미널을 찾는다', () => {
    const path = foreignTerminalAt('feat-o5')
    const out = runSweep(['--apply'])
    gone(path, out)
    has(calls(), 'orca terminal close --terminal term_codex')
    has(calls(), 'worker-list --limit 100')
  })

  test('PR 이 MERGED 가 아니면 터미널을 닫지 않는다', () => {
    const path = freshGoneBranch('fresh')
    terminals = [{ handle: 'term_f', worktreePath: path }]
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '살아 있는 터미널')
    lacks(calls(), 'terminal close')
  })

  test('터미널 목록을 읽지 못하면 아무것도 건드리지 않고 2 로 끝난다', () => {
    const path = worktree('feat-x')
    squashMerge('feat-x', path)
    orcaFail = true
    runSweep(['--apply'], { code: 2 })
    assert.ok(existsSync(path))
  })
})

// 로컬 브랜치 이름과 원격 브랜치 이름이 다른 worktree. 원격 브랜치는 그대로 둔다.
function renamedWorktree(local: string, remote: string, track = true, target = repo): string {
  const path = worktree(local, { push: false, repo: target })
  git('-C', path, 'push', '-q', ...(track ? ['-u'] : []), 'origin', `${local}:${remote}`)
  return path
}

describe('PR 찾기', () => {
  test('PR HEAD 가 worktree HEAD 보다 앞서면 받아 와 merged-head 로 넘긴다', () => {
    const path = worktree('feat-j')
    const other = join(tmp, 'other')
    git('clone', '-q', '-b', 'feat-j', join(tmp, 'repo-origin.git'), other)
    writeFileSync(join(other, 'update.txt'), 'x')
    git('-C', other, 'add', '-A')
    git('-C', other, 'commit', '-q', '-m', 'Merge branch main into feat-j')
    const ahead = git('-C', other, 'rev-parse', 'HEAD')
    git('-C', other, 'push', '-q', 'origin', `${ahead}:refs/pull/1/head`)
    git('-C', other, 'push', '-q', 'origin', ':feat-j')
    prs['feat-j'] = ['MERGED', ahead]
    assert.notEqual(git('-C', path, 'rev-parse', 'HEAD'), ahead)
    const out = runSweep(['--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-j'))
  })

  test('upstream 이름으로 PR 을 찾고 원격 브랜치를 지운다', () => {
    const path = renamedWorktree('dev/proj-topic', 'proj/topic')
    prs['proj/topic'] = ['MERGED', git('-C', path, 'rev-parse', 'HEAD')]
    const out = runSweep(['--apply'])
    gone(path, out)
    assert.ok(!branches().has('dev/proj-topic'))
    assert.ok(!remoteBranches().has('proj/topic'))
    has(calls(), '--head proj/topic')
    lacks(calls(), '--head dev/proj-topic')
  })

  test('upstream 이 없으면 이름 변형으로 PR 을 찾는다', () => {
    const path = renamedWorktree('dev/proj-topic', 'proj/topic', false)
    git('-C', repo, 'push', '-q', 'origin', '--delete', 'proj/topic')
    prs['proj/topic'] = ['MERGED', git('-C', path, 'rev-parse', 'HEAD')]
    const out = runSweep(['--apply'])
    gone(path, out)
  })

  test('브랜치를 담지 않은 이름 변형 PR 은 무시한다', () => {
    const path = worktree('dev/topic')
    prs.topic = ['MERGED', git('-C', repo, 'rev-parse', 'origin/main')]
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '남김')
  })

  test('새 커밋이 더해진 원격 브랜치는 남긴다', () => {
    const path = renamedWorktree('dev/proj-b', 'proj/b')
    const head = git('-C', path, 'rev-parse', 'HEAD')
    git('-C', repo, 'worktree', 'remove', path)
    const other = join(tmp, 'other')
    git('clone', '-q', '-b', 'proj/b', join(tmp, 'repo-origin.git'), other)
    writeFileSync(join(other, 'more.txt'), 'x')
    git('-C', other, 'add', '-A')
    git('-C', other, 'commit', '-q', '-m', 'more')
    git('-C', other, 'push', '-q', 'origin', 'proj/b')
    prs['proj/b'] = ['MERGED', head]
    const out = runSweep(['--apply'])
    assert.ok(!branches().has('dev/proj-b'), out)
    assert.ok(remoteBranches().has('proj/b'))
    has(out, '끝점이 머지된 커밋과 다르다')
  })

  test('fork 에서 온 PR 은 맞지 않는다', () => {
    const path = worktree('feat-k')
    prs['feat-k'] = ['MERGED', git('-C', path, 'rev-parse', 'HEAD'), true]
    const out = runSweep(['--apply'])
    exists(path, out)
  })

  test('빈 PR 조회는 PR 없음이고 worktree 를 남긴다', () => {
    const path = worktree('feat-l')
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, 'PR 없음')
    assert.ok(remoteBranches().has('feat-l'))
  })

  test('null 글자 조회는 머지가 아니다', () => {
    const path = worktree('feat-m')
    for (const name of ['feat-m', 'feat/m']) ghRaw[name] = 'null'
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '조회 실패')
    assert.ok(branches().has('feat-m'))
  })

  test('gh 가 실패하면 worktree 와 브랜치를 남긴다', () => {
    const path = worktree('feat-n')
    ghFail = true
    runSweep(['--apply'])
    assert.ok(existsSync(path))
    assert.ok(branches().has('feat-n'))
  })
})

function idleShell(path: string, handle = 'term_shell', child = false): Shell {
  const shell: Proc = { pid: 501, ppid: 1, cwd: path, command: '-/bin/zsh -l', terminal: handle }
  const rows = [shell, ...(child ? [{ pid: 502, ppid: 501, cwd: path, command: 'sleep 100' }] : [])]
  return { handle, path, processes: rows }
}

function releasedWorkerWithShell(name: string, child = false): string {
  const path = worktree(name)
  squashMerge(name, path)
  workers = [{ dispatchId: 'ctx_w', workerState: 'succeeded', resource: { worktreeId: `x::${path}`, releaseState: 'retained' } }]
  spawnOnRelease = idleShell(path, 'term_shell', child)
  return path
}

// 코디네이터가 끝난 worker 터미널을 닫자 Orca 가 그 탭에 빈 셸을 다시 열었다. 모든 Run 범위는 읽지 못한다.
function reopenedShell(name: string, opts: { child?: boolean; agent?: string; scope?: string } = {}): string {
  const path = worktree(name)
  squashMerge(name, path)
  workers = [{ dispatchId: 'ctx_w', workerState: 'succeeded', dispatchStatus: 'completed', agentTerminalHandle: 'term_gone', resource: { worktreeId: `x::${path}` } }]
  const shell = idleShell(path)
  terminals = [{ handle: 'term_shell', worktreePath: path, ...(opts.agent ? { agentIdentity: opts.agent } : {}) }]
  processes = [...shell.processes, ...(opts.child ? [{ pid: 502, ppid: 501, cwd: path, command: 'sleep 100' }] : [])]
  scope = opts.scope ?? 'bound'
  return path
}

describe('Orca 가 worker 반납 뒤 띄운 빈 셸', () => {
  test('반납 뒤 남은 빈 셸 터미널을 닫고 worktree 를 지운다', () => {
    const path = releasedWorkerWithShell('feat-o')
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-o'))
    has(calls(), 'orca terminal close --terminal term_shell')
  })

  test('자식이 도는 셸은 닫지 않는다', () => {
    const path = releasedWorkerWithShell('feat-p', true)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
    has(out, '다음 실행에서 다시 시도')
  })

  test('다른 프로세스는 빈 셸로 보지 않는다', () => {
    const path = worktree('feat-q')
    squashMerge('feat-q', path)
    terminals = [{ handle: 'term_q', worktreePath: path }]
    processes = [{ pid: 601, ppid: 1, cwd: path, command: 'node server.js' }]
    const out = runSweep(['--apply'])
    exists(path, out)
    assert.equal(sweepCalls('terminal close').length, 1, calls())
    has(out, '다음 실행에서 다시 시도')
  })

  test('Orca 터미널 없는 빈 셸은 그대로 둔다', () => {
    const path = worktree('feat-r')
    squashMerge('feat-r', path)
    processes = idleShell(path).processes
    const out = runSweep(['--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
  })

  test('다시 열린 빈 셸도 모든 Run 을 읽지 못하면 남긴다', () => {
    const path = reopenedShell('feat-s1')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })

  test('자식 프로세스가 있는 다시 열린 셸은 건너뛴다', () => {
    const path = reopenedShell('feat-s2', { child: true })
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })

  test('에이전트가 있거나 다른 Run 의 터미널은 건너뛴다', () => {
    const path = reopenedShell('feat-s3', { agent: 'claude' })
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
    const other = reopenedShell('feat-s4', { scope: 'all' })
    allWorkers = [{ runId: 'run_other', dispatchId: 'ctx_o', agentTerminalHandle: 'term_shell' }]
    const again = runSweep(['--run', 'run_x', '--apply'])
    exists(other, again)
    has(again, '다른 Run 의 worker 터미널 term_shell')
    lacks(calls(), 'terminal close')
  })

  test('--apply 가 없으면 다시 열린 셸을 닫지 않는다', () => {
    const path = reopenedShell('feat-s5')
    const out = runSweep(['--run', 'run_x'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })
})

function finishedWorkerWithHolders(name: string, state = 'succeeded'): string {
  const path = worktree(name)
  squashMerge(name, path)
  workers = [{ dispatchId: 'ctx_k', workerState: state, agentTerminalHandle: 'term_gone', resource: { worktreeId: `x::${path}`, releaseState: 'released' } }]
  mkdirSync(join(path, 'sub'))
  processes = [
    { pid: 701, ppid: 1, cwd: path, command: 'claude --resume' },
    { pid: 702, ppid: 1, cwd: join(path, 'sub'), command: '-/bin/zsh -l', ignores: ['TERM'] },
    { pid: 703, ppid: 1, cwd: path, command: 'node plugin.js' },
    { pid: 709, ppid: 1, cwd: `${path}-other`, command: '-/bin/zsh -l' },
  ]
  return path
}

function killCalls(): string[] {
  return calls()
    .split('\n')
    .filter((line) => line.startsWith('kill '))
}

function remainingPids(): Set<unknown> {
  const st = JSON.parse(readFileSync(join(tmp, 'state.json'), 'utf8')) as { processes: Proc[] }
  return new Set(st.processes.map((q) => q.pid))
}

describe('worker 가 끝난 뒤에도 경로를 쥔 프로세스 (--kill-holders)', () => {
  test('끝난 worker 의 프로세스를 끄고 worktree 를 지운다', () => {
    const path = finishedWorkerWithHolders('feat-k1')
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-k1'))
    // TERM 을 무시한 로그인 셸에만 HUP 을 보낸다. 이름이 비슷한 다른 경로의 셸은 건드리지 않는다
    assert.deepEqual(killCalls(), ['kill -TERM 701 702 703', 'kill -HUP 702'])
    assert.deepEqual(remainingPids(), new Set([709]))
  })

  test('TERM 과 HUP 을 무시하면 KILL 까지 보낸다', () => {
    const path = finishedWorkerWithHolders('feat-k2')
    processes[0].ignores = ['TERM', 'HUP']
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    gone(path, out)
    assert.deepEqual(killCalls(), ['kill -TERM 701 702 703', 'kill -HUP 701 702', 'kill -KILL 701'])
  })

  test('Orca 가 띄운 프로세스만 끈다', () => {
    const path = finishedWorkerWithHolders('feat-k7')
    const helper = '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper'
    processes = [
      // Orca 터미널: Orca Helper → login → 로그인 셸 → claude
      { pid: 800, ppid: 1, cwd: '/', command: '/Applications/Orca.app/Contents/MacOS/Orca' },
      { pid: 801, ppid: 800, cwd: '/', command: helper },
      { pid: 802, ppid: 801, cwd: '/', command: '/usr/bin/login -fpl user /bin/zsh' },
      { pid: 803, ppid: 802, cwd: path, command: '-/bin/zsh -l' },
      { pid: 804, ppid: 803, cwd: path, command: 'claude' },
      // iTerm 에서 그 폴더로 들어간 사용자 셸과, 편집기가 띄운 language server
      { pid: 810, ppid: 1, cwd: '/', command: '/Applications/iTerm.app/Contents/MacOS/iTerm2' },
      { pid: 811, ppid: 810, cwd: '/', command: '/usr/bin/login -fpl user /bin/zsh' },
      { pid: 812, ppid: 811, cwd: path, command: '-/bin/zsh -l' },
      { pid: 820, ppid: 1, cwd: '/', command: '/Applications/Code.app/Contents/MacOS/Code' },
      { pid: 821, ppid: 820, cwd: path, command: 'node tsserver.js' },
    ]
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    exists(path, out)
    assert.deepEqual(killCalls(), ['kill -TERM 803 804'])
    has(out, 'Orca 밖에서 띄웠거나')
    const left = remainingPids()
    assert.ok(left.has(812) && left.has(821), `812 와 821 이 남아야 한다: ${[...left].join(', ')}`)
  })

  test('이 명령 자신과 안쪽 워크트리를 쓰는 프로세스는 끄지 않는다', () => {
    const path = worktree('feat-k8')
    writeFileSync(join(path, '.gitignore'), 'nested/\n')
    git('-C', path, 'add', '-A')
    git('-C', path, 'commit', '-q', '-m', 'ignore nested')
    git('-C', path, 'push', '-q')
    squashMerge('feat-k8', path)
    git('-C', repo, 'worktree', 'add', '-q', '-b', 'other-k8', join(path, 'nested'), 'origin/main')
    workers = [{ dispatchId: 'ctx_k', workerState: 'succeeded', agentTerminalHandle: 'term_gone', resource: { worktreeId: `x::${path}`, releaseState: 'released' } }]
    processes = [
      { pid: 'SWEEP', ppid: 1, cwd: path, command: 'node cleanup-sweep.ts' },
      { pid: 851, ppid: 1, cwd: join(path, 'nested'), command: 'claude' },
      { pid: 852, ppid: 1, cwd: path, command: 'node plugin.js' },
    ]
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    exists(path, out)
    assert.deepEqual(killCalls(), ['kill -TERM 852'])
    assert.ok(remainingPids().has(851))
    has(out, '다음 실행에서 다시 시도')
  })

  test('OMC session-end hook 만 남으면 remove-worktree 에 넘긴다', () => {
    // 건너뛰지 않고 remove-worktree.ts 에 넘긴다. 그 명령이 hook 이 끝날 때까지 기다린다
    const path = worktree('feat-h1')
    squashMerge('feat-h1', path)
    processes = [{ pid: 861, ppid: 1, cwd: path, command: HOOK }]
    env.ORCH_HOOK_WAIT = '0'
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, 'OMC session-end hook 861 은 끄지 않는다')
    has(out, 'session-end hook 861 는 스스로 끝난다')
    lacks(out, '다음 실행에서 다시 시도')
  })

  test('--kill-holders 도 session-end hook 은 끄지 않는다', () => {
    const path = finishedWorkerWithHolders('feat-h2')
    processes.push({ pid: 862, ppid: 1, cwd: path, command: HOOK })
    env.ORCH_HOOK_WAIT = '0'
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    exists(path, out)
    assert.ok(killCalls().every((line) => !line.includes('862')), killCalls().join('\n'))
    assert.ok(remainingPids().has(862))
  })

  test('옵션이 없으면 끄지 않는다', () => {
    const path = finishedWorkerWithHolders('feat-k3')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    assert.deepEqual(killCalls(), [])
    has(out, '다음 실행에서 다시 시도')
  })

  test('끝난 dispatch 를 모르면 끄지 않는다', () => {
    const path = finishedWorkerWithHolders('feat-k4')
    const out = runSweep(['--kill-holders', '--apply'])
    exists(path, out)
    has(out, '그 경로의 worker 를 모른다')
    for (const state of ['failed', 'abandoned']) {
      workers[0].workerState = state
      const again = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
      exists(path, again)
      has(again, '끝나지 않은 dispatch ctx_k')
    }
    assert.deepEqual(killCalls(), [])
  })

  test('그 경로에 Orca 터미널이 남아 있으면 끄지 않는다', () => {
    const path = finishedWorkerWithHolders('feat-k5')
    // 닫기 명령이 성공을 돌려줘도 터미널이 남은 경우를 흉내 낸다
    terminals = [{ handle: 'term_stuck', worktreePath: path }]
    closeNoop = true
    const out = runSweep(['--run', 'run_x', '--kill-holders', '--apply'])
    exists(path, out)
    has(out, 'Orca 터미널이 남아 있거나')
    assert.deepEqual(killCalls(), [])
  })

  test('dry-run 은 신호를 보내지 않는다', () => {
    const path = finishedWorkerWithHolders('feat-k6')
    // 실제 실행은 MERGED 면 이 터미널을 먼저 닫으므로 dry-run 도 끈다고 낸다
    terminals = [{ handle: 'term_k6', worktreePath: path }]
    const out = runSweep(['--run', 'run_x', '--kill-holders'])
    exists(path, out)
    has(out, 'TERM, HUP, KILL 순으로 끈다')
    assert.deepEqual(killCalls(), [])
  })
})

// 그 이름의 PR 이 예전에 squash 머지되고 브랜치와 워크트리가 지워진 상태. 옛 PR HEAD 를 돌려준다.
function oldMergedPr(name: string): string {
  const old = worktree(name)
  const head = squashMerge(name, old)
  git('-C', repo, 'worktree', 'remove', old)
  git('-C', repo, 'branch', '-D', name)
  const main = join(tmp, 'main-clone')
  git('clone', '-q', join(tmp, 'repo-origin.git'), main)
  writeFileSync(join(main, 'squash.txt'), name)
  git('-C', main, 'add', '-A')
  git('-C', main, 'commit', '-q', '-m', `squash ${name}`)
  git('-C', main, 'push', '-q', 'origin', 'main')
  git('-C', repo, 'fetch', '-q', 'origin')
  rmSync(main, { recursive: true, force: true })
  return head
}

describe('저장소 여러 개, 남은 브랜치, 이름만 같은 PR', () => {
  test('저장소 여러 개를 한 번에 정리한다', () => {
    const second = makeRepo('second')
    const a = worktree('feat-s1')
    const b = worktree('feat-s2', { repo: second })
    squashMerge('feat-s1', a)
    git('-C', second, 'push', '-q', 'origin', '--delete', 'feat-s2')
    prs['feat-s2'] = ['MERGED', git('-C', b, 'rev-parse', 'HEAD')]
    const out = runSweep(['--apply'], { repos: [repo, second] })
    gone(a, out)
    gone(b, out)
    has(out, second)
    assert.ok(calls().includes('terminal list'))
  })

  test('읽지 못한 저장소가 있어도 나머지를 정리하고 2 로 끝난다', () => {
    const a = worktree('feat-t')
    squashMerge('feat-t', a)
    const out = runSweep(['--apply'], { repos: [join(tmp, 'missing'), repo], code: 2 })
    gone(a, out)
  })

  test('worktree 없는 머지된 로컬 브랜치의 이름이 다른 원격 브랜치를 지운다', () => {
    const path = renamedWorktree('dev/proj-c', 'proj/c')
    const head = git('-C', path, 'rev-parse', 'HEAD')
    git('-C', repo, 'worktree', 'remove', path)
    prs['proj/c'] = ['MERGED', head]
    const out = runSweep(['--apply'])
    assert.ok(!branches().has('dev/proj-c'), out)
    assert.ok(!remoteBranches().has('proj/c'))
  })

  test('열린 PR 의 base 인 브랜치는 남긴다', () => {
    const path = worktree('feat-u')
    const head = git('-C', path, 'rev-parse', 'HEAD')
    git('-C', repo, 'worktree', 'remove', path)
    prs['feat-u'] = ['MERGED', head]
    openBases = ['feat-u']
    const out = runSweep(['--apply'])
    assert.ok(branches().has('feat-u'), out)
    assert.ok(remoteBranches().has('feat-u'))
  })

  test('옛 머지된 PR 과 이름이 같은 새 브랜치는 남긴다', () => {
    oldMergedPr('feature/x')
    const path = worktree('feature/x', { commits: 0 })
    const out = runSweep(['--apply'])
    exists(path, out)
    assert.ok(branches().has('feature/x'))
    assert.ok(remoteBranches().has('feature/x'))
    has(out, '이름만 같은 PR')
    lacks(calls(), '--merged-head')
  })

  test('자기 커밋이 있고 옛 PR 이름을 쓴 새 브랜치도 남긴다', () => {
    oldMergedPr('feature/x')
    const path = worktree('feature/x', { push: false })
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '이름만 같은 PR')
  })

  test('갱신하지 않은 base 에서 옛 PR 이름으로 만든 브랜치도 남긴다', () => {
    // 갱신하지 않은 base 에서 만든 브랜치의 끝 커밋은 옛 PR HEAD 의 조상이다. base 위 커밋이 0 개라 새 브랜치로 본다
    const stale = git('-C', repo, 'rev-parse', 'origin/main')
    oldMergedPr('feature/x')
    const path = join(wts, 'feature-x-new')
    git('-C', repo, 'worktree', 'add', '-q', '-b', 'feature/x', path, stale)
    const out = runSweep(['--apply'])
    exists(path, out)
    assert.ok(branches().has('feature/x'))
  })

  test('PR HEAD 가 브랜치 끝인 merge commit PR 은 정리한다', () => {
    // 일반 merge 는 브랜치 커밋이 base 에 들어가 base 위 커밋이 0 개가 된다. 끝 커밋이 PR HEAD 와 같으면 머지로 본다
    const path = worktree('feat-v')
    const head = git('-C', path, 'rev-parse', 'HEAD')
    git('-C', repo, 'merge', '-q', '--no-ff', '-m', 'merge v', 'feat-v')
    git('-C', repo, 'push', '-q', 'origin', 'main')
    prs['feat-v'] = ['MERGED', head]
    const out = runSweep(['--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-v'))
  })

  test('remove-worktree 는 HEAD 가 merged-head 의 조상이 아니면 거부한다', () => {
    const head = oldMergedPr('feature/x')
    const path = worktree('feature/x', { commits: 0 })
    save()
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', REMOVE, path, '--delete-branch', '--merged-head', head], {
      env,
      encoding: 'utf8',
    })
    assert.equal(done.status, 1, done.stdout + done.stderr)
    has(done.stdout, '조상도 아니다')
    assert.ok(existsSync(path))
  })
})

// 임시 폴더에 만든 detached 워크트리. push 가 false 면 HEAD 가 원격에 없는 커밋이다.
function detached(name: string, push = true): string {
  const path = join(tmp, 'scratch', name)
  git('-C', repo, 'worktree', 'add', '-q', '--detach', path, 'origin/main')
  if (!push) git('-C', path, 'commit', '-q', '--allow-empty', '-m', 'local only')
  return path
}

describe('저장소 밖 detached 워크트리', () => {
  test('저장소 밖 detached 워크트리를 지운다', () => {
    const path = detached('baseline')
    const out = runSweep(['--apply'])
    gone(path, out)
    has(out, 'detached 워크트리 삭제')
    lacks(git('-C', repo, 'worktree', 'list'), path)
  })

  test('dry-run 은 남긴다', () => {
    const path = detached('baseline-dry')
    const out = runSweep()
    exists(path, out)
    has(out, 'detached 워크트리를 지울 것')
  })

  test('변경, 프로세스, 터미널, 로컬 커밋이 있으면 남긴다', () => {
    const dirtyPath = detached('d-dirty')
    writeFileSync(join(dirtyPath, 'x.txt'), 'x')
    const heldPath = detached('d-held')
    held = [heldPath]
    const termPath = detached('d-term')
    terminals = [{ handle: 'term_d', worktreePath: termPath }]
    const localPath = detached('d-local', false)
    const out = runSweep(['--apply'])
    for (const path of [dirtyPath, heldPath, termPath, localPath]) exists(path, out)
    has(out, `건너뜀 detached ${dirtyPath}: 커밋 안 된 변경`)
    has(out, `건너뜀 detached ${heldPath}: 그 경로를 쓰는 프로세스`)
    has(out, `건너뜀 detached ${termPath}: Orca 터미널이 있다`)
    has(out, `건너뜀 detached ${localPath}: HEAD 가 원격에 없다`)
  })

  test('저장소 안의 detached 워크트리는 그대로 둔다', () => {
    const path = join(repo, 'worktrees', 'repo', 'tmp-check')
    git('-C', repo, 'worktree', 'add', '-q', '--detach', path, 'origin/main')
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '브랜치가 없다(detached)')
  })

  test('지워진 폴더의 등록을 먼저 prune 한다', () => {
    const path = detached('gone')
    rmSync(path, { recursive: true, force: true })
    const dry = runSweep()
    has(dry, 'prune: Removing worktrees/gone')
    has(git('-C', repo, 'worktree', 'list'), path)
    const out = runSweep(['--apply'])
    has(out, 'prune: Removing worktrees/gone')
    lacks(git('-C', repo, 'worktree', 'list'), path)
  })
})

function agentWithShell(name: string, child = false): string {
  const path = worktree(name)
  squashMerge(name, path)
  const shell = idleShell(path, 'term_agent', child)
  terminals = [{ handle: 'term_agent', worktreePath: path }]
  processes = shell.processes
  // 모든 Run 범위를 읽지 못해 이 터미널이 누구 것인지 모른다
  scope = 'bound'
  return path
}

function mergedWithSpecs(name: string): { path: string; specs: string } {
  const path = worktree(name)
  squashMerge(name, path)
  const specs = join(repo, '.orch/specs')
  mkdirSync(specs, { recursive: true })
  writeFileSync(join(specs, `spec-${name}.md`), 'x')
  return { path, specs }
}

describe('하위 에이전트 워크트리와 사용자 보유 터미널', () => {
  test('모든 Run 을 읽지 못하면 하위 에이전트 워크트리의 빈 셸도 남긴다', () => {
    const path = agentWithShell('agent-a1')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })

  test('머지됐어도 사용자 보유 터미널이 있으면 아무것도 정리하지 않는다', () => {
    const { path, specs } = mergedWithSpecs('user-owned')
    terminals = [{ handle: 'term_user', worktreePath: path }]
    allWorkers = [{ agentTerminalHandle: 'term_user', resource: { terminalHandle: 'term_user', ownershipState: 'user_owned' } }]
    const out = runSweep(['--apply', '--kill-holders', '--specs-dir', specs])
    exists(path, out)
    has(out, '남김: 사용자 보유 터미널')
    assert.ok(branches().has('user-owned'))
    assert.ok(existsSync(join(specs, 'spec-user-owned.md')))
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
  })

  test('remove-worktree 를 바로 불러도 사용자 보유 터미널을 남긴다', () => {
    const path = worktree('direct-user')
    terminals = [{ handle: 'term_user', worktreePath: path }]
    allWorkers = [{ agentTerminalHandle: 'term_user', resource: { ownershipState: 'user_owned' } }]
    save()
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', REMOVE, path, '--delete-branch'], { env, encoding: 'utf8' })
    assert.equal(done.status, 1, done.stdout + done.stderr)
    has(done.stdout, '남김: 사용자 보유 터미널')
    assert.ok(existsSync(path))
  })

  test('자식이 도는 하위 에이전트 터미널은 남긴다', () => {
    const path = agentWithShell('agent-a2', true)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
    lacks(calls(), 'terminal close')
  })

  test('glob 밖의 빈 셸은 여전히 누구 것인지 모른다', () => {
    const path = agentWithShell('feat-a3')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '터미널 소유 상태 조회 실패')
  })

  test('--agent-glob 이 패턴을 바꾼다', () => {
    const path = agentWithShell('sub-a4')
    scope = 'all'
    const out = runSweep(['--run', 'run_x', '--agent-glob', 'sub-*', '--apply'])
    gone(path, out)
  })

  test('다른 Run 의 worker 로 확인된 터미널이 있는 하위 에이전트 경로는 남긴다', () => {
    const path = agentWithShell('agent-a5')
    scope = 'all'
    allWorkers = [{ runId: 'run_other', dispatchId: 'ctx_o', agentTerminalHandle: 'term_agent' }]
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '다른 Run 의 worker 터미널 term_agent')
  })
})

type TakeOver = { row?: Row; entry?: Row; child?: boolean; otherRun?: boolean }

function takenOver(name: string, opts: TakeOver = {}): string {
  const path = worktree(name)
  squashMerge(name, path)
  const resource = {
    worktreeId: `x::${path}`,
    terminalHandle: 'term_t',
    releaseState: 'retained',
    ownershipState: 'user_owned',
    retainedReason: 'user_takeover',
    ...((opts.row?.resource as Row | undefined) ?? {}),
  }
  const worker: Row = {
    runId: 'run_x',
    dispatchId: 'ctx_t',
    dispatchStatus: 'completed',
    workerState: 'succeeded',
    agentTerminalHandle: 'term_t',
    ...(opts.row ?? {}),
    resource,
  }
  terminals = [{ handle: 'term_t', worktreePath: path, ...(opts.entry ?? {}) }]
  processes = idleShell(path, 'term_t', opts.child).processes
  allWorkers = [worker]
  workers = opts.otherRun ? [] : [worker]
  return path
}

describe('끝난 dispatch 의 user_takeover 터미널 (--close-own-taken-over)', () => {
  test('옵션을 주면 끝난 dispatch 의 넘겨받은 터미널을 닫고 정리한다', () => {
    const path = takenOver('feat-t1')
    const out = runSweep(['--run', 'run_x', '--close-own-taken-over', '--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-t1'))
    has(calls(), 'orca terminal close --terminal term_t')
    has(calls(), 'orca orchestration worker-release --dispatch ctx_t')
  })

  test('옵션이 없으면 남긴다', () => {
    const path = takenOver('feat-t2')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '남김: 사용자 보유 터미널')
    lacks(calls(), 'terminal close')
  })

  test('--run 없이 주면 사용법 오류다', () => {
    const path = takenOver('feat-t3')
    runSweep(['--close-own-taken-over', '--apply'], { code: 2 })
    assert.ok(existsSync(path))
    lacks(calls(), 'terminal close')
  })

  const cases: Record<string, TakeOver> = {
    'other-run': { otherRun: true },
    running: { row: { dispatchStatus: 'dispatched', workerState: 'ready' } },
    'other-reason': { row: { resource: { retainedReason: 'external_terminal' } } },
    agent: { entry: { agentIdentity: 'claude' } },
    child: { child: true },
  }
  for (const [label, opts] of Object.entries(cases)) {
    test(`조건 하나가 어긋나면 남긴다: ${label}`, () => {
      const path = takenOver(`feat-t4-${label}`, opts)
      const out = runSweep(['--run', 'run_x', '--close-own-taken-over', '--apply'])
      exists(path, out)
      lacks(calls(), 'terminal close')
    })
  }

  test('dry-run 은 넘겨받은 터미널을 닫지 않는다', () => {
    const path = takenOver('feat-t5')
    const out = runSweep(['--run', 'run_x', '--close-own-taken-over'])
    exists(path, out)
    has(out, '터미널을 닫을 것 term_t')
    lacks(calls(), 'terminal close')
  })
})

describe('지시서, PR 본문, 기준 브랜치', () => {
  test('살아 있는 dispatch 의 지시서는 남긴다', () => {
    // 브랜치가 머지돼도 그 지시서로 아직 일하는 worker 가 있다
    const { path, specs } = mergedWithSpecs('feat-live')
    const spec = join(specs, 'spec-feat-live.md')
    tasks = [{ id: 'task_1', status: 'dispatched', spec: `지시서 ${spec} 를 끝까지 읽고 수행한다.` }]
    const out = runSweep(['--specs-dir', '.orch/specs', '--apply'])
    gone(path, out)
    exists(spec, out)
    has(out, '살아 있는 dispatch 가 쓴다')
  })

  test('끝난 Task 의 지시서는 지운다', () => {
    const { specs } = mergedWithSpecs('feat-done')
    const spec = join(specs, 'spec-feat-done.md')
    tasks = [{ id: 'task_1', status: 'completed', spec: `지시서 ${spec} 를 끝까지 읽고 수행한다.` }]
    const out = runSweep(['--specs-dir', '.orch/specs', '--apply'])
    gone(spec, out)
  })

  test('살아 있는 dispatch 를 읽지 못하면 지시서를 남긴다', () => {
    const { path, specs } = mergedWithSpecs('feat-unknown')
    tasksFail = true
    const out = runSweep(['--specs-dir', '.orch/specs', '--apply'])
    gone(path, out)
    assert.ok(existsSync(join(specs, 'spec-feat-unknown.md')))
    has(out, '목록을 읽지 못했다')
  })

  test('살아 있는 지시서 목록을 읽지 못하면 PR 본문도 남긴다', () => {
    const path = worktree('mac/kept')
    squashMerge('mac/kept', path)
    const orch = join(repo, '.orch')
    mkdirSync(join(orch, 'specs'), { recursive: true })
    const spec = join(orch, 'specs', 'spec-kept.md')
    const body = join(orch, 'pr-mac-kept.md')
    writeFileSync(spec, 'x')
    writeFileSync(body, 'x')
    tasksFail = true
    const out = runSweep(['--specs-dir', '.orch/specs', '--apply'])
    gone(path, out)
    exists(spec, out)
    exists(body, out)
    has(out, `  지시서를 남긴다 ${spec}: 살아 있는 지시서 목록을 읽지 못했다`)
    has(out, `  PR 본문을 남긴다 ${body}: 살아 있는 지시서 목록을 읽지 못했다`)
  })

  test('지시서 폴더 옆의 PR 본문 파일을 지운다', () => {
    const path = worktree('mac/body')
    squashMerge('mac/body', path)
    const orch = join(repo, '.orch')
    mkdirSync(join(orch, 'specs'), { recursive: true })
    for (const name of ['pr-body.md', 'pr-mac-body.md', 'pr-1.md', 'pr-other.md']) writeFileSync(join(orch, name), 'x')
    const dry = runSweep(['--specs-dir', '.orch/specs'])
    has(dry, `PR 본문을 지울 것 ${join(orch, 'pr-mac-body.md')}`)
    runSweep(['--specs-dir', '.orch/specs', '--apply'])
    const left = readdirSync(orch)
      .filter((name) => name.startsWith('pr-') && name.endsWith('.md'))
      .sort()
    assert.deepEqual(left, ['pr-other.md'])
  })

  test('기준 브랜치를 fast-forward 한다', () => {
    const other = join(tmp, 'other')
    git('clone', '-q', join(tmp, 'repo-origin.git'), other)
    git('-C', other, 'commit', '-q', '--allow-empty', '-m', 'ahead')
    git('-C', other, 'push', '-q', 'origin', 'main')
    const remote = git('-C', other, 'rev-parse', 'HEAD')
    const dry = runSweep()
    has(dry, 'fast-forward 할 것 main')
    assert.notEqual(git('-C', repo, 'rev-parse', 'HEAD'), remote)
    const out = runSweep(['--apply'])
    has(out, '기준 브랜치 fast-forward main')
    assert.equal(git('-C', repo, 'rev-parse', 'HEAD'), remote)
  })

  test('로컬 커밋이 있는 기준 브랜치는 그대로 둔다', () => {
    git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'local')
    const head = git('-C', repo, 'rev-parse', 'HEAD')
    const out = runSweep(['--apply'])
    has(out, 'origin/main 에 없는 커밋이 있다')
    assert.equal(git('-C', repo, 'rev-parse', 'HEAD'), head)
  })
})

function hook(event: string, code: number, reason = ''): void {
  mkdirSync(join(repo, '.orch/hooks'), { recursive: true })
  // stdin 의 입력을 HOOK_LOG 에 한 줄로 적고 code 로 끝난다
  const body = [
    "import { appendFileSync, readFileSync } from 'node:fs'",
    "appendFileSync(process.env.HOOK_LOG, JSON.stringify(JSON.parse(readFileSync(0, 'utf8'))) + '\\n')",
    reason ? `console.log(${JSON.stringify(reason)})` : '',
    `process.exitCode = ${code}`,
  ].join('\n')
  writeFileSync(join(repo, `.orch/hooks/${event}.ts`), body)
}

function hookInputs(event: string): Record<string, unknown>[] {
  if (!existsSync(hookLog)) return []
  return readFileSync(hookLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((input) => input.event === event)
}

describe('before-cleanup 과 after-cleanup 이벤트', () => {
  test('before-cleanup 이 거부하면 워크트리와 터미널을 남긴다', () => {
    const path = mergedWorkerWithTerminal('hook-reject', 'succeeded', 'completed')
    hook('before-cleanup', 10, '저장소가 남긴다')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, 'HOOK-REJECT before-cleanup 저장소가 남긴다')
    has(out, `남김 ${path}: 저장소 핸들러 거부`)
    lacks(out, `removed ${path}`)
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
    assert.ok(branches().has('hook-reject'))
    const st = JSON.parse(readFileSync(join(tmp, 'state.json'), 'utf8')) as { terminals: Row[] }
    assert.deepEqual(
      st.terminals.map((t) => t.handle),
      ['term_s'],
    )
  })

  test('before-cleanup 이 실패하면 HOOK-FAIL 과 같은 남김 줄로 남긴다', () => {
    const path = mergedWorkerWithTerminal('hook-fail', 'succeeded', 'completed')
    hook('before-cleanup', 1)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, 'HOOK-FAIL before-cleanup 1')
    has(out, `남김 ${path}: 저장소 핸들러 거부`)
    lacks(calls(), 'terminal close')
  })

  test('before-cleanup 은 지운 워크트리의 경로, 브랜치, PR, worker 를 받는다', () => {
    const path = mergedWorkerWithTerminal('hook-pass', 'succeeded', 'completed')
    const head = (prs['hook-pass'] as string[])[1]
    hook('before-cleanup', 0)
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    const inputs = hookInputs('before-cleanup')
    assert.equal(inputs.length, 1, JSON.stringify(inputs))
    const input = inputs[0]
    assert.equal(input.worktree, path)
    assert.equal(input.branch, 'hook-pass')
    assert.equal(input.run, 'run_x')
    assert.equal(input.base, 'main')
    const pr = input.pr as Record<string, unknown>
    assert.equal(pr.number, 1)
    assert.equal(pr.head, head)
    assert.equal(pr.branch, 'hook-pass')
    const worker = input.worker as Record<string, unknown>
    assert.equal(worker.dispatch, 'ctx_s')
    assert.equal(worker.terminal, 'term_s')
    assert.equal(worker.worktree, path)
  })

  test('after-cleanup 은 지운 워크트리와 남긴 워크트리를 받는다', () => {
    const removed = worktree('after-gone')
    squashMerge('after-gone', removed)
    const kept = worktree('after-dirty')
    squashMerge('after-dirty', kept)
    writeFileSync(join(kept, 'new.txt'), 'x')
    hook('after-cleanup', 0)
    const out = runSweep(['--apply'])
    gone(removed, out)
    exists(kept, out)
    const inputs = hookInputs('after-cleanup')
    assert.equal(inputs.length, 1, JSON.stringify(inputs))
    assert.deepEqual(inputs[0].removed, [removed])
    assert.deepEqual(inputs[0].skipped, [{ path: kept, reason: '커밋 안 된 변경' }])
  })

  test('워크트리가 없는 저장소의 after-cleanup 은 빈 목록을 받는다', () => {
    hook('after-cleanup', 0)
    runSweep(['--apply'])
    const inputs = hookInputs('after-cleanup')
    assert.equal(inputs.length, 1, JSON.stringify(inputs))
    assert.deepEqual(inputs[0].removed, [])
    assert.deepEqual(inputs[0].skipped, [])
  })

  test('after-cleanup 이 실패해도 종료 코드는 0 이다', () => {
    const path = worktree('after-fail')
    squashMerge('after-fail', path)
    hook('after-cleanup', 1)
    const out = runSweep(['--apply'])
    gone(path, out)
    has(out, 'HOOK-FAIL after-cleanup 1')
  })

  test('--apply 가 없으면 두 핸들러 모두 부르지 않는다', () => {
    const path = worktree('hook-dry')
    squashMerge('hook-dry', path)
    hook('before-cleanup', 0)
    hook('after-cleanup', 0)
    const out = runSweep()
    has(out, `정리 ${path}`)
    exists(path, out)
    assert.deepEqual(hookInputs('before-cleanup'), [])
    assert.deepEqual(hookInputs('after-cleanup'), [])
    assert.equal(existsSync(hookLog), false, '핸들러가 입력을 남겼다')
  })
})

// origin 에만 있는 브랜치를 만든다. 로컬 브랜치는 두지 않는다. 끝 커밋을 돌려준다.
function remoteOnly(name: string, parent = 'origin/main'): string {
  const tree = git('-C', repo, 'rev-parse', `${parent}^{tree}`)
  const oid = git('-C', repo, 'commit-tree', tree, '-p', parent, '-m', name)
  git('-C', repo, 'push', '-q', 'origin', `${oid}:refs/heads/${name}`)
  return oid
}

function closedPr(name: string, oid: string, state: 'MERGED' | 'CLOSED', opts: { number?: number; author?: string; cross?: boolean } = {}): void {
  closedPrs.push({
    number: opts.number ?? 1,
    state,
    headRefName: name,
    headRefOid: oid,
    baseRefName: 'main',
    isCrossRepository: opts.cross ?? false,
    mergedAt: state === 'MERGED' ? '2026-10-01T00:00:00Z' : null,
    author: opts.author ?? 'me',
  })
}

function authorsConfig(authors: string[]): void {
  mkdirSync(join(repo, '.orch'), { recursive: true })
  writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ pipeline: { authors } }))
}

describe('원격 브랜치 정리 (--remote-branches)', () => {
  beforeEach(() => {
    ghUser = 'me'
  })

  test('로컬 브랜치가 없는 MERGED 인 내 PR 의 원격 브랜치를 지운다', () => {
    closedPr('feat-m', remoteOnly('feat-m'), 'MERGED', { number: 7 })
    // 원격에 없는 이름은 줄을 내지 않는다
    closedPr('feat-already-gone', '1'.repeat(40), 'MERGED', { number: 8 })
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 삭제 feat-m (#7 MERGED)')
    assert.ok(!remoteBranches().has('feat-m'), out)
    assert.ok(remoteBranches().has('main'), out)
    lacks(out, 'feat-already-gone')
  })

  test('CLOSED 이고 head 커밋이 base 에 들어 있으면(다른 PR 에 합쳐 닫혔다) 지운다', () => {
    const oid = remoteOnly('feat-folded')
    git('-C', repo, 'push', '-q', 'origin', `${oid}:refs/heads/main`)
    closedPr('feat-folded', oid, 'CLOSED', { number: 3 })
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 삭제 feat-folded (#3 CLOSED)')
    assert.ok(!remoteBranches().has('feat-folded'), out)
  })

  test('CLOSED 이고 head 커밋이 base 에 없으면 남긴다', () => {
    closedPr('feat-dropped', remoteOnly('feat-dropped'), 'CLOSED')
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 남김 feat-dropped: CLOSED 이고 head 가 base 에 없다')
    assert.ok(remoteBranches().has('feat-dropped'), out)
  })

  test('다른 작성자의 PR 브랜치는 남기고 그 작성자의 목록을 부르지 않는다', () => {
    authorsConfig(['me'])
    ghUser = ''
    closedPr('feat-theirs', remoteOnly('feat-theirs'), 'MERGED', { author: 'other' })
    const out = runSweep(['--remote-branches', '--apply'])
    assert.ok(remoteBranches().has('feat-theirs'), out)
    has(calls(), '--author me')
    lacks(calls(), '--author other')
    // pipeline.authors 가 있으면 gh 현재 사용자를 읽지 않는다
    lacks(calls(), 'gh api user')
  })

  test('열린 PR 의 base 인 브랜치는 남기고 그 PR 의 base 를 바꾸지 않는다', () => {
    closedPr('feat-stack', remoteOnly('feat-stack'), 'MERGED')
    openBases = ['feat-stack']
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 남김 feat-stack: 열린 PR 의 base 다')
    assert.ok(remoteBranches().has('feat-stack'), out)
    lacks(calls(), 'pr edit')
  })

  test('열린 PR 의 head 인 브랜치는 남긴다', () => {
    closedPr('feat-reopened', remoteOnly('feat-reopened'), 'MERGED')
    openHeads = ['feat-reopened']
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 남김 feat-reopened: 열린 PR 의 head 다')
    assert.ok(remoteBranches().has('feat-reopened'), out)
  })

  test('release 브랜치는 남긴다', () => {
    closedPr('release/x', remoteOnly('release/x'), 'MERGED')
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 남김 release/x: 보호 브랜치다')
    assert.ok(remoteBranches().has('release/x'), out)
  })

  test('fork PR 과 같은 이름의 원격 브랜치는 남긴다', () => {
    closedPr('feat-fork', remoteOnly('feat-fork'), 'MERGED', { cross: true })
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 남김 feat-fork: fork 의 브랜치다')
    assert.ok(remoteBranches().has('feat-fork'), out)
  })

  test('원격 끝점이 PR head 와 다르면 남긴다', () => {
    const merged = remoteOnly('feat-moved')
    closedPr('feat-moved', merged, 'MERGED')
    // 머지 뒤 같은 이름에 커밋이 더해졌다
    remoteOnly('feat-moved', merged)
    const out = runSweep(['--remote-branches', '--apply'])
    has(out, '원격 브랜치 남김 feat-moved: 원격 끝점이 PR head 와 다르다')
    assert.ok(remoteBranches().has('feat-moved'), out)
  })

  test('--apply 가 없으면 지울 것만 내고 원격은 그대로다', () => {
    closedPr('feat-dry', remoteOnly('feat-dry'), 'MERGED', { number: 5 })
    const out = runSweep(['--remote-branches'])
    has(out, '원격 브랜치를 지울 것 feat-dry (#5 MERGED)')
    lacks(out, '원격 브랜치 삭제')
    assert.ok(remoteBranches().has('feat-dry'), out)
  })

  test('열린 PR 목록을 읽지 못하면 아무것도 지우지 않고 2 로 끝난다', () => {
    closedPr('feat-m2', remoteOnly('feat-m2'), 'MERGED')
    ghFailOn = ['--state open --limit 1000']
    const out = runSweep(['--remote-branches', '--apply'], { code: 2 })
    has(out, '원격 브랜치 정리 건너뜀')
    assert.ok(remoteBranches().has('feat-m2'), out)
  })

  test('남은 워크트리와 로컬 브랜치가 쓰는 원격 브랜치는 남긴다', () => {
    // 열린 PR 이 없어 남는 워크트리. 그 브랜치 이름의 옛 PR 이 MERGED 로 닫혀 있다
    const path = worktree('feat-wt')
    closedPr('feat-wt', git('-C', path, 'rev-parse', 'HEAD'), 'MERGED', { number: 11 })
    // 워크트리 없이 원격 브랜치를 upstream 으로 둔 로컬 브랜치
    closedPr('feat-lb', remoteOnly('feat-lb'), 'MERGED', { number: 12 })
    git('-C', repo, 'fetch', '-q', 'origin')
    git('-C', repo, 'branch', '-q', '--track', 'feat-lb', 'origin/feat-lb')
    const out = runSweep(['--remote-branches', '--apply'])
    exists(path, out)
    has(out, '원격 브랜치 남김 feat-wt: 워크트리가 쓴다')
    has(out, '원격 브랜치 남김 feat-lb: 로컬 브랜치가 쓴다')
    assert.ok(remoteBranches().has('feat-wt'), out)
    assert.ok(remoteBranches().has('feat-lb'), out)
  })

  test('열린 PR 이 limit 만큼 읽히면 목록이 잘렸을 수 있어 건너뛰고 2 로 끝난다', () => {
    closedPr('feat-many', remoteOnly('feat-many'), 'MERGED', { number: 9 })
    openHeads = Array.from({ length: 1000 }, (_, i) => `open-${i}`)
    const out = runSweep(['--remote-branches', '--apply'], { code: 2 })
    has(out, '원격 브랜치 정리 건너뜀: 열린 PR 이 1000 개 이상이라')
    assert.ok(remoteBranches().has('feat-many'), out)
    // 하나 적으면 다 읽은 목록이다
    openHeads = openHeads.slice(1)
    has(runSweep(['--remote-branches', '--apply']), '원격 브랜치 삭제 feat-many (#9 MERGED)')
    assert.ok(!remoteBranches().has('feat-many'))
  })

  test('내 PR 의 작성자를 정하지 못하면 아무것도 지우지 않고 2 로 끝난다', () => {
    ghUser = ''
    closedPr('feat-m3', remoteOnly('feat-m3'), 'MERGED')
    const done = runSweepFull(['--remote-branches', '--apply'], { code: 2 })
    has(done.stderr, '내 PR 의 작성자를 정하지 못해')
    has(done.stdout, '원격 브랜치 정리 건너뜀')
    assert.ok(remoteBranches().has('feat-m3'), done.stdout)
    lacks(calls(), '--author')
  })

  test('옵션이 없으면 작성자도 닫힌 PR 도 읽지 않는다', () => {
    ghUser = ''
    closedPr('feat-m4', remoteOnly('feat-m4'), 'MERGED')
    const out = runSweep(['--apply'])
    assert.ok(remoteBranches().has('feat-m4'), out)
    lacks(calls(), 'gh api user')
    lacks(calls(), '--author')
  })
})

// 이 Run 의 끝난 dispatch 와 그 터미널이 path 에 있다.
function finishedWorker(path: string): void {
  workers = [
    {
      dispatchId: 'ctx_c',
      workerState: 'succeeded',
      dispatchStatus: 'completed',
      agentTerminalHandle: 'term_c',
      resource: { worktreeId: `x::${path}`, terminalHandle: 'term_c' },
    },
  ]
  terminals = [{ handle: 'term_c', worktreePath: path }]
}

// 머지 없이 CLOSED 가 된 PR 의 워크트리. upstream 을 지우지 않으면 원격 브랜치가 남는다.
function closedWorktree(name: string, opts: { author?: string; dropUpstream?: boolean; intoBase?: boolean } = {}): string {
  const path = worktree(name)
  const head = git('-C', path, 'rev-parse', 'HEAD')
  if (opts.intoBase) git('-C', repo, 'push', '-q', 'origin', `${head}:refs/heads/main`)
  if (opts.dropUpstream || opts.intoBase) git('-C', repo, 'push', '-q', 'origin', '--delete', name)
  prs[name] = ['CLOSED', head]
  prAuthors[name] = opts.author ?? 'me'
  finishedWorker(path)
  return path
}

describe('머지 없이 CLOSED 가 된 PR 의 터미널', () => {
  beforeEach(() => {
    ghUser = 'me'
  })

  test('내 PR 의 끝난 dispatch 터미널을 닫고 반납하되 원격에 없는 커밋이 있는 워크트리는 남긴다', () => {
    const path = closedWorktree('closed-a', { dropUpstream: true })
    terminals.push({ handle: 'term_user_shell', worktreePath: path })
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, `남김 ${path}: upstream gone 이지만 base 에 없는 커밋 1 개`)
    has(out, '터미널 닫음 term_c (CLOSED #1)')
    has(calls(), 'orca terminal close --terminal term_c')
    has(calls(), 'orca orchestration worker-release --dispatch ctx_c')
    // 같은 경로의 다른 터미널은 닫지 않는다
    lacks(calls(), '--terminal term_user_shell')
    assert.ok(branches().has('closed-a'))
  })

  test('열린 PR 의 끝난 dispatch 터미널은 남긴다', () => {
    const path = worktree('open-a')
    prs['open-a'] = ['OPEN', git('-C', path, 'rev-parse', 'HEAD')]
    prAuthors['open-a'] = 'me'
    finishedWorker(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
    lacks(calls(), 'gh api user')
  })

  test('다른 작성자의 CLOSED PR 이면 터미널을 남긴다', () => {
    const path = closedWorktree('closed-theirs', { author: 'other' })
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
  })

  test('cherry 판정을 통과한 CLOSED PR 은 한 번 실행에 터미널을 닫고 워크트리를 지운다', () => {
    const path = closedWorktree('closed-folded', { intoBase: true })
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    has(out, `정리 ${path} (closed-folded, upstream gone, base 에 없는 커밋 0 개)`)
    has(calls(), 'orca terminal close --terminal term_c')
    has(calls(), 'orca orchestration worker-release --dispatch ctx_c')
    lacks(calls(), '--merged-head')
    assert.ok(!branches().has('closed-folded'))
  })

  test('upstream 이 남은 CLOSED PR 은 터미널만 닫고 워크트리를 남긴다', () => {
    const path = closedWorktree('closed-up')
    const dry = runSweep(['--run', 'run_x'])
    has(dry, '닫을 것: term_c (CLOSED #1)')
    lacks(calls(), 'terminal close')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, `남김 ${path}: PR CLOSED, upstream 이 남아 있다`)
    has(calls(), 'orca terminal close --terminal term_c')
    has(calls(), 'orca orchestration worker-release --dispatch ctx_c')
  })

  test('before-cleanup 이 거부하면 CLOSED PR 의 터미널도 닫지 않는다', () => {
    const path = closedWorktree('closed-hook', { intoBase: true })
    hook('before-cleanup', 10, '저장소가 남긴다')
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, `남김 ${path}: 저장소 핸들러 거부`)
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
  })

  test('내 PR 의 작성자를 정하지 못하면 터미널을 닫지 않고 2 로 끝난다', () => {
    ghUser = ''
    const path = closedWorktree('closed-unknown')
    const done = runSweepFull(['--run', 'run_x', '--apply'], { code: 2 })
    exists(path, done.stdout)
    has(done.stderr, '내 PR 의 작성자를 정하지 못해')
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
  })

  test('--run 이 없으면 CLOSED PR 의 터미널을 닫지 않는다', () => {
    const path = closedWorktree('closed-norun')
    const out = runSweep(['--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
    lacks(calls(), 'gh api user')
  })
})

describe('옛 경로', () => {
  test('cleanup-sweep.py 는 DEPRECATED 줄을 내고 cleanup-sweep.ts 로 넘긴다', () => {
    const path = worktree('shim-a')
    squashMerge('shim-a', path)
    save()
    const done = spawnSync('python3', [SHIM, '--repo', repo, '--wait', '0.01', '--poll-interval', '0.01', '--apply'], { env, encoding: 'utf8' })
    assert.equal(done.status, 0, done.stdout + done.stderr)
    has(done.stderr, 'DEPRECATED')
    has(done.stdout, `cleanup-sweep apply: ${repo}`)
    gone(path, done.stdout)
  })
})
