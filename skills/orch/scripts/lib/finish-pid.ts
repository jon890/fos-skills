// 마무리(queue/finish-pr.ts --pid-file)의 pid 파일과 다시 돌기 요청. 같은 PR 의 마무리가 둘 돌지 않게 하면서,
// 도는 동안 `orch followup done` 이 오면 끝난 뒤 한 번 더 돌게 한다.
//
// 파일: <pid 파일>(내용은 pid 하나, lib/process.ts 의 pidFileAlive 가 읽는다), <pid 파일>.rerun(다시 돌기 요청), <pid 파일>.lock(lib/owner-lock.ts).
// pid 파일과 요청은 늘 그 잠금 안에서 읽고 쓴다. 따로 다루면 끝나는 마무리가 pid 파일을 지운 사이 새 마무리가 뜨고,
// 끝나는 마무리가 새 마무리의 pid 파일까지 지웠다(PR 558 리뷰).
//   시작(claimPid): 내 pid 를 쓴다
//   요청(startOrQueue, followup done): 도는 마무리가 살아 있으면 요청을 남기고 'queued'. 아니면 그 자리에서 새 마무리를 띄워
//     그 pid 를 pid 파일에 쓰고 'started'. 띄우지 못하면 'failed'
//   끝(nextOrRelease): 요청이 있으면 가져가고 pid 파일을 내 pid 로 둔 채 true(한 번 더 돈다). 없으면 내 pid 가 적힌 pid 파일만 지우고 false
// 잠금을 잡지 못하면 OwnerLockBusy 를 던진다. releaseOwnPid 만 던지지 않는다.

import { readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { withOwnerLock } from './owner-lock.ts'
import { pidFileAlive } from './process.ts'

const WAIT_MS = 30_000

export function rerunFile(pidFile: string): string {
  return `${pidFile}.rerun`
}

function lockOf(pidFile: string): string {
  return `${pidFile}.lock`
}

function mine(pidFile: string): boolean {
  try {
    return readFileSync(pidFile, 'utf8').trim() === String(process.pid)
  } catch {
    return false
  }
}

function dropOwn(pidFile: string): void {
  if (!mine(pidFile)) return
  try { unlinkSync(pidFile) } catch { /* 이미 없다 */ }
}

export function claimPid(pidFile: string): void {
  withOwnerLock(lockOf(pidFile), () => writeFileSync(pidFile, String(process.pid)), { waitMs: WAIT_MS })
}

export function startOrQueue(pidFile: string, start: () => number | null): 'queued' | 'started' | 'failed' {
  return withOwnerLock(lockOf(pidFile), () => {
    if (pidFileAlive(pidFile)) {
      writeFileSync(rerunFile(pidFile), '')
      return 'queued'
    }
    const pid = start()
    if (pid === null) return 'failed'
    writeFileSync(pidFile, String(pid))
    return 'started'
  }, { waitMs: WAIT_MS })
}

export function nextOrRelease(pidFile: string): boolean {
  return withOwnerLock(lockOf(pidFile), () => {
    try {
      rmSync(rerunFile(pidFile))
    } catch {
      dropOwn(pidFile)
      return false
    }
    writeFileSync(pidFile, String(process.pid))
    return true
  }, { waitMs: WAIT_MS })
}

// 내 pid 가 적힌 pid 파일만 지운다. 잠금을 잡지 못해도 내 것인지는 보고 지운다
export function releaseOwnPid(pidFile: string): void {
  try {
    withOwnerLock(lockOf(pidFile), () => dropOwn(pidFile), { waitMs: WAIT_MS })
  } catch {
    dropOwn(pidFile)
  }
}
