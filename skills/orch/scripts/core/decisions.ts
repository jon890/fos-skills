import { createHash } from 'node:crypto'
import { payload } from './completion.ts'
import { dispatchOf } from './questions.ts'
import type { Message } from './questions.ts'
import type { BoardItem } from './board.ts'

export type Entry = { key: string; question?: { id: unknown; dispatch: string; text: string }; item?: { id: string; text: string } }
export const NOTE_LINE = /^참고\s*:/
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const flatten = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim()

export function isUserDecision(message: Message): boolean {
  return /^결정:\s*\S/.test(String(payload(message).question || message.body || '').trim())
}
export function lines(value: unknown): string[] {
  return (Array.isArray(value) ? value : String(value || '').split('\n')).flatMap((line) => {
    const text = typeof line === 'string' ? line : line?.text
    return (typeof line !== 'string' && line?.done === true) || /^\s*(?:✓|\[[xX]\])/.test(String(text || ''))
      ? [] : flatten(text) && !NOTE_LINE.test(flatten(text)) ? [flatten(text)] : []
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
    // 결정 줄이 있었는데 모두 끝났으면 더 물을 결정이 없다. `참고:` 줄만 있으면 제목으로 묻는다
    const decisionLine = (line: unknown) => {
      const text = flatten(typeof line === 'string' ? line : (line as { text?: unknown } | null)?.text)
      return Boolean(text) && !NOTE_LINE.test(text.replace(/^(?:✓|\[[xX]\])\s*/, ''))
    }
    if (!open.length && raw.some(decisionLine)) continue
    for (const text of open.length ? open : [flatten(item.title) || item.id]) {
      entries.push({ key: `board:${item.id}:${hash([item.title, text])}`, item: { id: item.id, text } })
    }
  }
  return [...new Map(entries.map((entry) => [entry.key, entry])).values()]
}
export const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((key) => b.includes(key))
