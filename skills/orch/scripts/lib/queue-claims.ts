// 머지 큐가 맡은 PR 의 기록. 같은 PR 에 머지 큐가 둘 뜨지 않게 한다(2026-11-20 fos-assistant 의 같은 PR 에 큐 프로세스 둘).
//
// 파일: <orch 루트>/state/queue-claims/<pid>.json. `orch queue merge`(merge-with-finish.ts) 프로세스 하나에 파일 하나다.
//   값: { pid, prs }. prs 는 그 호출이 맡은 PR 번호다. 상주 루프의 자동 머지도 같은 명령으로 걸므로 같은 자리에 남는다.
//   시작할 때 쓰고 끝날 때 지운다. 신호로 죽어 남은 파일은 pid 가 머지 큐 프로세스가 아니면 무시하고, 다음 호출이 지운다.
//
// 이미 맡은 PR(claimedPrs): 아래 둘 가운데 하나에 든 PR 이다. pid 가 지금 머지 큐 프로세스(lib/queue-process.ts 의 isQueueCommand)인 기록만 센다.
//   - 다른 프로세스의 맡은 PR 기록. 큐 잠금을 기다리는 동안(QUEUE-WAIT)에도 남아 있어 차례 기록이 아직 없는 큐도 본다
//   - 도는 머지 큐의 차례 기록(lib/queue-turn.ts)의 pr 과 prs. 이 기록 전에 시작한 큐와 `orch queue run` 으로 직접 건 큐를 본다
//   단 도는 큐가 이번 실행에서 뺀 PR(차례 기록의 held)이고 어느 차례 기록의 prs 에도 없으면 맡지 않은 것으로 본다.
//   보류를 고친 PR 을 그 큐가 끝나기 전에 다시 걸 수 있게 하려는 것이다.

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeParent, pathOf } from './paths.ts'
import type { QueueTurn } from './queue-turn.ts'
import { QUEUE_VALUE_OPTIONS } from '../core/queue-options.ts'

export type Claim = { pid: number; prs: number[] }

export function claimDir(repo: string): string {
  return join(pathOf('state', repo), 'queue-claims')
}

// 머리 주석의 「이미 맡은 PR」. 받은 PR 가운데 맡은 것을 PR 번호 → 맡은 pid 로 낸다. claims 와 turns 는 살아 있는 머지 큐의 것만 준다
export function claimedPrs(prs: number[], claims: Claim[], turns: QueueTurn[], self: number): Map<number, number> {
  const remaining = new Set(turns.flatMap((turn) => [...turn.prs, ...(turn.pr === null ? [] : [turn.pr])]))
  const dropped = new Set(turns.flatMap((turn) => turn.held.map((held) => held.pr)))
  const found = new Map<number, number>()
  for (const turn of turns) {
    if (turn.pid === self) continue
    for (const pr of [...turn.prs, ...(turn.pr === null ? [] : [turn.pr])]) if (prs.includes(pr) && !found.has(pr)) found.set(pr, turn.pid)
  }
  for (const claim of claims) {
    if (claim.pid === self) continue
    for (const pr of claim.prs) {
      if (!prs.includes(pr) || found.has(pr)) continue
      if (dropped.has(pr) && !remaining.has(pr)) continue
      found.set(pr, claim.pid)
    }
  }
  return found
}

export type Skipped = { pr: number; pid: number; reason: string }

// 머지 큐 인자(queue)에서 맡은 PR(taken)을 뺀다. `--chain` 묶음에 맡은 PR 이 있으면 묶음 전체를 뺀다. 뒤 PR 이 앞 PR 의 머지를 기다리기 때문이다.
// 뺀 PR 의 `--last-of-task`, `--chain` 인자도 뺀다. 값을 받는 옵션(QUEUE_VALUE_OPTIONS) 바로 뒤의 숫자는 PR 로 읽지 않는다
export function dropTaken(queue: string[], taken: Map<number, number>): { queue: string[]; skipped: Skipped[] } {
  const chainOf = (value: string) => value.split(',').map(Number)
  const chains: number[][] = []
  for (let i = 0; i < queue.length; i++) {
    if (queue[i] === '--chain' && i + 1 < queue.length) chains.push(chainOf(queue[i + 1]))
    else if (queue[i].startsWith('--chain=')) chains.push(chainOf(queue[i].slice('--chain='.length)))
  }
  const skipped = new Map<number, Skipped>()
  for (const [pr, pid] of taken) skipped.set(pr, { pr, pid, reason: `pid ${pid} 의 머지 큐가 이미 맡았다` })
  for (const chain of chains) {
    const head = chain.find((pr) => taken.has(pr))
    if (head === undefined) continue
    for (const pr of chain) if (!skipped.has(pr)) skipped.set(pr, { pr, pid: taken.get(head)!, reason: `묶음의 #${head} 를 pid ${taken.get(head)} 의 머지 큐가 이미 맡았다` })
  }
  if (skipped.size === 0) return { queue, skipped: [] }
  const out: string[] = []
  for (let i = 0; i < queue.length; i++) {
    const arg = queue[i]
    if (QUEUE_VALUE_OPTIONS.includes(arg) && i + 1 < queue.length) {
      const value = queue[i + 1]
      i += 1
      if (arg === '--last-of-task' && skipped.has(Number(value))) continue
      if (arg === '--chain' && chainOf(value).some((pr) => skipped.has(pr))) continue
      out.push(arg, value)
      continue
    }
    if (arg.startsWith('--chain=') && chainOf(arg.slice('--chain='.length)).some((pr) => skipped.has(pr))) continue
    const pr = /^(\d+)(?::.*)?$/s.exec(arg)
    if (pr && skipped.has(Number(pr[1]))) continue
    out.push(arg)
  }
  return { queue: out, skipped: [...skipped.values()].sort((a, b) => a.pr - b.pr) }
}

// 모든 기록. 형식이 틀린 파일은 넘어간다
export function readClaims(repo: string): Claim[] {
  let names: string[]
  try {
    names = readdirSync(claimDir(repo))
  } catch {
    return []
  }
  return names.filter((name) => /^\d+\.json$/.test(name)).flatMap((name) => {
    try {
      const data = JSON.parse(readFileSync(join(claimDir(repo), name), 'utf8')) as { pid?: unknown; prs?: unknown }
      const pid = Number(data.pid)
      if (!Number.isInteger(pid) || `${pid}.json` !== name || !Array.isArray(data.prs)) return []
      return [{ pid, prs: data.prs.map(Number).filter((pr) => Number.isInteger(pr) && pr > 0) }]
    } catch {
      return []
    }
  })
}

// 내 기록을 쓰고, 머지 큐 프로세스가 아닌 pid 의 기록을 지운다. 쓴 파일 경로를 낸다
export function writeClaim(repo: string, claim: Claim, isQueue: (pid: number) => boolean): string {
  const file = join(claimDir(repo), `${claim.pid}.json`)
  makeParent(file, repo)
  for (const old of readClaims(repo)) {
    if (old.pid !== claim.pid && !isQueue(old.pid)) rmSync(join(claimDir(repo), `${old.pid}.json`), { force: true })
  }
  writeFileSync(file, JSON.stringify(claim))
  return file
}

export function removeClaim(file: string): void {
  rmSync(file, { force: true })
}
