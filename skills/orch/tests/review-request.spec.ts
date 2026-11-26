import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { autoMergeConfig } from '../scripts/core/auto-merge.ts'
import type { Config } from '../scripts/core/config.ts'
import { context, initialState, stepContext } from '../scripts/loop/steps/context.ts'
import { requestMissingBotReviews } from '../scripts/loop/steps/review-request.ts'
import type { OwnPr } from '../scripts/loop/steps/shared.ts'
import { BOT, BOT_SETTING, receipt } from './fixtures/codex-review.ts'
import { fakeBin, type FakeRule } from './fixtures/fake-bin.ts'

const HEAD = 'a'.repeat(40)
const NEXT = 'b'.repeat(40)
const COMMAND = '@codex review'
const REVIEW = { pass: 'PASS', block: 'BLOCK', trusted_bots: [{ ...BOT_SETTING, request_comment: COMMAND }] }
const PR: OwnPr = {
  number: 12, head: HEAD, branch: 'fix/example', author: 'worker', draft: false,
  base: 'main', title: 'example', url: 'https://github.test/o/r/pull/12', host: 'github.test', slug: 'o/r', rollup: [],
}

function setup(t: TestContext, config: Config = { queue: { auto_review: REVIEW } }) {
  const repo = tempDir('review-request-', t)
  const fake = fakeBin(repo, 'gh', [{ code: 1, stderr: 'unexpected call' }])
  const previous = { GH: process.env.GH, ORCH_DIR: process.env.ORCH_DIR }
  Object.assign(process.env, { GH: fake.path, ORCH_DIR: join(repo, '.orch') })
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const ctx = stepContext({ ...context(repo, undefined, undefined), autoMerge: autoMergeConfig(config) }, 1)
  const snapshot = (head = HEAD, comments: unknown[] = [], overrides = {}, postRule: FakeRule = { code: 0 }) => {
    const page = (nodes: unknown[] = []) => ({ nodes, pageInfo: { hasNextPage: false } })
    const pullRequest = { headRefOid: head, state: 'OPEN', isDraft: false, comments: page(comments), reviews: page(), reviewThreads: page(), ...overrides }
    fake.setRules([
      { args: ['api', 'graphql'], stdout: JSON.stringify({ data: { repository: { pullRequest } } }) },
      { args: ['api', 'POST', 'repos/o/r/issues/12/comments'], ...postRule },
      { code: 1, stderr: 'unexpected call' },
    ])
  }
  const tick = (now: number, pr = PR) => requestMissingBotReviews(ctx, { ...initialState(), prs: { ok: true, mine: [pr] } }, now)
  const posts = () => fake.calls().filter(({ argv }) => argv.includes('POST'))
  return { fake, tick, snapshot, posts }
}

test('기본 3분이 지나면 현재 HEAD 에 한 번 요청하고 push 뒤 새 HEAD 를 다시 기다린다', (t) => {
  const { fake, tick, snapshot, posts } = setup(t)
  snapshot()
  tick(0)
  tick(179_999)
  assert.deepEqual(fake.calls(), [])
  tick(180_000)
  tick(360_000)
  assert.deepEqual(posts().map(({ argv }) => argv), [
    ['api', '--hostname', 'github.test', '-X', 'POST', 'repos/o/r/issues/12/comments', '-f', `body=${COMMAND}\n\n<!-- orch-bot-review-request:${HEAD} -->`],
  ])
  // P1·P2 를 고친 push 에만 다시 요청한다(스펙 DECISION15). 앞 리뷰에 P1 이 있었으니 새 HEAD 에 요청한다
  const next = { ...PR, head: NEXT }
  const p1 = { isResolved: true, comments: { nodes: [{ author: BOT, createdAt: '2026-01-01T00:02:00Z', body: '![P1 Badge] 제목', originalCommit: { oid: HEAD } }] } }
  snapshot(NEXT, [receipt(HEAD)], { reviewThreads: { nodes: [p1], pageInfo: { hasNextPage: false } } })
  tick(360_001, next)
  tick(540_000, next)
  assert.equal(posts().length, 1)
  tick(540_001, next)
  tick(720_000, PR)
  assert.equal(posts().length, 2)
})

test('앞 커밋의 봇 리뷰에 P1·P2 지적이 없으면 push 뒤에도 다시 요청하지 않는다', (t) => {
  const { tick, snapshot, posts } = setup(t)
  const next = { ...PR, head: NEXT }
  const p3 = { isResolved: true, comments: { nodes: [{ author: BOT, createdAt: '2026-01-01T00:02:00Z', body: '![P3 Badge] 제목', originalCommit: { oid: HEAD } }] } }
  snapshot(NEXT, [receipt(HEAD)], { reviewThreads: { nodes: [p3], pageInfo: { hasNextPage: false } } })
  tick(0, next)
  tick(180_000, next)
  assert.equal(posts().length, 0)
})

test('믿는 봇이 남긴 현재 HEAD 의 영수증이나 진행 중 표시가 있으면 요청하지 않는다', (t) => {
  const { tick, snapshot, posts } = setup(t)
  const running = (commit_sha: string) => ({
    author: BOT, createdAt: '2026-01-01T00:02:00Z',
    body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha, status: 'in_progress' } })} -->`,
  })
  tick(0)
  snapshot(HEAD, [running(HEAD)])
  tick(180_000)
  snapshot(HEAD, [receipt(HEAD)])
  tick(360_000)
  assert.equal(posts().length, 0)
  snapshot(HEAD, [running(NEXT)])
  tick(540_000)
  assert.equal(posts().length, 1)
})

test('대기 시간을 바꿀 수 있고 이미 GitHub 에 달린 요청은 다시 달지 않는다', (t) => {
  const { tick, snapshot, fake, posts } = setup(t, { queue: { auto_review: { ...REVIEW, request_after_sec: 10 } } })
  snapshot(HEAD, [{ author: null, body: `${COMMAND}\n\n<!-- orch-bot-review-request:${HEAD} -->` }])
  tick(0)
  tick(9_999)
  assert.deepEqual(fake.calls(), [])
  tick(10_000)
  assert.equal(fake.calls().length, 1)
  assert.equal(posts().length, 0)
})

test('믿는 봇을 설정하지 않으면 GitHub 를 조회하거나 요청하지 않는다', (t) => {
  const { tick, fake } = setup(t, { queue: { auto_review: { pass: 'PASS', block: 'BLOCK' } } })
  tick(0)
  tick(180_000)
  assert.deepEqual(fake.calls(), [])
})

test('조회 중 HEAD 가 달라지거나 PR 이 draft 가 되면 댓글을 달지 않는다', (t) => {
  const { tick, snapshot, posts } = setup(t)
  tick(0)
  snapshot(NEXT)
  assert.match(tick(180_000).errors?.['review-request'] ?? '', /HEAD 가 바뀌었다/)
  snapshot(HEAD, [], { isDraft: true })
  tick(360_000)
  assert.equal(posts().length, 0)
})

test('댓글 등록이 실패하면 다시 조회하고 GitHub 에 도착해 있으면 재등록하지 않는다', (t) => {
  const { tick, snapshot, posts } = setup(t)
  tick(0)
  snapshot(HEAD, [], {}, { code: 1, stderr: 'connection reset' })
  assert.match(tick(180_000).errors?.['review-request'] ?? '', /connection reset/)
  snapshot(HEAD, [{ author: null, body: `${COMMAND}\n\n<!-- orch-bot-review-request:${HEAD} -->` }])
  tick(360_000)
  tick(540_000)
  assert.equal(posts().length, 1)
})

// PR 651 리뷰: 믿는 봇이 여럿이면 관문처럼 모든 봇을 함께 본다. 한 봇의 앞 리뷰 인정만으로 재요청을 멈추지 않는다
test('다른 믿는 봇이 막는 지적을 남겼으면 한 봇의 앞 리뷰를 인정해도 다시 요청한다', (t) => {
  const second = { ...BOT, login: 'another-review-app' }
  const bots = [{ ...BOT_SETTING, request_comment: COMMAND }, { ...BOT_SETTING, login: second.login }]
  const { tick, snapshot, posts } = setup(t, { queue: { auto_review: { trusted_bots: bots } } })
  const blocking = { author: second, state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:03:00Z', body: '', commit: { oid: HEAD } }
  const next = { ...PR, head: NEXT }
  snapshot(NEXT, [receipt(HEAD)], { reviews: { nodes: [blocking], pageInfo: { hasNextPage: false } } })
  tick(0, next)
  tick(180_000, next)
  assert.equal(posts().length, 1)
})
