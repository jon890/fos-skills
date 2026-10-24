// merge_queue.ts 의 겹침 판정과 합친 사본 검사를 진짜 git 저장소(bare origin 과 clone)로 본다. gh 만 가짜다
// (tests/fixtures/merge-queue-fakes.ts). 판정 명령은 기본 경로의 진짜 overlap_units.ts 다.
// 임시 폴더는 macOS 에서 /var 링크 아래라 사본 경로의 실경로 처리를 그대로 겪는다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FAKE_GH, HAS_TOOLS, spawnDone, writeNodeBin } from './fixtures/merge-queue-fakes.ts'
import type { Done } from './fixtures/merge-queue-fakes.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/merge_queue.ts', import.meta.url))
const SUCCESS = { status: 'COMPLETED', conclusion: 'SUCCESS' }
const CI = { name: 'CI', ...SUCCESS }
const FIVE = '1\n2\n3\n4\n5\n'

type Json = Record<string, unknown>
type Ctx = {
  tmp: string
  repo: string
  stateFile: string
  env: NodeJS.ProcessEnv
  git: (args: string[], cwd?: string) => string
  log: () => string
  merged: () => boolean
  worktreeCount: () => number
  state: () => Json
  writeState: (state: Json) => void
  branches: (feat: Record<string, string>, main: Record<string, string>, featDeletes?: string[]) => void
  runQueue: (args: string[]) => Promise<Done>
}

let bindir = ''
before(() => {
  bindir = mkdtempSync(join(tmpdir(), 'merge-queue-overlap-bin-'))
  writeNodeBin(bindir, 'gh', FAKE_GH)
})
after(() => rmSync(bindir, { recursive: true, force: true }))

function setup(t: TestContext): Ctx {
  const tmp = mkdtempSync(join(tmpdir(), 'merge-queue-overlap-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const gitconfig = join(tmp, 'gitconfig')
  writeFileSync(gitconfig, '')
  const stateFile = join(tmp, 'state.json')
  const logFile = join(tmp, 'log.txt')
  writeFileSync(join(tmp, 'sweep.py'), '')
  // CI 에는 git 작성자 설정이 없고, 로컬의 전역 설정은 결과를 바꿀 수 있어 고정한다
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    FAKE_STATE: stateFile,
    FAKE_LOG: logFile,
    TMPDIR: tmp,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    MERGE_QUEUE_SLEEP_SCALE: '0',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@x',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@x',
    CLEANUP_SWEEP: join(tmp, 'sweep.py'),
  }
  delete env.GH
  delete env.OVERLAP_UNITS
  const repo = join(tmp, 'repo')
  const git = (args: string[], cwd = repo): string => {
    const done = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
    assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
    return done.stdout.trim()
  }
  const write = (files: Record<string, string>, message: string) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, name)), { recursive: true })
      writeFileSync(join(repo, name), text)
    }
    git(['add', '-A'])
    git(['commit', '-q', '-m', message])
  }
  const logText = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
  const writeState = (state: Json) => writeFileSync(stateFile, JSON.stringify(state))
  git(['init', '-q', '--bare', '-b', 'main', join(tmp, 'origin.git')], tmp)
  git(['clone', '-q', join(tmp, 'origin.git'), repo], tmp)
  write({ 'a.txt': FIVE, 'b.txt': 'b\n' }, 'init')
  git(['push', '-q', 'origin', 'HEAD:main'])
  git(['checkout', '-q', '-b', 'feat'])
  return {
    tmp,
    repo,
    stateFile,
    env,
    git,
    log: logText,
    merged: () => logText().includes('pr merge 1'),
    worktreeCount: () =>
      git(['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length,
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')) as Json,
    writeState,
    // feat 와 main 에 각각 커밋을 올리고 PR 상태를 쓴다. featDeletes 는 feat 가 지우는 파일이다
    branches: (feat, main, featDeletes = []) => {
      for (const name of featDeletes) unlinkSync(join(repo, name))
      write(feat, 'feat')
      git(['push', '-q', 'origin', 'feat'])
      const head = git(['rev-parse', 'HEAD'])
      git(['checkout', '-q', 'main'])
      write(main, 'main')
      git(['push', '-q', 'origin', 'main'])
      const pr = {
        state: 'OPEN',
        statusCheckRollup: [SUCCESS],
        mergeable: 'MERGEABLE',
        url: 'https://git.example.com/owner/repo/pull/1',
        headRefName: 'feat',
        baseRefName: 'main',
        headRefOid: head,
        isCrossRepository: false,
      }
      writeState({ '1': pr })
    },
    runQueue: (args) =>
      spawnDone([process.execPath, '--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--threads-cmd', 'echo 0', '--no-sweep', ...args, '1'], {
        env,
      }),
  }
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

function count(text: string, part: string): number {
  return text.split(part).length - 1
}

// 합친 사본 검사 명령이 받은 환경 변수를 JSON 으로 남기는 셸 명령
function dumpEnvCmd(file: string): string {
  return `python3 -c 'import json,os; json.dump(dict(os.environ),open("${file}","w"))'`
}

function patchPr(c: Ctx, fields: Json, behind?: number): void {
  const state = c.state()
  Object.assign(state['1'] as Json, fields)
  if (behind !== undefined) state._behind = behind
  c.writeState(state)
}

describe('merge_queue 겹침', { skip: !HAS_TOOLS && 'jq 와 bash 가 필요하다', concurrency: 4 }, () => {
  test('--stop-on-overlap 은 겹친 파일만 찍고 멈춘다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': `${FIVE}feat\n`, 'c.txt': 'c\n' }, { 'a.txt': `main\n${FIVE}` })
    const r = await c.runQueue(['--stop-on-overlap'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 겹침: a.txt')
    lacks(r.stdout, 'c.txt')
    assert.equal(c.merged(), false)
  })

  test('PR 이 지운 파일을 base 도 고쳤으면 겹침이다', async (t) => {
    const c = setup(t)
    c.branches({}, { 'b.txt': 'main\n' }, ['b.txt'])
    const r = await c.runQueue(['--stop-on-overlap'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 겹침: b.txt')
    assert.equal(c.merged(), false)
  })

  test('검사 명령의 CHANGED_FILES 에 지운 파일도 든다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': `${FIVE}feat\n` }, { 'a.txt': `main\n${FIVE}` }, ['b.txt'])
    const seen = join(c.tmp, 'environment.json')
    const r = await c.runQueue(['--verify-merged', dumpEnvCmd(seen)])
    assert.equal(r.code, 0, both(r))
    const env = JSON.parse(readFileSync(seen, 'utf8')) as Record<string, string>
    assert.equal(env.CHANGED_FILES, 'a.txt\nb.txt')
    assert.equal(env.OVERLAP_FILES, 'a.txt')
  })

  test('STOP 줄은 겹친 파일을 공백 하나로 잇고 끝 공백이 없다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': `${FIVE}feat\n`, 'b.txt': 'feat\n' }, { 'a.txt': `main\n${FIVE}`, 'b.txt': 'main\n' })
    const r = await c.runQueue(['--stop-on-overlap'])
    has(`\n${r.stdout}`, '\nSTOP 1 겹침: a.txt b.txt\n')
  })

  test('겹침 기록 줄은 끝 공백이 없다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': `${FIVE}feat\n`, 'b.txt': 'feat\n' }, { 'a.txt': `main\n${FIVE}`, 'b.txt': 'main\n' })
    const r = await c.runQueue(['--verify-merged', 'true'])
    assert.match(r.stdout, /^\d\d:\d\d 1 겹침: a\.txt b\.txt$/m)
  })

  test('겹치지 않으면 머지한다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': `${FIVE}feat\n` }, { 'b.txt': 'b2\n' })
    const r = await c.runQueue(['--stop-on-overlap'])
    assert.equal(r.code, 0, both(r))
    lacks(r.stdout, '겹침')
    assert.equal(c.merged(), true)
  })

  test('겹치지 않으면 검사 명령을 돌리지 않는다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': `${FIVE}feat\n` }, { 'b.txt': 'b2\n' })
    const r = await c.runQueue(['--verify-merged', 'exit 1'])
    assert.equal(r.code, 0, both(r))
    assert.equal(c.merged(), true)
  })

  test('base 와 충돌하면 멈추고 사본을 남기지 않는다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': '1\n2\nfeat\n4\n5\n' }, { 'a.txt': '1\n2\nmain\n4\n5\n' })
    const r = await c.runQueue(['--verify-merged', 'exit 0'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 base(main) 와 합치면 충돌한다')
    assert.equal(c.merged(), false)
    assert.equal(c.worktreeCount(), 1)
  })
})

describe('merge_queue 합친 사본 검사', { skip: !HAS_TOOLS && 'jq 와 bash 가 필요하다', concurrency: 4 }, () => {
  test('합친 사본의 실경로에서 검사하고 TMPDIR 도 실경로로 준다. 끝나면 사본을 지운다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': `${FIVE}feat\n` }, { 'a.txt': `main\n${FIVE}` })
    const seen = join(c.tmp, 'seen.txt')
    const cmd = `grep -qx main "$1/a.txt" && grep -qx feat "$1/a.txt" && [ "$PWD" = "$1" ] && printf "%s\\n%s\\n" "$1" "$TMPDIR" > ${seen}`
    const r = await c.runQueue(['--verify-merged', cmd])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 겹침: a.txt')
    has(r.stdout, '합친 사본의 검사 통과')
    assert.equal(c.merged(), true)
    const [copy, tmpdirSeen] = readFileSync(seen, 'utf8').trim().split('\n')
    const real = realpathSync(c.tmp)
    assert.equal(tmpdirSeen, real)
    assert.equal(dirname(copy), real)
    assert.match(copy, /\/merge-queue-pr1-\d+$/)
    assert.equal(existsSync(copy), false)
    assert.equal(c.worktreeCount(), 1)
  })

  test('검사가 실패하면 멈추고 사본을 지운다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': `${FIVE}feat\n` }, { 'a.txt': `main\n${FIVE}` })
    const seen = join(c.tmp, 'seen.txt')
    const r = await c.runQueue(['--verify-merged', `echo "$1" > ${seen}; exit 3`])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 합친 사본의 검사 실패(종료 코드 3)')
    assert.equal(c.merged(), false)
    assert.equal(existsSync(readFileSync(seen, 'utf8').trim()), false)
    assert.equal(c.worktreeCount(), 1)
  })

  test('검사 명령은 PR, 바뀐 파일, 겹친 파일, 두 커밋 id, 사본 경로를 환경 변수로 받는다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': `${FIVE}feat\n`, 'tests/new file.test.ts': 'test\n' }, { 'a.txt': `main\n${FIVE}` })
    const seen = join(c.tmp, 'environment.json')
    const r = await c.runQueue(['--verify-merged', dumpEnvCmd(seen)])
    assert.equal(r.code, 0, both(r))
    const env = JSON.parse(readFileSync(seen, 'utf8')) as Record<string, string>
    assert.equal(env.PR, '1')
    assert.equal(env.CHANGED_FILES, 'a.txt\ntests/new file.test.ts')
    assert.equal(env.OVERLAP_FILES, 'a.txt')
    assert.equal(env.PR_HEAD, c.git(['rev-parse', 'feat']))
    assert.equal(env.BASE_HEAD, c.git(['rev-parse', 'main']))
    assert.equal(env.GH_HOST, 'git.example.com')
    assert.equal(env.MERGE_COPY, env.PWD)
    assert.equal(existsSync(env.MERGE_COPY), false)
  })

  test('code 는 겹치지 않은 코드 PR 도 검사한다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': `${FIVE}feat\n` }, { 'b.txt': 'b2\n' })
    const r = await c.runQueue(['--verify-merged', 'exit 4', '--verify-merged-when', 'code'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '합친 사본의 검사 실패(종료 코드 4)')
    lacks(r.stdout, '겹침')
    assert.equal(c.merged(), false)
    assert.equal(c.worktreeCount(), 1)
  })

  test('문서만 바꾼 PR 은 겹쳐도 검사 없이 머지한다', async (t) => {
    const c = setup(t)
    c.branches({ 'docs/a.md': 'feat\n' }, { 'docs/a.md': 'main\n' })
    const r = await c.runQueue(['--verify-merged', 'exit 1', '--docs-glob', 'docs/*,*.txt'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 겹침: docs/a.md')
    has(r.stdout, '문서만 바꿨다')
    assert.equal(c.merged(), true)
  })

  test('--docs-glob 은 바뀐 파일을 모두 덮어야 문서 PR 이다', async (t) => {
    const c = setup(t)
    c.branches({ 'docs/a.md': 'feat\n', 'c.py': 'c\n' }, { 'b.txt': 'b2\n' })
    const r = await c.runQueue(['--verify-merged', 'exit 5', '--verify-merged-when', 'code', '--docs-glob', 'docs/*'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '검사 실패(종료 코드 5)')
  })

  test('code 에서도 겹치지 않은 문서 PR 은 검사 없이 머지한다', async (t) => {
    const c = setup(t)
    c.branches({ 'README.md': 'x\n' }, { 'b.txt': 'b2\n' })
    const r = await c.runQueue(['--verify-merged', 'exit 1', '--verify-merged-when', 'code', '--docs-glob', '*.md'])
    assert.equal(r.code, 0, both(r))
    assert.equal(c.merged(), true)
  })

  test('always 는 문서 PR 도 검사한다', async (t) => {
    const c = setup(t)
    c.branches({ 'README.md': 'x\n' }, { 'b.txt': 'b2\n' })
    const r = await c.runQueue(['--verify-merged', 'exit 6', '--verify-merged-when', 'always', '--docs-glob', '*.md'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '검사 실패(종료 코드 6)')
  })

  test('--after-merged 의 CODE_PRS 에서 문서 PR 을 뺀다', async (t) => {
    const c = setup(t)
    const seen = join(c.tmp, 'after.txt')
    c.branches({ 'docs/a.md': 'x\n' }, { 'b.txt': 'b2\n' })
    const r = await c.runQueue(['--after-merged', `echo "$MERGED_PRS|$CODE_PRS" > ${seen}`, '--docs-glob', 'docs/*'])
    assert.equal(r.code, 0, both(r))
    assert.equal(readFileSync(seen, 'utf8'), '1|\n')
  })

  test('--after-merged 의 CODE_PRS 에 코드 PR 이 든다', async (t) => {
    const c = setup(t)
    const seen = join(c.tmp, 'after.txt')
    c.branches({ 'docs/a.md': 'x\n', 'c.py': 'c\n' }, { 'b.txt': 'b2\n' })
    const r = await c.runQueue(['--after-merged', `echo "$MERGED_PRS|$CODE_PRS" > ${seen}`, '--docs-glob', 'docs/*'])
    assert.equal(r.code, 0, both(r))
    assert.equal(readFileSync(seen, 'utf8'), '1|1\n')
  })

  test('시작할 때 죽은 실행이 남긴 사본만 지운다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': `${FIVE}feat\n` }, { 'b.txt': 'b2\n' })
    const gonePid = await new Promise<number>((resolve) => {
      const gone = spawn('true')
      gone.on('exit', () => resolve(gone.pid as number))
    })
    const real = realpathSync(c.tmp)
    const dead = join(real, `merge-queue-pr9-${gonePid}`)
    const alive = join(real, `merge-queue-pr8-${process.pid}`)
    for (const copy of [dead, alive]) c.git(['worktree', 'add', '-q', '--detach', copy, 'main'])
    const r = await c.runQueue(['--stop-on-overlap'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, `끝난 실행(pid ${gonePid})이 남긴 사본을 지웠다: ${dead}`)
    assert.equal(existsSync(dead), false)
    assert.equal(existsSync(alive), true)
    assert.equal(c.worktreeCount(), 2)
  })

  test('검사 중에 SIGTERM 을 받으면 사본을 지우고 143 으로 끝난다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': `${FIVE}feat\n` }, { 'a.txt': `main\n${FIVE}` })
    const seen = join(c.tmp, 'seen.txt')
    // 검사 명령은 사본 경로를 적고 기다린다. 그 자식은 큐가 끝난 뒤에도 출력 파이프를 쥐므로 close 대신 exit 를 기다린다
    const args = ['--repo', c.repo, '--threads-cmd', 'echo 0', '--no-sweep', '--verify-merged', `echo "$1" > ${seen}; sleep 5`, '1']
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env: c.env, stdio: 'ignore' })
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
    const deadline = Date.now() + 30_000
    while (!(existsSync(seen) && readFileSync(seen, 'utf8').trim()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    const copy = readFileSync(seen, 'utf8').trim()
    assert.equal(existsSync(copy), true, '검사가 도는 동안에는 사본이 있어야 한다')
    child.kill('SIGTERM')
    assert.equal(await exited, 143)
    assert.equal(existsSync(copy), false)
    assert.equal(c.worktreeCount(), 1)
    assert.equal(c.merged(), false)
  })

  test('--copy-dir 의 상대경로는 --repo 기준이다', async (t) => {
    const c = setup(t)
    c.branches({ 'a.txt': `${FIVE}feat\n` }, { 'a.txt': `main\n${FIVE}` })
    const seen = join(c.tmp, 'seen.txt')
    const r = await c.runQueue(['--copy-dir', 'worktrees/repo', '--verify-merged', `echo "$1" > ${seen}`])
    assert.equal(r.code, 0, both(r))
    assert.equal(dirname(readFileSync(seen, 'utf8').trim()), realpathSync(join(c.repo, 'worktrees', 'repo')))
  })
})

describe('merge_queue 문서 PR 갱신', { skip: !HAS_TOOLS && 'jq 와 bash 가 필요하다', concurrency: 4 }, () => {
  // update-branch 가 돌려줄 실제 커밋을 준비한다. 처음 조회하는 PR HEAD 는 갱신 전 값이다
  function docsOverlap(c: Ctx, clean = 'CLEAN'): void {
    c.branches({ 'a.txt': `${FIVE}feat\n` }, { 'a.txt': `main\n${FIVE}` })
    c.git(['checkout', '-q', 'feat'])
    c.git(['merge', '-q', '--no-edit', 'main'])
    c.git(['push', '-q', 'origin', 'feat'])
    patchPr(c, { mergeStateStatus: clean, after_update_head: c.git(['rev-parse', 'HEAD']), statusCheckRollup: [CI], after_update: [CI] }, 1)
  }

  test('겹친 문서 PR 은 CLEAN 일 때 검사한 HEAD 로 base 를 합치고 새 CI 를 기다려 머지한다', async (t) => {
    const c = setup(t)
    docsOverlap(c)
    const old = (c.state()['1'] as Json).headRefOid as string
    const r = await c.runQueue(['--update-docs-on-overlap', '--docs-glob', '*.txt', '--required', 'CI', '--stop-on-overlap'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, 'update-branch 후 체크를 다시 기다린다')
    has(c.log(), `api --hostname git.example.com -X PUT repos/owner/repo/pulls/1/update-branch -f expected_head_sha=${old}\n`)
    assert.equal(count(c.log(), '-X PUT'), 1, c.log())
    assert.equal(c.merged(), true)
  })

  test('CLEAN 이 아니면 합치지 않고 멈춘다', async (t) => {
    const c = setup(t)
    docsOverlap(c, 'BLOCKED')
    const r = await c.runQueue(['--update-docs-on-overlap', '--docs-glob', '*.txt', '--required', 'CI'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 문서 PR 을 갱신하려면 GitHub CLEAN 이 필요하다(현재 BLOCKED)')
    lacks(c.log(), '-X PUT')
    assert.equal(c.merged(), false)
  })

  test('필수 체크 목록이 없으면 멈춘다', async (t) => {
    const c = setup(t)
    docsOverlap(c)
    const r = await c.runQueue(['--update-docs-on-overlap', '--docs-glob', '*.txt'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '필수 체크 목록이 필요하다')
    assert.equal(c.merged(), false)
  })

  test('합친 뒤 새 CI 가 실패하면 멈춘다', async (t) => {
    const c = setup(t)
    docsOverlap(c)
    patchPr(c, { after_update: [{ ...CI, conclusion: 'FAILURE' }] })
    const r = await c.runQueue(['--update-docs-on-overlap', '--docs-glob', '*.txt', '--required', 'CI'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '실패한 체크')
    assert.equal(c.merged(), false)
  })
})

describe('merge_queue 와 진짜 판정 명령', { skip: !HAS_TOOLS && 'jq 와 bash 가 필요하다', concurrency: 4 }, () => {
  function judgeQueue(c: Ctx, extra: string[] = []): Promise<Done> {
    return c.runQueue(['--required', 'CI', '--require-up-to-date', '--up-to-date-when', 'overlap', ...extra])
  }

  // 다른 사람이 origin/main 에 커밋을 올리는 것을 흉내 내는 셸 명령
  function pushFromAnotherClone(c: Ctx, name: string, text: string): string {
    const other = join(c.tmp, 'other')
    return (
      `git clone -q ${join(c.tmp, 'origin.git')} ${other} && cd ${other} && mkdir -p $(dirname ${name}) ` +
      `&& echo ${text} > ${name} && git add -A && git commit -q -m moved && git push -q origin HEAD:main`
    )
  }

  test('단위가 다르면 갱신 없이 머지한다', async (t) => {
    const c = setup(t)
    c.branches({ 'modules/api/A.java': 'a\n' }, { 'modules/web/W.java': 'w\n' })
    patchPr(c, { statusCheckRollup: [CI] }, 1)
    const r = await judgeQueue(c)
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 판정: 바로 머지')
    lacks(c.log(), 'update-branch')
    assert.equal(c.merged(), true)
  })

  test('머지 직전에 origin 이 움직이면 다시 판정한다', async (t) => {
    const c = setup(t)
    c.branches({ 'modules/api/A.java': 'a\n' }, { 'modules/web/W.java': 'w\n' })
    patchPr(c, { statusCheckRollup: [CI] }, 1)
    const r = await judgeQueue(c, ['--before', pushFromAnotherClone(c, 'modules/db/D.java', 'd')])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 판정한 뒤 base(main) 가 움직였다. 새로 들어온 변경으로 다시 판정한다')
    assert.equal(count(r.stdout, '1 판정: 바로 머지'), 2, r.stdout)
    lacks(c.log(), 'update-branch')
    assert.equal(c.merged(), true)
  })

  test('단위가 겹치면 갱신하고 새 HEAD 로 머지한다', async (t) => {
    const c = setup(t)
    c.branches({ 'modules/api/A.java': 'a\n' }, { 'modules/api/B.java': 'b\n' })
    // update-branch 가 돌려줄 실제 커밋을 준비한다
    c.git(['checkout', '-q', 'feat'])
    c.git(['merge', '-q', '--no-edit', 'main'])
    c.git(['push', '-q', 'origin', 'feat'])
    const next = c.git(['rev-parse', 'HEAD'])
    patchPr(c, { statusCheckRollup: [CI], after_update_head: next, after_update: [CI] }, 1)
    const r = await judgeQueue(c)
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 판정: 갱신 필요(단위 겹침: api)')
    assert.equal(count(c.log(), 'update-branch'), 1, c.log())
    has(c.log(), `pr merge 1 --merge --match-head-commit ${next}`)
  })
})
