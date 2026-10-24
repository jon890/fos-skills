// merge_queue.ts 를 가짜 gh, git 으로 본다(tests/fixtures/merge-queue-fakes.ts). orca 와 GitHub 에는 닿지 않는다.
// 겹침 판정과 합친 사본 검사는 진짜 git 저장소가 필요해 merge-queue-overlap.spec.ts 가 본다.
// 판정 명령(OVERLAP_UNITS)과 정리 명령(CLEANUP_SWEEP)의 가짜는 `.py` 라 확장자대로 python3 로 돈다.

import assert from 'node:assert/strict'
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FAKE_GH, FAKE_GIT, HAS_TOOLS, spawnDone, writeNodeBin } from './fixtures/merge-queue-fakes.ts'
import type { Done } from './fixtures/merge-queue-fakes.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/merge_queue.ts', import.meta.url))
const SCRIPTS = dirname(SCRIPT)
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning', SCRIPT]

type Json = Record<string, unknown>
type Ctx = {
  tmp: string
  stateFile: string
  logFile: string
  sweepLog: string
  env: NodeJS.ProcessEnv
  log: () => string
  state: () => Json
  writeState: (state: Json) => void
  runQueue: (state: Json, args: string[], threads?: string) => Promise<Done>
}

let bindir = ''
before(() => {
  bindir = mkdtempSync(join(tmpdir(), 'merge-queue-bin-'))
  writeNodeBin(bindir, 'gh', FAKE_GH)
  writeNodeBin(bindir, 'git', FAKE_GIT)
})
after(() => rmSync(bindir, { recursive: true, force: true }))

function setup(t: TestContext): Ctx {
  const tmp = mkdtempSync(join(tmpdir(), 'merge-queue-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const stateFile = join(tmp, 'state.json')
  const logFile = join(tmp, 'log.txt')
  const sweepLog = join(tmp, 'sweep.txt')
  const sweep = join(tmp, 'sweep.py')
  writeFileSync(sweep, `import sys\nopen(${JSON.stringify(sweepLog)}, 'w').write(' '.join(sys.argv[1:]))\n`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    FAKE_STATE: stateFile,
    FAKE_LOG: logFile,
    FAKE_REMOTE_HEAD: 'abc',
    MERGE_QUEUE_SLEEP_SCALE: '0',
    CLEANUP_SWEEP: sweep,
  }
  delete env.GH
  const writeState = (state: Json) => writeFileSync(stateFile, JSON.stringify(state))
  return {
    tmp,
    stateFile,
    logFile,
    sweepLog,
    env,
    log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''),
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')) as Json,
    writeState,
    runQueue: (state, args, threads = '0') => {
      writeState(state)
      return spawnDone([...NODE, '--repo', tmp, '--threads-cmd', `echo ${threads}`, ...args], { env })
    },
  }
}

function pr(over: Json = {}): Json {
  return {
    state: 'OPEN',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    mergeable: 'MERGEABLE',
    url: 'https://git.example.com/owner/repo/pull/1',
    headRefName: 'feat',
    baseRefName: 'main',
    headRefOid: 'abc',
    isCrossRepository: false,
    ...over,
  }
}

function check(name: string, conclusion = 'SUCCESS'): Json {
  return { name, status: 'COMPLETED', conclusion }
}

function rules(...names: string[]): Json[] {
  return [{ type: 'required_status_checks', parameters: { required_status_checks: names.map((context) => ({ context })) } }]
}

const FAILED = [{ status: 'COMPLETED', conclusion: 'FAILURE' }]

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

// Python 리터럴. 머지 전 명령으로 넘기는 python3 -c 안에 넣으므로 문자열은 작은따옴표로 감싼다
function pyLiteral(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

// 머지 전 명령으로 넘겨 가짜 상태를 바꾼다. base 가 움직이거나 HEAD 가 바뀐 것을 흉내 낸다
function editStateCmd(c: Ctx, fields: Record<string, unknown>, target = ''): string {
  const sets = Object.entries(fields)
    .map(([key, value]) => `d${target}[${pyLiteral(key)}]=${pyLiteral(value)}`)
    .join('; ')
  return `python3 -c "import json; p='${c.stateFile}'; d=json.load(open(p)); ${sets}; json.dump(d, open(p, 'w'))"`
}

describe('merge_queue 기본 흐름', { skip: !HAS_TOOLS && 'jq 와 bash 가 필요하다', concurrency: 4 }, () => {
  test('머지하고 머지 전 명령에 PR, BRANCH, OWNER, REPO 를 넘긴다', async (t) => {
    const c = setup(t)
    const marker = join(c.tmp, 'before.txt')
    const r = await c.runQueue({ '1': pr() }, [`1:echo "$PR $BRANCH $OWNER/$REPO" > ${marker}`])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, 'QUEUE-DONE')
    assert.equal(readFileSync(marker, 'utf8'), '1 feat owner/repo\n')
    has(c.log(), 'pr merge 1 --merge --match-head-commit abc')
    has(c.log(), 'git push -q origin --delete feat')
  })

  test('옛 merge-queue.sh 경로는 실행 가능하고 다른 디렉터리에서 불러도 같은 폴더의 큐를 돌린다', async (t) => {
    const c = setup(t)
    const old = join(SCRIPTS, 'merge-queue.sh')
    accessSync(old, constants.X_OK)
    has(readFileSync(old, 'utf8'), 'exec python3 "$(dirname "$0")/merge_queue.py" "$@"')
    c.writeState({ '1': pr() })
    const r = await spawnDone([old, '--repo', c.tmp, '--threads-cmd', 'echo 0', '--no-sweep', '1'], { env: c.env, cwd: '/' })
    assert.equal(r.code, 0, both(r))
    has(r.stdout, 'QUEUE-DONE')
    const bare = await spawnDone([old], { env: c.env })
    assert.equal(bare.code, 2, both(bare))
  })

  test('머지가 끝나면 정리를 base 와 --sweep-arg 로 부른다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr({ baseRefName: 'develop' }) }, ['--sweep-arg', '--run', '--sweep-arg', 'run x', '1'])
    assert.equal(r.code, 0, both(r))
    // --repo 는 옮겨 간 작업 디렉터리라 실경로다(macOS 의 임시 폴더는 /var 링크 아래다)
    has(readFileSync(c.sweepLog, 'utf8'), `--repo ${realpathSync(c.tmp)} --base develop --apply --run run x`)
  })

  test('--no-sweep 이나 보류로 멈추면 정리를 부르지 않는다', async (t) => {
    const c = setup(t)
    let r = await c.runQueue({ '1': pr() }, ['--no-sweep', '1'])
    assert.equal(r.code, 0, both(r))
    assert.equal(existsSync(c.sweepLog), false)
    r = await c.runQueue({ '1': pr() }, ['1'], '2')
    assert.equal(r.code, 1, both(r))
    assert.equal(existsSync(c.sweepLog), false)
  })

  test('미해결 스레드가 있으면 멈춘다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr() }, ['1'], '2')
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'threads=2')
    has(r.stdout, 'STOP 1\n')
    lacks(c.log(), 'pr merge')
  })

  test('실패한 체크가 있으면 멈춘다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr({ statusCheckRollup: FAILED }) }, ['1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 실패한 체크 1 개')
  })

  test('PR 조회가 실패하면 MERGE_QUEUE_GH_RETRIES 번까지 다시 부른다', async (t) => {
    const c = setup(t)
    c.env.MERGE_QUEUE_GH_RETRIES = '3'
    c.env.MERGE_QUEUE_GH_RETRY_SECONDS = '0'
    let r = await c.runQueue({ '1': pr(), _view_fails: 2 }, ['1'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 MERGED')
    r = await c.runQueue({ '1': pr(), _view_fails: 3 }, ['1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 state=조회 실패')
  })

  test('빈 재시도 변수는 기본값을 쓴다. 한쪽만 비어도 다른 쪽 값은 그대로 쓴다', async (t) => {
    const c = setup(t)
    c.env.MERGE_QUEUE_GH_RETRIES = ''
    c.env.MERGE_QUEUE_GH_RETRY_SECONDS = ''
    let r = await c.runQueue({ '1': pr(), _view_fails: 2 }, ['1'])
    assert.equal(r.code, 0, both(r))
    c.env.MERGE_QUEUE_GH_RETRY_SECONDS = '0'
    r = await c.runQueue({ '1': pr(), _view_fails: 3 }, ['1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 state=조회 실패')
  })

  test('정수가 아닌 재시도 변수는 하나씩 사용법 오류다', async (t) => {
    const c = setup(t)
    for (const [name, other] of [
      ['MERGE_QUEUE_GH_RETRIES', 'MERGE_QUEUE_GH_RETRY_SECONDS'],
      ['MERGE_QUEUE_GH_RETRY_SECONDS', 'MERGE_QUEUE_GH_RETRIES'],
    ]) {
      for (const bad of ['x', '-1', '1.5', '²']) {
        c.env[name] = bad
        c.env[other] = '1'
        const r = await c.runQueue({ '1': pr() }, ['1'])
        assert.equal(r.code, 2, `${name}=${bad}\n${both(r)}`)
        has(r.stderr, `${name} 는 정수다`)
      }
    }
  })

  test('SKIPPED 필수 체크는 --skipped-is-missing 일 때만 나타나지 않은 것으로 본다', async (t) => {
    const c = setup(t)
    const skipped = [{ name: 'verify', status: 'COMPLETED', conclusion: 'SKIPPED' }]
    let r = await c.runQueue({ '1': pr({ statusCheckRollup: skipped }) }, ['--required', 'verify', '1'])
    assert.equal(r.code, 0, both(r))
    r = await c.runQueue({ '1': pr({ statusCheckRollup: skipped }) }, ['--required', 'verify', '--skipped-is-missing', '--check-timeout', '0', '1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '나타나지 않은 필수 체크 verify')
    const ran = { left: 3, checks: [check('verify')] }
    r = await c.runQueue({ '1': pr({ statusCheckRollup: skipped, appear: ran }) }, ['--required', 'verify', '--skipped-is-missing', '1'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 MERGED')
  })

  test('--after-merged 는 머지한 PR 로 한 번 돈다', async (t) => {
    const c = setup(t)
    const seen = join(c.tmp, 'after.txt')
    const r = await c.runQueue({ '1': pr(), '2': pr(), '3': pr({ state: 'MERGED' }) }, [
      '--after-merged',
      `echo "$MERGED_PRS|$CODE_PRS" >> ${seen}`,
      '1',
      '2',
      '3',
    ])
    assert.equal(r.code, 0, both(r))
    assert.equal(readFileSync(seen, 'utf8'), '1 2|1 2\n')
  })

  test('뒤 PR 이 보류로 멈춰도 앞서 머지한 PR 의 --after-merged 는 돈다', async (t) => {
    const c = setup(t)
    const seen = join(c.tmp, 'after.txt')
    const r = await c.runQueue({ '1': pr(), '2': pr({ statusCheckRollup: FAILED }) }, ['--after-merged', `echo "$MERGED_PRS" > ${seen}`, '1', '2'])
    assert.equal(r.code, 1, both(r))
    assert.equal(readFileSync(seen, 'utf8'), '1\n')
  })

  test('머지한 PR 이 없으면 --after-merged 를 건너뛰고, 그 실패는 종료 코드 3 이다', async (t) => {
    const c = setup(t)
    const seen = join(c.tmp, 'after.txt')
    let r = await c.runQueue({ '1': pr({ state: 'MERGED' }) }, ['--after-merged', `touch ${seen}`, '1'])
    assert.equal(r.code, 0, both(r))
    assert.equal(existsSync(seen), false)
    r = await c.runQueue({ '1': pr() }, ['--after-merged', 'exit 7', '1'])
    assert.equal(r.code, 3, both(r))
    has(r.stdout, 'AFTER-MERGED-FAILED 7')
    has(r.stdout, '1 MERGED')
  })

  test('PR HEAD 와 원격 브랜치 HEAD 가 다르면 멈춘다', async (t) => {
    const c = setup(t)
    c.env.FAKE_REMOTE_HEAD = 'def'
    const r = await c.runQueue({ '1': pr() }, ['1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 head 불일치 pr=abc remote=def')
    lacks(c.log(), 'pr merge')
  })

  test('머지 전 명령이 실패하면 멈춘다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr() }, ['--before', 'exit 3', '1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 머지 전 명령 실패')
    lacks(c.log(), 'pr merge')
  })

  test('이미 MERGED 인 PR 은 건너뛰고 fork PR 의 브랜치는 지우지 않는다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr({ state: 'MERGED' }), '2': pr({ isCrossRepository: true }) }, ['1', '2'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 이미 MERGED')
    lacks(c.log(), '--delete')
  })

  test('머지 전 명령이 도는 사이 HEAD 가 바뀌면 머지하지 않고 멈춘다', async (t) => {
    const c = setup(t)
    const move = editStateCmd(c, { headRefOid: 'new' }, "['1']")
    const r = await c.runQueue({ '1': pr() }, [`1:${move}`])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 검사 뒤 HEAD 가 바뀌었다 checked=abc now=new')
    lacks(c.log(), 'pr merge')
  })

  test('release 브랜치와 다른 열린 PR 의 base 인 브랜치는 남긴다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr({ headRefName: 'release/1.0' }) }, ['1'])
    assert.equal(r.code, 0, both(r))
    c.env.FAKE_BASED = '1'
    const r2 = await c.runQueue({ '2': pr() }, ['2'])
    assert.equal(r2.code, 0, both(r2))
    lacks(c.log(), '--delete')
  })
})

describe('merge_queue 필수 체크', { skip: !HAS_TOOLS && 'jq 와 bash 가 필요하다', concurrency: 4 }, () => {
  test('필수 체크가 나타날 때까지 기다린다. 대기 0 을 완료로 보지 않는다', async (t) => {
    const c = setup(t)
    const p = pr({ statusCheckRollup: [], appear: { left: 30, checks: [check('backend')] } })
    const r = await c.runQueue({ '1': p, _rules: rules('backend') }, ['1'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 MERGED')
    // 머지된 시점에 필수 체크가 이미 나타나 있어야 한다
    const rollup = (c.state()['1'] as { statusCheckRollup: { name: string }[] }).statusCheckRollup
    assert.deepEqual(
      rollup.map((x) => x.name),
      ['backend'],
    )
  })

  test('--required 가 저장소 규칙보다 앞서고, 체크 대기 한도를 넘으면 멈춘다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr({ statusCheckRollup: [check('backend')] }), _rules: rules('backend') }, [
      '--required',
      'backend,frontend',
      '--check-timeout',
      '0',
      '1',
    ])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '나타나지 않은 필수 체크 frontend')
    lacks(c.log(), 'pr merge')
  })

  test('필수 체크를 저장소 규칙에서 읽는다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr({ statusCheckRollup: [check('backend')] }), _rules: rules('backend', 'lint') }, ['--check-timeout', '0', '1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '나타나지 않은 필수 체크 lint')
  })

  test('규칙 조회가 실패하면 멈춘다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr(), _api_fails: true }, ['1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '필수 체크 규칙 조회 실패')
    lacks(c.log(), 'pr merge')
  })

  test('플랜 제한의 403 은 필수 체크 목록이 빈 것으로 다룬다', async (t) => {
    const c = setup(t)
    const msg = 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)'
    const r = await c.runQueue({ '1': pr(), _rules_error: msg }, ['1'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '저장소 규칙을 읽을 수 없다')
    has(r.stdout, '필수 체크 목록이 비어 있다')
    has(c.log(), 'pr merge')
  })

  test('그 밖의 규칙 조회 실패는 멈춘다', async (t) => {
    const c = setup(t)
    for (const msg of [
      'gh: Resource not accessible by integration (HTTP 403)',
      'gh: Not Found (HTTP 404)',
      'gh: Bad credentials (HTTP 401)',
    ]) {
      const r = await c.runQueue({ '1': pr(), _rules_error: msg }, ['1'])
      assert.equal(r.code, 1, `${msg}\n${both(r)}`)
      has(r.stdout, '필수 체크 규칙 조회 실패')
      lacks(c.log(), 'pr merge')
    }
  })

  test('필수 체크 목록이 비면 경고하고 지금 있는 체크만 기다린다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr() }, ['1'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '필수 체크 목록이 비어 있다')
  })
})

describe('merge_queue --require-up-to-date', { skip: !HAS_TOOLS && 'jq 와 bash 가 필요하다', concurrency: 4 }, () => {
  test('뒤처지면 PR URL 호스트와 검사한 HEAD 로 update-branch 하고 체크를 다시 기다려 새 HEAD 로 머지한다', async (t) => {
    const c = setup(t)
    const p = pr({ statusCheckRollup: [check('backend')], after_update: [check('backend')] })
    const r = await c.runQueue({ '1': p, _behind: 2 }, ['--required', 'backend', '--require-up-to-date', '1'])
    assert.equal(r.code, 0, both(r))
    const log = c.log()
    has(log, 'api --hostname git.example.com -X PUT repos/owner/repo/pulls/1/update-branch -f expected_head_sha=abc\n')
    has(log, 'pr merge 1 --merge --match-head-commit new')
    assert.ok(log.indexOf('update-branch') < log.indexOf('pr merge'), log)
    has(r.stdout, '1 base(main) 보다 2 커밋 뒤처졌다. update-branch 후 체크를 다시 기다린다')
  })

  test('PR URL 의 엔터프라이즈 호스트가 모든 api 호출과 스레드 명령의 GH_HOST 로 간다', async (t) => {
    const c = setup(t)
    const hostSeen = join(c.tmp, 'threads-host.txt')
    const p = pr({ url: 'https://ghe.example.com/owner/repo/pull/1', statusCheckRollup: [check('backend')], after_update: [check('backend')] })
    c.writeState({ '1': p, _rules: rules('backend'), _behind: 1 })
    delete c.env.GH_HOST
    const r = await spawnDone([...NODE, '--repo', c.tmp, '--require-up-to-date', '--threads-cmd', `echo "$GH_HOST" > ${hostSeen}; echo 0`, '1'], {
      env: c.env,
    })
    assert.equal(r.code, 0, both(r))
    const api = c
      .log()
      .split('\n')
      .filter((line) => line.startsWith('api '))
    // 규칙 조회, update-branch 앞뒤의 compare 두 번, update-branch
    assert.equal(api.length, 4, api.join('\n'))
    for (const line of api) assert.ok(line.startsWith('api --hostname ghe.example.com '), line)
    assert.equal(readFileSync(hostSeen, 'utf8'), 'ghe.example.com\n')
  })

  test('전역 GH_HOST 가 다른 호스트를 가리켜도 PR URL 호스트를 따른다', async (t) => {
    const c = setup(t)
    const hostSeen = join(c.tmp, 'threads-host.txt')
    c.env.GH_HOST = 'github.com'
    c.writeState({ '1': pr(), _rules: rules() })
    const r = await spawnDone([...NODE, '--repo', c.tmp, '--threads-cmd', `echo "$GH_HOST" > ${hostSeen}; echo 0`, '1'], { env: c.env })
    assert.equal(r.code, 0, both(r))
    has(c.log(), 'api --hostname git.example.com repos/owner/repo/rules/branches/main')
    assert.equal(readFileSync(hostSeen, 'utf8'), 'git.example.com\n')
  })

  test('기본은 꺼져 있어 뒤처져도 update-branch 없이 머지한다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr({ statusCheckRollup: [check('backend')] }), _behind: 2 }, ['--required', 'backend', '1'])
    assert.equal(r.code, 0, both(r))
    lacks(c.log(), 'update-branch')
    has(c.log(), 'pr merge 1 --merge --match-head-commit abc')
  })

  test('최신이면 update-branch 를 부르지 않는다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr({ statusCheckRollup: [check('backend')] }), _behind: 0 }, ['--required', 'backend', '--require-up-to-date', '1'])
    assert.equal(r.code, 0, both(r))
    lacks(c.log(), 'update-branch')
  })

  test('update-branch 가 실패하면 멈춘다', async (t) => {
    const c = setup(t)
    const p = pr({ statusCheckRollup: [check('backend')], update_fails: true })
    const r = await c.runQueue({ '1': p, _behind: 1 }, ['--required', 'backend', '--require-up-to-date', '1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 update-branch 실패(충돌 가능)')
    lacks(c.log(), 'pr merge')
  })

  test('필수 체크 목록이 없으면 쓸 수 없다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr() }, ['--require-up-to-date', '1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '--required 로 준다')
  })
})

// 판정 명령 대신 받은 인자를 적고 정해 둔 판정을 내는 가짜. 실제 판정은 overlap-units.spec.ts 가 본다.
// then 은 두 번째 호출부터 차례로 낼 [판정, 종료 코드] 이고 다 쓰면 마지막 것을 되풀이한다.
// moveBase 이면 판정하는 사이 원격 base 가 움직인 것으로 본다.
function fakeOverlapUnits(c: Ctx, verdict: string, code: number, then: [string, number][] = [], moveBase = false): void {
  const script = join(c.tmp, 'overlap_units.py')
  const args = JSON.stringify(join(c.tmp, 'judge-args.txt'))
  const verdicts: [string, number][] = [[verdict, code], ...then]
  writeFileSync(
    script,
    'import json, sys\n' +
      `open(${args}, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n` +
      `calls = len(open(${args}).read().splitlines())\n` +
      `verdict, code = ${JSON.stringify(verdicts)}[min(calls, ${verdicts.length}) - 1]\n` +
      `if ${moveBase ? 'True' : 'False'}:\n` +
      `    d = json.load(open(${JSON.stringify(c.stateFile)}))\n` +
      "    d['_base_head'] = f'base{calls}'\n" +
      `    json.dump(d, open(${JSON.stringify(c.stateFile)}, 'w'))\n` +
      'print(verdict, file=sys.stderr if code == 2 else sys.stdout)\nsys.exit(code)\n',
  )
  c.env.OVERLAP_UNITS = script
}

function judgeArgs(c: Ctx): string {
  const file = join(c.tmp, 'judge-args.txt')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function judgedCount(c: Ctx): number {
  return judgeArgs(c).split('\n').filter((line) => line).length
}

const UP_TO_DATE_OVERLAP = ['--required', 'backend', '--require-up-to-date', '--up-to-date-when', 'overlap']

function overlapQueue(c: Ctx, verdict: string, code: number, extra: string[] = [], behind = 2): Promise<Done> {
  fakeOverlapUnits(c, verdict, code)
  const p = pr({ statusCheckRollup: [check('backend')], after_update: [check('backend')] })
  return c.runQueue({ '1': p, _behind: behind }, [...UP_TO_DATE_OVERLAP, ...extra, '1'])
}

describe('merge_queue --up-to-date-when overlap', { skip: !HAS_TOOLS && 'jq 와 bash 가 필요하다', concurrency: 4 }, () => {
  test('단위가 겹치지 않으면 갱신 없이 머지하고 판정 명령에 옵션을 = 로 붙여 넘긴다', async (t) => {
    const c = setup(t)
    const r = await overlapQueue(c, '바로 머지', 0, [
      '--shared-paths',
      '^modules/common/',
      '--unit-prefix',
      'apps/',
      '--docs-glob',
      'docs/*,*.md',
      '--unit-group',
      'web,bff',
      '--unit-group',
      'a,b',
    ])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 판정: 바로 머지')
    lacks(c.log(), 'update-branch')
    has(c.log(), 'pr merge 1 --merge --match-head-commit abc')
    assert.equal(
      judgeArgs(c),
      '--base origin/main --head abc --shared-paths=^modules/common/ --unit-prefix=apps/ --docs-glob=docs/*,*.md --unit-group=web,bff --unit-group=a,b\n',
    )
  })

  test('- 로 시작하는 옵션 값도 판정 명령에 값으로 간다', async (t) => {
    const c = setup(t)
    const r = await overlapQueue(c, '바로 머지', 0, ['--shared-paths', '-lock$', '--docs-glob', '-x/*', '--unit-prefix', '-m/', '--unit-group', '-a,-b'])
    assert.equal(r.code, 0, both(r))
    assert.equal(judgeArgs(c), '--base origin/main --head abc --shared-paths=-lock$ --unit-prefix=-m/ --docs-glob=-x/* --unit-group=-a,-b\n')
  })

  test('단위가 겹치면 갱신하고 새 HEAD 로 머지한다', async (t) => {
    const c = setup(t)
    const r = await overlapQueue(c, '갱신 필요(단위 겹침: api)', 1)
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 판정: 갱신 필요(단위 겹침: api)')
    has(c.log(), 'pulls/1/update-branch')
    has(c.log(), 'pr merge 1 --merge --match-head-commit new')
  })

  test('판정하지 못하면 갱신 필요로 다룬다', async (t) => {
    const c = setup(t)
    const r = await overlapQueue(c, '오류: git diff 실패', 2)
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 판정: 갱신 필요(판정 실패: 오류: git diff 실패)')
    has(c.log(), 'pulls/1/update-branch')
  })

  test('최신인 브랜치는 판정하지 않는다', async (t) => {
    const c = setup(t)
    const r = await overlapQueue(c, '바로 머지', 0, [], 0)
    assert.equal(r.code, 0, both(r))
    lacks(r.stdout, '판정')
    assert.equal(judgeArgs(c), '')
  })

  test('always 는 판정 없이 늘 갱신한다', async (t) => {
    const c = setup(t)
    fakeOverlapUnits(c, '바로 머지', 0)
    const p = pr({ statusCheckRollup: [check('backend')], after_update: [check('backend')] })
    const r = await c.runQueue({ '1': p, _behind: 2 }, ['--required', 'backend', '--require-up-to-date', '--up-to-date-when', 'always', '1'])
    assert.equal(r.code, 0, both(r))
    has(c.log(), 'pulls/1/update-branch')
    assert.equal(judgeArgs(c), '')
  })

  test('옵션 조합을 검사한다', async (t) => {
    const c = setup(t)
    const cases: [string[], string][] = [
      [['--up-to-date-when', 'overlap'], '--require-up-to-date 와 함께'],
      [['--require-up-to-date', '--up-to-date-when', 'never'], 'always, overlap 중 하나'],
      [['--shared-paths', '^x/'], '--up-to-date-when overlap 과 함께'],
      [['--unit-group', 'a,b'], '--up-to-date-when overlap 과 함께'],
    ]
    for (const [args, message] of cases) {
      const r = await c.runQueue({ '1': pr() }, [...args, '1'])
      assert.equal(r.code, 2, `${args.join(' ')}\n${both(r)}`)
      has(r.stderr, message)
    }
  })

  test('바로 머지로 판정한 뒤 머지 직전에 base 가 움직이면 멈추지 않고 다시 판정해 머지한다', async (t) => {
    const c = setup(t)
    fakeOverlapUnits(c, '바로 머지', 0)
    const r = await c.runQueue({ '1': pr({ statusCheckRollup: [check('backend')] }), _behind: 2 }, [
      ...UP_TO_DATE_OVERLAP,
      '--before',
      editStateCmd(c, { _base_head: 'moved', _behind: 3 }),
      '1',
    ])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 판정한 뒤 base(main) 가 움직였다. 새로 들어온 변경으로 다시 판정한다')
    assert.equal(count(r.stdout, '1 판정: 바로 머지'), 2, r.stdout)
    lacks(c.log(), 'update-branch')
    has(c.log(), 'pr merge 1 --merge --match-head-commit abc')
  })

  test('최신이라 판정 없이 지나갔어도 그 뒤 base 가 움직이면 다시 판정한다', async (t) => {
    const c = setup(t)
    fakeOverlapUnits(c, '바로 머지', 0)
    const r = await c.runQueue({ '1': pr({ statusCheckRollup: [check('backend')] }), _behind: 0 }, [
      ...UP_TO_DATE_OVERLAP,
      '--before',
      editStateCmd(c, { _base_head: 'moved', _behind: 3 }),
      '1',
    ])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 판정한 뒤 base(main) 가 움직였다. 새로 들어온 변경으로 다시 판정한다')
    assert.equal(judgedCount(c), 1)
    assert.equal(count(r.stdout, '1 판정: 바로 머지'), 1, r.stdout)
    lacks(c.log(), 'update-branch')
    has(c.log(), 'pr merge 1 --merge --match-head-commit abc')
  })

  test('최신이었다가 움직인 base 가 겹치면 그때 갱신한다', async (t) => {
    const c = setup(t)
    fakeOverlapUnits(c, '갱신 필요(단위 겹침: api)', 1, [['바로 머지', 0]])
    const p = pr({ statusCheckRollup: [check('backend')], after_update: [check('backend')] })
    const r = await c.runQueue({ '1': p, _behind: 0 }, [...UP_TO_DATE_OVERLAP, '--before', editStateCmd(c, { _base_head: 'moved', _behind: 3 }), '1'])
    assert.equal(r.code, 0, both(r))
    assert.equal(count(c.log(), 'update-branch'), 1, c.log())
    has(c.log(), 'pr merge 1 --merge --match-head-commit new')
  })

  test('base 조회가 실패하면 움직인 것으로 읽지 않고 멈춘다', async (t) => {
    const c = setup(t)
    fakeOverlapUnits(c, '바로 머지', 0)
    const r = await c.runQueue({ '1': pr({ statusCheckRollup: [check('backend')] }), _behind: 2 }, [
      ...UP_TO_DATE_OVERLAP,
      '--before',
      editStateCmd(c, { _ls_remote_fails: true }),
      '1',
    ])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 base 조회 실패')
    lacks(r.stdout, '다시 판정한다')
    assert.equal(judgedCount(c), 1)
    lacks(c.log(), 'pr merge')
  })

  test('머지 직전에 움직인 base 가 겹치면 그때 갱신하고 새 HEAD 로 머지한다', async (t) => {
    const c = setup(t)
    fakeOverlapUnits(c, '바로 머지', 0, [
      ['갱신 필요(단위 겹침: api)', 1],
      ['바로 머지', 0],
    ])
    const p = pr({ statusCheckRollup: [check('backend')], after_update: [check('backend')] })
    const r = await c.runQueue({ '1': p, _behind: 2 }, [...UP_TO_DATE_OVERLAP, '--before', editStateCmd(c, { _base_head: 'moved', _behind: 3 }), '1'])
    assert.equal(r.code, 0, both(r))
    assert.equal(count(c.log(), 'update-branch'), 1, c.log())
    has(c.log(), 'pr merge 1 --merge --match-head-commit new')
    // 갱신으로 base 를 모두 품으면 더 판정하지 않는다
    assert.equal(judgedCount(c), 2)
  })

  test('갱신 뒤 base 가 또 움직여도 새 변경이 겹치지 않으면 다시 갱신하지 않고 머지한다', async (t) => {
    const c = setup(t)
    fakeOverlapUnits(c, '갱신 필요(단위 겹침: api)', 1, [['바로 머지', 0]])
    const p = pr({ statusCheckRollup: [check('backend')], after_update: [check('backend')] })
    const r = await c.runQueue({ '1': p, _behind: 2, _behind_after_update: 1 }, [...UP_TO_DATE_OVERLAP, '1'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '1 판정: 갱신 필요(단위 겹침: api)')
    has(r.stdout, '1 판정: 바로 머지')
    assert.ok(r.stdout.indexOf('갱신 필요') < r.stdout.indexOf('1 판정: 바로 머지'), r.stdout)
    assert.equal(count(c.log(), 'update-branch'), 1, c.log())
    has(c.log(), 'pr merge 1 --merge --match-head-commit new')
    assert.equal(judgedCount(c), 2)
  })

  test('base 가 계속 움직이면 다시 판정 5번 뒤 멈춘다', async (t) => {
    const c = setup(t)
    fakeOverlapUnits(c, '바로 머지', 0, [], true)
    const r = await c.runQueue({ '1': pr({ statusCheckRollup: [check('backend')] }), _behind: 2 }, [...UP_TO_DATE_OVERLAP, '1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 다시 판정을 5번 했는데도 base(main) 가 계속 움직인다')
    // 처음 한 번과 다시 판정 5번
    assert.equal(judgedCount(c), 6)
    lacks(c.log(), 'pr merge')
  })

  test('한 단위가 두 묶음에 들면 시작할 때 사용법 오류다', async (t) => {
    const c = setup(t)
    const r = await overlapQueue(c, '바로 머지', 0, ['--unit-group', 'a,b', '--unit-group', 'b,c'])
    assert.equal(r.code, 2, both(r))
    has(r.stderr, '--unit-group')
    has(r.stderr, '묶음 둘에 들어 있다')
    lacks(c.log(), 'pr view')
  })

  test('--docs-glob 은 --up-to-date-when overlap 과만 함께 써도 된다', async (t) => {
    const c = setup(t)
    const r = await overlapQueue(c, '바로 머지', 0, ['--docs-glob', '*.md'])
    assert.equal(r.code, 0, both(r))
  })
})

function allowFailState(...failed: string[]): Json {
  return { '1': pr({ statusCheckRollup: [check('backend'), ...failed.map((name) => check(name, 'FAILURE'))] }) }
}

describe('merge_queue --allow-fail 과 사용법 오류', { skip: !HAS_TOOLS && 'jq 와 bash 가 필요하다', concurrency: 4 }, () => {
  test('--allow-fail 이 없으면 비필수 체크의 실패로 멈춘다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue(allowFailState('claude-review'), ['--required', 'backend', '1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '실패한 체크 1 개')
    lacks(c.log(), 'pr merge')
  })

  test('--allow-fail 로 준 체크의 실패는 경고하고 머지한다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue(allowFailState('claude-review'), ['--required', 'backend', '--allow-fail', 'claude-review', '1'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '경고: 1 실패를 허용한 체크 claude-review')
    has(r.stdout, '1 MERGED')
    assert.ok(r.stdout.indexOf('경고:') < r.stdout.indexOf('MERGED'), r.stdout)
  })

  test('--allow-fail 은 다른 실패한 체크를 덮지 않는다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue(allowFailState('claude-review', 'browser'), ['--required', 'backend', '--allow-fail', 'claude-review', '1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '실패한 체크 1 개')
    lacks(c.log(), 'pr merge')
  })

  test('--required 에 든 이름을 --allow-fail 로 주면 사용법 오류다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue(allowFailState(), ['--required', 'backend,lint', '--allow-fail', 'lint', '1'])
    assert.equal(r.code, 2, both(r))
    has(r.stderr, '필수 체크의 실패는 허용할 수 없다')
  })

  test('저장소 규칙의 필수 체크를 --allow-fail 로 주면 멈춘다', async (t) => {
    const c = setup(t)
    const state = { ...allowFailState('backend'), _rules: rules('backend') }
    const r = await c.runQueue(state, ['--allow-fail', 'backend', '1'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, '필수 체크의 실패는 허용할 수 없다')
    lacks(c.log(), 'pr merge')
  })

  test('--allow-fail 은 따옴표를 받지 않는다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({}, ['--allow-fail', 'a"b', '1'])
    assert.equal(r.code, 2, both(r))
  })

  test('값이 없는 옵션과 정수가 아닌 --check-timeout 은 사용법 오류다', async (t) => {
    const c = setup(t)
    let r = await c.runQueue({}, ['1', '--check-timeout'])
    assert.equal(r.code, 2, both(r))
    has(r.stderr, '--check-timeout 에 값이 없다')
    r = await c.runQueue({}, ['--check-timeout', '1.5', '1'])
    assert.equal(r.code, 2, both(r))
  })

  test('모르는 옵션과 줄여 쓴 옵션은 사용법 오류다', async (t) => {
    const c = setup(t)
    for (const arg of ['--nope', '--req', '--repo=x', '--no-swee']) {
      const r = await c.runQueue({}, [arg, '1'])
      assert.equal(r.code, 2, `${arg}\n${both(r)}`)
      has(r.stderr, `모르는 옵션: ${arg}`)
    }
  })

  test('PR 번호가 없으면 사용법을 stdout 에 찍고 2 로 끝난다', async (t) => {
    const c = setup(t)
    for (const args of [[], ['-h'], ['--help', '1']]) {
      const r = await spawnDone([...NODE, ...args], { env: c.env })
      assert.equal(r.code, 2, `${args.join(' ')}\n${both(r)}`)
      assert.ok(r.stdout.startsWith('사용: merge_queue.ts [옵션] PR[:머지 전 명령] ...\n'), r.stdout)
      has(r.stdout, '종료 코드: 0 모두 머지')
    }
  })

  test('--verify-merged-when 과 --docs-glob 은 --verify-merged 가 있어야 한다', async (t) => {
    const c = setup(t)
    for (const args of [['--verify-merged-when', 'code'], ['--verify-merged-when', 'always'], ['--docs-glob', '*.md']]) {
      const r = await c.runQueue({}, [...args, '1'])
      assert.equal(r.code, 2, `${args.join(' ')}\n${both(r)}`)
      has(r.stderr, '--verify-merged 와 함께 쓴다')
    }
    const r = await c.runQueue({}, ['--verify-merged', 'true', '--verify-merged-when', 'sometimes', '1'])
    assert.equal(r.code, 2, both(r))
  })
})

describe('merge_queue 보류', { skip: !HAS_TOOLS && 'jq 와 bash 가 필요하다', concurrency: 4 }, () => {
  test('기본은 첫 보류에서 멈추고 정리를 부르지 않는다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr({ statusCheckRollup: FAILED }), '2': pr({ headRefName: 'b' }) }, ['1', '2'])
    assert.equal(r.code, 1, both(r))
    lacks(c.log(), 'pr merge 2')
    lacks(r.stdout, 'QUEUE-')
    assert.equal(existsSync(c.sweepLog), false)
  })

  test('--continue-on-hold 는 나머지를 머지하고 보류한 PR 을 알린다', async (t) => {
    const c = setup(t)
    const state = { '1': pr({ statusCheckRollup: FAILED }), '2': pr({ headRefName: 'b', baseRefName: 'develop' }), '3': pr({ statusCheckRollup: FAILED }) }
    const r = await c.runQueue(state, ['--continue-on-hold', '1', '2', '3'])
    assert.equal(r.code, 1, both(r))
    has(r.stdout, 'STOP 1 실패한 체크 1 개')
    has(r.stdout, '1 보류. 다음 PR 로 간다')
    has(c.log(), 'pr merge 2 --merge')
    has(r.stdout, 'QUEUE-HELD 1 3')
    lacks(r.stdout, 'QUEUE-DONE')
    // 머지된 PR 이 있으니 정리는 돈다. base 는 마지막으로 읽은 PR(3) 의 것이다
    has(readFileSync(c.sweepLog, 'utf8'), '--base main --apply')
  })

  test('--continue-on-hold 에서 보류가 없으면 QUEUE-DONE 이다', async (t) => {
    const c = setup(t)
    const r = await c.runQueue({ '1': pr() }, ['--continue-on-hold', '1'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, 'QUEUE-DONE')
  })
})

// `gh run list --commit` 은 최근 실행 N 개를 받은 뒤 커밋으로 필터링한다. CI 가 몰리면 그 PR 의 실행이 밀려나
// 「실행 없음」 으로 머지를 보류한다(2026-10-23 실측). 커밋의 실행은 actions/runs?head_sha= 로 읽는다.
// 명령이 .ts 로 옮겨 가므로 .py, .sh 에 더해 .ts 와 lib/ 아래 .ts 도 본다
describe('CI 조회', () => {
  function scripts(dir: string, recurse: boolean): string[] {
    const found: string[] = []
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        if (recurse || name === 'lib') found.push(...scripts(path, true))
      } else if (recurse ? extname(name) === '.ts' : ['.py', '.sh', '.ts'].includes(extname(name))) {
        found.push(path)
      }
    }
    return found
  }

  test('어느 스크립트도 run list 를 커밋으로 필터링하지 않는다', () => {
    const files = scripts(SCRIPTS, false)
    assert.ok(files.includes(SCRIPT), '훑은 목록에 merge_queue.ts 가 없다')
    assert.ok(files.includes(join(SCRIPTS, 'lib', 'gh.ts')), '훑은 목록에 lib/gh.ts 가 없다')
    const pattern = /run["', ]+list[^\n]*--commit/
    const bad = files.filter((file) => pattern.test(readFileSync(file, 'utf8')))
    assert.deepEqual(bad, [])
  })
})
