// 보드의 첫 미완료 단계와 알림 기록. worker·PR 목록은 틱에서 받은 값만 쓴다.
// 알림 기록은 보드 파일마다 하나다: <머신 폴더>/step-ready.json 의 { boards: { <보드 실경로>: { notices } } }.
// 여러 저장소의 루프가 finish.board 로 같은 보드를 보면 저장소마다 기록이 따로라 같은 단계 알림이 루프 수만큼 갔다(2026-11-20 OCR).
// 잠금 안에서 읽고, 보내고, 쓴다. 그 보드의 기록이 아직 없으면 저장소의 옛 기록(state/step-ready.json)에서 이어받는다.
// 보드 파일이 없어진 기록은 쓸 때 지운다.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { withFileLock } from '../../../../modules/file-lock.ts'
import { machineDir } from './machine.ts'
import { itemBusy } from '../core/auto-advance.ts'
import { isObject } from '../core/json.ts'
import type { ReadyNotice, ReadyStep } from '../core/step-ready.ts'
import { firstPendingStep, mayHaveStepMark } from './auto-advance.ts'
import { prNumbers, readBoard } from './board.ts'
import { boardPath } from './board-file.ts'
import { openRows, worktreeOf } from '../core/movement.ts'
import { pathOf } from './paths.ts'
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

const legacyFile = (repo: string) => join(pathOf('state', repo), 'step-ready.json')
export const readyFile = (): string => join(machineDir(), 'step-ready.json')
export function boardKey(board: string): string {
  try { return realpathSync(board) } catch { return resolve(board) }
}

// 저장소의 옛 기록. 보드 기록이 없을 때 한 번 이어받는다
export function readLegacyNotices(repo: string): Record<string, ReadyNotice> {
  let body: unknown
  try { body = JSON.parse(readFileSync(legacyFile(repo), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  if (!isObject(body) || !isObject(body.notices)) throw new Error('다음 단계 알림 기록이 객체가 아니다')
  return parseNotices(body.notices)
}

function parseNotices(raw: Record<string, unknown>): Record<string, ReadyNotice> {
  const notices: Record<string, ReadyNotice> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!isObject(value) || typeof value.step !== 'string' || !['auto', 'ask'].includes(String(value.mark)) ||
      typeof value.at !== 'number' || !Number.isFinite(value.at) || (value.again !== null && (typeof value.again !== 'number' || !Number.isFinite(value.again)))) {
      throw new Error(`다음 단계 알림 기록을 읽지 못했다: ${id}`)
    }
    notices[id] = value as ReadyNotice
  }
  return notices
}

export function readBoardNotices(file: string): Record<string, Record<string, ReadyNotice>> {
  let body: unknown
  try { body = JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  if (!isObject(body) || !isObject(body.boards)) throw new Error('다음 단계 알림 기록이 객체가 아니다')
  const boards: Record<string, Record<string, ReadyNotice>> = {}
  for (const [key, value] of Object.entries(body.boards)) {
    if (!isObject(value) || !isObject(value.notices)) throw new Error(`다음 단계 알림 기록을 읽지 못했다: ${key}`)
    boards[key] = parseNotices(value.notices)
  }
  return boards
}

// 보드의 앞 기록을 받아 새 기록을 내는 일을 잠금 안에서 돌린다. 같은 보드를 보는 다른 루프는 기다렸다가 이 기록을 본다
export function withBoardNotices(repo: string, board: string, work: (previous: Record<string, ReadyNotice>) => Record<string, ReadyNotice>): void {
  const file = readyFile()
  mkdirSync(dirname(file), { recursive: true })
  const key = boardKey(board)
  withFileLock(file, () => {
    const boards = readBoardNotices(file)
    const records = work(boards[key] ?? readLegacyNotices(repo))
    const kept = Object.fromEntries(Object.entries(boards).filter(([one]) => one !== key && existsSync(one)).map(([one, notices]) => [one, { notices }]))
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ boards: { ...kept, [key]: { notices: records } } }) + '\n')
    renameSync(tmp, file)
  }, { waitMs: 15_000, staleMs: 10 * 60_000 })
}
