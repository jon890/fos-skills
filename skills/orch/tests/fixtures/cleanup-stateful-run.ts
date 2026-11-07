// 정리·알림의 허용 명령과 fixture PATH 만 소유한다. 운영 진입점을 import 하지 않는다.
import * as fs from 'node:fs'
import { delimiter, join } from 'node:path'
import { createStatefulRun } from './stateful-run.ts'

export const statefulRun = createStatefulRun({
  resolveCommand(argv, env) {
    let command = argv[0]
    // lsof 와 ps 만 fixture 의 PATH 에서 푼다. 다른 상대 경로는 실제 실행 경계에 둔다.
    if (command === 'lsof' || command === 'ps') {
      const first = (env.PATH ?? '').split(delimiter).map((dir) => join(dir, command)).find((file) => {
        try { fs.accessSync(file, fs.constants.X_OK); return true } catch { return false }
      })
      if (!env.CLEANUP_FAKE_BIN || first !== join(env.CLEANUP_FAKE_BIN, command)) return undefined
      command = first
    } else if (![env.GH, env.ORCA, env.ORCH_KILL, env.DOCKER].includes(command)) return undefined
    return command
  },
})
