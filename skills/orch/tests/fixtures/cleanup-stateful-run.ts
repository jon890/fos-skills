// 정리·알림의 허용 명령과 fixture PATH 만 소유한다. 운영 진입점을 import 하지 않는다.
import * as fs from 'node:fs'
import { delimiter, join } from 'node:path'
import { runProcess, type Runner } from '../../scripts/lib/proc.ts'
import { fileURLToPath } from 'node:url'
import { createStatefulRun } from './stateful-run.ts'

const fakeRun = createStatefulRun({
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

const remove = fileURLToPath(new URL('../../scripts/cleanup/remove-worktree.ts', import.meta.url))
const removeRunner = fileURLToPath(new URL('./remove-worktree-run.ts', import.meta.url))
export const statefulRun: Runner = (argv, opts) => {
  // 실제 삭제 자식의 격리·timeout·신호는 유지한다. 자식 안의 동기 가짜만 재사용한다.
  const at = argv[1] === '--disable-warning=ExperimentalWarning' ? 2 : 1
  if (argv[0] === process.execPath && argv[at] === remove) {
    return runProcess([...argv.slice(0, at), removeRunner, ...argv.slice(at + 1)], opts)
  }
  return fakeRun(argv, opts)
}
