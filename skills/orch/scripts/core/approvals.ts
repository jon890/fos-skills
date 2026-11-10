// 승인 대기의 저장 꼴과 상태 규칙. 시각과 외부 조회 결과는 호출자가 넘긴다.
import { isObject } from './json.ts'

export type ApprovalKind = 'post' | 'spec' | 'step' | 'real' | 'command'
export type ApprovalState = 'open' | 'approved' | 'used' | 'revise' | 'cancelled' | 'replaced'
export type Press = { action: 'approve' | 'revise'; terminal: string | null; origin: string; at: string; nonce: string }
export type Approval = {
  id: string; version: number; kind: ApprovalKind; title: string; state: ApprovalState; run: string; terminal: string | null
  preview: { path: string; sha256: string } | null; item: string | null; step: number | null; then: string | null
  real: { target: string; change: string; rollback: string } | null; command: string | null
  createdAt: string; closedAt: string | null; press: Press | null; note: string | null; reason: string | null
}
export type ApprovalFile = { seq: number; entries: Approval[] }
export type AddInput = Omit<Approval, 'version' | 'state' | 'createdAt' | 'closedAt' | 'press' | 'note' | 'reason'> & { keepOpen?: boolean }
export const KEEP_DAYS = 7
const KINDS = ['post', 'spec', 'step', 'real', 'command']
const STATES = ['open', 'approved', 'used', 'revise', 'cancelled', 'replaced']
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const nullableText = (v: unknown) => v === null || typeof v === 'string'
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v))
const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0
export function emptyFile(): ApprovalFile { return { seq: 0, entries: [] } }

function isApproval(v: unknown): v is Approval {
  if (!isObject(v)) return false
  return text(v.id) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.id) && positive(v.version) &&
    KINDS.includes(String(v.kind)) && STATES.includes(String(v.state)) && text(v.title) && text(v.run) &&
    ['terminal', 'item', 'then', 'command', 'note', 'reason'].every(k => nullableText(v[k])) &&
    (v.step === null || positive(v.step)) && date(v.createdAt) && (v.closedAt === null || date(v.closedAt)) &&
    (v.preview === null || (isObject(v.preview) && text(v.preview.path) && text(v.preview.sha256))) &&
    (v.real === null || (isObject(v.real) && ['target', 'change', 'rollback'].every(k => text((v.real as Record<string, unknown>)[k])))) &&
    (v.press === null || (isObject(v.press) && ['approve', 'revise'].includes(String(v.press.action)) &&
      nullableText(v.press.terminal) && text(v.press.origin) && date(v.press.at) && text(v.press.nonce)))
}

export function parseFile(source: string): ApprovalFile {
  if (!source.trim()) return emptyFile()
  const v: unknown = JSON.parse(source)
  if (!isObject(v) || !Number.isSafeInteger(v.seq) || Number(v.seq) < 0 || !Array.isArray(v.entries) ||
    !v.entries.every(isApproval)) throw new Error('승인 파일 꼴이 틀리다')
  const versions = new Set<number>()
  const opens = new Set<string>()
  for (const entry of v.entries) {
    if (entry.version > Number(v.seq) || versions.has(entry.version) || (entry.state === 'open' && opens.has(entry.id))) throw new Error('승인 파일 버전이나 열린 대기가 겹친다')
    versions.add(entry.version)
    if (entry.state === 'open') opens.add(entry.id)
  }
  return v as ApprovalFile
}

export function validateAdd(input: AddInput): { ok: true } | { ok: false; missing: string[] } | { ok: false; error: string } {
  if (!KINDS.includes(input.kind)) return { ok: false, error: '모르는 승인 종류다' }
  const missing: string[] = []
  for (const name of ['title', 'kind'] as const) if (!text(input[name])) missing.push(name)
  if (input.kind !== 'command' && !input.preview) missing.push('preview')
  if (input.kind === 'command' && !text(input.command)) missing.push('command')
  if (input.kind === 'step') {
    if (!text(input.item)) missing.push('item')
    if (!positive(input.step)) missing.push('step')
  }
  if (input.kind === 'real') for (const name of ['target', 'change', 'rollback'] as const) if (!text(input.real?.[name])) missing.push(name)
  return missing.length ? { ok: false, missing } : { ok: true }
}

export function latest(file: ApprovalFile, id: string): Approval | null {
  return file.entries.filter(e => e.id === id).reduce<Approval | null>((best, e) => !best || e.version > best.version ? e : best, null)
}
export function applyAdd(file: ApprovalFile, input: AddInput, now: Date): { file: ApprovalFile; entry: Approval; replaced: boolean; kept: boolean } {
  const open = file.entries.find(e => e.id === input.id && e.state === 'open')
  if (open && input.keepOpen) return { file, entry: open, replaced: false, kept: true }
  if (!Number.isSafeInteger(file.seq + 1)) throw new Error('승인 버전 번호의 한도를 넘었다')
  const { keepOpen: _, ...fields } = input
  const entry: Approval = { ...fields, version: file.seq + 1, state: 'open', createdAt: now.toISOString(), closedAt: null, press: null, note: null, reason: null }
  return { file: { seq: entry.version, entries: [...file.entries.map(e => e === open ? { ...e, state: 'replaced' as const, closedAt: now.toISOString() } : e), entry] }, entry, replaced: !!open, kept: false }
}
export function applyCancel(file: ApprovalFile, id: string, reason: string | null, now: Date): { file: ApprovalFile } | { error: '열린 대기가 없다' } {
  const open = file.entries.find(e => e.id === id && e.state === 'open')
  if (!open) return { error: '열린 대기가 없다' }
  return { file: { ...file, entries: file.entries.map(e => e === open ? { ...e, state: 'cancelled', closedAt: now.toISOString(), reason } : e) } }
}
export function prune(file: ApprovalFile, now: Date): ApprovalFile {
  return { ...file, entries: file.entries.filter(e => !e.closedAt || now.getTime() - Date.parse(e.closedAt) <= KEEP_DAYS * 86400000) }
}
export type CheckFacts = {
  askedVersion: number | null; previewSha: string | null
  message: { found: false } | { found: true; sender: string }
  workers: { ok: false } | { ok: true; workerHandles: Set<string> }
}
export type CheckReason = '기록 없음' | '아직 누르지 않음' | '이미 사용함' | '고쳐 달라' | '취소됨' | '미리보기가 바뀜' | '버전이 다름' | 'worker 가 보냄' | '신호를 읽지 못함'
export function stateReason(entry: Approval | null): CheckReason | null {
  if (!entry) return '기록 없음'
  return ({ open: '아직 누르지 않음', approved: null, used: '이미 사용함', revise: '고쳐 달라', cancelled: '취소됨', replaced: '아직 누르지 않음' } as const)[entry.state]
}
export function checkVerdict(entry: Approval | null, facts: CheckFacts): { ok: true } | { ok: false; reason: CheckReason } {
  const reason = stateReason(entry)
  if (reason || !entry) return { ok: false, reason: reason ?? '기록 없음' }
  if (entry.preview && (!facts.previewSha || facts.previewSha !== entry.preview.sha256)) return { ok: false, reason: '미리보기가 바뀜' }
  if (facts.askedVersion !== null && facts.askedVersion !== entry.version) return { ok: false, reason: '버전이 다름' }
  if (!entry.press || !facts.message.found || !facts.workers.ok) return { ok: false, reason: '신호를 읽지 못함' }
  if ([facts.message.sender, entry.press.terminal, entry.terminal].some(h => !!h && facts.workers.ok && facts.workers.workerHandles.has(h))) return { ok: false, reason: 'worker 가 보냄' }
  return { ok: true }
}
export function applyUsed(file: ApprovalFile, id: string, version: number, nonce: string, now: Date): { file: ApprovalFile } | { reason: CheckReason } {
  const entry = latest(file, id)
  const reason = stateReason(entry)
  if (!entry || entry.version !== version || reason) return { reason: reason ?? '버전이 다름' }
  if (!entry.press || entry.press.nonce !== nonce) return { reason: '신호를 읽지 못함' }
  return { file: { ...file, entries: file.entries.map(e => e === entry ? { ...e, state: 'used', closedAt: now.toISOString() } : e) } }
}
export function signalMatches(payload: Record<string, unknown>, entry: Approval): boolean {
  return !!entry.press && payload.source === 'board-approval' && payload.action === 'approve' && payload.id === entry.id && payload.version === entry.version && payload.nonce === entry.press.nonce
}
export function waitedText(createdAt: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(createdAt)) / 60000))
  return minutes >= 1440 ? `${Math.floor(minutes / 1440)}일` : minutes >= 60 ? `${Math.floor(minutes / 60)}시간` : `${minutes}분`
}
export function formatLine(entry: Approval, now: Date, full: boolean): string {
  const detail = entry.state === 'open' ? waitedText(entry.createdAt, now) : full ? `${entry.state} v${entry.version}` : ''
  return `APPROVAL ${entry.id} ${entry.kind} ${detail} ${entry.title.replace(/[\r\n]+/g, ' ')}`
}
