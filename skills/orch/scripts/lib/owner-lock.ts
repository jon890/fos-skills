// 쥔 프로세스의 생존으로 판정하는 파일 잠금. 쥔 프로세스가 살아 있으면 오래돼도 넘겨받지 않는다.
// work-board 의 withFileLock 은 수정 시각이 30초를 넘으면 살아 있는 쓰기의 잠금도 넘겨받아, 오래 걸리는 쓰기(보드 명령)가 겹쳤다(PR 558 리뷰).
//
// 내용: `<pid> <무작위 토큰>`. 쥔 pid 가 죽었거나 내용이 깨졌으면 lib/events.ts 의 reclaim 으로 회수한다.
//   빈 내용은 만든 지 1초 안이면 쓰는 중으로 보고 기다린다(wx 생성과 내용 쓰기 사이).
//   회수는 잠금을 고유 이름으로 rename 해 처음 읽은 내용과 대조하므로, 회수하던 프로세스가 도중에 죽어도 남는 표시가 없다. 다음 호출이 다시 회수한다.
// 놓을 때는 내용이 내 토큰일 때만 지운다.
// waitMs 안에 잡지 못하면 OwnerLockBusy 를 던진다. 부르는 쪽은 실패로 끝내고 잠금 없이 넘어가지 않는다.

import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { reclaim } from './events.ts'
import { alive } from './process.ts'

export class OwnerLockBusy extends Error {}

const EMPTY_GRACE_MS = 1000

function content(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

function held(file: string, seen: string): boolean {
  if (seen.trim() === '') {
    try { return Date.now() - statSync(file).mtimeMs < EMPTY_GRACE_MS } catch { return false }
  }
  const found = /^(\d+) \S+$/.exec(seen.trim())
  return found !== null && alive(Number(found[1]))
}

function create(file: string, token: string): boolean {
  let fd: number
  try {
    fd = openSync(file, 'wx')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    if (code === 'ENOENT') {
      mkdirSync(dirname(file), { recursive: true })
      return create(file, token)
    }
    throw e
  }
  try { writeSync(fd, token) } finally { closeSync(fd) }
  return true
}

export function withOwnerLock<T>(file: string, work: () => T, opts: { waitMs?: number; pollMs?: number } = {}): T {
  const { waitMs = 5000, pollMs = 50 } = opts
  const token = `${process.pid} ${randomUUID()}`
  const started = Date.now()
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    if (create(file, token)) break
    const seen = content(file)
    if (seen === null) continue
    if (!held(file, seen) && reclaim(file, seen) === 'retry') continue
    if (Date.now() - started >= waitMs) {
      throw new OwnerLockBusy(`잠금을 ${waitMs / 1000}초 안에 잡지 못했다: ${file} (쥔 쪽: ${seen.trim() || '쓰는 중'})`)
    }
    Atomics.wait(pause, 0, 0, pollMs)
  }
  try {
    return work()
  } finally {
    try {
      if (content(file) === token) unlinkSync(file)
    } catch {
      // 이미 없으면 놓을 것이 없다. 남의 잠금은 지우지 않는다
    }
  }
}
