// 승인 대기의 add <id> --kind --title --run [--preview ...], list [--full], cancel <id> [--reason], check <id> [--version].
// 짧은 출력: APPROVAL-ADD <id> <kind> <version> [replaced|kept], APPROVAL, APPROVAL-CANCEL, APPROVAL-OK, APPROVAL-REJECT.
// 종료 코드: 0 반영·통과, 1 거절·조회/저장 실패, 2 사용법 오류. 승인·고쳐 달라를 쓰는 명령은 없다.
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { applyAdd, applyCancel, applyUsed, checkVerdict, formatLine, latest, stateReason, validateAdd } from '../core/approvals.ts'
import type { AddInput, ApprovalKind, CheckFacts, CheckReason } from '../core/approvals.ts'
import { expandArgs } from '../lib/args.ts'
import { previewSha, readApprovals, readSignal, selfIsWorker, signalWorkers, updateApprovals } from '../lib/approvals.ts'
import { fullAsked } from '../lib/output.ts'
const OPTIONS = {
  repo: { type: 'string' }, run: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string' }, preview: { type: 'string' },
  item: { type: 'string' }, step: { type: 'string' }, then: { type: 'string' }, target: { type: 'string' }, change: { type: 'string' }, rollback: { type: 'string' },
  command: { type: 'string' }, reason: { type: 'string' }, version: { type: 'string' }, 'keep-open': { type: 'boolean' }, full: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} as const
const USAGE = '사용법: board-approval.ts add|list|cancel|check [id] [--kind 종류 --title 제목 --preview 파일 --run Run]'
const out = (line: string) => process.stdout.write(line + '\n')
const err = (line: string) => process.stderr.write(line + '\n')
const reject = (id: string, reason: CheckReason) => { out(`APPROVAL-REJECT ${id} ${reason}`); return 1 }
async function coordinatorAllowed(): Promise<boolean> {
  const worker = await selfIsWorker()
  if (worker === false) return true
  err(worker === true ? 'worker 터미널에서는 승인 대기를 올리거나 거두지 않는다' : 'worker 터미널인지 판정하지 못했다. 잠시 뒤 다시 부른다')
  return false
}
async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
  try { parsed = parseArgs({ args: expandArgs(process.argv.slice(2), OPTIONS), options: OPTIONS, allowPositionals: true }) } catch (error) { err((error as Error).message); return 2 }
  const { values: v, positionals } = parsed
  if (v.help) { out(USAGE); return 0 }
  const [action, id] = positionals
  if (!['add', 'list', 'cancel', 'check'].includes(action) || (action === 'list' ? positionals.length !== 1 : positionals.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))) { err(USAGE); return 2 }
  for (const key of ['step', 'version'] as const) if (v[key] !== undefined && (!/^\d+$/.test(v[key]!) || !Number.isSafeInteger(Number(v[key])) || Number(v[key]) < 1)) { err(`--${key} 은 양의 정수다`); return 2 }
  const repo = resolve(v.repo ?? process.cwd())
  if (action === 'add') {
    const preview = v.preview ? resolve(v.preview) : null
    const input: AddInput = { id, title: v.title ?? '', kind: (v.kind ?? '') as ApprovalKind, run: v.run ?? '', terminal: process.env.ORCA_TERMINAL_HANDLE || null,
      preview: preview ? { path: preview, sha256: '' } : null, item: v.item ?? null, step: v.step ? Number(v.step) : null, then: v.then ?? null,
      real: v.kind === 'real' ? { target: v.target ?? '', change: v.change ?? '', rollback: v.rollback ?? '' } : null, command: v.command ?? null, keepOpen: v['keep-open'] }
    const valid = validateAdd(input)
    if (!valid.ok) { err('missing' in valid ? `필수 인자가 빠졌다: ${valid.missing.map(name => `--${name}`).join(', ')}` : valid.error); return 2 }
    if (!input.run.trim()) { err('지금 Run 을 찾지 못했다'); return 1 }
    if (input.kind === 'command' && !input.terminal) { err('command 종류는 Orca 터미널에서 올린다'); return 1 }
    if (input.kind === 'command') input.preview = null
    if (input.preview) {
      const hash = previewSha(input.preview.path)
      if (!hash) { err(`미리보기 파일을 읽지 못했다: ${input.preview.path}`); return 1 }
      input.preview.sha256 = hash
    }
    if (!await coordinatorAllowed()) return 1
    const added = updateApprovals(repo, (file, now) => { const result = applyAdd(file, input, now); return { file: result.file, result } }, { recoverBroken: true, onBroken: path => err(`깨진 승인 파일을 옮겼다: ${path}`) })
    out(`APPROVAL-ADD ${id} ${added.entry.kind} ${added.entry.version}${added.kept ? ' kept' : added.replaced ? ' replaced' : ''}`)
    return 0
  }
  if (action === 'list') {
    const file = readApprovals(repo)
    for (const entry of file.entries.filter(e => v.full || fullAsked() || e.state === 'open').sort((a, b) => a.version - b.version)) out(formatLine(entry, new Date(), !!v.full || fullAsked()))
    return 0
  }
  if (action === 'cancel') {
    if (!await coordinatorAllowed()) return 1
    const result = updateApprovals(repo, (file, now) => { const next = applyCancel(file, id, v.reason ?? null, now); return { file: 'file' in next ? next.file : file, result: next } })
    if ('error' in result) { err(result.error); return 1 }
    out(`APPROVAL-CANCEL ${id}`); return 0
  }
  const entry = latest(readApprovals(repo), id)
  const reason = stateReason(entry)
  if (reason || !entry) return reject(id, reason ?? '기록 없음')
  const facts: CheckFacts = { askedVersion: v.version ? Number(v.version) : null, previewSha: entry.preview ? previewSha(entry.preview.path) : null, message: { found: false }, workers: { ok: false } }
  if (entry.preview && facts.previewSha !== entry.preview.sha256) return reject(id, '미리보기가 바뀜')
  if (facts.askedVersion !== null && facts.askedVersion !== entry.version) return reject(id, '버전이 다름')
  facts.message = readSignal(entry)
  const caller = process.env.ORCA_TERMINAL_HANDLE ?? ''
  if (facts.message.found) facts.workers = await signalWorkers([facts.message.sender, entry.press?.terminal ?? '', entry.terminal ?? '', caller])
  if (caller && facts.workers.ok && facts.workers.workerHandles.has(caller)) return reject(id, 'worker 가 보냄')
  const verdict = checkVerdict(entry, facts)
  if (!verdict.ok) return reject(id, verdict.reason)
  const result = updateApprovals(repo, (file, now) => { const next = applyUsed(file, id, entry.version, entry.press!.nonce, now); return { file: 'file' in next ? next.file : file, result: next } })
  if ('reason' in result) return reject(id, result.reason)
  out(`APPROVAL-OK ${id}`); return 0
}
try { process.exitCode = await main() } catch (error) { err((error as Error).message); process.exitCode = 1 }
