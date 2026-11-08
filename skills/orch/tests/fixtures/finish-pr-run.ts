// main의 호출별 프로세스 격리는 유지하고 동기 CommonJS 조회만 평가한다.
// timeout·입력·비동기 출력·생명주기는 stateful-run의 지원 범위 밖이다.
// git·sweep(워크트리·브랜치 삭제)·send·hook·Python 보드는 실제 자식으로 남긴다.
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main, reportError } from '../../scripts/queue/finish-pr.ts'
import { createStatefulRun } from './stateful-run.ts'

export const statefulRun = createStatefulRun({
  resolveCommand(argv, env) {
    if (argv[0] === env.GH || argv[0] === env.ORCA) return argv[0]
    return undefined
  },
})

if (import.meta.main || (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), statefulRun).then(
    (code) => { process.exitCode = code },
    reportError,
  )
}
