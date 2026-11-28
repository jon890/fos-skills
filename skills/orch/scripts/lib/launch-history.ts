// 정리가 지우는 launched-workers 와 별개로, 선택 근거와 실험 배정에 쓰는 영구 이력이다.
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { Launch } from './launched.ts'
import { ensure, pathOf } from './paths.ts'

// origin 은 이어 맡기기(lib/continue-worker.ts)로 생긴 후속 dispatch 의 까닭이다. returned 는 머지 전 완료 보고를 되돌린 것, stopped 는 멈춘 worker 이어 보내기다.
// spec_todos, spec_files 는 띄울 때 지시서의 할 일 수와 가리키는 파일 수다(specCounts). 머지 뒤 지시서가 지워져 나중에 셀 수 없다. 옛 이력에는 없다
export type LaunchHistory = Launch & { at: string; title: string | null; row: string | null; retry_of: string | null
  origin?: 'returned' | 'stopped' | null; spec_todos?: number | null; spec_files?: number | null }

// 할 일 수는 「## 할 일」 절의 맨 앞 번호 목록(`1. `) 수, 절이 없으면 null 이다.
// 파일 수는 지시서 전체의 백틱 조각 가운데 경로 꼴(공백 없이 `/` 가 들어가거나 `이름.확장자`)의 서로 다른 수다. URL 과 `:줄` 꼬리는 뺀다
export function specCounts(text: string): { spec_todos: number | null; spec_files: number } {
  const todo = /^## 할 일[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1]
  const files = new Set<string>()
  for (const [, raw] of text.matchAll(/`([^`\n]+)`/g)) {
    const token = raw.replace(/:\d+(?:-\d+)?$/, '')
    if (/\s/.test(token) || /^[a-z]+:\/\//i.test(token) || token.startsWith('-')) continue
    if (/^[\w.~@-]*\/[\w.@[\]/-]*\w/.test(token) || /^[\w.-]+\.[a-z]{1,5}$/i.test(token)) files.add(token)
  }
  return { spec_todos: todo === undefined ? null : todo.split('\n').filter(line => /^\d+\.\s/.test(line)).length, spec_files: files.size }
}

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
