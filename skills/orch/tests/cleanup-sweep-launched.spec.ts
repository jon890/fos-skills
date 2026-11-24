// cleanup-sweep.ts 가 코디네이터가 띄운 worker 터미널을 알아보는 것과, PR 없이 끝난 워크트리를 치우는 것을 본다.
// 가짜 실행 파일, 상태와 공통 도우미는 fixtures/cleanup-sweep.ts 가 소유한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chmodSync, existsSync, mkdirSync, utimesSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { type Row, branches, calls, exists, fx, git, gone, has, lacks, runSweep, runSweepFull, save, squashMerge, worktree } from './fixtures/cleanup-sweep.ts'

type Own = { record?: boolean | Row; status?: string; state?: string; otherTerminal?: boolean }

// 끝난 worker 가 user_owned 로 남은 터미널을 쥔 워크트리. 기록은 launch-worker.ts 가 남기는 파일과 같은 꼴이다
function ownTerminal(path: string, opts: Own = {}): void {
  const dispatch = 'ctx_o'
  if (opts.record !== false) {
    const dir = join(fx.repo, '.orch/state/launched-workers')
    mkdirSync(dir, { recursive: true })
    const record = { dispatch, terminal: 'term_o', worktree: path, run: 'run_x', ...(typeof opts.record === 'object' ? opts.record : {}) }
    writeFileSync(join(dir, `${dispatch}.json`), JSON.stringify(record))
  }
  const worker: Row = {
    runId: 'run_x',
    dispatchId: dispatch,
    dispatchStatus: opts.status ?? 'completed',
    workerState: opts.state ?? 'succeeded',
    agentTerminalHandle: 'term_o',
    resource: { worktreeId: `x::${path}`, terminalHandle: 'term_o', ownershipState: 'user_owned', retainedReason: 'user_takeover' },
    // failed 는 이유가 알려진 오류(worker 보고)로 둔다. 이유를 모르는 failed 는 끊김처럼 남긴다(lib/worker-state.ts 의 「failed 의 이유」)
    ...(opts.status === 'failed' ? { projection: { stage: { detail: 'settled' } } } : {}),
  }
  fx.terminals = [{ handle: 'term_o', worktreePath: path }]
  fx.allWorkers = [worker]
  fx.workers = [worker]
}

describe('launch-worker 가 기록한 user_owned 터미널', () => {
  for (const command of ['finish', 'sweep']) test(`Run 옵션 없는 legacy ${command} 는 자기 worker 만 치우고 전역 단계는 생략한다`, () => {
    const owned = worktree('feat-legacy-owned')
    const head = squashMerge('feat-legacy-owned', owned)
    const foreign = worktree('feat-legacy-foreign')
    squashMerge('feat-legacy-foreign', foreign)
    ownTerminal(owned, { record: { branch: 'feat-legacy-owned' } })
    fx.terminals.push({ handle: 'tm', agentIdentity: 'codex' })
    fx.runs = { main: [], run_x: fx.workers }
    const entries = join(fx.repo, '.orch', 'state', 'loop-runs')
    mkdirSync(entries, { recursive: true })
    writeFileSync(join(entries, 'main.json'), JSON.stringify({ run: 'main', registered_at: '2026-11-17T00:00:00Z', coordinator_terminal: 'tm' }))
    const original = fx.env.ORCA!
    const wrapper = join(fx.tmp, 'guard-orca.js')
    writeFileSync(wrapper, `#!${process.execPath}
const a = process.argv.slice(2)
const fs = require('node:fs')
if (a[1] === 'run-current') fs.writeSync(1, JSON.stringify({ ok: true, result: { run: { id: 'run_x' } } }))
else if (a[1] === 'run-list') fs.writeSync(1, JSON.stringify({ ok: true, result: { runs: [{ id: 'main', coordinator_handle: 'tm' }, { id: 'run_x' }] } }))
else { const r = require('node:child_process').spawnSync(${JSON.stringify(original)}, a, { env: process.env, encoding: 'utf8' }); fs.writeSync(1, r.stdout || ''); fs.writeSync(2, r.stderr || ''); process.exitCode = r.status }
`)
    chmodSync(wrapper, 0o755)
    fx.env.ORCA = wrapper
    const originalGh = fx.env.GH!
    const gh = join(fx.tmp, 'guard-gh.js')
    const pr = { number: 1, state: 'MERGED', mergeCommit: { oid: head }, headRefName: 'feat-legacy-owned', headRefOid: head, baseRefName: 'main', title: 'legacy worker', body: '', author: { login: 'me' }, url: 'https://example.test/pr/1' }
    writeFileSync(gh, `#!${process.execPath}
const a = process.argv.slice(2)
const fs = require('node:fs')
if (a[0] === 'pr' && a[1] === 'view') fs.writeSync(1, JSON.stringify(${JSON.stringify(pr)}))
else { const r = require('node:child_process').spawnSync(${JSON.stringify(originalGh)}, a, { env: process.env, encoding: 'utf8' }); fs.writeSync(1, r.stdout || ''); fs.writeSync(2, r.stderr || ''); process.exitCode = r.status }
`)
    chmodSync(gh, 0o755)
    fx.env.GH = gh
    const trace = join(fx.tmp, 'git-trace.log')
    fx.env.GIT_TRACE = trace
    const marker = join(fx.tmp, 'after-cleanup-called')
    mkdirSync(join(fx.repo, '.orch', 'hooks'), { recursive: true })
    writeFileSync(join(fx.repo, '.orch', 'hooks', 'after-cleanup.ts'), `import { writeFileSync, symlinkSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'called')`)
    save()
    const finish = fileURLToPath(new URL('../scripts/queue/finish-pr.ts', import.meta.url))
    const sweep = fileURLToPath(new URL('../scripts/cleanup/cleanup-sweep.ts', import.meta.url))
    const argv = command === 'finish'
      ? [finish, '1', '--repo', fx.repo, '--poll-interval', '0.01', '--merge-timeout', '0.005', '--deploy-timeout', '0.005']
      : [sweep, '--repo', fx.repo, '--apply', '--wait', '0', '--poll-interval', '0.01']
    const done = spawnSync(process.execPath, argv, { env: fx.env, encoding: 'utf8', timeout: 60_000 })
    assert.equal(done.status, 0, done.stdout + done.stderr)
    const out = done.stdout
    if (command === 'finish') assert.match(out, /FINISH-DONE/)
    gone(owned, out)
    exists(foreign, out)
    assert.ok(branches().has('feat-legacy-foreign'))
    assert.equal(existsSync(marker), false)
    const traced = readFileSync(trace, 'utf8')
    assert.doesNotMatch(traced, /built-in: git (?:fetch|worktree prune)/)
  })

  test('끝난 dispatch 면 닫고 PR 상태로 정리한다', () => {
    const path = worktree('feat-l1')
    squashMerge('feat-l1', path)
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    assert.ok(!branches().has('feat-l1'))
    has(calls(), 'orca terminal close --terminal term_o')
    has(calls(), 'orca orchestration worker-release --dispatch ctx_o')
    assert.ok(existsSync(join(fx.repo, '.orch/state/launched-workers/ctx_o.json')))
  })

  test('send reopened 가 기록한 새 터미널도 코디네이터가 띄운 것으로 본다', () => {
    const path = worktree('feat-reopened')
    squashMerge('feat-reopened', path)
    ownTerminal(path, { record: false })
    const spec = join(fx.tmp, 'follow.md')
    writeFileSync(spec, '# 후속 작업\n허락: 로컬 검증.\nworker 선택: `codex` `gpt-6.1-sol` effort `medium`. 행: impl-explore. 이유: 구현.\n')
    const fake = join(fx.tmp, 'follow-orca.js')
    writeFileSync(fake, `#!${process.execPath}
const args = process.argv.slice(2)
const result = args[1] === 'send'
  ? { delivery: 'reopened', dispatchId: 'ctx_o', taskId: 'task_new' }
  : args[args.indexOf('--dispatch') + 1] === 'ctx_old'
    ? { dispatch: { status: 'completed', runId: 'run_x' }, worker: { worktreeId: ${JSON.stringify(path)}, agentTerminalHandle: 'term_old' } }
    : { worker: { agentTerminalHandle: 'term_o' } }
console.log(JSON.stringify({ ok: true, result }))
`)
    chmodSync(fake, 0o755)
    const script = fileURLToPath(new URL('../scripts/worker/send-to-worker.ts', import.meta.url))
    const sent = spawnSync(process.execPath, [script, '--dispatch', 'ctx_old', '--spec', spec], {
      env: { ...fx.env, ORCA: fake, ORCH_DIR: join(fx.repo, '.orch') }, encoding: 'utf8',
    })
    assert.equal(sent.status, 0, sent.stdout + sent.stderr)
    assert.match(sent.stdout, /FOLLOW-UP ctx_old ctx_o task_new/)
    const out = runSweep(['--run', 'run_x'])
    has(out, '터미널을 닫을 것 term_o')
    lacks(out, '남김: 사용자 보유 터미널')
  })

  test('failed 와 canceled 도 끝난 것으로 본다', () => {
    for (const status of ['failed', 'canceled']) {
      const path = worktree(`feat-l-${status}`)
      squashMerge(`feat-l-${status}`, path)
      ownTerminal(path, { status, state: 'fenced' })
      const out = runSweep(['--run', 'run_x', '--apply'])
      gone(path, out)
    }
  })

  test('기록에 없는 터미널은 사람의 것으로 보고 남긴다', () => {
    const path = worktree('feat-l2')
    squashMerge('feat-l2', path)
    ownTerminal(path, { record: false })
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '남김: 사용자 보유 터미널')
    lacks(calls(), 'terminal close')
  })

  test('끝나지 않은 dispatch 는 남긴다', () => {
    const path = worktree('feat-l3')
    squashMerge('feat-l3', path)
    ownTerminal(path, { status: 'dispatched', state: 'ready' })
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
  })

  test('기록한 워크트리나 터미널이 다르면 남긴다', () => {
    for (const [label, record] of Object.entries({ worktree: { worktree: '/elsewhere' }, terminal: { terminal: 'term_other' } })) {
      const path = worktree(`feat-l4-${label}`)
      squashMerge(`feat-l4-${label}`, path)
      ownTerminal(path, { record })
      const out = runSweep(['--run', 'run_x', '--apply'])
      exists(path, out)
      has(out, '남김: 사용자 보유 터미널')
    }
  })

  test('--run 이 없으면 어느 dispatch 의 것인지 몰라 남긴다', () => {
    const path = worktree('feat-l5')
    squashMerge('feat-l5', path)
    ownTerminal(path)
    const out = runSweep(['--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
  })

  test('PR 이 MERGED 가 아니면 터미널을 닫지 않는다', () => {
    const path = worktree('feat-l6')
    fx.prs['feat-l6'] = ['OPEN', git('-C', path, 'rev-parse', 'HEAD')]
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
  })

  test('dry-run 은 닫을 것만 낸다', () => {
    const path = worktree('feat-l7')
    squashMerge('feat-l7', path)
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x'])
    exists(path, out)
    has(out, '터미널을 닫을 것 term_o')
    lacks(calls(), 'terminal close')
  })
})

describe('PR 없이 끝난 워크트리', () => {
  test('앞선 커밋과 변경이 없으면 워크트리, 로컬과 원격 브랜치를 치운다', () => {
    const path = worktree('meas-1', { commits: 0 })
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    assert.ok(!branches().has('meas-1'))
    has(calls(), 'orca terminal close --terminal term_o')
  })

  test('터미널이 없어도 치운다', () => {
    const path = worktree('meas-2', { commits: 0, push: false })
    ownTerminal(path)
    fx.terminals = []
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
  })

  test('base 보다 앞선 커밋이 있으면 남기고 이유를 낸다', () => {
    for (const push of [false, true]) {
      const path = worktree(`meas-3-${push}`, { push })
      ownTerminal(path)
      const out = runSweep(['--run', 'run_x', '--apply'])
      exists(path, out)
      has(out, '치우지 않는 이유: 끝난 dispatch ctx_o, PR 없음, base 보다 앞선 커밋 1 개')
      lacks(calls(), 'terminal close')
    }
  })

  test('커밋 안 된 변경이 있으면 남긴다', () => {
    const path = worktree('meas-4', { commits: 0, push: false })
    writeFileSync(join(path, 'wip.txt'), 'x')
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '치우지 않는 이유: 커밋 안 된 변경')
  })

  test('끝나지 않은 dispatch 는 PR 을 보기 전에 남긴다', () => {
    const path = worktree('meas-5', { commits: 0, push: false })
    ownTerminal(path, { status: 'dispatched', state: 'ready' })
    fx.terminals = []
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    // 그 터미널이 user_takeover 로 남았고 화면이 작업 중이 아니라 사용자 보유로 본다
    has(out, `남김: 사용자 보유 터미널 (${path}). 근거: 사용자가 넘겨받은 터미널(ctx_o user_takeover`)
    lacks(calls(), '--head meas-5')
    lacks(calls(), 'headRefName: "meas-5"')
  })

  test('failed dispatch 도 끝난 것으로 보고 치운다', () => {
    const path = worktree('meas-6', { commits: 0, push: false })
    ownTerminal(path, { status: 'failed', state: 'fenced' })
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
    has(calls(), 'orca terminal close --terminal term_o')
  })

  test('dispatch 를 모르면(--run 이 없으면) 남긴다', () => {
    const path = worktree('meas-7', { commits: 0, push: false })
    ownTerminal(path)
    fx.terminals = []
    const out = runSweep(['--apply'])
    exists(path, out)
    has(out, '치우지 않는 이유: 그 경로의 dispatch 를 모른다')
  })

  test('원격 브랜치에 앞선 커밋이 있으면 원격과 워크트리를 남긴다', () => {
    const path = worktree('meas-8')
    git('-C', path, 'reset', '-q', '--hard', 'origin/main')
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, '치우지 않는 이유: 원격 브랜치 meas-8 에 base 보다 앞선 커밋 1 개')
    assert.ok(git('-C', fx.repo, 'ls-remote', '--heads', 'origin', 'meas-8').includes('meas-8'))
  })

  test('기록 없는 터미널이 있으면 닫지 않고 남긴다', () => {
    const path = worktree('meas-9', { commits: 0, push: false })
    ownTerminal(path, { record: false })
    fx.allWorkers = []
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    lacks(calls(), 'terminal close')
  })

  // orch worker relaunch 가 옛 dispatch 를 abandon 하고 새 dispatch 를 띄우기 전의 틈이다(lib/relaunch-hold.ts)
  function relaunchHold(path: string, at: Date, body?: string): void {
    const dir = join(fx.repo, '.orch/state/relaunch-hold')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ctx_o.json'), body ?? JSON.stringify({ dispatch: 'ctx_o', worktree: path, spec: null, at: at.toISOString() }))
  }

  test('다시 띄우는 중인 워크트리는 끝난 dispatch 뿐이어도 터미널과 함께 남긴다', () => {
    const path = worktree('meas-11', { commits: 0, push: false })
    ownTerminal(path, { status: 'abandoned', state: 'fenced' })
    relaunchHold(path, new Date())
    const out = runSweep(['--run', 'run_x', '--apply'])
    exists(path, out)
    has(out, `남김 ${path}: 다시 띄우는 중(옛 dispatch ctx_o`)
    lacks(calls(), 'terminal close')
    lacks(calls(), 'worker-release')
  })

  test('다른 경로의 보존 표시와 깨진 표시 파일은 이 워크트리를 지키지 않는다', () => {
    const path = worktree('meas-13', { commits: 0, push: false })
    ownTerminal(path, { status: 'abandoned', state: 'fenced' })
    relaunchHold(`${path}-other`, new Date())
    gone(path, runSweep(['--run', 'run_x', '--apply']))
    const broken = worktree('meas-14', { commits: 0, push: false })
    ownTerminal(broken, { status: 'abandoned', state: 'fenced' })
    relaunchHold(broken, new Date(), '{"dispatch": "ctx_o", "worktree":')
    gone(broken, runSweep(['--run', 'run_x', '--apply']))
  })

  test('24시간이 지난 보존 표시는 듣지 않는다', () => {
    const path = worktree('meas-12', { commits: 0, push: false })
    ownTerminal(path, { status: 'abandoned', state: 'fenced' })
    relaunchHold(path, new Date(Date.now() - 25 * 60 * 60 * 1000))
    const out = runSweep(['--run', 'run_x', '--apply'])
    gone(path, out)
  })

  test('dry-run 은 치울 것만 낸다', () => {
    const path = worktree('meas-10', { commits: 0, push: false })
    ownTerminal(path)
    const out = runSweep(['--run', 'run_x'])
    exists(path, out)
    has(out, 'worktree 와 로컬 브랜치를 지울 것 meas-10')
    lacks(calls(), 'terminal close')
  })
})

describe('머지 큐 로그 폴더', () => {
  test('끝난 마무리 로그는 --trash 로 옮기고 모르는 파일은 남긴다', () => {
    const queue = join(fx.repo, '.orch/queue')
    mkdirSync(queue, { recursive: true })
    writeFileSync(join(queue, 'finish-41.out'), 'FINISH-DONE\n')
    const old = new Date(Date.now() - 4 * 86_400_000)
    utimesSync(join(queue, 'finish-41.out'), old, old)
    fx.prViews['41'] = { state: 'MERGED' }
    writeFileSync(join(queue, 'memo.txt'), 'x')
    const trash = join(fx.tmp, 'trash-q')
    const out = runSweep(['--trash', trash, '--apply'])
    has(out, '머지 큐 로그 옮김')
    assert.ok(!existsSync(join(queue, 'finish-41.out')))
    assert.ok(existsSync(join(trash, 'queue', 'finish-41.out')))
    assert.ok(existsSync(join(queue, 'memo.txt')))
  })
})

describe('상태 파일 보존 기한', () => {
  function file(rel: string, text: string, days = 4): string {
    const target = join(fx.repo, '.orch', rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
    const stamp = new Date(Date.now() - days * 86_400_000)
    utimesSync(target, stamp, stamp)
    return target
  }

  test('미리 본 파일만 휴지통으로 옮기고 보관 대상은 남긴다', () => {
    const trash = join(fx.tmp, 'retention trash')
    const launch = (dispatch: string, branch: string, days?: number, cwd = fx.wts) => file(
      `state/launched-workers/${dispatch}.json`, JSON.stringify({ dispatch, branch, worktree: cwd }), days)
    const activeAutoLog = file('state/auto-merge/20261001T100100Z.log', 'MERGED 41\nQUEUE-DONE\n')
    file('state/auto-merge.json', JSON.stringify({ queue: { log: activeAutoLog } }))
    const expired = [
      ['queue/finish-41.out', file('queue/finish-41.out', 'FINISH-DONE\n')],
      ['queue/finish-41.pid', file('queue/finish-41.pid', '999999999')],
      ['state/finish-started/41', file('state/finish-started/41', '2026-10-01T10:00:00Z\n')],
      ['state/auto-merge/20261001T100000Z.log', file('state/auto-merge/20261001T100000Z.log', 'MERGED 41\nQUEUE-DONE\n')],
      ['state/launched-workers/ctx_done.json', launch('ctx_done', 'finished')],
      ['state/gh/logs/2026-10-01.jsonl', file('state/gh/logs/2026-10-01.jsonl', '{}\n', 2)],
    ]
    const retained = worktree('retained-worker', { commits: 0, push: false })
    const kept = [
      activeAutoLog,
      file('state/auto-merge/20261001T100300Z.log', 'QUEUE-HELD 42\n'),
      file('queue/finish-42.out', 'FINISH-FAIL\n'),
      file('queue/finish-43.out', 'FINISH-DONE\n'),
      file('state/finish-started/42', '2026-10-01T10:00:00Z\n'),
      file('state/finish-started/41.tmp', 'x'),
      launch('ctx_busy', 'busy'),
      launch('ctx_unknown', 'missing'),
      launch('ctx_open', 'open-branch'),
      launch('ctx_retained', 'retained-worker', 4, retained),
      launch('ctx_recent', 'recent', 2),
      file(`state/gh/logs/${new Date().toISOString().slice(0, 10)}.jsonl`, '{}\n'),
      file('state/gh/logs/2026-10-02.jsonl', '{}\n', 0.5),
      file('state/gh/cache/pr.json', '{}'),
      file('state/launch-history.jsonl', 'x'),
      file('state/routing-log.jsonl', 'x'),
      file('state/requests/history.jsonl', 'x'),
    ]
    const link = join(fx.repo, '.orch/state/gh/logs/2026-10-03.jsonl')
    symlinkSync(kept.at(-1)!, link)
    kept.push(link)
    fx.prViews['41'] = { state: 'MERGED', headRefName: 'finished' }
    fx.prViews['42'] = { state: 'OPEN' }
    fx.openHeads = ['open-branch']
    fx.allWorkers = [
      ...['ctx_done', 'ctx_open', 'ctx_recent', 'ctx_retained'].map((dispatchId) => ({ dispatchId, dispatchStatus: 'completed' })),
      { dispatchId: 'ctx_busy', dispatchStatus: 'dispatched', workerState: 'ready' },
    ]
    fx.env.ORCH_OUTPUT = 'short'
    const preview = runSweepFull(['--trash', trash])
    delete fx.env.ORCH_OUTPUT
    const text = preview.stdout
    lacks(text, 'WOULD-REMOVE ' + join(fx.repo, '.orch/state/launched-workers/ctx_retained.json'))
    for (const [, target] of expired) {
      has(text, `WOULD-REMOVE ${target}`)
      exists(target, text)
    }
    assert.ok(!existsSync(trash))
    const out = runSweep(['--apply', '--trash', trash])
    for (const [relative, target] of expired) {
      gone(target, out)
      exists(join(trash, relative), out)
    }
    for (const target of kept) exists(target, out)
  })

  test('미리 보기 뒤 다시 열린 PR 의 로그와 마무리 표시는 남긴다', () => {
    fx.env.ORCH_GH_CACHE = '1'
    fx.env.ORCH_GH_CACHE_TTL_SECONDS = '600'
    const log = file('queue/finish-61.out', 'FINISH-DONE\n')
    const mark = file('state/finish-started/61', '2026-10-01T10:00:00Z\n')
    const trash = join(fx.tmp, 'trash')
    fx.prViews['61'] = { state: 'CLOSED' }
    const preview = runSweep(['--trash', trash])
    has(preview, `휴지통으로 옮길 것 ${log}`)
    has(preview, `휴지통으로 옮길 것 ${mark}`)
    fx.prViews['61'] = { state: 'OPEN' }
    const out = runSweep(['--apply', '--trash', trash])
    exists(log, out)
    exists(mark, out)
    assert.ok(!existsSync(trash))
  })

  test('handoff 의 끝난 산출물을 정기 정리가 옮기고 열린 PR 과 기한 안의 것은 남긴다', () => {
    const trash = join(fx.tmp, 'trash')
    const merged = file('handoff/pr-565-review-3n09s8zy/out.md', '리뷰', 0)
    const openPr = file('handoff/pr-570/body.md', '본문')
    const stray = file('handoff/plan-old-preview.html', '<p>')
    const owned = file('handoff/pr-571-preview.html', '<p>')
    const fresh = file('handoff/note.md', '메모', 1)
    const pending = file('handoff/pending/gone-worker/body.md', '대기')
    utimesSync(dirname(pending), new Date(Date.now() - 4 * 86_400_000), new Date(Date.now() - 4 * 86_400_000))
    fx.prViews['565'] = { state: 'MERGED' }
    fx.prViews['570'] = { state: 'OPEN' }
    fx.prViews['571'] = { state: 'OPEN' }
    const preview = runSweep(['--trash', trash])
    for (const target of [dirname(merged), stray, dirname(pending)]) has(preview, `handoff 산출물을 휴지통으로 옮길 것 ${target}`)
    fx.env.ORCH_OUTPUT = 'short'
    const short = runSweepFull(['--trash', trash]).stdout
    delete fx.env.ORCH_OUTPUT
    for (const target of [dirname(merged), stray, dirname(pending), owned]) has(short, `WOULD-REMOVE ${target}\n`)
    has(short, 'SWEEP-DRY 4 0')
    exists(merged, preview)
    const out = runSweep(['--apply', '--trash', trash])
    gone(merged, out)
    gone(stray, out)
    gone(pending, out)
    gone(owned, out)
    for (const target of [openPr, fresh]) exists(target, out)
    assert.ok(existsSync(join(trash, 'handoff/pr-565-review-3n09s8zy/out.md')))
  })

  test('data/<보드 항목 id>/ 는 보드에서 그 항목이 지워지면 옮긴다', () => {
    const trash = join(fx.tmp, 'trash')
    writeFileSync(join(fx.repo, 'board.json'), JSON.stringify({ items: [{ id: 'item-live', status: 'doing' }] }))
    file('config.json', JSON.stringify({ finish: { board: 'board.json' } }))
    const live = file('data/item-live/base.json', '{}')
    const removed = file('data/item-gone/base.json', '{}', 0)
    const loose = file('data/raw.csv', 'a,b\n')
    const out = runSweep(['--apply', '--trash', trash])
    exists(live, out)
    gone(removed, out)
    gone(loose, out)
    assert.ok(existsSync(join(trash, 'data/item-gone/base.json')))
  })

  test('보드를 읽지 못하면 data 폴더를 남긴다', () => {
    file('config.json', JSON.stringify({ finish: { board: 'missing-board.json' } }))
    const kept = file('data/item-gone/base.json', '{}')
    const out = runSweep(['--apply', '--trash', join(fx.tmp, 'trash')])
    exists(kept, out)
  })

  test('cleanup.handoff_days 로 handoff 기한을 바꾼다', () => {
    file('config.json', JSON.stringify({ cleanup: { handoff_days: 10 } }))
    const stray = file('handoff/plan-old-preview.html', '<p>', 5)
    const out = runSweep(['--apply', '--trash', join(fx.tmp, 'trash')])
    exists(stray, out)
  })

  test('저장소 설정으로 보존 기한을 바꾼다', () => {
    file('config.json', JSON.stringify({ cleanup: { queue_days: 6, state_days: '5', gh_log_days: 3, folder_days: 2 } }))
    const kept = [
      file('queue/finish-51.out', 'FINISH-DONE\n', 5),
      file('state/finish-started/51', '2026-10-01T10:00:00Z\n', 4),
      file('state/gh/logs/2026-10-01.jsonl', '{}\n', 2),
    ]
    const old = file('state/gh/logs/2026-10-02.jsonl', '{}\n', 4)
    fx.prViews['51'] = { state: 'CLOSED' }
    const out = runSweep(['--apply', '--trash', join(fx.tmp, 'trash')])
    for (const target of kept) exists(target, out)
    gone(old, out)
  })
})
