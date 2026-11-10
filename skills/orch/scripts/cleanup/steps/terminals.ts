// `orca <args> --json` 응답의 result. 실패하거나 result 가 없으면 null 이다.
import type { Args, Log, Pr, Terminal } from './shared.ts'
import { LookupError, rowHandles } from '../../lib/ownership.ts'
import { REAL_HOST, holderPids, holdersOf, onlyIdleShells } from './processes.ts'
import { RUN_TIMEOUT_SEC, resourceOf, run, truthy } from './shared.ts'
import type { WorkerRow } from '../../lib/ownership.ts'
import { basename } from 'node:path'
import { closeTerminal as closeOrcaTerminal, orcaBin, withFull } from '../../lib/orca.ts'
import { idleShellVerdict } from '../../lib/idle-shells.ts'
import { isFinished } from '../../lib/worker-state.ts'
import { isObject } from '../../core/json.ts'
import { readLaunch } from '../../lib/launched.ts'
import { realPath } from '../../lib/fs.ts'

function orcaResult(args: string[]): unknown {
  const done = run([orcaBin(), ...withFull(args), '--json'])
  if (done.code !== 0) return null
  try {
    const data: unknown = JSON.parse(done.out)
    return isObject(data) ? (data.result ?? null) : null
  } catch {
    return null
  }
}

// 다른 Run 의 worker 가 쥔 살아 있는 터미널 handle 집합. 모든 Run 의 worker 를 읽지 못하면 null 이다.
export async function foreignHandles(runId: string, workers: () => Promise<WorkerRow[]>): Promise<Set<unknown> | null> {
  try {
    const handles = new Set<unknown>()
    for (const w of await workers()) {
      if (w.runId !== runId && w.terminalState === 'active') for (const h of rowHandles(w)) handles.add(h)
    }
    return handles
  } catch (e) {
    if (e instanceof LookupError) return null
    throw e
  }
}

// 그 경로에서 이 Run 이 닫으면 안 되는 터미널. --run 이 없으면 빈 목록이다.
export function foreignAt(args: Args, mine: WorkerRow[], terminals: Terminal[], path: string): string[] {
  if (!args.run) return []
  const here = terminalsAt(terminals, path)
  if (args.foreign === null) {
    const own = new Set(mine.map((w) => w.agentTerminalHandle))
    return here.filter((h) => !own.has(h))
  }
  const foreign = args.foreign
  return here.filter((h) => foreign.has(h))
}

export function workersAt(workers: WorkerRow[], path: string): WorkerRow[] {
  return workers.filter((w) => String(resourceOf(w).worktreeId ?? '').endsWith(`::${path}`))
}

// 살아 있는 터미널 목록. 조회에 실패하면 null 이다.
export function liveTerminals(): Terminal[] | null {
  const result = orcaResult(['terminal', 'list'])
  if (!isObject(result)) return null
  const terminals = result.terminals ?? []
  if (!Array.isArray(terminals)) return null
  return terminals.filter(isObject)
}

export function terminalsAt(terminals: Terminal[] | null, path: string): string[] {
  const handles: string[] = []
  for (const t of terminals ?? []) if (t.worktreePath === path && typeof t.handle === 'string' && t.handle) handles.push(t.handle)
  return handles
}

export function closeTerminals(handles: string[], apply: boolean, log: Log, what = '터미널'): void {
  for (const handle of handles) {
    if (apply) log(closeOrcaTerminal(handle, { checkResponse: false, timeoutMs: RUN_TIMEOUT_SEC * 1000 }) ? `  ${what} 닫음 ${handle}` : `  ${what} 닫기 실패 ${handle}`)
    else log(`  ${what}을 닫을 것 ${handle}`)
  }
}

// Python fnmatch 와 같은 glob 판정. `*` 와 `?` 는 `/` 에도 맞고, 닫는 `]` 가 없는 `[` 는 글자 그대로다.
function globMatch(name: string, pattern: string): boolean {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      let j = i + 1
      if (pattern[j] === '!') j++
      if (pattern[j] === ']') j++
      while (j < pattern.length && pattern[j] !== ']') j++
      if (j >= pattern.length) {
        re += '\\['
        continue
      }
      let body = pattern.slice(i + 1, j).replaceAll('\\', '\\\\')
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      else if (body.startsWith('^')) body = `\\${body}`
      re += `[${body}]`
      i = j
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 's').test(name)
}

// 하위 에이전트 워크트리이고 그 경로를 쓰는 프로세스가 빈 로그인 셸뿐인지.
export function idleAgentPath(args: Args, path: string): boolean {
  return globMatch(basename(path), args.agentGlob) && onlyIdleShells(holderPids(path, REAL_HOST), REAL_HOST)
}

// theirs 가 모두 Orca 기본 셸이면 true. 판정은 lib/idle-shells.ts 의 idleShellVerdict 한 곳이다.
// Orca 는 PTY pid 를 주지 않아 `agentIdentity` 와 그 경로를 쓰는 프로세스로 판정한다.
// 어느 dispatch 의 터미널인지 몰라도 에이전트가 없고 자식 없는 로그인 셸뿐이면 닫는다(2026-11-04 ai-analysis 의 「Terminal 1」)
export function emptyShells(path: string, theirs: string[], terminals: Terminal[]): boolean {
  if (theirs.length === 0) return false
  const mine = terminals.filter((t) => theirs.includes(t.handle as string))
  if (mine.length !== theirs.length) return false
  return 'close' in idleShellVerdict({ path, terminals: mine, holders: holdersOf(path, REAL_HOST) })
}

// --close-own-taken-over 로 소유 확인에서 뺄 터미널 handle 집합. 조건 하나라도 어긋나면 빈 집합이다.
export function takenOverOwn(args: Args, mine: WorkerRow[], terminals: Terminal[], path: string): Set<unknown> {
  if (!(args.closeOwnTakenOver && args.run)) return new Set()
  const entries = new Map(terminals.map((t) => [t.handle, t] as const))
  const handles = new Set<unknown>()
  for (const w of mine) {
    const resource = resourceOf(w)
    const handle = truthy(resource.terminalHandle) ? resource.terminalHandle : w.agentTerminalHandle
    const entry = entries.get(handle)
    const runId = 'runId' in w ? w.runId : args.run
    if (
      runId === args.run &&
      w.dispatchStatus === 'completed' &&
      resource.ownershipState === 'user_owned' &&
      resource.retainedReason === 'user_takeover' &&
      entry &&
      entry.worktreePath === path &&
      !truthy(entry.agentIdentity)
    ) {
      handles.add(handle)
    }
  }
  if (handles.size && !onlyIdleShells(holderPids(path, REAL_HOST), REAL_HOST)) return new Set()
  return handles
}

// 코디네이터가 launch-worker.ts 로 띄운 것으로 기록돼 있고 끝난 dispatch 의 터미널 handle.
// worker 행의 dispatchId 에 기록이 있고, 기록한 워크트리가 이 경로이며, 기록한 터미널이 그 행의 터미널이어야 한다.
// 같은 터미널을 아직 끝나지 않은 dispatch 가 이어 쓰면 뺀다. 사람이 연 터미널은 기록이 없어 들지 않는다.
export function launchedOwn(repo: string, mine: WorkerRow[], terminals: Terminal[], path: string): Set<unknown> {
  const here = new Set<unknown>(terminalsAt(terminals, path))
  const own = new Set<unknown>()
  const busy = new Set<unknown>()
  try {
    for (const w of mine) {
      const handles = rowHandles(w)
      const live = [...handles].filter((h) => here.has(h))
      if (!isFinished(w)) {
        for (const h of live) busy.add(h)
        continue
      }
      const record = typeof w.dispatchId === 'string' ? readLaunch(repo, w.dispatchId) : null
      if (!record || realPath(record.worktree) !== realPath(path)) continue
      if (record.terminal && !handles.has(record.terminal)) continue
      for (const h of live) own.add(h)
    }
  } catch (e) {
    if (e instanceof LookupError) return new Set()
    throw e
  }
  for (const h of busy) own.delete(h)
  return own
}

export function closeForClosedPr(handles: string[], pr: Pr, apply: boolean, log: Log, indent: string): void {
  const tag = `(CLOSED #${pr.number})`
  for (const handle of handles) {
    if (apply) log(closeOrcaTerminal(handle, { checkResponse: false, timeoutMs: RUN_TIMEOUT_SEC * 1000 }) ? `${indent}터미널 닫음 ${handle} ${tag}` : `${indent}터미널 닫기 실패 ${handle} ${tag}`)
    else log(`${indent}닫을 것: ${handle} ${tag}`)
  }
}

// 이번 실행에서 반납한 dispatch. 끝난 dispatch 를 먼저 반납한 워크트리를 치울 때 같은 dispatch 를 다시 반납하지 않는다
const released = new Set<string>()

export function releaseDispatches(mine: WorkerRow[], apply: boolean, log: Log, indent: string): void {
  for (const w of mine) {
    const dispatch = w.dispatchId
    if (!truthy(dispatch) || resourceOf(w).releaseState === 'released' || released.has(String(dispatch))) continue
    if (apply) {
      const done = run([orcaBin(), 'orchestration', 'worker-release', '--dispatch', String(dispatch), '--json'])
      if (done.code === 0) released.add(String(dispatch))
      log(done.code === 0 ? `${indent}dispatch release ${dispatch}` : `${indent}dispatch release 실패 ${dispatch}`)
    } else {
      log(`${indent}dispatch 를 release 할 것 ${dispatch}`)
    }
  }
}
