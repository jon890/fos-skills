import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// 보드 파일의 기본 위치. cwd 의 git 작업 트리 최상위(--show-toplevel)가 기준이고, git 밖이면 cwd 다.
// 주 checkout 이 아니라 작업 트리 기준이다.
export function defaultBoardPath(cwd: string): string {
  const done = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const top = done.status === 0 ? (done.stdout ?? '').trim() : ''
  const root = top || cwd
  const legacy = join(root, '.omc/handoffs/board.json')
  return existsSync(legacy) ? legacy : join(root, '.omc/board.json')
}
