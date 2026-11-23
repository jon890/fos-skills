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
const judge = (rows: Partial<BotReviewData>) => judgeTrustedBotReviews(HEAD, { reviews: [], comments: [], reviewThreads: [], ...rows }, trustedBots!)

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
  for (const comment of [noMarker, stale, humanCopy, otherBot, ambiguous]) {
    assert.deepEqual(judge({ comments: [comment] }), { ok: true, receipts: [] })
  }
})

test('리뷰 영수증은 GitHub 가 기록한 커밋과도 맞아야 한다', () => {
  const returned = { author: BOT, state: 'APPROVED', submittedAt: REVIEWED_AT, body: receipt(HEAD).body }
  for (const oid of [OLD, HEAD.slice(0, 10) + OLD.slice(10)]) {
    assert.deepEqual(judge({ reviews: [{ ...returned, commit: { oid } }] }), { ok: true, receipts: [] })
  }
  const result = judge({ reviews: [{ ...returned, commit: { oid: HEAD } }] })
  assert.ok(result.ok && result.receipts.length === 1)
})

test('커밋 앞자리는 7자리부터 허용하며 영수증에 적힌 자리를 모두 비교한다', () => {
  const { body, ...comment } = receipt(HEAD)
  const withCommit = (commit: string) => ({ ...comment, body: body.replace(HEAD.slice(0, 10), commit) })
  for (const commit of [HEAD.slice(0, 6), HEAD.slice(0, 7) + 'bbb', HEAD.slice(0, 39) + 'b']) {
    assert.deepEqual(judge({ comments: [withCommit(commit)] }), { ok: true, receipts: [] })
  }
  for (const commit of [HEAD.slice(0, 7), HEAD]) {
    const result = judge({ comments: [withCommit(commit)] })
    assert.ok(result.ok && result.receipts.length === 1)
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
  const resolved = { ...thread, isResolved: true }
  assert.equal(judge({ reviewThreads: [resolved], comments: [receipt(HEAD), receipt(OLD, REREVIEWED_AT)] }).ok, false)
  const passed = judge({ reviewThreads: [resolved], comments: [receipt(HEAD), fresh] })
  assert.ok(passed.ok && passed.receipts[0].at === REREVIEWED_AT)
})

test('의견 리뷰와 변경 요청보다 늦게 같은 봇이 현재 HEAD 를 확인해야 한다', () => {
  for (const state of ['COMMENTED', 'CHANGES_REQUESTED']) {
    const reviews = [{ state, author: BOT, body: '', submittedAt: FOUND_AT, commit: { oid: HEAD } }]
    assert.equal(judge({ reviews, comments: [receipt(HEAD)] }).ok, false)
    assert.equal(judge({ reviews, comments: [receipt(HEAD, FOUND_AT)] }).ok, false)
    assert.equal(judge({ reviews, comments: [receipt(HEAD, REREVIEWED_AT)] }).ok, true)
  }
})
