// `orch queue gate`(queue/gate.ts)가 머지 큐와 같은 조건을 같은 이유로 판정하는지 본다.
// 가짜 gh, git 은 merge-queue.spec.ts 와 같은 것을 쓴다(tests/fixtures/merge-queue-fakes.ts).

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gateLines } from '../scripts/queue/gate.ts'
import { FAKE_GH, FAKE_GIT, HAS_TOOLS, spawnDone, writeNodeBin } from './fixtures/merge-queue-fakes.ts'
import type { Done } from './fixtures/merge-queue-fakes.ts'

const GATE_RUNNER = fileURLToPath(new URL('./fixtures/queue-gate-run.ts', import.meta.url))
const QUEUE_RUNNER = fileURLToPath(new URL('./fixtures/merge-queue-run.ts', import.meta.url))
const HEAD = 'a'.repeat(40)

type Json = Record<string, unknown>
type Ctx = { tmp: string; env: NodeJS.ProcessEnv; writeState: (state: Json) => void }

let bindir = ''
before(() => {
  bindir = mkdtempSync(join(tmpdir(), 'queue-gate-bin-'))
  writeNodeBin(bindir, 'gh', FAKE_GH)
  writeNodeBin(bindir, 'git', FAKE_GIT)
  writeNodeBin(bindir, 'orca', `const fs = require('node:fs'); console.log(JSON.stringify({ok:true,result:{message:{id:'notice'}}}))`)
})
after(() => rmSync(bindir, { recursive: true, force: true }))

function setup(t: TestContext): Ctx {
  const tmp = mkdtempSync(join(tmpdir(), 'queue-gate-'))
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
  // 기능 PR 로 읽히는 지시서. 근거 블록이 필요한 PR 이 된다
  mkdirSync(join(tmp, '.orch', 'specs'), { recursive: true })
  writeFileSync(join(tmp, '.orch', 'specs', 'feature.md'), '브랜치: `feat`\n## 할 일\n루프를 쓴다(스펙: 새로 쓴다)\n')
  return { tmp, env, writeState: (state) => writeFileSync(stateFile, JSON.stringify(state)) }
}

const BLOCK = `<!-- fos-feature-evidence -->
검증 커밋: ${HEAD}
인수 검증: 통과 | REQ1 실행 기록
문서 대조: 통과 | 설계 대조
독립 리뷰: 통과 | 독립 리뷰 결과 링크
후속 검증: 없음 | 배포 대상 없는 도구 변경
<!-- /fos-feature-evidence -->`

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
    body: BLOCK,
    ...over,
  }
}

const FAILED = [{ status: 'COMPLETED', conclusion: 'FAILURE' }]

function gate(c: Ctx, state: Json, threads: number | string, extra: string[] = []): Promise<Done> {
  c.writeState(state)
  return spawnDone([process.execPath, GATE_RUNNER, '--repo', c.tmp, '--threads-cmd', `echo ${threads}`, ...extra, '1'], { env: c.env })
}

function queue(c: Ctx, state: Json, threads: number | string): Promise<Done> {
  c.writeState(state)
  return spawnDone([process.execPath, QUEUE_RUNNER, '--repo', c.tmp, '--threads-cmd', `echo ${threads}`, '--no-sweep', '--stop-on-hold', '1'], { env: c.env })
}

function both(r: Done): string {
  return `종료 코드 ${r.code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`
}

// 판정 줄 다음의 이유 줄을 `; ` 로 이은 것
function gateReason(r: Done): string {
  return r.stdout.split('\n').slice(1).filter((line) => line.startsWith('  ')).map((line) => line.trim()).join('; ')
}

// 큐가 낸 첫 STOP 이나 CONFLICT 줄의 이유
function queueReason(r: Done): string {
  const line = r.stdout.split('\n').find((l) => /^(STOP|CONFLICT) 1 /.test(l))
  assert.ok(line, `STOP 이나 CONFLICT 줄이 없다:\n${both(r)}`)
  return line.replace(/^(STOP|CONFLICT) 1 /, '')
}

describe('orch queue gate', { skip: !HAS_TOOLS && 'jq 와 bash 가 필요하다', concurrency: 4 }, () => {
  test('통과하면 GATE-OK 한 줄과 종료 코드 0 이다', async (t) => {
    const c = setup(t)
    const r = await gate(c, { '1': pr() }, 0)
    assert.equal(r.code, 0, both(r))
    assert.equal(r.stdout.trim().split('\n').filter((line) => /^GATE-/.test(line)).join('\n'), 'GATE-OK 1')
  })

  test('걸리면 GATE-FAIL 과 이유를 한 줄씩 내고 종료 코드 1 이다. 이유는 모두 모은다', async (t) => {
    const c = setup(t)
    const r = await gate(c, { '1': pr({ statusCheckRollup: FAILED, body: '<!-- fos-feature-evidence -->' }) }, 2)
    assert.equal(r.code, 1, both(r))
    const lines = r.stdout.trim().split('\n').filter((line) => /^GATE-|^ {2}\S/.test(line))
    assert.deepEqual(lines, [
      'GATE-FAIL 1',
      '  실패한 체크 1 개',
      '  미해결 리뷰 스레드 2 개',
      '  기능 완료 근거 블록이 하나 필요하다',
    ])
  })

  test('독립 리뷰 줄이 대기면 걸린다', async (t) => {
    const c = setup(t)
    const r = await gate(c, { '1': pr({ body: BLOCK.replace('독립 리뷰: 통과', '독립 리뷰: 대기') }) }, 0)
    assert.equal(r.code, 1, both(r))
    assert.match(gateReason(r), /독립 리뷰 이 완료되지 않았다: 대기/)
  })

  test('진행 중인 체크는 기다리지 않고 걸린다', async (t) => {
    const c = setup(t)
    const r = await gate(c, { '1': pr({ statusCheckRollup: [{ status: 'IN_PROGRESS' }] }) }, 0)
    assert.equal(r.code, 1, both(r))
    assert.match(gateReason(r), /체크가 아직 끝나지 않았다\(진행 중 1/)
  })

  test('PR 을 읽지 못하거나 이미 MERGED 이면 통과로 보지 않는다', async (t) => {
    const c = setup(t)
    let r = await gate(c, { '1': pr({ state: 'MERGED' }) }, 0)
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /GATE-FAIL 1\n {2}이미 MERGED/)
    r = await gate(c, { '1': pr({ state: 'CLOSED' }) }, 0)
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /GATE-FAIL 1\n {2}state=CLOSED/)
  })

  test('PR 을 하나만 받는다', async (t) => {
    const c = setup(t)
    c.writeState({ '1': pr() })
    for (const args of [['1', '2'], ['1:echo hi']]) {
      const r = await spawnDone([process.execPath, GATE_RUNNER, '--repo', c.tmp, '--threads-cmd', 'echo 0', ...args], { env: c.env })
      assert.equal(r.code, 2, both(r))
      assert.equal(r.stdout, '')
    }
  })

  test('머지 큐와 같은 입력에서 같은 이유를 낸다', async (t) => {
    const cases: { name: string; state: Json; threads: number }[] = [
      { name: '스레드', state: { '1': pr() }, threads: 2 },
      { name: '근거 블록', state: { '1': pr({ body: '<!-- fos-feature-evidence -->' }) }, threads: 0 },
      { name: '스레드와 근거 블록', state: { '1': pr({ body: '<!-- fos-feature-evidence -->' }) }, threads: 1 },
      { name: '독립 리뷰 대기와 스레드', state: { '1': pr({ body: BLOCK.replace('독립 리뷰: 통과', '독립 리뷰: 대기') }) }, threads: 3 },
      { name: '오래된 검증 커밋', state: { '1': pr({ body: BLOCK.replace(HEAD, 'b'.repeat(40)) }) }, threads: 0 },
      { name: '실패한 체크와 스레드와 근거 블록', state: { '1': pr({ statusCheckRollup: FAILED, body: '' }) }, threads: 1 },
      { name: '충돌과 스레드', state: { '1': pr({ mergeable: 'CONFLICTING' }) }, threads: 1 },
    ]
    for (const { name, state, threads } of cases) {
      const c = setup(t)
      const g = await gate(c, state, threads)
      const q = await queue(c, state, threads)
      assert.equal(g.code, 1, `${name}\n${both(g)}`)
      assert.equal(q.code, 1, `${name}\n${both(q)}`)
      assert.equal(gateReason(g), queueReason(q), `${name}\ngate:\n${both(g)}\nqueue:\n${both(q)}`)
    }
  })

  test('머지 큐가 머지하는 PR 은 gate 도 통과시킨다', async (t) => {
    const c = setup(t)
    const g = await gate(c, { '1': pr() }, 0)
    assert.equal(g.code, 0, both(g))
    const q = await queue(c, { '1': pr() }, 0)
    assert.equal(q.code, 0, both(q))
    assert.match(q.stdout, /1 MERGED/)
  })

  test('gateLines 는 이유가 없으면 한 줄, 있으면 판정 줄과 이유 줄이다', () => {
    assert.deepEqual(gateLines('7', []), ['GATE-OK 7'])
    assert.deepEqual(gateLines('7', [{ kind: 'ci', text: 'a' }, { kind: 'threads', text: 'b' }]), ['GATE-FAIL 7', '  a', '  b'])
  })
})
