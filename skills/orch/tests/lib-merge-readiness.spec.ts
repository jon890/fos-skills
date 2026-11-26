// lib/merge-readiness.ts 의 값 읽기만 본다. 조건의 뜻은 core-merge-readiness.spec.ts 가 본다
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeRun } from '../../../modules/testkit/fake-run.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { checkReadiness } from '../scripts/lib/merge-readiness.ts'
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

test('읽을 필요가 없는 값은 읽지 않는다. 보류만 물으면 본문 보류와 지시서만 읽는다', async (t) => {
  const repo = setup(t)
  const fake = fakeRun({ gh: [{ args: ['--jq', '.body'], stdout: '본문\n머지 보류: 배포 대기\n' }], git: [{ code: 1 }] })
  const got = await withRun(fake.run, () => checkReadiness(target(repo), { scope: 'full', only: ['hold'], compat: { oldHolds: true } }))
  assert.deepEqual(got.reasons.map((r) => [r.kind, r.text]), [['hold', '배포 대기']])
  assert.deepEqual(ghCalls(fake.calls()), ['pr view 7 --json body --jq .body'])
  assert.deepEqual(Object.keys(got.snapshot.facts).sort(), ['holdBody', 'specHold'])
})

test('본문 보류를 읽지 못하면 ok: false 이고 그 문구가 lookup 이유다', async (t) => {
  const repo = setup(t)
  const fake = fakeRun({ gh: [{ code: 1, stderr: 'boom' }], git: [{ code: 1 }] })
  const got = await withRun(fake.run, () => checkReadiness(target(repo), { scope: 'full', only: ['hold'], compat: { oldHolds: true } }))
  assert.deepEqual(got.reasons.map((r) => [r.kind, r.stage, r.text]), [['lookup', 'merge', 'PR 본문을 읽지 못해 머지 보류 줄을 확인할 수 없다']])
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
