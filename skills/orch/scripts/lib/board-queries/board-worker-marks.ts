// 보드에서 쓰는 멈춤 설정과 worker 별 표시. 상태 파일과 Orca 응답은 orch 안에서 읽는다.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError } from '../config.ts'
import { real } from '../fs.ts'
import { judgeWorker, lastCommitMs, latestMtime, movementSettings, openRows, readRecords, worktreeOf } from '../movement.ts'
import type { MovementSettings, ScreenMark } from '../movement.ts'
import { pathOf } from '../paths.ts'
import { workerRows } from '../workers.ts'

type Json = Record<string, unknown>

export type WorkerMark = {
  dispatch: string
  terminal: string
  worktree: string | null
  reason: 'idle' | 'exited' | null
  idleMin: number | null
  movedAt: number | null
  workedAt: number | null
  waiting: string | null
}

// orch-loop.ts 의 waitingOf 와 같은 순서와 문구다
function waitingOf(row: Json, asking: ReadonlySet<string>, merging: ReadonlySet<string>, questionsUnknown: boolean): string | null {
  const dispatch = String(row.dispatchId ?? '')
  if (questionsUnknown) return '질문을 읽지 못했다'
  if (asking.has(dispatch) || asking.has(String(row.agentTerminalHandle ?? ''))) return '질문의 답을 기다린다'
  return merging.has(dispatch) ? 'CI 를 통과해 머지를 기다린다' : null
}

// 열린 dispatch 마다 판정한다. 워크트리 폴더가 없으면 파일과 커밋 시각을 읽지 않는다(lib/movement.ts 의 collectWorkers 와 같다)
function markWorkers(input: {
  rows: Json[]
  settings: MovementSettings
  now: number
  screens: Readonly<Record<string, ScreenMark>>
  asking: ReadonlySet<string>
  merging: ReadonlySet<string>
  questionsUnknown: boolean
}): WorkerMark[] {
  return openRows(input.rows).map((row) => {
    const path = worktreeOf(row)
    const existingPath = path !== null && existsSync(path) ? path : null
    const mtime = existingPath === null ? null : latestMtime(existingPath)
    const commit = existingPath === null ? null : lastCommitMs(existingPath)
    const worked = [mtime, commit].filter((v): v is number => typeof v === 'number')
    const verdict = judgeWorker({
      run: '',
      row,
      now: input.now,
      settings: input.settings,
      mtime,
      commit,
      screen: input.screens[String(row.dispatchId)],
      waiting: waitingOf(row, input.asking, input.merging, input.questionsUnknown),
    })
    return {
      dispatch: verdict.dispatch,
      terminal: verdict.terminal,
      worktree: verdict.worktree,
      reason: verdict.reason,
      idleMin: verdict.idleMin,
      movedAt: verdict.movedAt,
      workedAt: worked.length > 0 ? Math.max(...worked) : null,
      waiting: verdict.waiting,
    }
  })
}

// 루프가 적은 화면 기록. 없거나 깨졌으면 빈 기록이다
function screens(repo: string): Record<string, ScreenMark> {
  try {
    return readRecords(JSON.parse(readFileSync(join(pathOf('state', repo), 'movement.json'), 'utf8'))).screens
  } catch {
    return {}
  }
}

export function readBoardWorkerMarks(input: {
  repo: string
  run?: string
  asking?: readonly string[]
  merging?: readonly string[]
  questionsUnknown?: boolean
}): { ok: true; view: { settings: MovementSettings; workers: WorkerMark[]; error: string | null } } | { ok: false; error: string } {
  const repo = real(input.repo)
  let settings: MovementSettings
  try {
    settings = movementSettings(repo)
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return { ok: false, error: error.message }
  }

  if (!input.run) return { ok: true, view: { settings, workers: [], error: null } }
  const rows = workerRows(input.run)
  if (!rows.ok) return { ok: true, view: { settings, workers: [], error: rows.error } }

  const workers = markWorkers({
    rows: rows.rows,
    settings,
    now: Date.now(),
    screens: screens(repo),
    asking: new Set(input.asking),
    merging: new Set(input.merging),
    questionsUnknown: input.questionsUnknown ?? false,
  })
  return { ok: true, view: { settings, workers, error: null } }
}
