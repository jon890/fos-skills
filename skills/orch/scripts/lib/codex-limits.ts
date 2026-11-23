import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isObject } from '../core/json.ts'
import type { LimitEvidence, LimitWindow } from '../core/model-limits.ts'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const WINDOW_LABELS = new Map([[300, '5시간'], [10080, '주간']])
const END_TURN = new Set(['task_started', 'task_complete', 'turn_aborted'])

type Observation = LimitWindow & { id: string; model: string | null; minutes: number; at: number }
type CandidateFile = { file: string; modified: number }

class ScanLimit extends Error {}

function rolloutFiles(root: string, since: number, checkBudget: () => void): CandidateFile[] {
  const files: CandidateFile[] = []
  function visit(dir: string, depth: number): void {
    checkBudget()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      checkBudget()
      const file = join(dir, entry.name)
      if (depth < 3 && entry.isDirectory() && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
        visit(file, depth + 1)
      } else if (depth === 3 && entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const { mtimeMs } = statSync(file)
        if (mtimeMs >= since) files.push({ file, modified: mtimeMs })
      }
    }
  }
  visit(root, 0)
  return files.sort((a, b) => b.modified - a.modified)
}

function* lines(file: string, budget: { left: number; check: () => void }): Generator<string> {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(8 * 1024)
    let parts: Buffer[] = []
    for (;;) {
      budget.check()
      // 한도를 정확히 읽었을 때에는 EOF 인지 한 바이트만 확인한다.
      const size = readSync(fd, buffer, 0, Math.min(buffer.length, budget.left + 1), null)
      budget.left -= size
      budget.check()
      if (size === 0) return // 쓰는 중이라 개행이 없는 마지막 줄은 다음에 읽는다.
      let start = 0
      for (let end = buffer.indexOf(10, start); end >= 0 && end < size; end = buffer.indexOf(10, start)) {
        budget.check()
        const tail = buffer.subarray(start, end)
        yield parts.length ? Buffer.concat([...parts, tail]).toString('utf8') : tail.toString('utf8')
        parts = []
        start = end + 1
      }
      if (start < size) parts.push(Buffer.from(buffer.subarray(start, size)))
    }
  } finally {
    closeSync(fd)
  }
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

function observationTarget(limits: Record<string, unknown>): { id: string; model: string | null } | null {
  const raw = limits.limit_id
  if (raw == null || raw === 'codex') return { id: 'codex', model: null }
  if (typeof raw !== 'string' || typeof limits.limit_name !== 'string') return null
  const id = raw.trim().toLowerCase().replaceAll('-', '_')
  const model = limits.limit_name.trim().toLowerCase()
  if (id === 'base_model_inference' && /^gpt-reserve(?:-[\w.]+)?$/.test(model)) return { id, model }
  if (/^codex_\w+$/.test(id) && /^gpt-[\w.-]+$/.test(model)) return { id, model }
  return null
}

function observations(limits: Record<string, unknown>, at: number): Observation[] {
  const target = observationTarget(limits)
  if (!target) return []
  const slots = [limits.primary, limits.secondary].filter(slot => slot != null)
  return slots.filter(isObject).flatMap(raw => {
    const minutes = Number.isInteger(raw.window_minutes) ? raw.window_minutes as number : 0
    const label = WINDOW_LABELS.get(minutes)
    const resetsAt = typeof raw.resets_at === 'number' && Number.isSafeInteger(raw.resets_at) ? raw.resets_at * 1000 : 0
    const used = typeof raw.used_percent === 'number' && Number.isFinite(raw.used_percent) && raw.used_percent >= 0 ? raw.used_percent : null
    // 크레딧·지출 한도는 primary/secondary 의 초기화 시각에 연결하지 않는다.
    const reached = limits.rate_limit_reached_type === 'rate_limit_reached' && slots.length === 1
    if (!label || resetsAt <= 0 || resetsAt > 8.64e15 || (used === null && !reached)) return []
    return [{ ...target, minutes, label, used, resetsAt, reached, at }]
  })
}

function readFirstTurn(
  source: Iterable<string>, creatorId: string, found: Map<string, Observation>, now: number,
): void {
  let first = true
  let started = false
  for (const line of source) {
    const event = parseLine(line)
    if (first) {
      first = false
      if (event?.type !== 'session_meta' || !isObject(event.payload) || event.payload.creator_account_id !== creatorId) return
      continue
    }
    if (event?.type !== 'event_msg' || !isObject(event.payload)) continue
    const { type, rate_limits } = event.payload
    if (typeof type !== 'string') continue
    if (!started) {
      started = type === 'task_started'
      continue
    }
    if (END_TURN.has(type)) return
    if (type !== 'token_count' || !isObject(rate_limits) || typeof event.timestamp !== 'string') continue
    const at = Date.parse(event.timestamp)
    if (!Number.isFinite(at) || at > now) continue
    for (const value of observations(rate_limits, at)) {
      const key = `${value.id}:\0${value.minutes}`
      const previous = found.get(key)
      if (!previous || previous.at < at) found.set(key, value)
    }
  }
}

const commonModel = (model: string) => /^gpt-\d+(?:\.\d+)*(?:-(?:sol|astra|terra|luna|codex|max|mini|nano|pro))?$/.test(model)

export function readCodexLimits(
  home: string, creatorId: string, now: number, limits = { milliseconds: 3000, bytes: 64 * 1024 * 1024 },
): (model: string) => LimitEvidence {
  const deadline = performance.now() + limits.milliseconds
  const budget = {
    left: limits.bytes,
    check() {
      if (performance.now() >= deadline || this.left < 0) throw new ScanLimit()
    },
  }
  const found = new Map<string, Observation>()
  try {
    for (const { file } of rolloutFiles(join(home, 'sessions'), now - WEEK_MS, () => budget.check())) {
      readFirstTurn(lines(file, budget), creatorId, found, now)
    }
    budget.check()
  } catch (error) {
    const unknown = error instanceof ScanLimit ? '세션 기록 탐색 한도 초과' : '세션 기록을 읽지 못했다'
    return () => ({ windows: [], unknown })
  }
  return model => {
    const windows = [...found.values()]
      .filter(window => window.model ? model === window.model : commonModel(model))
      .map(({ label, used, resetsAt, reached }) => ({ label, used, resetsAt, reached }))
    return windows.length ? { windows } : { windows, unknown: '이 계정과 모델에 적용할 한도 창이 없다' }
  }
}
