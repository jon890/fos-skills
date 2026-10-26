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
  const items = readBoard(file)
  const explicit = text.match(/^\s*(?:[-*]\s*)?보드 항목 id\s*:\s*`?([^`\n]+)`?\s*$/m)?.[1].trim()
  // 지시서가 id 를 정하지 않았으면 같은 워크트리나 브랜치의 끝나지 않은 항목을 이어 쓴다.
  // 충돌 후속 지시서로 같은 워크트리에 다시 띄운 worker 가 항목을 하나 더 만들지 않게 한다
  const same = explicit
    ? undefined
    : items.find((row) => row.status !== 'done' && typeof row.id === 'string' && (row.worktree === basename(worktree) || (branch && row.branch === branch)))
  const id = explicit || (same?.id as string | undefined) || name || basename(worktree)
  const title = text.match(/^#\s+(.+)$/m)?.[1].trim() || id
  const bin = process.env.BOARD_BIN || BOARD_BIN
  const item = items.find((row) => row.id === id)
  // 이어 쓰는 항목은 처음 지시서의 제목을 그대로 둔다
  const args = ['set', id, 'doing', ...(same ? [] : ['--title', title]), '--worktree', basename(worktree), '--branch', branch]
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
// worktree 가 그 워크트리 이름인 항목을 찾는다. 브랜치로 찾을 때 done 항목과 merged-pr 에 이미 그 PR 이 든 항목은 뺀다.
// 이미 처리한 머지 PR 을 다시 연결하지 않기 위해서다. 어느 쪽도 없거나 보드를 읽지 못하면 null 이다. 둘 이상이면 ids 에 모두 담는다
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
  const byBranch = items.filter(
    (i) =>
      prNumbers(i.pr).size === 0 &&
      i.status !== 'done' &&
      !prNumbers(i['merged-pr']).has(pr) &&
      ((branch && i.branch === branch) || (worktree && i.worktree === worktree)),
  )
  return byBranch.length > 0 ? { by: 'branch', ids: byBranch.map(id) } : null
}

// 중간 PR 판정이 하위 항목에 남기는 줄의 머리. 단계 줄이 아니라 진행률에 세지 않는다
export const NOTE = '남은 일: '

export type BoardDetail = string | { text: string; done?: unknown }
export type BoardStep = { number: number; done: boolean; text: string }

export function detailText(detail: BoardDetail): string {
  return typeof detail === 'string' ? detail : detail.text
}

// board.ts set 의 --detail 인자. 완료 값은 옛 입력 표시(✓)로 넘긴다. 빈 목록은 하위 항목을 지운다
export function detailArgs(details: BoardDetail[]): string[] {
  if (details.length === 0) return ['--detail', '']
  return details.flatMap((d) => ['--detail', typeof d === 'string' ? d : (d.done === true ? '✓ ' : '') + d.text])
}

// 남은 일 줄. 남은 PR 도 지시서도 없으면 null
export function noteLine(prs: string[], specs: string[]): string | null {
  const parts = [prs.length > 0 ? `PR ${prs.join(' ')}` : '', specs.length > 0 ? `지시서 ${specs.join(' ')}` : ''].filter(Boolean)
  return parts.length > 0 ? NOTE + parts.join(', ') : null
}

// 하위 항목에서 남은 일 줄을 빼고 note 를 붙인 목록
export function withNote(details: BoardDetail[], note: string | null): BoardDetail[] {
  const kept = details.filter((d) => !detailText(d).startsWith(NOTE))
  return note ? [...kept, note] : kept
}

// 끝나지 않은 단계 가운데 그 PR 번호(#N)가 적힌 단계의 번호
export function prSteps(steps: BoardStep[], pr: string): number[] {
  const pattern = new RegExp(`#${pr}(?!\\d)`)
  return steps.filter((step) => !step.done && pattern.test(step.text)).map((step) => step.number)
}

// 중간 PR 을 항목에 반영하는 board.ts 명령. 남은 일 줄을 바꾸고, 그 PR 의 단계를 끝내고, pr 칸을 비우고 merged-pr 에 적는다.
// merged-pr 에 적은 PR 은 board-sync 가 다시 연결하지도 다시 판정하지도 않는다. 남은 일 줄이 단계가 아니라 단계 번호는 그대로다
export function intermediateCommands(id: string, details: BoardDetail[], steps: BoardStep[], pr: string, note: string | null): string[][] {
  const next = withNote(details, note)
  const same = next.length === details.length && next.every((d, i) => d === details[i])
  return [
    ...(same ? [] : [['set', id, ...detailArgs(next)]]),
    ...prSteps(steps, pr).map((n) => ['step', id, String(n)]),
    ['set', id, '--pr', '', '--merged-pr', pr],
  ]
}

// pr 칸이 빈 항목을 브랜치로 찾아 그 PR 번호로 채운다. 채운 항목 id 를 내고, 찾지 못했거나 pr 칸에 이미 든 항목이거나
// 둘 이상이면 null 이다. 보드 명령이 실패하면 Error 다
export function linkBoardPr(file: string, number: string, branch: string): string | null {
  const found = findBoardItems(file, number, branch, null)
  if (!found || found.by !== 'branch' || found.ids.length !== 1) return null
  const bin = process.env.BOARD_BIN || BOARD_BIN
  const done = run(scriptCommand(bin, ['set', found.ids[0], '--pr', number, '--file', file]), { timeoutMs: NO_LIMIT_MS })
  if (done.code !== 0) throw new Error(done.stderr.trim() || `보드 명령 종료 코드 ${done.code}`)
  return found.ids[0]
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
