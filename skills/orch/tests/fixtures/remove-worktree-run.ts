// 삭제는 별도 자식에서 실행하고 동기 조회 가짜만 함수로 바꾼다.
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main, reportError } from '../../scripts/cleanup/remove-worktree.ts'
import { statefulRun } from './cleanup-stateful-run.ts'

if (import.meta.main || (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), statefulRun).then(
    (code) => { process.exitCode = code },
    reportError,
  )
}
