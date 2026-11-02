import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ConfigError } from '../scripts/lib/config.ts'
import { dockerCleanup, dockerRules, ruleContainers, ruleImages, worktreeContainers } from '../scripts/lib/docker.ts'
import type { Container, Image, Runner } from '../scripts/lib/docker.ts'
import type { RunResult } from '../scripts/lib/proc.ts'

const WT = '/repo/worktrees/feat-a'

function box(id: string, name: string, extra: Partial<Container> = {}): Container {
  return { id, name, running: true, image: `sha256:img-${id}`, labels: {}, ...extra }
}

function compose(id: string, project: string, dir: string, extra: Partial<Container> = {}): Container {
  return box(id, `${project}-${id}`, {
    labels: { 'com.docker.compose.project': project, 'com.docker.compose.project.working_dir': dir },
    ...extra,
  })
}

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false })
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr, timedOut: false })

// docker 를 부르지 않고 상태 객체로 답하는 runner. 부른 인자를 calls 에 남긴다
function fakeDocker(state: { containers: Container[]; images?: Image[]; networks?: { id: string; name: string; project: string }[] }) {
  const calls: string[][] = []
  const runner: Runner = (args) => {
    calls.push(args)
    const [cmd, sub] = args
    if (cmd === 'ps') return ok(state.containers.map((c) => c.id).join('\n'))
    if (cmd === 'container' && sub === 'inspect') {
      const rows = state.containers
        .filter((c) => args.includes(c.id))
        .map((c) => ({ Id: c.id, Name: `/${c.name}`, Image: c.image, State: { Running: c.running }, Config: { Labels: c.labels } }))
      return ok(JSON.stringify(rows))
    }
    if (cmd === 'rm') {
      state.containers = state.containers.filter((c) => c.id !== args.at(-1))
      return ok()
    }
    if (cmd === 'network' && sub === 'ls') {
      const filter = args[args.indexOf('--filter') + 1]
      const project = filter.split('=').at(-1)
      return ok((state.networks ?? []).filter((n) => n.project === project).map((n) => `${n.id}\t${n.name}`).join('\n'))
    }
    if (cmd === 'network' && sub === 'rm') return ok()
    if (cmd === 'image' && sub === 'ls') return ok((state.images ?? []).map((i) => `${i.repository}\t${i.tag}\t${i.id}`).join('\n'))
    if (cmd === 'image' && sub === 'inspect') return ok((state.images ?? []).map((i) => `${i.id}\t${i.created}`).join('\n'))
    if (cmd === 'image' && sub === 'rm') return ok()
    return fail(`모르는 호출 ${args.join(' ')}`)
  }
  return { runner, calls }
}

function collect(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = []
  return { lines, log: (line) => lines.push(line) }
}

describe('dockerRules', () => {
  test('절이 없으면 빈 규칙이다', () => {
    assert.deepEqual(dockerRules({}), { containers: [], images: [] })
  })

  test('컨테이너 규칙과 이미지 규칙을 읽고 keep 기본값은 1 이다', () => {
    const rules = dockerRules({
      docker: {
        containers: [{ label: 'fos-assistant.temp', name: 'mysql-migration-check-(?<pid>\\d+)' }],
        images: [{ repository: 'fos-synthetic-.*-test' }, { repository: 'runner-test', keep: 0 }],
      },
    })
    assert.equal(rules.containers[0].label, 'fos-assistant.temp')
    assert.ok(rules.containers[0].name?.test('mysql-migration-check-80925'))
    // 정규식은 이름 전체에 맞춘다
    assert.ok(!rules.containers[0].name?.test('x-mysql-migration-check-80925'))
    assert.deepEqual(
      rules.images.map((r) => r.keep),
      [1, 0],
    )
  })

  for (const [what, body] of [
    ['모르는 절 키', { other: [] }],
    ['목록이 아닌 containers', { containers: {} }],
    ['label 도 name 도 없는 규칙', { containers: [{}] }],
    ['모르는 규칙 키', { containers: [{ label: 'a', volume: true }] }],
    ['틀린 정규식', { containers: [{ name: '(' }] }],
    ['repository 가 없는 이미지 규칙', { images: [{ keep: 1 }] }],
    ['음수 keep', { images: [{ repository: 'a', keep: -1 }] }],
    ['정수가 아닌 keep', { images: [{ repository: 'a', keep: 1.5 }] }],
  ] as const) {
    test(`${what}는 ConfigError 다`, () => {
      assert.throws(() => dockerRules({ docker: body as Record<string, unknown> }), ConfigError)
    })
  }
})

describe('worktreeContainers', () => {
  test('working_dir 이 워크트리이거나 그 아래인 compose 컨테이너만 고른다', () => {
    const picked = worktreeContainers(
      [
        compose('a', 'feat-a', WT),
        compose('b', 'feat-a', `${WT}/infra`),
        compose('c', 'feat-ab', `${WT}b`),
        compose('d', 'company', '/work/company'),
        box('e', 'testcontainers-ryuk'),
      ],
      [WT],
    )
    assert.deepEqual(
      picked.map((v) => [v.container.id, v.remove]),
      [
        ['a', true],
        ['b', true],
      ],
    )
  })
})

describe('ruleContainers', () => {
  const rules = dockerRules({
    docker: { containers: [{ label: 'fos-assistant.temp', name: 'mysql-migration-check-(?<pid>\\d+)' }, { label: 'fos-assistant.temp' }] },
  }).containers
  const alive = (pid: number) => pid === 111

  test('이름의 PID 가 죽었으면 지우고 살아 있으면 남긴다', () => {
    const verdicts = ruleContainers(
      [
        box('a', 'mysql-migration-check-80925', { labels: { 'fos-assistant.temp': 'true' } }),
        box('b', 'mysql-migration-check-111', { labels: { 'fos-assistant.temp': 'true' } }),
      ],
      rules,
      alive,
    )
    assert.deepEqual(
      verdicts.map((v) => [v.container.id, v.remove]),
      [
        ['a', true],
        ['b', false],
      ],
    )
    assert.match(verdicts[1].reason, /111 가 살아 있다/)
  })

  test('표식이 없으면 이름이 맞아도 고르지 않는다', () => {
    assert.deepEqual(ruleContainers([box('a', 'mysql-migration-check-80925')], rules, alive), [])
  })

  test('PID 묶음이 없는 규칙은 멈춘 컨테이너만 지운다', () => {
    const verdicts = ruleContainers(
      [
        box('a', 'other-temp', { labels: { 'fos-assistant.temp': '1' }, running: true }),
        box('b', 'other-stopped', { labels: { 'fos-assistant.temp': '1' }, running: false }),
      ],
      rules,
      alive,
    )
    assert.deepEqual(
      verdicts.map((v) => [v.container.id, v.remove]),
      [
        ['a', false],
        ['b', true],
      ],
    )
  })

  test('label 의 키=값 꼴은 값까지 맞춘다', () => {
    const exact = dockerRules({ docker: { containers: [{ label: 'role=temp' }] } }).containers
    const verdicts = ruleContainers(
      [box('a', 'x', { labels: { role: 'temp' }, running: false }), box('b', 'y', { labels: { role: 'db' }, running: false })],
      exact,
      alive,
    )
    assert.deepEqual(
      verdicts.map((v) => v.container.id),
      ['a'],
    )
  })
})

describe('ruleImages', () => {
  const rules = dockerRules({ docker: { images: [{ repository: 'fos-synthetic-.*-test', keep: 1 }] } }).images
  const image = (tag: string, created: string, repository = 'fos-synthetic-chrome-test'): Image => ({
    repository,
    tag,
    id: `sha256:${tag}`,
    created,
  })

  test('저장소마다 최근 keep 개와 컨테이너가 쓰는 것을 남기고 나머지를 지운다', () => {
    const verdicts = ruleImages(
      [
        image('old', '2026-11-01T00:00:00Z'),
        image('new', '2026-11-02T00:00:00Z'),
        image('used', '2026-10-30T00:00:00Z'),
        image('loop', '2026-10-01T00:00:00Z', 'fos-synthetic-loopback-test'),
        image('x', '2026-10-01T00:00:00Z', 'company-app'),
        image('<none>', '2026-10-01T00:00:00Z'),
      ],
      [box('c', 'runner', { image: 'sha256:used' })],
      rules,
    )
    assert.deepEqual(
      verdicts.map((v) => [v.image.tag, v.remove]),
      [
        ['new', false],
        ['old', true],
        ['used', false],
        ['loop', false],
      ],
    )
  })
})

describe('dockerCleanup', () => {
  test('워크트리 귀속 컨테이너를 익명 볼륨과 함께 지우고 프로젝트 네트워크를 지운다', () => {
    const { runner, calls } = fakeDocker({
      containers: [compose('a', 'feat-a', WT), compose('d', 'company', '/work/company')],
      networks: [{ id: 'n1', name: 'feat-a_default', project: 'feat-a' }],
    })
    const { lines, log } = collect()
    dockerCleanup({ worktrees: [WT], apply: true, log, runner })
    assert.ok(calls.some((c) => c.join(' ') === 'rm -f -v a'))
    assert.ok(!calls.some((c) => c[0] === 'rm' && c.includes('d')))
    assert.ok(calls.some((c) => c.join(' ') === 'network rm n1'))
    // 볼륨 명령은 부르지 않는다
    assert.ok(!calls.some((c) => c[0] === 'volume'))
    assert.deepEqual(lines, [
      `Docker 컨테이너 삭제 feat-a-a (a): compose working_dir 이 지운 워크트리 ${WT} 아래다`,
      'Docker 네트워크 삭제 feat-a_default: compose 프로젝트 feat-a',
    ])
  })

  test('같은 프로젝트 이름을 다른 체크아웃이 쓰면 네트워크를 남긴다', () => {
    const { runner, calls } = fakeDocker({
      containers: [compose('a', 'shared', WT), compose('b', 'shared', '/repo')],
      networks: [{ id: 'n1', name: 'shared_default', project: 'shared' }],
    })
    const { lines, log } = collect()
    dockerCleanup({ worktrees: [WT], apply: true, log, runner })
    assert.ok(!calls.some((c) => c[0] === 'network'))
    assert.match(lines[1], /^Docker 네트워크 남김 shared: .*shared-b/)
  })

  test('dry-run 은 지우지 않고 지울 것만 낸다', () => {
    const { runner, calls } = fakeDocker({
      containers: [box('a', 'mysql-migration-check-80925', { labels: { 'fos-assistant.temp': 'true' } })],
      images: [
        { repository: 'runner-test', tag: 'a', id: 'sha256:a', created: '2026-11-02T00:00:00Z' },
        { repository: 'runner-test', tag: 'b', id: 'sha256:b', created: '2026-11-01T00:00:00Z' },
      ],
    })
    const rules = dockerRules({ docker: { containers: [{ label: 'fos-assistant.temp', name: 'mysql-migration-check-(?<pid>\\d+)' }], images: [{ repository: 'runner-test' }] } })
    const { lines, log } = collect()
    dockerCleanup({ rules, apply: false, log, runner, alive: () => false })
    assert.ok(!calls.some((c) => c[0] === 'rm' || c.includes('rm')))
    assert.deepEqual(lines, [
      'Docker 컨테이너 지울 것 mysql-migration-check-80925 (a): 표식 fos-assistant.temp, 이름 mysql-migration-check-(?<pid>\\d+): 띄운 프로세스 80925 가 없다',
      'Docker 이미지 남김 runner-test:a: 저장소 runner-test 의 최근 1 개 안이다',
      'Docker 이미지 지울 것 runner-test:b: 규칙 runner-test: 최근 1 개 밖이고 쓰는 컨테이너가 없다',
    ])
  })

  test('지운 컨테이너가 쓰던 이미지는 쓰는 것으로 세지 않는다', () => {
    const { runner, calls } = fakeDocker({
      containers: [box('a', 'tmp', { labels: { temp: '1' }, running: false, image: 'sha256:b' })],
      images: [
        { repository: 'runner-test', tag: 'a', id: 'sha256:a', created: '2026-11-02T00:00:00Z' },
        { repository: 'runner-test', tag: 'b', id: 'sha256:b', created: '2026-11-01T00:00:00Z' },
      ],
    })
    const rules = dockerRules({ docker: { containers: [{ label: 'temp' }], images: [{ repository: 'runner-test' }] } })
    dockerCleanup({ rules, apply: true, log: () => {}, runner })
    assert.ok(calls.some((c) => c.join(' ') === 'image rm runner-test:b'))
  })

  test('삭제가 실패하면 남김 줄을 내고 이어 간다', () => {
    const state = { containers: [box('a', 'x', { labels: { temp: '1' }, running: false }), box('b', 'y', { labels: { temp: '1' }, running: false })] }
    const { runner } = fakeDocker(state)
    const failing: Runner = (args) => (args[0] === 'rm' && args.at(-1) === 'a' ? fail('Error: conflict') : runner(args))
    const { lines, log } = collect()
    dockerCleanup({ rules: dockerRules({ docker: { containers: [{ label: 'temp' }] } }), apply: true, log, runner: failing })
    assert.deepEqual(lines, ['Docker 컨테이너 남김 x (a): 삭제 실패 (Error: conflict)', 'Docker 컨테이너 삭제 y (b): 표식 temp: 멈춘 컨테이너'])
  })

  test('docker 가 없거나 데몬이 꺼져 있으면 경고 한 줄로 넘어간다', () => {
    for (const result of [fail('spawn docker ENOENT', 127), fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')]) {
      const { lines, log } = collect()
      dockerCleanup({ worktrees: [WT], apply: true, log, runner: () => result })
      assert.equal(lines.length, 1)
      assert.match(lines[0], /^Docker 정리 건너뜀: /)
    }
  })

  test('워크트리도 규칙도 없으면 docker 를 부르지 않는다', () => {
    const { runner, calls } = fakeDocker({ containers: [] })
    dockerCleanup({ apply: true, log: () => {}, runner })
    assert.deepEqual(calls, [])
  })
})
