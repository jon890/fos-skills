import { withoutEvidence } from './evidence.ts'
import { detailArgs, prNumbers, withNote } from './board-details.ts'
import type { BoardDetail, BoardStep } from './board-details.ts'
import { stagesOf } from './milestones.ts'

export { NOTE, detailArgs, detailText, noteLine, prNumbers, withNote } from './board-details.ts'
export type { BoardDetail, BoardItem, BoardStep } from './board-details.ts'

// CI 고침, 리뷰 반영, 충돌 해결처럼 기존 PR 을 마무리하는 지시서의 줄 머리. 단계 줄이 아니라 진행률에 세지 않는다
export const INTERIM = '중간 과정: '

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
