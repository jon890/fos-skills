// `orch worker relaunch` 가 다시 띄우는 동안 그 워크트리를 정리에서 지키는 표시.
//
// 다시 띄우기는 옛 dispatch 를 abandon 한 뒤 새 dispatch 를 띄운다. 그 사이에는 그 경로의 dispatch 가 모두 끝난 상태라,
// cleanup 의 「PR 없이 끝난 워크트리」(cleanup/steps/worktrees.ts)가 워크트리와 지시서를 지울 수 있다(2026-11-19 실측).
// 새 dispatch 가 뜨면 살아 있는 dispatch 가 워크트리를 지키므로 표시를 지운다. 띄우지 못하면 표시를 남겨 다시 부를 때까지 지킨다.
//
// 위치: <orch 루트>/state/relaunch-hold/<옛 dispatch>.json. 내용: { dispatch, worktree(실경로), spec, at(ISO 시각) }.
// 표시는 HOLD_MS(24시간) 동안만 듣는다. 다시 띄우기를 포기하고 잊어도 정리가 영영 막히지 않게 하려는 것이다.
//
// 내보내는 것:
//     holdRelaunch     표시를 쓴다. 실패하면 던진다
//     releaseRelaunch  표시를 지운다. 없어도 통과한다
//     relaunchHoldAt   그 워크트리를 지키는 아직 유효한 표시. 없으면 null

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { realPath } from './fs.ts'
import { ensure, pathOf } from './paths.ts'

export type RelaunchHold = { dispatch: string; worktree: string; spec: string | null; at: string }

const DIR = 'relaunch-hold'
export const HOLD_MS = 24 * 60 * 60 * 1000

function fileOf(repo: string, dispatch: string, create = false): string | null {
  // dispatch id 가 경로 조각이 되므로 한 단계 이름일 때만 쓴다(lib/launched.ts 와 같은 규칙)
  if (!/^[\w.-]+$/.test(dispatch) || dispatch.startsWith('.')) return null
  return join(create ? ensure('state', repo) : pathOf('state', repo), DIR, `${dispatch}.json`)
}

export function holdRelaunch(repo: string, hold: Omit<RelaunchHold, 'at'>, now = new Date()): void {
  const file = fileOf(repo, hold.dispatch, true)
  if (!file) throw new Error(`dispatch id 를 파일 이름으로 쓸 수 없다: ${hold.dispatch}`)
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ ...hold, worktree: realPath(hold.worktree), at: now.toISOString() })}\n`, 'utf8')
  renameSync(tmp, file)
}

export function releaseRelaunch(repo: string, dispatch: string): void {
  const file = fileOf(repo, dispatch)
  if (file) rmSync(file, { force: true })
}

export function relaunchHoldAt(repo: string, worktree: string, now = Date.now()): RelaunchHold | null {
  const target = realPath(worktree)
  let names: string[]
  try {
    names = readdirSync(join(pathOf('state', repo), DIR))
  } catch {
    return null
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    let data: unknown
    try {
      data = JSON.parse(readFileSync(join(pathOf('state', repo), DIR, name), 'utf8'))
    } catch {
      continue
    }
    if (typeof data !== 'object' || data === null) continue
    const v = data as Record<string, unknown>
    if (typeof v.dispatch !== 'string' || typeof v.worktree !== 'string' || typeof v.at !== 'string') continue
    const at = Date.parse(v.at)
    if (!Number.isFinite(at) || now - at > HOLD_MS) continue
    if (v.worktree !== target && v.worktree !== worktree) continue
    return { dispatch: v.dispatch, worktree: v.worktree, spec: typeof v.spec === 'string' ? v.spec : null, at: v.at }
  }
  return null
}
