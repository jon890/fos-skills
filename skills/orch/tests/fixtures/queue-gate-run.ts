// gate.ts 를 가짜 gh, git 으로 돌린다. merge-queue-run.ts 와 같은 함수 가짜를 쓴다.
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main } from '../../scripts/queue/gate.ts'
import { statefulRun } from './merge-queue-run.ts'

if (import.meta.main || (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), statefulRun(process.env.MERGE_QUEUE_FAKE_GIT === '1')).then(
    (code) => { process.exitCode = code },
    (error) => { console.error(error); process.exitCode = 1 },
  )
}
