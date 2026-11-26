import type { Choice } from '../src/choices.ts'
import type { Screen } from '../src/state.ts'
import type { Summary } from '../src/summary.ts'

export const STUDY_ID = 'example-study'
export const REPO_ID = 'example-repo'
export const AUTOMATION_ID = '3f4dbd0c-3d0a-45a5-9bd8-63fb0e28fc83'
export const at = Date.parse('2026-11-27T00:00:00Z')
export const studyChoice: Choice = {
  action: 'choose_study_candidate', item: STUDY_ID, revision: 1, answer: 'write'
}
export function exampleSummary(): Summary {
  const curatedAt = new Date(at).toISOString()
  return {
    schemaVersion: 1, curatedAt, updatedAt: curatedAt,
    study: [{
      id: STUDY_ID, title: '캐시 갱신 순서', question: '동시에 캐시를 갱신하면 어떤 값이 남을까?',
      round: 2, revision: 1, state: 'selectable', error: null,
      outline: ['갱신 순서 비교', '동시 요청 테스트'],
      sources: [{ label: '캐시 실험 메모' }],
      repoIds: [REPO_ID]
    }],
    feedback: [{
      id: 'example-feedback', number: 3, title: '테스트 실패 안내 정리', skill: 'example-skill',
      round: 1, revision: 1, state: 'selectable', error: null,
      candidates: [{ id: 'example-candidate', title: '실패한 테스트 경로 표시', repoId: REPO_ID }]
    }],
    feedbackTotals: { rejected: 4, held: 2 },
    inProgress: [{
      item: 'example-in-progress', title: '재시도 글 초안', activity: 'writing',
      repoId: REPO_ID, pr: { number: 12, state: 'open', draft: true }
    }],
    repositories: [{ id: REPO_ID, name: '예제 저장소', studyCount: 1, feedbackCount: 2 }]
  }
}
export function exampleScreen(): Screen {
  const summary = exampleSummary()
  return { sequence: 1, status: 'ready', configured: true, stale: false, curatedAt: summary.curatedAt, summary, cards: [] }
}
