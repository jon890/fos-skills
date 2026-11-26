import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel.tsx'
import type { Choice } from './choices.ts'
import { exampleScreen, studyChoice } from '../tests/fixtures.ts'

test('draws study, feedback, repository totals and work in progress', async () => {
  const data = exampleScreen()
  data.summary!.inProgress.push({
    item: 'example-applying', title: '반영 준비', activity: 'applying', repoId: 'repo-with-zero-counts', pr: null
  })
  data.summary!.repositories.push({ id: 'zero', name: '빈 저장소', studyCount: 0, feedbackCount: 0 })
  const view = await mount(panel, { host: mockHost({ requests: { 'studyPanel.get': () => data } }) })
  try {
    assert.ok(view.find({ text: '동시에 캐시를 갱신하면 어떤 값이 남을까?' }))
    assert.ok(view.find({ text: '캐시 실험 메모' }))
    assert.ok(view.find({ text: '글 쓰는 중' }))
    assert.ok(view.find({ text: '반영 요청 중' }))
    assert.ok(view.find({ text: '요약에 저장소 이름 없음' }))
    assert.ok(view.find({ text: 'PR #12 · 초안' }))
    assert.match(JSON.stringify(view.tree()), /갱신 순서 비교/)
    await view.select({ label: '공부·피드백 목록' }, 'feedback')
    assert.equal(view.valueOf({ label: '공부·피드백 목록' }), 'feedback')
    for (const text of ['실패한 테스트 경로 표시', '기각 4', '보류 2']) {
      assert.ok(view.find({ text }), text)
    }
    assert.match(JSON.stringify(view.tree()), /3\. 테스트 실패 안내 정리.*example-skill/)
    await view.select({ label: '공부·피드백 목록' }, 'repos')
    assert.ok(view.find({ text: '공부 1 · 피드백 2' }))
    assert.doesNotMatch(JSON.stringify(view.tree()), /빈 저장소|repo-with-zero-counts/)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  } finally {
    await view.unmount()
  }
})

test('requires a reason, shows accepted and waiting states and ignores older events', async () => {
  const data = exampleScreen()
  const received: Choice[] = []
  const sentAt = '2026-11-27T00:15:00Z'
  const sent = { ...studyChoice, sentAt, status: 'sent' as const }
  const host = mockHost({ requests: {
    'studyPanel.get': () => data,
    'studyPanel.choose': (choice) => {
      received.push(choice)
      return { sentAt, screen: { ...data, sequence: 2, cards: [sent] } }
    }
  } })
  const view = await mount(panel, { host })
  try {
    await view.press({ text: '빼기' })
    assert.equal(view.find({ text: '보내기' })?.disabled, true)
    assert.deepEqual(received, [])
    await view.type({ label: '빼기 이유' }, '이미 다룬 주제')
    await view.press({ text: '보내기' })
    assert.deepEqual(received, [{ ...studyChoice, answer: 'drop', reason: '이미 다룬 주제' }])
    assert.ok(view.find({ text: '보냄 09:15' }))
    assert.equal(view.find({ text: '글로 쓰기' })?.disabled, true)
    await view.post('studyPanel.changed', { ...data, sequence: 3, cards: [{ ...sent, status: 'waiting' }] })
    await view.post('studyPanel.changed', data)
    assert.ok(view.find({ text: '처리 대기' }))
    assert.equal(view.find({ text: '글로 쓰기' })?.disabled, false)
    data.summary!.study[0].error = { code: 'example', message: '봇에서 반영하지 못했습니다.' }
    await view.post('studyPanel.changed', { ...data, sequence: 4, status: 'read_failed', stale: true })
    for (const text of ['봇에서 반영하지 못했습니다.', '읽기 실패', '오래됨']) assert.ok(view.find({ text }), text)
    assert.equal(view.find({ text: '글로 쓰기' })?.disabled, true)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})
