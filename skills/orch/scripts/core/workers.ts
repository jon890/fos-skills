import { basename } from 'node:path'

// 살아 있는 dispatch 의 상태
export const LIVE_DISPATCH = new Set(['pending', 'dispatched', 'running'])

export function liveWorkerOn(item: { worktree: string | null; branch: string | null }, live: ReadonlySet<string>, branches: ReadonlyMap<string, string>): boolean {
  const names = new Set([...live].map(value => basename(value)))
  const byBranch = item.branch ? branches.get(item.branch) : undefined
  return !!((item.worktree && names.has(basename(item.worktree))) || (byBranch && live.has(byBranch)))
}
