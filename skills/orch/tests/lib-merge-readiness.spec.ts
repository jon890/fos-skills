// lib/merge-readiness.ts 의 값 읽기만 본다. 조건의 뜻은 core-merge-readiness.spec.ts 가 본다
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeRun } from '../../../modules/testkit/fake-run.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { checkReadiness, defaultThreadsCmd } from '../scripts/lib/merge-readiness.ts'
import type { PrTarget } from '../scripts/lib/merge-readiness.ts'
import { withRun } from '../scripts/lib/proc.ts'

const HEAD = 'a'.repeat(40)
process.env.ORCH_GH_CACHE = '0'

function target(repo: string, over: Partial<PrTarget> = {}): PrTarget {
  return { repo, number: 7, head: HEAD, base: 'main', branch: 'feat/x', host: 'github.com', slug: 'o/r', draft: false, ...over }
}

function setup(t: Parameters<typeof tempDir>[1]) {
  const repo = tempDir('readiness-', t)
  process.env.ORCH_PRIVATE_WORDS = join(repo, 'no-words.txt')
  return repo
}

const ghCalls = (calls: { argv: string[] }[]) => calls.filter((c) => c.argv[0].endsWith('gh')).map((c) => c.argv.slice(1).join(' '))

test('보류만 물으면 본문, 지시서, 보드를 읽는다. 없는 지시서 폴더와 보드는 보류 없음이다', async (t) => {
  const repo = setup(t)
  const fake = fakeRun({ gh: [{ args: ['--jq', '.body'], stdout: '본문\n머지 보류: 배포 대기\n' }], git: [{ code: 1 }] })
  const got = await withRun(fake.run, () => checkReadiness(target(repo), { scope: 'full', only: ['hold'] }))
  assert.deepEqual(got.reasons.map((r) => [r.kind, r.text]), [['hold', '배포 대기']])
  assert.deepEqual(ghCalls(fake.calls()), ['pr view 7 --json body --jq .body'])
  assert.deepEqual(got.snapshot.facts, {
    holdBody: { ok: true, value: '배포 대기' },
    specHold: { ok: true, value: null },
    boardItems: { ok: true, value: [] },
  })
})

test('본문 보류를 읽지 못하면 ok: false 이고 그 문구가 lookup 이유다', async (t) => {
  const repo = setup(t)
  const fake = fakeRun({ gh: [{ code: 1, stderr: 'boom' }], git: [{ code: 1 }] })
  const got = await withRun(fake.run, () => checkReadiness(target(repo), { scope: 'full', only: ['hold'] }))
  assert.deepEqual(got.reasons.map((r) => [r.kind, r.stage, r.text]), [['lookup', 'merge', 'PR 본문을 읽지 못해 머지 보류 줄을 확인할 수 없다']])
})

test('폴더 자리에 파일이 있거나 보드를 파싱하지 못하면 두 조회가 모두 보류 단계에서 걸린다', async (t) => {
  const repo = setup(t)
  const specs = join(repo, 'specs')
  const board = join(repo, 'board.json')
  mkdirSync(join(repo, '.orch'))
  writeFileSync(join(repo, '.orch', 'config.json'), JSON.stringify({ finish: { specs_dir: specs, board } }))
  writeFileSync(specs, '')
  writeFileSync(board, '{')
  const fake = fakeRun({ gh: [{ stdout: '머지 보류: 본문 이유\n' }], git: [{ code: 1 }] })
  const got = await withRun(fake.run, () => checkReadiness(target(repo), { scope: 'full', only: ['hold'] }))
  assert.equal(got.snapshot.facts.specHold?.ok, false)
  assert.equal(got.snapshot.facts.boardItems?.ok, false)
  assert.deepEqual(got.reasons.map((r) => [r.kind, r.stage]), [['lookup', 'merge'], ['hold', 'merge'], ['lookup', 'merge']])
})

test('HEAD 가 다른 값을 읽으면 뒤 값은 읽지 않는다', async (t) => {
  const repo = setup(t)
  const other = 'b'.repeat(40)
  const fake = fakeRun({
    gh: [
      { args: ['statusCheckRollup,headRefOid'], stdout: JSON.stringify({ statusCheckRollup: [], headRefOid: HEAD }) },
      { args: ['body,headRefOid'], stdout: JSON.stringify({ body: '', headRefOid: other }) },
      { args: ['mergeable'], stdout: 'MERGEABLE\n' },
    ],
    git: [{ code: 1 }],
  })
  const got = await withRun(fake.run, () => checkReadiness(target(repo), { scope: 'full', skip: ['hold'] }, { threadsCmd: 'echo 0', retries: 1, allowNoChecks: true }))
  assert.deepEqual(got.reasons.map((r) => r.kind), ['head'])
  assert.equal(got.reasons[0].text, `검사 뒤 HEAD 가 바뀌었다 checked=${HEAD.slice(0, 8)} now=${other.slice(0, 8)}`)
  // 체크, 스레드(bash), mergeable, 본문 순서로 읽고 본문 뒤에서 멈춘다
  assert.deepEqual(ghCalls(fake.calls()), [
    'pr view 7 --json statusCheckRollup,headRefOid --jq .',
    'pr view 7 --json mergeable --jq .mergeable',
    'pr view 7 --json body,headRefOid --jq .',
  ])
})

test('fresh 로 물으면 체크를 캐시 없이 읽는다', async (t) => {
  const repo = setup(t)
  delete process.env.ORCH_GH_CACHE
  t.after(() => {
    process.env.ORCH_GH_CACHE = '0'
  })
  process.env.ORCH_MACHINE_DIR = join(repo, 'machine')
  process.env.ORCH_DIR = join(repo, 'orch')
  const fake = fakeRun({ gh: [{ stdout: JSON.stringify({ statusCheckRollup: [{ name: 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS' }], headRefOid: HEAD }) }], git: [{ code: 1 }] })
  const ask = async (fresh: boolean) => withRun(fake.run, () => checkReadiness(target(repo), { scope: 'full', only: ['ci'], fresh }, { required: ['Tests'], retries: 1 }))
  await ask(false)
  await ask(false)
  const cached = ghCalls(fake.calls()).length
  assert.equal(cached, 1)
  await ask(true)
  assert.equal(ghCalls(fake.calls()).length, cached + 1)
})

test('known 으로 준 읽기 함수는 그 값이 필요할 때 한 번만 불리고 gh 를 부르지 않는다', async (t) => {
  const repo = setup(t)
  const fake = fakeRun({ gh: [{ code: 1 }], git: [{ code: 1 }] })
  let called = 0
  const got = await withRun(fake.run, () => checkReadiness(target(repo), { scope: 'light', only: ['threads'] }, {
    known: { threads: () => (called++, { ok: true, value: '2' }) },
  }))
  assert.equal(called, 1)
  assert.deepEqual(got.reasons.map((r) => r.text), ['미해결 리뷰 스레드 2 개'])
  assert.deepEqual(ghCalls(fake.calls()), [])
})

test('스레드 기본 명령은 진입 폴더에서 review_threads.ts 로 정규화하지 않고 잇는다(옛 명령과 같은 글자)', () => {
  assert.equal(defaultThreadsCmd('/x/scripts/loop'), `node '/x/scripts/loop/../../../review-fix/scripts/review_threads.ts' list --count "$OWNER" "$REPO" "$PR"`)
})
