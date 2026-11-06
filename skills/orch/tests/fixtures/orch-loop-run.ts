// 루프 자식의 진입점 이름을 유지하며 지연 orca 는 실제 실행으로 보낸다.
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main } from '../../scripts/loop/orch-loop.ts'
import { createStatefulRun } from './stateful-run.ts'

export const statefulRun = createStatefulRun({
  resolveCommand(argv, env) {
    if (![env.GH, env.ORCA, env.PS].filter(Boolean).includes(argv[0])) return undefined
    if (argv[0] === env.ORCA && env.FAKE_DIR && fs.existsSync(`${env.FAKE_DIR}/orca.json`)) {
      try {
        const state = JSON.parse(fs.readFileSync(`${env.FAKE_DIR}/orca.json`, 'utf8'))
        if (state.sleep || state.slow_run_current) return undefined
      } catch {
        // 깨진 상태의 오류도 실제 가짜 자식이 명령 실패로 돌려주게 한다.
        return undefined
      }
    }
    return argv[0]
  },
})

const SELF = fileURLToPath(import.meta.url)
if (import.meta.main || (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === SELF)) {
  main(process.argv.slice(2), statefulRun, SELF).then(
    (code) => { process.exitCode = code },
    (error) => { console.error(error); process.exitCode = 1 },
  )
}
