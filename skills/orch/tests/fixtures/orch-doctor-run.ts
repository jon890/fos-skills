// doctor 의 호출별 격리와 실제 git·hook 을 유지한다. 지연 orca 는 실제 실행으로 보낸다.
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main, reportError } from '../../scripts/doctor/orch-doctor.ts'
import { createStatefulRun } from './stateful-run.ts'

export const statefulRun = createStatefulRun({
  resolveCommand(argv, env) {
    if (argv[0] === env.ORCA && !env.FAKE_SLEEP) return argv[0]
    if (argv[0] === env.PS) return argv[0]
    return undefined
  },
})

if (import.meta.main || (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), statefulRun).then(
    (code) => { process.exitCode = code },
    reportError,
  )
}
