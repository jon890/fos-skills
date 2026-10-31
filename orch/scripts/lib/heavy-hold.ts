// 무거운 검사 자리를 오래 쥔 등록을 찾는다. 상주 루프(orch-loop.ts 의 「자리 보유 확인」)가 틱마다 부른다.
//
// heavy-slot.ts 는 자리를 잡을 때 등록(<pid>.json)에 held_at(자리를 잡은 시각, epoch ms)과 command(명령줄)를 적는다.
// 이 모듈은 잠금 없이 등록을 읽기만 한다. 등록을 지우거나 프로세스를 끊지 않는다. 끊을지는 사용자가 정한다.
// 10-30 에 한 호스트가 자리를 6시간 쥐어 다른 worker 의 검사가 모두 기다렸다. 그때는 알릴 방법이 없었다.
//
// 판정: 등록이 held 이고 held_at 이 수이고 pid 가 살아 있고 지금 - held_at 이 상한(초)을 넘으면 오래 쥔 것이다.
// held_at 이 없는 등록(이 기록을 남기기 전 heavy-slot 이 잡은 자리)과 읽지 못한 파일은 건너뛴다.
//
// 상한: HEAVY_HOLD_MAX(양수 초). 없거나 양수가 아니면 DEFAULT_HOLD_MAX_SEC(1800, 30분)다.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { alive } from './process.ts'

export const DEFAULT_HOLD_MAX_SEC = 1800

export type Held = { pid: number; heldAt: number; command: string }

export function holdMaxSec(): number {
  const value = Number(process.env.HEAVY_HOLD_MAX)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_HOLD_MAX_SEC
}

// dir 의 등록 가운데 maxSec 보다 오래 자리를 쥔 것. 오래 쥔 차례(held_at 이 앞선 것부터)다. 폴더가 없으면 빈 목록이다
export function overHeld(dir: string, maxSec: number, now: number, isAlive: (pid: number) => boolean = alive): Held[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => /^\d+\.json$/.test(name))
  } catch {
    return []
  }
  const found: Held[] = []
  for (const name of names) {
    let row: Record<string, unknown>
    try {
      row = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (row === null || typeof row !== 'object' || row.held !== true || typeof row.held_at !== 'number') continue
    const pid = Number(name.slice(0, -'.json'.length))
    if (now - row.held_at <= maxSec * 1000 || !isAlive(pid)) continue
    found.push({ pid, heldAt: row.held_at, command: typeof row.command === 'string' ? row.command : '' })
  }
  return found.sort((a, b) => a.heldAt - b.heldAt || a.pid - b.pid)
}
