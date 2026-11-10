// 남은 프로세스 끄기 (--kill-holders):
//     `worker-stop` 이 `process=none` 을 돌려줘도 그 worker 의 claude 세션, 로그인 셸, 플러그인 node, Gradle 같은
//     프로세스가 그 경로를 작업 디렉터리로 쥐고 남아 `remove-worktree.ts` 가 매번 거부한다.
//     이 옵션은 아래가 모두 참일 때만 그 프로세스를 TERM, HUP, KILL 순으로 끈다. 신호마다 --wait 초(최소 --poll-interval 초) 기다리고,
//     그때도 그 경로를 쓰는 pid 만 다시 골라 다음 신호를 보낸다. 로그인 셸은 TERM 을 무시해 HUP 이 필요하다.
//       - PR 이 MERGED 이거나 PR 없이 끝난 워크트리다
//       - lib/worker-state.ts 의 판정이 done 이다. --run 으로 찾은 그 경로의 worker 가 하나 이상이고 모두 끝났다
//         (completed, failed, canceled, 반납). 반납되지 않은 채 끊긴 dispatch 는 끝났는지 몰라 끄지 않는다
//       - 그 경로에 Orca 터미널이 남아 있지 않다
//       - 프로세스의 작업 디렉터리가 그 경로이거나 그 아래다
//     하나라도 거짓이면 끄지 않고 이유를 낸다. 위가 참이어도 아래 프로세스는 빼고 끈다.
//       - 이 명령과 그 조상
//       - 그 경로 안에 놓인 다른 워크트리를 작업 디렉터리로 쓰는 프로세스
//       - 조상에 Orca(`Orca.app/` 아래 실행 파일), `login`, 같은 경로를 쥔 프로세스 말고 다른 프로세스가 있는 것.
//         Orca 터미널은 `Orca` → `Orca Helper` → `login` → 로그인 셸로 이어진다(실측). iTerm 이나 VS Code 에서
//         그 폴더로 들어간 사용자 셸과 language server 는 조상이 그 앱이라 빠진다. 부모를 잃어 launchd(pid 1)
//         아래로 간 프로세스는 끈다
//     열린 파일로만 그 경로를 쥔 프로세스는 끄지 않는다.
//     워크트리 삭제를 막는 것은 작업 디렉터리이고, 작업 디렉터리가 밖에 있는 Gradle daemon 같은 프로세스는
//     다른 워크트리의 빌드도 맡을 수 있다.
import type { Holder } from '../lib/idle-shells.ts'
import type { Log } from './shared.ts'
import { basename } from 'node:path'
import { lines, run, under } from './shared.ts'
import { setTimeout as sleepMs } from 'node:timers/promises'

const STOP_SIGNALS = ['TERM', 'HUP', 'KILL']

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh'])

// 조상에 이 문자열이 든 실행 파일이 있으면 Orca 가 띄운 프로세스다
const ORCA_APP = 'Orca.app/'

// OMC session-end hook worker 의 명령줄에 든 문자열. 끄지도 세지도 않고 remove-worktree.ts 가 기다린다
const SESSION_END_MARKS = ['--omc-session-end-worker', 'hooks/session-end/worker.js']

// 프로세스 조회와 대기. 테스트가 대역으로 바꾼다
export type Host = {
  // 그 경로나 하위를 작업 디렉터리로 쓰는 프로세스의 pid 에서 작업 디렉터리로
  holderCwds: (path: string) => Map<string, string>
  // pid 에서 [ppid, command] 로
  psRows: () => Map<string, [string, string]>
  sleep: (seconds: number) => Promise<void>
  kill: (signal: string, pids: string[]) => void
}

export const REAL_HOST: Host = {
  holderCwds(path) {
    const found = new Map<string, string>()
    let pid: string | null = null
    for (const line of lines(run(['lsof', '-d', 'cwd', '-Fpn']).out)) {
      if (line.startsWith('p')) pid = line.slice(1)
      else if (line.startsWith('n') && pid !== null && under(line.slice(1), path)) found.set(pid, line.slice(1))
    }
    return found
  },
  psRows() {
    const rows = new Map<string, [string, string]>()
    for (const line of lines(run(['ps', '-axo', 'pid=,ppid=,command=']).out)) {
      const m = /^\s*(\S+)\s+(\S+)\s+(\S.*)$/.exec(line)
      if (m) rows.set(m[1], [m[2], m[3]])
    }
    return rows
  },
  sleep: (seconds) => sleepMs(seconds * 1000).then(() => undefined),
  kill(signal, pids) {
    run([killBin(), `-${signal}`, ...pids])
  },
}

function killBin(): string {
  return process.env.ORCH_KILL || 'kill'
}

export function holderPids(path: string, host: Host): string[] {
  return [...host.holderCwds(path).keys()]
}

function firstWord(command: string): string {
  return command ? command.split(/\s+/)[0] : ''
}

// 그 pid 가운데 OMC session-end hook worker 인 것. 세션이 끝난 뒤 `.omc/` 를 쓰다 스스로 끝난다.
export function sessionEndHooks(pids: string[], host: Host): string[] {
  const rows = host.psRows()
  return pids.filter((pid) => {
    const row = rows.get(pid)
    return row !== undefined && SESSION_END_MARKS.some((mark) => row[1].includes(mark))
  })
}

// 그 프로세스가 모두 자식 없는 로그인 셸이면 true. 로그인 셸은 argv[0] 이 `-` 로 시작한다(`-/bin/zsh`).
export function onlyIdleShells(pids: string[], host: Host): boolean {
  if (pids.length === 0) return false
  const table = host.psRows()
  const parents = new Set([...table.values()].map(([ppid]) => ppid))
  for (const pid of pids) {
    const argv0 = firstWord(table.get(pid)?.[1] ?? '')
    if (!argv0.startsWith('-') || !SHELLS.has(basename(argv0.slice(1))) || parents.has(pid)) return false
  }
  return true
}

// 그 경로를 쓰는 프로세스가 빠지기를 기다린다. 남은 pid 목록을 돌려준다.
// seconds 동안 interval 마다 다시 본다. 마지막 간격은 남은 시간만큼 줄인다. seconds 가 0 이면 한 번만 본다.
export async function waitFree(path: string, seconds: number, interval = 1, host: Host = REAL_HOST): Promise<string[]> {
  let pids = holderPids(path, host)
  let remaining = seconds
  while (pids.length && remaining > 0) {
    const delay = Math.min(interval, remaining)
    await host.sleep(delay)
    remaining -= delay
    pids = holderPids(path, host)
  }
  return pids
}

// 이 명령과 그 조상의 pid. 이 명령을 부른 셸이 그 경로에 있어도 끄지 않는다.
function ownAncestors(host: Host): Set<string> {
  const parent = new Map([...host.psRows()].map(([pid, [ppid]]) => [pid, ppid] as const))
  const seen = new Set<string>()
  let pid: string | undefined = String(process.pid)
  while (pid && !seen.has(pid) && pid !== '0' && pid !== '1') {
    seen.add(pid)
    pid = parent.get(pid)
  }
  return seen
}

export function describe(pids: string[], host: Host): string {
  const rows = host.psRows()
  return pids
    .map((pid) => {
      const row = rows.get(pid)
      return row ? `${pid} ${basename(firstWord(row[1]).replace(/^-+/, ''))}` : pid
    })
    .join(', ')
}

// 조상에 Orca, `login`, 같은 경로를 쥔 프로세스 말고 다른 프로세스가 있으면 true. 조상을 못 읽어도 true 다.
function startedOutsideOrca(pid: string, rows: Map<string, [string, string]>, holders: Map<string, string>): boolean {
  const seen = new Set<string>()
  let current = pid
  for (;;) {
    const row = rows.get(current)
    if (row === undefined) return true
    current = row[0]
    if (current === '0' || current === '1') return false
    if (seen.has(current)) return true
    seen.add(current)
    const command = rows.get(current)?.[1] ?? ''
    if (!(holders.has(current) || command.includes(ORCA_APP) || basename(firstWord(command)) === 'login')) return true
  }
}

// 끌 pid 목록. 빼는 것은 머리 주석의 「남은 프로세스 끄기」 가 정한다.
function targets(path: string, nested: string[], host: Host, log?: Log): string[] {
  const cwds = host.holderCwds(path)
  const rows = host.psRows()
  const keep = ownAncestors(host)
  for (const pid of sessionEndHooks([...cwds.keys()], host)) keep.add(pid)
  const chosen: string[] = []
  const skipped: string[] = []
  for (const [pid, cwd] of cwds) {
    if (keep.has(pid) || nested.some((other) => under(cwd, other)) || startedOutsideOrca(pid, rows, cwds)) skipped.push(pid)
    else chosen.push(pid)
  }
  if (skipped.length && log) log(`  Orca 밖에서 띄웠거나 다른 워크트리를 쓰는 프로세스라 끄지 않는다: ${describe(skipped, host)}`)
  return chosen
}

// targets 가 고른 프로세스를 TERM, HUP, KILL 순으로 끈다. 그 경로를 아직 쓰는 pid 목록을 돌려준다.
// 신호마다 max(seconds, interval) 초 기다리고 대상을 다시 고른다. 앞 신호로 빠진 pid 가 다른 프로세스로 재사용돼도 닿지 않는다.
export async function stopHolders(
  path: string,
  nested: string[],
  seconds: number,
  log: Log,
  interval = 1,
  host: Host = REAL_HOST,
): Promise<string[]> {
  let pids = targets(path, nested, host, log)
  for (const signal of STOP_SIGNALS) {
    if (pids.length === 0) break
    log(`  ${signal} 를 보낸다: ${describe(pids, host)}`)
    host.kill(signal, pids)
    await waitFree(path, Math.max(seconds, interval), interval, host)
    pids = targets(path, nested, host)
  }
  return holderPids(path, host)
}

// 그 경로를 작업 디렉터리로 쓰는 프로세스의 명령과 자식 유무(lib/idle-shells.ts 의 Holder)
export function holdersOf(path: string, host: Host): Holder[] {
  const rows = host.psRows()
  const parents = new Set([...rows.values()].map(([ppid]) => ppid))
  return holderPids(path, host)
    .filter((pid) => rows.has(pid))
    .map((pid) => ({ pid, command: (rows.get(pid) as [string, string])[1], hasChildren: parents.has(pid) }))
}
