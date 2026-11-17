// 루프 한 틱이 띄우는 자식에게 저장소와 등록 Run 을 넘긴다. 닫힌 터미널의 run-current 에 기대지 않는다.
// 자식은 같은 저장소의 아직 등록된 Run 만 믿는다. 틱 밖에서는 이전 환경을 복구한다.
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
