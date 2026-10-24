// 보드(board.json)에서 PR 이 머지된 항목을 done 으로 바꾸고 목표 진행률을 다시 센다.
//
// 하위 줄은 코디네이터가 쓰는 번호 붙은 단계만 둔다. 이 스크립트는 상태 줄을 쓰지 않는다.
// PR 상태나 커밋 같은 자동 줄은 읽기 어렵고 단계와 섞여 보드를 흐린다(사용자 요청).
//
//     - pr 칸의 PR 이 MERGED 이고 끝나지 않은 단계가 1개 이하면 남은 단계를 끝내고 항목을 done 으로 바꾼다
//     - MERGED 여도 끝나지 않은 단계가 2개 이상이면 done 으로 바꾸지 않는다. 그 PR 번호(#N)가 적힌 단계만
//       끝내고 pr 칸을 비운다. 머지 뒤 검증이나 후속 PR 이 남은 항목을 끝난 것으로 보지 않기 위해서다
//     - 단계 줄 판정과 끝내기는 보드 명령에 맡긴다. `steps` 로 단계 목록을 받고 `step <id> <n>` 으로 끝낸다.
//       단계 줄 판정은 이 스크립트에서 하지 않는다. 옛 자동 줄을 지울 때만 완료 값을 CLI 입력 표시로 전달한다
//     - 예전 버전이 남긴 「자동: 」 줄은 지운다
//     - --goal 을 주면 끝에 goal-progress.ts 로 목표 진행률을 다시 센다
//
// 사용법:
//     board-sync.ts [--board PATH] [--repo DIR] [--goal GOAL_ID --goal-items FILE] [--dry-run]
//
//     --board       board.json. 기본은 work-board 의 board.py 가 정한 위치
//     --board-bin   항목을 고치는 명령. 기본은 BOARD_BIN 환경 변수, 없으면 이 저장소의 work-board/bin/board.py
//     --repo        gh 를 돌릴 저장소. 기본은 현재 디렉터리
//     --goal, --goal-items
//                   --goal 을 주면 끝에 goal-progress.ts 로 목표 진행률을 다시 센다.
//                   --goal-items 가 없으면 목표 항목의 단계 줄을 센다
//     --dry-run     보드를 고치지 않고 바뀔 항목과 부를 보드 명령만 낸다. 단계 목록은 읽는다
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts)
//
// GH 환경 변수로 gh 실행 파일을 바꾼다.
//
// 종료 코드: 0 반영했다(또는 --dry-run), 1 보드를 읽지 못했거나 보드 명령이 실패했다, 2 사용법 오류

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { gh } from './lib/gh.ts'
import { boardPath } from './lib/paths.ts'
import { NO_LIMIT_MS, run, scriptCommand } from './lib/proc.ts'
import { pyStr } from './lib/py.ts'

const USAGE = '사용법: board-sync.ts [--board PATH] [--board-bin PATH] [--repo DIR] [--goal GOAL_ID [--goal-items FILE]] [--dry-run]'
const HERE = dirname(fileURLToPath(import.meta.url))
const LEGACY_AUTO = '자동: '
const SKIP_STATUS = new Set(['done', 'goal'])

const OPTIONS = {
  board: { type: 'string' },
  'board-bin': { type: 'string' },
  repo: { type: 'string' },
  goal: { type: 'string' },
  'goal-items': { type: 'string' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

type Detail = string | { text: string; done?: unknown }
type Step = { number: number; done: boolean; text: string }

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(detail: Detail): string {
  return typeof detail === 'string' ? detail : detail.text
}

function prNumber(pr: unknown): string {
  return pyStr(pr || '').split(',')[0].replace(/\D/g, '')
}

// pr 칸의 첫 PR 이 MERGED 인지. 조회에 실패하면 머지되지 않은 것으로 본다.
function prMerged(pr: unknown, repo: string): boolean {
  const num = prNumber(pr)
  if (!num) return false
  const done = gh(['pr', 'view', num, '--json', 'state', '--jq', '.state'], { cwd: repo })
  return done.code === 0 && done.stdout.trim() === 'MERGED'
}

// 보드 명령이 판정한 단계 목록. 읽지 못하면 null.
function boardSteps(boardBin: string, itemId: string, board: string): Step[] | null {
  const done = run(scriptCommand(boardBin, ['steps', itemId, '--file', board]), { timeoutMs: NO_LIMIT_MS })
  if (done.code !== 0) return null
  try {
    const steps: unknown = JSON.parse(done.stdout)
    return Array.isArray(steps) ? (steps as Step[]) : null
  } catch {
    return null
  }
}

// 끝낼 단계 번호 목록과 항목을 끝내는지.
function finishPlan(steps: Step[], pr: unknown): { numbers: number[]; finish: boolean } {
  const left = steps.filter((step) => !step.done)
  if (left.length > 1) {
    const num = prNumber(pr)
    const pattern = num ? new RegExp(`#${num}(?!\\d)`) : null
    return { numbers: left.filter((step) => pattern?.test(step.text)).map((step) => step.number), finish: false }
  }
  return { numbers: left.map((step) => step.number), finish: true }
}

// CLI 입력으로 돌려줄 때 완료 값을 옛 입력 표시로 전달한다.
function detailArgument(line: Detail): string {
  return typeof line === 'string' ? line : (line.done === true ? '✓ ' : '') + line.text
}

function main(argv: string[]): number {
  let parsed
  try {
    parsed = parseArgs({ args: expandArgs(argv, OPTIONS), options: OPTIONS, allowPositionals: false })
  } catch (e) {
    err(`${USAGE}\nboard-sync: ${(e as Error).message}`)
    return 2
  }
  const values = parsed.values
  if (values.help) {
    out(USAGE)
    return 0
  }
  if (values['goal-items'] && !values.goal) {
    err('board-sync: --goal-items 는 --goal 과 함께 준다')
    return 2
  }
  const boardBin = values['board-bin'] || process.env.BOARD_BIN || resolve(HERE, '../../work-board/bin/board.py')
  const board = values.board ? resolve(values.board) : boardPath(process.cwd())
  const repo = resolve(values.repo ?? '.')
  const dryRun = values['dry-run'] === true
  let items: Record<string, unknown>[]
  try {
    const raw = (JSON.parse(readFileSync(board, 'utf8')) as { items?: unknown }).items
    if (raw === undefined) throw new Error("'items'")
    const rows: unknown[] = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : []
    items = rows.filter(isRecord)
  } catch (e) {
    err(`board-sync: 보드를 읽지 못했다: ${board}: ${(e as Error).message}`)
    return 1
  }

  const changed: string[] = []
  for (const item of items) {
    if (SKIP_STATUS.has(String(item.status))) continue
    const id = String(item.id)
    const merged = item.pr ? prMerged(item.pr, repo) : false
    const old = (Array.isArray(item.details) ? item.details : []) as Detail[]
    const kept = old.filter((d) => !textOf(d).startsWith(LEGACY_AUTO))
    if (kept.length === old.length && !merged) continue
    const cmds: string[][] = []
    if (kept.length !== old.length) cmds.push(['set', id, ...(kept.length > 0 ? kept : ['']).flatMap((d) => ['--detail', detailArgument(d)])])
    let finish = false
    if (merged) {
      const steps = boardSteps(boardBin, id, board)
      if (steps === null) {
        err(`board-sync: 단계 목록을 읽지 못했다: ${id}`)
        return 1
      }
      const plan = finishPlan(steps, item.pr)
      finish = plan.finish
      cmds.push(...plan.numbers.map((n) => ['step', id, String(n)]))
      cmds.push(finish ? ['set', id, 'done'] : ['set', id, '--pr', ''])
    }
    changed.push(id)
    if (dryRun) {
      out([id + (finish ? ' -> done' : ''), ...cmds.map((c) => c.join(' '))].join('\n  '))
      continue
    }
    for (const cmd of cmds) {
      const done = run(scriptCommand(boardBin, [...cmd, '--file', board]), { timeoutMs: NO_LIMIT_MS })
      if (done.code !== 0) {
        if (done.stderr) process.stderr.write(done.stderr)
        err(`board-sync: 보드 명령이 실패했다: ${id}`)
        return 1
      }
    }
  }
  if (values.goal && !dryRun) {
    const cmd = [values.goal, '--board', board, '--board-bin', boardBin]
    if (values['goal-items']) cmd.push('--items-file', values['goal-items'], '--details')
    const done = run(scriptCommand(join(HERE, 'goal-progress.ts'), cmd), { timeoutMs: NO_LIMIT_MS })
    if (done.stderr) process.stderr.write(done.stderr)
  }
  out(`board-sync: ${changed.join(', ') || '바뀐 항목 없음'}`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
