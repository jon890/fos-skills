// orch 가 쓰는 보드 경로: 명시 값, finish.board, work-board 기본 위치 순서다.
// config 가 paths 를 읽으므로 설정을 읽는 경로 함수는 이 모듈에 둔다.
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultBoardPath } from '../../../../extensions/work-board/bin/board.ts'
import { ConfigError, loadConfig } from './config.ts'
import { real } from './fs.ts'
import { mainCheckout } from './git.ts'

export const BOARD_BIN = fileURLToPath(new URL('../../../../extensions/work-board/bin/board.ts', import.meta.url))

export function staleBoardWrite(command: string[], result: { code: number; stderr: string }): boolean {
  return command.includes('--if-rev') && result.code === 1 &&
    result.stderr.split('\n').some((line) => line.endsWith(`읽은 뒤 ${command[1]} 의 줄이 바뀌어 저장하지 않았다. 다시 읽어 판정한다`))
}

export function boardPath(repo: string, explicit?: string | null): string {
  let value = explicit
  if (!value) {
    const configured = loadConfig(repo).finish?.board
    if (configured !== undefined && typeof configured !== 'string') throw new ConfigError('finish.board 는 문자열이어야 한다')
    value = configured as string | undefined
  }
  if (!value) return defaultBoardPath(real(repo))
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  return isAbsolute(expanded) ? expanded : join(mainCheckout(repo), expanded)
}
