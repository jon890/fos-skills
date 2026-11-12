// Run 이 둘 등록된 틱의 순서를 기록하고 비교한다. 로그 줄, 결과 줄(errors 의 키 순서), orca 와 gh 를 부르는 순서를 본다.
// 고정 입력 기록(tests/golden)은 Run 하나만 본다. 틱은 Run 마다 번갈아 도는 곳이 여럿이라 그 순서를 따로 고정한다.
// 기록은 tests/loop-order/<사례>/ 에 있고 --record 로 다시 만든다. 틱의 순서를 일부러 바꿀 때만 다시 만든다.
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGolden, type Input } from './golden-run.ts'

const here = dirname(fileURLToPath(import.meta.url))
const envelope = (result: unknown) => JSON.stringify({ ok: true, result }) + '\n'
const json = (value: unknown) => JSON.stringify(value) + '\n'
// 앞에 등록한 r1 이 주 Run 이다(lib/loop.ts 의 registeredRuns 는 registered_at 순이다)
const registration = (run: string, at: string) => json({ run, specs_dir: null, registered_at: at })
const worker = (run: string) => ({ taskId: `t-${run}`, dispatchId: `d-${run}`, dispatchStatus: 'running', workerState: 'running', terminalState: 'active', agentTerminalHandle: `term_${run}`, resource: { worktreeId: `repo::<TMP>/worktree-${run}`, ownershipState: 'owned' }, projection: { liveness: { verdict: 'exited' } } })
const question = { id: 'q1', type: 'question', from_handle: 'term_r1', to_handle: 'run:r1', run_id: 'r1', task_id: 't-r1', dispatch_id: 'd-r1', created_at: '2026-11-09T23:00:00Z', body: '방법을 알려 주세요', payload: { question: '방법을 알려 주세요' } }
// 모아 둔 알림. 보낸 지 주기(pipeline.digest_sec 기본 1800초)가 지나 이번 틱이 Run 마다 DIGEST 로 보낸다
const digest = (run: string) => json({ sent_at: '2026-11-09T00:00:00.000Z', items: [{ kind: 'STAGE-STALLED', text: `item-${run} 30분 pr`, at: '2026-11-09T23:30:00.000Z' }], streaks: {} })
const pr = { number: 1, state: 'OPEN', title: 'example', headRefName: 'feat', baseRefName: 'main', headRefOid: 'abc', isCrossRepository: false, author: { login: 'me' }, url: 'https://github.example/o/r/pull/1', mergeable: 'CONFLICTING', statusCheckRollup: [{ name: 'Tests', status: 'COMPLETED', conclusion: 'FAILURE' }] }

function cases(): Record<string, Input> {
  const found: Record<string, Input> = {}
  for (const name of ['two-runs-offline', 'two-runs-busy']) {
    const offline = name === 'two-runs-offline'
    found[name] = {
      script: 'loop/orch-loop.ts', args: ['--repo', '<TMP>/repo', '--run', 'r1', '--tick', '--tick-number', '1'],
      files: {
        'repo/.orch/config.json': json({ pipeline: { authors: ['me'] } }),
        'repo/.orch/state/loop-runs/r1.json': registration('r1', '2026-01-01T00:00:00Z'),
        'repo/.orch/state/loop-runs/r2.json': registration('r2', '2026-01-02T00:00:00Z'),
        'repo/.orch/state/notice-digest/r1.json': digest('r1'),
        'repo/.orch/state/notice-digest/r2.json': digest('r2'),
      },
      rules: {
        orca: offline ? [{ code: 1, stderr: 'offline\n' }] : [
          { args: ['worker-list', 'r1'], stdout: envelope({ workers: [worker('r1')], page: {}, scope: { source: 'flag' } }) },
          { args: ['worker-list', 'r2'], stdout: envelope({ workers: [worker('r2')], page: {}, scope: { source: 'flag' } }) },
          { args: ['task-list'], stdout: envelope({ tasks: [] }) },
          { args: ['check', '--all'], stdout: envelope({ messages: [] }) },
          { args: ['check', 'r1'], stdout: envelope({ messages: [question] }) },
          { args: ['check', 'r2'], stdout: envelope({ messages: [] }) },
          { args: ['terminal', 'read'], stdout: envelope({ lines: [] }) },
          { stdout: envelope({ messages: [], workers: [], runs: [], message: { id: 'notice' }, page: {}, scope: { source: 'all' } }) },
        ],
        gh: offline ? [{ code: 1, stderr: 'offline\n' }] : [
          { args: ['pr', 'list'], stdout: json([pr]) },
          { args: ['api', 'user'], stdout: 'me\n' }, { args: ['api'], stdout: '[]\n' }, { stdout: json({ ...pr, commits: [], files: [] }) },
        ],
        git: [{ args: ['--git-common-dir'], code: 128 }, { args: ['worktree', 'list'], stdout: 'worktree <TMP>/repo\nHEAD abc\nbranch refs/heads/main\n\n' }, { args: ['fetch'], code: 0 }, { args: ['rev-parse', '--verify'], stdout: 'abc\n' }, { args: ['cat-file'], code: 0 }, { args: ['merge-tree'], code: 1, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsrc/conflict.ts\n' }, { code: 1 }],
      },
    }
  }
  const settled = structuredClone(found['two-runs-busy'])
  settled.rules.orca = [
    { args: ['worker-list', 'r1'], stdout: envelope({ workers: Array.from({ length: 6 }, (_, i) => ({ ...worker(`r1-${i}`), dispatchStatus: 'completed', workerState: 'succeeded' })), page: {}, scope: { source: 'flag' } }) },
    { args: ['worker-list', 'r2'], stdout: envelope({ workers: [], page: {}, scope: { source: 'flag' } }) },
    { args: ['check', '--all'], stdout: envelope({ messages: [] }) },
    { args: ['check', 'r1'], stdout: envelope({ messages: Array.from({ length: 6 }, (_, i) => ({ ...question, id: `q${i}`, from_handle: `term_r1-${i}`, dispatch_id: `d-r1-${i}` })) }) },
    { stdout: envelope({ messages: [], workers: [], runs: [], page: {}, message: { id: 'notice' }, scope: { source: 'all' } }) },
  ]
  settled.rules.gh = [{ args: ['pr', 'list'], stdout: '[]\n' }, { stdout: '[]\n' }]
  found['settled-dispatches'] = settled
  return found
}

export function runLoopOrder(record = false): void {
  runGolden(record, undefined, { dir: join(here, '..', 'loop-order'), cases, calls: ['orca', 'gh'] })
}
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) runLoopOrder(process.argv.includes('--record'))
