// launch 의 호출별 격리와 실제 비동기 도구·hook 을 유지한다. 동기 orca 만 함수로 부른다.
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main, reportError } from '../../scripts/worker/launch-worker.ts'
import { createStatefulRun } from './stateful-run.ts'

export const statefulRun = createStatefulRun({
  resolveCommand: (argv, env) => argv[0] === env.ORCA ? argv[0] : undefined,
})

if (import.meta.main || (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), statefulRun).then(
    (code) => { process.exitCode = code },
    reportError,
  )
}
