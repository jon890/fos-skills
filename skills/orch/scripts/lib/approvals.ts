// 승인 파일의 읽기·쓰기와 외부 조회. Orca 조회는 잠금 밖에서 하고 저장만 잠금 안에서 한다.
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock } from '../../../../extensions/work-board/bin/file-lock.ts'
import { emptyFile, parseFile, prune, signalMatches } from '../core/approvals.ts'
import type { Approval, ApprovalFile, CheckFacts } from '../core/approvals.ts'
import { isObject } from '../core/json.ts'
import { payloadOf, senderOf } from '../core/message-fields.ts'
import { orcaJson } from './orca.ts'
import { pathOf } from './paths.ts'
import { APPROVAL_STATES, lookupWorkerTerminals } from './worker-terminal.ts'

// 2026-11-10 실제 bound Run: 11089, 10019, 9270ms. 최댓값의 3배와 30초 중 큰 값.
export const WORKER_LOOKUP_MS = 33_267
export function approvalsFile(repo: string): string { return join(pathOf('state', repo), 'approvals.json') }
function readAt(file: string): ApprovalFile {
  let source: string
  try { source = readFileSync(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile()
    throw error
  }
  try { return parseFile(source) } catch (error) { throw new Error(`${file}: ${(error as Error).message}`) }
}
export function readApprovals(repo: string): ApprovalFile { return readAt(approvalsFile(repo)) }
function moveAt(file: string, now: Date): string {
  const moved = `${file}.broken-${now.getTime()}`
  renameSync(file, moved)
  return moved
}
export function moveBroken(repo: string, now: Date): string { return moveAt(approvalsFile(repo), now) }
export function updateApprovals<T>(repo: string, change: (file: ApprovalFile, now: Date) => { file: ApprovalFile; result: T }, options: { recoverBroken?: boolean; onBroken?: (path: string) => void } = {}): T {
  const target = approvalsFile(repo)
  return withFileLock(target, lock => {
    const now = new Date()
    let file: ApprovalFile
    try { file = readAt(target) } catch (error) {
      if (!options.recoverBroken) throw error
      // 읽기 권한 오류는 손상으로 취급하지 않는다.
      if ((error as NodeJS.ErrnoException).code) throw error
      const moved = moveAt(target, now)
      options.onBroken?.(moved)
      file = { seq: now.getTime(), entries: [] }
    }
    const next = change(file, now)
    const tmp = `${target}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(prune(next.file, now), null, 2) + '\n')
      if (!lock.held()) throw new Error(`승인 파일 잠금을 잃었다: ${target}`)
      renameSync(tmp, target)
    } finally {
      try { unlinkSync(tmp) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return next.result
  })
}
export function previewSha(file: string): string | null {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex') } catch { return null }
}
export function readSignal(entry: Approval): CheckFacts['message'] {
  // inbox 는 이미 읽은 신호도 돌려주며 check 와 달리 메일함을 소비하지 않는다.
  const result = orcaJson<{ messages?: unknown }>(['orchestration', 'inbox', '--terminal', `run:${entry.run}`, '--limit', '200'])
  if (!result.ok || !Array.isArray(result.data?.messages)) return { found: false }
  const message = result.data.messages.find(m => isObject(m) && signalMatches(payloadOf(m), entry))
  return isObject(message) ? { found: true, sender: senderOf(message) } : { found: false }
}
export async function signalWorkers(handles: string[]): Promise<CheckFacts['workers']> {
  const result = await lookupWorkerTerminals([...new Set(handles.filter(Boolean))], { states: APPROVAL_STATES, deadline: Date.now() + WORKER_LOOKUP_MS })
  return result.ok ? { ok: true, workerHandles: new Set(result.found.keys()) } : { ok: false }
}
export async function selfIsWorker(): Promise<boolean | null> {
  const handle = process.env.ORCA_TERMINAL_HANDLE
  if (!handle) return false
  const result = await signalWorkers([handle])
  return result.ok ? result.workerHandles.has(handle) : null
}
