// cleanup-sweep.ts 를 실제 git 저장소와 가짜 gh, orca, lsof, ps, kill 로 본다. GitHub 와 Orca 에는 닿지 않는다.
//
// 가짜 실행 파일은 모든 테스트가 함께 쓰고(macOS 의 첫 실행 검사를 테스트마다 치르지 않게 한다), 상태와 호출 기록은
// 테스트마다 따로 둔다. 가짜는 FAKE_STATE 의 JSON 을 읽어 답하고 FAKE_LOG 에 `<이름> <인자>` 한 줄을 더한다.
// 프로세스의 pid 가 SWEEP 이면 cleanup-sweep.ts 자신이다. lsof 와 ps 가짜는 그 명령이 바로 띄우므로 부모 pid 가 곧 그 pid 다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, before, beforeEach, afterEach } from 'node:test'
import { fileURLToPath } from 'node:url'

export const SCRIPT = fileURLToPath(new URL('../../scripts/cleanup-sweep.ts', import.meta.url))
export const SHIM = fileURLToPath(new URL('../../scripts/cleanup-sweep.py', import.meta.url))
export const REMOVE = fileURLToPath(new URL('../../scripts/remove-worktree.ts', import.meta.url))
export const HOOK = 'node /x/oh-my-claudecode/dist/hooks/session-end/worker.js --omc-session-end-worker {}'

export type Row = Record<string, unknown>
export type Proc = { pid: number | 'SWEEP'; ppid?: number; cwd: string; command: string; terminal?: string; ignores?: string[] }
export type Shell = { handle: string; path: string; processes: Proc[] }

// 나눈 테스트 파일들이 함께 쓰는 상태다. 다른 모듈이 다시 대입할 수 있게 객체 하나에 둔다
export type Fixture = {
  bin: string
  tmp: string
  repo: string
  wts: string
  logFile: string
  hookLog: string
  env: NodeJS.ProcessEnv

  // 테스트마다 새로 두는 가짜의 상태. save 가 FAKE_STATE 로 옮긴다
  prs: Record<string, unknown[]>
  workers: Row[]
  terminals: Row[]
  held: string[]
  allWorkers: Row[]
  scope: string
  processes: Proc[]
  spawnOnRelease: Shell | null
  ghRaw: Record<string, string>
  openBases: string[]
  orcaFail: boolean
  ghFail: boolean
  closeNoop: boolean
  tasks: Row[]
  tasksFail: boolean
  prCommits: Record<string, string[]>
  // Run 마다 worker 행. null 이면 run-list 가 실패하고 worker-list --run 은 workers 를 준다
  runs: Record<string, Row[] | null> | null
  pageSize: number
  // --remote-branches 가 읽는 닫힌 PR. author 로 가짜가 고른다
  closedPrs: Row[]
  // gh api user 가 줄 로그인. 빈 값이면 그 조회가 실패한다
  ghUser: string
  // --head 조회의 PR 작성자. 브랜치 이름에서 로그인으로
  prAuthors: Record<string, string>
  openHeads: string[]
  // gh 인자를 이은 문자열에 이 조각이 들면 그 호출이 실패한다
  ghFailOn: string[]
}
export const fx = {} as Fixture

export const FAKE_HEAD = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_STATE
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
const a = process.argv.slice(2)
const save = () => fs.writeFileSync(file, JSON.stringify(st))
const has = (...xs) => xs.every((x, i) => a[i] === x)
`

export const FAKES: Record<string, string> = {
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
  fx.bin = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-sweep-bin-')))
  for (const [name, body] of Object.entries(FAKES)) {
    const head = FAKE_HEAD + `fs.appendFileSync(process.env.FAKE_LOG, ['${name}', ...a].join(' ') + '\\n')\n`
    writeFileSync(join(fx.bin, name), head + body)
    chmodSync(join(fx.bin, name), 0o755)
  }
})

after(() => rmSync(fx.bin, { recursive: true, force: true }))

beforeEach(() => {
  fx.tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-sweep-')))
  fx.logFile = join(fx.tmp, 'calls.log')
  fx.hookLog = join(fx.tmp, 'hooks.jsonl')
  fx.env = {
    ...process.env,
    // 가짜 실행 파일은 PATH 의 node 로 돈다. 이 테스트의 node 폴더를 가짜 다음에 둔다
    PATH: [fx.bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    FAKE_STATE: join(fx.tmp, 'state.json'),
    FAKE_LOG: fx.logFile,
    HOOK_LOG: fx.hookLog,
    ORCA: join(fx.bin, 'orca'),
    GH: join(fx.bin, 'gh'),
    ORCH_GH_CACHE: '0', // 가짜 상태를 매 검사마다 바꾸므로 이전 응답을 재사용하지 않는다.
    ORCH_KILL: join(fx.bin, 'kill'),
  }
  // Orca 터미널에서 돌려도 가짜 orca 가 bound 범위로 답하지 않게 한다. bound 는 테스트가 직접 켠다.
  // orch 루트와 hook 대기 시간도 테스트가 정한다
  delete fx.env.ORCA_TERMINAL_HANDLE
  delete fx.env.ORCH_DIR
  delete fx.env.ORCH_HOOK_WAIT
  fx.prs = {}
  fx.workers = []
  fx.terminals = []
  fx.held = []
  fx.allWorkers = []
  fx.scope = 'all'
  fx.processes = []
  fx.spawnOnRelease = null
  fx.ghRaw = {}
  fx.openBases = []
  fx.orcaFail = false
  fx.ghFail = false
  fx.closeNoop = false
  fx.tasks = []
  fx.tasksFail = false
  fx.prCommits = {}
  fx.runs = null
  fx.pageSize = 100
  fx.closedPrs = []
  fx.ghUser = ''
  fx.prAuthors = {}
  fx.openHeads = []
  fx.ghFailOn = []
  fx.repo = makeRepo('repo')
  fx.wts = join(fx.tmp, 'wts')
})

afterEach(() => rmSync(fx.tmp, { recursive: true, force: true }))

export function sh(cmd: string, ...args: string[]): string {
  const done = spawnSync(cmd, args, { env: fx.env, encoding: 'utf8' })
  assert.equal(done.status, 0, `${cmd} ${args.join(' ')} 실패: ${done.stderr}`)
  return done.stdout.trim()
}

export function git(...args: string[]): string {
  return sh('git', ...args)
}

// 처음 부를 때 origin 과 clone 을 한 벌 만들어 두고, 그 뒤로는 복사해 origin 주소만 바꾼다.
// git init, clone, commit, push 를 테스트마다 치르지 않는다. 템플릿은 가짜 폴더와 함께 지워진다.
let template: { origin: string; dir: string } | null = null

export function makeRepo(name: string): string {
  if (!template) {
    template = { origin: join(fx.bin, 'template-origin.git'), dir: join(fx.bin, 'template') }
    git('init', '-q', '--bare', '-b', 'main', template.origin)
    git('clone', '-q', template.origin, template.dir)
    git('-C', template.dir, 'commit', '-q', '--allow-empty', '-m', 'init')
    git('-C', template.dir, 'push', '-q', '-u', 'origin', 'main')
  }
  const origin = join(fx.tmp, `${name}-origin.git`)
  const dir = join(fx.tmp, name)
  cpSync(template.origin, origin, { recursive: true })
  cpSync(template.dir, dir, { recursive: true })
  git('-C', dir, 'remote', 'set-url', 'origin', origin)
  return dir
}

export function save(): void {
  writeFileSync(
    join(fx.tmp, 'state.json'),
    JSON.stringify({
      prs: fx.prs,
      workers: fx.workers,
      terminals: fx.terminals,
      processes: [...fx.processes, ...fx.held.map((cwd, i) => ({ pid: 900 + i, cwd, command: 'node server.js' }))],
      spawn_on_release: fx.spawnOnRelease,
      gh_raw: fx.ghRaw,
      open_bases: fx.openBases,
      all_workers: fx.allWorkers,
      scope: fx.scope,
      orca_fail: fx.orcaFail,
      gh_fail: fx.ghFail,
      close_noop: fx.closeNoop,
      tasks: fx.tasks,
      tasks_fail: fx.tasksFail,
      pr_commits: fx.prCommits,
      runs: fx.runs,
      page_size: fx.pageSize,
      closed_prs: fx.closedPrs,
      gh_user: fx.ghUser,
      pr_authors: fx.prAuthors,
      open_heads: fx.openHeads,
      gh_fail_on: fx.ghFailOn,
    }),
  )
}

export function worktree(name: string, opts: { push?: boolean; commits?: number; repo?: string } = {}): string {
  const target = opts.repo ?? fx.repo
  const path = join(fx.wts, name)
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
export function squashMerge(name: string, path: string): string {
  const head = git('-C', path, 'rev-parse', 'HEAD')
  git('-C', fx.repo, 'push', '-q', 'origin', '--delete', name)
  fx.prs[name] = ['MERGED', head]
  return head
}

export type Swept = { stdout: string; stderr: string }

export function runSweepFull(args: string[] = [], opts: { code?: number; repos?: string[] } = {}): Swept {
  save()
  const flags = (opts.repos ?? [fx.repo]).flatMap((r) => ['--repo', r])
  const done = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', SCRIPT, ...flags, '--wait', '0.01', '--poll-interval', '0.01', ...args],
    { env: fx.env, encoding: 'utf8' },
  )
  assert.equal(done.status, opts.code ?? 0, `종료 코드가 다르다\nstdout:\n${done.stdout}\nstderr:\n${done.stderr}`)
  return { stdout: done.stdout, stderr: done.stderr }
}

export function runSweep(args: string[] = [], opts: { code?: number; repos?: string[] } = {}): string {
  return runSweepFull(args, opts).stdout
}

export function branches(): Set<string> {
  return new Set(git('-C', fx.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean))
}

export function remoteBranches(): Set<string> {
  const refs = git('-C', fx.repo, 'ls-remote', '--heads', 'origin').split(/\s+/).filter(Boolean)
  return new Set(refs.filter((_, i) => i % 2 === 1).map((ref) => ref.replace(/^refs\/heads\//, '')))
}

export function calls(): string {
  return existsSync(fx.logFile) ? readFileSync(fx.logFile, 'utf8') : ''
}

export function sweepCalls(needle: string): string[] {
  return calls()
    .split('\n')
    .filter((line) => line.includes(needle))
}

export function has(text: string, part: string): void {
  assert.ok(text.includes(part), `「${part}」 가 없다:\n${text}`)
}

export function lacks(text: string, part: string): void {
  assert.ok(!text.includes(part), `「${part}」 가 있으면 안 된다:\n${text}`)
}

export function exists(path: string, out: string): void {
  assert.ok(existsSync(path), `${path} 가 남아 있어야 한다:\n${out}`)
}

export function gone(path: string, out: string): void {
  assert.ok(!existsSync(path), `${path} 가 지워져야 한다:\n${out}`)
}

// 막 만든 브랜치. base 와 같고 커밋 0 이며 upstream 이 gone 이라 cherry 판정을 통과한다.
export function freshGoneBranch(name: string): string {
  const path = worktree(name, { commits: 0 })
  git('-C', fx.repo, 'push', '-q', 'origin', '--delete', name)
  return path
}

export function mergedWorkerWithTerminal(name: string, state: string, status: string): string {
  const path = worktree(name)
  squashMerge(name, path)
  fx.workers = [{ dispatchId: 'ctx_s', workerState: state, dispatchStatus: status, agentTerminalHandle: 'term_s', resource: { worktreeId: `x::${path}` } }]
  fx.terminals = [{ handle: 'term_s', worktreePath: path }]
  return path
}

export function hook(event: string, code: number, reason = ''): void {
  mkdirSync(join(fx.repo, '.orch/hooks'), { recursive: true })
  // stdin 의 입력을 HOOK_LOG 에 한 줄로 적고 code 로 끝난다
  const body = [
    "import { appendFileSync, readFileSync } from 'node:fs'",
    "appendFileSync(process.env.HOOK_LOG, JSON.stringify(JSON.parse(readFileSync(0, 'utf8'))) + '\\n')",
    reason ? `console.log(${JSON.stringify(reason)})` : '',
    `process.exitCode = ${code}`,
  ].join('\n')
  writeFileSync(join(fx.repo, `.orch/hooks/${event}.ts`), body)
}

export function idleShell(path: string, handle = 'term_shell', child = false): Shell {
  const shell: Proc = { pid: 501, ppid: 1, cwd: path, command: '-/bin/zsh -l', terminal: handle }
  const rows = [shell, ...(child ? [{ pid: 502, ppid: 501, cwd: path, command: 'sleep 100' }] : [])]
  return { handle, path, processes: rows }
}

// 로컬 브랜치 이름과 원격 브랜치 이름이 다른 worktree. 원격 브랜치는 그대로 둔다.
export function renamedWorktree(local: string, remote: string, track = true, target = fx.repo): string {
  const path = worktree(local, { push: false, repo: target })
  git('-C', path, 'push', '-q', ...(track ? ['-u'] : []), 'origin', `${local}:${remote}`)
  return path
}
