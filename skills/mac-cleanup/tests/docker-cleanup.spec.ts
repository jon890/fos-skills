// docker_cleanup 의 명령 경계 테스트(REQ2, REQ4). docker 는 가짜 실행 파일이라 실제 이미지와 빌드 캐시를 지우지 않는다.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { FakeRule } from '../../../modules/testkit/fake-bin.ts'
import { Sandbox, write } from './helpers.ts'
import { makeRow, type Row } from './runtimes-helpers.ts'

const LOCAL = 'unix:///Users/x/.docker/run/docker.sock'

const ROWS: Row[] = [
  makeRow('docker-desktop', 'docker-desktop', 'Docker Desktop', { context: 'desktop-linux' }),
  makeRow('orbstack', 'orbstack', 'OrbStack', { context: 'orbstack' }),
  makeRow('remote:prod', 'remote', '이 맥 밖의 엔진', { local: false, context: 'prod' }),
  makeRow('docker-desktop-x', 'docker-desktop', 'Docker Desktop', { context: null }),
]

function setup(endpoints: Record<string, string> = { 'desktop-linux': LOCAL, orbstack: LOCAL, prod: 'ssh://deploy@prod.example.com' }, extra: FakeRule[] = []) {
  const box = new Sandbox()
  const rules: FakeRule[] = [...extra, ...Object.entries(endpoints).map(([name, host]) => ({ args: ['context', 'inspect', name], stdout: `${host}\n` })), { args: ['builder', 'prune'], stdout: 'Total: 1GB\n' }, { args: ['rmi'] }]
  const docker = box.fake('docker', rules)
  const file = write(join(box.root, 'r.json'), JSON.stringify({ runtimes: ROWS }))
  // 옵션은 위치 인자 앞에 둔다. rest 의 `--apply` 는 앞으로 옮긴다
  const run = (id: string, rest: string[]) => box.run('docker_cleanup', ['--runtime', id, ...rest.filter((a) => a === '--apply'), file, ...rest.filter((a) => a !== '--apply')])
  const sent = () => docker.calls().map((c) => c.argv).filter((a) => a[0] === '--context')
  return { box, docker, file, run, sent }
}

describe('이미지와 빌드 캐시 삭제', () => {
  test('dry-run 은 보낼 명령만 보이고 docker 삭제 명령을 부르지 않는다', () => {
    const { run, sent } = setup()
    const done = run('docker-desktop', ['rmi', 'alpine:3', 'abc123def456'])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, '## dry-run (변경 없음, 실제 삭제는 --apply)\n런타임: Docker Desktop(docker-desktop), context: desktop-linux\n[삭제 예정] docker --context desktop-linux rmi alpine:3\n[삭제 예정] docker --context desktop-linux rmi abc123def456\n')
    assert.deepEqual(sent(), [])
  })

  test('--apply 는 REF 마다 따로, 승인한 런타임의 context 로만 rmi 를 보낸다', () => {
    const { run, sent } = setup()
    const done = run('orbstack', ['--apply', 'rmi', 'alpine:3', 'abc123def456'])
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(sent(), [['--context', 'orbstack', 'rmi', 'alpine:3'], ['--context', 'orbstack', 'rmi', 'abc123def456']])
    assert.ok(done.stdout.startsWith('## 실행\n'))
  })

  test('builder-prune 은 -af 로 그 context 에 한 번 보낸다', () => {
    const { run, sent } = setup()
    const done = run('docker-desktop', ['--apply', 'builder-prune'])
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(sent(), [['--context', 'desktop-linux', 'builder', 'prune', '-af']])
    assert.ok(done.stdout.includes('[삭제] docker --context desktop-linux builder prune -af\nTotal: 1GB\n'))
  })

  test('명령이 실패하면 그 줄을 실패로 보이고 나머지를 계속하며 종료 코드 1 이다', () => {
    const { run, sent } = setup(undefined, [{ args: ['rmi', 'bad:1'], stderr: 'Error: No such image: bad:1', code: 1 }])
    const done = run('docker-desktop', ['--apply', 'rmi', 'bad:1', 'good:1'])
    assert.equal(done.code, 1)
    assert.ok(done.stdout.includes('[실패] docker --context desktop-linux rmi bad:1  Error: No such image: bad:1\n'), done.stdout)
    assert.equal(sent().length, 2)
  })
})

describe('이 맥 밖의 엔진은 거부한다', () => {
  test('조사 파일에서 원격인 런타임은 dry-run 도 --apply 도 5 이고 docker 를 부르지 않는다', () => {
    const { run, docker } = setup()
    for (const rest of [['rmi', 'a:1'], ['--apply', 'rmi', 'a:1'], ['--apply', 'builder-prune']]) {
      const done = run('remote:prod', rest)
      assert.equal(done.code, 5, done.stderr)
      assert.ok(done.stderr.includes('이 맥 밖의 엔진이다'))
    }
    assert.deepEqual(docker.calls(), [])
  })

  test('조사 뒤 context 가 ssh 나 tcp 엔진을 가리키게 바뀌었으면 5 이고 삭제 명령을 보내지 않는다', () => {
    for (const host of ['ssh://deploy@prod.example.com', 'tcp://10.0.0.5:2376', '']) {
      const { run, docker } = setup({ 'desktop-linux': host })
      const done = run('docker-desktop', ['--apply', 'rmi', 'a:1'])
      assert.equal(done.code, 5, `${host}: ${done.stderr}`)
      assert.ok(done.stderr.includes('이 맥의 unix 소켓이 아니다'))
      assert.ok(docker.calls().every((c) => c.argv[0] === 'context'), '엔드포인트를 읽는 호출 말고는 부르지 않는다')
    }
  })

  test('엔드포인트를 읽지 못하면 4 로 닫는다', () => {
    const { docker, run } = setup()
    docker.setRules([{ args: ['context', 'inspect'], stderr: 'context not found', code: 1 }, { args: ['rmi'] }])
    const done = run('docker-desktop', ['--apply', 'rmi', 'a:1'])
    assert.equal(done.code, 4)
    assert.ok(done.stderr.startsWith('docker 를 쓸 수 없다: context not found'))
    assert.ok(docker.calls().every((c) => c.argv[0] === 'context'))
  })
})

describe('입력 오류는 docker 를 부르기 전에 2 다', () => {
  test('없는 런타임, context 없는 런타임, 모르는 동작, REF 개수, -로 시작하는 REF', () => {
    const { run, docker } = setup()
    const cases: [string, string[], string][] = [
      ['nope', ['builder-prune'], '런타임 nope 가 조사 파일에 없다'],
      ['docker-desktop-x', ['builder-prune'], 'context 가 없어 대상 엔진을 정할 수 없다'],
      ['orbstack', ['prune'], '동작은 builder-prune, rmi 중 하나다'],
      ['orbstack', ['rmi'], 'rmi 는 REF 가 하나 이상 필요하다'],
      ['orbstack', ['builder-prune', 'a:1'], 'builder-prune 은 REF 를 받지 않는다'],
      ['orbstack', ['rmi', '--', '-f', 'a:1'], 'REF 가 -로 시작한다(-f)'],
    ]
    for (const [id, rest, message] of cases) {
      const done = run(id, rest)
      assert.equal(done.code, 2, `${id} ${rest.join(' ')}: ${done.stderr}`)
      assert.ok(done.stderr.includes(message), done.stderr)
    }
    assert.deepEqual(docker.calls(), [])
  })
})

describe('이미지 조사 파일로 rmi', () => {
  const IMAGES = [
    { class: '사용 중', size: '8MB', size_bytes: 8_000_000, ref: 'alpine:latest', rmi: 'alpine:latest', id: 'a'.repeat(12), created: '', created_since: '' },
    { class: '미사용', size: '300MB', size_bytes: 300_000_000, ref: 'old:1.0', rmi: 'old:1.0', id: 'b'.repeat(12), created: '', created_since: '' },
    { class: '확인 필요(최근 생성)', size: '1GB', size_bytes: 1_000_000_000, ref: 'mine:dev', rmi: 'mine:dev', id: 'c'.repeat(12), created: '', created_since: '' },
    { class: '미사용', size: '1.2GB', size_bytes: 1_200_000_000, ref: '<none>', rmi: 'd'.repeat(12), id: 'd'.repeat(12), created: '', created_since: '' },
  ]

  function withFile(context: string | null = 'desktop-linux', images: unknown[] = IMAGES) {
    const s = setup()
    const imagesFile = write(join(s.box.root, 'images.json'), JSON.stringify({ ...(context ? { context } : {}), recent_hours: 24, images }))
    // 옵션은 위치 인자(RUNTIMES_JSON, 동작) 앞에 둔다
    const runOpts = (id: string, opts: string[], rest: string[]) => s.box.run('docker_cleanup', ['--runtime', id, ...opts, s.file, ...rest])
    const runFile = (id: string, cls: string, opts: string[] = []) => runOpts(id, ['--images-json', imagesFile, '--class', cls, ...opts], ['rmi'])
    return { ...s, imagesFile, runFile, runOpts }
  }

  test('dry-run 은 그 분류의 rmi 값만 명령으로 보이고 개수와 합계를 적는다', () => {
    const { runFile, sent } = withFile()
    const done = runFile('docker-desktop', '미사용')
    assert.equal(done.code, 0, done.stderr)
    assert.equal(
      done.stdout,
      '## dry-run (변경 없음, 실제 삭제는 --apply)\n런타임: Docker Desktop(docker-desktop), context: desktop-linux\n' +
        '대상: 이미지 조사 파일의 미사용 2개, 합계 최대 1.5GB\n' +
        `[삭제 예정] docker --context desktop-linux rmi old:1.0\n[삭제 예정] docker --context desktop-linux rmi ${'d'.repeat(12)}\n`,
    )
    assert.deepEqual(sent(), [])
  })

  test('--apply 는 그 분류의 이미지마다 rmi 를 따로 보낸다', () => {
    const { runFile, sent } = withFile()
    const done = runFile('docker-desktop', '확인 필요(최근 생성)', ['--apply'])
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(sent(), [['--context', 'desktop-linux', 'rmi', 'mine:dev']])
  })

  test('그 분류의 이미지가 없으면 docker 를 부르지 않고 0 이다', () => {
    const { runFile, docker } = withFile('desktop-linux', [IMAGES[0]])
    const done = runFile('docker-desktop', '미사용', ['--apply'])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, '이미지 조사 파일에 미사용 이미지가 없다. 보낼 명령이 없다\n')
    assert.deepEqual(docker.calls(), [])
  })

  test('파일의 context 가 런타임의 context 와 다르면 2 이고 docker 를 부르지 않는다', () => {
    for (const context of ['orbstack', null]) {
      const { runFile, docker } = withFile(context)
      const done = runFile('docker-desktop', '미사용', ['--apply'])
      assert.equal(done.code, 2, done.stderr)
      assert.ok(done.stderr.includes('이미지 조사 파일의 context'), done.stderr)
      assert.deepEqual(docker.calls(), [])
    }
  })

  test('조합이 맞지 않거나 형식이 틀리면 2 이고 docker 를 부르지 않는다', () => {
    const { runOpts, imagesFile, box, docker } = withFile()
    const broken = write(join(box.root, 'broken.json'), JSON.stringify({ images: [{ class: '미사용' }] }))
    const cases: [string[], string[], string][] = [
      [['--images-json', imagesFile], ['rmi'], '--images-json 과 --class 는 함께 준다'],
      [['--class', '미사용'], ['rmi', 'a:1'], '--images-json 과 --class 는 함께 준다'],
      [['--images-json', imagesFile, '--class', '미사용'], ['rmi', 'a:1'], 'REF 없이 rmi 에만 쓴다'],
      [['--images-json', imagesFile, '--class', '미사용'], ['builder-prune'], 'REF 없이 rmi 에만 쓴다'],
      [['--images-json', imagesFile, '--class', '사용 중'], ['rmi'], 'invalid choice'],
      [['--images-json', broken, '--class', '미사용'], ['rmi'], 'docker_images.ts --json-out 형식이 아니다'],
      [['--images-json', join(box.root, 'none.json'), '--class', '미사용'], ['rmi'], '입력을 읽을 수 없다'],
    ]
    for (const [opts, rest, message] of cases) {
      const done = runOpts('docker-desktop', opts, rest)
      const label = [...opts, ...rest].join(' ')
      assert.equal(done.code, 2, `${label}: ${done.stderr}`)
      assert.ok(done.stderr.includes(message), `${label}: ${done.stderr}`)
    }
    assert.deepEqual(docker.calls(), [])
  })
})
