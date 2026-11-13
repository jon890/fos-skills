// 부모 lifecycle.ts 가 쓰는 옛 번들 판정 상태와 다시 뜰 때의 판정이다. 직접 실행하지 않는다.
// 실패한 진입점과 처음 발견한 시각은 메모리에만 둔다. 사람이 다시 띄우면 다시 시도하기 위해서다.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { bundleVersion } from '../lib/bundle.ts'
import { mainCheckout } from '../lib/git.ts'
import { pathOf } from '../lib/paths.ts'
import { run } from '../lib/proc.ts'
import { pidFileAlive } from '../lib/process.ts'

export const STALE_WAIT_MAX_MS = 60 * 60 * 1000
export type SelfUpdate = { target: string | null; since: number | null; failed: string | null; waitReason: string | null }
export function newSelfUpdate(): SelfUpdate { return { target: null, since: null, failed: null, waitReason: null } }
export function heirEntry(bundle: string): string { return join(bundle, 'skills', 'orch', 'scripts', 'loop', 'orch-loop.ts') }

export function observe(s: SelfUpdate, target: string | null, now: number, own: string): string | null {
  if (target === null) { Object.assign(s, newSelfUpdate()); return null }
  if (target === s.target) return null
  s.target = target
  s.failed = null
  s.since ??= now
  return `LOOP-STALE ${bundleVersion(own) ?? '-'} ${bundleVersion(target) ?? '-'} ${heirEntry(target)}`
}

export function decide(input: { target: string | null; failed: string | null; since: number | null; now: number; busy: string | null; lastCode: number }): { kind: 'none' } | { kind: 'wait'; reason: string } | { kind: 'go' } {
  if (input.target === null || input.failed === heirEntry(input.target)) return { kind: 'none' }
  if (input.lastCode === 2 || (input.since !== null && input.now - input.since >= STALE_WAIT_MAX_MS)) return { kind: 'go' }
  return input.busy === null ? { kind: 'go' } : { kind: 'wait', reason: input.busy }
}

export function busyReason(repo: string): string | null {
  const queue = pathOf('queue', repo)
  let files: string[]
  try { files = readdirSync(queue).sort() }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return '마무리 목록을 읽지 못했다'
    files = []
  }
  for (const file of files) {
    const pr = /^finish-(\d+)\.pid$/.exec(file)?.[1]
    if (pr && pidFileAlive(join(queue, file))) return `마무리 PR ${pr}`
  }
  const ps = run([process.env.PS || 'ps', '-Ao', 'pid=,command='])
  if (ps.code !== 0) return '프로세스 목록을 읽지 못했다'
  for (const line of ps.stdout.split('\n')) {
    const found = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!found || !/merge_queue\.|merge-queue\.sh|merge-with-finish\./.test(found[2])) continue
    const target = /\s--repo\s+(\S+)/.exec(found[2])?.[1]
    if (!target || mainCheckout(target) === mainCheckout(repo)) return `머지 큐 pid ${found[1]}`
  }
  return null
}
