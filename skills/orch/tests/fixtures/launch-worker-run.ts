// 함수 평가에는 timeoutMs·input·maxBuffer 를 적용하지 않는다.
// 지연·입력·출력 한도를 검증하는 가짜는 resolveCommand 에서 undefined 를 돌려 실제 실행으로 넘긴다.
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
