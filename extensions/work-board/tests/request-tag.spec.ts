import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestNumberText, requestView } from '../hooks/request-tag.js'

test('새 요청 항목은 칸과 id 에서 보낸 곳과 번호를 읽는다', () => {
  assert.deepEqual(requestView({ id: 'req-fos-skills-46', title: '보드 단계 정리', 'request-from': 'ai-analysis' }),
    { tag: '[ai-analysis 요청]', number: 46, title: '보드 단계 정리' })
  assert.deepEqual(requestView({ id: 'req-fos-skills-46', title: '보드 단계 정리', 'request-to': 'fos-skills' }),
    { tag: '[fos-skills 에 보낸 요청]', number: 46, title: '보드 단계 정리' })
  // 같은 저장소 안의 요청은 앞 표시가 없다. 옛 id req-<n> 도 읽는다
  assert.deepEqual(requestView({ id: 'req-3', title: '정리' }), { tag: null, number: 3, title: '정리' })
  assert.equal(requestNumberText(46), '요청 46')
})

test('옛 제목에서 보낸 곳, 받는 곳, 번호, 본래 제목을 읽는다', () => {
  assert.deepEqual(requestView({ id: 'req-fos-skills-46', title: '요청 R46: 보드 단계 정리 (ai-analysis)' }),
    { tag: '[ai-analysis 요청]', number: 46, title: '보드 단계 정리' })
  assert.deepEqual(requestView({ id: 'req-fos-skills-46', title: 'fos-skills 요청 R46 기다림: 보드 단계 정리' }),
    { tag: '[fos-skills 에 보낸 요청]', number: 46, title: '보드 단계 정리' })
  assert.deepEqual(requestView({ id: 'req-5', title: '요청 R5: 같은 저장소 일' }), { tag: null, number: 5, title: '같은 저장소 일' })
  // id 가 요청 꼴이 아니어도 옛 제목이면 읽는다
  assert.deepEqual(requestView({ id: 'x', title: '요청 R9: 고침 (repo)' }), { tag: '[repo 요청]', number: 9, title: '고침' })
})

test('요청 항목이 아니면 null 이다', () => {
  for (const item of [{ id: 'order-api', title: '주문 이력 조회 API' }, { id: 'request-9', title: '요청 정리' }, { id: 'req-x', title: 'x' }])
    assert.equal(requestView(item), null)
})
