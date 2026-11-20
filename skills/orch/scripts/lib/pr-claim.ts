// PR 실행권: PR 하나의 머지 큐 실행(queue)과 마무리(finish)를 각각 한 프로세스만 맡게 한다.
// 설계는 docs/features/queue-dedupe/design.md 가 소유한다.
//
// 실행권은 <orch 루트>/state/pr-claims/<종류>-<PR> 디렉터리 하나다. 만들기, 죽은 실행권 회수, 놓기는 lib/owner-lock.ts 의
// rename 규칙을 그대로 쓴다. 그래서 같은 PR 을 동시에 잡으려 해도 한쪽만 잡고, 잡을 때 기다리는 잠금이 없다.
// 쥔 프로세스가 사는 동안 쥐고, 죽으면 다음에 잡는 쪽이 회수한다. 넘겨주는 절차가 없어 넘겨주다 죽은 상태도 없다.
//   owner 파일: {"pid", "identity", "token", "at", "note"}
//     identity  쥔 프로세스의 시작 시각과 명령줄(lib/process.ts 의 identity). pid 가 다른 프로세스에 다시 쓰이면 죽은 것으로 본다
//     token     쥔 쪽을 가리키는 난수. 래퍼(merge-with-finish.ts)가 자식 머지 큐에 넘겨, 자식이 부모의 실행권을 제 것으로 읽는다
//     note      진행 중인 쪽을 알릴 때 붙이는 글(명령과 Run)
// 머지 큐 실행권은 그 PR 을 큐가 맡고 있는 동안만 쥔다. 큐가 보류로 뺀 PR 의 실행권은 그 자리에서 놓는다(queue/steps/select.ts 의 dropClaim).
// 큐가 끝날 때까지 쥐면, 보류가 풀린 PR 을 다시 걸어도 「이미 진행 중」 으로 거절되고 앞 큐는 그 PR 을 다시 보지 않아 아무도 맡지 않는다
// 쥔 쪽이 살아 있는지 읽지 못하면(ps 실패) 회수하지 않고 unknown 을 낸다. 부르는 쪽은 아무것도 시작하지 않고 끝낸다.
// 남은 것: 죽은 실행권과 묘비는 한 시간이 지나면 다음 잡기가 같은 폴더에서 치운다(sweepClaims).

import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LEFTOVER, LEFTOVER_MS, peek, reclaimDead, release, tryTake } from './owner-lock.ts'
import type { Seen } from './owner-lock.ts'
import { makeParent, pathOf } from './paths.ts'
import { alive, identity } from './process.ts'

export type ClaimKind = 'queue' | 'finish'
export type Holder = { pid: number; at: string; note: string }
export type Claim = { file: string; owner: string; token: string }
export type Take =
  | { kind: 'taken'; claim: Claim }
  // 내 token 이나 물려받은 token 의 실행권이 이미 있다. 놓는 것은 처음 잡은 쪽이다
  | { kind: 'mine' }
  | { kind: 'held'; holder: Holder }
  | { kind: 'unknown'; reason: string }

// 난수는 randomUUID 를 쓰지 않는다. 고정 입력 실행기(tests/fixtures/fixed-clock.ts)가 randomUUID 를 차례 번호로 바꿔 두어, 같은 값이 겹친다
export function newToken(): string {
  return randomBytes(16).toString('hex')
}

// 회수 경합에서 다시 보는 횟수. 넘으면 unknown 이다
const TAKE_TRIES = 20

export function claimFile(repo: string, kind: ClaimKind, pr: string | number): string {
  return join(pathOf('state', repo), 'pr-claims', `${kind}-${pr}`)
}

type Owner = { pid: number; identity: string; token: string; at: string; note: string }

function parseOwner(text: string): Owner | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  if (!Number.isInteger(row.pid) || Number(row.pid) < 1 || typeof row.identity !== 'string' || typeof row.token !== 'string') return null
  return { pid: row.pid as number, identity: row.identity, token: row.token, at: typeof row.at === 'string' ? row.at : '', note: typeof row.note === 'string' ? row.note : '' }
}

// 깨진 owner 는 죽은 것이다. 잡기가 내용을 다 쓴 디렉터리를 rename 하므로 반쯤 쓴 owner 는 보이지 않는다
function liveness(owner: Owner | null): 'live' | 'dead' | { unknown: string } {
  if (owner === null || !alive(owner.pid)) return 'dead'
  let now: string | null
  try { now = identity(owner.pid) } catch (e) { return { unknown: (e as Error).message } }
  return now === owner.identity ? 'live' : 'dead'
}

// 기다리지 않고 한 번 잡는다. token 은 이 프로세스가 잡는 실행권에 함께 쓸 값, inherit 는 부모가 넘긴 token 이다
export function takeClaim(file: string, opts: { note?: string; token?: string; inherit?: string } = {}): Take {
  let own: string | null
  try { own = identity(process.pid) } catch (e) { return { kind: 'unknown', reason: (e as Error).message } }
  if (!own) return { kind: 'unknown', reason: '이 프로세스의 시작 시각과 명령줄을 읽지 못했다' }
  const token = opts.token ?? newToken()
  const owner = JSON.stringify({ pid: process.pid, identity: own, token, at: new Date().toISOString(), note: opts.note ?? '' })
  mkdirSync(dirname(file), { recursive: true })
  for (let i = 0; i < TAKE_TRIES; i++) {
    if (tryTake(file, owner, newToken())) {
      sweepClaims(dirname(file))
      return { kind: 'taken', claim: { file, owner, token } }
    }
    const seen = peek(file)
    if (seen === null) continue
    const holder = parseOwner(seen.owner)
    if (holder && (holder.token === token || holder.token === opts.inherit)) return { kind: 'mine' }
    const state = liveness(holder)
    if (state === 'live') return { kind: 'held', holder: { pid: holder!.pid, at: holder!.at, note: holder!.note } }
    if (state !== 'dead') return { kind: 'unknown', reason: state.unknown }
    // 내가 옮기지 못했으면 다른 쪽이 먼저 회수했다. 다시 보면 새 주인이 보인다
    reclaimDead(file, seen)
  }
  return { kind: 'unknown', reason: `실행권을 잡지도 쥔 쪽을 확인하지도 못했다: ${file}` }
}

export function releaseClaim(claim: Claim): void {
  release(claim.file, claim.owner, newToken())
  // 비었으면 폴더도 지운다. 잡는 쪽의 임시 디렉터리가 이 폴더 안에 있어, 잡는 중에는 비지 않는다
  try { rmdirSync(dirname(claim.file)) } catch { /* 다른 실행권이 있다 */ }
}

// token 으로 쥔 실행권을 놓는다. 머지 큐가 보류로 뺀 PR 을 큐가 끝나기 전에 다시 걸 수 있게 하는 데 쓴다.
// 부모(merge-with-finish.ts)가 잡은 실행권도 token 을 물려받은 자식 큐가 놓을 수 있다. 그 뒤 다른 쪽이 잡은 실행권은 owner 가 달라
// 부모가 끝날 때의 releaseClaim 이 건드리지 않는다
export function releaseByToken(file: string, tokens: string[]): void {
  const seen = peek(file)
  const holder = seen ? parseOwner(seen.owner) : null
  if (seen && holder && tokens.includes(holder.token)) release(file, seen.owner, newToken())
}

// 한 시간 넘게 남은 묘비·임시 디렉터리를 지우고, 한 시간 넘은 죽은 실행권을 묘비로 옮긴다. 묘비는 다음 정리가 지운다.
// 죽었는지는 pid 만 본다. pid 가 다시 쓰인 실행권은 그 PR 을 다시 잡을 때 identity 로 회수한다. now 는 테스트가 시각을 앞당길 때 준다
export function sweepClaims(dir: string, now: number = Date.now()): void {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const entry of entries) {
    const path = join(dir, entry)
    try {
      const stat = statSync(path)
      if (now - Math.max(stat.mtimeMs, stat.ctimeMs) <= LEFTOVER_MS) continue
      if (LEFTOVER.test(entry)) {
        rmSync(path, { recursive: true, force: true })
        continue
      }
      const seen: Seen | null = peek(path)
      const pid = seen ? parseOwner(seen.owner)?.pid : undefined
      if (seen && (pid === undefined || !alive(pid))) reclaimDead(path, seen)
    } catch { /* 다른 실행이 치웠다 */ }
  }
}

export type Claimed =
  | { kind: 'ok'; claims: Claim[] }
  | { kind: 'held'; held: { pr: string; holder: Holder }[] }
  | { kind: 'unknown'; reason: string }

// PR 여럿을 모두 잡거나 하나도 잡지 않는다. 일부만 잡고 이어 가면 묶음(--chain)과 순서가 깨진다.
// 번호가 낮은 PR 부터 잡고, 다른 쪽이 쥐었거나 확인하지 못한 첫 PR 에서 멈춰 이번에 잡은 것을 놓는다.
// 순서를 정해 두지 않으면 `1 2` 와 `2 1` 을 동시에 건 두 호출이 하나씩 잡고 서로에게 막혀 둘 다 물러난다.
// 그래서 held 에는 처음 막힌 PR 하나만 든다
export function claimPrs(repo: string, kind: ClaimKind, prs: string[], opts: { note?: string; token?: string; inherit?: string } = {}): Claimed {
  const token = opts.token ?? newToken()
  const claims: Claim[] = []
  const ordered = [...new Set(prs)].sort((a, b) => Number(a) - Number(b))
  // 폴더를 만들고 git 이 orch 루트를 무시하게 한다
  makeParent(claimFile(repo, kind, ordered[0] ?? '0'), repo)
  for (const pr of ordered) {
    const taken = takeClaim(claimFile(repo, kind, pr), { ...opts, token })
    if (taken.kind === 'taken') claims.push(taken.claim)
    if (taken.kind === 'taken' || taken.kind === 'mine') continue
    for (const claim of claims) releaseClaim(claim)
    return taken.kind === 'held' ? { kind: 'held', held: [{ pr, holder: taken.holder }] } : { kind: 'unknown', reason: `#${pr}: ${taken.reason}` }
  }
  return { kind: 'ok', claims }
}

// 머지 큐 실행권을 잡지 못했을 때 낼 줄과 종료 코드. merge-with-finish.ts 와 merge_queue.ts 가 같은 줄을 낸다.
//   QUEUE-DUP <PR> 이미 진행 중이다: pid <pid> <시작 시각> <note>   종료 코드 4. 진행 중인 쪽이 끝낸다. 다시 걸지 않는다
//   QUEUE-CLAIM-FAIL <이유>                                        종료 코드 1. 아무것도 걸지 않았다. 같은 명령을 다시 부른다.
//     쥔 쪽이나 이 프로세스의 시작 시각을 읽지 못했거나(ps 실패), 회수 경합이 TAKE_TRIES 번을 넘었을 때다
export const QUEUE_DUP_CODE = 4

export function refusal(claimed: Exclude<Claimed, { kind: 'ok' }>): { lines: string[]; code: number } {
  if (claimed.kind === 'unknown') {
    return { lines: [`QUEUE-CLAIM-FAIL 다른 머지 큐가 이 PR 을 맡았는지 확인하지 못해 아무것도 걸지 않았다. 다시 부른다: ${claimed.reason}`], code: 1 }
  }
  return {
    lines: claimed.held.map(({ pr, holder }) => `QUEUE-DUP ${pr} 이미 진행 중이다: pid ${holder.pid} ${holder.at} ${holder.note}`.trimEnd()),
    code: QUEUE_DUP_CODE,
  }
}
