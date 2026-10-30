// 상주 루프의 사용자 결정 알림. 같은 내용은 답하거나 사라지기 전까지 다시 깨우지 않는다.
// 질문 재전송은 dispatch 와 본문으로 묶고 보드 결정은 남은 줄마다 추적한다.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readBoard } from './board.ts'
import type { BoardItem } from './board.ts'
import { payload } from './completion.ts'
import { fire } from './events.ts'
import { appendEvent, registeredRuns, runKey } from './loop.ts'
import { boardPath, makeParent, pathOf } from './paths.ts'
import { dispatchOf } from './questions.ts'
import type { Message } from './questions.ts'
import { LIVE_DISPATCH, workerRows } from './workers.ts'

type Entry = { key: string; question?: { id: unknown; dispatch: string; text: string }; item?: { id: string; text: string } }
type Seen = { announced: string[]; notified: string[]; coordinator?: string | null }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const flatten = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim()

export function isUserDecision(message: Message): boolean {
  return /^결정:\s*\S/.test(String(payload(message).question || message.body || '').trim())
}

// done 값과 옛 문자열의 완료 표시를 함께 읽는다. 빈 줄만 든 항목도 줄 없는 항목처럼 취급한다.
function lines(value: unknown): string[] {
  return (Array.isArray(value) ? value : String(value || '').split('\n')).flatMap((line) => {
    const text = typeof line === 'string' ? line : line?.text
    return (typeof line !== 'string' && line?.done === true) || /^\s*(?:✓|\[[xX]\])/.test(String(text || ''))
      ? [] : flatten(text) ? [flatten(text)] : []
  })
}

export function decisionEntries(pending: Message[], items: BoardItem[], active: { dispatchId?: unknown; agentTerminalHandle?: unknown }[]): Entry[] {
  const live = new Set(active.map((w) => String(w.dispatchId)))
  const byTerminal = new Map(active.filter((w) => w.agentTerminalHandle).map((w) => [w.agentTerminalHandle, String(w.dispatchId)]))
  const newest = new Map<string, Message>()
  for (const message of pending) {
    const dispatch = dispatchOf(message) || byTerminal.get(message.from_handle)
    if (!dispatch || !live.has(dispatch)) continue
    const previous = newest.get(dispatch)
    if (!previous || String(message.created_at || '') >= String(previous.created_at || '')) newest.set(dispatch, message)
  }
  const entries: Entry[] = []
  for (const [dispatch, message] of newest) {
    const text = String(payload(message).question || message.body || '').trim()
    if (!isUserDecision(message)) continue
    entries.push({ key: `question:${dispatch}:${hash(flatten(text))}`, question: { id: message.id, dispatch, text } })
  }
  for (const item of items.filter((item) => item.status === 'decide')) {
    const open = [...lines(item.details), ...lines(item.next)]
    const raw = [...(Array.isArray(item.details) ? item.details : String(item.details || '').split('\n')),
      ...(Array.isArray(item.next) ? item.next : String(item.next || '').split('\n'))]
    // 줄이 있었는데 모두 끝났으면 더 물을 결정이 없다.
    if (!open.length && raw.some((line) => flatten(typeof line === 'string' ? line : line?.text))) continue
    for (const text of open.length ? open : [flatten(item.title) || item.id]) {
      entries.push({ key: `board:${item.id}:${hash([item.title, text])}`, item: { id: item.id, text } })
    }
  }
  return [...new Map(entries.map((entry) => [entry.key, entry])).values()]
}

// 조회 실패 시 앞 기록을 보존한다. 성공한 전달만 notified 에 적어, 전달 실패는 다음 틱에 다시 시도한다.
export async function notifyDecisions(repo: string, run: string, pending: Message[], includeBoard: boolean): Promise<void> {
  const questions = pending.filter(isUserDecision)
  const workers = questions.length ? workerRows(run) : { ok: true as const, rows: [] }
  if (!workers.ok) throw new Error(workers.error)
  const items = includeBoard && existsSync(boardPath(repo)) ? readBoard(boardPath(repo)) : []
  const entries = decisionEntries(pending, items, workers.rows.filter((w) => LIVE_DISPATCH.has(String(w.dispatchStatus))))
  const file = join(pathOf('state', repo), 'decision-pending', `${runKey(run)}.json`)
  const before: Seen = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { announced: [], notified: [] }
  if (!Array.isArray(before.announced) || !Array.isArray(before.notified)) throw new Error(`결정 알림 기록 형식이 잘못됐다: ${file}`)
  const keys = entries.map((e) => e.key)
  const coordinator = registeredRuns(repo).find((entry) => entry.run === run)?.coordinator_terminal ?? null
  const sameCoordinator = before.coordinator === undefined || before.coordinator === coordinator
  const seen: Seen = {
    announced: sameCoordinator ? keys.filter((key) => before.announced.includes(key)) : [],
    notified: sameCoordinator ? keys.filter((key) => before.notified.includes(key)) : [],
    coordinator,
  }
  const save = () => {
    makeParent(file, repo)
    writeFileSync(`${file}.tmp`, JSON.stringify(seen))
    renameSync(`${file}.tmp`, file)
  }
  if (keys.some((key) => !seen.announced.includes(key))) {
    appendEvent(repo, 'DECISION-PENDING', null, `정할 것 묻기: 질문 ${entries.filter((e) => e.question).length}, 보드 결정 ${entries.filter((e) => e.item).length}`, run)
    seen.announced = keys
    save()
  }
  if (keys.some((key) => !seen.notified.includes(key))) {
    const result = await fire('decision-pending', {
      questions: entries.flatMap((e) => e.question ? [e.question] : []),
      items: entries.flatMap((e) => e.item ? [e.item] : []),
    }, { repo, base: '', run })
    if (result.result !== 'pass') throw new Error(`decision-pending 전달 실패: ${result.reason || result.result}`)
    seen.notified = keys
  }
  save()
}
