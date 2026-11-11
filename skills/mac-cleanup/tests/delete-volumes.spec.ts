// delete_volumes 의 명령 경계 테스트. docker 는 가짜 실행 파일이라 실제 volume 을 지우지 않는다.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { FakeRule } from '../../../modules/testkit/fake-bin.ts'
import { Sandbox, write } from './helpers.ts'

const [PG, MY, OT, FRESH, UNOPENED, GONE] = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(64))

const vol = (name: string, kind: string | null, cls = '후보', extra: object = {}) => ({
  name,
  class: cls,
  size_bytes: 1000,
  kind,
  ...(kind === null ? {} : { top_entries: ['x'], peek_error: null }),
  ...extra,
})

function setup(opts: { ryuk?: boolean; dangling?: string[]; fail?: string[]; down?: boolean } = {}) {
  const box = new Sandbox()
  // 실제 docker 는 엔진이 꺼져도 `context inspect` 가 된다. 삭제 도구가 먼저 엔드포인트를 읽으므로 두 경우 모두 로컬 소켓을 낸다
  const endpoint: FakeRule = { args: ['context', 'inspect'], stdout: 'unix:///var/run/docker.sock\n' }
  const rules: FakeRule[] = opts.down
    ? [endpoint, { stderr: 'Cannot connect to the Docker daemon', code: 1 }]
    : [
        endpoint,
        { args: ['ps'], stdout: opts.ryuk ? 'postgres:17\ntestcontainers/ryuk:0.11.0\n' : 'postgres:17\n' },
        { args: ['volume', 'ls'], stdout: `${(opts.dangling ?? [PG, MY, OT, UNOPENED, FRESH]).join('\n')}\n` },
        ...(opts.fail ?? []).map((name) => ({ args: ['volume', 'rm', name], stderr: 'Error: volume is in use', code: 1 })),
        { args: ['volume', 'rm'] },
      ]
  const docker = box.fake('docker', rules)
  const file = (volumes: object[]) => write(join(box.root, 'v.json'), JSON.stringify({ volumes }))
  const removed = () => docker.calls().filter((c) => c.argv[0] === 'volume' && c.argv[1] === 'rm').map((c) => c.argv)
  const run = (volumes: object[], args: string[] = []) => box.run('delete_volumes', [file(volumes), ...args])
  return { box, docker, file, removed, run }
}

const pad = (text: string) => text.padStart(9)
const all = [vol(PG, 'postgres'), vol(MY, 'mysql'), vol(OT, 'other')]

describe('삭제 대상 판정', () => {
  test('dry-run 은 docker volume rm 을 부르지 않는다', () => {
    const { removed, run } = setup()
    const done = run([vol(PG, 'postgres')])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, `## dry-run (변경 없음, 실제 삭제는 --apply)\n대상 종류: postgres, mysql\n[삭제 예정] ${pad('1.0KB')}  ${PG}  docker volume rm (postgres)\n\n## 합계\n   1개 ${pad('1.0KB')}  삭제 예정\n`)
    assert.deepEqual(removed(), [])
  })

  test('--apply 는 기본 종류를 이름마다 따로 지우고 other 는 지우지 않는다', () => {
    const { removed, run } = setup()
    const done = run(all, ['--apply'])
    assert.equal(done.code, 0)
    assert.deepEqual(removed(), [['volume', 'rm', PG], ['volume', 'rm', MY]])
    assert.ok(done.stdout.startsWith('## 실행\n대상 종류: postgres, mysql\n'))
    assert.ok(done.stdout.includes(`[삭제] ${pad('1.0KB')}  ${PG}  (postgres)\n`))
    assert.ok(done.stdout.includes(`[유지] ${pad('1.0KB')}  ${OT}  종류 other 는 --kind 에 없다\n`))
    assert.ok(done.stdout.endsWith(`\n## 합계\n   2개 ${pad('2.0KB')}  삭제\n   1개 ${pad('1.0KB')}  유지\n`), done.stdout)
  })

  test('--kind 는 거듭 주거나 여러 값으로 주면 모두 모으고 대상 종류는 postgres, mysql, other 순서로 보인다', () => {
    const { removed, run } = setup()
    const done = run(all, ['--apply', '--kind', 'other', '--kind', 'postgres'])
    assert.deepEqual(removed(), [['volume', 'rm', PG], ['volume', 'rm', OT]])
    assert.ok(done.stdout.includes('대상 종류: postgres, other\n'))
    const many = setup()
    const multi = many.run(all, ['--kind', 'other', 'mysql'])
    assert.ok(multi.stdout.includes('대상 종류: mysql, other\n'))
    assert.equal(multi.stdout.split('\n').filter((l) => l.startsWith('[삭제 예정]')).length, 2)
  })

  test('--kind 에 모르는 값이면 사용법 오류 2 다', () => {
    const { run } = setup()
    const done = run(all, ['--kind', 'redis'])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes("argument --kind: invalid choice: 'redis' (choose from 'postgres', 'mysql', 'other')"), done.stderr)
    assert.equal(run(all, ['--kind']).code, 2)
    assert.equal(run(all, ['--kind', 'other', 'redis']).code, 2)
  })

  test('열지 않은 volume, 최근 volume, 열기 실패한 volume 은 유지한다', () => {
    const { removed, run } = setup()
    const done = run([vol(UNOPENED, null), vol(FRESH, 'postgres', '최근'), vol(PG, null, '후보', { peek_error: 'boom' }), vol(MY, 'mysql', '후보', { peek_error: 'boom' })], ['--apply'])
    assert.ok(done.stdout.includes(`  ${UNOPENED}  내용을 열어 보지 않았다\n`))
    assert.ok(done.stdout.includes(`  ${FRESH}  분류 최근\n`))
    assert.ok(done.stdout.includes(`  ${PG}  내용을 열지 못했다: boom\n`))
    assert.ok(done.stdout.includes(`  ${MY}  내용을 열지 못했다: boom\n`))
    assert.deepEqual(removed(), [])
  })

  test('이름 있는 volume 은 지우지 않는다', () => {
    const { removed, run } = setup({ dangling: ['pgdata'] })
    const done = run([vol('pgdata', 'postgres')], ['--apply'])
    assert.ok(done.stdout.includes('  pgdata  익명 volume 이름이 아니다\n'))
    assert.deepEqual(removed(), [])
  })

  test('실행 직전에 dangling 목록에 없으면 유지한다', () => {
    const { removed, run } = setup()
    const done = run([vol(GONE, 'postgres')], ['--apply'])
    assert.ok(done.stdout.includes(`  ${GONE}  dangling 목록에 없다(이미 없거나 컨테이너에 붙었다)\n`))
    assert.deepEqual(removed(), [])
  })

  test('docker volume rm 이 실패하면 오류 문장을 보이고 종료 코드 1 이며 나머지는 계속한다', () => {
    const { removed, run } = setup({ fail: [PG] })
    const done = run(all, ['--apply'])
    assert.equal(done.code, 1)
    assert.ok(done.stdout.includes(`[실패] ${pad('1.0KB')}  ${PG}  Error: volume is in use\n`), done.stdout)
    assert.deepEqual(removed(), [['volume', 'rm', PG], ['volume', 'rm', MY]])
  })
})

describe('크기 서식', () => {
  test('Docker 와 같은 10진수 단위를 쓰고 정확히 반인 값은 짝수로 반올림한다', () => {
    const sizes = [0, 999, 1000, 1250, 1750, 1_500_000, 2_500_000_000, 1_234_000_000_000, 12_500]
    const rows = sizes.map((size, i) => vol(String(i).repeat(64), 'postgres', '후보', { size_bytes: size }))
    const { run } = setup({ dangling: rows.map((r) => r.name) })
    const done = run(rows)
    const got = done.stdout.split('\n').filter((l) => l.startsWith('[삭제 예정]')).map((l) => /^\[삭제 예정\]\s+(\S+)/.exec(l)![1])
    assert.deepEqual(got, ['0B', '999B', '1.0KB', '1.2KB', '1.8KB', '1.5MB', '2.5GB', '1.2TB', '12.5KB'])
  })

  test('size_bytes 가 없거나 null 이면 0 으로 센다', () => {
    const { run } = setup()
    const done = run([{ name: PG, class: '후보', kind: 'postgres', size_bytes: null }])
    assert.ok(done.stdout.includes(`[삭제 예정] ${pad('0B')}  ${PG}`))
  })
})

describe('ryuk 와 docker 상태', () => {
  test('ryuk 가 떠 있으면 dry-run 은 경고하고 아무것도 지우지 않는다', () => {
    const { removed, run } = setup({ ryuk: true })
    const done = run(all)
    assert.equal(done.code, 0)
    assert.ok(done.stdout.startsWith('경고: testcontainers ryuk 가 떠 있다. 다른 세션이 테스트 중이므로 --apply 전에 사용자에게 알린다\n## dry-run'))
    assert.deepEqual(removed(), [])
  })

  test('ryuk 가 떠 있으면 --apply 는 3 으로 거부한다', () => {
    const { removed, run } = setup({ ryuk: true })
    const done = run(all, ['--apply'])
    assert.equal(done.code, 3)
    assert.equal(done.stdout, '')
    assert.ok(done.stderr.includes('거부: testcontainers ryuk 가 떠 있다. 다른 세션이 테스트 중이므로 --apply 를 하지 않는다'))
    assert.deepEqual(removed(), [])
  })

  test('docker 를 쓸 수 없으면 4 다', () => {
    const { run } = setup({ down: true })
    const done = run(all)
    assert.equal(done.code, 4)
    assert.ok(done.stderr.startsWith('docker 를 쓸 수 없다: '))
  })

  test('docker 가 PATH 에 없어도 4 다', () => {
    const box = new Sandbox()
    const file = write(join(box.root, 'v.json'), JSON.stringify({ volumes: all }))
    assert.equal(box.run('delete_volumes', [file]).code, 4)
  })

  test('입력 오류는 docker 를 부르기 전에 2 로 끝난다', () => {
    const { box, docker } = setup()
    assert.equal(box.run('delete_volumes', [join(box.root, 'none.json')]).code, 2)
    for (const body of ['[]', '{}', '{"volumes": [{"x": 1}]}', 'nope']) {
      const done = box.run('delete_volumes', [write(join(box.root, 'bad.json'), body)])
      assert.equal(done.code, 2, body)
      assert.ok(done.stderr.startsWith('입력을 읽을 수 없다: '), body)
    }
    assert.equal(docker.calls().length, 0)
  })

  test('- 는 표준 입력에서 읽고 docker 호출 순서는 엔드포인트, ps, volume ls 다', () => {
    const { box, docker } = setup()
    const done = box.run('delete_volumes', ['-'], { input: JSON.stringify({ volumes: [vol(PG, 'postgres')] }) })
    assert.equal(done.code, 0)
    assert.deepEqual(docker.calls().map((c) => c.argv), [['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], ['ps', '--format', '{{.Image}}'], ['volume', 'ls', '-f', 'dangling=true', '-q']])
  })
})

describe('context 와 원격 엔진(REQ2, REQ4)', () => {
  const rules = (endpoints: Record<string, string>): FakeRule[] => [
    ...Object.entries(endpoints).map(([name, host]) => ({ args: ['context', 'inspect', name], stdout: `${host}\n` })),
    { args: ['ps'], stdout: 'postgres:17\n' },
    { args: ['volume', 'ls'], stdout: `${PG}\n` },
    { args: ['volume', 'rm'] },
  ]
  const withContext = (context: string | undefined) => ({ context, volumes: [vol(PG, 'postgres')] })
  const removes = (calls: { argv: string[] }[]) => calls.filter((c) => c.argv.includes('rm')).map((c) => c.argv)

  test('ssh 와 tcp 엔드포인트는 dry-run 도 --apply 도 5 로 거부하고 volume rm 을 보내지 않는다', () => {
    const { box, docker } = setup()
    docker.setRules(rules({ prod: 'ssh://deploy@prod.example.com', lab: 'tcp://10.0.0.5:2376' }))
    const file = write(join(box.root, 'ctx.json'), JSON.stringify(withContext('prod')))
    for (const args of [[], ['--apply']]) {
      const done = box.run('delete_volumes', [file, ...args])
      assert.equal(done.code, 5, done.stderr)
      assert.equal(done.stdout, '')
      assert.ok(done.stderr.includes('거부: context prod 의 엔드포인트가 이 맥의 unix 소켓이 아니다(ssh://deploy@prod.example.com). 맥 밖 엔진의 volume 은 지우지 않는다\n'), done.stderr)
    }
    const flagOnly = write(join(box.root, 'plain.json'), JSON.stringify({ volumes: [vol(PG, 'postgres')] }))
    const viaFlag = box.run('delete_volumes', [flagOnly, '--context', 'lab', '--apply'])
    assert.equal(viaFlag.code, 5)
    assert.deepEqual(removes(docker.calls()), [])
    assert.ok(docker.calls().every((c) => c.argv[0] === 'context'), '엔드포인트를 읽는 호출 말고는 docker 를 부르지 않는다')
  })

  test('DOCKER_HOST 가 원격이고 context 를 안 줬으면 5 이고, 엔드포인트가 비거나 읽히지 않아도 5 나 4 로 닫는다', () => {
    const { box, docker } = setup()
    docker.setRules(rules({}))
    const file = write(join(box.root, 'plain.json'), JSON.stringify({ volumes: [vol(PG, 'postgres')] }))
    const remote = box.run('delete_volumes', [file, '--apply'], { env: box.env({ DOCKER_HOST: 'tcp://10.0.0.5:2376' }) })
    assert.equal(remote.code, 5)
    assert.deepEqual(docker.calls(), [])
    const empty = box.run('delete_volumes', [file, '--apply'])
    assert.equal(empty.code, 5)
    assert.ok(empty.stderr.includes('(비어 있음)'))
    assert.deepEqual(removes(docker.calls()), [])
  })

  test('엔드포인트를 읽지 못하면 4 로 닫고 volume rm 을 보내지 않는다', () => {
    const { box, docker } = setup()
    docker.setRules([{ args: ['context', 'inspect'], stderr: 'context "gone": context not found', code: 1 }, { args: ['volume', 'rm'] }])
    const file = write(join(box.root, 'ctx.json'), JSON.stringify(withContext('gone')))
    const done = box.run('delete_volumes', [file, '--apply'])
    assert.equal(done.code, 4)
    assert.ok(done.stderr.startsWith('docker 를 쓸 수 없다: context "gone": context not found'), done.stderr)
    assert.deepEqual(removes(docker.calls()), [])
  })

  test('DOCKER_CONTEXT 가 원격이면 DOCKER_HOST 가 로컬이어도 5 다. docker 는 DOCKER_CONTEXT 를 먼저 쓴다', () => {
    const { box, docker } = setup()
    docker.setRules(rules({ prod: 'ssh://deploy@prod.example.com' }))
    const file = write(join(box.root, 'plain.json'), JSON.stringify({ volumes: [vol(PG, 'postgres')] }))
    const done = box.run('delete_volumes', [file, '--apply'], { env: box.env({ DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: 'prod' }) })
    assert.equal(done.code, 5)
    assert.ok(done.stderr.includes('(ssh://deploy@prod.example.com)'), done.stderr)
    assert.deepEqual(removes(docker.calls()), [])
  })

  test('조사 파일의 context 로만 지운다. 로컬 unix 소켓이면 모든 호출이 그 context 를 가진다', () => {
    const { box, docker } = setup()
    docker.setRules(rules({ desktop: 'unix:///Users/x/.docker/run/docker.sock' }))
    const file = write(join(box.root, 'ctx.json'), JSON.stringify(withContext('desktop')))
    const done = box.run('delete_volumes', [file, '--apply'])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.startsWith('## 실행\ncontext: desktop\n'), done.stdout)
    assert.deepEqual(removes(docker.calls()), [['--context', 'desktop', 'volume', 'rm', PG]])
    assert.ok(docker.calls().slice(1).every((c) => c.argv[0] === '--context' && c.argv[1] === 'desktop'))
  })

  test('--context 가 조사 파일의 context 와 다르면 docker 를 부르기 전에 2 다', () => {
    const { box, docker } = setup()
    const file = write(join(box.root, 'ctx.json'), JSON.stringify(withContext('desktop')))
    const done = box.run('delete_volumes', [file, '--context', 'orbstack', '--apply'])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('--context orbstack 가 조사 파일의 context desktop 와 다르다'))
    assert.equal(docker.calls().length, 0)
  })
})
