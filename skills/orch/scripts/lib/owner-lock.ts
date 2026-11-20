// 쥔 프로세스의 생존으로 판정하는 잠금. 쥔 프로세스가 살아 있으면 오래돼도 넘겨받지 않는다.
// work-board 의 withFileLock 은 수정 시각이 30초를 넘으면 살아 있는 쓰기의 잠금도 넘겨받아, 오래 걸리는 쓰기(보드 명령)가 겹쳤다(PR 558 리뷰).
//
// 잠금은 디렉터리 하나다. 안의 owner 파일에 `<pid> <무작위 토큰>` 을 둔다. 잠금의 모든 바뀜은 디렉터리 rename 하나로만 한다.
//   잡기: owner 를 쓴 임시 디렉터리(<잠금>.new-<토큰>)를 잠금 이름으로 rename 한다. 잠금이 있으면 비어 있지 않아 rename 이 실패한다.
//     그래서 내용이 빈 잠금이 보이는 순간이 없다
//   회수: owner 의 pid 가 죽었거나 owner 가 깨졌으면 잠금을 그 잠금만의 묘비 이름(<잠금>.dead-<owner 와 inode 의 해시>)으로 rename 한다.
//     같은 죽은 잠금을 둘이 함께 읽어도 먼저 옮긴 쪽만 성공한다. 늦은 쪽은 묘비가 이미 있어(비어 있지 않은 디렉터리) rename 이 실패하므로,
//     그 사이 새 주인이 잡은 잠금을 옮기지 않는다. 잠금 경로가 비는 것은 죽은 잠금을 옮긴 직후뿐이다(PR 558 리뷰의 회수 경합)
//   놓기: owner 가 내 토큰일 때 잠금을 <잠금>.released-<토큰> 으로 rename 한 뒤 지운다
// 묘비와 남은 임시 디렉터리는 한 시간이 지나면 다음 잡기가 지운다. 묘비는 회수한 시각부터 센다. 회수가 그보다 오래 멈추면 막지 못한다.
// waitMs 안에 잡지 못하면 OwnerLockBusy 를 던진다. 부르는 쪽은 실패로 끝내고 잠금 없이 넘어가지 않는다.

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { alive } from './process.ts'

export class OwnerLockBusy extends Error {}

const LEFTOVER_MS = 60 * 60 * 1000

export type Seen = { owner: string; key: string }

// 지금 잠금의 owner 와 묘비 이름에 쓸 key. 잠금이 없으면 null
export function peek(lock: string): Seen | null {
  let ino: number
  try {
    ino = statSync(lock).ino
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  let owner = ''
  try { owner = readFileSync(join(lock, 'owner'), 'utf8') } catch { /* 깨진 잠금 */ }
  return { owner, key: createHash('sha1').update(`${owner}\0${ino}`).digest('hex').slice(0, 16) }
}

function held(seen: Seen): boolean {
  const found = /^(\d+) \S+$/.exec(seen.owner.trim())
  return found !== null && alive(Number(found[1]))
}

// 머리 주석의 「회수」. 본 죽은 잠금을 내가 옮겼으면 true
export function reclaimDead(lock: string, seen: Seen): boolean {
  const tomb = `${lock}.dead-${seen.key}`
  try {
    renameSync(lock, tomb)
  } catch {
    return false
  }
  // 묘비는 옮긴 시각부터 센다. 수정 시각을 그대로 두면 오래 남은 죽은 잠금의 묘비를 회수 직후 sweepLeftovers 가 지웠다(PR 558 리뷰)
  const now = new Date()
  try { utimesSync(tomb, now, now) } catch { /* 이미 지웠다. 아래 sweepLeftovers 는 ctime 도 본다 */ }
  return true
}

function tryTake(lock: string, token: string): boolean {
  const fresh = `${lock}.new-${randomUUID()}`
  mkdirSync(fresh, { recursive: true })
  writeFileSync(join(fresh, 'owner'), token)
  try {
    renameSync(fresh, lock)
    return true
  } catch (e) {
    rmSync(fresh, { recursive: true, force: true })
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EISDIR' || code === 'ENOTDIR') return false
    throw e
  }
}

function sweepLeftovers(lock: string): void {
  const dir = dirname(lock)
  const name = basename(lock)
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const entry of entries) {
    if (!/^\.(dead|new|released)-/.test(entry.slice(name.length)) || !entry.startsWith(name)) continue
    const path = join(dir, entry)
    try {
      // rename 은 ctime 을 새로 적는다. 수정 시각과 둘 중 늦은 쪽부터 센다
      const stat = statSync(path)
      if (Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs) > LEFTOVER_MS) rmSync(path, { recursive: true, force: true })
    } catch { /* 다른 실행이 지웠다 */ }
  }
}

export function withOwnerLock<T>(lock: string, work: () => T, opts: { waitMs?: number; pollMs?: number } = {}): T {
  const { waitMs = 5000, pollMs = 50 } = opts
  const token = `${process.pid} ${randomUUID()}`
  const started = Date.now()
  const pause = new Int32Array(new SharedArrayBuffer(4))
  mkdirSync(dirname(lock), { recursive: true })
  for (;;) {
    if (tryTake(lock, token)) break
    const seen = peek(lock)
    if (seen === null) continue
    if (!held(seen) && reclaimDead(lock, seen)) continue
    if (Date.now() - started >= waitMs) {
      throw new OwnerLockBusy(`잠금을 ${waitMs / 1000}초 안에 잡지 못했다: ${lock} (쥔 쪽: ${seen.owner.trim() || '알 수 없음'})`)
    }
    Atomics.wait(pause, 0, 0, pollMs)
  }
  sweepLeftovers(lock)
  try {
    return work()
  } finally {
    if (peek(lock)?.owner === token) {
      const gone = `${lock}.released-${token.split(' ')[1]}`
      try {
        renameSync(lock, gone)
        rmSync(gone, { recursive: true, force: true })
      } catch { /* 이미 없다 */ }
    }
  }
}
