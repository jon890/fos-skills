// docker_volumes 의 명령 경계 테스트. docker 는 가짜 실행 파일이고 TZ 는 UTC 로 고정한다.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { FakeRule } from '../../../modules/testkit/fake-bin.ts'
import { Sandbox } from './helpers.ts'

const HOUR = 3600 * 1000
const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(64))
const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}+00:00`
const epoch = (text: string) => Date.parse(text) / 1000
const pad = (text: string) => text.padStart(9)
const pyFloat = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n))

type Vol = { name: string; created?: string | null; size?: string | null }
type Opts = { ryuk?: boolean; images?: string[]; peeks?: Record<string, { out?: string; err?: string }>; down?: boolean; dfOutput?: string }

function dockerRules(vols: Vol[], opts: Opts = {}): FakeRule[] {
  if (opts.down) return [{ stderr: 'Cannot connect to the Docker daemon', code: 1 }]
  const rules: FakeRule[] = [
    { args: ['volume', 'ls'], stdout: vols.map((v) => v.name).join('\n') + '\n' },
    { args: ['volume', 'inspect'], stdout: JSON.stringify(vols.filter((v) => /^[0-9a-f]{64}$/.test(v.name)).map((v) => ({ Name: v.name, CreatedAt: v.created }))) },
    { args: ['system', 'df'], stdout: opts.dfOutput ?? `${JSON.stringify(vols.map((v) => ({ Name: v.name, Size: v.size === null ? undefined : (v.size ?? '0B') })))}\n` },
    { args: ['ps'], stdout: opts.ryuk ? 'testcontainers/ryuk:0.11.0\n' : 'postgres:17\n' },
    { args: ['images'], stdout: (opts.images ?? ['alpine:3.20', 'postgres:17']).join('\n') + '\n' },
  ]
  for (const [name, peek] of Object.entries(opts.peeks ?? {})) rules.push({ args: ['run', `${name}:/v:ro`], stdout: peek.out ?? '', stderr: peek.err ?? '', code: peek.err ? 1 : 0 })
  rules.push({ args: ['run'] })
  return rules
}

function setup(vols: Vol[], opts: Opts = {}) {
  const box = new Sandbox()
  const docker = box.fake('docker', dockerRules(vols, opts))
  const run = (args: string[] = []) => box.run('docker_volumes', args)
  return { box, docker, run }
}

const OLD1 = '2026-10-14T13:14:51+00:00'
const OLD2 = '2026-10-12T01:02:03+00:00'

describe('분류와 출력', () => {
  test('후보와 최근을 나누고 후보는 큰 순서로 보인다', () => {
    const recent = iso(Date.now() - HOUR)
    const { run } = setup([
      { name: B, created: OLD2, size: '12kB' },
      { name: A, created: OLD1, size: '256.6MB' },
      { name: C, created: recent, size: '1.5GB' },
      { name: 'pgdata', created: OLD1, size: '5GB' },
    ])
    const done = run()
    assert.equal(done.code, 0, done.stderr)
    const made = (text: string) => text.slice(0, 16).replace('T', ' ')
    assert.equal(
      done.stdout,
      `## 후보(하루 넘은 dangling 익명 volume)\n${'256.6MB'.padStart(9)}  ${made(OLD1)}  ${A}\n${'12.0KB'.padStart(9)}  ${made(OLD2)}  ${B}\n` +
        `## 최근(24시간 안, 후보에서 뺀다)\n${'1.5GB'.padStart(9)}  ${made(recent)}  ${C}\n` +
        `\n## 합계\n   2개 ${'256.6MB'.padStart(9)}  후보\n   1개 ${'1.5GB'.padStart(9)}  최근\n`,
    )
  })

  test('크기가 같으면 이름순이고 크기를 모르면 ? 와 0 으로 센다', () => {
    const { run } = setup([
      { name: B, created: OLD1, size: '1MB' },
      { name: A, created: OLD1, size: '1MB' },
      { name: C, created: OLD1, size: null },
      { name: D, created: OLD1, size: 'N/A' },
    ])
    const rows = run().stdout.split('\n').filter((l) => l.includes('2026-10-14'))
    assert.deepEqual(rows.map((l) => l.trim().split(/\s+/)[0]), ['1.0MB', '1.0MB', '0B', '0B'].map((s, i) => (i >= 2 ? '?' : s)))
    assert.deepEqual(rows.map((l) => l.slice(-64)), [A, B, C, D])
  })

  test('생성 시각을 모르면 최근이고 - 로 보인다', () => {
    const { run } = setup([{ name: A, created: null, size: '1kB' }, { name: B, created: 'not a date', size: '1kB' }])
    const out = run().stdout
    assert.ok(out.includes('## 후보(하루 넘은 dangling 익명 volume)\n## 최근(24시간 안, 후보에서 뺀다)\n'))
    assert.ok(out.includes(`  -  ${A}\n`))
    assert.ok(out.includes(`   0개 ${pad('0B')}  후보\n   2개 ${pad('2.0KB')}  최근\n`))
  })

  test('--recent-hours 는 기준을 바꾸고 제목은 %g 꼴로 보인다', () => {
    const ts = iso(Date.now() - 5 * HOUR)
    const { run } = setup([{ name: A, created: ts, size: '1kB' }])
    assert.ok(run().stdout.includes('## 최근(24시간 안'))
    const six = run(['--recent-hours', '3.5'])
    assert.ok(six.stdout.includes('## 최근(3.5시간 안, 후보에서 뺀다)\n'))
    assert.ok(six.stdout.includes(`${A}\n`) && six.stdout.includes(`   1개 ${pad('1.0KB')}  후보\n`))
    assert.ok(run(['--rec=1e1']).stdout.includes('최근(10시간 안'))
  })

  test('이름이 64자 소문자 hex 가 아닌 volume 은 빼고 대문자 hex 도 뺀다', () => {
    const { run } = setup([{ name: 'A'.repeat(64), created: OLD1 }, { name: 'a'.repeat(63), created: OLD1 }, { name: A, created: OLD1 }])
    assert.equal(run().stdout.split('\n').filter((l) => l.includes('2026-10')).length, 1)
  })

  test('익명 volume 이 없으면 volume inspect 를 부르지 않는다', () => {
    const { run, docker } = setup([{ name: 'pgdata' }])
    run()
    assert.ok(!docker.calls().some((c) => c.argv[1] === 'inspect'))
  })

  test('system df 가 비어 있으면 빈 목록으로 읽는다', () => {
    const { run } = setup([{ name: A, created: OLD1 }], { dfOutput: '' })
    assert.ok(run().stdout.includes(`  ?  `) || run().stdout.includes(`    ?  ${OLD1.slice(0, 10)}`))
  })
})

describe('ryuk 경고', () => {
  test('ryuk 가 떠 있으면 첫 줄에 경고한다', () => {
    const { run } = setup([{ name: A, created: OLD1, size: '1kB' }], { ryuk: true })
    assert.ok(run().stdout.startsWith('경고: testcontainers ryuk 가 떠 있다. 다른 세션이 테스트 중이므로 지우기 전에 사용자에게 알린다\n## 후보'))
  })
})

describe('--peek', () => {
  const vols: Vol[] = [
    { name: A, created: OLD1, size: '5GB' },
    { name: B, created: OLD1, size: '4GB' },
    { name: C, created: OLD1, size: '3GB' },
    { name: D, created: iso(Date.now() - HOUR), size: '2GB' },
  ]

  test('--peek N 은 큰 후보 N개만 연다', () => {
    const { run, docker } = setup(vols, { peeks: { [A]: { out: 'PG_VERSION\nbase\nglobal\n' }, [B]: { out: 'ibdata1\nmysql\n' } } })
    const done = run(['--peek', '2'])
    assert.equal(done.code, 0, done.stderr)
    const runs = docker.calls().filter((c) => c.argv[0] === 'run')
    assert.deepEqual(runs.map((c) => c.argv), [A, B].map((n) => ['run', '--rm', '--pull=never', '--network', 'none', '-v', `${n}:/v:ro`, '--entrypoint', 'ls', 'alpine:3.20', '-A', '/v']))
    assert.ok(done.stdout.includes(`${A}\n           내용: [postgres] PG_VERSION base global\n`))
    assert.ok(done.stdout.includes(`${B}\n           내용: [mysql] ibdata1 mysql\n`))
    assert.ok(!done.stdout.includes(`${C}\n           내용:`))
    assert.ok(done.stdout.endsWith(`\n## 열어 본 후보의 종류별 합계\n   1개 ${pad('5.0GB')}  postgres\n   1개 ${pad('4.0GB')}  mysql\n`), done.stdout)
  })

  test('all 이면 후보를 모두 열고 최근 volume 은 열지 않는다', () => {
    const { run, docker } = setup(vols, { peeks: { [C]: { out: 'SOUL.md\nauth.json\n' } } })
    const done = run(['--peek', 'all'])
    assert.equal(docker.calls().filter((c) => c.argv[0] === 'run').length, 3)
    assert.ok(done.stdout.includes(`내용: [other] SOUL.md auth.json\n`))
  })

  test('열기 실패는 열지 못함으로 보이고 오류는 120자로 자른다', () => {
    const err = `Error: ${'x'.repeat(200)}`
    const { run } = setup([vols[0]], { peeks: { [A]: { err } } })
    const done = run(['--peek', '1'])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes(`           내용: 열지 못함: ${err.slice(0, 120)}\n`))
    assert.ok(!done.stdout.includes('열어 본 후보의 종류별 합계'))
  })

  test('내용이 열두 개를 넘으면 열두 개만 보인다', () => {
    const entries = Array.from({ length: 15 }, (_, i) => `f${i}`)
    const { run } = setup([vols[0]], { peeks: { [A]: { out: `${entries.join('\n')}\n` } } })
    assert.ok(run(['--peek', '1']).stdout.includes(`[other] ${entries.slice(0, 12).join(' ')}\n`))
  })

  test('로컬 이미지가 없으면 경고하고 열지 않는다', () => {
    const { run, docker } = setup([vols[0]], { images: ['mysql:8.4', 'alpine:<none>'] })
    const done = run(['--peek', '1'])
    assert.equal(done.code, 0)
    assert.equal(done.stderr, '경고: 내용을 열 로컬 이미지가 없어 --peek 을 건너뛴다. --peek-image 로 지정한다\n')
    assert.ok(!docker.calls().some((c) => c.argv[0] === 'run'))
  })

  test('--peek-image 가 우선하고 이미지 선호는 alpine, busybox, debian, ubuntu 순이다', () => {
    const a = setup([vols[0]], { images: ['ubuntu:24.04', 'debian:12', 'busybox:1', 'x/alpine:3'] })
    a.run(['--peek', '1'])
    assert.equal(a.docker.calls().at(-1)!.argv.at(-3), 'x/alpine:3')
    const b = setup([vols[0]], { images: ['ubuntu:24.04', 'library/debian:12'] })
    b.run(['--peek', '1'])
    assert.equal(b.docker.calls().at(-1)!.argv.at(-3), 'library/debian:12')
    const c = setup([vols[0]])
    c.run(['--peek', '1', '--peek-image', 'my/img:1'])
    assert.equal(c.docker.calls().at(-1)!.argv.at(-3), 'my/img:1')
  })

  test('--peek 값 읽기: 정수, all, 앞뒤 공백, 밑줄, 0, 음수', () => {
    const one = setup(vols)
    one.run(['--peek', ' 2 '])
    assert.equal(one.docker.calls().filter((c) => c.argv[0] === 'run').length, 2)
    const zero = setup(vols)
    zero.run(['--peek', '0'])
    assert.equal(zero.docker.calls().filter((c) => c.argv[0] === 'run').length, 0)
    const neg = setup(vols)
    assert.equal(neg.run(['--peek', '-1']).code, 0)
    assert.equal(neg.docker.calls().filter((c) => c.argv[0] === 'run').length, 0)
    const under = setup(vols)
    under.run(['--peek', '1_0'])
    assert.equal(under.docker.calls().filter((c) => c.argv[0] === 'run').length, 3)
  })

  test('--peek 에 정수도 all 도 아니면 사용법 오류 2 다', () => {
    const { run } = setup(vols)
    for (const v of ['many', 'ALL', '1.5', '']) {
      const done = run([`--peek=${v}`])
      assert.equal(done.code, 2, v)
      assert.ok(done.stderr.includes('argument --peek: 정수 또는 all 이어야 한다'), done.stderr)
    }
  })
})

describe('JSON', () => {
  const volumes: Vol[] = [{ name: A, created: OLD1, size: '5GB' }, { name: B, created: OLD2, size: '4GB' }]
  const peeks = { [A]: { out: 'PG_VERSION\n' } }

  test('--json 은 들여쓴 JSON 이고 실수는 1.0 꼴이다', () => {
    const { run } = setup(volumes, { peeks })
    const done = run(['--json', '--peek', '1'])
    assert.equal(done.code, 0, done.stderr)
    const expected = `{
  "ryuk_running": false,
  "recent_hours": 24,
  "peek_image": "alpine:3.20",
  "totals": {
    "후보": {
      "count": 2,
      "size_bytes": 9000000000
    },
    "최근": {
      "count": 0,
      "size_bytes": 0
    }
  },
  "kind_totals": {
    "postgres": {
      "count": 1,
      "size_bytes": 5000000000
    }
  },
  "volumes": [
    {
      "name": "${A}",
      "created_ts": ${pyFloat(epoch(OLD1))},
      "size_bytes": 5000000000,
      "class": "후보",
      "kind": "postgres",
      "top_entries": [
        "PG_VERSION"
      ],
      "peek_error": null
    },
    {
      "name": "${B}",
      "created_ts": ${pyFloat(epoch(OLD2))},
      "size_bytes": 4000000000,
      "class": "후보",
      "kind": null
    }
  ]
}
`
    assert.equal(done.stdout, expected)
  })

  test('recent_hours 는 옵션으로 주면 실수 꼴이고 안 주면 정수 24 다', () => {
    const { run } = setup(volumes)
    assert.ok(run(['--json']).stdout.includes('"recent_hours": 24,\n'))
    assert.ok(run(['--json', '--recent-hours', '24']).stdout.includes('"recent_hours": 24.0,\n'))
    assert.ok(run(['--json', '--recent-hours', '1e1']).stdout.includes('"recent_hours": 10.0,\n'))
    assert.ok(run(['--json', '--recent-hours=0.25']).stdout.includes('"recent_hours": 0.25,\n'))
  })

  test('peek_image 는 실제로 열었을 때만 이름이다', () => {
    const { run } = setup(volumes)
    assert.ok(run(['--json', '--peek', '0']).stdout.includes('"peek_image": null,\n'))
  })

  test('볼륨이 없으면 빈 목록이다', () => {
    const { run } = setup([])
    const out = run(['--json']).stdout
    assert.ok(out.endsWith('  "kind_totals": {},\n  "volumes": []\n}\n'), out)
  })

  test('--json-out 은 텍스트를 내면서 같은 JSON 을 파일에 줄바꿈 하나와 함께 쓴다', () => {
    const { box, run } = setup(volumes, { peeks })
    const file = join(box.root, 'v.json')
    const done = run(['--peek', '1', '--json-out', file])
    assert.ok(done.stdout.startsWith('## 후보'))
    const jsonRun = run(['--peek', '1', '--json'])
    assert.equal(readFileSync(file, 'utf8'), jsonRun.stdout)
  })

  test('--json 과 --json-out 을 함께 주면 stdout 은 JSON 이고 파일도 쓴다', () => {
    const { box, run } = setup(volumes)
    const file = join(box.root, 'v.json')
    const done = run(['--json', '--json-out', file])
    assert.equal(readFileSync(file, 'utf8'), done.stdout)
  })

  test('--json-out 을 쓸 수 없으면 1 이다', () => {
    const { box, run } = setup(volumes)
    const done = run(['--json-out', join(box.root, 'no/such/dir/o.json')])
    assert.equal(done.code, 1)
    assert.ok(done.stderr.startsWith('--json-out 파일을 쓸 수 없다: '))
    assert.equal(done.stdout, '')
  })

  test('ryuk 는 JSON 에서 ryuk_running 이다', () => {
    const { run } = setup(volumes, { ryuk: true })
    assert.ok(run(['--json']).stdout.startsWith('{\n  "ryuk_running": true,\n'))
  })
})

describe('docker 상태와 옵션', () => {
  test('docker 를 쓸 수 없으면 1 이다', () => {
    const { run } = setup([], { down: true })
    const done = run()
    assert.equal(done.code, 1)
    assert.equal(done.stdout, '')
    assert.equal(done.stderr, 'docker 를 쓸 수 없다: Cannot connect to the Docker daemon\n')
  })

  test('docker 가 PATH 에 없어도 1 이다', () => {
    const box = new Sandbox()
    assert.equal(box.run('docker_volumes').code, 1)
  })

  test('docker 출력이 JSON 이 아니면 1 이다', () => {
    const { run } = setup([{ name: A, created: OLD1 }], { dfOutput: 'garbage' })
    assert.equal(run().code, 1)
  })

  test('옵션은 줄여 쓰고 모르는 옵션은 사용법 오류 2 다', () => {
    const { run } = setup([])
    assert.equal(run(['--j']).code, 2)
    assert.equal(run(['--json-']).code, 2)
    assert.equal(run(['--json-o']).code, 2)
    assert.equal(run(['--peek-']).code, 2)
    assert.equal(run(['--nope']).code, 2)
    assert.equal(run(['--json=1']).code, 2)
    const ambiguous = run(['--json'])
    assert.equal(ambiguous.code, 0)
    const help = run(['--help'])
    assert.equal(help.code, 0)
    assert.ok(help.stdout.startsWith('usage: '))
  })
})
