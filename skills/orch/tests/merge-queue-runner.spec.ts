import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeRun } from '../../../modules/testkit/fake-run.ts'
import { run, runProcess, withRun } from '../scripts/lib/proc.ts'
import { main } from '../scripts/queue/merge_queue.ts'
import { ConfigError } from '../scripts/lib/config.ts'
import { Conflict, Deferred, HeadChanged, NotReady, StepState, WorkerFix } from '../scripts/queue/steps/model.ts'
import { parseArgs } from '../scripts/queue/steps/options.ts'
import { setup } from '../scripts/queue/steps/setup.ts'
import { afterQueue } from '../scripts/queue/steps/finish.ts'
import { attempt } from '../scripts/queue/steps/select.ts'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { runCommand } from '../../../modules/testkit/command.ts'
import { FAKE_GH, FAKE_GIT, HAS_TOOLS, writeNodeBin } from './fixtures/merge-queue-fakes.ts'
import { statefulRun } from './fixtures/merge-queue-run.ts'

test('주입은 비동기 호출 범위에만 남고 실제 실행으로 넘길 수 있다', async () => {
  const left = fakeRun({ probe: [{ stdout: 'left' }] })
  const right = fakeRun({ probe: [{ stdout: 'right' }] })
  const invoke = (runner: typeof run) => withRun(runner, async () => {
    await new Promise((resolve) => setImmediate(resolve))
    return run(['probe']).stdout
  })
  assert.deepEqual(await Promise.all([invoke(left.run), invoke(right.run)]), ['left', 'right'])
  const actual = withRun(() => runProcess([process.execPath, '-e', 'process.stdout.write("actual")']), () => run(['probe']))
  assert.equal(actual.stdout, 'actual')
  assert.equal(run(['probe']).code, 127)
})

test('큐를 import 하면 CLI 와 신호 처리기를 실행하지 않는다', () => {
  assert.equal(typeof main, 'function')
  assert.equal(process.listeners('SIGTERM').some((listener) => listener.name === 'onSignal'), false)
  assert.equal(process.listeners('SIGINT').some((listener) => listener.name === 'onSignal'), false)
})


const script = fileURLToPath(new URL('../scripts/queue/merge_queue.ts', import.meta.url))
const open = {
  state: 'OPEN', headRefOid: 'abc', headRefName: 'feat', baseRefName: 'main',
  url: 'https://git.example.com/owner/repo/pull/1', isCrossRepository: false,
  mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
}

for (const example of [
  { command: 'gh', args: ['pr', 'view', '1', '--json', 'state', '--jq', '.state'], state: { '1': open } },
  { command: 'gh', args: ['pr', 'merge', '1', '--match-head-commit', 'abc'], state: { '1': open } },
  { command: 'gh', args: ['pr', 'merge', '1', '--match-head-commit', 'wrong'], state: { '1': open } },
  { command: 'gh', args: ['api', 'repos/owner/repo/pulls/1/update-branch'], state: { '1': open } },
  { command: 'gh', args: ['api', 'repos/owner/repo/rules/branches/main', '--jq', '.'], state: { _rules_error: 'denied' } },
  { command: 'git', args: ['diff', '--name-only', 'base'], state: { _diff_sequence: [['a.txt']] } },
  { command: 'git', args: ['rev-parse', '--git-dir'], state: {} },
  { command: 'git', args: ['ls-remote', 'origin', 'main'], state: { _ls_remote_fails: true } },
]) {
  test(`함수 가짜와 실행 파일의 응답·상태가 같다: ${example.command} ${example.args.join(' ')}`, { skip: !HAS_TOOLS }, (t) => {
    const dir = tempDir('queue-parity-', t)
    const bin = writeNodeBin(dir, example.command, example.command === 'gh' ? FAKE_GH : FAKE_GIT)
    const state = join(dir, 'state.json')
    const log = join(dir, 'calls.txt')
    const env = { ...process.env, FAKE_STATE: state, FAKE_LOG: log }
    const reset = () => { writeFileSync(state, JSON.stringify(example.state)); writeFileSync(log, '') }
    const snapshot = () => [readFileSync(state, 'utf8'), readFileSync(log, 'utf8')]
    reset()
    const command = runCommand([bin, ...example.args], { env })
    const expected = snapshot()
    reset()
    const result = statefulRun(true)([example.command, ...example.args], { env })
    assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, {
      code: command.code, stdout: command.stdout, stderr: command.stderr,
    })
    assert.deepEqual(snapshot(), expected)
  })
}

for (const [label, fields, args, code, output] of [
  ['성공', {}, ['--no-sweep', '1'], 0, /QUEUE-DONE/],
  ['보류', { mergeable: 'CONFLICTING' }, ['--no-sweep', '1'], 1, /QUEUE-CONFLICT 1/],
  ['후처리 실패', {}, ['--no-sweep', '1'], 3, /AFTER-MERGED-FAILED 1/],
  ['사용법 오류', {}, ['--unknown'], 2, /모르는 옵션: --unknown/],
] as const) {
  test(`실제 CLI 의 ${label} 종료 코드와 출력`, { skip: !HAS_TOOLS }, (t) => {
    const dir = tempDir('queue-cli-', t)
    writeNodeBin(dir, 'gh', FAKE_GH)
    writeNodeBin(dir, 'git', FAKE_GIT)
    const state = join(dir, 'state.json')
    writeFileSync(state, JSON.stringify({ '1': { ...open, ...fields } }))
    const env = {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_STATE: state,
      FAKE_LOG: join(dir, 'calls.txt'), FAKE_REMOTE_HEAD: 'abc', MERGE_QUEUE_SLEEP_SCALE: '0',
    }
    if (code === 3) {
      mkdirSync(join(dir, '.orch', 'hooks'), { recursive: true })
      writeFileSync(join(dir, '.orch', 'hooks', 'after-queue.ts'), 'process.exit(1)\n')
    }
    delete env.GH
    delete env.ORCH_DIR
    const result = runCommand([process.execPath, script, '--repo', dir, '--threads-cmd', 'echo 0', ...args], { env })
    assert.equal(result.code, code, result.stdout + result.stderr)
    assert.match(result.stdout + result.stderr, output)
    if (code === 0) assert.equal(JSON.parse(readFileSync(state, 'utf8'))['1'].state, 'MERGED')
    assert.equal(existsSync(join(dir, '.git')), false)
  })
}


test('링크 경로로 직접 실행해도 사용법 오류를 반환한다', (t) => {
  const dir = tempDir('queue-link-', t)
  const linked = join(dir, 'queue.ts')
  symlinkSync(script, linked)
  for (const entry of new Set([linked, join(tmpdir(), basename(dir), 'queue.ts')])) {
    const result = runCommand([process.execPath, entry, '--unknown'])
    assert.equal(result.code, 2, result.stdout + result.stderr)
    assert.equal(result.stderr, '모르는 옵션: --unknown\n')
  }
})


test('가짜 본문의 예외도 실행 파일처럼 종료 코드와 stderr로 반환한다', { skip: !HAS_TOOLS }, (t) => {
  const dir = tempDir('queue-exception-', t)
  const bin = writeNodeBin(dir, 'gh', FAKE_GH)
  const state = join(dir, 'state.json')
  writeFileSync(state, '{}')
  const env = { ...process.env, FAKE_STATE: state, FAKE_LOG: join(dir, 'calls.txt') }
  const args = ['pr', 'view', '9', '--json', 'state', '--jq', '.state']
  const command = runCommand([bin, ...args], { env })
  const result = statefulRun(true)(['gh', ...args], { env })
  assert.equal(command.code, 1)
  assert.equal(result.code, command.code)
  assert.equal(result.stdout, command.stdout)
  const error = /TypeError:.*(?:\n|$)/
  assert.match(command.stderr, error)
  assert.equal(result.stderr.match(error)?.[0], command.stderr.match(error)?.[0])
})


test('단계 파일을 각각 import 해도 실행 환경과 신호 처리기를 바꾸지 않는다', () => {
  const folder = new URL('../scripts/queue/steps/', import.meta.url)
  const urls = readdirSync(folder).filter((name) => name.endsWith('.ts')).map((name) => new URL(name, folder).href)
  const code = `
    const before = { cwd: process.cwd(), term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') }
    for (const url of ${JSON.stringify(urls)}) await import(url)
    console.log(JSON.stringify({ before, after: { cwd: process.cwd(), term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') } }))
  `
  const result = runCommand([process.execPath, '--input-type=module', '-e', code])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  const { before, after } = JSON.parse(result.stdout)
  assert.deepEqual(after, before)
})

for (const [error, kind, conflict, retryable] of [
  [new Conflict('base 충돌'), 'held', true, undefined],
  [new WorkerFix('고침 필요', '리뷰 스레드', true), 'held', false, true],
  [new HeadChanged('HEAD 변경'), 'held', false, true],
  [new Deferred('1', ['changed.ts']), 'deferred', false, undefined],
  [new NotReady('CI 대기'), 'not-ready', false, undefined],
  [new ConfigError('설정 오류'), 'config', false, undefined],
] as const) {
  test(`단계를 나눠도 ${error.constructor.name} 분류와 정리 상태를 유지한다`, async () => {
    const state = new StepState(parseArgs(['--no-sweep', '1']))
    state.copy = 'fake-queue-copy'
    const calls: string[][] = []
    const runner: typeof run = (argv) => {
      calls.push(argv)
      if (basename(argv[0]) !== 'git') throw error
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const context = { script, here: new URL('../scripts/queue/', import.meta.url).pathname, sleepScale: 0 }
    const result = await withRun(runner, () => attempt(context, state, '1', 'quick'))
    assert.equal(result.kind, kind)
    assert.equal(state.mode, 'normal')
    assert.equal(state.copy, '')
    assert.deepEqual(state.conflicted, conflict ? ['1'] : [])
    Object.assign(state, result.changes)
    assert.deepEqual(state.conflicted, conflict ? ['1'] : [])
    if (result.kind === 'held') assert.equal(result.retryable, retryable)
    if (result.kind === 'config') assert.equal(result.error, error)
    if (result.kind === 'deferred') assert.equal(result.deferred, error)
    assert.ok(calls.some((argv) => argv.join(' ') === 'git worktree remove --force fake-queue-copy'))
    assert.ok(calls.some((argv) => argv.join(' ') === 'git worktree prune'))
  })
}


test('준비 단계의 사용법 오류를 결과로 받고 작업 폴더는 유지한다', async (t) => {
  const missing = join(tempDir('queue-missing-repo-', t), 'missing')
  const before = process.cwd()
  const state = new StepState(parseArgs(['--repo', missing, '1']))
  const result = await setup({ script, here: '', sleepScale: 0 }, state)
  assert.equal(result.kind, 'error')
  if (result.kind === 'error') assert.match(result.error.message, /로 이동하지 못했다/)
  assert.equal(process.cwd(), before)
  Object.assign(state, result.changes)
  assert.equal(state.repoDir, '')
})

test('머지 뒤 핸들러가 없으면 결과를 합쳐도 머지 기록을 유지한다', async () => {
  const state = new StepState(parseArgs(['--no-sweep', '1']))
  state.merged = [['1', 'code']]
  const result = await afterQueue({ script, here: '', sleepScale: 0 }, state)
  assert.equal(result.kind, 'done')
  Object.assign(state, result.changes)
  assert.deepEqual(state.merged, [['1', 'code']])
  assert.equal(state.afterFailed, false)
})
