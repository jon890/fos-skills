// worker 띄우기와 루프가 함께 쓰는 보드 연동. 쓰기는 board.ts 에 맡긴다.
// 지시서에 `중간 과정:` 줄이 있으면 띄울 때 항목을 만들지 않고 그 PR 의 기존 항목에 한 줄만 남긴다.
// `보드 항목 id:` 로 정한 항목이 done 이면 doing 으로 다시 열고 지난 단계 뒤에 새 단계를 잇는다(ADR-015).
// 새 단계는 지시서의 「할 일」 이 아니라 사용자 마일스톤 단계다(lib/milestones.ts, ADR-018)
import { parseEventTag } from '../../../work-board/hooks/event-tags.js'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boardSettings, DEFAULT_STEPS, DEFAULT_TASK_LINE, milestoneLines, specSteps, stagesText } from './milestones.ts'
import { loadConfig } from './config.ts'
import { boardPath, pathOf } from './paths.ts'
import { NO_LIMIT_MS, run, scriptCommand } from './proc.ts'

export const BOARD_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../work-board/bin/board.ts')
export type BoardItem = Record<string, unknown> & { id: string }
export function readBoard(file: string): BoardItem[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')).items
  if (!raw || typeof raw !== 'object') throw new Error('보드 items 가 목록이나 객체가 아니다')
  return Array.isArray(raw) ? raw : Object.values(raw)
}

// CI 고침, 리뷰 반영, 충돌 해결처럼 기존 PR 을 마무리하는 지시서의 줄 머리. 단계 줄이 아니라 진행률에 세지 않는다
export const INTERIM = '중간 과정: '

// 지시서 머리(첫 `## ` 제목 앞)의 `중간 과정:` 줄. 할 일 본문이 그 줄을 인용해도 잡지 않는다.
// 줄이 없으면 null 이고, 값에 PR 번호(#N 을 먼저, 없으면 첫 숫자)가 없으면 pr 이 null 이다
export function interimOf(text: string): { pr: string | null } | null {
  const head = text.split(/^##\s/m)[0]
  const value = head.match(/^\s*(?:[-*]\s*)?중간 과정\s*:\s*(.+)$/m)?.[1]
  if (value === undefined) return null
  return { pr: value.match(/#(\d+)/)?.[1] ?? value.match(/\d+/)?.[0] ?? null }
}

// board.ts 가 하위 항목 앞에 붙이는 완료 표시. hooks/register.js 의 STEP 과 같은 표시다
const LEAD_MARK = /^\s*(?:✓|\[[xX ]\]|▶|◇)\s*/

// 띄운 worker 를 보드 항목에 붙인다. 순서대로 하나만 한다.
// 1. `중간 과정:` 줄이 있으면 done, decide, goal 이 아닌 항목 가운데 pr 칸에 그 PR 이 든 항목을, 없으면 같은 브랜치나 워크트리의 항목을 찾는다.
//    찾은 항목 하나에 `중간 과정: <지시서 제목>` 줄 하나만 바꿔 두고 status, 제목, pr 은 그대로 둔다. 없거나 둘 이상이면 보드를 쓰지 않고 Error 다
// 2. `보드 항목 id:` 로 정한 항목이 done 이면 다시 연다. 지난 줄은 완료로 두고(남은 일 줄과 중간 과정 줄은 뺀다) 마일스톤 단계를 다음 번호부터 붙이고
//    stages 칸을 새 번호로 바꾼다. pr 칸의 머지된 PR 은 merged-pr 의 맨 앞으로 옮겨 board-sync 가 다시 연결하지 않게 한다. 제목은 바꾸지 않는다
// 3. 그 밖에는 지시서의 id, 같은 워크트리나 브랜치의 끝나지 않은 항목, 같은 업무 번호의 끝나지 않은 항목, --name, 워크트리 이름 순으로 항목을 정한다.
//    업무 번호는 지시서의 업무 연결 줄(taskOf)에서 읽고, 제목에 그 번호가 든 항목을 같은 업무로 본다. done, decide, goal 항목은 보지 않는다.
//    항목이 이미 있으면 제목과 단계는 그대로 두고 워크트리와 브랜치만 바꿔 doing 으로 둔다. 새 항목만 specTitle 의 제목과 마일스톤 단계로 만든다
// 마일스톤 단계는 지시서의 `## 보드 단계` 절, config.json 의 board.steps, 기본값 순으로 처음 있는 것이다.
// 설정이 틀리면 ConfigError 다. 지시서의 「할 일」 줄은 보드에 올리지 않는다. 구현 세부라 머지와 배포로 끝낼 수 없다
// 보드 파일이 없으면 넘어간다. 단 설정이 보드를 가리키면 Error 로 알린다
export function registerBoard(repo: string, spec: string, worktree: string, name: string, branch: string): void {
  const file = boardPath(repo)
  if (!existsSync(file)) {
    const config = loadConfig(repo)
    const named = [config.finish?.board && 'finish.board', config.cleanup?.board && 'cleanup.board', config.board && 'board 절'].filter(Boolean)
    if (named.length > 0) throw new Error(`설정 파일에 ${named.join(', ')} 이 있지만 보드 파일이 없다: ${file}. {"items":[]} 로 만들면 다음부터 항목을 만든다`)
    return
  }
  const text = readFileSync(spec, 'utf8')
  const items = readBoard(file)
  const task = taskOf(text, boardSettings(repo).taskLine)
  const bin = process.env.BOARD_BIN || BOARD_BIN
  const heading = text.match(/^#\s+(.+)$/m)?.[1].trim()
  const lines = (value: unknown): BoardDetail[] => (Array.isArray(value) ? value : value ? String(value).split('\n') : [])
  // 옛 문자열 줄은 앞에 완료 표시(✓)가 붙어 있어 떼고 본다
  const plain = (d: BoardDetail) => detailText(d).replace(LEAD_MARK, '')
  // 중간 과정과 다시 열기는 기존 항목을 고쳐, 브랜치를 읽지 못했으면 항목의 branch 칸을 지우지 않게 넘기지 않는다
  const branchArgs = branch ? ['--branch', branch] : []
  const interim = interimOf(text)
  if (interim) {
    // 결정 항목과 목표 항목은 업무 항목이 아니라 중간 과정을 붙이지 않는다
    const open = items.filter((row) => !['done', 'decide', 'goal'].includes(String(row.status)) && typeof row.id === 'string')
    let found = interim.pr ? open.filter((row) => prNumbers(row.pr).has(interim.pr as string)) : []
    // CI 고침 worker 의 항목은 대개 pr 칸이 차 있어, pr 칸이 빈 항목만 보는 findBoardItems 를 쓰지 않는다
    if (found.length === 0) found = open.filter((row) => row.worktree === basename(worktree) || (branch && row.branch === branch))
    if (found.length !== 1) {
      const why = found.length === 0 ? `PR ${interim.pr ?? '번호 없음'}, 브랜치 ${branch || '없음'}, 워크트리 ${basename(worktree)} 의 항목이 없다` : `항목이 둘 이상이다: ${found.map((row) => row.id).join(', ')}`
      throw new Error(`중간 과정 지시서의 보드 항목을 찾지 못해 만들지 않는다: ${why}`)
    }
    const kept = lines(found[0].details).filter((d) => !plain(d).startsWith(INTERIM))
    return write(['set', found[0].id, '--worktree', basename(worktree), ...branchArgs, ...detailArgs([...kept, INTERIM + (heading || basename(spec))])])
  }
  const explicit = text.match(/^\s*(?:[-*]\s*)?보드 항목 id\s*:\s*`?([^`\n]+)`?\s*$/m)?.[1].trim()
  // 지시서가 id 를 정하지 않았으면 같은 워크트리나 브랜치의 끝나지 않은 항목을 이어 쓴다.
  // 충돌 후속 지시서로 같은 워크트리에 다시 띄운 worker 가 항목을 하나 더 만들지 않게 한다
  // 그다음은 같은 업무 번호의 항목이다. 한 업무의 다음 PR 이나 확인 작업을 다른 워크트리에서 띄워도 진행률이 한 항목에 모인다
  const open = items.filter((row) => row.status !== 'done' && typeof row.id === 'string')
  const same = explicit
    ? undefined
    : (open.find((row) => row.worktree === basename(worktree) || (branch && row.branch === branch)) ??
      (task ? open.find((row) => !['decide', 'goal'].includes(String(row.status)) && hasTask(row.title, task.number)) : undefined))
  const id = explicit || (same?.id as string | undefined) || name || basename(worktree)
  const title = specTitle(text, { items, explicit, task, id })
  const item = items.find((row) => row.id === id)
  // 지시서 절이 있으면 설정을 읽지 않는다. 기존 항목은 단계를 바꾸지 않아 다시 열 때만 단계를 만든다
  const milestones = () => {
    const given = specSteps(text)
    if (given) return given
    return boardSettings(repo).steps ?? [...DEFAULT_STEPS]
  }
  if (item && explicit && item.status === 'done') {
    const old = lines(item.details)
      .map(plain)
      .filter((text) => !text.startsWith(NOTE) && !text.startsWith(INTERIM))
      .map((text) => ({ text, done: true }))
    // next 에만 단계가 있던 항목도 그 번호 다음부터 잇는다
    const numbers = [...old.map((d) => d.text), ...lines(item.next).map(plain)].map((text) => Number(/^(\d+)[.)]?\s/.exec(text)?.[1] ?? 0))
    const added = milestoneLines(milestones(), Math.max(0, ...numbers) + 1)
    // progress 칸에 옛 값(3/3)이 남아 있으면 단계 수보다 앞서 진행률이 100% 로 남아 지운다.
    // 제목은 사용자가 정한 마일스톤이라 이어 띄운 지시서의 머리줄로 바꾸지 않는다
    const args = ['set', id, 'doing', '--worktree', basename(worktree), ...branchArgs, '--progress', 'auto', '--stages', stagesText(added.stages)]
    const merged = [...prNumbers(item.pr)]
    if (merged.length) args.push('--pr', '', '--merged-pr', [...new Set([...merged, ...prNumbers(item['merged-pr'])])].join(', '))
    return write([...args, ...detailArgs([...old, ...added.details])])
  }
  // 이미 있는 끝나지 않은 항목은 제목과 단계를 그대로 두고 worker 의 워크트리와 브랜치만 바꾼다.
  // 이어 띄운 지시서(충돌 풀기, CI 고침)의 머리줄과 할 일이 마일스톤 제목과 단계를 덮지 않게 한다.
  // 단계도 progress 도 없는 항목을 doing 으로 두면 board.ts 가 거절해 status 도 그대로 둔다
  if (item) {
    const known = run(scriptCommand(bin, ['steps', id, '--file', file]), { timeoutMs: NO_LIMIT_MS })
    if (known.code !== 0) throw new Error(known.stderr || '단계 목록을 읽지 못했다')
    const ready = JSON.parse(known.stdout).length > 0 || /^\s*\d+\s*\/\s*\d+\s*$/.test(String(item.progress ?? ''))
    return write(['set', id, ...(ready ? ['doing'] : []), '--worktree', basename(worktree), ...branchArgs])
  }
  const fresh = milestoneLines(milestones())
  const stages = stagesText(fresh.stages)
  const args = ['set', id, 'doing', '--title', title, '--worktree', basename(worktree), '--branch', branch, ...(stages ? ['--stages', stages] : [])]
  for (const step of fresh.details) args.push('--detail', step)
  write(args)
  function write(args: string[]): void {
    const done = run(scriptCommand(bin, [...args, '--file', file]), { timeoutMs: NO_LIMIT_MS })
    if (done.code !== 0) throw new Error(done.stderr || `보드 명령 종료 코드 ${done.code}`)
  }
}

export type SpecTask = { number: string; title: string | null }

// 지시서의 업무 연결 줄(`두레이 업무: AI-스마트홈-AI/282 「제목」`)에서 읽은 업무 번호와 제목. 줄이 없으면 null 이다.
// pattern 은 board.task_line(lib/milestones.ts 의 boardSettings)이고 없으면 DEFAULT_TASK_LINE 이다.
// 이름 붙은 묶음 number 가 번호, title 이 제목이다. 제목 묶음이 없거나 비었으면 title 은 null 이다
export function taskOf(text: string, pattern: RegExp | null = null): SpecTask | null {
  const groups = (pattern ?? DEFAULT_TASK_LINE).exec(text)?.groups
  const number = groups?.number?.trim()
  if (!number) return null
  return { number, title: groups?.title?.trim() || null }
}

// 제목에 업무 번호가 든 항목인지. 번호 뒤에 숫자가 이어지면(`/282` 와 `/2821`) 다른 업무다
export function hasTask(title: unknown, number: string): boolean {
  if (typeof title !== 'string') return false
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}_/-])${escaped}(?!\\p{N})`, 'u').test(title)
}

// `## 목표` 절의 첫 문장. 목록 기호와 굵게 표시는 뗀다. 절이 없거나 비었으면 null 이다
export function goalSentence(text: string): string | null {
  const body = text.match(/^##\s+목표[^\n]*\n([\s\S]*?)(?=^#{1,2}\s|$(?![\s\S]))/m)?.[1]
  const line = body
    ?.split('\n')
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').replaceAll('**', '').trim())
    .find(Boolean)
  if (!line) return null
  return line.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? line
}

// 새 보드 항목의 제목. 아래 순서로 처음 있는 것이다. spec-lint 의 제목 경고와 references/spec-writing.md 의 지시서 첫 줄이 이 순서를 가리킨다
//   1. 지시서의 `# ` 제목 줄
//   2. `보드 항목 id:` 가 가리키는 기존 항목의 제목. 사용자가 정한 제목이라 업무 번호를 붙이지 않는다
//   3. 업무 연결 줄의 제목
//   4. `## 목표` 절의 첫 문장
//   5. 항목 id
// 업무 번호가 있고 제목에 아직 없으면 앞에 붙인다
export function specTitle(text: string, opts: { items: BoardItem[]; explicit?: string; task: SpecTask | null; id: string }): string {
  const heading = text.match(/^#\s+(.+)$/m)?.[1].trim()
  const existing = opts.explicit ? opts.items.find((row) => row.id === opts.explicit)?.title : undefined
  if (!heading && typeof existing === 'string' && existing.trim()) return existing.trim()
  const title = heading || opts.task?.title || goalSentence(text) || opts.id
  return opts.task && !hasTask(title, opts.task.number) ? `${opts.task.number} ${title}` : title
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

// 보드 명령(board.ts steps)이 판정한 단계 목록. 읽지 못하면 null 이다
export function boardSteps(bin: string, id: string, file: string): BoardStep[] | null {
  const done = run(scriptCommand(bin, ['steps', id, '--file', file]), { timeoutMs: NO_LIMIT_MS })
  if (done.code !== 0) return null
  try {
    const steps: unknown = JSON.parse(done.stdout)
    return Array.isArray(steps) ? (steps as BoardStep[]) : null
  } catch {
    return null
  }
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

// 중간 PR 을 옛 단계 항목(stages 칸이 없다)에 반영하는 board.ts 명령. 남은 일 줄을 바꾸고, 그 PR 의 단계를 끝내고, pr 칸을 비우고 merged-pr 에 쌓는다.
// merged-pr 에 적은 PR 은 board-sync 가 다시 연결하지도 다시 판정하지도 않는다. 남은 일 줄이 단계가 아니라 단계 번호는 그대로다.
// merged 는 항목의 지금 merged-pr 칸이다. 업무 하나에 중간 PR 이 여럿이면 앞 PR 을 지우지 않고 뒤에 더한다
export function intermediateCommands(id: string, details: BoardDetail[], steps: BoardStep[], pr: string, note: string | null, merged: unknown = null): string[][] {
  const next = withNote(details, note)
  const same = next.length === details.length && next.every((d, i) => d === details[i])
  return [
    ...(same ? [] : [['set', id, ...detailArgs(next)]]),
    ...prSteps(steps, pr).map((n) => ['step', id, String(n)]),
    ['set', id, '--pr', '', '--merged-pr', [...new Set([...prNumbers(merged), pr])].join(', ')],
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

// 진행률을 세는 쪽은 board.ts steps 가 정한다. 꼬리표 후보가 없는 항목은 CLI 를 부르지 않는다.
export function taggedBoardSteps(bin: string, id: string, file: string, item: Record<string, unknown>): BoardStep[] | null {
  if (!hasEventTags(item)) return []
  const steps = boardSteps(bin, id, file)
  return steps === null ? null : steps.filter((step) => parseEventTag(step.text))
}

export function hasEventTags(item: Record<string, unknown>): boolean {
  const candidates = ['details', 'next'].flatMap((key) => Array.isArray(item[key]) ? item[key] as BoardDetail[] : String(item[key] || '').split('\n'))
  return candidates.some((line) => parseEventTag(detailText(line)))
}
