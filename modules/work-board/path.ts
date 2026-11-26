import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BOARD_PATHS } from './locations.ts'

export { BOARD_PATHS } from './locations.ts'

// 호출한 git 작업 트리의 최상위. git 밖에서는 세션의 홈 보드를 쓴다.
export function boardRoot(cwd: string): string {
  const done = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const top = done.status === 0 ? (done.stdout ?? '').trim() : ''
  return top || homedir()
}

export function defaultBoardPath(cwd: string): string {
  const root = boardRoot(cwd)
  const paths = BOARD_PATHS.map(path => join(root, path))
  return paths.find(path => existsSync(path)) ?? paths[0]
}
