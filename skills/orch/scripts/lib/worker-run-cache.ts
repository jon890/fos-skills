// 끝난 Run 의 worker 행만 머신 폴더의 worker-runs/<실행 파일과 Run id의 해시>.json 에 기억한다.
// run-list 에 완료 상태가 없어 worker-list 의 모든 dispatch 가 completed/failed/abandoned/canceled 이고,
// working/ready 행이 없으며 updated_at 이 10분 이상 지난 Run 만 저장한다. 갱신 시각이 없으면 저장하지 않는다.
// run-list 의 updated_at 이 바뀌면 무효다. 같은 시각이어도 현재 살아 있는 터미널 handle 이 행에 있으면 다시 읽는다.
// 따라서 끝난 Run 의 터미널을 사용자가 넘겨받아도 옛 소유 상태로 닫거나 입력을 허락하지 않는다.
// hook 은 보내려는 handle 을 살아 있는 handle 로 넘긴다. 캐시가 없거나 손상됐으면 정상 조회로 돌아간다.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { machineDir } from './machine.ts'
import { orcaBin } from './orca.ts'

export type RunInfo = { id: string; updated_at?: unknown }
type Row = Record<string, unknown>
const OLD_MS = 600_000

function settled(rows: Row[]): boolean {
  return rows.every((r) => ['completed', 'failed', 'abandoned', 'canceled'].includes(String(r.dispatchStatus)) &&
    !['working', 'ready'].includes(String(r.workerState)))
}

function handles(row: Row): unknown[] {
  return [row.agentTerminalHandle, (row.resource as Row | undefined)?.terminalHandle]
}

export class WorkerRunCache {
  private file(run: RunInfo): string {
    const key = createHash('sha256').update(`${orcaBin()}\0${run.id}`).digest('hex')
    return join(machineDir(), 'worker-runs', `${key}.json`)
  }

  read(run: RunInfo, live: ReadonlySet<unknown>): Row[] | null {
    try {
      const data = JSON.parse(readFileSync(this.file(run), 'utf8'))
      if (!this.old(run) || data.updated !== run.updated_at || !Array.isArray(data.rows)) return null
      if (!data.rows.every((r: unknown) => r && typeof r === 'object' && !Array.isArray(r))) return null
      if (!settled(data.rows)) return null
      if (data.rows.some((r: Row) => handles(r).some((h) => h && live.has(h)))) return null
      return data.rows
    } catch { return null }
  }

  private old(run: RunInfo): boolean {
    const at = typeof run.updated_at === 'string' ? Date.parse(run.updated_at) : NaN
    return Number.isFinite(at) && Date.now() - at >= OLD_MS
  }

  remember(run: RunInfo, rows: Row[]): void {
    if (!this.old(run) || !settled(rows)) return
    try {
      const file = this.file(run)
      mkdirSync(join(machineDir(), 'worker-runs'), { recursive: true })
      writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify({ updated: run.updated_at, rows }))
      renameSync(`${file}.${process.pid}.tmp`, file)
    } catch { /* 캐시 쓰기 실패는 다음 조회만 늘린다 */ }
  }
}
