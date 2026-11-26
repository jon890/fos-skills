import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoMergeConfig } from '../scripts/core/auto-merge.ts'
import { judgeTrustedBotReviews } from '../scripts/lib/review-bot.ts'
import type { BotReviewData } from '../scripts/lib/review-bot.ts'
import { BOT, BOT_SETTING, REVIEWED_AT, receipt } from './fixtures/codex-review.ts'

const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const FOUND_AT = '2026-01-01T00:03:00Z'
const REREVIEWED_AT = '2026-01-01T00:04:00Z'
const CONFIG = { pass: 'PASS', block: 'BLOCK', trusted_bots: [BOT_SETTING] }
const { trustedBots } = autoMergeConfig({ queue: { auto_review: CONFIG } }).review!
// PR 커밋은 OLD 다음 HEAD 순서다
const judge = (rows: Partial<BotReviewData>) => judgeTrustedBotReviews(HEAD, { reviews: [], comments: [], reviewThreads: [], commits: [OLD, HEAD], ...rows }, trustedBots!)

test('믿는 봇 설정에서 잘못된 항목을 거절한다', () => {
  for (const trusted_bots of [[], [null], [{ ...BOT_SETTING, login: '' }], [{ ...BOT_SETTING, receipt_marker: '' }],
    [{ ...BOT_SETTING, reviewed_commit: '(' }], [{ ...BOT_SETTING, reviewed_commit: 'no-group' }],
    [BOT_SETTING, { ...BOT_SETTING, login: BOT.login.toUpperCase() }]]) {
    assert.throws(() => autoMergeConfig({ queue: { auto_review: { ...CONFIG, trusted_bots } } }), /queue\.auto_review\.trusted_bots/)
  }
})

test('봇 종류와 계정, 영수증 표지, 현재 HEAD 앞자리가 모두 맞아야 pass 를 얻는다', () => {
  const current = receipt(HEAD, REVIEWED_AT, '검토를 마쳤습니다.')
  assert.deepEqual(judge({ comments: [current] }), {
    ok: true, receipts: [{ body: '', at: REVIEWED_AT, commit: HEAD, receiptBot: BOT.login }],
  })
  const noMarker = { ...current, body: current.body.split('\n').slice(1).join('\n') }
  const stale = receipt(OLD, REVIEWED_AT, "Didn't find any major issues. Keep them coming!")
  const humanCopy = { ...current, author: { __typename: 'User', login: BOT.login } }
  const otherBot = { ...current, author: { ...BOT, login: 'another-app' } }
  const ambiguous = { ...current, body: current.body + '\n' + stale.body }
  for (const comment of [noMarker, humanCopy, otherBot, ambiguous]) {
    assert.deepEqual(judge({ comments: [comment] }), { ok: true, receipts: [] })
  }
  // 앞 커밋의 영수증은 지적이 없으면 인정하고 그 커밋을 근거에 남긴다(스펙 DECISION15)
  assert.deepEqual(judge({ comments: [stale] }), {
    ok: true, receipts: [{ body: '', at: REVIEWED_AT, commit: OLD.slice(0, 10), receiptBot: BOT.login, earlier: true }],
  })
})

test('리뷰 영수증은 GitHub 가 기록한 커밋과도 맞아야 한다', () => {
  const returned = { author: BOT, state: 'APPROVED', submittedAt: REVIEWED_AT, body: receipt(HEAD).body }
  assert.deepEqual(judge({ reviews: [{ ...returned, commit: { oid: OLD } }] }), { ok: true, receipts: [] })
  // 영수증 앞자리가 맞는 다른 커밋의 리뷰는 지금 HEAD 의 것이 아니라 앞 커밋의 리뷰다
  const other = HEAD.slice(0, 10) + OLD.slice(10)
  const earlier = judge({ reviews: [{ ...returned, commit: { oid: other } }], commits: [other, HEAD] })
  assert.ok(earlier.ok && earlier.receipts[0].earlier === true && earlier.receipts[0].commit === other)
  // 리뷰한 커밋이 지금 PR 커밋 목록에 없으면(force-push 로 지웠다) 인정하지 않는다
  assert.equal(judge({ reviews: [{ ...returned, commit: { oid: other } }] }).ok, false)
  const result = judge({ reviews: [{ ...returned, commit: { oid: HEAD } }] })
  assert.ok(result.ok && result.receipts.length === 1)
})

test('커밋 앞자리는 7자리부터 허용하며 영수증에 적힌 자리를 모두 비교한다', () => {
  const { body, ...comment } = receipt(HEAD)
  const withCommit = (commit: string) => ({ ...comment, body: body.replace(HEAD.slice(0, 10), commit) })
  assert.deepEqual(judge({ comments: [withCommit(HEAD.slice(0, 6))] }), { ok: true, receipts: [] })
  for (const commit of [HEAD.slice(0, 7) + 'bbb', HEAD.slice(0, 39) + 'b']) {
    const result = judge({ comments: [withCommit(commit)], commits: [commit, HEAD] })
    assert.ok(result.ok && result.receipts[0].earlier === true, commit)
    assert.equal(judge({ comments: [withCommit(commit)] }).ok, false, commit)
  }
  for (const commit of [HEAD.slice(0, 7), HEAD]) {
    const result = judge({ comments: [withCommit(commit)] })
    assert.ok(result.ok && result.receipts.length === 1 && result.receipts[0].earlier === undefined)
  }
})

test('제출되지 않았거나 취소된 리뷰는 지적이나 영수증으로 세지 않는다', () => {
  for (const state of ['PENDING', 'DISMISSED']) {
    const review = { author: BOT, state, submittedAt: FOUND_AT, body: receipt(HEAD).body, commit: { oid: HEAD } }
    assert.deepEqual(judge({ reviews: [review] }), { ok: true, receipts: [] })
    const result = judge({ reviews: [{ ...review, body: '' }], comments: [receipt(HEAD)] })
    assert.ok(result.ok && result.receipts.length === 1)
  }
})

test('의견 리뷰가 다른 커밋의 영수증을 포함하면 지적으로 처리한다', () => {
  const review = { author: BOT, state: 'COMMENTED', submittedAt: FOUND_AT, body: receipt(HEAD).body, commit: { oid: OLD } }
  assert.equal(judge({ reviews: [review], comments: [receipt(HEAD)] }).ok, false)
})

test('지적 시각을 읽을 수 없으면 영수증이 있어도 재리뷰를 기다린다', () => {
  const review = { author: BOT, state: 'CHANGES_REQUESTED', submittedAt: null, body: '', commit: { oid: HEAD } }
  assert.equal(judge({ reviews: [review], comments: [receipt(HEAD, REREVIEWED_AT)] }).ok, false)
})

test('등록한 봇 하나의 영수증을 pass 로 센다. 지적을 남긴 봇의 새 영수증은 그 봇에서 받아야 한다', () => {
  const second = { ...BOT, login: 'another-review-app' }
  const auto_review = { ...CONFIG, trusted_bots: [BOT_SETTING, { ...BOT_SETTING, login: second.login }] }
  const { trustedBots: bots } = autoMergeConfig({ queue: { auto_review } }).review!
  const comment = receipt(HEAD, REREVIEWED_AT)
  const rows = { comments: [comment], reviews: [], reviewThreads: [] }
  const pass = judgeTrustedBotReviews(HEAD, rows, bots!)
  assert.ok(pass.ok && pass.receipts.length === 1 && pass.receipts[0].receiptBot === BOT.login)

  const reviews = [{ author: second, state: 'CHANGES_REQUESTED', submittedAt: FOUND_AT, body: '', commit: { oid: HEAD } }]
  assert.equal(judgeTrustedBotReviews(HEAD, { ...rows, reviews }, bots!).ok, false)
  const comments = [comment, { ...comment, author: second }]
  assert.equal(judgeTrustedBotReviews(HEAD, { ...rows, reviews, comments }, bots!).ok, true)
})

test('미해결 봇 스레드는 영수증보다 우선하고, 해결 뒤에는 지적 이후의 영수증을 요구한다', () => {
  const thread = { isResolved: false, comments: { nodes: [{ author: BOT, createdAt: FOUND_AT }] } }
  const fresh = receipt(HEAD, REREVIEWED_AT)
  assert.deepEqual(judge({ reviewThreads: [thread], comments: [fresh] }), {
    ok: false, wait: `${BOT.login} 봇의 미해결 줄 댓글 스레드가 있다`,
  })
  // 해결한 지적은 그 줄 댓글을 단 커밋의 리뷰에 묶는다
  const onOld = { isResolved: true, comments: { nodes: [{ author: BOT, createdAt: FOUND_AT, originalCommit: { oid: OLD } }] } }
  assert.equal(judge({ reviewThreads: [onOld], comments: [receipt(OLD)] }).ok, false)
  const passed = judge({ reviewThreads: [onOld], comments: [receipt(OLD), fresh] })
  assert.ok(passed.ok && passed.receipts[0].at === REREVIEWED_AT && passed.receipts[0].earlier === undefined)
  // 어느 리뷰에도 묶지 못한 지적은 P1·P2 로 본다
  assert.equal(judge({ reviewThreads: [{ ...thread, isResolved: true }], comments: [receipt(OLD), fresh] }).ok, false)
})

test('의견 리뷰와 변경 요청보다 늦게 같은 봇이 현재 HEAD 를 확인해야 한다', () => {
  for (const state of ['COMMENTED', 'CHANGES_REQUESTED']) {
    const reviews = [{ state, author: BOT, body: '', submittedAt: FOUND_AT, commit: { oid: HEAD } }]
    assert.equal(judge({ reviews, comments: [receipt(HEAD)] }).ok, false)
    assert.equal(judge({ reviews, comments: [receipt(HEAD, FOUND_AT)] }).ok, false)
    assert.equal(judge({ reviews, comments: [receipt(HEAD, REREVIEWED_AT)] }).ok, true)
  }
})

// 스펙 DECISION15: 마지막 리뷰에 P1·P2 지적이 없으면 뒤 커밋에도 인정한다. 배지를 읽지 못한 줄 댓글은 막는 지적으로 본다
test('마지막 봇 리뷰의 줄 댓글 배지로 P1·P2 를 보고 앞 커밋의 리뷰를 인정할지 정한다', () => {
  const badge = (body: string) => ({ isResolved: true, comments: { nodes: [{ author: BOT, createdAt: REVIEWED_AT, body, originalCommit: { oid: OLD } }] } })
  const level = (n: number) => badge(`**<sub><sub>![P${n} Badge](https://img.shields.io/badge/P${n}-yellow?style=flat)</sub></sub>  제목**`)
  const old = receipt(OLD)
  for (const n of [0, 1, 2]) {
    assert.deepEqual(judge({ comments: [old], reviewThreads: [level(n)] }), {
      ok: false, wait: `${BOT.login} 봇이 P1·P2 지적을 남겼다. 고친 커밋에서 현재 HEAD 의 영수증을 다시 받아야 한다`,
    })
  }
  for (const n of [3, 4, 5]) {
    const got = judge({ comments: [old], reviewThreads: [level(n)] })
    assert.ok(got.ok && got.receipts[0].earlier === true, String(n))
  }
  assert.equal(judge({ comments: [old], reviewThreads: [level(3), badge('배지 없는 지적')] }).ok, false)
  // 사람이 단 배지 글은 읽지 않는다. 봇이 연 스레드만 본다
  const human = { isResolved: true, comments: { nodes: [{ author: { __typename: 'User', login: 'me' }, createdAt: REVIEWED_AT, body: '![P1 Badge]' }] } }
  assert.ok(judge({ comments: [old], reviewThreads: [human] }).ok)
  // P1·P2 를 고친 새 커밋에서 다시 받은 리뷰는 앞 지적과 상관없이 인정한다
  const fixed = judge({ comments: [old, receipt(HEAD, REREVIEWED_AT)], reviewThreads: [level(1)] })
  assert.ok(fixed.ok && fixed.receipts[0].earlier === undefined)
  // 지금 커밋의 리뷰에 P3 만 있으면 다시 리뷰받지 않아도 된다
  const p3OnHead = { isResolved: true, comments: { nodes: [{ ...level(3).comments.nodes[0], originalCommit: { oid: HEAD } }] } }
  assert.ok(judge({ comments: [receipt(HEAD)], reviewThreads: [p3OnHead] }).ok)
})

test('지금 HEAD 에서 봇 리뷰가 도는 중이면 앞 커밋의 리뷰를 인정하지 않고 기다린다', () => {
  const running = { author: BOT, state: 'PENDING', submittedAt: null, body: '', commit: { oid: HEAD } }
  assert.deepEqual(judge({ comments: [receipt(OLD)], reviews: [running] }), { ok: false, wait: `${BOT.login} 봇이 현재 HEAD 를 리뷰하는 중이다` })
})

// PR 651 리뷰: 봇이 줄 댓글을 리뷰 제출보다 먼저 만들어도 그 리뷰의 지적으로 본다. 시각이 아니라 소속 리뷰로 묶는다
test('리뷰보다 먼저 만든 줄 댓글도 커밋으로 묶어 P1·P2 를 본다', () => {
  const review = { id: 'R1', author: BOT, state: 'COMMENTED', submittedAt: REVIEWED_AT, body: receipt(OLD).body, commit: { oid: OLD } }
  const early = (n: number) => ({ isResolved: true, comments: { nodes: [{ author: BOT, createdAt: '2026-01-01T00:01:59Z', body: `![P${n} Badge] 제목`, originalCommit: { oid: OLD } }] } })
  assert.equal(judge({ reviews: [review], reviewThreads: [early(1)] }).ok, false)
  const p3 = judge({ reviews: [review], reviewThreads: [early(3)] })
  assert.ok(p3.ok && p3.receipts[0].earlier === true && p3.receipts[0].commit === OLD)
  // 같은 리뷰에 묶인 P1 은 뒤의 다른 커밋 리뷰가 다시 봤으면 막지 않는다
  assert.ok(judge({ reviews: [review], reviewThreads: [early(1)], comments: [receipt(HEAD, REREVIEWED_AT)] }).ok)
})

// PR 651 리뷰: 영수증 없는 지적 리뷰 뒤에 같은 커밋의 영수증 댓글이 오면 그 지적은 그 영수증의 것이다
test('영수증 없는 지적 리뷰의 줄 댓글은 같은 커밋의 뒤 영수증 댓글에 묶는다', () => {
  const findingReview = { id: 'F1', author: BOT, state: 'COMMENTED', submittedAt: REVIEWED_AT, body: '지적', commit: { oid: OLD } }
  const thread = (n: number) => ({ isResolved: true, comments: { nodes: [{ author: BOT, createdAt: REVIEWED_AT, body: `![P${n} Badge] 제목`, originalCommit: { oid: OLD } }] } })
  const lateReceipt = receipt(OLD, FOUND_AT)
  assert.equal(judge({ reviews: [findingReview], reviewThreads: [thread(1)], comments: [lateReceipt] }).ok, false)
  // 줄 댓글이 P3 뿐이면 그 영수증을 인정한다. P1 이어도 고친 새 커밋의 영수증이면 통과한다
  assert.ok(judge({ reviews: [findingReview], reviewThreads: [thread(3)], comments: [lateReceipt] }).ok)
  assert.ok(judge({ reviews: [findingReview], reviewThreads: [thread(1)], comments: [lateReceipt, receipt(HEAD, REREVIEWED_AT)] }).ok)
})

// 코디네이터 2026-11-26: 인정하려는 영수증의 커밋과 같거나 뒤 커밋의 P1·P2 는 해결 여부와 관계없이 막는다. 커밋이나 순서를 모르면 막는다
test('앞 영수증의 커밋과 같거나 뒤 커밋의 P1·P2 줄 댓글은 막고, 커밋이나 순서를 모르면 막는다', () => {
  const MID = 'c'.repeat(40)
  const at = (commit: string | null, n = 1) => ({ isResolved: true, comments: { nodes: [{ author: BOT, createdAt: REVIEWED_AT, body: `![P${n} Badge] 제목`, ...(commit ? { originalCommit: { oid: commit } } : {}) }] } })
  const commits = [OLD, MID, HEAD]
  assert.equal(judge({ comments: [receipt(OLD)], reviewThreads: [at(MID)], commits }).ok, false)
  assert.equal(judge({ comments: [receipt(MID)], reviewThreads: [at(MID)], commits }).ok, false)
  assert.ok(judge({ comments: [receipt(MID)], reviewThreads: [at(OLD)], commits }).ok)
  assert.ok(judge({ comments: [receipt(OLD)], reviewThreads: [at(MID, 3)], commits }).ok)
  assert.equal(judge({ comments: [receipt(MID)], reviewThreads: [at(null)], commits }).ok, false)
  assert.equal(judge({ comments: [receipt(MID)], reviewThreads: [at(OLD)], commits: [] }).ok, false)
})

// PR 651 리뷰: force-push 로 지워진 커밋의 영수증은 지적이 없어도 인정하지 않고, 재리뷰 요청도 막지 않는다
test('리뷰한 커밋이 지금 PR 커밋 목록에 없으면 앞 리뷰를 인정하지 않는다', () => {
  assert.deepEqual(judge({ comments: [receipt(OLD)], commits: [HEAD] }), {
    ok: false, wait: `${BOT.login} 봇이 리뷰한 커밋이 지금 PR 커밋 목록에 없다. 현재 HEAD 의 영수증을 다시 받아야 한다`,
  })
  assert.equal(judgeTrustedBotReviews(HEAD, { reviews: [], comments: [receipt(OLD)], reviewThreads: [] }, trustedBots!).ok, false)
  assert.ok(judge({ comments: [receipt(HEAD)], commits: [HEAD] }).ok)
})

// PR 651 리뷰: 믿는 봇이 여럿이면 다른 봇이 지금 HEAD 를 리뷰하는 중일 때도 앞 리뷰를 인정하지 않는다
test('다른 믿는 봇이 지금 HEAD 를 리뷰하는 중이면 앞 리뷰를 인정하지 않는다', () => {
  const second = { ...BOT, login: 'another-review-app' }
  const { trustedBots: bots } = autoMergeConfig({ queue: { auto_review: { ...CONFIG, trusted_bots: [BOT_SETTING, { ...BOT_SETTING, login: second.login }] } } }).review!
  const running = { author: second, state: 'PENDING', submittedAt: null, body: '', commit: { oid: HEAD } }
  const rows = { reviews: [running], comments: [receipt(OLD)], reviewThreads: [], commits: [OLD, HEAD] }
  assert.deepEqual(judgeTrustedBotReviews(HEAD, rows, bots!), { ok: false, wait: `${second.login} 봇이 현재 HEAD 를 리뷰하는 중이다` })
  assert.ok(judgeTrustedBotReviews(HEAD, { ...rows, reviews: [] }, bots!).ok)
})
