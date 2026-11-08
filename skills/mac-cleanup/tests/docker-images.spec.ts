// docker_images 의 명령 경계 테스트. docker 는 가짜 실행 파일이다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { FakeRule } from '../../../modules/testkit/fake-bin.ts'
import { Sandbox } from './helpers.ts'

const sha = (c: string) => `sha256:${c.repeat(64)}`
const HOUR = 3600 * 1000

type Img = { repo: string; tag: string; id: string; size?: string; since?: string; created: Date | string; inspectable?: boolean }
type Ctr = { image: string; id: string }

// docker 가짜의 규칙. 호출 순서와 무관하게 인자로 고른다
function rules(images: Img[], containers: Ctr[], opts: { resolves?: Record<string, boolean>; inspectContainers?: string } = {}): FakeRule[] {
  const out: FakeRule[] = [
    { args: ['ps', '-a', '--no-trunc', '--format'], stdout: containers.map((c) => JSON.stringify({ Image: c.image })).join('\n') + (containers.length ? '\n' : '') },
    { args: ['images', '--no-trunc', '--format'], stdout: images.map((i) => JSON.stringify({ Repository: i.repo, Tag: i.tag, ID: i.id, Size: i.size ?? '10MB', CreatedSince: i.since ?? '2 weeks ago' })).join('\n') + (images.length ? '\n' : '') },
    { args: ['ps', '-aq', '--no-trunc'], stdout: containers.map((c) => c.id).join('\n') + (containers.length ? '\n' : '') },
  ]
  if (containers.length) out.push({ args: ['inspect', ...containers.map((c) => c.id)], stdout: opts.inspectContainers ?? JSON.stringify(containers.map((c) => ({ Image: c.id }))) })
  for (const i of images) {
    const created = typeof i.created === 'string' ? i.created : `${i.created.toISOString().slice(0, 19)}.123456789Z`
    out.push({ args: ['inspect', i.id], stdout: JSON.stringify([{ Id: i.id, Created: created }]) })
  }
  for (const [ref, ok] of Object.entries(opts.resolves ?? {})) out.push({ args: ['image', 'inspect', ref], code: ok ? 0 : 1, stderr: ok ? '' : `Error: No such image: ${ref}` })
  out.push({ args: ['image', 'inspect'] })
  return out
}

function setup(images: Img[], containers: Ctr[] = [], opts: Parameters<typeof rules>[2] = {}) {
  const box = new Sandbox()
  const docker = box.fake('docker', rules(images, containers, opts))
  return { box, docker, run: (args: string[] = []) => box.run('docker_images', args) }
}

const cls = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - [...text].length))

describe('분류와 출력', () => {
  test('사용 중, 최근 생성, 미사용으로 나눠 줄을 낸다', () => {
    const now = Date.now()
    const images: Img[] = [
      { repo: 'alpine', tag: 'latest', id: sha('a'), size: '8MB', since: '2 weeks ago', created: new Date(now - 14 * 24 * HOUR) },
      { repo: 'mine', tag: 'dev', id: sha('b'), size: '1.2GB', since: '3 hours ago', created: new Date(now - 3 * HOUR) },
      { repo: 'old', tag: '1.0', id: sha('c'), size: '300MB', since: '3 months ago', created: new Date(now - 90 * 24 * HOUR) },
    ]
    const { run } = setup(images, [{ image: 'alpine', id: 'c1' }])
    const done = run()
    assert.equal(done.code, 0, done.stderr)
    assert.equal(
      done.stdout,
      `${cls('사용 중', 22)} ${'8MB'.padStart(9)}  alpine:latest  (2 weeks ago)  rmi=alpine:latest id=${'a'.repeat(12)}\n` +
        `${cls('확인 필요(최근 생성)', 22)} ${'1.2GB'.padStart(9)}  mine:dev  (3 hours ago)  rmi=mine:dev id=${'b'.repeat(12)}\n` +
        `${cls('미사용', 22)} ${'300MB'.padStart(9)}  old:1.0  (3 months ago)  rmi=old:1.0 id=${'c'.repeat(12)}\n`,
    )
  })

  test('컨테이너가 쓰는 이미지 ID 가 같아도 사용 중이다', () => {
    const now = Date.now()
    const id = sha('d')
    const { run } = setup([{ repo: 'other', tag: '1', id, created: new Date(now - 90 * 24 * HOUR) }], [{ image: 'unrelated:1', id: 'c9' }], { inspectContainers: JSON.stringify([{ Image: id }]) })
    assert.ok(run().stdout.startsWith('사용 중 '))
  })

  test('컨테이너 이미지 이름은 태그 생략을 :latest 로 맞춰 비교한다', () => {
    const now = Date.now()
    const images: Img[] = [
      { repo: 'alpine', tag: 'latest', id: sha('a'), created: new Date(now - 90 * 24 * HOUR) },
      { repo: 'localhost:5000/app', tag: 'latest', id: sha('b'), created: new Date(now - 90 * 24 * HOUR) },
      { repo: 'a/b', tag: '1', id: sha('c'), created: new Date(now - 90 * 24 * HOUR) },
    ]
    const { run } = setup(images, [{ image: 'alpine', id: 'x1' }, { image: 'localhost:5000/app', id: 'x2' }, { image: 'a/b@sha256:ff', id: 'x3' }])
    const got = run().stdout.split('\n').filter(Boolean).map((l) => l.split(/\s{2,}|\s(?=\S+:)/)[0].trim().split(' ')[0])
    assert.deepEqual(got, ['사용', '사용', '미사용'])
  })

  test('--recent-hours 는 최근 기준을 바꾼다', () => {
    const now = Date.now()
    const images: Img[] = [{ repo: 'mine', tag: 'dev', id: sha('b'), created: new Date(now - 3 * HOUR) }]
    const { run } = setup(images)
    assert.ok(run().stdout.startsWith('확인 필요(최근 생성)'))
    assert.ok(run(['--recent-hours', '2']).stdout.startsWith('미사용'))
    assert.ok(run(['--recent=0.5']).stdout.startsWith('미사용'))
    assert.ok(run(['--recent-hours', '1e1']).stdout.startsWith('확인 필요'))
  })

  test('생성 시각은 소수 초와 시간대 표기를 잘라 지역 시각으로 읽는다', () => {
    // 가짜 sandbox 의 TZ 는 UTC 다. 1시간 전 시각을 초까지 잘라 쓴다
    const created = new Date(Date.now() - HOUR).toISOString().slice(0, 19)
    const { run } = setup([{ repo: 'a', tag: '1', id: sha('a'), created: `${created}+09:00` }])
    assert.ok(run().stdout.startsWith('확인 필요(최근 생성)'))
    const empty = setup([{ repo: 'a', tag: '1', id: sha('a'), created: '' }])
    assert.ok(empty.run().stdout.startsWith('미사용'))
  })

  test('이미지가 없으면 아무것도 내지 않고 0 이다', () => {
    const { run } = setup([])
    const done = run()
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '')
  })
})

describe('rmi 대상', () => {
  const old = () => new Date(Date.now() - 90 * 24 * HOUR)

  test('태그가 있으면 repo:tag, <none> 이면 이미지 ID 12자리다', () => {
    const images: Img[] = [
      { repo: 'gersang-lab', tag: 'latest', id: sha('a'), created: old() },
      { repo: 'traefik', tag: '<none>', id: sha('b'), created: old() },
      { repo: '<none>', tag: '<none>', id: sha('c'), created: old() },
    ]
    const { run } = setup(images)
    const rows = run().stdout.split('\n').filter(Boolean)
    assert.ok(rows[0].includes(`  gersang-lab:latest  (`) && rows[0].includes(' rmi=gersang-lab:latest id='))
    assert.ok(rows[1].includes('  traefik:<none>  (') && rows[1].includes(` rmi=${'b'.repeat(12)} id=${'b'.repeat(12)}`))
    assert.ok(rows[2].includes('  <none>  (') && rows[2].includes(` rmi=${'c'.repeat(12)} id=`))
  })

  test('repo:tag 로 조회되지 않으면(repo:tag@digest 로 저장) 이미지 ID 를 쓴다', () => {
    const ref = 'ghcr.io/actions/actions-runner:2.338.0'
    const { run, docker } = setup([{ repo: 'ghcr.io/actions/actions-runner', tag: '2.338.0', id: sha('e'), created: old() }], [], { resolves: { [ref]: false } })
    const done = run()
    assert.ok(done.stdout.includes(` rmi=${'e'.repeat(12)} id=`))
    assert.ok(docker.calls().some((c) => c.argv.join(' ') === `image inspect ${ref}`))
  })

  test('조회가 성공하면 repo:tag 를 유지한다', () => {
    const { run } = setup([{ repo: 'gersang-lab', tag: 'latest', id: sha('a'), created: old() }], [], { resolves: { 'gersang-lab:latest': true } })
    assert.ok(run().stdout.includes(' rmi=gersang-lab:latest id='))
  })

  test('<none> 이미지는 docker image inspect 를 부르지 않는다', () => {
    const { run, docker } = setup([{ repo: '<none>', tag: '<none>', id: sha('c'), created: old() }])
    run()
    assert.ok(!docker.calls().some((c) => c.argv[0] === 'image'))
  })

  test('이미지 ID 가 sha256: 접두 없이 와도 12자리로 줄인다', () => {
    const { run } = setup([{ repo: '<none>', tag: '<none>', id: 'd'.repeat(64), created: old() }])
    assert.ok(run().stdout.includes(` rmi=${'d'.repeat(12)} id=${'d'.repeat(12)}`))
  })
})

describe('docker 상태와 옵션', () => {
  test('docker 를 쓸 수 없으면 1 이고 stdout 은 비어 있다', () => {
    const box = new Sandbox()
    box.fake('docker', [{ stderr: 'Cannot connect to the Docker daemon', code: 1 }])
    const done = box.run('docker_images')
    assert.equal(done.code, 1)
    assert.equal(done.stdout, '')
    assert.equal(done.stderr, 'docker 를 쓸 수 없다: Cannot connect to the Docker daemon\n')
  })

  test('docker 가 PATH 에 없어도 1 이다', () => {
    const box = new Sandbox()
    const done = box.run('docker_images')
    assert.equal(done.code, 1)
    assert.ok(done.stderr.startsWith('docker 를 쓸 수 없다: '))
  })

  test('JSON 이 아닌 docker 출력도 1 이다', () => {
    const box = new Sandbox()
    box.fake('docker', [{ stdout: 'not json\n' }])
    assert.equal(box.run('docker_images').code, 1)
  })

  test('컨테이너가 없으면 docker inspect 를 컨테이너 ID 로 부르지 않는다', () => {
    const { run, docker } = setup([{ repo: 'a', tag: '1', id: sha('a'), created: new Date(0) }])
    run()
    assert.deepEqual(docker.calls().map((c) => c.argv.slice(0, 2).join(' ')), ['ps -a', 'images --no-trunc', 'ps -aq', 'inspect sha256:' + 'a'.repeat(64), 'image inspect'])
  })

  test('모르는 옵션과 실수가 아닌 값은 사용법 오류 2 다', () => {
    const { run } = setup([])
    assert.equal(run(['--nope']).code, 2)
    assert.equal(run(['--recent-hours', 'x']).code, 2)
    assert.equal(run(['--recent-hours']).code, 2)
    assert.equal(run(['extra']).code, 2)
    const help = run(['-h'])
    assert.equal(help.code, 0)
    assert.ok(help.stdout.startsWith('usage: '))
  })
})
