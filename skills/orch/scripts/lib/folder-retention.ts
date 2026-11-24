// orch 작업 폴더(handoff/, data/)에서 휴지통으로 옮길 항목을 고른다. 폴더마다 담는 것, 이름 꼴, 지우는 때는
// references/overlay.md 「orch 작업 폴더」 표가 소유하고, 이 파일은 그 표의 handoff 와 data 줄을 판정한다.
// 정기 정리(cleanup/steps/state.ts)와 `orch cleanup handoff`(handoff 만)가 쓴다. specs 줄은 cleanup/steps/specs.ts 가 본다.
//
// handoff/ 의 이름 꼴은 `pr-<번호>/` 와 `pending/<워크트리 이름>/` 두 가지다. 바로 아래 항목과 pending 바로 아래 항목만 본다.
//     - `pr-<번호>/`: 그 PR 이 MERGED·CLOSED 면 `pr-closed`. OPEN 이나 상태를 모르면 남긴다
//     - `pending/<워크트리 이름>/`: 그 이름의 워크트리가 있으면 남긴다. 없고 days 일 넘게 바뀌지 않았으면 `stale`.
//       워크트리 목록을 읽지 못하면(null) 남긴다
//     - 두 꼴 밖의 이름: 이름에 `pr-<번호>` 가 있고 그 PR 이 MERGED·CLOSED 면 기한 없이 `pr-closed`.
//       그 밖에는 days 일 넘게 바뀌지 않았으면 `nonconforming`. 옛 정리가 `pr-<번호>` 만 봐서 `pr-565-review-…`,
//       `plan-…-preview.html` 같은 이름이 쌓였다(2026-11-24)
// data/ 의 이름 꼴은 `data/<보드 항목 id>/` 다.
//     - 보드에 그 id 가 없는 폴더는 `board-removed`. 보드를 읽지 못하면(null) 남긴다
//     - 폴더가 아닌 항목은 days 일 넘게 바뀌지 않았으면 `nonconforming`
// 폴더는 안의 가장 늦은 수정 시각으로 본다. 심볼릭 링크와 파일·폴더가 아닌 것은 건드리지 않는다.

import { cpSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type RetentionReason = 'pr-closed' | 'stale' | 'nonconforming' | 'board-removed'
export type RetentionCandidate = { path: string; rel: string; reason: RetentionReason; pr: number | null }
export type HandoffHost = {
  now: number
  days: number
  // 번호마다 PR 상태(OPEN, MERGED, CLOSED). 모르는 번호는 빼고 돌려준다
  prStates: (numbers: number[]) => Map<number, string>
  // 살아 있는 워크트리의 폴더 이름. 읽지 못하면 null
  worktrees: Set<string> | null
}
export type DataHost = {
  now: number
  days: number
  // 보드 항목 id. 읽지 못하면 null
  boardIds: Set<string> | null
}

const DAY_MS = 86_400_000
const PR_DIR = /^pr-([1-9]\d*)$/
const PR_NUMBER = /(?:^|[^a-z0-9])pr-([1-9]\d*)(?![0-9])/i

function kind(path: string): 'file' | 'dir' | null {
  try {
    const stat = lstatSync(path)
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : null
  } catch { return null }
}

function list(dir: string): string[] {
  try { return readdirSync(dir).sort() } catch { return [] }
}

// 폴더면 안의 가장 늦은 수정 시각이다. 링크는 따라가지 않는다
export function newestMtime(path: string): number {
  let stat
  try { stat = lstatSync(path) } catch { return Number.POSITIVE_INFINITY }
  let newest = stat.mtimeMs
  if (stat.isDirectory()) for (const name of list(path)) newest = Math.max(newest, newestMtime(join(path, name)))
  return newest
}

export function prNumberOf(name: string): number | null {
  const m = PR_NUMBER.exec(name)
  return m ? Number(m[1]) : null
}

export function handoffCandidates(dir: string, host: HandoffHost): RetentionCandidate[] {
  if (kind(dir) !== 'dir') return []
  const cutoff = host.now - host.days * DAY_MS
  const stale = (path: string) => newestMtime(path) < cutoff
  const found: RetentionCandidate[] = []
  const owned: { path: string; name: string; pr: number; conforming: boolean }[] = []

  for (const name of list(dir)) {
    const path = join(dir, name)
    const type = kind(path)
    if (!type) continue
    if (name === 'pending' && type === 'dir') {
      if (!host.worktrees) continue
      for (const child of list(path)) {
        const entry = join(path, child)
        if (kind(entry) && !host.worktrees.has(child) && stale(entry)) found.push({ path: entry, rel: `pending/${child}`, reason: 'stale', pr: null })
      }
      continue
    }
    const exact = type === 'dir' ? PR_DIR.exec(name) : null
    const pr = exact ? Number(exact[1]) : prNumberOf(name)
    if (pr !== null) owned.push({ path, name, pr, conforming: exact !== null })
    else if (stale(path)) found.push({ path, rel: name, reason: 'nonconforming', pr: null })
  }

  if (owned.length) {
    const states = host.prStates([...new Set(owned.map(({ pr }) => pr))])
    for (const { path, name, pr, conforming } of owned) {
      const state = states.get(pr)
      if (state === 'MERGED' || state === 'CLOSED') found.push({ path, rel: name, reason: 'pr-closed', pr })
      else if (!conforming && stale(path)) found.push({ path, rel: name, reason: 'nonconforming', pr })
    }
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel))
}

export function dataCandidates(dir: string, host: DataHost): RetentionCandidate[] {
  if (kind(dir) !== 'dir') return []
  const cutoff = host.now - host.days * DAY_MS
  const found: RetentionCandidate[] = []
  for (const name of list(dir)) {
    const path = join(dir, name)
    const type = kind(path)
    if (type === 'dir') {
      if (host.boardIds && !host.boardIds.has(name)) found.push({ path, rel: name, reason: 'board-removed', pr: null })
    } else if (type === 'file' && newestMtime(path) < cutoff) {
      found.push({ path, rel: name, reason: 'nonconforming', pr: null })
    }
  }
  return found
}

function taken(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

// <trash>/<폴더>/<rel> 로 옮긴다. 같은 이름이 있으면 번호를 붙인다. 폴더도 옮긴다
export function moveRetained(candidate: RetentionCandidate, trash: string, folder: string): string {
  const base = join(trash, folder, candidate.rel)
  let target = base
  for (let n = 2; taken(target); n += 1) target = `${base}.${n}`
  mkdirSync(dirname(target), { recursive: true })
  try {
    renameSync(candidate.path, target)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    cpSync(candidate.path, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
    rmSync(candidate.path, { recursive: true })
  }
  return target
}

export function reasonText(candidate: RetentionCandidate, days: number): string {
  switch (candidate.reason) {
    case 'pr-closed': return `PR #${candidate.pr} 이 머지되거나 닫혔다`
    case 'stale': return `그 워크트리가 없고 ${days}일 넘게 바뀌지 않았다`
    case 'board-removed': return '보드에 그 항목이 없다'
    default: return `정한 이름 꼴 밖이고 ${days}일 넘게 바뀌지 않았다`
  }
}
