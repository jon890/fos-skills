// queue.integration_tests 규칙이 있으면 `orch queue gate` 와 머지 큐가 바뀐 모듈의 통합 테스트 기록을 같은 이유로 확인하는지 본다.
// 가짜 gh 가 PR 본문과 바뀐 파일(REST pulls/<n>/files)을 흉내 낸다(tests/fixtures/merge-queue-fakes.ts).

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FAKE_GH, FAKE_GIT, HAS_TOOLS, spawnDone, writeNodeBin } from './fixtures/merge-queue-fakes.ts'
import type { Done } from './fixtures/merge-queue-fakes.ts'

const GATE_RUNNER = fileURLToPath(new URL('./fixtures/queue-gate-run.ts', import.meta.url))
const QUEUE_RUNNER = fileURLToPath(new URL('./fixtures/merge-queue-run.ts', import.meta.url))
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const RULES = { queue: { integration_tests: [{ paths: 'modules/<모듈>/src/main/**', command: './gradlew :<모듈>:integrationTest' }] } }

type Json = Record<string, unknown>
type Ctx = { tmp: string; env: NodeJS.ProcessEnv; writeState: (state: Json) => void }

let bindir = ''
before(() => {
  bindir = mkdtempSync(join(tmpdir(), 'queue-gate-it-bin-'))
  writeNodeBin(bindir, 'gh', FAKE_GH)
  writeNodeBin(bindir, 'git', FAKE_GIT)
  writeNodeBin(bindir, 'orca', `console.log(JSON.stringify({ok:true,result:process.argv.includes('run-current') ? {run:null} : {message:{id:'notice'}}}))`)
})
after(() => rmSync(bindir, { recursive: true, force: true }))

function setup(t: TestContext, config: Json | null = RULES): Ctx {
  const tmp = mkdtempSync(join(tmpdir(), 'queue-gate-it-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const stateFile = join(tmp, 'state.json')
  const sweep = join(tmp, 'sweep.py')
  writeFileSync(sweep, 'import sys\n')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    ORCA: join(bindir, 'orca'),
    NOTICE_LOG: join(tmp, 'notices.jsonl'),
    FAKE_STATE: stateFile,
    FAKE_LOG: join(tmp, 'log.txt'),
    FAKE_REMOTE_HEAD: HEAD,
    MERGE_QUEUE_FAKE_GIT: '1',
    MERGE_QUEUE_SLEEP_SCALE: '0',
    CLEANUP_SWEEP: sweep,
  }
  delete env.GH
  delete env.ORCH_DIR
  mkdirSync(join(tmp, '.orch'), { recursive: true })
  if (config) writeFileSync(join(tmp, '.orch', 'config.json'), JSON.stringify(config))
  return { tmp, env, writeState: (state) => writeFileSync(stateFile, JSON.stringify(state)) }
}

const FILES = [{ path: 'modules/core/src/main/A.kt' }, { path: 'modules/api/src/main/B.kt' }, { path: 'docs/a.md' }]
const record = (module: string, commit = HEAD) => `- 통합 테스트 통과: ${module} | ./gradlew :${module}:integrationTest | ${commit}`
const body = (...lines: string[]) => `## 변경\n본문\n\n## 검증\n${lines.join('\n')}\n`

function pr(over: Json = {}): Json {
  return {
    state: 'OPEN',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    mergeable: 'MERGEABLE',
    url: 'https://git.example.com/owner/repo/pull/1',
    headRefName: 'feat',
    baseRefName: 'main',
    headRefOid: HEAD,
    isCrossRepository: false,
    files: FILES,
    body: body(record('api'), record('core')),
    ...over,
  }
}

function gate(c: Ctx, state: Json): Promise<Done> {
  c.writeState(state)
  return spawnDone([process.execPath, GATE_RUNNER, '--repo', c.tmp, '--threads-cmd', 'echo 0', '1'], { env: c.env })
}

function queue(c: Ctx, state: Json): Promise<Done> {
  c.writeState(state)
  return spawnDone([process.execPath, QUEUE_RUNNER, '--repo', c.tmp, '--threads-cmd', 'echo 0', '--no-sweep', '--stop-on-hold', '1'], { env: c.env })
}

function both(r: Done): string {
  return `종료 코드 ${r.code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`
}

// 시각이 붙은 진행 줄을 뺀 출력 줄
function verdict(r: Done): string[] {
  return r.stdout.trim().split('\n').filter((line) => !/^\d\d:\d\d /.test(line))
}

function gateReason(r: Done): string {
  return r.stdout.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim()).join('; ')
}

describe('통합 테스트 기록 관문', { skip: !HAS_TOOLS && 'jq 와 bash 가 필요하다', concurrency: 4 }, () => {
  test('규칙이 없으면 바뀐 파일을 읽지 않고 지금처럼 GATE-OK 한 줄이다', async (t) => {
    const c = setup(t, null)
    const r = await gate(c, { '1': pr({ body: '' }) })
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(verdict(r), ['GATE-OK 1'])
    assert.doesNotMatch(readFileSync(c.env.FAKE_LOG!, 'utf8'), /\/files/)
  })

  test('바뀐 모듈마다 head 기록이 있으면 gate 가 통과하고 머지 큐가 머지한다', async (t) => {
    const c = setup(t)
    const g = await gate(c, { '1': pr() })
    assert.equal(g.code, 0, both(g))
    assert.deepEqual(verdict(g), ['GATE-OK 1'])
    const q = await queue(c, { '1': pr() })
    assert.equal(q.code, 0, both(q))
    assert.match(q.stdout, /1 MERGED/)
  })

  test('기록이 없거나 head 가 아니면 gate 와 머지 큐가 같은 이유로 막는다', async (t) => {
    const c = setup(t)
    const state = { '1': pr({ body: body(record('core', OLD)) }) }
    const g = await gate(c, state)
    assert.equal(g.code, 1, both(g))
    assert.equal(gateReason(g), '통합 테스트 기록 없음: api (./gradlew :api:integrationTest); 통합 테스트 기록이 head 가 아니다: core')
    const q = await queue(c, state)
    assert.equal(q.code, 1, both(q))
    assert.match(q.stdout, /통합 테스트 기록 없음: api \(\.\/gradlew :api:integrationTest\); 통합 테스트 기록이 head 가 아니다: core/)
    assert.doesNotMatch(readFileSync(c.env.FAKE_LOG!, 'utf8'), /pr merge/)
  })

  test('이유가 있는 생략 줄은 넘기고 gate 와 머지 출력에 보인다', async (t) => {
    const c = setup(t)
    const state = { '1': pr({ body: `${body(record('core'))}\n통합 테스트 생략: api 주석만 바꿨다\n` }) }
    const g = await gate(c, state)
    assert.equal(g.code, 0, both(g))
    assert.deepEqual(verdict(g), ['GATE-OK 1', '통합 테스트 생략 api: 주석만 바꿨다'])
    const q = await queue(c, state)
    assert.equal(q.code, 0, both(q))
    assert.match(q.stdout, /경고: 1 통합 테스트 생략 api: 주석만 바꿨다/)
    assert.match(q.stdout, /1 MERGED/)
  })

  test('이유가 빈 생략 줄은 생략으로 보지 않는다', async (t) => {
    const c = setup(t)
    const g = await gate(c, { '1': pr({ body: `${body(record('core'))}\n통합 테스트 생략: api\n` }) })
    assert.equal(g.code, 1, both(g))
    assert.equal(gateReason(g), '통합 테스트 기록 없음: api (./gradlew :api:integrationTest)')
  })

  test('규칙에 맞는 파일이 없으면 기록 없이 통과한다', async (t) => {
    const c = setup(t)
    const g = await gate(c, { '1': pr({ files: [{ path: 'docs/a.md' }], body: '' }) })
    assert.equal(g.code, 0, both(g))
  })

  test('목록에 든 모듈의 기록만 관문과 머지 큐에서 확인한다', async (t) => {
    const c = setup(t, { queue: { integration_tests: [{ ...RULES.queue.integration_tests[0], modules: ['core'] }] } })
    const missing = await gate(c, { '1': pr({ body: '' }) })
    assert.equal(missing.code, 1, both(missing))
    assert.equal(gateReason(missing), '통합 테스트 기록 없음: core (./gradlew :core:integrationTest)')

    const state = { '1': pr({ body: body(record('core')) }) }
    const g = await gate(c, state)
    assert.equal(g.code, 0, both(g))
    assert.deepEqual(verdict(g), ['GATE-OK 1'])
    const q = await queue(c, state)
    assert.equal(q.code, 0, both(q))
    assert.match(q.stdout, /1 MERGED/)

    const onlyOutside = await gate(c, { '1': pr({ files: [FILES[1]], body: '통합 테스트 생략: api 테스트가 없다' }) })
    assert.equal(onlyOutside.code, 0, both(onlyOutside))
    assert.deepEqual(verdict(onlyOutside), ['GATE-OK 1'])
  })

  test('이름을 바꾼 파일은 옛 경로의 모듈도 기록이 필요하다', async (t) => {
    const c = setup(t)
    const files = [{ path: 'modules/api/src/main/A.kt', previous: 'modules/core/src/main/A.kt' }]
    const g = await gate(c, { '1': pr({ files, body: body(record('api')) }) })
    assert.equal(g.code, 1, both(g))
    assert.equal(gateReason(g), '통합 테스트 기록 없음: core (./gradlew :core:integrationTest)')
  })

  test('규칙 꼴이 틀리면 사용법 오류(2)다', async (t) => {
    const c = setup(t, { queue: { integration_tests: [{ paths: 'modules/**', command: 'x' }] } })
    const g = await gate(c, { '1': pr() })
    assert.equal(g.code, 2, both(g))
    assert.match(g.stderr, /queue\.integration_tests\[0\]\.paths 에는 <모듈> 가 꼭 하나/)
  })

  test('바뀐 파일을 읽지 못하면 통과로 보지 않는다', async (t) => {
    const c = setup(t)
    const g = await gate(c, { '1': pr({ files_fail: true }) })
    assert.equal(g.code, 1, both(g))
    assert.equal(gateReason(g), '통합 테스트 대상 파일 조회 실패')
  })
})
