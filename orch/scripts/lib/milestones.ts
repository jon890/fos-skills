// 보드 항목의 마일스톤 단계 한 벌이다(ADR-018). 띄우기(lib/board.ts 의 registerBoard)가 단계를 만들고,
// 보드 동기화(board-sync.ts), 마무리(finish-pr.ts), 릴리스 확인(board-release.ts)이 사건마다 단계를 끝낸다.
//
// 단계 정의: 문자열 하나가 단계 하나다. 앞에 꼬리표 `[pr]`, `[merge]`, `[deploy]`, `[release]` 가 있으면 그 사건이 끝내는 단계이고,
//     꼬리표가 없으면 코디네이터가 끝내는 수동 단계다. 꼬리표는 한 번씩만 쓴다. 정하는 곳은 아래 순서로 처음 있는 것이다.
//       1. 지시서의 `## 보드 단계` 절. 번호 줄(`2. [merge] 머지`)만 읽는다
//       2. config.json 의 board.steps
//       3. 기본값 DEFAULT_STEPS(`[pr] PR`, `[merge] 머지`). 배포와 릴리스의 흐름은 저장소마다 달라 코어가 기본값으로 정하지 않는다.
//          배포 워크플로가 있어도 배포 단계를 저절로 만들지 않는다. 그 저장소가 board.steps 로 정한다
// 항목에는 사건과 단계 번호의 짝을 stages 칸(`pr=1,merge=2,deploy=3,release=4`)으로 저장한다. stages 칸이 없는 항목은
// 옛 「할 일」 단계 항목이라 이 모듈을 쓰지 않고 예전 규칙(PR 번호가 적힌 단계만 끝낸다)으로 처리한다.
//
// 사건: pr(PR 이 열렸다), merge(머지됐다), deploy(배포 워크플로가 성공했다), release(릴리스에 들어갔다). 이 순서로 앞선다.
//     사건 하나는 그 사건과 앞 사건의 단계를 모두 끝낸다. 업무의 중간 PR 은 deploy 까지만 끝내고, 마지막 PR 만 release 와 done 으로 간다.
// done 지점: board.done_after(기본 merge)의 사건 단계다. 항목에 그 사건 단계가 없으면 항목에 있는 가장 늦은 사건 단계다.
//     마지막 PR 이 그 지점에 닿으면 그 번호까지의 남은 단계(수동 단계 포함)를 끝내고 done 으로 바꾸고 worktree 칸을 비운다.
//     그 뒤 번호의 단계는 그대로 둔다

import { detailArgs, detailText, prNumbers, withNote } from './board.ts'
import type { BoardDetail, BoardItem, BoardStep } from './board.ts'
import { ConfigError, loadConfig, section, BOARD_KEYS } from './config.ts'
import { FINISH_KEYS } from './finish-options.ts'

export const STAGE_KINDS = ['pr', 'merge', 'deploy', 'release'] as const
export type StageKind = (typeof STAGE_KINDS)[number]
export type Stages = Partial<Record<StageKind, number>>
export type MilestoneStep = { kind: StageKind | null; text: string }
export type BoardSettings = { steps: MilestoneStep[] | null; doneAfter: StageKind | null; deploy: { workflow: string; branch: string } | null }

// board.steps 가 없을 때의 단계
export const DEFAULT_STEPS: readonly MilestoneStep[] = [
  { kind: 'pr', text: 'PR' },
  { kind: 'merge', text: '머지' },
]
// board.done_after 가 없을 때의 done 지점
export const DEFAULT_DONE_AFTER: StageKind = 'merge'

// done_after 로 고를 수 있는 사건. pr 은 머지 전이라 업무를 끝낸 것으로 볼 수 없다
const DONE_KINDS: readonly StageKind[] = ['merge', 'deploy', 'release']
const TAG = /^\s*\[([A-Za-z]+)\]\s*/
const STAGES = /^\s*(?:(?:pr|merge|deploy|release)=\d+)(?:\s*,\s*(?:pr|merge|deploy|release)=\d+)*\s*$/

function order(kind: StageKind): number {
  return STAGE_KINDS.indexOf(kind)
}

function isKind(value: string): value is StageKind {
  return (STAGE_KINDS as readonly string[]).includes(value)
}

// 단계 정의 한 줄. 모르는 꼬리표나 빈 본문은 Error 다
export function parseStep(line: string): MilestoneStep {
  const tag = TAG.exec(line)
  const text = line.replace(TAG, '').trim()
  if (!text) throw new Error(`보드 단계의 본문이 비었다: ${line}`)
  if (!tag) return { kind: null, text }
  const kind = tag[1].toLowerCase()
  if (!isKind(kind)) throw new Error(`보드 단계의 꼬리표는 ${STAGE_KINDS.map((k) => `[${k}]`).join(', ')} 중 하나다: ${line}`)
  return { kind, text }
}

// 단계 정의 목록. 같은 꼬리표가 둘이면 Error 다
export function parseSteps(lines: string[]): MilestoneStep[] {
  const steps = lines.map(parseStep)
  const kinds = steps.flatMap((step) => (step.kind ? [step.kind] : []))
  const twice = kinds.find((kind, i) => kinds.indexOf(kind) !== i)
  if (twice) throw new Error(`보드 단계의 꼬리표 [${twice}] 가 둘이다`)
  return steps
}

// 지시서의 `## 보드 단계` 절의 번호 줄. 절이 없거나 번호 줄이 없으면 null 이다
export function specSteps(text: string): MilestoneStep[] | null {
  const body = text.match(/^##\s+보드 단계[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1]
  if (body === undefined) return null
  const lines = body
    .split('\n')
    .map((line) => /^\s*\d+[.)]?\s+(.+)$/.exec(line)?.[1])
    .filter((line): line is string => Boolean(line))
  return lines.length > 0 ? parseSteps(lines) : null
}

// config.json 의 board 절과 finish 절의 배포 설정. 배포 설정은 [deploy] 단계를 끝낼 때만 쓴다. 값이 틀리면 ConfigError 다
export function boardSettings(repo: string): BoardSettings {
  const config = loadConfig(repo)
  const board = section<Record<string, unknown>>(config, 'board', BOARD_KEYS)
  const finish = section<Record<string, unknown>>(config, 'finish', FINISH_KEYS)
  let steps: MilestoneStep[] | null = null
  if (board.steps !== undefined) {
    if (!Array.isArray(board.steps) || board.steps.length === 0 || !board.steps.every((line) => typeof line === 'string')) {
      throw new ConfigError('설정 파일의 board.steps 는 비지 않은 문자열 목록이어야 한다')
    }
    try {
      steps = parseSteps(board.steps as string[])
    } catch (e) {
      throw new ConfigError(`설정 파일의 board.steps: ${(e as Error).message}`)
    }
  }
  let doneAfter: StageKind | null = null
  if (board.done_after !== undefined) {
    const value = board.done_after
    if (typeof value !== 'string' || !(DONE_KINDS as readonly string[]).includes(value)) {
      throw new ConfigError(`설정 파일의 board.done_after 는 ${DONE_KINDS.join(', ')} 중 하나다`)
    }
    doneAfter = value as StageKind
  }
  const workflow = typeof finish.deploy_workflow === 'string' ? finish.deploy_workflow : ''
  const branch = typeof finish.deploy_branch === 'string' ? finish.deploy_branch : ''
  return { steps, doneAfter, deploy: workflow && branch ? { workflow, branch } : null }
}

// 단계 정의를 보드 줄과 stages 로 바꾼다. 번호는 start 부터다
export function milestoneLines(steps: MilestoneStep[], start = 1): { details: string[]; stages: Stages } {
  const stages: Stages = {}
  const details = steps.map((step, i) => {
    if (step.kind) stages[step.kind] = start + i
    return `${start + i}. ${step.text}`
  })
  return { details, stages }
}

// stages 칸의 글. 사건 순서로 쓴다. 빈 stages 는 빈 문자열이다
export function stagesText(stages: Stages): string {
  return STAGE_KINDS.flatMap((kind) => (stages[kind] === undefined ? [] : [`${kind}=${stages[kind]}`])).join(',')
}

// 항목의 stages 칸. 없거나 형식이 틀리거나 비었으면 null 이다(옛 단계 항목)
export function stagesOf(item: BoardItem | Record<string, unknown>): Stages | null {
  const value = item.stages
  if (typeof value !== 'string' || !STAGES.test(value)) return null
  const stages: Stages = {}
  for (const part of value.split(',')) {
    const [kind, number] = part.trim().split('=')
    stages[kind as StageKind] = Number(number)
  }
  return Object.keys(stages).length > 0 ? stages : null
}

// 항목이 done 이 되는 단계 번호. 머리 주석의 「done 지점」 이다. 사건 단계가 없으면 null 이다
export function doneStep(stages: Stages, doneAfter: StageKind | null): number | null {
  const kind = doneAfter ?? DEFAULT_DONE_AFTER
  if (stages[kind] !== undefined) return stages[kind] as number
  const kinds = STAGE_KINDS.filter((kind) => stages[kind] !== undefined)
  return kinds.length > 0 ? (stages[kinds[kinds.length - 1]] as number) : null
}

// 사건 하나로 끝낼 보드 명령. reached 와 그 앞 사건의 끝나지 않은 단계를 끝낸다.
// 중간 PR(last 가 false)은 deploy 까지만 끝내고 done 으로 가지 않는다. 마지막 PR 이 done 지점에 닿았으면
// 그 번호까지의 남은 단계를 끝내고 done 으로 바꾸고 worktree 칸을 비운다. done 은 done 으로 바꿨는지다
export function advanceCommands(
  id: string,
  steps: BoardStep[],
  stages: Stages,
  reached: StageKind,
  opts: { last: boolean; doneAfter: StageKind | null },
): { cmds: string[][]; done: boolean } {
  const top = opts.last ? order(reached) : Math.min(order(reached), order('deploy'))
  const numbers = new Set(STAGE_KINDS.filter((kind) => order(kind) <= top && stages[kind] !== undefined).map((kind) => stages[kind] as number))
  const point = doneStep(stages, opts.doneAfter)
  const done = opts.last && point !== null && numbers.has(point)
  const finish = steps.filter((step) => !step.done && (numbers.has(step.number) || (done && step.number <= (point as number))))
  const cmds = finish.map((step) => ['step', id, String(step.number)])
  if (done) cmds.push(['set', id, 'done', '--worktree', ''])
  return { cmds, done }
}

// merged-pr 칸에 pr 을 더한 값. 이미 든 번호는 다시 넣지 않는다
export function mergedList(field: unknown, pr: string): string {
  return [...new Set([...prNumbers(field), pr])].join(', ')
}

// 머지된 PR 을 stages 가 있는 항목에 반영하는 보드 명령. board-sync.ts 와 finish-pr.ts 가 함께 쓴다.
//   - 하위 항목의 남은 일 줄을 note 로 바꾼다(마지막 PR 이면 지운다)
//   - reached(merge 나 deploy)까지의 단계를 끝낸다(advanceCommands)
//   - 마지막 PR 이면 pr 칸을 두고 merged-pr 에도 적는다. pr 칸에 남겨 릴리스 확인(board-release.ts)과 배포 확인이 찾게 하고,
//     merged-pr 에 적어 다음 틱에 다시 판정하지 않게 한다
//   - 중간 PR 이면 pr 칸을 비우고 merged-pr 에 쌓는다
export function mergedCommands(
  item: BoardItem | Record<string, unknown>,
  steps: BoardStep[],
  stages: Stages,
  pr: string,
  reached: StageKind,
  opts: { last: boolean; doneAfter: StageKind | null; note: string | null },
): { cmds: string[][]; done: boolean } {
  const id = String(item.id)
  const details = (Array.isArray(item.details) ? item.details : []) as BoardDetail[]
  const next = withNote(details, opts.last ? null : opts.note)
  const same = next.length === details.length && next.every((d, i) => detailText(d) === detailText(details[i]))
  const advanced = advanceCommands(id, steps, stages, reached, opts)
  const merged = mergedList(item['merged-pr'], pr)
  return {
    cmds: [
      ...(same ? [] : [['set', id, ...detailArgs(next)]]),
      ...advanced.cmds,
      opts.last ? ['set', id, '--merged-pr', merged] : ['set', id, '--pr', '', '--merged-pr', merged],
    ],
    done: advanced.done,
  }
}
