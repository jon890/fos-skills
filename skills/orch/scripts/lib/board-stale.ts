// 「갱신 필요」 알림을 이미 낸 단계의 기록. 같은 항목·단계·PR·글이면 동기화마다 같은 줄을 다시 내지 않는다.
// 기록은 orch 루트의 state/board-stale-notified.json 에 둔다. 읽거나 쓰지 못해도 동기화는 계속하고 그때는 알림이 반복될 수 있다.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { withFileLock } from '../../../../extensions/work-board/bin/file-lock.ts'
import { makeParent, pathOf } from './paths.ts'

// 항목 id → { "<단계 번호>:<PR 번호>": 단계 글의 지문 }
export type Notified = Record<string, Record<string, string>>

const fileOf = (repo: string) => join(pathOf('state', repo), 'board-stale-notified.json')
export const staleKey = (number: number, pr: string): string => `${number}:${pr}`
export const textRev = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 12)

export function loadNotified(repo: string): Notified {
  try {
    const file = fileOf(repo)
    if (!existsSync(file)) return {}
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Notified) : {}
  } catch (e) {
    console.error(`board-stale: 기록을 읽지 못했다: ${(e as Error).message.replace(/\s+/g, ' ')}`)
    return {}
  }
}

export function saveNotified(repo: string, data: Notified): void {
  try {
    const file = fileOf(repo)
    makeParent(file, repo)
    withFileLock(file, () => {
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(data))
      renameSync(tmp, file)
    })
  } catch (e) {
    console.error(`board-stale: 기록을 쓰지 못했다: ${(e as Error).message.replace(/\s+/g, ' ')}`)
  }
}
