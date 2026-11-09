// DECISION16: 대표 CLI와 같은 main/가짜 본문이 출력·종료·argv/stdin을 보존하는지 대조한다.
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { FunctionBox } from './function-box.ts'
import { egoOut, write, type FakeRule } from './helpers.ts'
import { withRuntime, runtimeEnv } from '../driver/runtime.ts'

type Case = { name: string; driver: string; args: string[]; rules: FakeRule[]; code: number }
const cases: Case[] = [
  { name: 'orca 성공과 JSON 출력', driver: 'orca', args: ['js', 'P', '1'], rules: [{ stdout: '{"ok":true,"result":{"result":1}}\n' }], code: 0 },
  { name: 'orca 백엔드 실패', driver: 'orca', args: ['url', 'P'], rules: [{ stdout: '{"ok":false,"error":{"code":"E","message":"실패"}}\n' }], code: 1 },
  { name: 'orca 사용법 오류', driver: 'orca', args: ['nav', 'P'], rules: [], code: 2 },
  { name: 'cmux 성공과 stdout+stderr', driver: 'cmux', args: ['url', '4'], rules: [{ stdout: 'url\n', stderr: '경고\n' }], code: 0 },
  { name: 'cmux 종료 실패', driver: 'cmux', args: ['url', '4'], rules: [{ code: 3, stderr: 'Access denied\n' }], code: 1 },
  { name: 'cmux 미지원 명령', driver: 'cmux', args: ['worktree', '4'], rules: [], code: 2 },
  { name: 'agent 성공과 종료 코드 무시', driver: 'agent-browser', args: ['url', 'S'], rules: [{ stdout: 'url\n', code: 5 }], code: 0 },
  { name: 'agent 줄머리 오류', driver: 'agent-browser', args: ['url', 'S'], rules: [{ stdout: '✗ 실패\n' }], code: 1 },
  { name: 'agent 미지원 명령', driver: 'agent-browser', args: ['spaces'], rules: [], code: 2 },
  { name: 'ego 출력 분리', driver: 'ego', args: ['open', 'about:blank'], rules: [{ stdout: egoOut('9:p2\tDefault\tPersonal\tspace[ego-browser:notice] 새 알림') }], code: 0 },
  { name: 'ego 누락 표식', driver: 'ego', args: ['url', '9:p2'], rules: [{ stdout: '연결 실패\n' }], code: 1 },
  { name: 'ego js timeout 옵션', driver: 'ego', args: ['js', '9:p2', 'const a=1; a+2', '--timeout', '40000'], rules: [{ stdout: egoOut('3') }], code: 0 },
  { name: 'ego 포인터 옵션', driver: 'ego', args: ['click', '9:p2', '12', '34', '--button', 'right'], rules: [{ stdout: egoOut('') }], code: 0 },
  { name: 'ego 잘못된 옵션', driver: 'ego', args: ['js', '9:p2', '1', '--timeout', 'bad'], rules: [], code: 2 },
  { name: 'ego reset 옵션', driver: 'ego', args: ['reset', '--space-id', '7'], rules: [{ stdout: egoOut('{"res":null}') }], code: 0 },
]
for (const row of cases) {
  test(`CLI 대조: ${row.name}`, (t) => {
    const box = new FunctionBox(t)
    box.env.BROWSER_DRIVER = row.driver
    const fake = box.fake(row.driver === 'ego' ? 'ego-browser' : row.driver, row.rules)
    const direct = box.run(row.args)
    const calls = fake.calls()
    rmSync(`${fake.path}.calls.jsonl`, { force: true })
    const cli = box.cli(row.args)
    assert.equal(direct.code, row.code, direct.stderr)
    assert.deepEqual(direct, cli)
    assert.deepEqual(calls, fake.calls())
  })
}

test('CLI 대조: jsfile은 파일을 읽어 timeout과 함께 보낸다', (t) => {
  const box = new FunctionBox(t)
  box.env.BROWSER_DRIVER = 'ego'
  const fake = box.fake('ego-browser', [{ stdout: egoOut('3') }])
  const source = join(box.root, 'probe.js')
  writeFileSync(source, 'const a = 1;\na + 2')
  const args = ['jsfile', '9:p2', source, '--timeout', '40000']
  const direct = box.run(args)
  const calls = fake.calls()
  rmSync(`${fake.path}.calls.jsonl`, { force: true })
  assert.deepEqual(direct, box.cli(args))
  assert.equal(direct.code, 0)
  assert.deepEqual(calls, fake.calls())
})

test('환경과 설정은 호출마다 격리되고 중첩·예외 뒤 복원된다', (t) => {
  const a = new FunctionBox(t)
  const b = new FunctionBox(t)
  a.setConfig({ driver: 'orca' })
  b.setConfig({ driver: 'cmux' })
  const original = process.env
  assert.equal(a.run(['driver']).stdout, 'orca\n')
  assert.equal(b.run(['driver']).stdout, 'cmux\n')
  assert.equal(a.run(['config-path']).stdout, `${a.config}\n`)
  const outer = { env: { BROWSER_DRIVER: 'outer' }, write() {} }
  withRuntime(outer, () => {
    assert.equal(a.run(['driver']).stdout, 'orca\n')
    assert.equal(runtimeEnv().BROWSER_DRIVER, 'outer')
    assert.throws(() => withRuntime({ ...outer, env: {} }, () => { throw new Error('boom') }))
    assert.equal(runtimeEnv().BROWSER_DRIVER, 'outer')
  })
  assert.equal(runtimeEnv(), original)
  assert.equal(process.env, original)
})

test('함수 가짜 본문의 예외는 실제 CLI처럼 실패한다', (t) => {
  const box = new FunctionBox(t)
  box.env.BROWSER_DRIVER = 'orca'
  const fake = box.fake('orca')
  // 하드 링크의 공유 본문을 바꾸지 않고 새 inode로 실패 대역을 만든다.
  rmSync(fake.path)
  writeFileSync(fake.path, `#!${process.execPath}\nthrow new Error('fake boom')\n`, { mode: 0o755 })
  for (const result of [box.run(['url', 'P']), box.cli(['url', 'P'])]) {
    assert.equal(result.code, 1)
    assert.ok(result.stderr.includes('fake boom'))
  }
})

test('처리하지 못한 오류도 main의 실제 오류 처리기를 거친다', (t) => {
  const box = new FunctionBox(t)
  box.setConfig('[1]')
  const direct = box.run(['driver'])
  const cli = box.cli(['driver'])
  assert.equal(direct.code, 1)
  assert.equal(cli.code, 1)
  assert.equal(direct.stderr.split('\n').slice(0, 2).join('\n'), cli.stderr.split('\n').slice(0, 2).join('\n'))
})


for (const args of [['help'], ['driver'], ['nav', 'P']]) {
  test(`CLI 대조: 설정 후보 경고를 ${args.join(' ')}의 출력보다 먼저 낸다`, (t) => {
    const box = new FunctionBox(t)
    box.env.BROWSER_CONFIG = undefined
    box.env.BROWSER_DRIVER = 'orca'
    box.fake('orca')
    for (const name of ['a-x', 'b-y']) {
      write(join(box.claude, 'plugins', 'data', name, 'browser.config.json'), '{}')
    }
    const direct = box.run(args)
    const cli = box.cli(args)
    assert.match(cli.stderr, /^경고: 설치 캐시 밖에서 플러그인 데이터 설정 후보가 여러 개여서 옛 위치 사용:/)
    assert.deepEqual(direct, cli)
  })
}
