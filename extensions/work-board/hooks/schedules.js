// CronCreate/CronDelete 결과로만 갱신하는 세션 전용 예약 목록.
/** @typedef {import('../../../types/index.d.ts').BoardSchedule} BoardSchedule */
const WEEK = 7 * 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000

function field(source, min, max, sunday = false) {
  const values = new Set()
  for (const part of source.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return null
    const [startText, endText] = range === '*' ? [String(min), String(max)] : range.split('-')
    const start = Number(startText)
    const end = endText === undefined ? (stepText === undefined ? start : max) : Number(endText)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return null
    for (let n = start; n <= end; n += step) values.add(sunday && n === 7 ? 0 : n)
  }
  return values
}

export function nextCron(cron, after) {
  if (typeof cron !== 'string' || !Number.isFinite(after)) return null
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minute, hour, day, month, weekday] = parts.map((part, i) => field(part, [0, 0, 1, 1, 0][i], [59, 23, 31, 12, 7][i], i === 4))
  if ([minute, hour, day, month, weekday].some((part) => !part)) return null
  const dayWildcard = parts[2].startsWith('*')
  const weekdayWildcard = parts[4].startsWith('*')
  let time = Math.floor(after / MINUTE) * MINUTE + MINUTE
  const start = new Date(time)
  const limit = new Date(start.getFullYear() + 9, start.getMonth(), start.getDate()).getTime()
  while (time < limit) {
    const date = new Date(time)
    const dayMatch = day.has(date.getDate())
    const weekdayMatch = weekday.has(date.getDay())
    if (!month.has(date.getMonth() + 1)) {
      time = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime()
      continue
    }
    if (!(dayWildcard || weekdayWildcard ? dayMatch && weekdayMatch : dayMatch || weekdayMatch)) {
      time = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
      continue
    }
    if (!hour.has(date.getHours())) {
      time += (60 - date.getMinutes()) * MINUTE
      continue
    }
    if (minute.has(date.getMinutes())) return time
    time += MINUTE
  }
  return null
}

function dataOf(result) {
  if (!result || result.deny || result.isError) return null
  const data = result.result
  return data && typeof data === 'object' ? data : null
}

/** @returns {BoardSchedule[]} */
export function updateSchedules(current, call, result, at) {
  const rows = Array.isArray(current) ? current : []
  const data = dataOf(result)
  if (!data || !call || !Number.isFinite(at)) return rows
  if (call.tool === 'CronDelete') {
    if (typeof call.id !== 'string' || data.id !== call.id) return rows
    return rows.filter((row) => row.id !== call.id)
  }
  if (call.tool !== 'CronCreate' || typeof call.cron !== 'string' || typeof call.prompt !== 'string'
    || typeof data.id !== 'string' || !data.id || data.durable === true) return rows
  const firstCron = nextCron(call.cron, at)
  const next = Number.isFinite(data.nextFireAt) ? data.nextFireAt : firstCron
  if (next === null) return rows
  const offset = firstCron === null ? 0 : next - firstCron
  const recurring = data.recurring === true || (data.recurring === undefined && call.recurring !== false)
  /** @type {BoardSchedule} */
  const row = { id: data.id, cron: call.cron, prompt: call.prompt, schedule: typeof data.humanSchedule === 'string' ? data.humanSchedule : call.cron,
    recurring, next, offset, expires: recurring ? at + WEEK : null }
  return [...rows.filter((item) => item.id !== row.id), row]
}

/** @returns {BoardSchedule[]} */
export function visibleSchedules(current, at) {
  if (!Array.isArray(current)) return []
  return current.flatMap((row) => {
    if (!row || !Number.isFinite(row.next) || (row.expires !== null && row.expires <= at)) return []
    if (row.next > at) return [row]
    if (!row.recurring) return []
    const nextCronTime = nextCron(row.cron, at - (row.offset || 0))
    const next = nextCronTime === null ? null : nextCronTime + (row.offset || 0)
    return next !== null && (row.expires === null || next <= row.expires) ? [{ ...row, next }] : []
  })
}

function dateTime(at) {
  const date = new Date(at)
  return String(date.getMonth() + 1).padStart(2, '0') + '/' + String(date.getDate()).padStart(2, '0')
    + ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
}

export function scheduleLine(row) {
  const prompt = row.prompt.trim().split(/\r?\n/)[0].slice(0, 80)
  return row.schedule + ' · ' + prompt + ' · 다음 ' + dateTime(row.next)
    + (row.expires === null ? '' : ' · 만료 ' + dateTime(row.expires))
}
