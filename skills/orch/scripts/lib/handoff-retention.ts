// <orch 루트>/handoff/ 에서 휴지통으로 옮길 항목을 고른다. 정기 정리(cleanup/steps/state.ts)와 `orch cleanup handoff` 가 함께 쓴다.
//
// handoff 에는 코디네이터가 읽을 파일만 둔다(references/replying.md 「인계 파일을 둔다」). 그래도 이름 규칙 밖의 파일
// (`pr-565-review-…`, `review-pr-561-…`, `plan-…-preview.html`)이 남아 쌓였다. 옛 정리는 `pr-<번호>` 폴더만 보고 나머지는 건너뛰었다.
//
// 항목마다 아래 차례로 정한다. 바로 아래 항목과 `pending/` 의 바로 아래 항목만 본다.
//     - `.keep` 과 handoff/.keep 에 적은 이름, `compare-keys`(모델 비교의 순서 파일)는 남긴다
//     - 심볼릭 링크와 파일·폴더가 아닌 것은 건드리지 않는다
//     - `pending/<워크트리 이름>/`: 그 이름의 워크트리가 있으면 남긴다. 없고 days 일 넘게 바뀌지 않았으면 `stale` 이다
//     - 이름에 `pr-<번호>` 가 있으면 그 PR 에 속한다. MERGED·CLOSED 면 기한 없이 `pr-closed`, OPEN 이나 상태를 모르면 남긴다
//     - 그 밖에는 이름에 살아 있는 워크트리 이름이나 열린 PR·워크트리 브랜치의 끝 조각(`/` 뒤)이 들어 있으면 남긴다.
//       어디에도 속하지 않고 days 일 넘게 바뀌지 않았으면 `stale` 이다. 폴더는 안의 가장 늦은 수정 시각으로 본다
//     - 워크트리 목록이나 열린 PR 목록을 읽지 못하면(null) 그 판단이 필요한 항목은 남긴다
// 모델 비교 리뷰 폴더(`<비교 id>-<건 번호>/`)는 비교 중이면 리뷰어 worker 가 읽으므로 days 안에는 남는다.

import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type HandoffReason = 'pr-closed' | 'stale'
export type HandoffCandidate = { path: string; rel: string; reason: HandoffReason; pr: number | null }
export type HandoffHost = {
  now: number
  days: number
  // 번호마다 PR 상태(OPEN, MERGED, CLOSED). 모르는 번호는 빼고 돌려준다
  prStates: (numbers: number[]) => Map<number, string>
  // 살아 있는 워크트리의 폴더 이름. 읽지 못하면 null
  worktrees: Set<string> | null
  // 열린 PR 과 워크트리의 브랜치 이름. 읽지 못하면 null
  branches: Set<string> | null
}

const DAY_MS = 86_400_000
const PR_NUMBER = /(?:^|[^a-z0-9])pr-([1-9]\d*)(?![0-9])/i
const ALWAYS_KEEP = new Set(['.keep', 'compare-keys'])
// 짧은 끝 조각(`fix`, `a`)은 아무 이름에나 들어 있어 남길 근거가 되지 않는다
const MIN_TOKEN = 4

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

function keepList(dir: string): Set<string> {
  try {
    return new Set(readFileSync(join(dir, '.keep'), 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  } catch { return new Set() }
}

export function prNumberOf(name: string): number | null {
  const m = PR_NUMBER.exec(name)
  return m ? Number(m[1]) : null
}

function tokens(host: HandoffHost): string[] | null {
  if (!host.worktrees || !host.branches) return null
  const found = new Set<string>([...host.worktrees])
  for (const branch of host.branches) found.add(branch.slice(branch.lastIndexOf('/') + 1))
  return [...found].filter((token) => token.length >= MIN_TOKEN)
}

export function handoffCandidates(dir: string, host: HandoffHost): HandoffCandidate[] {
  if (kind(dir) !== 'dir') return []
  const cutoff = host.now - host.days * DAY_MS
  const keep = keepList(dir)
  const stale = (path: string) => newestMtime(path) < cutoff
  const found: HandoffCandidate[] = []
  const owned: { path: string; name: string; pr: number }[] = []
  const owners = tokens(host)

  for (const name of list(dir)) {
    if (ALWAYS_KEEP.has(name) || keep.has(name)) continue
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
    const pr = prNumberOf(name)
    if (pr !== null) {
      owned.push({ path, name, pr })
      continue
    }
    if (!owners) continue
    if (owners.some((token) => name.includes(token))) continue
    if (stale(path)) found.push({ path, rel: name, reason: 'stale', pr: null })
  }

  if (owned.length) {
    const states = host.prStates([...new Set(owned.map(({ pr }) => pr))])
    for (const { path, name, pr } of owned) {
      const state = states.get(pr)
      if (state === 'MERGED' || state === 'CLOSED') found.push({ path, rel: name, reason: 'pr-closed', pr })
    }
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel))
}

function taken(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

// <trash>/handoff/<rel> 로 옮긴다. 같은 이름이 있으면 번호를 붙인다. 폴더도 옮긴다
export function moveHandoffEntry(candidate: HandoffCandidate, trash: string): string {
  const base = join(trash, 'handoff', candidate.rel)
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

export function reasonText(candidate: HandoffCandidate, days: number): string {
  return candidate.reason === 'pr-closed'
    ? `PR #${candidate.pr} 이 머지되거나 닫혔다`
    : `${days}일 넘게 바뀌지 않았고 열린 PR·워크트리·게시 대기에 속하지 않는다`
}
