// worker 셸의 PATH 를 가짜로 정하는 도구. lib/worker-path.ts 가 ORCH_WORKER_PATH 를 worker 셸의 PATH 로 읽는다.
// launch 와 resume 을 돌리는 테스트가 이 기계의 셸 설정에 기대지 않게 한다.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LAUNCHER_MARK } from '../../scripts/lib/commands.ts'

// 표지 있는 가짜 실행기를 둔 폴더를 만들고 그 폴더를 PATH 값으로 낸다
export function workerPathWithOrch(root: string): string {
  const dir = join(root, 'worker-bin')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'orch')
  writeFileSync(file, `#!/usr/bin/env node\n// ${LAUNCHER_MARK}\n`)
  chmodSync(file, 0o755)
  return `${dir}:/usr/bin:/bin`
}
