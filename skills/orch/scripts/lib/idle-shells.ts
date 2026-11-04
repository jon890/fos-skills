// 워크트리를 붙잡은 것이 Orca 기본 셸뿐인지 판정하는 한 벌이다.
//
// Orca 는 워크트리를 화면에서 열 때 에이전트 없는 셸 터미널(「Terminal 1」, `zsh -l`)을 띄운다. 코디네이터가 끝난 worker 터미널을
// 닫았을 때도 그 탭에 같은 셸을 다시 연다. 이 셸이 워크트리를 작업 디렉터리로 쥐고 있으면 `git worktree remove` 앞의 점유 확인이
// 거부한다. 어느 dispatch 의 것도 아니어서 cleanup-sweep.ts 의 남은 프로세스 끄기도 건너뛰었다(2026-11-04 ai-analysis).
//
// 사용처: cleanup-sweep.ts(끝난 워크트리의 남은 셸, 확인하지 못한 터미널), remove-worktree.ts(점유 프로세스 대기 전).
//
// 판정(idleShellVerdict, 위에서부터 처음 걸린 것이 남길 이유다):
//     1  그 경로의 Orca 터미널이 없다                                   남긴다. 닫을 터미널이 없다
//     2  그 경로의 터미널 가운데 agentIdentity 가 있는 것이 있다          남긴다. 에이전트 터미널이다
//     3  그 경로의 터미널 가운데 claimed 에 든 것이 있다                  남긴다. 살아 있는 worker 나 다른 Run 의 터미널이다
//     4  그 경로를 작업 디렉터리로 쓰는 프로세스가 없다                    남긴다. 셸이 워크트리를 쥐고 있지 않다
//     5  그 프로세스 가운데 로그인 셸(argv[0] 이 `-zsh`, `-/bin/zsh` 꼴)이 아니거나 자식이 있는 것이 있다
//                                                                      남긴다. 무언가 돌고 있다
//     6  셸 수가 터미널 수보다 적다                                     남긴다. 작업 폴더를 옮긴 터미널이 있다
//     그 밖                                                            그 경로의 터미널을 모두 닫는다
//     경로는 터미널의 worktreePath 와 글자 그대로 비교한다. `orca terminal list` 가 워크트리 경로를 그대로 준다.
//
// idleShellVerdict 는 조회하지 않는다. 터미널은 orcaTerminals, 프로세스는 holderRows 로 읽어 넘긴다.

import { basename } from 'node:path'
import { orcaJson } from './orca.ts'
import { run } from './proc.ts'

export type ShellTerminal = Record<string, unknown>
// 그 경로를 작업 디렉터리로 쓰는 프로세스. command 는 `ps -o command=` 의 값이다
export type Holder = { pid: string; command: string; hasChildren: boolean }
export type IdleShellVerdict = { close: string[] } | { keep: string }

export const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh'])

function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && value !== false
}

// 로그인 셸이면 true. 로그인 셸은 argv[0] 이 `-` 로 시작한다(`-/bin/zsh`, `-zsh`)
export function loginShell(command: string): boolean {
  const argv0 = command.trim().split(/\s+/)[0] ?? ''
  return argv0.startsWith('-') && SHELLS.has(basename(argv0.slice(1)))
}

// 머리 주석의 판정. claimed 는 닫으면 안 되는 터미널 handle(살아 있는 worker, 다른 Run 의 worker)이다
export function idleShellVerdict(input: {
  path: string
  terminals: readonly ShellTerminal[]
  holders: readonly Holder[]
  claimed?: ReadonlySet<unknown>
}): IdleShellVerdict {
  const here = input.terminals.filter((t) => t.worktreePath === input.path && typeof t.handle === 'string' && t.handle)
  if (here.length === 0) return { keep: '그 경로에 Orca 터미널이 없다' }
  const agent = here.find((t) => given(t.agentIdentity))
  if (agent) return { keep: `에이전트 터미널 ${String(agent.handle)}` }
  const claimed = here.find((t) => input.claimed?.has(t.handle))
  if (claimed) return { keep: `worker 터미널 ${String(claimed.handle)}` }
  if (input.holders.length === 0) return { keep: '그 경로를 쓰는 프로세스가 없다' }
  const busy = input.holders.find((h) => !loginShell(h.command) || h.hasChildren)
  if (busy) {
    const name = basename((busy.command.trim().split(/\s+/)[0] ?? '').replace(/^-+/, ''))
    return { keep: busy.hasChildren && loginShell(busy.command) ? `자식이 있는 셸 ${busy.pid}` : `셸이 아닌 프로세스 ${busy.pid} ${name}` }
  }
  if (input.holders.length < here.length) return { keep: '셸 수가 터미널 수보다 적다(작업 폴더를 옮긴 터미널이 있다)' }
  return { close: here.map((t) => String(t.handle)) }
}

// pid 마다 명령과 자식 유무. ps 를 읽지 못하면 null 이다. 목록에 없는 pid(그사이 끝났다)는 뺀다
export function holderRows(pids: readonly string[]): Holder[] | null {
  const done = run(['ps', '-axo', 'pid=,ppid=,command='])
  if (done.code !== 0) return null
  const commands = new Map<string, string>()
  const parents = new Set<string>()
  for (const line of done.stdout.split('\n')) {
    const m = /^\s*(\S+)\s+(\S+)\s+(\S.*)$/.exec(line)
    if (!m) continue
    commands.set(m[1], m[3])
    parents.add(m[2])
  }
  return pids.filter((pid) => commands.has(pid)).map((pid) => ({ pid, command: commands.get(pid) as string, hasChildren: parents.has(pid) }))
}

// `orca terminal list` 의 터미널. 읽지 못하면 null 이다
export function orcaTerminals(): ShellTerminal[] | null {
  const done = orcaJson<{ terminals?: unknown }>(['terminal', 'list'])
  if (!done.ok || typeof done.data !== 'object' || done.data === null || !Array.isArray(done.data.terminals)) return null
  return done.data.terminals.filter((t): t is ShellTerminal => typeof t === 'object' && t !== null && !Array.isArray(t))
}

export function closeTerminal(handle: string): boolean {
  return orcaJson(['terminal', 'close', '--terminal', handle]).ok
}
