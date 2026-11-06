// 호출별 프로세스 격리를 유지하고 동기 명령 가짜만 공통 평가기로 보낸다.
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main, reportError } from '../../scripts/cleanup/cleanup-sweep.ts'
import { statefulRun } from './cleanup-stateful-run.ts'
export { statefulRun } from './cleanup-stateful-run.ts'

if (import.meta.main || (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), statefulRun).then(
    (code) => { process.exitCode = code },
    reportError,
  )
}
