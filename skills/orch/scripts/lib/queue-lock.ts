// 큐 잠금은 PID 와 시작 시각·명령줄을 함께 대조해 PID 재사용을 구분한다.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { reclaim } from './events.ts'
import { alive } from './process.ts'
import { run } from './proc.ts'
import { isQueueCommand } from './queue-process.ts'

function identity(pid: number): string | null {
  if (!alive(pid)) return null
  const read = run([process.env.PS || 'ps', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], { env: { LC_ALL: 'C' } })
  if (read.code !== 0 || !read.stdout.trim()) {
    if (!alive(pid)) return null
    throw new Error(`pid ${pid} 의 시작 시각과 명령줄을 읽지 못했다`)
  }
  return read.stdout.trim()
}

function content(file: string): string | null {
  try { return readFileSync(file, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

function live(file: string, seen: string): boolean {
  if (!seen.trim()) {
    // wx 생성과 내용 쓰기 사이에는 다른 실행이 회수하지 않는다.
    try { return Date.now() - statSync(file).mtimeMs < 1000 }
    catch { return false }
  }
  // 잠금 도입 초기의 PID 만 든 파일도 실제 큐의 명령줄을 확인한다.
  if (/^\d+$/.test(seen.trim())) {
    const actual = identity(Number(seen.trim()))
    return actual !== null && isQueueCommand(actual)
  }
  let saved: { pid?: unknown; identity?: unknown }
  try { saved = JSON.parse(seen) }
  catch { return false }
  if (!saved || !Number.isInteger(saved.pid) || Number(saved.pid) < 1 || typeof saved.identity !== 'string') return false
  return identity(Number(saved.pid)) === saved.identity
}

// 기다리지 않고 한 번 잡는다. 회수 경합에서 내 파일이 바뀌었으면 안전하게 거절한다.
export function acquireQueueLock(file: string): string | null {
  const own = identity(process.pid)
  if (!own) throw new Error('현재 큐의 프로세스 정보를 읽지 못했다')
  const token = JSON.stringify({ pid: process.pid, identity: own, token: randomUUID() })
  for (;;) {
    let fd: number
    try { fd = openSync(file, 'wx') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const seen = content(file)
      if (seen === null) continue
      if (live(file, seen)) return null
      if (reclaim(file, seen) === 'retry') continue
      return null
    }
    try { writeSync(fd, token) }
    finally { closeSync(fd) }
    return token
  }
}

export function ownsQueueLock(file: string, token: string): boolean {
  return token !== '' && content(file) === token
}

export function releaseQueueLock(file: string, token: string): void {
  try { if (ownsQueueLock(file, token)) unlinkSync(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
