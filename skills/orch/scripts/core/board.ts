import { withoutEvidence } from "./evidence.ts"
import { stagesOf } from './milestones.ts'

export type BoardItem = Record<string, unknown> & { id: string }

// CI 고침, 리뷰 반영, 충돌 해결처럼 기존 PR 을 마무리하는 지시서의 줄 머리. 단계 줄이 아니라 진행률에 세지 않는다
export const INTERIM = '중간 과정: '

// 보드 항목의 pr 칸(`#492`, `492, 495`, `492/495`)에 든 PR 번호들. 글자에 붙은 숫자(`#492 (v2)` 의 `2`)는 읽지 않는다.
// 옮기기 전 Python 의 \w 가 한글도 글자로 보았으므로 유니코드 글자와 숫자를 글자로 센다
export function prNumbers(field: unknown): Set<string> {
  const text = !field ? '' : typeof field === 'string' ? field : JSON.stringify(field)
  return new Set([...text.matchAll(/(?<![\p{L}\p{N}_])#?(\d+)(?![\p{L}\p{N}_])/gu)].map((m) => m[1]))
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

// 통째 저장은 마지막 목록 하나만 맨 앞에 둔다. 나머지 칸 변경과 단계 명령의 순서는 보존한다.
// 지문은 파일을 읽은 lib 호출자가 계산한다(core 는 work-board 를 읽지 않는다).
export function guardedCommands(commands: string[][], rev: string): string[][] {
  let rewrite: string[] | undefined
  const rest: string[][] = []
  for (const command of commands) {
    if (command[0] === 'set' && command.includes('--detail')) rewrite = command
    else rest.push(command)
  }
  return rewrite ? [[...rewrite, '--if-rev', rev], ...rest] : rest
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

// 근거 괄호 밖에 그 PR 번호(#N)가 적힌 단계. includeDone 은 참조 판정에서도 같은 규칙을 쓰게 한다.
export function prSteps(steps: BoardStep[], pr: string, includeDone = false): number[] {
  const pattern = new RegExp(`#${pr}(?!\\d)`)
  return steps.filter((step) => (includeDone || !step.done) && pattern.test(withoutEvidence(step.text))).map((step) => step.number)
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

// 이미 끝난 줄도 참조로 센다. 꼬리표가 있으면 글의 번호보다 꼬리표 사건을 우선한다.
export type BoardEventReference = { pr: string; done: boolean }

export function unmatchedMerge(item: Record<string, unknown>, steps: BoardStep[], pr: string, tagged: BoardEventReference[] = []): boolean {
  if (item.status === 'done' || steps.every((step) => step.done)) return false
  if (tagged.length > 0) return !tagged.some((step) => step.pr === pr)
  const stages = stagesOf(item)
  if (stages) return !steps.some((step) => step.number === stages.pr || step.number === stages.merge)
  return prSteps(steps, pr, true).length === 0
}

export function unmatchedResolved(steps: BoardStep[], pr: string, tagged: BoardEventReference[] = []): boolean {
  return steps.every((step) => step.done) || tagged.some((step) => step.done && step.pr === pr)
}
