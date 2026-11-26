import { statSync, watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

type Row = Record<string, unknown>
type Card = {
  id: string
  title: string
  round: number
  revision: number
  state: 'selectable' | 'recorded'
  error: { code: string; message: string } | null
}
export type StudyCard = Card & {
  question: string
  outline: string[]
  sources: { label: string; url?: string }[]
  repoIds: string[]
}
export type FeedbackCard = Card & {
  number: number
  skill: string
  candidates: { id: string; title: string; repoId: string }[]
}
export type Summary = {
  schemaVersion: 1
  curatedAt: string | null
  updatedAt: string
  study: StudyCard[]
  feedback: FeedbackCard[]
  feedbackTotals: { rejected: number; held: number }
  inProgress: {
    item: string
    title: string
    activity: 'writing' | 'applying'
    repoId: string
    pr: { number: number; state: 'open'; draft: boolean } | null
  }[]
  repositories: { id: string; name: string; studyCount: number; feedbackCount: number }[]
}

export type SummaryRead =
  | { status: 'ready'; summary: Summary }
  | { status: 'missing' | 'read_failed' }
  | { status: 'unsupported'; curatedAt?: string | null }

export const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const id = (value: unknown): value is string => text(value) && value.length > 0
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export const positive = (value: unknown): value is number => count(value) && value > 0
const list = (value: unknown, valid: (entry: unknown) => boolean) =>
  Array.isArray(value) && value.every(valid)
const uniqueIds = (rows: Card[]) => new Set(rows.map(({ id }) => id)).size === rows.length

function timestamp(value: unknown): value is string {
  if (!text(value)) return false
  const parts = /^(\d{4})-(\d\d)-(\d\d)T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value)
  if (!parts || !Number.isFinite(Date.parse(value))) return false
  const [, year, month, day] = parts
  const leap = +year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return +day >= 1 && +day <= days[+month - 1]
}

function card(value: unknown): value is Row & Card {
  return isRow(value) && id(value.id) && text(value.title) &&
    positive(value.round) && positive(value.revision) &&
    (value.state === 'selectable' || value.state === 'recorded') &&
    (value.error === null || (isRow(value.error) && text(value.error.code) && text(value.error.message)))
}

function validSummary(value: Row): value is Row & Summary {
  return (value.curatedAt === null || timestamp(value.curatedAt)) && timestamp(value.updatedAt) &&
    list(value.study, (item) => card(item) && text(item.question) && list(item.outline, text) &&
      list(item.repoIds, id) && list(item.sources, (source) =>
        isRow(source) && text(source.label) && (source.url === undefined || text(source.url)))) &&
    list(value.feedback, (item) => card(item) && positive(item.number) && text(item.skill) &&
      list(item.candidates, (candidate) =>
        isRow(candidate) && id(candidate.id) && text(candidate.title) && id(candidate.repoId))) &&
    uniqueIds(value.study as StudyCard[]) && uniqueIds(value.feedback as FeedbackCard[]) &&
    isRow(value.feedbackTotals) && count(value.feedbackTotals.rejected) && count(value.feedbackTotals.held) &&
    list(value.inProgress, (item) => isRow(item) && id(item.item) && text(item.title) && id(item.repoId) &&
      (item.activity === 'writing' || item.activity === 'applying') &&
      (item.pr === null || (isRow(item.pr) && positive(item.pr.number) &&
        item.pr.state === 'open' && typeof item.pr.draft === 'boolean'))) &&
    list(value.repositories, (repo) => isRow(repo) && id(repo.id) && text(repo.name) &&
      count(repo.studyCount) && count(repo.feedbackCount))
}

export function parseSummary(value: unknown): SummaryRead {
  if (!isRow(value) || !Number.isInteger(value.schemaVersion)) return { status: 'read_failed' }
  if (value.schemaVersion !== 1) {
    const curatedAt = value.curatedAt === null || timestamp(value.curatedAt) ? value.curatedAt : undefined
    return { status: 'unsupported', curatedAt }
  }
  return validSummary(value) ? { status: 'ready', summary: value } : { status: 'read_failed' }
}

export async function readSummary(file: string): Promise<SummaryRead> {
  try {
    return parseSummary(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'read_failed' }
  }
}

// In Seoul time, count 24 hours spent on weekdays, then restore the UTC instant.
export function staleAfter(curatedAt: string): number {
  const hour = 3_600_000
  const day = 24 * hour
  const seoulOffset = 9 * hour
  let cursor = Date.parse(curatedAt) + seoulOffset
  let remaining = day
  while (remaining > 0) {
    const weekday = new Date(cursor).getUTCDay()
    const untilMidnight = (Math.floor(cursor / day) + 1) * day - cursor
    if (weekday === 0 || weekday === 6) {
      cursor += untilMidnight
    } else {
      const elapsed = Math.min(remaining, untilMidnight)
      cursor += elapsed
      remaining -= elapsed
    }
  }
  return cursor - seoulOffset
}

export class SummaryWatch {
  #watcher?: FSWatcher
  #identity?: string

  sync(file: string, onChange: () => void) {
    let target = file
    let directory = dirname(target)
    for (;;) {
      let stat
      try {
        stat = statSync(directory)
      } catch {
        // The closest existing parent can see the missing directory appear.
      }
      if (stat?.isDirectory()) {
        const identity = JSON.stringify([file, directory, stat.dev, stat.ino])
        if (this.#identity === identity) return
        this.close()
        const name = basename(target)
        try {
          const watcher = watch(directory, { persistent: false }, (_event, filename) => {
            if (this.#watcher === watcher && (!filename || filename === name)) onChange()
          })
          this.#watcher = watcher
          this.#identity = identity
          watcher.on('error', () => {
            if (this.#watcher === watcher) this.close()
          })
        } catch {
          // The periodic refresh retries a directory that vanished while attaching.
        }
        return
      }
      if (directory === dirname(directory)) {
        this.close()
        return
      }
      target = directory
      directory = dirname(target)
    }
  }

  close() {
    this.#watcher?.close()
    this.#watcher = undefined
    this.#identity = undefined
  }
}
