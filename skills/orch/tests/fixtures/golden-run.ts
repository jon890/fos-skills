// 기존 CLI 의 입력과 결과를 기록한다. --record 는 명시적으로만 기대값을 쓴다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeBin, type FakeRule } from './fake-bin.ts'
import { linkBin } from '../../../../modules/testkit/fake-bin.ts'
import { FAKE_GH, FAKE_GIT } from './merge-queue-fakes.ts'

export type Input = { script: string; args: string[]; files: Record<string, string>; rules: Record<string, FakeRule[]>; queue?: Record<string, unknown> }
// 기록 묶음. dir 아래 <사례>/input.json 과 result.json 을 둔다. calls 에 적은 가짜 명령은 받은 인자를 호출 순서대로 결과에 담는다
export type GoldenSet = { dir: string; cases: () => Record<string, Input>; calls?: string[] }
const here = dirname(fileURLToPath(import.meta.url))
const golden = join(here, '..', 'golden')
const scripts = join(here, '..', '..', 'scripts')
const envelope = (result: unknown) => JSON.stringify({ ok: true, result }) + '\n'
const json = (value: unknown) => JSON.stringify(value) + '\n'
const registration = json({ run: 'r', specs_dir: null, registered_at: '2026-01-01T00:00:00Z' })
const worker = { taskId: 't', dispatchId: 'd', dispatchStatus: 'running', workerState: 'running', terminalState: 'active', agentTerminalHandle: 'term_worker', resource: { worktreeId: 'repo::<TMP>/worktree', ownershipState: 'owned' }, projection: { liveness: { verdict: 'exited' } } }
const pr = { number: 1, state: 'OPEN', title: 'example', headRefName: 'feat', baseRefName: 'main', headRefOid: 'abc', isCrossRepository: false, author: { login: 'me' }, url: 'https://github.example/o/r/pull/1', mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-01-01T00:00:00Z' }] }

function cases(): Record<string, Input> {
  const found: Record<string, Input> = {}
  for (const name of ['ci-conflict', 'unanswered-stopped', 'offline']) {
    const question = { id: 'q', type: 'question', from_handle: 'term_worker', to_handle: 'run:r', run_id: 'r', task_id: 't', dispatch_id: 'd', created_at: '2026-11-09T23:00:00Z', body: '방법을 알려 주세요', payload: { question: '방법을 알려 주세요' } }
    found[`loop/${name}`] = {
      script: 'loop/orch-loop.ts', args: ['--repo', '<TMP>/repo', '--run', 'r', '--tick', '--tick-number', '1'],
      files: { 'repo/.orch/config.json': json({ pipeline: { authors: ['me'] } }), 'repo/.orch/state/loop-runs/r.json': registration },
      rules: {
        orca: name === 'offline' ? [{ code: 1, stderr: 'offline\n' }] : [
          { args: ['worker-list'], stdout: envelope({ workers: name === 'unanswered-stopped' ? [worker] : [], page: {}, scope: { source: 'all' } }) },
          { args: ['check', 'question,escalation'], stdout: envelope({ messages: name === 'unanswered-stopped' ? [question] : [] }) },
          { args: ['check', '--all'], stdout: envelope({ messages: [] }) },
          { args: ['check'], stdout: envelope({ messages: name === 'unanswered-stopped' ? [question] : [] }) },
          { args: ['terminal', 'read'], stdout: envelope({ lines: [] }) },
          { stdout: envelope({ messages: [], workers: [], runs: [], message: { id: 'notice' }, page: {}, scope: { source: 'all' } }) },
        ],
        gh: name === 'offline' ? [{ code: 1, stderr: 'offline\n' }] : [
          { args: ['pr', 'list'], stdout: json(name === 'ci-conflict' ? [{ ...pr, mergeable: 'CONFLICTING', statusCheckRollup: [{ name: 'Tests', status: 'COMPLETED', conclusion: 'FAILURE' }] }] : []) },
          { args: ['api', 'user'], stdout: 'me\n' }, { args: ['api'], stdout: '[]\n' }, { stdout: json({ ...pr, commits: [], files: [] }) },
        ],
        git: [{ args: ['--git-common-dir'], code: 128 }, { args: ['worktree', 'list'], stdout: 'worktree <TMP>/repo\nHEAD abc\nbranch refs/heads/main\n\n' }, { args: ['fetch'], code: 0 }, { args: ['rev-parse', '--verify'], stdout: 'abc\n' }, { args: ['cat-file'], code: 0 }, { args: ['merge-tree'], code: 1, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsrc/conflict.ts\n' }, { code: 1 }],
      },
    }
  }
  for (const name of ['merge', 'ci-failure', 'conflict']) found[`queue/${name}`] = {
    script: 'queue/merge_queue.ts', args: ['--repo', '<TMP>/repo', '--threads-cmd', 'echo 0', '--keep-branch', '1'], files: {}, rules: {},
    queue: { '1': { ...pr, ...(name === 'ci-failure' ? { statusCheckRollup: [{ name: 'Tests', status: 'COMPLETED', conclusion: 'FAILURE' }] } : name === 'conflict' ? { mergeable: 'CONFLICTING' } : {}) } },
  }
  for (const name of ['merged-worktree', 'live-worker', 'legacy-state']) found[`cleanup/${name}`] = {
    script: 'cleanup/cleanup-sweep.ts', args: ['--repo', '<TMP>/repo', '--run', 'r', '--base', 'main', '--trash', '<TMP>/trash'],
    files: { 'repo/.git/HEAD': 'ref: refs/heads/main\n', ...(name === 'legacy-state' ? { 'repo/.orch/state/wait/old.json': '{}', 'repo/.orch/state/loop-events/r.jsonl': json({ text: '옛 알림' }) } : {}) },
    rules: {
      git: [
        { args: ['--git-common-dir'], stdout: '<TMP>/repo/.git\n' },
        { args: ['worktree', 'list'], stdout: 'worktree <TMP>/repo\nHEAD abc\nbranch refs/heads/main\n\n' + (name === 'legacy-state' ? '' : 'worktree <TMP>/worktree\nHEAD abc\nbranch refs/heads/feat\n\n') },
        { args: ['rev-parse'], stdout: 'abc\n' }, { args: ['show-ref'], stdout: 'abc refs/remotes/origin/main\n' }, { stdout: '' },
      ],
      orca: [
        { args: ['run-list'], stdout: envelope({ runs: [{ id: 'r' }], nextCursor: null }) },
        { args: ['worker-list', '--run'], stdout: envelope({ workers: name === 'live-worker' ? [worker] : [], scope: { source: 'flag' }, page: {} }) },
        { args: ['worker-list'], stdout: envelope({ workers: name === 'live-worker' ? [worker] : [], scope: { source: 'all' }, page: {} }) },
        { stdout: envelope({ terminals: [], messages: [], runs: [], tasks: [], page: {} }) },
      ],
      gh: [
        { args: ['repo', 'view'], stdout: json({ url: 'https://github.example/o/r' }) },
        { args: ['api', 'graphql'], stdout: json({ data: { repository: { h0: { nodes: [{ ...pr, state: 'MERGED' }] } } } }) },
        { args: ['--head'], stdout: json([{ ...pr, state: 'MERGED' }]) }, { stdout: '[]\n' },
      ],
      lsof: [{ code: 1 }], ps: [{ stdout: '' }], docker: [{ code: 1 }],
    },
  }
  const applied = structuredClone(found['cleanup/merged-worktree'])
  applied.args.push('--apply')
  found['cleanup/merged-worktree-apply'] = applied
  return found
}

function filesAt(root: string): Record<string, string> {
  if (!existsSync(root)) return {}
  const found: Record<string, string> = {}
  function visit(dir: string, prefix: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name
      if (entry.isDirectory()) visit(join(dir, entry.name), name + '/')
      else if (entry.isFile()) found[name] = readFileSync(join(dir, entry.name), 'utf8')
    }
  }
  visit(root, '')
  return found
}

// 가짜 명령이 받은 인자 목록. 호출 순서대로다. 한 번도 불리지 않았으면 빈 목록이다
function callsOf(file: string): string[][] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { argv: string[] }).argv)
}

export function runGolden(record = false, selected?: string, set: GoldenSet = { dir: golden, cases }): void {
  const inputs = record ? set.cases() : Object.fromEntries(Object.keys(set.cases()).map((name) => [name, JSON.parse(readFileSync(join(set.dir, name, 'input.json'), 'utf8')) as Input]))
  if (selected) assert.ok(Object.hasOwn(inputs, selected), `알 수 없는 고정 입력: ${selected}`)
  for (const [name, input] of Object.entries(inputs)) {
    if (selected && name !== selected) continue
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-golden-')))
    const expand = (text: string) => text.replaceAll('<TMP>', tmp)
    const normalize = (text: string) => text.replaceAll(tmp, '<TMP>')
    try {
      const bin = join(tmp, 'bin')
      mkdirSync(bin)
      mkdirSync(join(tmp, 'repo'))
      mkdirSync(join(tmp, 'worktree'))
      for (const [file, text] of Object.entries(input.files)) {
        mkdirSync(dirname(join(tmp, file)), { recursive: true })
        writeFileSync(join(tmp, file), expand(text))
      }
      for (const [command, rules] of Object.entries(input.rules)) fakeBin(bin, command, JSON.parse(expand(JSON.stringify(rules))))
      const noop = join(tmp, 'noop.ts')
      writeFileSync(noop, '')
      const env: NodeJS.ProcessEnv = { PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, HOME: join(tmp, 'home'), ORCA: join(bin, 'orca'), GH: join(bin, 'gh'), GIT: join(bin, 'git'), DOCKER: join(bin, 'docker'), ORCH_MACHINE_DIR: join(tmp, 'machine'), ORCH_GH_CACHE: '0', ORCH_CACHE_DIR: join(tmp, 'cache'), CLEANUP_SWEEP: noop, BOARD_SYNC: noop, GIT_CEILING_DIRECTORIES: tmp, LANG: 'C', TZ: 'UTC', NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import=${join(here, 'fixed-clock.ts')}` }
      if (input.queue) {
        linkBin(bin, 'gh', FAKE_GH)
        linkBin(bin, 'git', FAKE_GIT)
        fakeBin(bin, 'orca', [{ stdout: envelope({ message: { id: 'notice' } }) }])
        writeFileSync(join(tmp, 'queue.json'), json(input.queue))
        Object.assign(env, { FAKE_STATE: join(tmp, 'queue.json'), FAKE_LOG: join(tmp, 'calls.log'), FAKE_REMOTE_HEAD: 'abc', MERGE_QUEUE_SLEEP_SCALE: '0' })
      }
      const done = spawnSync(process.execPath, [join(scripts, input.script), ...input.args.map(expand)], { env, cwd: tmp, encoding: 'utf8', timeout: 30_000 })
      assert.ifError(done.error)
      const states = filesAt(join(tmp, 'repo', '.orch'))
      if (input.queue) states['queue.json'] = readFileSync(join(tmp, 'queue.json'), 'utf8')
      const calls = set.calls ? { calls: Object.fromEntries(set.calls.map((command) => [command, callsOf(join(bin, `${command}.calls.jsonl`))])) } : {}
      const normalized = normalize(JSON.stringify({ stdout: done.stdout, stderr: done.stderr, code: done.status, states, ...calls }))
        .replace(new RegExp(`(?<![0-9])${done.pid}(?![0-9])`, 'g'), '<PID>')
      const result = JSON.parse(normalized)
      const dest = join(set.dir, name)
      if (record) {
        mkdirSync(dest, { recursive: true })
        writeFileSync(join(dest, 'input.json'), JSON.stringify(input, null, 2) + '\n')
        writeFileSync(join(dest, 'result.json'), JSON.stringify(result, null, 2) + '\n')
      } else assert.deepEqual(result, JSON.parse(readFileSync(join(dest, 'result.json'), 'utf8')), name)
      console.log(`GOLDEN ${name} code=${done.status}`)
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) runGolden(process.argv.includes('--record'), process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : undefined)
