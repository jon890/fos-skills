import { isAbsolute, join, resolve } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type {} from './protocol.ts'
import type { Choice } from './choices.ts'
import { deliver, type DeliverySettings } from './delivery.ts'
import { isRow, parseSummary, readSummary, SummaryWatch } from './summary.ts'
import {
  cardKey, matchingCard, PanelState, parseChoice,
  type ChoiceError, type ChoiceResult, type Screen, type SendRecord
} from './state.ts'

const STORAGE_KEY = 'studyPanel.state'
const RECHECK_MS = 30_000
const automationUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
let stop: (() => void) | undefined

function savedRecords(value: unknown): SendRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    if (!isRow(row) || typeof row.at !== 'number' || !Number.isFinite(row.at) ||
        typeof row.sentAt !== 'string' || !Number.isFinite(Date.parse(row.sentAt))) return []
    const choice = parseChoice({ ...row, reason: 'stored' })
    if (typeof choice === 'string') return []
    const { action, item, revision, answer } = choice
    return [{ action, item, revision, answer, at: row.at, sentAt: row.sentAt }]
  })
}

export default function activate(orca: OrcaWorkerApi) {
  const watcher = new SummaryWatch()
  const sending = new Map<string, Choice>()
  let botHome = ''
  let state = new PanelState()
  let delivery: DeliverySettings | undefined
  let screen: Screen
  let emitted = ''
  let saved = ''
  let sequence = Date.now() * 1000
  let disposed = false
  let boundary: ReturnType<typeof setTimeout> | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  let pending = Promise.resolve()

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = pending.then(operation)
    pending = next.then(() => {}, () => {})
    return next
  }

  function refreshInBackground() {
    if (disposed) return
    void serialize(refresh).catch(() => orca.log('공부·피드백 패널을 갱신하지 못했습니다.'))
  }

  function fileChanged() {
    clearTimeout(debounce)
    debounce = setTimeout(refreshInBackground, 40)
  }

  function publish() {
    const now = Date.now()
    const data = state.screen(now, delivery !== undefined, [...sending.values()])
    const serialized = JSON.stringify(data)
    if (serialized !== emitted) {
      emitted = serialized
      sequence = Math.max(sequence + 1, now * 1000)
      screen = { ...data, sequence }
      if (!disposed) orca.panels.post('studyPanel.changed', screen)
    }
    clearTimeout(boundary)
    const next = state.nextBoundary(now, data.curatedAt)
    if (!disposed && next - now <= RECHECK_MS) boundary = setTimeout(refreshInBackground, next - now)
    return screen
  }

  async function persist() {
    const value = { botHome, lastGood: state.lastGood, recent: state.recent, locks: state.locks }
    const serialized = JSON.stringify(value)
    if (serialized === saved || !botHome || disposed) return
    try {
      await orca.storage.set(STORAGE_KEY, value)
      saved = serialized
    } catch {
      orca.log('공부·피드백 패널 기록을 저장하지 못했습니다.')
    }
  }

  async function refresh() {
    const settings = await orca.settings.get()
    const home = typeof settings.botHome === 'string' && isAbsolute(settings.botHome)
      ? resolve(settings.botHome) : ''
    const automationId = settings.panelAutomationId
    const executable = settings.orcaExecutable || 'orca'
    if (home !== botHome) {
      botHome = home
      watcher.close()
      sending.clear()
      state = new PanelState()
      saved = ''
      if (home) {
        const value = await orca.storage.get(STORAGE_KEY)
        if (isRow(value) && value.botHome === home) {
          const parsed = parseSummary(value.lastGood)
          if (parsed.status === 'ready') state.lastGood = parsed.summary
          state.recent = savedRecords(value.recent)
          state.locks = savedRecords(value.locks)
        }
      }
    }
    delivery = home && typeof automationId === 'string' && automationUuid.test(automationId) &&
      typeof executable === 'string' && (executable === 'orca' || isAbsolute(executable))
      ? { botHome: home, automationId, executable } : undefined
    if (home && !disposed) {
      const file = join(home, 'state', 'study-panel-summary.json')
      watcher.sync(file, fileChanged)
      state.accept(await readSummary(file))
    }
    state.prune(Date.now())
    const current = publish()
    await persist()
    return current
  }

  function failure(error: ChoiceError): ChoiceResult {
    return { error, screen }
  }

  orca.panels.handle('studyPanel.get', () => serialize(refresh))
  orca.panels.handle('studyPanel.choose', async (input): Promise<ChoiceResult> => {
    const prepared = await serialize(async () => {
      await refresh()
      const choice = parseChoice(input)
      if (typeof choice === 'string') return failure(choice)
      if (!delivery) return failure('unconfigured')
      if (state.latest?.status !== 'ready') return failure('unavailable')
      const card = matchingCard(state.latest.summary, choice)
      if (!card || card.revision !== choice.revision || card.state !== 'selectable') return failure('changed')
      const key = cardKey(choice)
      const now = Date.now()
      const blocked = sending.has(key) ? 'locked' : state.block(choice, now)
      if (blocked) return failure(blocked)
      sending.set(key, choice)
      publish()
      return { choice, round: card.round, key, state, delivery, now }
    })
    if (!('choice' in prepared)) return prepared
    const { choice, round, key, now } = prepared
    const result = await deliver(prepared.delivery, choice, round, now)
    return serialize(async () => {
      if (prepared.state === state) {
        sending.delete(key)
        if ('sentAt' in result) {
          const { action, item, revision, answer } = choice
          state.record({ action, item, revision, answer, at: Date.now(), sentAt: result.sentAt })
        }
      }
      return { ...result, screen: await refresh() }
    })
  })

  const settings = orca.settings.onDidChange(refreshInBackground)
  const interval = setInterval(refreshInBackground, RECHECK_MS)
  interval.unref()
  stop = () => {
    disposed = true
    settings.dispose()
    watcher.close()
    clearInterval(interval)
    clearTimeout(boundary)
    clearTimeout(debounce)
  }
}

export function deactivate() {
  stop?.()
  stop = undefined
}
