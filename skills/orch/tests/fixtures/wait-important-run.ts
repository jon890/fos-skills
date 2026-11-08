// 동기 조회만 평가한다. check --wait는 출력·시간 제한·자식 종료를 보므로 실제 spawn한다.
// stateful-run의 입력·출력 한도·비동기·상대 파일 접근 제약을 그대로 따른다.
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main, reportError } from '../../scripts/wait/wait-important.ts'
import { createStatefulRun } from './stateful-run.ts'

export const statefulRun = createStatefulRun({
  resolveCommand(argv, env) {
    if (argv[0] === env.GH) return argv[0]
    if (argv[0] !== env.ORCA) return undefined
    const [group, command] = argv.slice(1)
    if (group === 'terminal' && command === 'read') return argv[0]
    if (group !== 'orchestration') return undefined
    if (['worker-list', 'task-list', 'dispatch-show', 'inbox'].includes(command)) return argv[0]
    if (command === 'check' && argv.includes('--all')) return argv[0]
    return undefined
  },
})

if (import.meta.main || (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), statefulRun).then(
    (code) => { process.exitCode = code },
    reportError,
  )
}
