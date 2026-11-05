// 정리가 지우는 launched-workers 와 별개로, 선택 근거와 실험 배정에 쓰는 영구 이력이다.
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Launch } from './launched.ts'
import { ensure, pathOf } from './paths.ts'

export type LaunchHistory = Launch & { at: string; title: string | null; row: string | null; retry_of: string | null }

export function launchHistory(repo: string): LaunchHistory[] {
  let text: string
  try { text = readFileSync(join(pathOf('state', repo), 'launch-history.jsonl'), 'utf8') }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  return text.split('\n').filter(line => line.trim()).map(line => {
    const row = JSON.parse(line)
    if (!row || typeof row.dispatch !== 'string' || typeof row.at !== 'string') throw new Error('띄우기 이력 형식이 틀렸다')
    return row as LaunchHistory
  })
}

export function recordHistory(repo: string, launch: LaunchHistory): void {
  appendFileSync(join(ensure('state', repo), 'launch-history.jsonl'), `${JSON.stringify(launch)}\n`, 'utf8')
}

export function latestTerminal(repo: string, terminal: string): LaunchHistory | null {
  return launchHistory(repo).filter(row => row.terminal === terminal).sort((a, b) => b.at.localeCompare(a.at)).at(0) ?? null
}
