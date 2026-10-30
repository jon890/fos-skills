// finish-pr.ts 를 임시 git 저장소와 가짜 gh, orca, 업무 명령, 정리 스크립트, 보드 명령으로 돌려 본다.
//
// 실제 GitHub, Orca, 업무 시스템에는 닿지 않는다. 워크트리와 브랜치는 모두 임시 저장소의 것이다.
// 판정(배포 판정, 업무 번호 뽑기, 브랜치 줄, 워크트리 찾기)은 명령을 돌려 출력과 남은 파일로 본다.
// 가짜 gh, orca, 업무 명령은 이 테스트를 도는 node 를 shebang 에 박은 실행 파일이다(tests/fixtures/merge-queue-fakes.ts 의 writeNodeBin).
// 가짜 정리 스크립트와 보드 명령은 `.py` 라 확장자대로 python3 로 돈다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawnDone, writeNodeBin } from './fixtures/merge-queue-fakes.ts'
import type { Done } from './fixtures/merge-queue-fakes.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/finish-pr.ts', import.meta.url))
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning', SCRIPT]
// 정리 스크립트를 다시 부르는 횟수. finish-pr.ts 의 동작 규칙 값이다
const CLEANUP_TRIES = 5

// 받은 인자를 FAKE_LOG 에 `이름 인자...` 한 줄로 적는다. 출력은 macOS 의 비동기 파이프에서도 다 나가게 writeSync 로 쓴다
const LOG = `const fs = require('node:fs')
const args = process.argv.slice(2)
const say = (fd, text) => fs.writeSync(fd, text + '\\n')
`
const FAKE_GH = `${LOG}fs.appendFileSync(process.env.FAKE_LOG, 'gh ' + args.join(' ') + '\\n')
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'))
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = state.pr
  say(1, JSON.stringify({ number: Number(args[2]), state: pr.state, mergeCommit: pr.merge ? { oid: pr.merge } : null, headRefName: pr.branch,
    title: pr.title, headRefOid: pr.head, author: { login: 'me' }, isDraft: false, url: 'https://git.example.com/owner/repo/pull/' + args[2], baseRefName: 'main' }))
  process.exit(0)
}
// 마지막 PR 판정의 조회. 열린 PR 은 state.open, --head 의 MERGED PR 은 state.merged(브랜치 목록)에 있는지로 답한다
if (args[0] === 'pr' && args[1] === 'list') {
  if (state.listFails) process.exit(1)
  const head = args.includes('--head') ? args[args.indexOf('--head') + 1] : null
  say(1, JSON.stringify(head === null ? state.open || [] : (state.merged || []).includes(head) ? [{ number: 1 }] : []))
  process.exit(0)
}
if (args[0] === 'run' && args[1] === 'list') {
  say(1, JSON.stringify(state.runs))
  process.exit(0)
}
process.exit(3)
`
// 업무 완료 명령. 받은 argv 를 FAKE_ARGV 에 JSON 한 줄로 더 적는다. 공백이 든 인자를 구별하려는 것이다
const FAKE_TASK = `${LOG}fs.appendFileSync(process.env.FAKE_LOG, 'task-cli ' + args.join(' ') + '\\n')
if (process.env.FAKE_ARGV) fs.appendFileSync(process.env.FAKE_ARGV, JSON.stringify(args) + '\\n')
say(1, 'done ' + args.join(' '))
process.exit(Number(process.env.FAKE_EXIT_TASK_CLI || '0'))
`
// orca orchestration worker-list, task-list. 상태의 orca 칸(workers, tasks, fails)으로 답한다
const FAKE_ORCA = `${LOG}fs.appendFileSync(process.env.FAKE_LOG, 'orca ' + args.join(' ') + '\\n')
const orca = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8')).orca || {}
if (orca.fails) process.exit(1)
if (args.includes('worker-list')) say(1, JSON.stringify({ ok: true, result: { workers: orca.workers || [], scope: { source: 'all' } } }))
else if (args.includes('task-list')) say(1, JSON.stringify({ ok: true, result: { tasks: orca.tasks || [] } }))
else process.exit(3)
`
const FAKE_SWEEP = `import os, subprocess, sys
open(os.environ["FAKE_LOG"], "a").write("sweep " + " ".join(sys.argv[1:]) + "\\n")
if os.environ.get("FAKE_SWEEP_REMOVES") == "1":
    wt = os.environ["FAKE_WORKTREE"]
    repo = sys.argv[sys.argv.index("--repo") + 1]
    subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", wt], check=True, capture_output=True)
    subprocess.run(["git", "-C", repo, "branch", "-D", os.environ["FAKE_BRANCH"]], check=True, capture_output=True)
`
// worker 에게 보내는 명령. 받은 인자를 적고, FAKE_SEND_ENDS 면 상태의 worker 를 끝난 것(succeeded)으로 바꾼 뒤 FAKE_SEND_EXIT 로 끝난다
const FAKE_SEND = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_LOG, 'send-to-worker ' + process.argv.slice(2).join(' ') + '\\n')
if (process.env.FAKE_SEND_ENDS === '1') {
  const state = JSON.parse(readFileSync(process.env.FAKE_STATE, 'utf8'))
  for (const row of state.orca.workers) row.dispatchStatus = 'succeeded'
  writeFileSync(process.env.FAKE_STATE, JSON.stringify(state))
}
console.log('replied: m_1 에 답했다 (msg_new)')
process.exit(Number(process.env.FAKE_SEND_EXIT || '0'))
`
// steps 는 FAKE_STEPS(JSON, 없으면 빈 목록)를 낸다
const FAKE_BOARD = `import os, sys
open(os.environ["FAKE_LOG"], "a").write("board " + " ".join(sys.argv[1:]) + "\\n")
if sys.argv[1:2] == ["steps"]:
    print(os.environ.get("FAKE_STEPS", "[]"))
`

const PATTERN = '^\\[?(PROJ-[0-9]+)'
const COMPLETE = ['--complete', '--task-pattern', PATTERN]

type Json = Record<string, unknown>
type Ctx = {
  tmp: string
  repo: string
  wt: string
  specs: string
  merge: string
  later: string
  init: string
  bin: string
  state: { pr: Json; runs: Json[]; orca?: Json; open?: Json[]; merged?: string[]; listFails?: boolean }
  env: NodeJS.ProcessEnv
  finish: (args: string[], env?: Record<string, string>) => Promise<Done>
  calls: () => string[]
  git: (...args: string[]) => string
}

let bindir = ''
before(() => {
  bindir = mkdtempSync(join(tmpdir(), 'finish-pr-bin-'))
  writeNodeBin(bindir, 'gh', FAKE_GH)
  writeNodeBin(bindir, 'task-cli', FAKE_TASK)
  writeNodeBin(bindir, 'orca', FAKE_ORCA)
  writeFileSync(join(bindir, 'sweep.py'), FAKE_SWEEP)
  writeFileSync(join(bindir, 'send.ts'), FAKE_SEND)
  writeFileSync(join(bindir, 'board.py'), FAKE_BOARD)
})
after(() => rmSync(bindir, { recursive: true, force: true }))

function setup(t: TestContext): Ctx {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'finish-pr-')))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    GH: join(bindir, 'gh'),
    ORCA: join(bindir, 'orca'),
    CLEANUP_SWEEP: join(bindir, 'sweep.py'),
    SEND_TO_WORKER: join(bindir, 'send.ts'),
    FAKE_STATE: join(tmp, 'state.json'),
    FAKE_LOG: join(tmp, 'log.txt'),
    PATH: `${bindir}:${process.env.PATH}`,
    FAKE_SWEEP_REMOVES: '1',
  }
  for (const key of ['ORCH_DIR', 'BOARD_BIN', 'GH_HOST', 'GIT', 'FAKE_ARGV', 'FAKE_SEND_ENDS', 'FAKE_SEND_EXIT']) delete env[key]
  const sh = (cmd: string[]): string => {
    const done = spawnSync(cmd[0], cmd.slice(1), { env, encoding: 'utf8' })
    assert.equal(done.status, 0, `${cmd.join(' ')}: ${done.stderr}`)
    return done.stdout.trim()
  }
  const origin = join(tmp, 'origin.git')
  const repo = join(tmp, 'repo')
  const git = (...args: string[]) => sh(['git', '-C', repo, ...args])
  sh(['git', 'init', '-q', '--bare', '-b', 'main', origin])
  sh(['git', 'clone', '-q', origin, repo])
  git('commit', '-q', '--allow-empty', '-m', 'init')
  const init = git('rev-parse', 'HEAD')
  git('push', '-q', '-u', 'origin', 'main')
  const branch = 'feat/x'
  const wt = join(tmp, 'wt')
  git('worktree', 'add', '-q', '-b', branch, wt, 'origin/main')
  git('-C', wt, 'commit', '-q', '--allow-empty', '-m', 'work')
  git('push', '-q', '-u', 'origin', branch)
  git('checkout', '-q', '--detach', 'origin/main')
  git('merge', '-q', '--no-ff', '-m', 'merge feat/x', branch)
  const merge = git('rev-parse', 'HEAD')
  git('checkout', '-q', '-B', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'later')
  const later = git('rev-parse', 'HEAD')
  git('push', '-q', 'origin', 'main')
  env.FAKE_WORKTREE = wt
  env.FAKE_BRANCH = branch
  const specs = join(tmp, 'specs')
  mkdirSync(specs)
  writeFileSync(join(specs, 'spec-x.md'), `# x\n브랜치: \`${branch}\`\n`)
  writeFileSync(join(specs, 'spec-y.md'), '# y\n브랜치: `feat/other`\n')
  const c: Ctx = {
    tmp,
    repo,
    wt,
    specs,
    merge,
    later,
    init,
    bin: bindir,
    state: {
      pr: { state: 'MERGED', merge, branch, title: '[PROJ-123] 로그인 고침', head: 'f'.repeat(40) },
      runs: runs([later, 'completed', 'success'], [merge, 'completed', 'skipped']),
    },
    env,
    finish: (args, extra = {}) => {
      writeFileSync(join(tmp, 'state.json'), JSON.stringify(c.state))
      return spawnDone(
        [...NODE, '77', '--repo', repo, '--poll-interval', '0.01', '--merge-timeout', '0.005', '--deploy-timeout', '0.005', ...args],
        { env: { ...env, ...extra } },
      )
    },
    calls: () => (existsSync(join(tmp, 'log.txt')) ? readFileSync(join(tmp, 'log.txt'), 'utf8').split('\n').filter((line) => line) : []),
    git,
  }
  return c
}

function runs(...rows: [string, string, string | null][]): Json[] {
  return rows.map(([headSha, status, conclusion]) => ({ headSha, status, conclusion }))
}

function both(r: Done): string {
  return `종료 코드 ${r.code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`
}

function has(text: string, part: string, detail = text): void {
  assert.ok(text.includes(part), `${JSON.stringify(part)} 가 없다:\n${detail}`)
}

function lacks(text: string, part: string, detail = text): void {
  assert.ok(!text.includes(part), `${JSON.stringify(part)} 가 있으면 안 된다:\n${detail}`)
}

function lastLine(r: Done): string {
  return r.stdout.trimEnd().split('\n').at(-1) ?? ''
}

function starting(calls: string[], prefix: string): string[] {
  return calls.filter((line) => line.startsWith(prefix))
}

function hook(c: Ctx, body: string): void {
  mkdirSync(join(c.repo, '.orch', 'hooks'), { recursive: true })
  writeFileSync(join(c.repo, '.orch', 'hooks', 'after-deploy.ts'), body)
}

// 받은 입력을 file 에 한 줄씩 덧붙이고 code 로 끝나는 핸들러 본문
function recorder(file: string, code = 0): string {
  return [
    "import { appendFileSync, readFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(file)}, JSON.stringify(JSON.parse(readFileSync(0, 'utf8'))) + '\\n')`,
    `process.exit(${code})`,
  ].join('\n')
}

function taskCompleter(): string {
  return "import { readFileSync } from 'node:fs'\nimport { spawnSync } from 'node:child_process'\nif (!JSON.parse(readFileSync(0, 'utf8')).last_of_task) process.exit(0)\nconst done = spawnSync('task-cli', ['complete', 'PROJ-123'], { stdio: 'inherit' })\nprocess.exit(done.status ?? 1)\n"
}

function inputs(file: string): Json[] {
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line)
        .map((line) => JSON.parse(line) as Json)
    : []
}

const DEPLOY = ['--deploy-workflow', 'deploy.yml', '--deploy-branch', 'main']

describe('finish-pr 흐름', { concurrency: 4 }, () => {
  test('worker 를 정리하고 배포를 기다리고 업무를 완료 처리하고 보드를 바꾼다', async (t) => {
    const c = setup(t)
    hook(c, taskCompleter())
    const r = await c.finish([
      '--run',
      'run_1',
      '--specs-dir',
      c.specs,
      ...DEPLOY,
      ...COMPLETE,
      '--board',
      join(c.tmp, 'board.json'),
      '--board-id',
      'item-1',
      '--board-bin',
      join(c.bin, 'board.py'),
    ])
    assert.equal(r.code, 0, both(r))
    assert.equal(lastLine(r), 'FINISH-DONE', both(r))
    assert.equal(existsSync(c.wt), false)
    assert.equal(c.git('branch', '--list', 'feat/x'), '')
    assert.equal(existsSync(join(c.specs, 'spec-x.md')), false)
    assert.equal(existsSync(join(c.specs, 'spec-y.md')), true)
    const calls = c.calls()
    const sweep = starting(calls, 'sweep ')[0]
    for (const part of ['--apply', '--run run_1', '--kill-holders']) has(sweep, part)
    assert.ok(calls.includes('task-cli complete PROJ-123'), calls.join('\n'))
    const board = calls.findLastIndex((line) => line.startsWith('board ') && line.includes('set item-1 done'))
    assert.ok(board >= 0, calls.join('\n'))
    assert.ok(calls.indexOf('task-cli complete PROJ-123') < board, calls.join('\n'))
    has(r.stdout, `배포 성공 ${c.later.slice(0, 9)}`)
  })

  test('중간 PR 은 지시서를 남긴다', async (t) => {
    const c = setup(t)
    const r = await c.finish(['--specs-dir', c.specs])
    assert.equal(r.code, 0, both(r))
    assert.equal(existsSync(join(c.specs, 'spec-x.md')), true)
    assert.equal(existsSync(join(c.specs, 'spec-y.md')), true)
    has(r.stdout, '지시서 유지')
    assert.deepEqual(starting(c.calls(), 'orca '), [])
  })

  test('중간 PR 이어도 orch 루트의 그 PR 충돌 후속 지시서는 옛 이름까지 지우고 다른 PR 의 것은 남긴다', async (t) => {
    const c = setup(t)
    const specs = join(c.repo, '.orch/specs')
    mkdirSync(specs, { recursive: true })
    for (const name of ['spec-conflict-77.md', 'spec-conflict-77-0123abcd.md', 'spec-conflict-771.md']) {
      writeFileSync(join(specs, name), '# 충돌\n브랜치: `feat/x`\n중간 과정: PR #77\n')
    }
    const r = await c.finish(['--intermediate'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '마지막 PR 판정: 중간')
    assert.equal(existsSync(join(specs, 'spec-conflict-77.md')), false, both(r))
    assert.equal(existsSync(join(specs, 'spec-conflict-77-0123abcd.md')), false, both(r))
    assert.equal(existsSync(join(specs, 'spec-conflict-771.md')), true, both(r))
    assert.equal(existsSync(join(c.specs, 'spec-x.md')), true)
  })

  test('마지막 PR 은 줄 머리의 브랜치 줄이 그 브랜치인 지시서만 지운다', async (t) => {
    const c = setup(t)
    writeFileSync(join(c.specs, 'spec-bold.md'), '# 지시서\n- **브랜치:** `feat/x`\n')
    writeFileSync(join(c.specs, 'spec-prose.md'), '# 지시서\n본문에서 브랜치: `feat/x` 라고 말한다\n브랜치: `feat/b`\n')
    writeFileSync(join(c.specs, 'other-x.md'), '브랜치: `feat/x`\n')
    const r = await c.finish(['--specs-dir', c.specs, ...COMPLETE])
    assert.equal(r.code, 0, both(r))
    assert.equal(existsSync(join(c.specs, 'spec-x.md')), false)
    assert.equal(existsSync(join(c.specs, 'spec-bold.md')), false)
    assert.equal(existsSync(join(c.specs, 'spec-prose.md')), true)
    assert.equal(existsSync(join(c.specs, 'spec-y.md')), true)
    assert.equal(existsSync(join(c.specs, 'other-x.md')), true)
    has(r.stdout, `지시서 삭제 ${join(c.specs, 'spec-x.md')}`)
  })

  test('--specs-dir 가 orch 루트 밖이어도 지운다. 상대경로는 --repo 기준이고 링크인 폴더도 같다', async (t) => {
    const c = setup(t)
    // 지시서 폴더는 orch 루트(<repo>/.orch) 밖의 임시 폴더다. 그 폴더를 가리키는 링크를 저장소 안에 둔다
    symlinkSync(c.specs, join(c.repo, 'linked-specs'))
    const r = await c.finish(['--specs-dir', 'linked-specs', '--complete'])
    assert.equal(r.code, 0, both(r))
    assert.equal(existsSync(join(c.specs, 'spec-x.md')), false, both(r))
    assert.equal(existsSync(join(c.specs, 'spec-y.md')), true)
  })

  test('PR head 이름으로 워크트리가 보이지 않아도 정리 스크립트를 한 번은 돌린다', async (t) => {
    const c = setup(t)
    // feat 는 feat/x 의 앞부분이라 워크트리 목록의 branch refs/heads/feat/x 줄과 같은 브랜치로 보면 안 된다
    for (const branch of ['other/name', 'feat']) {
      rmSync(join(c.tmp, 'log.txt'), { force: true })
      c.state.pr.branch = branch
      const r = await c.finish(['--run', 'run_1'], { FAKE_SWEEP_REMOVES: '0' })
      assert.equal(r.code, 0, `${branch}: ${both(r)}`)
      assert.equal(starting(c.calls(), 'sweep ').length, 1, branch)
      lacks(r.stdout, '정리 남음', branch)
    }
  })

  test('after-deploy 핸들러가 없어도 --complete 면 지시서를 지운다', async (t) => {
    const c = setup(t)
    const r = await c.finish(['--specs-dir', c.specs, '--complete'])
    assert.equal(r.code, 0, both(r))
    assert.equal(lastLine(r), 'FINISH-DONE', both(r))
    lacks(r.stdout, '지시서 유지')
    assert.equal(existsSync(join(c.specs, 'spec-x.md')), false)
    assert.equal(existsSync(join(c.specs, 'spec-y.md')), true)
    assert.deepEqual(starting(c.calls(), 'task-cli'), [])
  })

  test('중간 PR 이면 after-deploy 핸들러를 업무 완료로 부르지 않는다', async (t) => {
    const c = setup(t)
    hook(c, taskCompleter())
    const r = await c.finish(['--intermediate', '--task-pattern', PATTERN])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(starting(c.calls(), 'task-cli'), [])
    lacks(r.stdout, 'DEPRECATED')
  })

  test('머지 없이 닫힌 PR 은 FINISH-FAIL 이고 아무것도 정리하지 않는다', async (t) => {
    const c = setup(t)
    Object.assign(c.state.pr, { state: 'CLOSED', merge: null })
    const r = await c.finish(['--run', 'run_1'])
    assert.equal(r.code, 1, both(r))
    assert.equal(lastLine(r), 'FINISH-FAIL', both(r))
    has(r.stdout, 'PR 77 가 머지 없이 닫혔다')
    assert.equal(existsSync(c.wt), true)
    assert.deepEqual(starting(c.calls(), 'sweep'), [])
  })

  test('열린 채인 PR 은 시간이 지나면 정리하지 않고 FINISH-FAIL 이다', async (t) => {
    const c = setup(t)
    Object.assign(c.state.pr, { state: 'OPEN', merge: null })
    const r = await c.finish([])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '머지를 기다리다 시간이 지났다')
    has(r.stdout, 'FINISH-FAIL')
    assert.equal(existsSync(c.wt), true)
  })

  test('상대경로 보드는 작업 디렉터리가 아니라 저장소 기준이다', async (t) => {
    const c = setup(t)
    const r = await c.finish(['--board', 'boards/main.json', '--board-id', 'item-1', '--board-bin', join(c.bin, 'board.py')])
    assert.equal(r.code, 0, both(r))
    const board = starting(c.calls(), 'board ')
    assert.equal(board.length, 1, board.join('\n'))
    assert.ok(board[0].endsWith(`--file ${c.repo}/boards/main.json`), board[0])
  })

  test('BOARD_BIN 이 없으면 저장소의 work-board/bin/board.ts 가 보드 항목을 done 으로 바꾼다', async (t) => {
    const c = setup(t)
    const file = join(c.tmp, 'board.json')
    writeFileSync(file, JSON.stringify({ items: [{ id: 'item-1', status: 'wait', title: '로그인', pr: '#77' }, { id: 'item-2', status: 'wait', title: '다른 일' }] }))
    const r = await c.finish(['--board', file, '--board-id', 'item-1'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '보드 item-1 done')
    const items = (JSON.parse(readFileSync(file, 'utf8')) as { items: Json[] }).items
    assert.equal(items.find((item) => item.id === 'item-1')?.status, 'done', JSON.stringify(items))
    assert.equal(items.find((item) => item.id === 'item-2')?.status, 'wait', JSON.stringify(items))
  })

  test('정리 스크립트가 지우지 못한 워크트리는 알리고 흐름을 이어 간다', async (t) => {
    const c = setup(t)
    const r = await c.finish(DEPLOY, { FAKE_SWEEP_REMOVES: '0' })
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '정리 남음')
    assert.equal(starting(c.calls(), 'sweep').length, CLEANUP_TRIES)
    assert.equal(existsSync(c.wt), true)
  })

  test('설정 파일이 옵션을 채우고 명령줄이 우선한다', async (t) => {
    const c = setup(t)
    const cfg = join(c.tmp, 'config.json')
    writeFileSync(cfg, JSON.stringify({ finish: { run: 'run_cfg', deploy_workflow: 'deploy.yml', deploy_branch: 'main' }, cleanup: { trash: '/nowhere' } }))
    const r = await c.finish(['--config', cfg, '--run', 'run_cli'])
    assert.equal(r.code, 0, both(r))
    has(starting(c.calls(), 'sweep ')[0], '--run run_cli')
    assert.ok(c.calls().some((line) => line.startsWith('gh run list --branch main --workflow deploy.yml')), c.calls().join('\n'))
  })

  test('설정 파일이 없으면 저장소의 .orch/config.json 을 읽는다', async (t) => {
    const c = setup(t)
    mkdirSync(join(c.repo, '.orch'))
    writeFileSync(join(c.repo, '.orch', 'config.json'), JSON.stringify({ finish: { run: 'run_default', sweep_arg: ['--a'] } }))
    const r = await c.finish(['--sweep-arg=--b'])
    assert.equal(r.code, 0, both(r))
    const sweep = starting(c.calls(), 'sweep ')[0]
    has(sweep, '--run run_default')
    // sweep_arg 는 설정의 목록 뒤에 명령줄의 값을 잇는다
    assert.ok(sweep.endsWith('--a --b'), sweep)
  })

  test('옵션은 고유 접두로 줄여 쓸 수 있고, 여러 옵션의 접두면 사용법 오류다', async (t) => {
    const c = setup(t)
    const r = await c.finish(['--specs', c.specs, '--complete', '--deploy-w', 'deploy.yml', '--deploy-b=main'])
    assert.equal(r.code, 0, both(r))
    assert.equal(existsSync(join(c.specs, 'spec-x.md')), false)
    assert.ok(c.calls().some((line) => line.startsWith('gh run list --branch main --workflow deploy.yml')), c.calls().join('\n'))
  })

  test('pid 파일은 도는 동안 쓰고 끝나면 지운다', async (t) => {
    const c = setup(t)
    const pidFile = join(c.tmp, 'queue', 'finish-77.pid')
    const r = await c.finish(['--pid-file', pidFile])
    assert.equal(r.code, 0, both(r))
    assert.equal(existsSync(pidFile), false)
    assert.equal(existsSync(join(c.tmp, 'queue')), true)
  })
})

describe('finish-pr 사용법 오류', { concurrency: 4 }, () => {
  test('머지를 기다리기 전에 종료 코드 2 로 끝난다', async (t) => {
    const c = setup(t)
    for (const extra of [
      ['--deploy-workflow', 'deploy.yml'],
      ['--complete-cmd', 'task-cli complete {number}'],
      ['--task-pattern', '('],
      ['--merge-timeout', 'soon'],
      ['--nope'],
    ]) {
      const r = await c.finish(extra)
      assert.equal(r.code, 2, `${extra.join(' ')}: ${both(r)}`)
    }
    const cfg = join(c.tmp, 'bad.json')
    writeFileSync(cfg, JSON.stringify({ finish: { typo_key: 1 } }))
    const r = await c.finish(['--config', cfg])
    assert.equal(r.code, 2, both(r))
    has(r.stderr, 'typo_key')
    assert.deepEqual(starting(c.calls(), 'gh '), [])
  })

  test('삭제한 --complete-cmd 와 finish.complete_cmd 는 머지를 기다리지 않고 2 로 끝난다', async (t) => {
    const c = setup(t)
    const r = await c.finish(['--complete-cmd', 'task-cli complete {number}'])
    assert.equal(r.code, 2, both(r))
    has(r.stderr, '--complete-cmd')
    assert.deepEqual(c.calls(), [])
    // 설정 파일의 complete_cmd 는 5.0.0 에서 제거했다
    mkdirSync(join(c.repo, '.orch'), { recursive: true })
    writeFileSync(join(c.repo, '.orch', 'config.json'), JSON.stringify({ finish: { complete_cmd: 'task-cli complete {number}', task_pattern: PATTERN } }))
    const again = await c.finish(['--complete'])
    assert.equal(again.code, 2, both(again))
    has(again.stderr, 'finish.complete_cmd')
    has(again.stderr, 'migrate-orch-dir')
    assert.deepEqual(c.calls(), [])
  })
})

describe('finish-pr 시간 제한 설정', { concurrency: 4 }, () => {
  test('hooks.timeouts.after-deploy 가 틀리면 머지를 기다리지 않고 2 로 끝나고, 핸들러도 업무 완료 명령도 없으면 보지 않는다', async (t) => {
    const c = setup(t)
    mkdirSync(join(c.repo, '.orch'), { recursive: true })
    writeFileSync(join(c.repo, '.orch', 'config.json'), JSON.stringify({ hooks: { timeouts: { 'after-deploy': 0 } } }))
    // after-deploy 를 낼 것이 없으면 값을 읽지 않는다. 옛 명령처럼 머지를 기다린다
    const none = await c.finish([])
    assert.notEqual(none.code, 2, both(none))
    lacks(none.stderr, 'hooks.timeouts.after-deploy')
    for (const args of [COMPLETE, []]) {
      hook(c, recorder(join(c.tmp, `in-${args.length}.jsonl`)))
      const before = c.calls().length
      const r = await c.finish(args)
      assert.equal(r.code, 2, `${args.join(' ')}\n${both(r)}`)
      has(r.stderr, 'hooks.timeouts.after-deploy 는 양수(초)여야 한다')
      assert.deepEqual(c.calls().slice(before), [], '머지를 기다리면 안 된다')
    }
  })
})

describe('finish-pr 배포 판정', { concurrency: 4 }, () => {
  // 머지 커밋(merge), 그 뒤 커밋(later), 머지 커밋보다 앞 커밋(init), 저장소에 없는 커밋(x)의 실행으로 판정을 본다
  const cases: { name: string; runs: (c: Ctx) => Json[]; want: (c: Ctx) => string; deploy: string }[] = [
    { name: '머지 커밋 자신의 성공', runs: (c) => runs([c.merge, 'completed', 'success']), want: (c) => `배포 성공 ${c.merge.slice(0, 9)}`, deploy: 'success' },
    {
      name: '머지 커밋은 skipped, 뒤 커밋이 성공',
      runs: (c) => runs([c.later, 'completed', 'success'], [c.merge, 'completed', 'skipped']),
      want: (c) => `배포 성공 ${c.later.slice(0, 9)}`,
      deploy: 'success',
    },
    {
      name: '머지 커밋은 뒤 실행에 밀려 cancelled, 뒤 커밋이 성공',
      runs: (c) => runs([c.later, 'completed', 'success'], [c.merge, 'completed', 'cancelled']),
      want: (c) => `배포 성공 ${c.later.slice(0, 9)}`,
      deploy: 'success',
    },
    {
      name: 'cancelled 인데 뒤 실행이 아직 돈다',
      runs: (c) => runs([c.later, 'in_progress', null], [c.merge, 'completed', 'cancelled']),
      want: () => '배포를 기다리다 시간이 지났다',
      deploy: 'timeout',
    },
    { name: 'skipped 만 있다', runs: (c) => runs([c.merge, 'completed', 'skipped']), want: () => '배포를 기다리다 시간이 지났다', deploy: 'timeout' },
    {
      name: '성공도 진행 중도 없이 실패가 있다. 저장소에 없는 커밋의 성공은 세지 않는다',
      runs: (c) => runs([c.merge, 'completed', 'failure'], ['0'.repeat(40), 'completed', 'success']),
      want: (c) => `배포 실패 ${c.merge.slice(0, 9)}`,
      deploy: 'failure',
    },
    { name: '머지 커밋보다 앞 커밋의 성공은 세지 않는다', runs: (c) => runs([c.init, 'completed', 'success']), want: () => '배포를 기다리다 시간이 지났다', deploy: 'timeout' },
    { name: '실행이 없다', runs: () => [], want: () => '배포를 기다리다 시간이 지났다', deploy: 'timeout' },
  ]
  for (const item of cases) {
    test(item.name, async (t) => {
      const c = setup(t)
      c.state.runs = item.runs(c)
      const file = join(c.tmp, 'in.jsonl')
      hook(c, recorder(file))
      const r = await c.finish(DEPLOY)
      has(r.stdout, item.want(c), both(r))
      assert.equal(inputs(file)[0]?.deploy, item.deploy, both(r))
      assert.equal(r.code, item.deploy === 'success' ? 0 : 1, both(r))
      assert.equal(lastLine(r), item.deploy === 'success' ? 'FINISH-DONE' : 'FINISH-FAIL', both(r))
    })
  }
})

describe('finish-pr after-deploy', { concurrency: 4 }, () => {
  test('핸들러는 pr, merge_commit, deploy, last_of_task 를 받는다', async (t) => {
    const c = setup(t)
    const file = join(c.tmp, 'in.jsonl')
    hook(c, recorder(file))
    const r = await c.finish(['--complete', '--run', 'run_1', ...DEPLOY])
    assert.equal(r.code, 0, both(r))
    const [input] = inputs(file)
    assert.equal(input.event, 'after-deploy')
    assert.equal(input.deploy, 'success')
    assert.equal(input.last_of_task, true)
    assert.equal(input.merge_commit, c.merge)
    assert.equal(input.base, 'main')
    assert.equal(input.run, 'run_1')
    assert.deepEqual(input.pr, {
      number: 77,
      title: '[PROJ-123] 로그인 고침',
      branch: 'feat/x',
      head: 'f'.repeat(40),
      author: 'me',
      draft: false,
      url: 'https://git.example.com/owner/repo/pull/77',
    })
  })

  test('배포 워크플로가 없으면 deploy 는 none 이고, 중간 PR 의 last_of_task 는 false 다', async (t) => {
    const c = setup(t)
    const file = join(c.tmp, 'in.jsonl')
    hook(c, recorder(file))
    const r = await c.finish([])
    assert.equal(r.code, 0, both(r))
    const [input] = inputs(file)
    assert.equal(input.deploy, 'none')
    assert.equal(input.last_of_task, false)
  })

  test('배포가 실패하면 deploy: failure 를 받고, 업무 완료도 보드도 하지 않고 FINISH-FAIL 이다', async (t) => {
    const c = setup(t)
    c.state.runs = runs([c.merge, 'completed', 'failure'])
    const file = join(c.tmp, 'in.jsonl')
    hook(c, recorder(file))
    const r = await c.finish(['--complete', ...DEPLOY, '--board-id', 'item-1', '--board-bin', join(c.bin, 'board.py')])
    assert.equal(r.code, 1, both(r))
    assert.equal(lastLine(r), 'FINISH-FAIL', both(r))
    const [input] = inputs(file)
    assert.equal(input.deploy, 'failure')
    assert.equal(input.last_of_task, true)
    assert.deepEqual(starting(c.calls(), 'board'), [])
  })

  test('배포가 끝나지 않으면 deploy: timeout 을 받고, 보드를 바꾸지 않고 FINISH-FAIL 이다', async (t) => {
    const c = setup(t)
    c.state.runs = runs([c.merge, 'completed', 'skipped'])
    const file = join(c.tmp, 'in.jsonl')
    hook(c, recorder(file))
    const r = await c.finish([...DEPLOY, '--board-id', 'item-1', '--board-bin', join(c.bin, 'board.py')])
    assert.equal(r.code, 1, both(r))
    assert.equal(lastLine(r), 'FINISH-FAIL', both(r))
    assert.equal(inputs(file)[0]?.deploy, 'timeout')
    assert.deepEqual(starting(c.calls(), 'board'), [])
  })

  test('배포가 실패하면 업무 완료 명령을 돌리지 않는다', async (t) => {
    const c = setup(t)
    c.state.runs = runs([c.merge, 'completed', 'failure'])
    const r = await c.finish([...DEPLOY, '--complete', '--board-id', 'item-1', '--board-bin', join(c.bin, 'board.py')])
    assert.equal(r.code, 1, both(r))
    assert.equal(lastLine(r), 'FINISH-FAIL', both(r))
    has(r.stdout, `배포 실패 ${c.merge.slice(0, 9)}`)
    assert.deepEqual(starting(c.calls(), 'task-cli'), [])
    assert.deepEqual(starting(c.calls(), 'board'), [])
  })

  test('핸들러가 1 로 끝나면 HOOK-FAIL 줄을 내고 보드는 done 으로 바꾸고 FINISH-FAIL 이다', async (t) => {
    const c = setup(t)
    hook(c, recorder(join(c.tmp, 'in.jsonl'), 1))
    const r = await c.finish(['--board-id', 'item-1', '--board-bin', join(c.bin, 'board.py')])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'HOOK-FAIL after-deploy 1')
    has(r.stdout, 'after-deploy 핸들러가 실패했다')
    assert.ok(starting(c.calls(), 'board ').some((line) => line.includes('set item-1 done')), c.calls().join('\n'))
    assert.equal(lastLine(r), 'FINISH-FAIL', both(r))
  })
})

describe('finish-pr 살아 있는 지시서', { concurrency: 4 }, () => {
  test('같은 브랜치의 지시서라도 살아 있는 dispatch 가 쓰면 --complete 에서도 남긴다', async (t) => {
    const c = setup(t)
    const spec = join(c.specs, 'spec-x.md')
    c.state.orca = {
      workers: [{ taskId: 'task_1', dispatchStatus: 'running' }],
      tasks: [{ id: 'task_1', status: 'dispatched', spec: `지시서 ${spec} 를 읽고 시작한다` }],
    }
    const r = await c.finish(['--run', 'run_1', '--specs-dir', c.specs, '--complete'])
    assert.equal(r.code, 0, both(r))
    assert.equal(existsSync(spec), true)
    has(r.stdout, `지시서를 남긴다 ${spec}: 살아 있는 dispatch 가 쓴다`)
    has(starting(c.calls(), 'orca ').join('\n'), 'worker-list --run run_1')
  })

  test('dispatch 목록 조회가 실패하면 남긴다', async (t) => {
    const c = setup(t)
    c.state.orca = { fails: true }
    const r = await c.finish(['--specs-dir', c.specs, '--complete'])
    assert.equal(r.code, 0, both(r))
    assert.equal(existsSync(join(c.specs, 'spec-x.md')), true)
    has(r.stdout, '살아 있는 지시서 목록을 읽지 못했다')
  })
})

// 지시서가 업무를 가리키는 줄의 형식. 이 테스트의 지시서는 `업무: PROJ-123` 줄을 쓴다
const SPEC_PATTERN = '^업무: (PROJ-[0-9]+)'

describe('finish-pr 마지막 PR 판정', { concurrency: 4 }, () => {
  const judged = (c: Ctx, extra: string[] = []) => {
    hook(c, taskCompleter())
    return c.finish(['--task-pattern', PATTERN, '--specs-dir', c.specs, '--spec-task-pattern', SPEC_PATTERN, ...extra])
  }

  test('같은 업무의 다른 열린 PR 이 있으면 중간 PR 이라 업무를 완료하지 않고 지시서를 남긴다', async (t) => {
    const c = setup(t)
    c.state.open = [
      { number: 77, title: '[PROJ-123] 로그인 고침' },
      { number: 78, title: '[PROJ-123] 뒷부분' },
      { number: 79, title: '[PROJ-9] 다른 업무' },
    ]
    const r = await judged(c)
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '마지막 PR 판정: 중간(업무 PROJ-123, 남은 PR #78, 남은 지시서 없음)')
    assert.equal(starting(c.calls(), 'task-cli').length, 0)
    assert.equal(existsSync(join(c.specs, 'spec-x.md')), true)
    has(r.stdout, '지시서 유지')
  })

  test('같은 업무를 가리키는 다른 지시서가 있으면 중간 PR 이고, 브랜치가 이미 머지된 지시서는 세지 않는다', async (t) => {
    const c = setup(t)
    writeFileSync(join(c.specs, 'spec-z.md'), '# z\n업무: PROJ-123\n브랜치: `feat/z`\n')
    writeFileSync(join(c.specs, 'spec-w.md'), '# w\n업무: PROJ-123\n브랜치: `feat/w`\n')
    writeFileSync(join(c.specs, 'spec-v.md'), '# v\n업무: PROJ-9\n브랜치: `feat/v`\n')
    c.state.merged = ['feat/w']
    const r = await judged(c)
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '마지막 PR 판정: 중간(업무 PROJ-123, 남은 PR 없음, 남은 지시서 spec-z.md)')
    assert.equal(starting(c.calls(), 'task-cli').length, 0)
  })

  test('남은 PR 도 지시서도 없으면 마지막 PR 이라 업무를 완료하고 그 브랜치의 지시서를 지운다', async (t) => {
    const c = setup(t)
    // 이 PR 의 브랜치를 가리키는 지시서는 같은 업무여도 세지 않는다
    writeFileSync(join(c.specs, 'spec-x.md'), '# x\n업무: PROJ-123\n브랜치: `feat/x`\n')
    c.state.open = [{ number: 77, title: '[PROJ-123] 로그인 고침' }]
    const r = await judged(c)
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '마지막 PR 판정: 마지막(업무 PROJ-123, 남은 PR 없음, 남은 지시서 없음)')
    assert.deepEqual(starting(c.calls(), 'task-cli'), ['task-cli complete PROJ-123'])
    assert.equal(existsSync(join(c.specs, 'spec-x.md')), false)
    assert.equal(existsSync(join(c.specs, 'spec-y.md')), true)
  })

  test('판정으로 마지막 PR 이면 after-deploy 의 last_of_task 가 true 다', async (t) => {
    const c = setup(t)
    const file = join(c.tmp, 'inputs.jsonl')
    hook(c, recorder(file))
    const r = await c.finish(['--task-pattern', PATTERN])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '마지막 PR 판정: 마지막(업무 PROJ-123, 남은 PR 없음, 지시서는 보지 않음(specs_dir 없음))')
    assert.equal(inputs(file)[0].last_of_task, true)
  })

  test('명령줄의 표시가 설정의 complete, intermediate 보다 우선한다', async (t) => {
    const c = setup(t)
    mkdirSync(join(c.repo, '.orch'), { recursive: true })
    writeFileSync(join(c.repo, '.orch', 'config.json'), JSON.stringify({ finish: { complete: true } }))
    let r = await c.finish(['--intermediate'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '마지막 PR 판정: 중간(--intermediate 로 지정)')
    writeFileSync(join(c.repo, '.orch', 'config.json'), JSON.stringify({ finish: { intermediate: true } }))
    r = await c.finish(['--complete'])
    has(r.stdout, '마지막 PR 판정: 마지막(--complete 로 지정)')
    r = await c.finish([])
    has(r.stdout, '마지막 PR 판정: 중간(--intermediate 로 지정)')
  })

  test('브랜치가 여럿인 지시서는 모두 머지됐을 때만 세지 않는다', async (t) => {
    const c = setup(t)
    writeFileSync(join(c.specs, 'spec-z.md'), '# z\n업무: PROJ-123\n브랜치: `feat/z1`\n브랜치: `feat/z2`\n')
    c.state.merged = ['feat/z1']
    const r = await judged(c)
    has(r.stdout, '남은 지시서 spec-z.md')
  })

  test('--complete 와 --intermediate 가 판정보다 우선하고 함께 주면 사용법 오류다', async (t) => {
    const c = setup(t)
    c.state.open = [{ number: 78, title: '[PROJ-123] 뒷부분' }]
    let r = await judged(c, ['--complete'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '마지막 PR 판정: 마지막(--complete 로 지정)')
    assert.deepEqual(starting(c.calls(), 'task-cli'), ['task-cli complete PROJ-123'])
    c.state.open = []
    r = await judged(c, ['--intermediate'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '마지막 PR 판정: 중간(--intermediate 로 지정)')
    r = await judged(c, ['--complete', '--intermediate'])
    assert.equal(r.code, 2, both(r))
    has(r.stderr, '--complete 와 --intermediate 는 함께 쓸 수 없다')
  })

  test('판정하지 못하면 중간 PR 이다', async (t) => {
    const c = setup(t)
    let r = await c.finish(['--specs-dir', c.specs])
    has(r.stdout, '마지막 PR 판정: 중간(판정하지 못했다: task_pattern 이 없다)')
    r = await c.finish(['--task-pattern', PATTERN, '--specs-dir', c.specs])
    has(r.stdout, '마지막 PR 판정: 중간(판정하지 못했다: specs_dir 는 있는데 spec_task_pattern 이 없다)')
    c.state.listFails = true
    r = await judged(c)
    has(r.stdout, '마지막 PR 판정: 중간(판정하지 못했다: 열린 PR 을 읽지 못했다)')
    c.state.listFails = false
    c.state.pr.title = '제목에 번호 없음'
    r = await judged(c)
    has(r.stdout, '마지막 PR 판정: 중간(판정하지 못했다: PR 제목에서 업무 번호를 찾지 못했다: 제목에 번호 없음)')
    assert.equal(existsSync(join(c.specs, 'spec-x.md')), true)
    assert.equal(starting(c.calls(), 'task-cli').length, 0)
  })

  test('설정 파일의 spec_task_pattern 을 읽는다', async (t) => {
    const c = setup(t)
    writeFileSync(join(c.specs, 'spec-z.md'), '# z\n업무: PROJ-123\n브랜치: `feat/z`\n')
    mkdirSync(join(c.repo, '.orch'), { recursive: true })
    writeFileSync(join(c.repo, '.orch', 'config.json'), JSON.stringify({ finish: { task_pattern: PATTERN, spec_task_pattern: SPEC_PATTERN, specs_dir: c.specs } }))
    const r = await c.finish([])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '남은 지시서 spec-z.md')
  })
})

describe('finish-pr 보드 항목 찾기', { concurrency: 4 }, () => {
  function board(c: Ctx, items: Json[]): string[] {
    mkdirSync(join(c.repo, '.omc'), { recursive: true })
    writeFileSync(join(c.repo, '.omc', 'board.json'), JSON.stringify({ items }))
    return ['--board-bin', join(c.bin, 'board.py')]
  }

  for (const mode of ['--complete', '--intermediate']) {
    test(`사건 꼬리표 항목은 ${mode} 에서도 일괄 완료하지 않는다`, async (t) => {
      const c = setup(t)
      const file = join(c.repo, '.omc', 'board.json')
      const bin = board(c, [{ id: 'tagged', status: 'doing', pr: 77, details: ['1. 머지 (#77 merge)', '2. 반영 (#77 release)'] }])
      const before = readFileSync(file, 'utf8')
      const r = await c.finish([mode, ...bin])
      assert.equal(r.code, 0, both(r))
      assert.deepEqual(starting(c.calls(), 'board '), [])
      assert.equal(readFileSync(file, 'utf8'), before)
      has(r.stdout, '사건 꼬리표가 있어 board-sync 에 맡긴다')
    })
  }

  test('pr 칸이 빈 항목을 브랜치로 찾아 마지막 PR 이면 done 으로 바꾼다', async (t) => {
    const c = setup(t)
    const bin = board(c, [{ id: 'other', branch: 'feat/y' }, { id: 'task-x', status: 'doing', branch: 'feat/x' }])
    const r = await c.finish(['--task-pattern', PATTERN, ...bin])
    assert.equal(r.code, 0, both(r))
    assert.equal(starting(c.calls(), 'board set task-x done').length, 1, c.calls().join('\n'))
    has(r.stdout, '보드 task-x done(브랜치로 찾았다)')
  })

  test('워크트리 이름으로도 찾는다. 정리가 워크트리를 지우기 전에 이름을 읽는다', async (t) => {
    const c = setup(t)
    const bin = board(c, [{ id: 'task-wt', status: 'doing', worktree: 'wt' }])
    const r = await c.finish(['--task-pattern', PATTERN, ...bin])
    assert.equal(r.code, 0, both(r))
    assert.equal(starting(c.calls(), 'board set task-wt done').length, 1, c.calls().join('\n'))
  })

  test('중간 PR 이면 그 PR 의 단계를 끝내고 남은 일 줄을 두고 PR 을 merged-pr 로 옮긴다', async (t) => {
    const c = setup(t)
    c.state.open = [{ number: 78, title: '[PROJ-123] 뒷부분' }]
    const file = join(c.repo, '.omc', 'board.json')
    const bin = board(c, [{ id: 'task-x', status: 'doing', branch: 'feat/x', details: [{ text: '1. PR #77', done: false }, '남은 일: 옛 줄'] }])
    const steps = JSON.stringify([{ number: 1, done: false, text: '1. PR #77' }, { number: 2, done: false, text: '2. PR #78' }])
    const r = await c.finish(['--task-pattern', PATTERN, ...bin], { FAKE_STEPS: steps })
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(starting(c.calls(), 'board '), [
      `board steps task-x --file ${file}`,
      `board set task-x --detail 1. PR #77 --detail 남은 일: PR #78 --file ${file}`,
      `board step task-x 1 --file ${file}`,
      `board set task-x --pr  --merged-pr 77 --file ${file}`,
    ])
    has(r.stdout, '보드 task-x 는 중간 PR 이라 done 으로 바꾸지 않고 PR 77 를 merged-pr 에 적었다')
  })

  test('--intermediate 면 pr 칸으로 찾은 항목도 done 으로 바꾸지 않고 merged-pr 로 옮긴다', async (t) => {
    const c = setup(t)
    const file = join(c.repo, '.omc', 'board.json')
    const bin = board(c, [{ id: 'by-pr', status: 'doing', pr: 77 }])
    const r = await c.finish(['--intermediate', '--task-pattern', PATTERN, ...bin])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(starting(c.calls(), 'board set'), [`board set by-pr --pr  --merged-pr 77 --file ${file}`])
  })

  test('브랜치로 찾을 때 done 항목과 merged-pr 에 이 PR 이 든 항목은 뺀다', async (t) => {
    const c = setup(t)
    const bin = board(c, [
      { id: 'old', status: 'done', branch: 'feat/x' },
      { id: 'handled', status: 'doing', branch: 'feat/x', 'merged-pr': 77 },
    ])
    const r = await c.finish(['--task-pattern', PATTERN, ...bin])
    assert.equal(r.code, 0, both(r))
    assert.equal(starting(c.calls(), 'board ').length, 0, c.calls().join('\n'))
  })

  test('마일스톤 항목은 판정하지 못한 PR 도 마지막으로 보고 기본 done 지점(merge)에서 done 으로 바꾼다', async (t) => {
    const c = setup(t)
    const file = join(c.repo, '.omc', 'board.json')
    const bin = board(c, [{ id: 'm', status: 'doing', branch: 'feat/x', stages: 'pr=1,merge=2', details: [{ text: '1. PR', done: false }, { text: '2. 머지', done: false }] }])
    const steps = JSON.stringify([{ number: 1, done: false, text: '1. PR' }, { number: 2, done: false, text: '2. 머지' }])
    // --task-pattern 이 없어 판정하지 못한다
    const r = await c.finish([...bin], { FAKE_STEPS: steps })
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(starting(c.calls(), 'board '), [
      `board steps m --file ${file}`,
      `board step m 1 --file ${file}`,
      `board step m 2 --file ${file}`,
      `board set m done --worktree  --file ${file}`,
      `board set m --merged-pr 77 --file ${file}`,
    ])
    has(r.stdout, '보드 m done(브랜치로 찾았다)')
  })

  test('마일스톤 항목은 배포가 성공하면 [deploy] 단계까지 끝내고 done 지점 전이면 doing 으로 둔다', async (t) => {
    const c = setup(t)
    mkdirSync(join(c.repo, '.orch'), { recursive: true })
    writeFileSync(join(c.repo, '.orch', 'config.json'), JSON.stringify({ board: { done_after: 'release' } }))
    const file = join(c.repo, '.omc', 'board.json')
    const bin = board(c, [{ id: 'm', status: 'doing', pr: 77, stages: 'pr=1,merge=2,deploy=3,release=4' }])
    const steps = JSON.stringify([1, 2, 3, 4].map((number) => ({ number, done: number === 1, text: `${number}. 단계` })))
    const r = await c.finish([...DEPLOY, '--complete', ...bin], { FAKE_STEPS: steps })
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(starting(c.calls(), 'board '), [
      `board steps m --file ${file}`,
      `board step m 2 --file ${file}`,
      `board step m 3 --file ${file}`,
      `board set m --merged-pr 77 --file ${file}`,
    ])
    has(r.stdout, '보드 m 는 done 지점 전이라 단계만 끝내고 PR 77 를 merged-pr 에 적었다')
  })

  test('마일스톤 항목의 중간 PR 은 pr 칸을 비우고 merged-pr 에 쌓는다', async (t) => {
    const c = setup(t)
    const file = join(c.repo, '.omc', 'board.json')
    const bin = board(c, [{ id: 'm', status: 'doing', pr: 77, 'merged-pr': 70, stages: 'pr=1,merge=2' }])
    const steps = JSON.stringify([{ number: 1, done: true, text: '1. PR' }, { number: 2, done: true, text: '2. 머지' }])
    const r = await c.finish(['--intermediate', ...bin], { FAKE_STEPS: steps })
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(starting(c.calls(), 'board set'), [`board set m --pr  --merged-pr 70, 77 --file ${file}`])
  })

  test('찾은 항목이 둘 이상이면 건너뛴다', async (t) => {
    const c = setup(t)
    const bin = board(c, [{ id: 'a', pr: '#77' }, { id: 'b', pr: '77' }])
    const r = await c.finish(['--task-pattern', PATTERN, ...bin])
    assert.equal(r.code, 0, both(r))
    assert.equal(starting(c.calls(), 'board ').length, 0)
    has(r.stdout, '보드 항목이 둘 이상이라 건너뛴다: PR 77 -> a, b')
  })
})

describe('finish-pr 머지 알림', { concurrency: 4 }, () => {
  const live = (c: Ctx, status = 'running') => {
    c.state.orca = { workers: [{ dispatchId: 'ctx_w', dispatchStatus: status, resource: { worktreeId: `repo::${c.wt}` } }] }
  }

  test('그 워크트리의 살아 있는 worker 에게 머지를 알리고, 끝나기를 기다린 뒤 정리한다', async (t) => {
    const c = setup(t)
    live(c)
    const r = await c.finish(['--run', 'run_1', '--complete'], { FAKE_SEND_ENDS: '1' })
    assert.equal(r.code, 0, both(r))
    const calls = c.calls()
    const sent = calls.findIndex((line) => line.startsWith('send-to-worker '))
    assert.ok(sent >= 0, calls.join('\n'))
    assert.equal(
      calls[sent],
      `send-to-worker --dispatch ctx_w --body PR #77 이 MERGED 됐다(머지 커밋 ${c.merge}). gh pr view 로 확인한 뒤 worker_done 을 보내고 끝낸다 --run run_1`,
    )
    // 알림이 정리보다 먼저다
    assert.ok(sent < calls.findIndex((line) => line.startsWith('sweep ')), calls.join('\n'))
    has(r.stdout, 'notify: replied: m_1 에 답했다 (msg_new)')
    has(r.stdout, 'notify: worker 끝남: ctx_w (succeeded)')
    assert.equal(existsSync(c.wt), false)
  })

  test('시간 안에 끝나지 않으면 남았다고 알리고 정리를 이어 간다', async (t) => {
    const c = setup(t)
    live(c)
    const r = await c.finish(['--run', 'run_1', '--complete', '--worker-done-timeout', '0.001'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, 'notify: worker 남음: ctx_w 가 아직 살아 있다')
    assert.ok(starting(c.calls(), 'sweep ').length > 0, c.calls().join('\n'))
  })

  test('보내지 못하면 기다리지 않는다', async (t) => {
    const c = setup(t)
    live(c)
    const r = await c.finish(['--run', 'run_1', '--complete'], { FAKE_SEND_EXIT: '3' })
    assert.equal(r.code, 0, both(r))
    has(r.stdout, 'notify: ctx_w 에 머지를 알리지 못했다(종료 코드 3). 기다리지 않고 정리한다')
    lacks(r.stdout, '끝나기를 기다린다')
  })

  test('살아 있는 worker 가 없으면 알리지 않는다', async (t) => {
    const c = setup(t)
    live(c, 'succeeded')
    const r = await c.finish(['--run', 'run_1', '--complete'])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(starting(c.calls(), 'send-to-worker '), [])
    lacks(r.stdout, 'notify:')
  })
})
