// 사용 한도 알림 시각은 머신 전체가 공유한다. 별도 파일 잠금 안에서 최신 시각만 남긴다.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock } from '../../../../extensions/work-board/bin/file-lock.ts'
import { machineDir } from './machine.ts'

const fileOf = () => join(machineDir(), 'worker-limited.json')
export function workerLimitedAt(): number | null {
  try {
    const value = JSON.parse(readFileSync(fileOf(), 'utf8'))
    if (typeof value?.at !== 'number' || !Number.isFinite(value.at)) throw new Error('한도 알림 시각이 숫자가 아니다')
    return value.at
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function recordWorkerLimited(at: number): void {
  const file = fileOf()
  withFileLock(file, lock => {
    if ((workerLimitedAt() ?? -Infinity) >= at) return
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ at }) + '\n')
    if (!lock.held()) throw new Error(`한도 알림 파일 잠금을 잃었다: ${file}`)
    renameSync(tmp, file)
  })
}
