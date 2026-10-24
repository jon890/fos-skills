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
const SHIM = fileURLToPath(new URL('../scripts/remove-worktree.py', import.meta.url))
const HOOK = 'node /x/oh-my-claudecode/dist/hooks/session-end/worker.js --omc-session-end-worker {}'

type Proc = { pid: number; cwd: string; command: string; gone?: number; ppid?: number }
type State = { procs?: Proc[]; terminals?: unknown[]; workers?: unknown[]; takeoverAt?: number; orcaFail?: boolean }

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
if (argv.includes('terminal') && argv.includes('list')) console.log(JSON.stringify({ result: { terminals: st.terminals || [] } }))
else if (argv.includes('worker-list')) console.log(JSON.stringify({ result: { scope: { source: 'all' }, workers: st.workers || [], page: {} } }))
else console.log(JSON.stringify({ ok: true, result: {} }))
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

function proc(pid: number, command: string, opts: { gone?: number; ppid?: number } = {}): Proc {
  return { pid, cwd: wt, command, ...opts }
}

type Launch = 'node' | 'bash' | 'shim'

function removeWorktree(state: State, args: string[] = [], opts: { hookWait?: number; launch?: Launch } = {}) {
  writeFileSync(stateFile, JSON.stringify({ slept: 0, ...state }))
  const runEnv = { ...env }
  if (opts.hookWait !== undefined) runEnv.ORCH_HOOK_WAIT = String(opts.hookWait)
  const node = [process.execPath, '--disable-warning=ExperimentalWarning', SCRIPT, wt, ...args]
  const command =
    opts.launch === 'bash'
      ? ['bash', '-c', 'exec "$@"', 'remove-worktree', ...node]
      : opts.launch === 'shim'
        ? ['python3', SHIM, wt, ...args]
        : node
  const done = spawnSync(command[0], command.slice(1), { env: runEnv, encoding: 'utf8' })
  const slept = (JSON.parse(readFileSync(stateFile, 'utf8')) as { slept: number }).slept
  return { code: done.status, stdout: done.stdout, out: done.stdout + done.stderr, slept }
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

describe('옛 경로', () => {
  test('remove-worktree.py 는 DEPRECATED 줄을 내고 같은 판정으로 지운다', () => {
    const r = removeWorktree({}, ['--delete-branch'], { launch: 'shim' })
    assert.equal(r.code, 0, r.out)
    has(r.out, 'DEPRECATED python3 remove-worktree.py')
    has(r.stdout, `removed ${wt}`)
    assert.equal(existsSync(wt), false)
  })
})
