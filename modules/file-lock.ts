// 대상 파일 옆 <target>.lock 을 wx 로 만들고 pid-무작위 표지를 쓴다.
// 기본 5초 동안 50ms 마다 기다리며, 수정 시각이 30초 넘은 잠금은 넘겨받는다.
// 프로세스 생존 여부는 보지 않는다. 내용과 수정 시각의 해시로 낡은 잠금의 key 를 만든다.
// <lock>.claim.<key> 를 wx 로 만든 하나만 다시 key 를 확인하고 임시 파일을 rename 해 덮는다.
// 남은 권리 파일은 저절로 풀지 않는다. 놓을 때 자기 표지가 남아 있을 때만 권리 파일, 잠금 순으로 지운다.
// 잠금이 필요한 이유와 감당하는 한계: docs/adr/029-board-write-lock.md.
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class LockTimeout extends Error {}
export type LockOptions = { waitMs?: number; staleMs?: number; pollMs?: number }
export type Lock = { file: string; held(): boolean }
export type Seen = { key: string; stale: boolean; text: string; mtimeMs: number }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

export function peekLock(lock: string, staleMs: number): Seen | null {
  try {
    const text = readFileSync(lock, 'utf8')
    const { mtimeMs } = statSync(lock)
    const key = createHash('sha1').update(`${text}\0${mtimeMs}`).digest('hex').slice(0, 12)
    return { key, stale: Date.now() - mtimeMs > staleMs, text, mtimeMs }
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
}

export function claimFile(lock: string, key: string): string {
  return `${lock}.claim.${key}`
}

function exclusive(file: string, token: string): void {
  const fd = openSync(file, 'wx')
  try { writeFileSync(fd, token) } finally { closeSync(fd) }
}

export function claimStale(lock: string, seen: Seen, token: string): boolean {
  try {
    exclusive(claimFile(lock, seen.key), token)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

export function replaceStale(lock: string, seen: Seen, token: string): boolean {
  if (peekLock(lock, 0)?.key !== seen.key) {
    unlinkSync(claimFile(lock, seen.key))
    return false
  }
  const tmp = `${lock}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, token)
    renameSync(tmp, lock)
    return true
  } finally {
    try { unlinkSync(tmp) } catch (error) { if (!missing(error)) throw error }
  }
}

export function withFileLock<T>(target: string, work: (lock: Lock) => T, opts: LockOptions = {}): T {
  const { waitMs = 5000, staleMs = 30000, pollMs = 50 } = opts
  const file = `${target}.lock`
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`
  const started = Date.now()
  const sleep = new Int32Array(new SharedArrayBuffer(4))
  let claim: string | undefined
  for (;;) {
    try {
      exclusive(file, token)
      break
    } catch (error) {
      if (missing(error)) { mkdirSync(dirname(file), { recursive: true }); continue }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const seen = peekLock(file, staleMs)
    if (!seen) continue
    if (seen.stale && claimStale(file, seen, token) && replaceStale(file, seen, token)) {
      claim = claimFile(file, seen.key)
      break
    }
    if (Date.now() - started >= waitMs) {
      let message = `파일 잠금을 ${waitMs / 1000}초 안에 잡지 못했다: ${file}`
      const pending = claimFile(file, seen.key)
      try {
        if (seen.stale && Date.now() - statSync(pending).mtimeMs > staleMs) {
          message += `\n넘겨받기가 끝나지 않은 채 남아 있다. 다른 쓰기가 돌고 있지 않으면 ${file} 과 ${pending} 을 지운다`
        }
      } catch (error) { if (!missing(error)) throw error }
      throw new LockTimeout(message)
    }
    Atomics.wait(sleep, 0, 0, Math.min(pollMs, Math.max(0, waitMs - (Date.now() - started))))
  }
  const lock: Lock = { file, held() {
    try { return readFileSync(file, 'utf8') === token } catch { return false }
  } }
  try { return work(lock) } finally {
    if (lock.held()) {
      if (claim) unlinkSync(claim)
      unlinkSync(file)
    }
  }
}
