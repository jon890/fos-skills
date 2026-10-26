// worker 띄우기와 루프가 함께 쓰는 보드 연동. 쓰기는 board.ts 에 맡긴다.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boardPath, pathOf } from './paths.ts'
import { NO_LIMIT_MS, run, scriptCommand } from './proc.ts'

export const BOARD_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../work-board/bin/board.ts')
export type BoardItem = Record<string, unknown> & { id: string }
export function readBoard(file: string): BoardItem[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')).items
  if (!raw || typeof raw !== 'object') throw new Error('보드 items 가 목록이나 객체가 아니다')
  return Array.isArray(raw) ? raw : Object.values(raw)
}

export function registerBoard(repo: string, spec: string, worktree: string, name: string, branch: string): void {
  const file = boardPath(repo)
  if (!existsSync(file)) return
  const text = readFileSync(spec, 'utf8')
  const id = text.match(/^\s*(?:[-*]\s*)?보드 항목 id\s*:\s*`?([^`\n]+)`?\s*$/m)?.[1].trim() || name || basename(worktree)
  const title = text.match(/^#\s+(.+)$/m)?.[1].trim() || id
  const bin = process.env.BOARD_BIN || BOARD_BIN
  const item = readBoard(file).find((row) => row.id === id)
  const args = ['set', id, 'doing', '--title', title, '--worktree', basename(worktree), '--branch', branch]
  if (item) {
    const steps = run(scriptCommand(bin, ['steps', id, '--file', file]), { timeoutMs: NO_LIMIT_MS })
    if (steps.code !== 0) throw new Error(steps.stderr || '단계 목록을 읽지 못했다')
    if (JSON.parse(steps.stdout).length) return write(args)
  }
  const todo = text.match(/^##\s+할 일[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1] || ''
  const steps = todo.split('\n').filter((line) => /^\d+[.)]?\s/.test(line))
  for (const step of steps.length ? steps : ['1. 구현', '2. 리뷰 반영', '3. 머지']) args.push('--detail', step)
  write(args)
  function write(args: string[]): void {
    const done = run(scriptCommand(bin, [...args, '--file', file]), { timeoutMs: NO_LIMIT_MS })
    if (done.code !== 0) throw new Error(done.stderr || `보드 명령 종료 코드 ${done.code}`)
  }
}

// 보드 항목의 pr 칸(`#492`, `492, 495`, `492/495`)에 든 PR 번호들. 글자에 붙은 숫자(`#492 (v2)` 의 `2`)는 읽지 않는다.
// 옮기기 전 Python 의 \w 가 한글도 글자로 보았으므로 유니코드 글자와 숫자를 글자로 센다
export function prNumbers(field: unknown): Set<string> {
  const text = !field ? '' : typeof field === 'string' ? field : JSON.stringify(field)
  return new Set([...text.matchAll(/(?<![\p{L}\p{N}_])#?(\d+)(?![\p{L}\p{N}_])/gu)].map((m) => m[1]))
}

export type BoardMatch = { by: 'pr' | 'branch'; ids: string[] }

// 머지한 PR 의 보드 항목. pr 칸에 그 PR 이 든 항목을 먼저 찾고, 없으면 pr 칸이 빈 항목 가운데 branch 가 PR 브랜치이거나
// worktree 가 그 워크트리 이름인 항목을 찾는다. 어느 쪽도 없거나 보드를 읽지 못하면 null 이다. 둘 이상이면 ids 에 모두 담는다
export function findBoardItems(file: string, pr: string, branch: string, worktree: string | null): BoardMatch | null {
  let items: BoardItem[]
  try {
    items = readBoard(file).filter((i) => typeof i === 'object' && i !== null && !Array.isArray(i) && Boolean(i.id))
  } catch {
    return null
  }
  const id = (i: BoardItem) => (typeof i.id === 'string' ? i.id : JSON.stringify(i.id))
  const byPr = items.filter((i) => prNumbers(i.pr).has(pr))
  if (byPr.length > 0) return { by: 'pr', ids: byPr.map(id) }
  const byBranch = items.filter((i) => prNumbers(i.pr).size === 0 && ((branch && i.branch === branch) || (worktree && i.worktree === worktree)))
  return byBranch.length > 0 ? { by: 'branch', ids: byBranch.map(id) } : null
}

// 알림을 기록한 뒤에만 해시를 저장한다. 사라진 항목은 잊어 다시 생겼을 때 알린다.
export function remindDecisions(repo: string, notify: (text: string) => void): void {
  const file = boardPath(repo)
  if (!existsSync(file)) return
  const stateFile = resolve(pathOf('state', repo), 'board-decisions.json')
  const before: Record<string, string> = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {}
  const next: Record<string, string> = {}
  for (const item of readBoard(file).filter((row) => row.status === 'decide')) {
    const lines = (value: unknown) => (Array.isArray(value) ? value : String(value || '').split('\n')).map((line) => typeof line === 'string' ? line : line.text)
    const hash = createHash('sha256').update(JSON.stringify([item.title, lines(item.details), lines(item.next)])).digest('hex')
    if (before[item.id] !== hash) notify(`정할 것 ${item.id}: ${item.title || item.id}`)
    next[item.id] = hash
  }
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(next))
  renameSync(`${stateFile}.tmp`, stateFile)
}
