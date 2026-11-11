import { basename } from 'node:path'
import type { StageKind, Stages } from './milestones.ts'
import { liveWorkerOn } from './workers.ts'
import { BOARD_KEYS, ConfigError, section } from './config.ts'
import type { Config } from './config.ts'

export type BoardView = {
  pr: string[]
  mergedPr: string[]
  stages: Stages | null
  steps: Array<{ number: number; done: boolean; tag: { pr: string; event: string } | null }>
}

export function eventDone(items: BoardView[], pr: string, event: StageKind): boolean {
  return items.some(item => {
    if (item.steps.some(step => step.done && step.tag?.pr === pr && step.tag.event === event)) return true
    if (event === 'merge') return item.mergedPr.includes(pr)
    const prs = new Set([...item.pr, ...item.mergedPr])
    return prs.has(pr) && (event === 'pr' || prs.size === 1) &&
      item.steps.some(step => step.done && step.number === item.stages?.[event])
  })
}

export function itemBusy(
  item: { worktree: string | null; branch: string | null; pr: string[] },
  launches: ReadonlyArray<{ dispatch: string; branch: string | null }>,
  live: { paths: ReadonlySet<string>; dispatches: ReadonlySet<string> },
  branches: ReadonlyMap<string, string>,
  openPrs: ReadonlyArray<{ number: string; branch: string }>,
): boolean {
  if (liveWorkerOn(item, live.paths, branches) || launches.some(row => live.dispatches.has(row.dispatch))) return true
  const names = new Set([item.branch, ...launches.map(row => row.branch)])
  for (const [branch, path] of branches) if (item.worktree && basename(path) === basename(item.worktree)) names.add(branch)
  return openPrs.some(pr => item.pr.includes(pr.number) || names.has(pr.branch))
}

export const ADVANCE_REASONS = {
  off: '자동 진행이 꺼져 있다',
  noItem: '항목이 없다',
  status: '상태가 doing 이나 wait 가 아니다',
  notAuto: '첫 미완료 단계가 [auto] 가 아니다',
  busy: 'worker 나 열린 PR 이 있다',
  unknownBusy: 'worker 나 PR 을 확인하지 못했다',
  launched: '이미 한 번 띄웠다',
  limited: '사용 한도 알림 뒤 30분이 지나지 않았다',
  noEvidence: '근거가 없다',
  noSpec: '스펙 파일이 없다',
  unconfirmed: '스펙에 확인 줄이 없다',
  noPlan: '계획 파일이 없다',
  eventPending: '앞 사건이 끝나지 않았다',
} as const

export type AdvanceInput = {
  autoAdvance: boolean
  status: string | null
  step: { number: number; mark: 'auto' | 'ask' | 'wait' | null } | null
  busy: boolean | null
  launched: boolean
  limited?: boolean
  evidence: Array<{ text: string; problem: string | null }>
}
export type AdvanceVerdict =
  | { ok: true; number: number; evidence: string }
  | { ok: false; number: number | null; reason: string }

export function judgeAdvance(input: AdvanceInput): AdvanceVerdict {
  const reject = (reason: string, number: number | null = input.step?.number ?? null): AdvanceVerdict => ({ ok: false, number, reason })
  if (!input.autoAdvance) return reject(ADVANCE_REASONS.off, null)
  if (input.status === null) return reject(ADVANCE_REASONS.noItem, null)
  if (!['doing', 'wait'].includes(input.status)) return reject(ADVANCE_REASONS.status, null)
  if (input.step?.mark !== 'auto') return reject(ADVANCE_REASONS.notAuto)
  if (input.busy === null) return reject(ADVANCE_REASONS.unknownBusy)
  if (input.busy) return reject(ADVANCE_REASONS.busy)
  if (input.launched) return reject(ADVANCE_REASONS.launched)
  if (!input.evidence.length) return reject(ADVANCE_REASONS.noEvidence)
  const bad = input.evidence.find(row => row.problem !== null)
  if (bad) return reject(bad.problem!)
  if (input.limited) return reject(ADVANCE_REASONS.limited)
  return { ok: true, number: input.step.number, evidence: input.evidence.map(row => row.text).join(', ') }
}

export function autoAdvanceOf(config: Config): boolean {
  const value = section<Record<string, unknown>>(config, 'board', BOARD_KEYS).auto_advance
  if (value === undefined) return true
  if (typeof value !== 'boolean') throw new ConfigError('설정 파일의 board.auto_advance 는 true 나 false 다')
  return value
}
