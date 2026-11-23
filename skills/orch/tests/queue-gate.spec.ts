// `orch queue gate`(queue/gate.ts)가 머지 큐와 같은 조건을 같은 이유로 판정하는지 본다.
// 가짜 gh, git 은 merge-queue.spec.ts 와 같은 것을 쓴다(tests/fixtures/merge-queue-fakes.ts).

import assert from 'node:assert/strict'
import { HEAD_MISMATCH, verifiedPlan, verifiedPlanEvidence } from './fixtures/verified-plan.ts'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gateLines } from '../scripts/queue/gate.ts'
import { FAKE_GH, FAKE_GIT, HAS_TOOLS, spawnDone, writeNodeBin } from './fixtures/merge-queue-fakes.ts'
import type { Done } from './fixtures/merge-queue-fakes.ts'
import { BOT, BOT_SETTING, receipt } from './fixtures/codex-review.ts'

import { copyRepo, git as templateGit } from '../../../modules/testkit/git.ts'

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
  writeNodeBin(bindir, 'orca', `const fs = require('node:fs'); console.log(JSON.stringify({ok:true,result:process.argv.includes('run-current') ? {run:null} : {message:{id:'notice'}}}))`)
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

for (const extraChange of [false, true]) {
  test(`관문의 계획 삭제 검증 (계획 밖 변경 ${extraChange})`, { skip: !HAS_TOOLS }, async (t) => {
    const c = setup(t)
    const repo = copyRepo(join(c.tmp, 'repo')).dir
    c.env.PATH = process.env.PATH
    c.env.GH = join(bindir, 'gh')
    delete c.env.MERGE_QUEUE_FAKE_GIT
    templateGit(repo, ['switch', '-qc', 'feat'])
    const { verified, head } = verifiedPlan(repo, extraChange)
    templateGit(repo, ['push', '-qu', 'origin', 'feat'])
    const result = await gate({ ...c, tmp: repo }, { '1': pr({ headRefOid: head, body: verifiedPlanEvidence(verified) }) }, 0)
    assert.equal(result.code, extraChange ? 1 : 0, both(result))
    assert.ok(result.stdout.includes(extraChange ? HEAD_MISMATCH : 'GATE-OK 1'), both(result))
  })
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

  for (const line of ['머지 보류: real 확인 전', '- **머지 보류:** real 확인 전', '머지 보류:']) {
    test(`보류 줄이 있으면 gate 는 안내하고 merge 는 거절한다: ${line}`, async (t) => {
      const c = setup(t)
      writeFileSync(join(c.tmp, '.orch', 'specs', 'spec-hold.md'), `브랜치: \`feat\`\n${line}\n`)
      for (const invoke of [gate, queue]) {
        const r = await invoke(c, { '1': pr() }, 0)
        assert.equal(r.code, invoke === gate ? 0 : 1, both(r))
        assert.match(r.stdout, invoke === gate ? /^HOLD (real 확인 전|이유 없음)$/m : /GATE-HOLD (real 확인 전|이유 없음)/)
        if (invoke === gate) assert.match(r.stdout, /^GATE-OK 1$/m)
        assert.doesNotMatch(readFileSync(c.env.FAKE_LOG!, 'utf8'), /pr merge/)
      }
    })
  }

  test('PR 본문에만 보류 줄이 있어도 gate 는 안내하고 merge 는 거절한다', async (t) => {
    const c = setup(t)
    const body = `${BLOCK}\n\n- 머지 보류: 본문의 배포 대기\n`
    const g = await gate(c, { '1': pr({ body }) }, 0)
    assert.equal(g.code, 0, both(g))
    assert.match(g.stdout, /^GATE-OK 1$/m)
    assert.match(g.stdout, /^HOLD 본문의 배포 대기$/m)
    const q = await queue(c, { '1': pr({ body }) }, 0)
    assert.equal(q.code, 1, both(q))
    assert.match(q.stdout, /GATE-HOLD 본문의 배포 대기/)
    assert.doesNotMatch(readFileSync(c.env.FAKE_LOG!, 'utf8'), /pr merge/)
  })

  test('지시서 보류가 본문 보류보다 먼저고 둘 다 없으면 보류 줄이 없다', async (t) => {
    const c = setup(t)
    writeFileSync(join(c.tmp, '.orch', 'specs', 'spec-hold.md'), '브랜치: `feat`\n머지 보류: 지시서 이유\n')
    const both2 = await gate(c, { '1': pr({ body: `${BLOCK}\n- 머지 보류: 본문 이유\n` }) }, 0)
    assert.match(both2.stdout, /^HOLD 지시서 이유$/m)
    assert.doesNotMatch(both2.stdout, /본문 이유/)
    const c2 = setup(t)
    const none = await gate(c2, { '1': pr() }, 0)
    assert.doesNotMatch(none.stdout, /^HOLD /m)
  })

  test('앞 Run 의 지시서 보류를 gate 와 merge 가 함께 따른다', async (t) => {
    const c = setup(t)
    const state = join(c.tmp, '.orch', 'state', 'loop-runs')
    mkdirSync(state, { recursive: true })
    for (const [run, hold] of [['first', '먼저 등록한 Run'], ['later', '나중 Run']]) {
      const dir = join(c.tmp, run)
      mkdirSync(dir)
      writeFileSync(join(dir, 'spec-hold.md'), `브랜치: \`feat\`\n머지 보류: ${hold}\n`)
      writeFileSync(join(state, `${run}.json`), JSON.stringify({ run, specs_dir: dir, registered_at: run === 'first' ? '2026-01-01' : '2026-01-02' }))
    }
    for (const invoke of [gate, queue]) {
      const r = await invoke(c, { '1': pr() }, 0)
      assert.equal(r.code, invoke === gate ? 0 : 1, both(r))
      assert.match(r.stdout, invoke === gate ? /^HOLD 먼저 등록한 Run$/m : /GATE-HOLD 먼저 등록한 Run/)
    }
  })

  test('설정한 지시서 폴더도 gate 와 merge 가 확인한다', async (t) => {
    const c = setup(t)
    mkdirSync(join(c.tmp, 'custom-specs'))
    writeFileSync(join(c.tmp, '.orch', 'config.json'), JSON.stringify({ finish: { specs_dir: 'custom-specs' } }))
    writeFileSync(join(c.tmp, 'custom-specs', 'spec-hold.md'), '브랜치: `feat`\n머지 보류: 백업 대기\n')
    for (const invoke of [gate, queue]) {
      const r = await invoke(c, { '1': pr() }, 0)
      assert.equal(r.code, invoke === gate ? 0 : 1, both(r))
      assert.match(r.stdout, invoke === gate ? /^HOLD 백업 대기$/m : /GATE-HOLD 백업 대기/)
    }
  })

  test('워크트리에서도 주 checkout 의 상대경로 지시서를 찾는다', async (t) => {
    const c = setup(t)
    const root = c.tmp
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    git('init', '-q', '--initial-branch=main')
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init')
    const worktree = join(root, 'linked-worktree')
    git('worktree', 'add', '--detach', worktree, 'HEAD')
    mkdirSync(join(root, 'custom-specs'))
    writeFileSync(join(root, '.orch', 'config.json'), JSON.stringify({ finish: { specs_dir: 'custom-specs' } }))
    writeFileSync(join(root, 'custom-specs', 'spec-hold.md'), '브랜치: `feat`\n머지 보류: 주 checkout 의 확인 대기\n')
    // gh 는 함수 가짜로 두고 git 은 실제 임시 저장소를 읽게 한다.
    c.env.PATH = process.env.PATH
    c.env.MERGE_QUEUE_FAKE_GIT = '0'
    c.tmp = worktree
    for (const invoke of [gate, queue]) {
      const r = await invoke(c, { '1': pr() }, 0)
      assert.equal(r.code, invoke === gate ? 0 : 1, both(r))
      assert.match(r.stdout, invoke === gate ? /^HOLD 주 checkout 의 확인 대기$/m : /GATE-HOLD 주 checkout 의 확인 대기/)
    }
  })

  test('보류 중에도 CI 와 미해결 스레드 이유를 모두 내고 실패한다', async (t) => {
    const c = setup(t)
    writeFileSync(join(c.tmp, '.orch', 'specs', 'spec-hold.md'), '브랜치: `feat`\n머지 보류: 배포 대기\n')
    const r = await gate(c, { '1': pr({ statusCheckRollup: FAILED }) }, 2)
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /^GATE-FAIL 1$/m)
    assert.match(r.stdout, /실패한 체크 1 개/)
    assert.match(r.stdout, /미해결 리뷰 스레드 2 개/)
    assert.match(r.stdout, /^HOLD 배포 대기$/m)
  })

  test('다른 브랜치의 보류 줄은 gate 와 merge 를 막지 않는다', async (t) => {
    const c = setup(t)
    writeFileSync(join(c.tmp, '.orch', 'specs', 'spec-other.md'), '브랜치: `other`\n머지 보류: 다른 작업\n')
    for (const invoke of [gate, queue]) {
      const r = await invoke(c, { '1': pr() }, 0)
      assert.equal(r.code, 0, both(r))
      assert.doesNotMatch(r.stdout, /GATE-HOLD/)
    }
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

  test('리뷰 설정이 있으면 HEAD 의 리뷰 판정이 필요하다', async (t) => {
    const c = setup(t)
    writeFileSync(join(c.tmp, '.orch', 'config.json'), JSON.stringify({ queue: { auto_review: { pass: 'PASS', block: 'BLOCK', require: ['verdict-on-head'] } } }))
    const r = await gate(c, { '1': pr({ reviews: [], comments: [] }) }, 0)
    assert.equal(r.code, 1, both(r))
    assert.match(r.stdout, /GATE-FAIL 1/)
    assert.match(gateReason(r), /HEAD aaaaaaaa 에 리뷰 판정이 없다/)
    const passed = await gate(c, { '1': pr({ reviews: [{ body: 'PASS', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: HEAD } }], comments: [] }) }, 0)
    assert.equal(passed.code, 0, both(passed))
  })

  test('믿는 봇 영수증을 뒤 페이지까지 읽고 require 의 pass 로 센다', async (t) => {
    const c = setup(t)
    const auto_review = { pass: 'PASS', block: 'BLOCK', trusted_bots: [BOT_SETTING],
      require: ['verdict-seen', 'last-verdict-pass', 'rereview-after-block'] }
    writeFileSync(join(c.tmp, '.orch', 'config.json'), JSON.stringify({ queue: { auto_review } }))
    const priorBlock = { body: 'BLOCK', submittedAt: '2026-01-01T00:01:00Z', commit: { oid: HEAD } }
    const r = await gate(c, { '1': pr({ reviews: [priorBlock], comments: [],
      bot_review: { split: 'comments', comments: [receipt(HEAD)] },
    }), _log_rows: [`${HEAD}\t\t2026-01-01T00:00:00Z`] }, 0)
    assert.equal(r.code, 0, both(r))
    assert.match(r.stdout, /^GATE-OK 1$/m)
  })

  test('믿는 봇을 설정해도 기존 판정 문구로 통과할 수 있고 봇 지적이나 조회 실패는 머지를 막는다', async (t) => {
    const c = setup(t)
    const auto_review = { pass: 'PASS', block: 'BLOCK', trusted_bots: [BOT_SETTING] }
    writeFileSync(join(c.tmp, '.orch', 'config.json'), JSON.stringify({ queue: { auto_review } }))
    const reviews = [{ body: 'PASS', submittedAt: '2026-01-01T00:02:00Z', commit: { oid: HEAD } }]
    const cases = [
      { data: {}, reason: null },
      { data: undefined, reason: /스레드를 읽지 못했다/ },
      { data: { headRefOid: 'b'.repeat(40) }, reason: /PR HEAD 가 바뀌었다/ },
      { data: { reviewThreads: [{ isResolved: false, comments: { nodes: [{ author: BOT, createdAt: '2026-01-01T00:01:00Z' }] } }] },
        reason: /봇의 미해결 줄 댓글 스레드/ },
    ]
    for (const { data, reason } of cases) {
      const r = await gate(c, { '1': pr({ reviews, comments: [], bot_review: data }) }, 0)
      assert.equal(r.code, reason ? 1 : 0, both(r))
      if (reason) assert.match(gateReason(r), reason)
    }
    const missing = await gate(c, { '1': pr({ reviews: [], comments: [], bot_review: {} }) }, 0)
    assert.match(gateReason(missing), /리뷰 판정 문구나 현재 HEAD 를 확인한 봇 영수증이 없다/)
  })

  test('기능 PR 은 설정에 HEAD 조건이 없어도 현재 HEAD 의 판정이 필요하다', async (t) => {
    const c = setup(t)
    writeFileSync(join(c.tmp, '.orch', 'config.json'), JSON.stringify({ queue: { auto_review: { pass: 'PASS', block: 'BLOCK', require: ['last-verdict-pass'] } } }))
    const r = await gate(c, { '1': pr({ reviews: [{ body: 'PASS', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: 'b'.repeat(40) } }], comments: [] }) }, 0)
    assert.equal(r.code, 1, both(r))
    assert.match(gateReason(r), /HEAD aaaaaaaa 에 리뷰 판정이 없다/)
  })

  test('리뷰 설정이 없으면 리뷰 없이 통과한다', async (t) => {
    const c = setup(t)
    const r = await gate(c, { '1': pr({ reviews: [], comments: [] }) }, 0)
    assert.equal(r.code, 0, both(r))
  })

  test('머지 큐와 gate 는 이전 HEAD 와 보류 판정을 막는다', async (t) => {
    const c = setup(t)
    writeFileSync(join(c.tmp, '.orch', 'config.json'), JSON.stringify({ queue: { auto_review: { pass: 'PASS', block: 'BLOCK' } } }))
    for (const [body, oid, reason] of [['PASS', 'b'.repeat(40), '리뷰 판정이 없다'], ['BLOCK', HEAD, '리뷰 보류']]) {
      const state = { '1': pr({ reviews: [{ body, submittedAt: '2026-01-01T00:00:00Z', commit: { oid } }], comments: [] }) }
      const g = await gate(c, state, 0)
      const q = await queue(c, state, 0)
      assert.equal(g.code, 1, both(g))
      assert.equal(q.code, 1, both(q))
      assert.match(gateReason(g), new RegExp(reason))
      assert.equal(gateReason(g), queueReason(q))
    }
  })

  describe('block 을 반영한 PR(fixed_after_block)', () => {
    const REVIEWED = 'b'.repeat(40)
    const rows = [`${HEAD}\t${REVIEWED}\t2026-01-02T00:00:00Z`, `${REVIEWED}\t\t2026-01-01T00:00:00Z`]
    const review = (commit: string) => ({ id: 'PRR_1', body: 'BLOCK', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: commit } })
    const config = (c: Ctx, over: Json = {}) =>
      writeFileSync(join(c.tmp, '.orch', 'config.json'), JSON.stringify({ queue: { auto_review: { pass: 'PASS', block: 'BLOCK', require: ['verdict-seen', 'last-verdict-pass', 'rereview-after-block'], feature_head: false, ...over } } }))

    test('block 뒤 새 커밋이 있고 스레드가 0 이면 통과하고 REVIEW-FIXED 줄을 낸다', async (t) => {
      const c = setup(t)
      config(c, { fixed_after_block: true })
      const r = await gate(c, { '1': pr({ reviews: [review(REVIEWED)], comments: [] }), _log_rows: rows }, 0)
      assert.equal(r.code, 0, both(r))
      assert.deepEqual(r.stdout.trim().split('\n').filter((line) => /^(GATE-|REVIEW-FIXED)/.test(line)), ['GATE-OK 1', `REVIEW-FIXED PRR_1 ${REVIEWED.slice(0, 8)}..${HEAD.slice(0, 8)}`])
    })

    test('미해결 스레드가 남으면 막고 REVIEW-FIXED 줄을 내지 않는다', async (t) => {
      const c = setup(t)
      config(c, { fixed_after_block: true })
      const r = await gate(c, { '1': pr({ reviews: [review(REVIEWED)], comments: [] }), _log_rows: rows }, 2)
      assert.equal(r.code, 1, both(r))
      assert.match(gateReason(r), /미해결 리뷰 스레드 2 개/)
      assert.doesNotMatch(r.stdout, /REVIEW-FIXED/)
    })

    test('block 뒤 커밋이 없으면 리뷰 보류로 막는다', async (t) => {
      const c = setup(t)
      config(c, { fixed_after_block: true })
      const r = await gate(c, { '1': pr({ reviews: [review(HEAD)], comments: [] }), _log_rows: [`${HEAD}\t\t2026-01-02T00:00:00Z`] }, 0)
      assert.equal(r.code, 1, both(r))
      assert.match(gateReason(r), /리뷰 보류/)
    })

    test('설정을 켜지 않으면 지금처럼 막는다', async (t) => {
      const c = setup(t)
      config(c)
      const r = await gate(c, { '1': pr({ reviews: [review(REVIEWED)], comments: [] }), _log_rows: rows }, 0)
      assert.equal(r.code, 1, both(r))
      assert.match(gateReason(r), /리뷰 보류/)
    })
  })

  test('모르는 리뷰 조건은 gate 를 막는다', async (t) => {
    const c = setup(t)
    writeFileSync(join(c.tmp, '.orch', 'config.json'), JSON.stringify({ queue: { auto_review: { pass: 'PASS', block: 'BLOCK', require: ['unknown'] } } }))
    const r = await gate(c, { '1': pr({ reviews: [], comments: [] }) }, 0)
    assert.equal(r.code, 1, both(r))
    assert.match(gateReason(r), /모르는 조건/)
  })

  test('같은 이름 체크의 이전 실패보다 새 통과를 센다', async (t) => {
    const c = setup(t)
    const checks = [
      { name: 'Tests', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-01-01T00:00:00Z' },
      { name: 'Tests', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-01-01T01:00:00Z' },
    ]
    const r = await gate(c, { '1': pr({ statusCheckRollup: checks }) }, 0)
    assert.equal(r.code, 0, both(r))
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

  test('--wait 는 필수 체크가 늦게 붙어도 기다린 뒤 관문을 확인한다', async (t) => {
    const c = setup(t)
    const completed = (name: string) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })
    const state = { '1': pr({ statusCheckRollup: [completed('label')], appear: { left: 12, checks: [completed('Tests')] } }) }
    const required = ['--required-check', 'Tests']
    const immediate = await gate(c, state, 0, required)
    assert.equal(immediate.code, 1, both(immediate))
    assert.match(gateReason(immediate), /나타나지 않은 필수 체크 Tests/)

    const waited = await gate(c, state, 0, [...required, '--wait'])
    assert.equal(waited.code, 0, both(waited))
    assert.match(waited.stdout, /^GATE-OK 1$/m)
  })

  test('--wait 는 늦게 붙는 필수 체크의 대기 한도를 지키고 다른 이유도 알린다', async (t) => {
    const c = setup(t)
    const r = await gate(c, { '1': pr() }, 2, ['--wait', '--missing-timeout', '1', '--required-check', 'Tests'])
    assert.equal(r.code, 1, both(r))
    assert.match(gateReason(r), /필수 체크가 1분째 나타나지 않는다.*Tests/)
    assert.match(gateReason(r), /미해결 리뷰 스레드 2 개/)
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

  test('설정 파일의 queue.required 를 머지 큐와 같은 길로 읽는다', async (t) => {
    const c = setup(t)
    writeFileSync(join(c.tmp, '.orch', 'config.json'), JSON.stringify({ queue: { required: ['Tests'] } }))
    // 필수 체크 Tests 가 없는 PR 은 통과시키지 않는다
    let r = await gate(c, { '1': pr() }, 0)
    assert.equal(r.code, 1, both(r))
    assert.match(gateReason(r), /나타나지 않은 필수 체크 Tests/)
    // Tests 가 끝난 PR 은 통과한다
    r = await gate(c, { '1': pr({ statusCheckRollup: [{ name: 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS' }] }) }, 0)
    assert.equal(r.code, 0, both(r))
    // 명령줄의 --required-check 가 설정보다 우선한다
    r = await gate(c, { '1': pr({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }) }, 0, ['--required-check', 'ci'])
    assert.equal(r.code, 0, both(r))
  })

  test('설정 파일의 queue 절이 잘못되면 사용법 오류다', async (t) => {
    const c = setup(t)
    writeFileSync(join(c.tmp, '.orch', 'config.json'), JSON.stringify({ queue: { required: 5 } }))
    const r = await gate(c, { '1': pr() }, 0)
    assert.equal(r.code, 2, both(r))
    assert.equal(r.stdout, '')
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

  // 가상 낱말만 쓴다. 실제 목록(~/.config/orch/private-words.txt)은 읽지 않는다
  describe('비공개 낱말', () => {
    const WORD = 'example-secret'
    function withWords(c: Ctx): Ctx {
      const home = join(c.tmp, 'home')
      mkdirSync(join(home, '.config', 'orch'), { recursive: true })
      writeFileSync(join(home, '.config', 'orch', 'private-words.txt'), `# 가상 목록\n\n${WORD}\n`)
      c.env.ORCH_PRIVATE_WORDS = join(home, '.config', 'orch', 'private-words.txt')
      c.env.ORCH_MACHINE_DIR = join(c.tmp, 'machine')
      return c
    }

    test('본문과 댓글에 낱말이 있으면 GATE-FAIL 이고 위치만 알린다', async (t) => {
      const c = withWords(setup(t))
      const state = { '1': pr({
        body: `${BLOCK}\n배경: /srv/${WORD}/data\n`,
        issue_comments: [{ id: 11, body: '괜찮은 댓글' }, { id: 12, body: `경로는 ${WORD.toUpperCase()} 다` }],
        reviews_rest: [{ id: 21, body: null }],
        review_comments: [{ id: 31, body: `첫 줄\n${WORD}` }],
      }) }
      const g = await gate(c, state, 0)
      assert.equal(g.code, 1, both(g))
      assert.match(g.stdout, /^GATE-FAIL 1$/m)
      const reason = gateReason(g)
      assert.match(reason, /PR 본문 8번째 줄\(목록 3번째 줄\)/)
      assert.match(reason, /일반 댓글 12 1번째 줄/)
      assert.match(reason, /코드 줄 댓글 31 2번째 줄/)
      assert.doesNotMatch(reason, /일반 댓글 11/)
      assert.ok(!`${g.stdout}${g.stderr}`.toLowerCase().includes(WORD), both(g))
      const q = await queue(c, state, 0)
      assert.equal(q.code, 1, both(q))
      assert.ok(!`${q.stdout}${q.stderr}`.toLowerCase().includes(WORD), both(q))
      assert.doesNotMatch(readFileSync(c.env.FAKE_LOG!, 'utf8'), /pr merge/)
    })

    test('낱말이 없거나 비공개 저장소거나 목록이 없으면 통과한다', async (t) => {
      const clean = await gate(withWords(setup(t)), { '1': pr({ issue_comments: [{ id: 1, body: '문제 없음' }] }) }, 0)
      assert.equal(clean.code, 0, both(clean))
      const hidden = await gate(withWords(setup(t)), { '1': pr({ body: `${BLOCK}\n${WORD}\n` }), _visibility: 'PRIVATE' }, 0)
      assert.equal(hidden.code, 0, both(hidden))
      const c = setup(t)
      c.env.ORCH_PRIVATE_WORDS = join(c.tmp, 'empty-home', 'private-words.txt')
      c.env.ORCH_MACHINE_DIR = join(c.tmp, 'machine')
      const none = await gate(c, { '1': pr({ body: `${BLOCK}\n${WORD}\n` }) }, 0)
      assert.equal(none.code, 0, both(none))
      assert.doesNotMatch(readFileSync(c.env.FAKE_LOG!, 'utf8'), /repo view|issues\/1\/comments/)
    })

    test('공개 여부를 읽지 못하면 공개로 보고, 댓글을 읽지 못하면 조회 실패다', async (t) => {
      const unknown = await gate(withWords(setup(t)), { '1': pr({ body: `${BLOCK}\n${WORD}\n` }), _visibility_fails: true }, 0)
      assert.equal(unknown.code, 1, both(unknown))
      assert.match(gateReason(unknown), /PR 본문 8번째 줄/)
      const failed = await gate(withWords(setup(t)), { '1': pr({ comments_fail: true }) }, 0)
      assert.equal(failed.code, 1, both(failed))
      assert.match(gateReason(failed), /비공개 낱말 검사: 일반 댓글, 리뷰, 코드 줄 댓글 조회 실패/)
    })

    test('본문에서 옮긴 다른 이유 줄의 낱말도 가린다', async (t) => {
      const c = withWords(setup(t))
      const body = BLOCK.replace('인수 검증: 통과 | REQ1 실행 기록', `인수 검증: 대기 | ${WORD} 서버에서 확인`)
      const g = await gate(c, { '1': pr({ body }), _visibility: 'PRIVATE' }, 0)
      assert.equal(g.code, 1, both(g))
      assert.match(gateReason(g), /\*\*\*/)
      assert.ok(!g.stdout.toLowerCase().includes(WORD), both(g))
    })

    test('보류 이유에 낱말이 있으면 값 대신 위치를 쓴다', async (t) => {
      const c = withWords(setup(t))
      const body = `${BLOCK}\n\n- 머지 보류: ${WORD} 서버 확인 전\n`
      const g = await gate(c, { '1': pr({ body }), _visibility: 'PRIVATE' }, 0)
      assert.equal(g.code, 0, both(g))
      assert.match(g.stdout, /^HOLD 비공개 낱말이 있어 값을 생략한다\(PR 본문 9번째 줄\)$/m)
      assert.ok(!g.stdout.includes(WORD), both(g))
    })
  })
})
