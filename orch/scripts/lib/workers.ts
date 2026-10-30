// 브랜치의 워크트리와 그 워크트리의 worker-list 행 찾기 한 벌이다.
// 사용처: notify-conflicts.ts(충돌한 PR 의 worker 에게 알리기), orch-loop.ts(체크가 실패한 PR 의 worker 에게 알리기),
// orch-doctor.ts(--run 의 worker 판정. workerRows 만 쓴다).

import { git } from './git.ts'
import { orcaJson } from './orca.ts'
import type { RunOptions } from './proc.ts'

type Json = Record<string, unknown>

// 살아 있는 dispatch 의 상태
export const LIVE_DISPATCH = new Set(['pending', 'dispatched', 'running'])

function obj(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {}
}

// {브랜치: 워크트리 경로}.
export function worktreePaths(repo: string): Map<string, string> {
  const done = git(repo, ['worktree', 'list', '--porcelain'])
  const paths = new Map<string, string>()
  let path: string | null = null
  for (const line of done.code === 0 ? done.stdout.split('\n') : []) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('branch refs/heads/') && path) paths.set(line.slice('branch refs/heads/'.length), path)
  }
  return paths
}

// worker-list 의 행을 모든 페이지에 걸쳐 읽는다. 첫 페이지만 읽으면 다른 worker 를 놓친다(lib/orca.ts 머리 주석).
export function workerRows(run: string, opts?: RunOptions): { ok: true; rows: Json[] } | { ok: false; error: string } {
  const rows: Json[] = []
  const seen = new Set<string>()
  let cursor = ''
  for (;;) {
    const got = orcaJson<unknown>(['orchestration', 'worker-list', ...(run ? ['--run', run] : []), '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])], opts)
    if (!got.ok) return got
    const result = obj(got.data)
    rows.push(...(Array.isArray(result.workers) ? result.workers.map(obj) : []))
    const next = obj(result.page).nextCursor
    cursor = typeof next === 'string' ? next : ''
    if (!cursor) return { ok: true, rows }
    if (seen.has(cursor)) return { ok: false, error: 'worker-list 의 다음 페이지가 앞 페이지와 같다' }
    seen.add(cursor)
  }
}

// 그 워크트리의 worker-list 행. 살아 있는 dispatch 를 먼저 고르고, 같은 상태끼리는 목록의 뒤쪽이다. 없으면 null.
export function workerFor(rows: Json[], path: string): Json | null {
  const here = rows.filter((row) => String(obj(row.resource).worktreeId ?? '').endsWith(`::${path}`) && row.dispatchId)
  const live = here.filter((row) => LIVE_DISPATCH.has(String(row.dispatchStatus)))
  const pick = live.length > 0 ? live : here
  return pick.length > 0 ? pick[pick.length - 1] : null
}
