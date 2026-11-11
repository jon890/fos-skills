// runtime_reclaim 의 명령 경계 테스트(REQ5). colima 와 du 는 가짜 실행 파일이라 실제 VM 과 디스크를 건드리지 않는다.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Sandbox, write } from './helpers.ts'
import { makeRow, type Row } from './runtimes-helpers.ts'

const GIB = 1024 ** 3
const KB = (gib: number) => gib * 1024 * 1024

function setup(rows: (disk: string) => Row[], opts: { used?: number; duGib?: number } = {}) {
  const box = new Sandbox('mc-', [])
  const disk = write(join(box.root, 'disk.img'))
  const file = write(join(box.root, 'runtimes.json'), JSON.stringify({ runtimes: rows(disk) }))
  const du = box.fake('du', [{ stdout: `${KB(opts.duGib ?? 4)}\t${disk}\n` }])
  const colima = box.fake('colima', [
    { args: ['status'] },
    { args: ['df'], stdout: `       Used\n${opts.used ?? 4 * GIB}\n` },
    { args: ['sh'], stdout: '/mnt/lima-colima: 43.8 GiB (47028871168 bytes) trimmed\n' },
  ])
  const run = (id: string, extra: string[] = []) => box.run('runtime_reclaim', [file, '--runtime', id, ...extra])
  const fstrimCalls = () => colima.calls().filter((c) => c.argv.includes('sh'))
  return { box, run, du, colima, fstrimCalls, disk }
}

describe('REQ5 런타임별 회수', () => {
  test('Colima 만 fstrim 을 부르고 프로필을 colima_trim 에 넘긴다', () => {
    const { run, colima, fstrimCalls } = setup((d) => [makeRow('colima:work', 'colima', 'Colima 프로필 work', { reclaim: 'fstrim', profile: 'work', disk_path: d })], { used: 4 * GIB, duGib: 4 })
    const done = run('colima:work', ['--interval', '0'])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.startsWith('Colima 프로필 work(colima:work): fstrim 으로 회수한다\n'), done.stdout)
    assert.ok(done.stdout.includes('시도 1: trim 43.8GiB\n'))
    assert.deepEqual(fstrimCalls().map((c) => c.argv), [['ssh', '-p', 'work', '--', 'sh', '-c', 'sync && sudo fstrim -v /mnt/lima-colima']])
    assert.deepEqual(colima.calls()[0].argv, ['status', '-p', 'work'])
  })

  test('Colima 의 종료 코드를 그대로 돌려준다: 차이가 남으면 2, 정지면 1', () => {
    const left = setup((d) => [makeRow('colima:default', 'colima', 'Colima 프로필 default', { reclaim: 'fstrim', profile: 'default', disk_path: d })], { used: 24 * GIB, duGib: 40 })
    const gap = left.run('colima:default', ['--interval', '0', '--max-attempts', '1'])
    assert.equal(gap.code, 2)
    assert.ok(gap.stderr.includes('시도 1회 뒤에도 차이 16.0GiB 가 남았다'), gap.stderr)
    const down = setup((d) => [makeRow('colima:default', 'colima', 'Colima 프로필 default', { reclaim: 'fstrim', profile: 'default', disk_path: d })])
    down.colima.setRules([{ args: ['status'], code: 1 }])
    const stopped = down.run('colima:default')
    assert.equal(stopped.code, 1)
    assert.ok(stopped.stderr.includes('Colima 프로필 default 가 떠 있지 않다'))
  })

  test('Docker Desktop 은 fstrim 없이 정리 전후 디스크 파일 크기를 보고한다', () => {
    const { run, colima, fstrimCalls } = setup((d) => [makeRow('docker-desktop', 'docker-desktop', 'Docker Desktop', { reclaim: 'disk-size', disk_path: d, disk_bytes: 10 * GIB })], { duGib: 4 })
    const done = run('docker-desktop')
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, 'Docker Desktop(docker-desktop): trim 명령이 없다. 디스크 파일 점유 크기만 정리 전후로 비교한다\n디스크 파일 10.0GiB -> 4.0GiB, 줄어든 크기 6.0GiB\n')
    assert.deepEqual(fstrimCalls(), [])
    assert.deepEqual(colima.calls(), [])
  })

  test('OrbStack 도 같고, 줄지 않았으면 비동기로 줄인다는 문구를 내며 다시 하지 않고 0 이다', () => {
    const { run, du } = setup((d) => [makeRow('orbstack', 'orbstack', 'OrbStack', { reclaim: 'disk-size', disk_path: d, disk_bytes: 4 * GIB })], { duGib: 4 })
    const done = run('orbstack')
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes('디스크 파일 4.0GiB -> 4.0GiB, 줄어든 크기 0.0GiB\n'))
    assert.ok(done.stdout.includes('디스크 파일이 줄지 않았다. OrbStack 는 지운 만큼 디스크 파일을 스스로 비동기로 줄이므로 시간이 지나야 줄 수 있다. 다시 하지 않는다\n'))
    assert.equal(du.calls().length, 1)
  })

  test('정리 전 크기를 모르면 지금 크기만 보고하고, 디스크 파일이 없으면 1 이다', () => {
    const unknownBefore = setup((d) => [makeRow('orbstack', 'orbstack', 'OrbStack', { reclaim: 'disk-size', disk_path: d, disk_bytes: null })], { duGib: 3 })
    const a = unknownBefore.run('orbstack')
    assert.equal(a.code, 0)
    assert.ok(a.stdout.includes('정리 전 크기를 몰라 지금 3.0GiB 만 보고한다\n'), a.stdout)
    const noDisk = setup(() => [makeRow('orbstack', 'orbstack', 'OrbStack', { reclaim: 'disk-size', disk_path: null })])
    const b = noDisk.run('orbstack')
    assert.equal(b.code, 1)
    assert.ok(b.stderr.includes('VM 디스크 파일을 찾지 못해 크기를 재지 못했다'))
  })

  test('알 수 없는 런타임은 회수하지 않았다고 보고하고 아무것도 부르지 않는다', () => {
    const { run, du, colima } = setup(() => [makeRow('unknown:podman', 'unknown', '알 수 없는 런타임')])
    const done = run('unknown:podman')
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '알 수 없는 런타임(unknown:podman): 디스크를 회수하지 않았다. 이 런타임의 VM 디스크 회수는 사용자 몫이다\n')
    assert.deepEqual([du.calls(), colima.calls()], [[], []])
  })

  test('이 맥 밖의 엔진과 없는 id 는 2 다', () => {
    const { run } = setup(() => [makeRow('remote:prod', 'remote', '이 맥 밖의 엔진', { local: false })])
    const remote = run('remote:prod')
    assert.equal(remote.code, 2)
    assert.ok(remote.stderr.includes('이 맥 밖의 엔진이라 회수 대상이 아니다'))
    const missing = run('nope')
    assert.equal(missing.code, 2)
    assert.ok(missing.stderr.includes('런타임 nope 가 조사 파일에 없다'))
  })
})
