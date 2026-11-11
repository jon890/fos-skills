// 보드의 첫 미완료 단계와 알림 기록. worker·PR 목록은 틱에서 받은 값만 쓴다.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { itemBusy } from '../core/auto-advance.ts'
import { isObject } from '../core/json.ts'
import type { ReadyNotice, ReadyStep } from '../core/step-ready.ts'
import { firstPendingStep, mayHaveStepMark } from './auto-advance.ts'
import { prNumbers, readBoard } from './board.ts'
import { boardPath } from './board-file.ts'
import { openRows, worktreeOf } from '../core/movement.ts'
import { makeParent, pathOf } from './paths.ts'
import { stepLaunches } from './step-launches.ts'

export type LiveSteps = { paths: Set<string>; dispatches: Set<string> }
export type OpenStepPrs = Array<{ number: string; branch: string }>
export function liveSteps(rows: Record<string, unknown>[]): LiveSteps {
  const live: LiveSteps = { paths: new Set(), dispatches: new Set() }
  for (const row of openRows(rows)) {
    const path = worktreeOf(row)
    if (path) live.paths.add(path)
    live.dispatches.add(String(row.dispatchId))
  }
  return live
}

export function boardReadySteps(repo: string, live: LiveSteps | null, branches: Map<string, string>, prs: OpenStepPrs | null): ReadyStep[] {
  const file = boardPath(repo)
  return readBoard(file).map(item => {
    const step = item.status === 'done' || !mayHaveStepMark(item) ? null : firstPendingStep(file, item)
    const launches = step?.mark === 'auto' ? stepLaunches(repo, item.id, step.key) : []
    const text = (key: string) => typeof item[key] === 'string' ? (item[key] as string).trim() || null : null
    const busy = live && prs ? itemBusy({ worktree: text('worktree'), branch: text('branch'), pr: [...prNumbers(item.pr)] }, launches, live, branches, prs) : null
    return { id: item.id, active: ['doing', 'wait'].includes(String(item.status)), done: item.status === 'done',
      step: step?.key ?? null, mark: step?.mark ?? null, busy, launched: launches.length > 0 }
  })
}

const fileOf = (repo: string) => join(pathOf('state', repo), 'step-ready.json')
export function readReadyNotices(repo: string): Record<string, ReadyNotice> {
  let body: unknown
  try { body = JSON.parse(readFileSync(fileOf(repo), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  if (!isObject(body) || !isObject(body.notices)) throw new Error('다음 단계 알림 기록이 객체가 아니다')
  const notices: Record<string, ReadyNotice> = {}
  for (const [id, value] of Object.entries(body.notices)) {
    if (!isObject(value) || typeof value.step !== 'string' || !['auto', 'ask'].includes(String(value.mark)) ||
      typeof value.at !== 'number' || !Number.isFinite(value.at) || (value.again !== null && (typeof value.again !== 'number' || !Number.isFinite(value.again)))) {
      throw new Error(`다음 단계 알림 기록을 읽지 못했다: ${id}`)
    }
    notices[id] = value as ReadyNotice
  }
  return notices
}

export function writeReadyNotices(repo: string, notices: Record<string, ReadyNotice>): void {
  const file = fileOf(repo)
  makeParent(file, repo)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ notices }) + '\n')
  renameSync(tmp, file)
}
