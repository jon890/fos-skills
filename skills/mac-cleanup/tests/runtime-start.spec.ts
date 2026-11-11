// runtime_start 의 명령 경계 테스트(REQ3). open, colima, orb, docker 는 가짜 실행 파일이라 실제 런타임을 켜지 않는다.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Sandbox, write } from './helpers.ts'
import { START_TIMEOUT_SEC } from '../scripts/runtime_start.ts'
import { makeRow, type Row } from './runtimes-helpers.ts'

// 켜는 명령의 가짜. 호출을 LOG 에 남기고 MARKER 를 만든다. docker 의 info 는 MARKER 가 있어야 성공한다
const STARTER = `const fs = require('node:fs')
fs.appendFileSync(process.env.LOG, JSON.stringify([require('node:path').basename(process.argv[1]), ...process.argv.slice(2)]) + '\\n')
if (process.env.START_FAIL) { process.stderr.write('start failed\\n'); process.exit(1) }
fs.writeFileSync(process.env.MARKER, '1')
`
const DOCKER = `const fs = require('node:fs')
const argv = process.argv.slice(2)
fs.appendFileSync(process.env.LOG, JSON.stringify(['docker', ...argv]) + '\\n')
if (argv.includes('info')) process.exit(fs.existsSync(process.env.MARKER) || process.env.ALREADY ? 0 : 1)
`

const ROWS: Row[] = [
  makeRow('docker-desktop', 'docker-desktop', 'Docker Desktop', { state: 'stopped', context: 'desktop-linux', start_command: ['open', '-a', 'Docker'], reclaim: 'disk-size' }),
  makeRow('orbstack', 'orbstack', 'OrbStack', { state: 'stopped', context: 'orbstack', start_command: ['orb', 'start'], reclaim: 'disk-size' }),
  makeRow('colima:work', 'colima', 'Colima 프로필 work', { state: 'stopped', context: 'colima-work', start_command: ['colima', 'start', '-p', 'work'], profile: 'work', reclaim: 'fstrim' }),
  makeRow('unknown:podman', 'unknown', '알 수 없는 런타임', { context: 'podman' }),
]

function setup(env: Record<string, string | undefined> = {}) {
  const box = new Sandbox('mc-', [])
  const log = join(box.root, 'calls.log')
  const marker = join(box.root, 'started')
  const file = write(join(box.root, 'runtimes.json'), JSON.stringify({ runtimes: ROWS }))
  for (const name of ['open', 'orb', 'colima']) box.script(name, STARTER)
  box.script('docker', DOCKER)
  const full = box.env({ LOG: log, MARKER: marker, ...env })
  const run = (id: string, extra: string[] = []) => box.run('runtime_start', [file, '--runtime', id, '--interval', '0.1', ...extra], { env: full })
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : [])
  return { box, run, calls, file }
}

describe('REQ3 켜기', () => {
  test('기다리는 기본 최대 시간은 120초다', () => {
    assert.equal(START_TIMEOUT_SEC, 120)
  })

  test('Docker Desktop 은 open -a Docker 로 켜고 docker info 가 성공하면 0 이다', () => {
    const { run, calls } = setup()
    const done = run('docker-desktop')
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.includes('켜는 중: Docker Desktop(docker-desktop)  open -a Docker\n'), done.stdout)
    assert.ok(/켜짐: Docker Desktop\(docker-desktop\) \d+초 뒤 docker info 성공\n/.test(done.stdout), done.stdout)
    assert.deepEqual(calls().filter((c) => c[0] === 'open'), [['open', '-a', 'Docker']])
    assert.ok(calls().some((c) => c[0] === 'docker' && c.join(' ') === 'docker --context desktop-linux info'))
  })

  test('OrbStack 은 orb start, Colima 프로필은 colima start -p <프로필> 이다', () => {
    const orb = setup()
    assert.equal(orb.run('orbstack').code, 0)
    assert.deepEqual(orb.calls().filter((c) => c[0] === 'orb'), [['orb', 'start']])
    const colima = setup()
    assert.equal(colima.run('colima:work').code, 0)
    assert.deepEqual(colima.calls().filter((c) => c[0] === 'colima'), [['colima', 'start', '-p', 'work']])
    assert.ok(colima.calls().some((c) => c.join(' ') === 'docker --context colima-work info'))
  })

  test('이미 켜져 있으면 켜는 명령을 부르지 않고 0 이다', () => {
    const { run, calls } = setup({ ALREADY: '1' })
    const done = run('docker-desktop')
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '이미 켜져 있다: Docker Desktop(docker-desktop)\n')
    assert.deepEqual(calls().filter((c) => c[0] === 'open'), [])
  })

  test('준비되지 않으면 제한 시간 뒤 켜지 못함과 0 이 아닌 종료 코드가 나온다', () => {
    const { box, run, calls } = setup()
    box.script('docker', `process.exit(process.argv.includes('info') ? 1 : 0)`)
    const done = run('docker-desktop', ['--timeout', '1'])
    assert.equal(done.code, 1)
    assert.ok(done.stderr.includes('켜지 못함: Docker Desktop(docker-desktop) 1초 안에 docker info 가 성공하지 않았다. 이 런타임만 건너뛰고 나머지를 계속한다\n'), done.stderr)
    assert.equal(calls().filter((c) => c[0] === 'open').length, 1)
  })

  test('켜는 명령이 실패하면 기다리지 않고 켜지 못함 1 이다', () => {
    const { run } = setup({ START_FAIL: '1' })
    const done = run('orbstack', ['--timeout', '30'])
    assert.equal(done.code, 1)
    assert.ok(done.stderr.includes('켜지 못함: OrbStack(orbstack) 켜는 명령이 실패했다: start failed\n'), done.stderr)
  })

  test('켜는 명령이 없는 런타임과 없는 id 는 2 다', () => {
    const { run, calls } = setup()
    const unknown = run('unknown:podman')
    assert.equal(unknown.code, 2)
    assert.ok(unknown.stderr.includes('이 스킬이 켜지 않는다'))
    const missing = run('nope')
    assert.equal(missing.code, 2)
    assert.ok(missing.stderr.includes('런타임 nope 가 조사 파일에 없다'))
    assert.deepEqual(calls(), [])
  })

  test('조사 파일 형식이 아니면 2 다', () => {
    const { box } = setup()
    const bad = write(join(box.root, 'bad.json'), '{}')
    const done = box.run('runtime_start', [bad, '--runtime', 'orbstack'], { env: box.env() })
    assert.equal(done.code, 2)
    assert.ok(done.stderr.startsWith('입력을 읽을 수 없다: '))
  })
})
