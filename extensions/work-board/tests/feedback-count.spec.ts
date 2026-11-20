import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionableFeedbackCount, type FeedbackCollected, type FeedbackRow } from '../../../skills/orch/scripts/lib/feedback-loop.ts'

const core = { name: 'fos-skills', path: '/core' }
const other = { name: 'service', path: '/service' }
function row(repo: typeof core, target: string, status: string, group: string): FeedbackRow {
  return { repo, group, candidate: { title: '후보', slug: 'case', file: '', text: '', values: { 대상: target, 상태: status } as FeedbackRow['candidate']['values'] } }
}

test('보드는 자기 몫과 받을 알림만 세며 보류와 버전 대기를 뺀다', () => {
  const collected: FeedbackCollected = { core, errors: [], rows: [
    row(other, 'core 스킬', '후보', '판정할 core 후보'),
    row(other, '이 저장소', '후보', '저장소 몫'),
    row(core, '이 저장소', '후보', '저장소 몫'),
    row(other, 'core 스킬', '채택 #12', '보낼 알림'),
    row(other, 'core 스킬', '반영됨 #12 (1.0)', '받은 알림'),
    row(other, 'core 스킬', '보류(나중)', '보류'),
    row(other, 'core 스킬', '채택 #13', '버전 대기'),
  ] }
  assert.equal(actionableFeedbackCount(collected, core.path), 3)
  assert.equal(actionableFeedbackCount(collected, other.path), 2)
})
