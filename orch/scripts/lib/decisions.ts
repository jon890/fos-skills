// 상주 루프의 사용자 결정 알림. 같은 내용은 답하거나 사라지기 전까지 다시 깨우지 않는다.
// 질문 재전송은 dispatch 와 본문으로 묶고 보드 결정은 남은 줄마다 추적한다.
// 보드 decide 항목의 `참고:` 로 시작하는 줄은 결정이 아니라 배경이라 세지 않는다.
//
// 전달 미루기: 코디네이터가 사용자와 대화 중이면(lib/user-active.ts 의 「대화 중」) decision-pending 을 내지 않는다.
//     알리지 않은 결정은 그대로 남아 대화가 끝난 뒤의 틱이 낸다. DECISION-PENDING 알림 파일 줄은 미루지 않는다.
// 전달 실패: 핸들러가 실패하면 같은 결정 묶음은 ORCH_DECISION_RETRY_SEC(기본 600초)부터 두 배씩, 한 시간까지 기다린 뒤 다시 낸다.
//     그동안은 앞 실패와 같은 이유로 던져 루프가 같은 WATCH-ERROR 를 다시 쓰지 않는다. 묶음이 바뀌거나(새 결정, 답한 결정)
//     코디네이터가 바뀌면 기다리지 않는다. 틱마다 다시 내던 때는 미룬 결정으로 「정할 것 묻기」 가 몇 분마다 왔다(2026-11-04).
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
import { userActive } from './user-active.ts'
import { LIVE_DISPATCH, workerRows } from './workers.ts'

type Entry = { key: string; question?: { id: unknown; dispatch: string; text: string }; item?: { id: string; text: string } }
type Retry = { keys: string[]; failures: number; at: number; reason: string }
type Seen = { announced: string[]; notified: string[]; coordinator?: string | null; retry?: Retry | null }
const NOTE_LINE = /^참고\s*:/
const RETRY_MAX_SEC = 3600
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

function retryMs(failures: number): number {
  const raw = Number(process.env.ORCH_DECISION_RETRY_SEC)
  const base = Number.isFinite(raw) && raw >= 0 ? raw : 600
  return Math.min(base * 2 ** (failures - 1), RETRY_MAX_SEC) * 1000
}

const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((key) => b.includes(key))

// 조회 실패 시 앞 기록을 보존한다. 성공한 전달만 notified 에 적는다. 미루기와 실패 뒤 기다리기는 머리 주석을 따른다.
export async function notifyDecisions(repo: string, run: string, pending: Message[], includeBoard: boolean, now = Date.now()): Promise<void> {
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
    retry: null,
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
  const due = keys.filter((key) => !seen.notified.includes(key))
  if (due.length) {
    const retry = sameCoordinator && before.retry && Array.isArray(before.retry.keys) && sameKeys(before.retry.keys, due) ? before.retry : null
    if (retry && now < retry.at) {
      seen.retry = retry
      save()
      throw new Error(retry.reason)
    }
    if (userActive(coordinator, now).active) {
      seen.retry = retry
      save()
      return
    }
    const result = await fire('decision-pending', {
      questions: entries.flatMap((e) => e.question ? [e.question] : []),
      items: entries.flatMap((e) => e.item ? [e.item] : []),
    }, { repo, base: '', run })
    if (result.result !== 'pass') {
      const failures = (retry?.failures ?? 0) + 1
      const reason = `decision-pending 전달 실패: ${result.reason || result.result}`
      seen.retry = { keys: due, failures, at: now + retryMs(failures), reason }
      save()
      throw new Error(reason)
    }
    seen.notified = keys
  }
  save()
}
