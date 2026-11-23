// 계정과 파일을 읽는 쪽에서 모델에 적용할 창만 넘긴다.
export type LimitWindow = { label: string; used: number | null; resetsAt: number; reached?: boolean }
export type LimitEvidence = { windows: LimitWindow[]; unknown?: string }

export function exhaustedWindows(windows: readonly LimitWindow[], now: number): LimitWindow[] {
  return windows.filter(w => w.resetsAt > now && (w.reached || (w.used !== null && w.used >= 100)))
}

export type BlockedModel = { model: string; windows: LimitWindow[] }

export function limitReason(model: string, window: LimitWindow): string {
  return `한도: ${model} ${window.label} 100%, ${new Date(window.resetsAt).toISOString()}`
}

export function chooseWithinLimits<T extends { model: string | null }>(
  initial: T,
  alternatives: () => Iterable<T>,
  evidence: (candidate: T) => LimitEvidence,
  now: number,
): { chosen: T; reason: string | null } | { blocked: BlockedModel[] } {
  const blocked: BlockedModel[] = []
  function isBlocked(candidate: T): boolean {
    if (!candidate.model) return false
    const windows = exhaustedWindows(evidence(candidate).windows, now)
    if (!windows.length) return false
    if (!blocked.some(entry => entry.model === candidate.model)) blocked.push({ model: candidate.model, windows })
    return true
  }
  if (!isBlocked(initial)) return { chosen: initial, reason: null }
  for (const candidate of alternatives()) {
    if (!isBlocked(candidate)) {
      const latest = blocked[0].windows.reduce((a, b) => b.resetsAt > a.resetsAt ? b : a)
      return { chosen: candidate, reason: limitReason(blocked[0].model, latest) }
    }
  }
  return { blocked }
}

export function refusalLines(blocked: BlockedModel[]): string[] {
  const windows = blocked.flatMap(entry => entry.windows.map(window => ({ model: entry.model, window })))
  const earliest = Math.min(...windows.map(entry => entry.window.resetsAt))
  return [
    ...windows.map(({ model, window }) => `USAGE-LIMIT ${limitReason(model, window)}`),
    `USAGE-RESET 가장 먼저 풀리는 시각 ${new Date(earliest).toISOString()}`,
  ]
}
