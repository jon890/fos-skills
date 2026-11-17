// 루프 한 틱이 띄우는 자식에게 저장소와 등록 Run 을 넘긴다. 닫힌 터미널의 run-current 에 기대지 않는다.
// 자식은 같은 저장소의 아직 등록된 Run 만 믿는다. 틱 밖에서는 이전 환경을 복구한다.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { realPath } from './fs.ts'
import { pathOf } from './paths.ts'
import { mainCheckout } from './git.ts'
import { readLoop, registeredRuns } from './loop.ts'
import { run as execute } from './proc.ts'

export const LOOP_CALLER_ENV = 'ORCH_LOOP_CALLER'

function processInfo(pid: number): { parent: number; identity: string } | null {
  if (!Number.isInteger(pid) || pid < 1) return null
  const got = execute(['ps', '-p', String(pid), '-o', 'ppid=', '-o', 'lstart=', '-o', 'command='], { env: { LC_ALL: 'C' } })
  const row = got.code === 0 ? got.stdout.trim().match(/^(\d+)\s+(.+)$/) : null
  return row ? { parent: Number(row[1]), identity: row[2] } : null
}

function loopAncestor(pid: number, identity: string): boolean {
  const seen = new Set<number>()
  for (let current = process.pid; current > 1 && !seen.has(current);) {
    seen.add(current)
    const info = processInfo(current)
    if (!info) return false
    if (current === pid) return info.identity === identity && /orch-loop/.test(info.identity)
    current = info.parent
  }
  return false
}

export function loopCaller(repo: string): string | null {
  try {
    const value = JSON.parse(process.env[LOOP_CALLER_ENV] ?? '')
    const state = readLoop(repo)
    return value && typeof value.repo === 'string' && typeof value.run === 'string' &&
      typeof value.identity === 'string' && mainCheckout(value.repo) === mainCheckout(repo) &&
      registeredRuns(repo)[0]?.run === value.run && state !== null && state.run === value.run && state.pid === value.pid &&
      loopAncestor(value.pid, value.identity) ? value.run : null
  } catch { return null }
}

export async function withLoopCaller<T>(repo: string, run: string | null, action: () => Promise<T>): Promise<T> {
  const previous = process.env[LOOP_CALLER_ENV]
  const state = readLoop(repo)
  const identity = state ? processInfo(state.pid)?.identity : null
  if (run && state?.run === run && registeredRuns(repo)[0]?.run === run && identity && loopAncestor(state.pid, identity)) {
    process.env[LOOP_CALLER_ENV] = JSON.stringify({ repo: mainCheckout(repo), run, pid: state.pid, identity })
  } else delete process.env[LOOP_CALLER_ENV]
  try { return await action() }
  finally {
    if (previous === undefined) delete process.env[LOOP_CALLER_ENV]
    else process.env[LOOP_CALLER_ENV] = previous
  }
}

// 성공한 우회의 자식 프로세스만 같은 저장소의 기록과 알림을 재사용한다.
const RECEIPT_ENV = 'ORCH_MAIN_GUARD_RECEIPT'
const TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  'queue merge': ['queue run', 'queue finish'],
  'queue run': ['cleanup sweep'],
  'queue finish': ['cleanup sweep'],
  'cleanup sweep': ['cleanup worktree'],
  'worker continue': ['worker send'],
  'worker send': ['worker launch'],
  'worker launch': ['worker worktree'],
}
export const newOverrideToken = (): string => randomBytes(32).toString('hex')
export const overrideHash = (token: string): string => createHash('sha256').update(token).digest('hex')

export function inheritOverride(repo: string, command: string, reason: unknown): { main: string; reason: string } | null {
  try {
    const marker = JSON.parse(process.env[RECEIPT_ENV] ?? '')
    if (typeof marker.file !== 'string' || typeof marker.pid !== 'number' || marker.pid === process.pid ||
        typeof marker.token !== 'string' || !/^[a-f0-9]{64}$/.test(marker.token) ||
        !TRANSITIONS[marker.command]?.includes(command)) return null
    if (dirname(realPath(marker.file)) !== realPath(join(pathOf('state', repo), 'launched-workers', 'not-main'))) return null
    const row = JSON.parse(readFileSync(marker.file, 'utf8'))
    if (row.repo !== mainCheckout(repo) || row.notified !== true || typeof row.main_run !== 'string' ||
        typeof row.caller_run !== 'string' || typeof row.reason !== 'string' || !row.reason.trim()) return null
    if (overrideHash(marker.token) !== row.receipt_hash) return null
    if (reason !== undefined && reason !== row.reason) return null
    shareOverride(marker.file, marker.token, command)
    return { main: row.main_run, reason: row.reason }
  } catch { return null }
}

export function shareOverride(file: string, token: string, command: string): void {
  process.env[RECEIPT_ENV] = JSON.stringify({ file, token, command, pid: process.pid })
}
