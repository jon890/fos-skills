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

const HOUR = 60 * MINUTE
const pad = (n) => String(n).padStart(2, '0')
const clock = (date) => pad(date.getHours()) + ':' + pad(date.getMinutes())

function dateTime(at) {
  const date = new Date(at)
  return pad(date.getMonth() + 1) + '/' + pad(date.getDate()) + ' ' + clock(date)
}

// 다음 실행 시각을 오늘, 내일, 그 뒤는 날짜로 쓴다
export function whenText(at, now) {
  const date = new Date(at)
  const today = new Date(now)
  const days = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / (24 * HOUR))
  return (days === 0 ? '오늘 ' : days === 1 ? '내일 ' : pad(date.getMonth() + 1) + '/' + pad(date.getDate()) + ' ') + clock(date)
}

// 프롬프트 첫 줄의 첫 [...] 안 글이 제목이다. 없으면 첫 줄을 짧게 자른다
export function promptTitle(prompt, max = 40) {
  const first = String(prompt).trim().split(/\r?\n/)[0].trim()
  const tag = first.match(/\[([^\]]+)\]/)
  const title = tag ? tag[1].trim() : first
  return title.length > max ? title.slice(0, max - 1) + '…' : title
}

function numbers(text, max) {
  if (!/^\d+(,\d+)*$/.test(text)) return null
  const values = [...new Set(text.split(',').map(Number))].sort((a, b) => a - b)
  return values.every((n) => n <= max) ? values : null
}

// cron 식을 사람이 읽는 말로 바꾼다. 매일 정해진 시각과 한 번만 도는 것만 바꾸고, 그 밖은 도구가 준 말이나 원래 식이다
export function cronText(row) {
  if (!row.recurring) return '한 번, ' + dateTime(row.next)
  const parts = row.cron.trim().split(/\s+/)
  if (parts.length === 5 && parts.slice(2).every((part) => part === '*')) {
    const minutes = numbers(parts[0], 59)
    const hours = numbers(parts[1], 23)
    if (minutes && hours) return '매일 ' + hours.flatMap((h) => minutes.map((m) => pad(h) + ':' + pad(m))).join(', ')
  }
  return row.schedule && row.schedule !== row.cron ? row.schedule : row.cron
}

// 한 시간 안에 도는 예약이다. 보드 창이 색으로 나눈다
export function scheduleSoon(row, now) {
  return row.next - now <= HOUR
}

export function sortSchedules(rows) {
  return [...rows].sort((a, b) => a.next - b.next)
}

// 접힌 줄: 다음 실행, 반복(↻)과 한 번(1회) 표시, 제목, 사람이 읽는 주기
export function scheduleLine(row, now) {
  return whenText(row.next, now) + '  ' + (row.recurring ? '↻' : '1회') + ' ' + promptTitle(row.prompt) + ' · ' + cronText(row)
}

// 펼친 자리: 원래 식, 만료, 세션 한정 안내, 프롬프트 전문
export function scheduleDetail(row) {
  return [
    'cron ' + row.cron + (row.expires === null ? '' : ' · 만료 ' + dateTime(row.expires)),
    '이 세션에서만 살아요. 세션이 끝나면 사라져요',
    row.prompt.trim(),
  ]
}
