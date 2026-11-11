// survey_docker 와 docker_images, docker_volumes 의 --context 옵션 테스트(REQ4). docker 는 가짜 실행 파일이다.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { FakeRule } from '../../../modules/testkit/fake-bin.ts'
import { Sandbox, write } from './helpers.ts'
import { makeRow, type Row } from './runtimes-helpers.ts'

const ROWS: Row[] = [
  makeRow('docker-desktop', 'docker-desktop', 'Docker Desktop', { context: 'desktop-linux', contexts: ['default', 'desktop-linux'], reclaim: 'disk-size' }),
  makeRow('orbstack', 'orbstack', 'OrbStack', { context: 'orbstack', reclaim: 'disk-size' }),
  makeRow('colima:default', 'colima', 'Colima 프로필 default', { state: 'stopped', context: 'colima', reclaim: 'fstrim', profile: 'default' }),
  makeRow('remote:prod', 'remote', '이 맥 밖의 엔진', { local: false, context: 'prod' }),
]

function setup(rules: FakeRule[] = []) {
  const box = new Sandbox()
  const docker = box.fake('docker', rules)
  const file = write(join(box.root, 'runtimes.json'), JSON.stringify({ runtimes: ROWS }))
  const outDir = join(box.root, 'out')
  const run = (extra: string[] = []) => box.run('survey_docker', [file, '--out-dir', outDir, ...extra])
  const contexts = () => docker.calls().map((c) => (c.argv[0] === '--context' ? c.argv[1] : null))
  return { box, docker, outDir, run, contexts }
}

describe('REQ4 런타임별 조사', () => {
  test('켜진 로컬 런타임마다 절을 나누고 모든 docker 호출에 그 context 를 붙인다. 같은 소켓의 default 는 부르지 않는다', () => {
    const { run, contexts, docker } = setup()
    const done = run()
    assert.equal(done.code, 0, done.stderr)
    const heads = done.stdout.split('\n').filter((l) => l.startsWith('## 런타임'))
    assert.deepEqual(heads, ['## 런타임 docker-desktop (Docker Desktop, context=desktop-linux)', '## 런타임 orbstack (OrbStack, context=orbstack)'])
    assert.ok(done.stdout.indexOf('context=desktop-linux') < done.stdout.indexOf('context=orbstack'))
    const used = new Set(contexts())
    assert.deepEqual([...used].sort(), ['desktop-linux', 'orbstack'])
    assert.ok(docker.calls().every((c) => c.argv[0] === '--context'), '모든 호출이 --context 로 시작한다')
    assert.equal(done.stdout.split('## context: desktop-linux\n').length - 1, 2, '이미지와 volume 출력이 각각 context 줄을 낸다')
  })

  test('런타임마다 volume 조사 파일을 따로 쓰고 context 를 남긴다', () => {
    const { run, outDir } = setup()
    const done = run()
    for (const [id, context] of [['docker-desktop', 'desktop-linux'], ['orbstack', 'orbstack']]) {
      const file = join(outDir, `volumes-${id}.json`)
      assert.ok(done.stdout.includes(`volume 조사 파일: ${file}\n`), done.stdout)
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).context, context)
    }
    assert.ok(!existsSync(join(outDir, 'volumes-colima_default.json')))
  })

  test('--runtime 은 꺼짐으로 적힌 런타임도 그 하나만 조사한다. 파일 이름의 :은 _ 다', () => {
    const { run, outDir, contexts } = setup()
    const done = run(['--runtime', 'colima:default'])
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual([...new Set(contexts())], ['colima'])
    assert.equal(JSON.parse(readFileSync(join(outDir, 'volumes-colima_default.json'), 'utf8')).context, 'colima')
  })

  test('이 맥 밖의 엔진과 없는 id 는 2 이고 docker 를 부르지 않는다', () => {
    const { run, docker } = setup()
    assert.equal(run(['--runtime', 'remote:prod']).code, 2)
    assert.equal(run(['--runtime', 'nope']).code, 2)
    assert.deepEqual(docker.calls(), [])
  })

  test('한 런타임의 조사가 실패해도 나머지를 계속하고 1 로 끝난다', () => {
    const { run, outDir } = setup([{ args: ['--context', 'orbstack', 'volume', 'ls'], stderr: 'boom', code: 1 }])
    const done = run()
    assert.equal(done.code, 1)
    assert.ok(done.stdout.includes('orbstack: 조사에 실패했다. 이 런타임의 이미지와 volume 은 정리 후보에 넣지 않는다\n'), done.stdout)
    assert.ok(done.stderr.includes('boom'))
    assert.ok(existsSync(join(outDir, 'volumes-docker-desktop.json')))
  })

  test('알 수 없는 로컬 런타임도 docker CLI 로 이미지와 volume 을 조사하고 volume 조사 파일을 쓴다', () => {
    const box = new Sandbox()
    const docker = box.fake('docker', [])
    const file = write(join(box.root, 'r.json'), JSON.stringify({ runtimes: [makeRow('unknown:podman', 'unknown', '알 수 없는 런타임', { context: 'podman' })] }))
    const outDir = join(box.root, 'o')
    const done = box.run('survey_docker', [file, '--out-dir', outDir])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.includes('## 런타임 unknown:podman (알 수 없는 런타임, context=podman)\n'), done.stdout)
    const verbs = docker.calls().map((c) => c.argv.slice(2).join(' '))
    assert.ok(verbs.some((v) => v.startsWith('images ')) && verbs.some((v) => v.startsWith('volume ls ')), verbs.join('\n'))
    assert.equal(JSON.parse(readFileSync(join(outDir, 'volumes-unknown_podman.json'), 'utf8')).context, 'podman')
  })

  test('켜진 런타임이 없으면 그렇게 보이고 0 이다', () => {
    const box = new Sandbox()
    const file = write(join(box.root, 'r.json'), JSON.stringify({ runtimes: [ROWS[2]] }))
    const done = box.run('survey_docker', [file, '--out-dir', join(box.root, 'o')])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.startsWith('조사할 켜진 런타임이 없다\n'))
  })
})

describe('--context 옵션', () => {
  test('docker_images 와 docker_volumes 는 context 를 주면 모든 호출에 붙이고 주지 않으면 붙이지 않는다', () => {
    const box = new Sandbox()
    const docker = box.fake('docker', [])
    const withCtx = box.run('docker_images', ['--context', 'orbstack'])
    assert.equal(withCtx.code, 0, withCtx.stderr)
    assert.ok(withCtx.stdout.startsWith('## context: orbstack\n'))
    const vols = box.run('docker_volumes', ['--context', 'orbstack'])
    assert.equal(vols.code, 0, vols.stderr)
    assert.ok(vols.stdout.startsWith('## context: orbstack\n'))
    assert.ok(docker.calls().length > 0 && docker.calls().every((c) => c.argv[0] === '--context' && c.argv[1] === 'orbstack'))

    const before = docker.calls().length
    const plain = box.run('docker_images')
    assert.equal(plain.stdout, '')
    assert.ok(docker.calls().slice(before).every((c) => c.argv[0] !== '--context'))
  })

  test('docker_volumes --json 은 context 를 줬을 때만 context 필드를 낸다', () => {
    const box = new Sandbox()
    box.fake('docker', [])
    assert.equal(JSON.parse(box.run('docker_volumes', ['--json']).stdout).context, undefined)
    assert.equal(JSON.parse(box.run('docker_volumes', ['--json', '--context', 'colima']).stdout).context, 'colima')
  })
})
