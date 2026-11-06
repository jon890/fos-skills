// 정리가 지우는 launched-workers 와 별개로, 선택 근거와 실험 배정에 쓰는 영구 이력이다.
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { Launch } from './launched.ts'
import { ensure, pathOf } from './paths.ts'

export type LaunchHistory = Launch & { at: string; title: string | null; row: string | null; retry_of: string | null }

export function launchHistory(repo: string): LaunchHistory[] {
  let text: string
  try { text = readFileSync(join(pathOf('state', repo), 'launch-history.jsonl'), 'utf8') }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  return text.split('\n').flatMap((line, index) => {
    if (!line.trim()) return []
    try {
      const row = JSON.parse(line)
      if (!row || typeof row.dispatch !== 'string' || !row.dispatch ||
          typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at)) ||
          typeof row.worktree !== 'string' || !row.worktree) throw new Error('필수 필드 형식 오류')
      return [row as LaunchHistory]
    } catch {
      process.stderr.write(`LAUNCH-HISTORY-SKIP ${join(pathOf('state', repo), 'launch-history.jsonl')}:${index + 1} 손상된 줄을 건너뛴다\n`)
      return []
    }
  })
}

export function recordHistory(repo: string, launch: LaunchHistory): void {
  const file = join(ensure('state', repo), 'launch-history.jsonl')
  let separator = ''
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    if (size) {
      const last = Buffer.alloc(1)
      readSync(fd, last, 0, 1, size - 1)
      if (last[0] !== 10) separator = '\n'
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  } finally { if (fd !== undefined) closeSync(fd) }
  appendFileSync(file, `${separator}${JSON.stringify(launch)}\n`, 'utf8')
}

export function latestTerminal(repo: string, terminal: string): LaunchHistory | null {
  return launchHistory(repo).filter(row => row.terminal === terminal).sort((a, b) => b.at.localeCompare(a.at)).at(0) ?? null
}
