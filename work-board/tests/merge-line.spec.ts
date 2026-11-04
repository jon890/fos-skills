// 열린 PR 아래에 붙이는 머지 줄의 판정(mergeLine)과 대기 이유를 옮기는 말(waitText)을 본다.
// 세 경우(큐를 쓰지 않음, 큐를 쓰고 기록이 있음, 큐를 쓰고 기록이 없음)를 한 판정 함수로 묶는다.
//
// 실행: node --test work-board/tests/merge-line.spec.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clockOf, mergeLine, parseQueueView, waitText } from '../hooks/register.js'

const AT = '2026-11-04T04:10:00.000Z'
const SINCE = clockOf(AT) + ' 부터'

test('큐를 쓰지 않는 저장소면 기록이 있어도 줄을 붙이지 않는다', () => {
  const view = { enabled: false, running: false, prs: { 7: { place: 'out', rank: null, reason: 'CI pending', at: AT } }, error: null }
  assert.equal(mergeLine(view, 7), null)
  // 출력을 읽지 못했을 때도 큐를 쓰는지 몰라 붙이지 않는다
  assert.equal(mergeLine(null, 7), null)
})

test('큐를 쓰는 저장소에서 기록이 있으면 상태와 그 상태가 된 시각을 붙인다', () => {
  const view = { enabled: true, running: true, error: null, prs: {
    1: { place: 'turn', rank: 1, reason: 'update-branch 뒤 체크 대기', at: AT },
    2: { place: 'queued', rank: 2, reason: '#1 차례 대기', at: AT },
    3: { place: 'ready', rank: null, reason: null, at: AT },
    4: { place: 'out', rank: null, reason: '미해결 스레드 1', at: AT },
    5: { place: 'turn', rank: 1, reason: '머지', at: null },
  } }
  assert.deepEqual(mergeLine(view, 1), { text: '머지 중 · update-branch 뒤 체크 대기', color: 'green', since: SINCE })
  assert.deepEqual(mergeLine(view, 2), { text: '머지 큐 2 번째', color: 'cyan', since: SINCE })
  assert.deepEqual(mergeLine(view, 3), { text: '머지 가능', color: 'green', since: SINCE })
  assert.deepEqual(mergeLine(view, 4), { text: '대기: 미해결 대화 1', color: 'yellow', since: SINCE })
  // 시각을 읽지 못하면 「부터」 를 붙이지 않는다
  assert.deepEqual(mergeLine(view, 5), { text: '머지 중', color: 'green', since: '' })
})

test('큐를 쓰는 저장소라도 그 PR 의 기록이 없으면 줄을 붙이지 않는다', () => {
  const view = { enabled: true, running: false, prs: { 7: { place: 'out', rank: null, reason: 'draft', at: AT } }, error: null }
  assert.equal(mergeLine(view, 8), null)
  assert.equal(mergeLine({ ...view, prs: { 8: { place: 'out', rank: null, reason: null, at: AT } } }, 8), null)
})

test('루프의 대기 이유를 사람이 읽는 말로 옮기고, 모르는 이유는 그대로 둔다', () => {
  assert.equal(waitText('CI pending'), '체크 대기')
  assert.equal(waitText('CI failed'), '체크 실패')
  assert.equal(waitText('CI 없음'), '체크 결과 없음')
  assert.equal(waitText('draft'), 'Draft')
  assert.equal(waitText('미해결 스레드 3'), '미해결 대화 3')
  assert.equal(waitText('리뷰 보류'), '리뷰 보류')
  assert.equal(waitText('리뷰 대기'), '리뷰 대기')
  assert.equal(waitText('재리뷰 대기: block 뒤 같은 커밋이나 그 뒤 커밋의 pass 가 없다'), '재리뷰 대기')
  assert.equal(waitText('지시서 보류: 사용자 확인'), '지시서 보류')
  assert.equal(waitText('기능 완료 근거 블록이 하나 필요하다'), '기능 완료 근거 없음')
  assert.equal(waitText('독립 리뷰 이 완료되지 않았다: 대기'), '기능 완료 근거 없음')
  assert.equal(waitText('core V12 이 #30 V12 을 기다린다'), '마이그레이션 순서 대기(#30 V12)')
  assert.equal(waitText('새 이유'), '새 이유')
})

test('출력에 enabled 가 없으면 형식 오류로 던진다', () => {
  assert.throws(() => parseQueueView(JSON.stringify({ running: false, prs: {}, error: null })), /형식이 달라요/)
  assert.deepEqual(parseQueueView(JSON.stringify({ enabled: true, running: false, prs: {}, error: null })),
    { enabled: true, running: false, prs: {}, error: null })
})
