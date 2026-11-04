// remove-worktree.ts 를 실제 git 저장소와 가짜 orca, lsof, ps, sleep 으로 본다. 원격은 로컬 bare 저장소다.
//
// 가짜 sleep 은 부를 때마다 시계(slept)를 1 올리고, gone 에 이른 프로세스를 지운다.
// takeoverAt 에 이르면 worker 행의 소유 상태를 user_owned 로 바꾼다. 기다리는 사이에 사용자가 터미널을 넘겨받은 것이다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/remove-worktree.ts', import.meta.url))
const HOOK = 'node /x/oh-my-claudecode/dist/hooks/session-end/worker.js --omc-session-end-worker {}'

// terminal 은 그 프로세스를 띄운 Orca 터미널이다. 가짜 orca 가 그 터미널을 닫으면 프로세스도 끝난다
type Proc = { pid: number; cwd: string; command: string; gone?: number; ppid?: number; terminal?: string }
type State = {
  procs?: Proc[]
  terminals?: unknown[]
  workers?: unknown[]
  takeoverAt?: number
  orcaFail?: boolean
  // 가짜 orca 가 닫은 터미널 handle
  closed?: string[]
  // terminal close 를 받은 뒤 worker 행의 소유 상태를 이 값으로 바꾼다. 닫기 바로 앞의 다시 읽기를 본다
  takeoverOnList?: boolean
  // 리뷰 브랜치 판정이 읽는 것. gh pr view 의 응답(PR 번호에서)과 task-list 의 Task
  prViews?: Record<string, unknown>
  tasks?: unknown[]
  tasksFail?: boolean
  // 가짜 docker 가 답할 컨테이너(docker container inspect 의 행)와 데몬이 꺼졌는지. 부른 인자는 dockerCalls 에 쌓인다
  docker?: { containers: unknown[] }
  dockerDown?: boolean
}

let tmp: string
let repo: string
let wt: string
let stateFile: string
let env: NodeJS.ProcessEnv

function git(...args: string[]): string {
  const done = spawnSync('git', args, { env, encoding: 'utf8' })
  assert.equal(done.status, 0, `git ${args.join(' ')} 실패: ${done.stderr}`)
  return done.stdout.trim()
}

function fake(bin: string, name: string, body: string): void {
  const head = `#!/usr/bin/env node
const fs = require('node:fs')
const file = ${JSON.stringify(stateFile)}
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
const argv = process.argv.slice(2)
`
  writeFileSync(join(bin, name), head + body)
  chmodSync(join(bin, name), 0o755)
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'remove-worktree-')))
  stateFile = join(tmp, 'state.json')
  const bin = join(tmp, 'bin')
  mkdirSync(bin)
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
    ORCA: join(bin, 'orca'),
    GH: join(bin, 'gh'),
    DOCKER: join(bin, 'docker'),
    ORCH_GH_CACHE: '0',
  }
  // Orca 터미널 안에서 돌려도 이 변수가 가짜 orca 로 새지 않게 한다. 대기 시간은 테스트가 직접 정한다
  delete env.ORCA_TERMINAL_HANDLE
  delete env.ORCH_HOOK_WAIT
  const origin = join(tmp, 'origin.git')
  repo = join(tmp, 'repo')
  git('init', '-q', '--bare', '-b', 'main', origin)
  git('clone', '-q', origin, repo)
  git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git('-C', repo, 'push', '-q', '-u', 'origin', 'main')
  wt = join(tmp, 'wt')
  git('-C', repo, 'worktree', 'add', '-q', '-b', 'feat', wt, 'origin/main')
  git('-C', wt, 'push', '-q', '-u', 'origin', 'feat')
  fake(
    bin,
    'orca',
    `if (st.orcaFail) process.exit(1)
if (argv.includes('terminal') && argv.includes('list')) {
  console.log(JSON.stringify({ result: { terminals: st.terminals || [] } }))
  st.lists = (st.lists || 0) + 1
  // 두 번째 목록(유휴 셸 판정) 뒤에 사용자가 넘겨받는다. 닫기 바로 앞의 소유 확인(세 번째 목록)이 잡아야 한다
  if (st.takeoverOnList && st.lists === 2) for (const w of st.workers || []) w.resource.ownershipState = 'user_owned'
  fs.writeFileSync(file, JSON.stringify(st))
}
else if (argv.includes('terminal') && argv.includes('close')) {
  const handle = argv[argv.indexOf('--terminal') + 1]
  st.closed = [...(st.closed || []), handle]
  st.procs = (st.procs || []).filter((q) => q.terminal !== handle)
  fs.writeFileSync(file, JSON.stringify(st))
  console.log(JSON.stringify({ ok: true, result: {} }))
}
else if (argv.includes('worker-list')) console.log(JSON.stringify({ result: { scope: { source: 'all' }, workers: st.workers || [], page: {} } }))
else if (argv.includes('task-list')) {
  if (st.tasksFail) process.exit(1)
  console.log(JSON.stringify({ result: { tasks: st.tasks || [] } }))
}
else console.log(JSON.stringify({ ok: true, result: {} }))
`,
  )
  fake(bin, 'gh', `const n = argv[2]
if (argv[0] === 'pr' && argv[1] === 'view' && st.prViews && n in st.prViews) console.log(JSON.stringify(st.prViews[n]))
else process.exit(1)
`)
  fake(
    bin,
    'docker',
    `st.dockerCalls = [...(st.dockerCalls || []), argv.join(' ')]
fs.writeFileSync(file, JSON.stringify(st))
const rows = (st.docker || { containers: [] }).containers
if (st.dockerDown) {
  console.error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')
  process.exit(1)
}
if (argv[0] === 'ps') console.log(rows.map((c) => c.Id).join('\\n'))
else if (argv[0] === 'container' && argv[1] === 'inspect') console.log(JSON.stringify(rows))
`,
  )
  fake(bin, 'lsof', `for (const q of st.procs || []) console.log('p' + q.pid + '\\nn' + q.cwd)\n`)
  fake(bin, 'ps', `for (const q of st.procs || []) console.log(q.pid + ' ' + (q.ppid ?? 1) + ' ' + q.command)\n`)
  fake(
    bin,
    'sleep',
    `st.slept += 1
st.procs = (st.procs || []).filter((q) => q.gone == null || q.gone > st.slept)
if (st.takeoverAt === st.slept) for (const w of st.workers || []) w.resource.ownershipState = 'user_owned'
fs.writeFileSync(file, JSON.stringify(st))
`,
  )
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function proc(pid: number, command: string, opts: { gone?: number; ppid?: number; terminal?: string } = {}): Proc {
  return { pid, cwd: wt, command, ...opts }
}

type Launch = 'node' | 'bash'

function removeWorktree(state: State, args: string[] = [], opts: { hookWait?: number; launch?: Launch } = {}) {
  writeFileSync(stateFile, JSON.stringify({ slept: 0, ...state }))
  const runEnv = { ...env }
  if (opts.hookWait !== undefined) runEnv.ORCH_HOOK_WAIT = String(opts.hookWait)
  const node = [process.execPath, '--disable-warning=ExperimentalWarning', SCRIPT, wt, ...args]
  const command =
    opts.launch === 'bash'
      ? ['bash', '-c', 'exec "$@"', 'remove-worktree', ...node]
      : node
  const done = spawnSync(command[0], command.slice(1), { env: runEnv, encoding: 'utf8' })
  const after = JSON.parse(readFileSync(stateFile, 'utf8')) as { slept: number; closed?: string[] }
  return { code: done.status, stdout: done.stdout, out: done.stdout + done.stderr, slept: after.slept, closed: after.closed ?? [] }
}

function has(text: string, part: string): void {
  assert.ok(text.includes(part), `출력에 「${part}」 가 없다:\n${text}`)
}

function lacks(text: string, part: string): void {
  assert.ok(!text.includes(part), `출력에 「${part}」 가 있으면 안 된다:\n${text}`)
}

describe('작업 디렉터리를 쥔 프로세스 대기', () => {
  test('OMC session-end hook 이 끝나기를 기다려 지운다', () => {
    const r = removeWorktree({ procs: [proc(41, HOOK, { gone: 3 })] })
    assert.equal(r.code, 0, r.out)
    has(r.out, 'OMC session-end hook 41')
    assert.equal(r.slept, 3)
    assert.equal(existsSync(wt), false)
  })

  test('끝나지 않는 hook 은 ORCH_HOOK_WAIT 뒤에 거부한다', () => {
    const r = removeWorktree({ procs: [proc(41, HOOK)] }, [], { hookWait: 2 })
    assert.equal(r.code, 1, r.out)
    has(r.out, '2초 기다림')
    has(r.out, 'session-end hook 41 는 스스로 끝난다')
    assert.equal(r.slept, 2)
    assert.equal(existsSync(wt), true)
  })

  test('hook 이 아닌 프로세스는 기다리지 않고 거부한다', () => {
    const r = removeWorktree({ procs: [proc(42, 'node server.js', { gone: 1 })] })
    assert.equal(r.code, 1, r.out)
    has(r.out, 'pid 42')
    lacks(r.out, 'session-end')
    assert.equal(r.slept, 0)
    assert.equal(existsSync(wt), true)
  })

  test('hook 옆에 다른 프로세스가 있으면 hook 대기 시간으로 늘리지 않는다', () => {
    const r = removeWorktree({ procs: [proc(41, HOOK, { gone: 2 }), proc(42, '-/bin/zsh')] })
    assert.equal(r.code, 1, r.out)
    assert.equal(r.slept, 0)
    has(r.out, 'pid 41, 42')
  })

  test('hook 과 그 자식은 --wait 가 아니라 hook 대기 시간까지 기다린다', () => {
    // 대기 도중 hook 의 자식(42)이 생겨도 hook 대기 시간까지 기다린다
    const procs = [proc(41, HOOK, { gone: 5 }), proc(42, 'node child.js', { gone: 4, ppid: 41 })]
    const r = removeWorktree({ procs }, ['--wait', '1'], { hookWait: 10 })
    assert.equal(r.code, 0, r.out)
    assert.equal(r.slept, 5)
    assert.equal(existsSync(wt), false)
  })

  test('hook 옆의 관계없는 프로세스는 --wait 뒤에 거부한다', () => {
    const procs = [proc(41, HOOK, { gone: 5 }), proc(50, 'node other.js', { ppid: 7 })]
    const r = removeWorktree({ procs }, ['--wait', '1'], { hookWait: 10 })
    assert.equal(r.code, 1, r.out)
    assert.equal(r.slept, 1)
    has(r.out, 'pid 41, 50')
    assert.equal(existsSync(wt), true)
  })

  test('--wait 를 주면 다른 프로세스도 기다린다', () => {
    const r = removeWorktree({ procs: [proc(42, 'node server.js', { gone: 2 })] }, ['--wait', '5'])
    assert.equal(r.code, 0, r.out)
    assert.equal(r.slept, 2)
    assert.equal(existsSync(wt), false)
  })
})

// Orca 가 워크트리를 화면에서 열 때 띄운 「Terminal 1」(에이전트 없는 `zsh -l`)이 워크트리를 쥔 경우(2026-11-04 ai-analysis)
describe('Orca 기본 셸', () => {
  const shell = (handle = 'term_1') => ({ handle, worktreePath: wt, title: 'Terminal 1' })

  test('자식 없는 로그인 셸만 쥐었으면 그 터미널을 닫고 지운다', () => {
    const r = removeWorktree({ procs: [proc(42, '-zsh', { terminal: 'term_1' })], terminals: [shell()] })
    assert.equal(r.code, 0, r.out)
    has(r.out, '유휴 셸 터미널 닫음 term_1')
    assert.deepEqual(r.closed, ['term_1'])
    assert.equal(existsSync(wt), false)
  })

  test('자식이 있는 셸은 닫지 않고 거부한다', () => {
    const procs = [proc(42, '-zsh', { terminal: 'term_1' }), { pid: 43, cwd: tmp, command: 'vim', ppid: 42 }]
    const r = removeWorktree({ procs, terminals: [shell()] })
    assert.equal(r.code, 1, r.out)
    has(r.out, '유휴 셸 터미널을 닫지 않는다: 자식이 있는 셸 42')
    assert.deepEqual(r.closed, [])
    assert.equal(existsSync(wt), true)
  })

  test('에이전트 터미널은 닫지 않는다', () => {
    const r = removeWorktree({ procs: [proc(42, '-zsh', { terminal: 'term_1' })], terminals: [{ ...shell(), agentIdentity: { agent: 'claude' } }] })
    assert.equal(r.code, 1, r.out)
    has(r.out, '유휴 셸 터미널을 닫지 않는다: 에이전트 터미널 term_1')
    assert.deepEqual(r.closed, [])
  })

  test('살아 있는 dispatch 의 터미널은 닫지 않는다', () => {
    const workers = [{ dispatchStatus: 'running', agentTerminalHandle: 'term_1', resource: { terminalHandle: 'term_1', ownershipState: 'owned' } }]
    const r = removeWorktree({ procs: [proc(42, '-zsh', { terminal: 'term_1' })], terminals: [shell()], workers })
    assert.equal(r.code, 1, r.out)
    has(r.out, '유휴 셸 터미널을 닫지 않는다: worker 터미널 term_1')
    assert.deepEqual(r.closed, [])
  })

  test('닫기 바로 앞에 사용자가 넘겨받았으면 닫지 않고 남긴다', () => {
    const workers = [{ dispatchStatus: 'completed', agentTerminalHandle: 'term_1', resource: { terminalHandle: 'term_1', ownershipState: 'owned' } }]
    const r = removeWorktree({ procs: [proc(42, '-zsh', { terminal: 'term_1' })], terminals: [shell()], workers, takeoverOnList: true })
    assert.equal(r.code, 1, r.out)
    has(r.out, `남김: 사용자 보유 터미널 (${wt})`)
    assert.deepEqual(r.closed, [])
    assert.equal(existsSync(wt), true)
  })

  test('그 경로에 Orca 터미널이 없으면 닫지 않고 판정 줄도 내지 않는다', () => {
    const r = removeWorktree({ procs: [proc(42, '-zsh')] })
    assert.equal(r.code, 1, r.out)
    lacks(r.out, '유휴 셸')
    assert.deepEqual(r.closed, [])
  })
})

describe('인자', () => {
  test('--wait 는 정수여야 한다', () => {
    const r = removeWorktree({}, ['--wait', 'soon'])
    assert.equal(r.code, 2, r.out)
    assert.equal(existsSync(wt), true)
  })

  test('ORCH_HOOK_WAIT 도 정수여야 한다', () => {
    writeFileSync(stateFile, JSON.stringify({ slept: 0 }))
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, wt], {
      env: { ...env, ORCH_HOOK_WAIT: '-1' },
      encoding: 'utf8',
    })
    assert.equal(done.status, 2, done.stdout + done.stderr)
    assert.equal(existsSync(wt), true)
  })

  test('디렉터리가 아니면 없음 줄을 내고 1 이다', () => {
    rmSync(wt, { recursive: true, force: true })
    const r = removeWorktree({})
    assert.equal(r.code, 1, r.out)
    assert.equal(r.stdout, `없음: ${wt}\n`)
  })
})

describe('bash 로 띄우기', () => {
  test('사용법 오류가 node 로 바로 띄운 것과 같다', () => {
    const direct = removeWorktree({}, ['--wait', 'soon'])
    const bash = removeWorktree({}, ['--wait', 'soon'], { launch: 'bash' })
    assert.equal(bash.code, 2, bash.out)
    assert.equal(bash.code, direct.code)
    assert.equal(bash.out, direct.out)
    lacks(bash.out, 'unbound variable')
  })

  test('워크트리를 지운다', () => {
    const r = removeWorktree({}, [], { launch: 'bash' })
    assert.equal(r.code, 0, r.out)
    has(r.out, `removed ${wt}`)
    lacks(r.out, 'unbound variable')
    assert.equal(existsSync(wt), false)
  })

  test('쥔 프로세스를 기다린다', () => {
    const r = removeWorktree({ procs: [proc(42, 'node server.js', { gone: 2 })] }, ['--wait', '5'], { launch: 'bash' })
    assert.equal(r.code, 0, r.out)
    assert.equal(r.slept, 2)
    assert.equal(existsSync(wt), false)
  })
})

describe('원격에 없는 커밋', () => {
  test('원격에 같은 제목의 커밋이 있으면 rebase 된 것으로 보고 지운다', () => {
    writeFileSync(join(wt, 'a.txt'), 'a')
    git('-C', wt, 'add', 'a.txt')
    git('-C', wt, 'commit', '-q', '-m', 'fix(x): 같은 제목 (#1)')
    // 원격의 다른 브랜치에 같은 제목으로 다른 해시의 커밋을 올린다
    git('-C', repo, 'checkout', '-q', '-b', 'rebased', 'origin/main')
    git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'fix(x): 같은 제목 (#1)')
    git('-C', repo, 'push', '-q', 'origin', 'rebased')
    const r = removeWorktree({})
    assert.equal(r.code, 0, r.out)
    assert.equal(existsSync(wt), false)
  })

  test('squash 머지는 제목이 달라 --merged-head 없이는 거부하고, 주면 지운다', () => {
    writeFileSync(join(wt, 'a.txt'), 'a')
    git('-C', wt, 'add', 'a.txt')
    git('-C', wt, 'commit', '-q', '-m', '작업 내용')
    const head = git('-C', wt, 'rev-parse', 'HEAD')
    // 원격 main 에 같은 변경을 PR 제목으로 한 커밋으로 올린다
    writeFileSync(join(repo, 'a.txt'), 'a')
    git('-C', repo, 'add', 'a.txt')
    git('-C', repo, 'commit', '-q', '-m', 'feat: PR 제목 (#2)')
    git('-C', repo, 'push', '-q', 'origin', 'main')
    const refused = removeWorktree({})
    assert.equal(refused.code, 1, refused.out)
    has(refused.out, `거부: ${wt} 에 원격에 없는 커밋 1 개`)
    assert.equal(existsSync(wt), true)
    const removed = removeWorktree({}, ['--merged-head', head])
    assert.equal(removed.code, 0, removed.out)
    assert.equal(existsSync(wt), false)
  })

  test('HEAD 가 --merged-head 의 조상이 아니면 거부한다', () => {
    const other = git('-C', repo, 'rev-parse', 'HEAD')
    writeFileSync(join(wt, 'a.txt'), 'a')
    git('-C', wt, 'add', 'a.txt')
    git('-C', wt, 'commit', '-q', '-m', '작업 내용')
    const r = removeWorktree({}, ['--merged-head', other])
    assert.equal(r.code, 1, r.out)
    has(r.out, '조상도 아니다')
    assert.equal(existsSync(wt), true)
  })

  test('커밋 안 된 변경이 있으면 거부한다', () => {
    writeFileSync(join(wt, 'a.txt'), 'a')
    const r = removeWorktree({})
    assert.equal(r.code, 1, r.out)
    has(r.out, '커밋 안 된 변경')
    assert.equal(existsSync(wt), true)
  })
})

describe('터미널 소유 상태', () => {
  const owned = (state: string) => [{ agentTerminalHandle: 't', resource: { terminalHandle: 't', ownershipState: state } }]

  test('사용자 보유 터미널이 있으면 남긴다', () => {
    const r = removeWorktree({ terminals: [{ handle: 't', worktreePath: wt }], workers: owned('user_owned') })
    assert.equal(r.code, 1, r.out)
    assert.equal(r.stdout, `남김: 사용자 보유 터미널 (${wt})\n`)
    assert.equal(existsSync(wt), true)
  })

  test('소유 상태를 읽지 못하면 남긴다', () => {
    const r = removeWorktree({ orcaFail: true })
    assert.equal(r.code, 1, r.out)
    has(r.out, `남김: 터미널 소유 상태 조회 실패 (${wt})`)
    assert.equal(existsSync(wt), true)
  })

  test('기다리는 사이에 사용자가 넘겨받은 터미널은 삭제 직전 확인으로 남긴다', () => {
    const r = removeWorktree({
      procs: [proc(41, HOOK, { gone: 2 })],
      terminals: [{ handle: 't', worktreePath: wt }],
      workers: owned('owned'),
      takeoverAt: 1,
    })
    assert.equal(r.code, 1, r.out)
    assert.equal(r.slept, 2)
    has(r.out, `남김: 사용자 보유 터미널 (${wt})`)
    assert.equal(existsSync(wt), true)
  })

  test('owned 터미널만 있으면 지우고 --delete-branch 로 브랜치도 지운다', () => {
    const r = removeWorktree({ terminals: [{ handle: 't', worktreePath: wt }], workers: owned('owned') }, ['--delete-branch'])
    assert.equal(r.code, 0, r.out)
    has(r.out, `removed ${wt}`)
    has(r.out, 'deleted branch feat')
    assert.equal(existsSync(wt), false)
    assert.equal(spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '-q', 'refs/heads/feat'], { env }).status, 1)
  })
})

describe('detached 워크트리의 브랜치', () => {
  function branchExists(name: string): boolean {
    return spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '-q', `refs/heads/${name}`], { env }).status === 0
  }

  // 리뷰 worker 처럼 review/pr-7 브랜치로 만든 워크트리에서 PR head 를 detached 로 꺼낸다. PR head 는 원격의 다른 브랜치(topic)에도 있다
  function detachToPrHead(branch = 'review/pr-7'): void {
    git('-C', wt, 'branch', '-m', branch)
    const other = join(tmp, 'other')
    git('clone', '-q', join(tmp, 'origin.git'), other)
    git('-C', other, 'commit', '-q', '--allow-empty', '-m', 'pr head')
    git('-C', other, 'push', '-q', 'origin', 'HEAD:refs/heads/topic', 'HEAD:refs/pull/7/head')
    git('-C', wt, 'fetch', '-q', 'origin')
    git('-C', wt, 'fetch', '-q', 'origin', 'refs/pull/7/head')
    git('-C', wt, 'checkout', '-q', '--detach', 'FETCH_HEAD')
  }

  const merged = { prViews: { 7: { state: 'MERGED', headRefOid: 'x' } } }

  test('--delete-branch 는 PR 이 닫히고 리뷰가 끝났으면 detached 워크트리를 만든 리뷰 브랜치를 지운다', () => {
    detachToPrHead()
    const r = removeWorktree(merged, ['--delete-branch'])
    assert.equal(r.code, 0, r.out)
    has(r.out, 'deleted branch review/pr-7')
    assert.equal(branchExists('review/pr-7'), false)
  })

  test('--delete-branch 가 없으면 detached 워크트리를 만든 브랜치를 남긴다', () => {
    detachToPrHead()
    const r = removeWorktree(merged)
    assert.equal(r.code, 0, r.out)
    lacks(r.out, 'deleted branch')
    assert.equal(branchExists('review/pr-7'), true)
  })

  test('PR 이 열려 있으면 리뷰 브랜치를 남긴다', () => {
    detachToPrHead()
    const r = removeWorktree({ prViews: { 7: { state: 'OPEN' } } }, ['--delete-branch'])
    assert.equal(r.code, 0, r.out)
    has(r.out, `removed ${wt}`)
    has(r.out, '브랜치 남김 review/pr-7: PR 이 열려 있다')
    assert.equal(branchExists('review/pr-7'), true)
  })

  test('PR 을 읽지 못하면 리뷰 브랜치를 남긴다', () => {
    detachToPrHead()
    const r = removeWorktree({}, ['--delete-branch'])
    has(r.out, '브랜치 남김 review/pr-7: PR 을 읽지 못했다')
    assert.equal(branchExists('review/pr-7'), true)
  })

  test('살아 있는 dispatch 가 그 PR 의 리뷰 지시서를 쓰면 리뷰 브랜치를 남긴다', () => {
    detachToPrHead()
    const spec = join(tmp, 'spec-review-pr-7-2.md')
    writeFileSync(spec, '# 다시 리뷰\n')
    const state = { ...merged, workers: [{ taskId: 'task_r', dispatchStatus: 'running', resource: { ownershipState: 'owned' } }], tasks: [{ id: 'task_r', status: 'running', spec: `지시서 ${spec}` }] }
    const r = removeWorktree(state, ['--delete-branch'])
    has(r.out, '브랜치 남김 review/pr-7: 리뷰 dispatch 가 살아 있다')
    assert.equal(branchExists('review/pr-7'), true)
  })

  test('살아 있는 지시서 목록을 읽지 못하면 리뷰 브랜치를 남긴다', () => {
    detachToPrHead()
    const r = removeWorktree({ ...merged, tasksFail: true }, ['--delete-branch'])
    has(r.out, '브랜치 남김 review/pr-7: 살아 있는 지시서 목록을 읽지 못했다')
    assert.equal(branchExists('review/pr-7'), true)
  })

  test('리뷰 브랜치 이름이 아니면 남긴다', () => {
    detachToPrHead('feat')
    const r = removeWorktree(merged, ['--delete-branch'])
    has(r.out, '브랜치 남김 feat: 리뷰 브랜치 이름이 아니다')
    assert.equal(branchExists('feat'), true)
  })

  test('그 브랜치에 원격에 없는 커밋이 있으면 남기고 이유를 낸다', () => {
    git('-C', wt, 'commit', '-q', '--allow-empty', '-m', 'local only')
    detachToPrHead()
    const r = removeWorktree(merged, ['--delete-branch'])
    assert.equal(r.code, 0, r.out)
    has(r.out, `removed ${wt}`)
    has(r.out, '브랜치 남김 review/pr-7: 원격에 없는 커밋 1 개')
    assert.equal(branchExists('review/pr-7'), true)
  })

  test('처음부터 detached 로 만든 워크트리는 지울 브랜치가 없다', () => {
    git('-C', repo, 'worktree', 'remove', wt)
    git('-C', repo, 'worktree', 'add', '-q', '--detach', wt, 'origin/main')
    const r = removeWorktree(merged, ['--delete-branch'])
    assert.equal(r.code, 0, r.out)
    lacks(r.out, 'deleted branch')
    lacks(r.out, '브랜치 남김')
  })
})

describe('Docker 자원', () => {
  function box(id: string, dir: string) {
    return { Id: id, Name: `/${id}`, Image: 'sha256:x', State: { Running: true }, Config: { Labels: { 'com.docker.compose.project.working_dir': dir } } }
  }
  function dockerCalls(): string[] {
    return (JSON.parse(readFileSync(stateFile, 'utf8')) as { dockerCalls?: string[] }).dockerCalls ?? []
  }

  test('워크트리를 지운 뒤 그 아래에서 띄운 compose 컨테이너만 지운다', () => {
    const r = removeWorktree({ docker: { containers: [box('mine', join(wt, 'infra')), box('other', join(tmp, 'company'))] } })
    assert.equal(r.code, 0, r.out)
    has(r.out, `removed ${wt}`)
    has(r.out, 'Docker 컨테이너 삭제 mine (mine)')
    const calls = dockerCalls()
    assert.ok(calls.includes('rm -f -v mine'), calls.join('\n'))
    assert.ok(!calls.some((c) => c.startsWith('rm') && c.includes('other')), calls.join('\n'))
  })

  test('Docker 데몬이 꺼져 있으면 경고 한 줄을 내고 0 이다', () => {
    const r = removeWorktree({ dockerDown: true })
    assert.equal(r.code, 0, r.out)
    has(r.out, 'Docker 정리 건너뜀: 컨테이너 목록을 읽지 못했다 (Cannot connect to the Docker daemon')
    assert.equal(existsSync(wt), false)
  })

  test('거부하면 docker 를 부르지 않는다', () => {
    writeFileSync(join(wt, 'dirty.txt'), 'x')
    const r = removeWorktree({ docker: { containers: [box('mine', wt)] } })
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(dockerCalls(), [])
  })
})

describe('옛 경로', () => {
})
