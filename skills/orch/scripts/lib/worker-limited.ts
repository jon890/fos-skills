// 사용 한도 알림 시각은 머신 전체가 공유한다. 별도 파일 잠금 안에서 최신 시각만 남긴다.
import { randomUUID } from 'node:crypto'
import type { Lock } from '../../../../extensions/work-board/bin/file-lock.ts'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock } from '../../../../extensions/work-board/bin/file-lock.ts'
import { machineDir } from './machine.ts'

const fileOf = () => join(machineDir(), 'worker-limited.json')
type Check = { run: string; provider: string; at: number; checkedAt?: number; claim?: { id: string; at: number } }
type Limited = { at: number; checks?: Record<string, Check> }
export const LIMIT_CHECK_MS = 60 * 60_000
export const LIMIT_CHECK_TTL_MS = 24 * LIMIT_CHECK_MS
function readLimited(): Limited | null {
  try {
    const value = JSON.parse(readFileSync(fileOf(), 'utf8'))
    if (typeof value?.at !== 'number' || !Number.isFinite(value.at)) throw new Error('한도 알림 시각이 숫자가 아니다')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function workerLimitedAt(): number | null { return readLimited()?.at ?? null }

export function recordWorkerLimited(at: number, event?: { run: string; provider: string }): void {
  const file = fileOf()
  withFileLock(file, lock => {
    const previous = readLimited()
    const checks = { ...previous?.checks }
    if (event) {
      const key = JSON.stringify([event.run, event.provider])
      if (!checks[key] || checks[key].at < at) checks[key] = { ...event, at }
    }
    if (!event && (previous?.at ?? -Infinity) >= at) return
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ at: Math.max(previous?.at ?? -Infinity, at), ...(Object.keys(checks).length ? { checks } : {}) }) + '\n')
    if (!lock.held()) throw new Error(`한도 알림 파일 잠금을 잃었다: ${file}`)
    renameSync(tmp, file)
  })
}

// 한도 해제 시각을 알 수 없으므로 시간마다 확인을 요청한다. Run·제공자별 성공 시각을
// 머신 잠금 안에서 저장해 다른 저장소의 루프나 재시작도 같은 주기를 다시 보내지 않는다.
export function notifyLimitChecks(runs: string[], now: number, notify: (check: Check) => void): unknown[] {
  const failures: unknown[] = []
  const file = fileOf()
  for (const key of Object.keys(readLimited()?.checks ?? {})) {
    try {
      const claimed = withFileLock(file, lock => {
        const value = readLimited()
        const check = value?.checks?.[key]
        if (!value || !check) return null
        if (now - check.at >= LIMIT_CHECK_TTL_MS) {
          delete value.checks![key]
          saveLimited(value, lock)
          return null
        }
        if (!runs.includes(check.run) || now - (check.checkedAt ?? check.at) < LIMIT_CHECK_MS) return null
        // 잠금 안에서는 전송 예약만 한다. 프로세스가 사라져도 기한 뒤 다시 시도한다.
        if (check.claim && now - check.claim.at < 180_000) return null
        check.claim = { id: randomUUID(), at: now }
        saveLimited(value, lock)
        return check
      })
      if (!claimed) continue
      let sent = false
      try { notify(claimed); sent = true } catch (error) { failures.push(error) }
      withFileLock(file, lock => {
        const value = readLimited()
        const check = value?.checks?.[key]
        // 명시 해제나 새 한도가 옛 전송의 완료 기록으로 덮이지 않게 한다.
        if (!value || !check || check.claim?.id !== claimed.claim?.id) return
        if (sent) check.checkedAt = now
        delete check.claim
        saveLimited(value, lock)
      })
    } catch (error) { failures.push(error) }
  }
  return failures
}

function saveLimited(value: Limited, lock: Lock): void {
  const file = fileOf()
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value) + '\n')
  if (!lock.held()) throw new Error(`한도 알림 파일 잠금을 잃었다: ${file}`)
  renameSync(tmp, file)
}

// 해제를 확인한 코디네이터가 자기 Run의 제공자 알림만 끝낸다. at는 기존 자동 진행 기준이라 보존한다.
export function clearLimitCheck(run: string, provider: string): void {
  const file = fileOf()
  withFileLock(file, lock => {
    const value = readLimited()
    const key = JSON.stringify([run, provider])
    if (!value?.checks?.[key]) return
    delete value.checks[key]
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value) + '\n')
    if (!lock.held()) throw new Error(`한도 알림 파일 잠금을 잃었다: ${file}`)
    renameSync(tmp, file)
  })
}
