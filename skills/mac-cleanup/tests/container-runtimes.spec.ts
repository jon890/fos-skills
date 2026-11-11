// container_runtimes 의 명령 경계 테스트(REQ1, REQ2, REQ4 의 감지). docker, du 는 가짜 실행 파일이고 홈은 임시 폴더다.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { write } from './helpers.ts'
import { PATHS, runtimeBox, type Row, type RuntimeFixture } from './runtimes-helpers.ts'

const DF = 'TYPE TOTAL\nImages 3\n'
const GIB_KB = 1024 * 1024

function survey(fixture: RuntimeFixture) {
  const t = runtimeBox(fixture)
  const out = join(t.box.root, 'runtimes.json')
  const done = t.box.run('container_runtimes', ['--json-out', out], { env: t.env() })
  assert.equal(done.code, 0, done.stderr)
  const rows = (JSON.parse(readFileSync(out, 'utf8')) as { runtimes: Row[] }).runtimes
  return { ...t, done, rows, text: done.stdout }
}

describe('REQ1 런타임별 줄', () => {
  test('Docker Desktop 이 켜져 있으면 이름, 켜짐, context, 디스크 파일과 크기, system df 가 나온다', () => {
    const t = survey({
      dockerDesktop: { kb: 6 * GIB_KB },
      contexts: ({ unix }) => [{ name: 'desktop-linux', endpoint: unix(PATHS.dockerDesktopSocket), responds: true, df: DF }],
    })
    assert.equal(t.text, `## 컨테이너 런타임\ndocker-desktop  Docker Desktop  켜짐\n  context: desktop-linux\n  VM 디스크 파일: ${join(t.home, PATHS.dockerDesktopDisk)}  6.0G\n    TYPE TOTAL\n    Images 3\n`)
  })

  test('--json-out 은 같은 결과를 런타임 필드로 쓴다', () => {
    const { rows } = survey({
      dockerDesktop: { kb: 2048 },
      contexts: ({ unix }) => [{ name: 'desktop-linux', endpoint: unix(PATHS.dockerDesktopSocket), responds: true }],
    })
    assert.equal(rows.length, 1)
    const [row] = rows
    assert.deepEqual([row.id, row.kind, row.state, row.local, row.context, row.disk_bytes, row.reclaim], ['docker-desktop', 'docker-desktop', 'running', true, 'desktop-linux', 2048 * 1024, 'disk-size'])
    assert.deepEqual(row.start_command, ['open', '-a', 'Docker'])
  })

  test('Colima 프로필 둘은 런타임 둘이고 꺼진 프로필만 켜는 명령과 켜서 조사하기 후보가 나온다', () => {
    const t = survey({
      colima: [{ profile: 'default', kb: 50 * GIB_KB }, { profile: 'work', kb: 8 * GIB_KB }],
      contexts: ({ unix }) => [
        { name: 'colima', endpoint: unix(PATHS.colimaSocket('default')), responds: false },
        { name: 'colima-work', endpoint: unix(PATHS.colimaSocket('work')), responds: true, df: DF },
      ],
    })
    assert.deepEqual(t.rows.map((r) => [r.id, r.state, r.context, r.reclaim, r.profile]), [
      ['colima:default', 'stopped', 'colima', 'fstrim', 'default'],
      ['colima:work', 'running', 'colima-work', 'fstrim', 'work'],
    ])
    assert.deepEqual(t.rows[0].start_command, ['colima', 'start', '-p', 'default'])
    assert.deepEqual(t.rows[1].start_command, ['colima', 'start', '-p', 'work'])
    assert.ok(t.text.includes('colima:default  Colima 프로필 default  꺼짐\n'))
    assert.ok(t.text.includes('  켜는 명령: colima start -p default\n  켜서 조사하기: 승인 묶음 후보(VM 디스크 50G)\n'), t.text)
    assert.ok(t.text.includes('colima:work  Colima 프로필 work  켜짐\n'))
    assert.ok(!t.text.includes('colima start -p work'))
    assert.ok(t.text.includes(`VM 디스크 파일: ${join(t.home, PATHS.colimaDisk('default'))}  50G`))
  })

  test('context 가 없어도 디스크 디렉터리만 있는 Colima 프로필은 꺼진 런타임으로 감지한다', () => {
    const t = survey({ colima: [{ profile: 'old', kb: 3 * GIB_KB }] })
    assert.deepEqual(t.rows.map((r) => [r.id, r.state, r.context]), [['colima:old', 'stopped', 'colima-old']])
    assert.ok(t.text.includes('  켜는 명령: colima start -p old\n'))
  })

  test('OrbStack 이 켜져 있으면 orbstack 한 줄과 디스크 크기가 나온다', () => {
    const t = survey({
      orbstack: { kb: 4 * GIB_KB },
      contexts: ({ unix }) => [{ name: 'orbstack', endpoint: unix(PATHS.orbstackSocket), responds: true, df: DF }],
    })
    assert.deepEqual(t.rows.map((r) => [r.id, r.state, r.reclaim]), [['orbstack', 'running', 'disk-size']])
    assert.ok(t.text.includes('orbstack  OrbStack  켜짐\n'))
    assert.ok(t.text.includes('4.0G'))
  })

  test('설치됐지만 꺼진 Docker Desktop 은 context 가 응답하지 않아도 데이터 디렉터리로 감지하고 켜는 명령을 보인다', () => {
    const t = survey({ dockerDesktop: { kb: 9 * GIB_KB } })
    assert.deepEqual(t.rows.map((r) => [r.id, r.state, r.context]), [['docker-desktop', 'stopped', 'desktop-linux']])
    assert.ok(t.text.includes('  켜는 명령: open -a Docker\n  켜서 조사하기: 승인 묶음 후보(VM 디스크 9.0G)\n'), t.text)
  })

  test('설치 흔적이 앱 번들뿐이어도 감지한다', () => {
    const t = runtimeBox()
    write(join(t.appsDir, 'OrbStack.app', 'Contents'))
    const done = t.box.run('container_runtimes', [], { env: t.env() })
    assert.ok(done.stdout.includes('orbstack  OrbStack  꺼짐\n'), done.stdout)
    assert.ok(done.stdout.includes('  VM 디스크 파일: 찾지 못함\n'))
  })

  test('아무 런타임도 없으면 감지한 런타임 없음이고 docker 가 실패해도 0 이다', () => {
    const t = runtimeBox()
    t.box.fake('docker', [{ code: 127 }])
    const done = t.box.run('container_runtimes', [], { env: t.env() })
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '## 컨테이너 런타임\n감지한 런타임 없음\n')
  })

  test('--json-out 을 쓸 수 없으면 1 이다', () => {
    const t = runtimeBox()
    const done = t.box.run('container_runtimes', ['--json-out', join(t.box.root, 'no/such/dir/x.json')], { env: t.env() })
    assert.equal(done.code, 1)
    assert.ok(done.stderr.startsWith('--json-out 파일을 쓸 수 없다: '))
  })
})

describe('REQ2 알 수 없는 런타임과 원격 엔진', () => {
  const PODMAN = '.local/share/containers/podman.sock'

  test('표에 없는 로컬 소켓은 알 수 없는 런타임이고 회수는 사용자 몫이라는 줄이 나온다', () => {
    const t = survey({
      files: [PODMAN],
      contexts: ({ unix }) => [{ name: 'podman', endpoint: unix(PODMAN), responds: true, df: DF }],
    })
    assert.ok(t.text.includes('unknown:podman  알 수 없는 런타임  켜짐\n'), t.text)
    assert.ok(t.text.includes('  디스크 회수는 사용자 몫이다. 이 스킬은 하지 않는다. docker CLI 로 조사와 정리는 한다\n'))
    assert.ok(!t.text.includes('켜는 명령'))
    assert.deepEqual(t.rows.map((r) => [r.id, r.kind, r.local, r.reclaim, r.start_command, r.disk_bytes]), [['unknown:podman', 'unknown', true, 'none', null, null]])
  })

  test('ssh 와 tcp 엔드포인트는 이 맥 밖의 엔진이고 크기만 보이며 켜는 명령이 없다', () => {
    const t = survey({
      contexts: () => [
        { name: 'prod', endpoint: 'ssh://deploy@prod.example.com', responds: true, df: 'TYPE TOTAL\nImages 9\n' },
        { name: 'lab', endpoint: 'tcp://10.0.0.5:2376', responds: false },
      ],
    })
    assert.deepEqual(t.rows.map((r) => [r.id, r.kind, r.local, r.state, r.start_command, r.reclaim]), [
      ['remote:prod', 'remote', false, 'running', null, 'none'],
      ['remote:lab', 'remote', false, 'unresponsive', null, 'none'],
    ])
    assert.ok(t.text.includes('remote:prod  이 맥 밖의 엔진  켜짐\n  context: prod\n  엔드포인트: ssh://deploy@prod.example.com\n'), t.text)
    assert.ok(t.text.includes('  이 맥 밖의 엔진이다. 크기만 보이고 승인 묶음과 삭제 대상에 넣지 않는다\n    TYPE TOTAL\n    Images 9\n'))
    assert.ok(!t.text.includes('켜서 조사하기'))
  })

  test('이름만 colima 로 시작하는 ssh context 는 Colima 프로필이 아니라 맥 밖의 엔진이다', () => {
    const t = survey({ contexts: () => [{ name: 'colima-prod', endpoint: 'ssh://deploy@prod.example.com', responds: true, df: DF }] })
    assert.deepEqual(t.rows.map((r) => [r.id, r.kind]), [['remote:colima-prod', 'remote']])
    assert.ok(!t.text.includes('colima start'))
  })

  test('같은 엔드포인트를 가리키는 원격 context 둘은 런타임 하나로 합친다', () => {
    const t = survey({
      contexts: () => [
        { name: 'prod', endpoint: 'ssh://deploy@prod.example.com', responds: true, df: DF },
        { name: 'prod-alias', endpoint: 'ssh://deploy@prod.example.com', responds: true, df: DF },
      ],
    })
    assert.deepEqual(t.rows.map((r) => [r.id, r.contexts]), [['remote:prod', ['prod', 'prod-alias']]])
    assert.equal(t.docker.calls().filter((c) => c.argv.includes('system')).length, 1)
  })

  test('설치 흔적이 있어도 기대한 context 이름이 ssh 엔진을 가리키면 그 엔진을 Docker Desktop 으로 잇지 않는다', () => {
    const t = survey({
      dockerDesktop: { kb: GIB_KB },
      contexts: () => [{ name: 'desktop-linux', endpoint: 'ssh://prod.example', responds: true, df: DF }],
    })
    assert.deepEqual(t.rows.map((r) => [r.id, r.kind, r.local, r.state, r.context, r.start_command]), [
      ['docker-desktop', 'docker-desktop', true, 'stopped', null, null],
      ['remote:desktop-linux', 'remote', false, 'running', 'desktop-linux', null],
    ])
    assert.equal(t.rows.flatMap((r) => r.contexts).filter((c) => c === 'desktop-linux').length, 1, '같은 context 가 두 런타임에 나오지 않는다')
    assert.ok(t.text.includes('  주의: 기대한 context desktop-linux 가 이 런타임의 소켓이 아닌 ssh://prod.example 를 가리켜 조사하지 않는다\n'), t.text)
    assert.ok(!t.text.includes('켜는 명령'))
  })

  test('기대한 context 이름이 다른 로컬 소켓을 가리키면 그 소켓은 알 수 없는 런타임이고 Docker Desktop 은 context 없이 남는다', () => {
    const t = survey({
      dockerDesktop: { kb: GIB_KB },
      files: ['.other/docker.sock'],
      contexts: ({ unix }) => [{ name: 'desktop-linux', endpoint: unix('.other/docker.sock'), responds: true, df: DF }],
    })
    assert.deepEqual(t.rows.map((r) => [r.id, r.kind, r.context]), [['docker-desktop', 'docker-desktop', null], ['unknown:desktop-linux', 'unknown', 'desktop-linux']])
    assert.equal(t.rows[0].state, 'stopped')
    assert.equal(t.rows[0].start_command, null)
  })

  test('소켓이 없는 default context 는 런타임으로 세지 않는다', () => {
    const t = runtimeBox({ contexts: () => [{ name: 'default', endpoint: 'unix:///nonexistent-dir/docker.sock', responds: false }] })
    const done = t.box.run('container_runtimes', [], { env: t.env() })
    assert.equal(done.stdout, '## 컨테이너 런타임\n감지한 런타임 없음\n')
  })
})

describe('REQ4 같은 소켓의 context 합치기', () => {
  test('default 가 desktop-linux 소켓을 가리키는 링크이면 런타임 하나이고 대표는 desktop-linux 다. system df 도 한 번이다', () => {
    const t = survey({
      dockerDesktop: { kb: 5 * GIB_KB },
      links: [{ from: 'var/run/docker.sock', to: PATHS.dockerDesktopSocket }],
      contexts: ({ unix }) => [
        { name: 'default', endpoint: unix('var/run/docker.sock'), responds: true, df: DF },
        { name: 'desktop-linux', endpoint: unix(PATHS.dockerDesktopSocket), responds: true, df: DF },
      ],
    })
    assert.equal(t.rows.length, 1)
    assert.equal(t.rows[0].context, 'desktop-linux')
    assert.deepEqual(t.rows[0].contexts, ['default', 'desktop-linux'])
    assert.ok(t.text.includes('  context: desktop-linux (같은 소켓으로 합친 context: default)\n'), t.text)
    assert.equal(t.docker.calls().filter((c) => c.argv.includes('system')).length, 1)
  })
})

describe('여러 런타임과 현재 context', () => {
  test('Docker Desktop, OrbStack, Colima 프로필 둘, 알 수 없는 런타임, 원격 엔진이 정해진 순서로 나오고 현재 context 설정은 그대로다', () => {
    const t = runtimeBox({
      dockerDesktop: {},
      orbstack: {},
      colima: [{ profile: 'default' }, { profile: 'work' }],
      files: ['.local/share/containers/podman.sock'],
      contexts: ({ unix }) => [
        { name: 'prod', endpoint: 'ssh://h', responds: true, df: DF },
        { name: 'podman', endpoint: unix('.local/share/containers/podman.sock'), responds: true, df: DF },
        { name: 'orbstack', endpoint: unix(PATHS.orbstackSocket), responds: true, df: DF },
        { name: 'colima-work', endpoint: unix(PATHS.colimaSocket('work')) },
        { name: 'colima', endpoint: unix(PATHS.colimaSocket('default')) },
        { name: 'desktop-linux', endpoint: unix(PATHS.dockerDesktopSocket), responds: true, df: DF },
      ],
    })
    const before = readFileSync(t.dockerConfig, 'utf8')
    const done = t.box.run('container_runtimes', [], { env: t.env() })
    assert.equal(done.code, 0, done.stderr)
    const heads = done.stdout.split('\n').filter((l) => /^\S/.test(l) && !l.startsWith('##')).map((l) => l.split('  ').join('|'))
    assert.deepEqual(heads, ['docker-desktop|Docker Desktop|켜짐', 'orbstack|OrbStack|켜짐', 'colima:default|Colima 프로필 default|꺼짐', 'colima:work|Colima 프로필 work|꺼짐', 'unknown:podman|알 수 없는 런타임|켜짐', 'remote:prod|이 맥 밖의 엔진|켜짐'])
    assert.equal(readFileSync(t.dockerConfig, 'utf8'), before)
    assert.ok(t.docker.calls().every((c) => !(c.argv[0] === 'context' && c.argv[1] === 'use')))
  })
})
