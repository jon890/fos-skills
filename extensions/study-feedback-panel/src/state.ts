import { isRow, positive, staleAfter, type Summary, type SummaryRead } from './summary.ts'

import { ANSWERS, needsReason, validReason, type Choice, type Action } from './choices.ts'

export type SendRecord = Omit<Choice, 'reason'> & { at: number; sentAt: string }
export type CardStatus = {
  action: Action
  item: string
  revision: number
  status: 'sending' | 'sent' | 'waiting'
  sentAt?: string
}
export type Screen = {
  sequence: number
  status: SummaryRead['status'] | 'unconfigured'
  configured: boolean
  curatedAt: string | null
  stale: boolean
  summary: Summary | null
  cards: CardStatus[]
}
export type ChoiceError = 'unconfigured' | 'unavailable' | 'changed' | 'invalid_choice' |
  'invalid_reason' | 'locked' | 'duplicate' | 'queue_write_failed' | 'wake_failed'
export type ChoiceResult = { screen: Screen } & ({ sentAt: string } | { error: ChoiceError })

export const DUPLICATE_MS = 60_000
export const LOCK_MS = 600_000
export function parseChoice(value: unknown): Choice | ChoiceError {
  if (!isRow(value) || typeof value.item !== 'string' || !value.item || !positive(value.revision) ||
      (value.action !== 'choose_study_candidate' && value.action !== 'choose_feedback_bundle') ||
      !(ANSWERS[value.action] as readonly unknown[]).includes(value.answer)) return 'invalid_choice'
  const { item, revision, action, answer } = value as Choice
  if (!needsReason(answer)) return { item, revision, action, answer }
  if (typeof value.reason !== 'string' || !validReason(value.reason)) return 'invalid_reason'
  return { item, revision, action, answer, reason: value.reason.trim() }
}

export const cardKey = ({ action, item }: Pick<Choice, 'action' | 'item'>) => JSON.stringify([action, item])
export const matchingCard = (summary: Summary, choice: Pick<Choice, 'action' | 'item'>) =>
  (choice.action === 'choose_study_candidate' ? summary.study : summary.feedback).find(({ id }) => id === choice.item)

export class PanelState {
  latest: SummaryRead | null = null
  lastGood: Summary | null = null
  recent: SendRecord[] = []
  locks: SendRecord[] = []

  accept(read: SummaryRead) {
    this.latest = read
    if (read.status !== 'ready') return
    this.lastGood = read.summary
    this.locks = this.locks.filter((entry) => matchingCard(read.summary, entry)?.revision === entry.revision)
  }

  record(entry: SendRecord) {
    this.recent.push(entry)
    if (this.latest?.status !== 'ready' || matchingCard(this.latest.summary, entry)?.revision === entry.revision) {
      this.locks = this.locks.filter((lock) => cardKey(lock) !== cardKey(entry))
      this.locks.push(entry)
    }
  }

  block(choice: Choice, now: number): ChoiceError | undefined {
    if (this.recent.some((entry) => cardKey(entry) === cardKey(choice) && entry.answer === choice.answer &&
      now < entry.at + DUPLICATE_MS)) return 'duplicate'
    if (this.locks.some((entry) => cardKey(entry) === cardKey(choice) && now < entry.at + LOCK_MS)) return 'locked'
  }

  screen(now: number, configured: boolean, sending: Choice[]): Omit<Screen, 'sequence'> {
    const status = this.latest?.status ?? 'unconfigured'
    const curatedAt = this.latest?.status === 'unsupported' && this.latest.curatedAt !== undefined
      ? this.latest.curatedAt : this.lastGood?.curatedAt ?? null
    const cards: CardStatus[] = this.locks.map(({ action, item, revision, at, sentAt }) => ({
      action, item, revision, status: now < at + LOCK_MS ? 'sent' : 'waiting', sentAt
    }))
    cards.push(...sending.map(({ action, item, revision }) => ({ action, item, revision, status: 'sending' as const })))
    return {
      status, configured, curatedAt, stale: curatedAt !== null && now > staleAfter(curatedAt),
      summary: status === 'ready' || status === 'read_failed' ? this.lastGood : null, cards
    }
  }

  nextBoundary(now: number, curatedAt: string | null): number {
    const stale = curatedAt === null ? Infinity : staleAfter(curatedAt) + 1
    const lockEnds = this.locks.map(({ at }) => at + LOCK_MS)
    return Math.min(...[stale, ...lockEnds].filter((at) => at > now))
  }

  prune(now: number) {
    this.recent = this.recent.filter(({ at }) => now < at + DUPLICATE_MS)
  }
}
