// 알림 main 의 호출별 프로세스 격리는 유지하고 gh·orca 가짜만 함수로 실행한다.
import { main, reportError } from '../../scripts/queue/notify-conflicts.ts'
import { statefulRun } from './cleanup-sweep-run.ts'

if (import.meta.main) {
  main(process.argv.slice(2), statefulRun).then(
    (code) => { process.exitCode = code },
    reportError,
  )
}
