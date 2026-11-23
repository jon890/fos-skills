// 보드용 승인 명령은 이 모듈을 통해 승인 기록과 터미널을 조회한다.
import { resolve } from 'node:path'
import { approvalsFile } from '../approvals.ts'

export { approvalsFile as boardApprovalPath, recordPress, selfIsWorker } from '../approvals.ts'

// 승인 조회가 시작될 때 훅에 경로를 한 번 넘긴다. 훅은 Node 내장 모듈을 불러올 수 없다.
if (import.meta.main) {
  const repo = process.argv[2]
  if (!repo) {
    process.exitCode = 2
  } else {
    process.stdout.write(approvalsFile(resolve(repo)) + '\n')
  }
}
