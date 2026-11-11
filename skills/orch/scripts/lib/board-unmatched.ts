// 못 맞춘 머지 기록. 모든 읽기·갱신은 파일 옆 잠금으로 보호한다.
// 기록 실패는 머지 마무리를 실패로 바꾸지 않는다. 성공한 전송만 notified 에 남긴다.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LockTimeout, withFileLock } from '../../../../extensions/work-board/bin/file-lock.ts'
import { unmatchedMerge, unmatchedResolved as resolved } from '../core/board.ts'
import { parseEventTag } from '../../../../extensions/work-board/hooks/event-tags.js'
import type { BoardStep } from '../core/board.ts'
import { makeParent, pathOf } from './paths.ts'
import { notifyRun } from './run-notice.ts'

export type Entry = { at: string; notified: string | null }
type Store = { items: Record<string, Record<string, Entry>> }
const eventReferences = (steps: BoardStep[]) => steps.flatMap((step) => {
  const tag = parseEventTag(step.text)
  return tag ? [{ pr: tag.pr, done: step.done }] : []
})
export function unmatchedResolved(steps: BoardStep[], pr: string): boolean { return resolved(steps, pr, eventReferences(steps)) }
export const unmatchedLine = (id: string, pr: string): string => `BOARD-UNMATCHED ${id} PR #${pr}`
const fileOf = (repo: string) => join(pathOf('state', repo), 'board-unmatched.json')

function access<T>(repo: string, write: boolean, work: (data: Store) => T): T | undefined {
  try {
    const file = fileOf(repo)
    if (!write && !existsSync(file)) return undefined
    makeParent(file, repo)
    return withFileLock(file, () => {
      const data: Store = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { items: {} }
      if (!data.items || typeof data.items !== 'object' || Array.isArray(data.items)) throw new Error('items 가 객체가 아니다')
      const result = work(data)
      if (write) {
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(data))
        renameSync(tmp, file)
      }
      return result
    })
  } catch (e) {
    console.error(`board-unmatched: 기록을 읽거나 쓰지 못했다: ${(e as Error).message.replace(/\s+/g, ' ')}`)
    return undefined
  }
}

export function unmatchedRecords(repo: string): Store['items'] {
  return access(repo, false, (data) => data.items) ?? {}
}

// 보드 쓰기가 성공한 뒤에만 호출한다. 기존 notified 는 덮지 않는다.
export function recordUnmatched(repo: string, item: Record<string, unknown>, steps: BoardStep[], pr: string): string | null {
  if (!unmatchedMerge(item, steps, pr, eventReferences(steps))) return null
  const saved = access(repo, true, (data) => {
    const id = String(item.id)
    if (!Object.hasOwn(data.items, id)) Object.defineProperty(data.items, id, { value: Object.create(null), enumerable: true, configurable: true })
    const records = data.items[id]
    records[pr] ??= { at: new Date().toISOString(), notified: null }
    return true
  })
  return saved ? unmatchedLine(String(item.id), pr) : null
}

// 목록은 잠금 밖에서 얻는다. 조회 실패한 항목(undefined)은 기록을 보존하고 없는 항목(null)은 지운다.
export function pruneUnmatched(repo: string, rows: Map<string, BoardStep[] | null | undefined>): void {
  if (!existsSync(fileOf(repo))) return
  access(repo, true, (data) => {
    for (const [id, records] of Object.entries(data.items)) {
      if (!rows.has(id)) continue
      const steps = rows.get(id)
      if (steps === undefined) continue
      for (const pr of Object.keys(records)) if (steps === null || unmatchedResolved(steps, pr)) delete records[pr]
      if (Object.keys(records).length === 0) delete data.items[id]
    }
  })
}

// 외부 전송은 별도 잠금으로 직렬화한다. 기록 잠금은 전송 전에 읽고 전송 뒤 새 목록에 합칠 때만 잡는다.
// 전송은 발신자 재시도까지 두 번, 각 60초 한도다. 전송 잠금의 만료는 그보다 길게 둔다.
export function notifyUnmatched(repo: string, run: string | null, send = notifyRun): void {
  if (!run || !existsSync(fileOf(repo))) return
  const candidates = unmatchedRecords(repo)
  for (const [id, records] of Object.entries(candidates)) for (const pr of Object.keys(records)) {
    try {
      withFileLock(`${fileOf(repo)}.notify`, () => {
        const entry = access(repo, false, (data) => data.items[id]?.[pr])
        if (!entry || entry.notified) return
        const sent = send(run, 'BOARD-UNMATCHED', unmatchedLine(id, pr), Number(pr))
        if (!sent.ok) { console.error(`NOTICE-FAIL BOARD-UNMATCHED ${sent.error}`); return }
        access(repo, true, (data) => {
          const current = data.items[id]?.[pr]
          // 전송 중 풀려 지워졌거나 새로 기록된 것은 건드리지 않는다.
          if (current?.at === entry.at) current.notified = new Date().toISOString()
        })
      }, { waitMs: 0, staleMs: 180_000 })
    } catch (e) {
      if (!(e instanceof LockTimeout)) console.error(`NOTICE-FAIL BOARD-UNMATCHED ${(e as Error).message}`)
    }
  }
}
