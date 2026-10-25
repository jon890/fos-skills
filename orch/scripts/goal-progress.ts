// 보드의 목표 항목 진행 표시줄을 다시 계산한다.
//
// 보드는 work-board 형식의 board.json 이다. 항목마다 id 와 status(goal, decide, doing, wait, done)가 있다.
// 추적 항목을 주지 않으면 목표 항목 자신의 단계 줄을 센다. 단계 줄은 숫자로 시작하고(「1. …」),
// 객체의 done 이 true 면 끝난 단계다. 옛 문자열의 「✓ 」 도 읽는다. 숫자로 시작하지 않는 줄은 참고 줄이라 세지 않는다.
// 끝난 단계 수와 전체 단계 수를 목표 항목에 `--progress 끝낸수/전체수` 로 넣는다.
// 추적 항목을 주면(하위 호환) 그 항목 중 status 가 done 인 수를 센다.
//
// 사용법:
//     goal-progress.ts GOAL_ID                        # 목표 항목의 단계 줄을 센다
//     goal-progress.ts GOAL_ID ITEM_ID [ITEM_ID ...]
//     goal-progress.ts GOAL_ID --items-file FILE      # 한 줄에 id 하나. 빈 줄과 # 줄은 건너뛴다
//     옵션 (고유 접두로 줄여 쓸 수 있다. lib/args.ts):
//       --board PATH       board.json 경로. 기본은 work-board 의 board.ts 가 정한 위치
//       --board-bin PATH   항목을 고치는 명령. 기본은 환경 변수 BOARD_BIN, 없으면 이 저장소의 work-board/bin/board.ts
//       --details          목표 항목의 하위 줄도 추적 항목마다 하나씩 다시 쓴다. 끝난 항목은 「✓ 」 를 앞에 붙인다
//       --dry-run          보드를 고치지 않고 계산 결과만 낸다
//
// 보드에 없는 추적 항목은 끝나지 않은 것으로 세고 stderr 로 알린다.
// 머지 뒤 정리에서 항목을 지웠다면 지우지 말고 done 으로 두거나, 추적 목록에서도 뺀다.
//
// 종료 코드: 0 반영했다(또는 --dry-run), 1 보드나 명령을 읽지 못했다, 2 사용법 오류

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { boardPath } from './lib/paths.ts'
import { NO_LIMIT_MS, run, scriptCommand } from './lib/proc.ts'
import { LINE_BREAK } from './lib/spec.ts'

const USAGE = '사용법: goal-progress.ts GOAL_ID [ITEM_ID ...] [--items-file FILE] [--board PATH] [--board-bin PATH] [--details] [--dry-run]'
const HERE = dirname(fileURLToPath(import.meta.url))
const DONE_MARK = '✓ '
const STEP = /^(✓ )?\p{Nd}/u

const OPTIONS = {
  'items-file': { type: 'string' },
  board: { type: 'string' },
  'board-bin': { type: 'string' },
  details: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

type Detail = string | { text: string; done?: unknown }
type Item = { id: string; status?: unknown; title?: string; details?: unknown }

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

function textOf(detail: Detail): string {
  return typeof detail === 'string' ? detail : detail.text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readItemsFile(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

function boardItems(board: unknown): Map<string, Item> {
  const items = isRecord(board) ? (board.items ?? []) : []
  const values: unknown[] = Array.isArray(items) ? items : isRecord(items) ? Object.values(items) : []
  const found = new Map<string, Item>()
  for (const value of values) if (isRecord(value) && Object.hasOwn(value, 'id')) found.set(String(value.id), value as Item)
  return found
}

// 끝낸 수, 하위 줄, 보드에 없는 id 를 낸다.
function progress(byId: Map<string, Item>, tracked: string[]): { done: number; details: string[]; missing: string[] } {
  let done = 0
  const details: string[] = []
  const missing: string[] = []
  for (const id of tracked) {
    const item = byId.get(id)
    if (item === undefined) {
      missing.push(id)
      details.push(id)
      continue
    }
    const finished = item.status === 'done'
    if (finished) done += 1
    details.push((finished ? DONE_MARK : '') + (item.title ?? id))
  }
  return { done, details, missing }
}

// 끝낸 수와 단계 줄을 낸다. 숫자로 시작하지 않는 줄은 세지 않는다.
function stepProgress(goal: Item): { done: number; steps: Detail[] } {
  const details = Array.isArray(goal.details) ? (goal.details as Detail[]) : []
  const steps = details.filter((detail) => STEP.test(textOf(detail)))
  const done = steps.filter((detail) => (typeof detail === 'string' ? detail.startsWith(DONE_MARK) : detail.done === true)).length
  return { done, steps }
}

function main(argv: string[]): number {
  let parsed
  try {
    parsed = parseArgs({ args: expandArgs(argv, OPTIONS), options: OPTIONS, allowPositionals: true })
  } catch (e) {
    err(`${USAGE}\ngoal-progress: ${(e as Error).message}`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    out(USAGE)
    return 0
  }
  if (positionals.length === 0) {
    err(`${USAGE}\ngoal-progress: GOAL_ID 가 필요하다`)
    return 2
  }
  const [goal, ...items] = positionals
  let tracked: string[]
  try {
    tracked = [...items, ...(values['items-file'] ? readItemsFile(values['items-file']) : [])]
  } catch (e) {
    err(`추적 항목 파일을 읽지 못했다: ${(e as Error).message}`)
    return 1
  }
  tracked = [...new Set(tracked)]
  const board = values.board ? resolve(values.board) : boardPath(process.cwd())
  let byId: Map<string, Item>
  try {
    byId = boardItems(JSON.parse(readFileSync(board, 'utf8')))
  } catch (e) {
    err(`보드를 읽지 못했다: ${board}: ${(e as Error).message}`)
    return 1
  }
  const goalItem = byId.get(goal)
  if (goalItem === undefined) {
    err(`목표 항목이 보드에 없다: ${goal}`)
    return 1
  }

  let done: number
  let total: number
  let details: Detail[]
  let missing: string[] = []
  let withDetails = values.details === true
  if (tracked.length > 0) {
    const found = progress(byId, tracked)
    done = found.done
    details = found.details
    missing = found.missing
    total = tracked.length
  } else {
    const found = stepProgress(goalItem)
    done = found.done
    details = found.steps
    total = details.length
    if (total === 0) {
      out(`${goal} 단계 줄이 없어 진행률을 건드리지 않았다`)
      return 0
    }
    // 단계 줄이 곧 하위 줄이라 다시 쓰지 않는다. 참고 줄을 지우지 않기 위해서다
    withDetails = false
  }
  if (missing.length > 0) err(`보드에 없는 추적 항목(끝나지 않은 것으로 셈): ${missing.join(', ')}`)
  const value = `${done}/${total}`
  out(`${goal} ${value}`)
  if (withDetails) for (const detail of details) out(`  ${textOf(detail)}`)
  if (values['dry-run']) return 0

  const binPath = values['board-bin'] || process.env.BOARD_BIN || resolve(HERE, '../../work-board/bin/board.ts')
  const cmd = ['set', goal, '--progress', value, '--file', board]
  if (withDetails) for (const detail of details) cmd.push('--detail', textOf(detail))
  const result = run(scriptCommand(binPath, cmd), { timeoutMs: NO_LIMIT_MS })
  if (result.code !== 0) {
    process.stderr.write(result.stderr || result.stdout)
    return 1
  }
  return 0
}

process.exitCode = main(process.argv.slice(2))
