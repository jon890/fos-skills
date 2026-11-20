// 보드가 일정 간격으로 실행한다. collectFeedback의 PR 조회 결과를 그 사이 캐시한다.
import { resolve } from 'node:path'
import { actionableFeedbackCount, collectFeedback } from '../../../skills/orch/scripts/lib/feedback-loop.ts'

const repo = process.argv[2]
if (!repo) {
  console.error('사용법: feedback-count.ts <저장소 경로>')
  process.exitCode = 2
} else {
  try {
    const collected = collectFeedback()
    console.log(actionableFeedbackCount(collected, resolve(repo)))
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
  }
}
