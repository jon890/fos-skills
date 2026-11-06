import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeRun } from '../../../modules/testkit/fake-run.ts'
import { run, runProcess, withRun } from '../scripts/lib/proc.ts'
import { main } from '../scripts/queue/merge_queue.ts'

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

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { runCommand } from '../../../modules/testkit/command.ts'
import { FAKE_GH, FAKE_GIT, HAS_TOOLS, writeNodeBin } from './fixtures/merge-queue-fakes.ts'
import { statefulRun } from './fixtures/merge-queue-run.ts'

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
  ['사용법 오류', {}, ['--unknown'], 2, /모르는 옵션|알 수 없는 옵션/],
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
