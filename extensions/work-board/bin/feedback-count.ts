// 보드가 일정 간격으로 실행한다. 후보 파일과 마지막 collect 결과만 읽는다.
import { resolve } from 'node:path'
import { localFeedbackCount } from '../../../skills/orch/scripts/lib/feedback-loop.ts'

const repo = process.argv[2]
if (!repo) {
  console.error('사용법: feedback-count.ts <저장소 경로>')
  process.exitCode = 2
} else {
  try {
    console.log(localFeedbackCount(resolve(repo)))
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
  }
}
