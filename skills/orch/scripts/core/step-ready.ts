// 다음 단계 알림의 중복과 사용 한도 뒤 재알림을 판단한다. 입출력은 호출자가 맡는다.
export const LIMITED_PAUSE_MS = 30 * 60_000
export type ReadyNotice = { step: string; mark: 'auto' | 'ask'; at: number; again: number | null }
export type ReadyStep = { id: string; active: boolean; done: boolean; step: string | null; mark: 'auto' | 'ask' | 'wait' | null; busy: boolean | null; launched: boolean }

export function readyNotices(previous: Record<string, ReadyNotice>, steps: ReadyStep[], now: number, limitedAt: number | null): {
  records: Record<string, ReadyNotice>; fire: Array<{ id: string; notice: ReadyNotice }>
} {
  const records: Record<string, ReadyNotice> = {}
  const fire: Array<{ id: string; notice: ReadyNotice }> = []
  for (const row of steps) {
    const before = previous[row.id]
    if (row.done) continue
    // 목록을 읽지 못한 auto 는 앞 기록도 바꾸지 않는다.
    if (row.mark === 'auto' && row.busy === null) {
      if (before) records[row.id] = before
      continue
    }
    if (before && before.step === row.step) records[row.id] = before
    if (!row.active || !row.step || (row.mark !== 'auto' && row.mark !== 'ask')) continue
    if (row.mark === 'auto' && row.busy) continue
    const same = before?.step === row.step
    const again = same && row.mark === 'auto' && !row.launched && limitedAt !== null &&
      now - limitedAt >= LIMITED_PAUSE_MS && before.at < limitedAt + LIMITED_PAUSE_MS && before.again !== limitedAt
    if (same && !again) continue
    fire.push({ id: row.id, notice: { step: row.step, mark: row.mark, at: now, again: again ? limitedAt : null } })
  }
  // fire 는 아직 전송 전이다. 호출자는 성공한 알림만 records 에 넣는다.
  return { records, fire }
}

// 머신 로컬 시간. 날짜를 자동 보정하는 Date 동작을 받아들이지 않는다.
export function waitTimeMs(condition: string | null): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(condition ?? '')
  if (!parts) return null
  const [year, month, day, hour, minute] = parts.slice(1).map(Number)
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(hour, minute, 0, 0)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day &&
    date.getHours() === hour && date.getMinutes() === minute ? date.getTime() : null
}
