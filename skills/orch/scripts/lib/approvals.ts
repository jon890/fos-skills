// 승인 파일의 읽기·쓰기와 외부 조회. Orca 조회는 잠금 밖에서 하고 저장만 잠금 안에서 한다.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock } from '../../../../extensions/work-board/bin/file-lock.ts'
import { applyPress, emptyFile, parseFile, prune, revertPress, signalMatches } from '../core/approvals.ts'
import type { Approval, ApprovalFile, CheckFacts, PressInput } from '../core/approvals.ts'
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
  // inbox 는 최신 메시지부터 돌려준다(core/message-fields.ts 의 실측). 이미 읽은 신호도 소비 없이 읽는다.
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

export type PressRequest = Pick<PressInput, 'id' | 'version' | 'action' | 'note' | 'origin'>
export type PressOutcome = { ok: true; messageId: string } | { ok: false; reason: string }
// 창이 press 를 부르는 제한 시간(register.js 의 PRESS_TIMEOUT_MS)은 WORKER_LOOKUP_MS + 잠금 5초 + 이 값 + 되돌리기보다 길어야 한다
export const SEND_TIMEOUT_MS = 30_000
const REVERT_FAILED = '승인 기록을 되돌리지 못했어요. 코디네이터에게 다시 올려 달라고 하세요'
// 창에서 사람이 누른 버튼을 기록하고 올린 Run 으로 신호를 보낸다. 창 전용 스크립트 bin/approvals.ts 만 부른다.
// 기록을 먼저 쓰고 신호를 보내며, 보내지 못하면 되돌린다. 성공하면 기록을 다시 쓰지 않는다(check 가 nonce 로 메시지를 찾는다).
export async function recordPress(repo: string, request: PressRequest): Promise<PressOutcome> {
  const terminal = process.env.ORCA_TERMINAL_HANDLE || null
  if (terminal) {
    const worker = await selfIsWorker()
    if (worker !== false) return { ok: false, reason: worker ? 'worker 터미널에서는 누를 수 없어요' : 'worker 터미널인지 확인하지 못했어요' }
  }
  const nonce = randomUUID()
  let pressed: Approval
  try {
    const written = updateApprovals(repo, (file, now) => {
      const next = applyPress(file, { ...request, terminal, nonce }, now)
      return { file: 'file' in next ? next.file : file, result: next }
    })
    if ('refusal' in written) return { ok: false, reason: written.refusal }
    pressed = written.entry
  } catch (error) { return { ok: false, reason: `승인 파일을 쓰지 못했어요: ${(error as Error).message}` } }
  const subject = `${request.action === 'approve' ? 'APPROVED' : 'REVISE'} ${pressed.id} ${pressed.version}`
  const body = [subject, pressed.title, pressed.then ? `승인 뒤 할 일: ${pressed.then}` : '', pressed.preview ? `미리보기: ${pressed.preview.path}` : '', pressed.note ?? ''].filter(Boolean).join('\n')
  const payload = JSON.stringify({ source: 'board-approval', action: request.action, id: pressed.id, version: pressed.version, nonce })
  const sent = orcaJson<Record<string, unknown>>(['orchestration', 'send', '--to', `run:${pressed.run}`, '--type', 'status', '--subject', subject, '--body', body, '--payload', payload], { timeoutMs: SEND_TIMEOUT_MS })
  const message = sent.ok ? sent.data?.message : null
  const id = sent.ok ? (isObject(message) ? message.id : undefined) ?? sent.data?.messageId ?? sent.data?.id : null
  if (sent.ok && typeof id === 'string' && id) return { ok: true, messageId: id }
  const why = sent.ok ? '신호 영수증에 메시지 id 가 없어요' : sent.error
  try {
    updateApprovals(repo, file => {
      const back = revertPress(file, pressed.id, pressed.version, nonce)
      return { file: 'file' in back ? back.file : file, result: back }
    })
  } catch { return { ok: false, reason: REVERT_FAILED } }
  return { ok: false, reason: `신호를 보내지 못했어요: ${why.split('\n')[0]}` }
}
