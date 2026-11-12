// 사용 한도 알림 시각은 머신 전체가 공유한다. 별도 파일 잠금 안에서 최신 시각만 남긴다.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock } from '../../../../extensions/work-board/bin/file-lock.ts'
import { machineDir } from './machine.ts'

const fileOf = () => join(machineDir(), 'worker-limited.json')
type Check = { run: string; provider: string; at: number; checkedAt?: number }
type Limited = { at: number; checks?: Record<string, Check> }
export const LIMIT_CHECK_MS = 60 * 60_000
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
  }, { staleMs: 180_000 })
}

// 한도 해제 시각을 알 수 없으므로 시간마다 확인을 요청한다. Run·제공자별 성공 시각을
// 머신 잠금 안에서 저장해 다른 저장소의 루프나 재시작도 같은 주기를 다시 보내지 않는다.
export function notifyLimitChecks(runs: string[], now: number, notify: (check: Check) => void): void {
  const file = fileOf()
  for (const key of Object.keys(readLimited()?.checks ?? {})) {
    // Orca 전송은 최대 60초씩 두 번 시도하므로 전송 중 잠금을 넘겨받지 않게 한다.
    withFileLock(file, lock => {
      const value = readLimited()
      const check = value?.checks?.[key]
      if (!value || !check || !runs.includes(check.run) || now - (check.checkedAt ?? check.at) < LIMIT_CHECK_MS) return
      notify(check)
      check.checkedAt = now
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(value) + '\n')
      if (!lock.held()) throw new Error(`한도 알림 파일 잠금을 잃었다: ${file}`)
      renameSync(tmp, file)
    }, { staleMs: 180_000 })
  }
}
