// 보드(board.json)에서 PR 이 머지된 항목을 done 으로 바꾸고 목표 진행률을 다시 센다.
//
// 하위 줄은 코디네이터가 쓰는 번호 붙은 단계만 둔다. 이 스크립트는 상태 줄을 쓰지 않는다.
// PR 상태나 커밋 같은 자동 줄은 읽기 어렵고 단계와 섞여 보드를 흐린다(사용자 요청).
//
//     - pr 칸의 PR 이 MERGED 면 업무의 마지막 PR 인지 판정한다(lib/last-pr.ts 의 judgeLastPr, 규칙은 config.json 의 finish 절
//       task_pattern, spec_task_pattern, specs_dir). 마지막이면 남은 단계를 끝내고 항목을 done 으로 바꾼다.
//       중간이면 그 PR 번호(#N)가 적힌 단계만 끝내고 pr 칸을 비우고, 하위 항목에 `남은 일: PR #31 #33, 지시서 spec-b.md` 한 줄을 둔다.
//       그 줄은 단계 줄이 아니라 진행률에 세지 않고, 다음 판정 때 새 줄로 바꾼다
//     - gh 조회가 실패해 판정하지 못하면 그 항목을 고치지 않고 다음 틱에 다시 판정한다
//     - 그 밖의 이유로 판정하지 못하면(task_pattern 이 없다, 제목에 업무 번호가 없다) 단계 수로 정한다. 끝나지 않은 단계가
//       1개 이하면 남은 단계를 끝내고 done 으로 바꾸고, 2개 이상이면 그 PR 번호가 적힌 단계만 끝내고 pr 칸을 비운다.
//       머지 뒤 검증이나 후속 PR 이 남은 항목을 끝난 것으로 보지 않기 위해서다. finish 절이 틀렸으면 stderr 에 한 줄 남기고 단계 수로 정한다
//     - 그 PR 의 마무리(finish-pr)가 돌고 있으면(<orch 작업 폴더>/queue/finish-<PR>.pid 의 프로세스가 살아 있으면) 머지를 반영하지 않는다.
//       마무리가 배포 뒤 판정과 표시(PR!, PR~)로 항목을 고친다. merge-with-finish --finish-log-dir 로 폴더를 바꾸면 보지 못한다
//     - done 으로 바꿀 때는 남은 일 줄을 지운다
//     - 단계 줄 판정과 끝내기는 보드 명령에 맡긴다. `steps` 로 단계 목록을 받고 `step <id> <n>` 으로 끝낸다.
//       단계 줄 판정은 이 스크립트에서 하지 않는다. 옛 자동 줄을 지울 때만 완료 값을 CLI 입력 표시로 전달한다
//     - 예전 버전이 남긴 「자동: 」 줄은 지운다
//     - --goal 을 주면 끝에 goal-progress.ts 로 목표 진행률을 다시 센다
//
// 사용법:
//     board-sync.ts [--board PATH] [--repo DIR] [--goal GOAL_ID --goal-items FILE] [--dry-run]
//
//     --board       board.json. 기본은 work-board 의 board.ts 가 정한 위치
//     --board-bin   항목을 고치는 명령. 기본은 BOARD_BIN 환경 변수, 없으면 이 저장소의 work-board/bin/board.ts
//     --repo        gh 를 돌릴 저장소. 기본은 현재 디렉터리
//     --open-prs    루프가 이미 읽은 열린 PR JSON 목록(number, headRefName). 없으면 직접 조회한다
//     --goal, --goal-items
//                   --goal 을 주면 끝에 goal-progress.ts 로 목표 진행률을 다시 센다.
//                   --goal-items 가 없으면 목표 항목의 단계 줄을 센다
//     --dry-run     보드를 고치지 않고 바뀔 항목과 부를 보드 명령만 낸다. 단계 목록은 읽는다
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts)
//
// done, goal 이 아닌 항목의 pr 칸이 비었으면 worktree 브랜치(없으면 저장한 branch)로 PR 을 연결한다.
// 후속 단계가 남아 비운 머지 PR 은 merged-pr 에 기록해 다시 연결하지 않는다.
// GH 환경 변수로 gh 실행 파일을 바꾼다.
//
// 종료 코드: 0 반영했다(또는 --dry-run), 1 보드를 읽지 못했거나 보드 명령이 실패했다, 2 사용법 오류

import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { ConfigError, loadConfig, section } from './lib/config.ts'
import { FINISH_KEYS } from './lib/finish-options.ts'
import { detailArgs, detailText as textOf, noteLine, prSteps, withNote } from './lib/board.ts'
import type { BoardDetail as Detail } from './lib/board.ts'
import { judgeLastPr, rulesFrom } from './lib/last-pr.ts'
import { pidFileAlive } from './lib/process.ts'
import type { LastPrRules, LastPrVerdict } from './lib/last-pr.ts'
import { worktreePaths } from './lib/workers.ts'
import { gh, ghJson } from './lib/gh.ts'
import { boardPath, pathOf } from './lib/paths.ts'
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
  'open-prs': { type: 'string' },
  goal: { type: 'string' },
  'goal-items': { type: 'string' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

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

// finish 절의 판정 규칙. 설정이 틀리면 알리고 null 이다(단계 수로 정한다)
function lastPrRules(repo: string): LastPrRules | null {
  try {
    return rulesFrom(section<Record<string, unknown>>(loadConfig(repo), 'finish', FINISH_KEYS), repo)
  } catch (e) {
    if (!(e instanceof ConfigError) && !(e instanceof Error)) throw e
    err(`board-sync: 마지막 PR 판정 규칙을 읽지 못해 단계 수로 정한다: ${(e as Error).message}`)
    return null
  }
}

// 머지한 PR 의 제목과 브랜치로 마지막 PR 인지 판정한다. 규칙(task_pattern)이 없으면 null 이다. PR 을 읽지 못하면 retry 다
function judge(repo: string, num: string, rules: LastPrRules | null): LastPrVerdict | null {
  if (!rules?.taskPattern) return null
  const got = ghJson<{ title?: unknown; headRefName?: unknown }>(['pr', 'view', num, '--json', 'title,headRefName'], { cwd: repo })
  if (!got.ok || typeof got.data !== 'object' || got.data === null) {
    return { last: null, retry: true, number: null, prs: [], specs: [], reason: `PR ${num} 의 제목과 브랜치를 읽지 못했다` }
  }
  const title = typeof got.data.title === 'string' ? got.data.title : ''
  const branch = typeof got.data.headRefName === 'string' ? got.data.headRefName : ''
  return judgeLastPr(repo, { number: num, title, branch }, rules)
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
  const boardBin = values['board-bin'] || process.env.BOARD_BIN || resolve(HERE, '../../work-board/bin/board.ts')
  const board = values.board ? resolve(values.board) : boardPath(resolve(values.repo ?? '.'))
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

  type Pr = { number: number; headRefName: string; state?: string }
  let open: Pr[] | null = null
  if (values['open-prs']) {
    try {
      open = JSON.parse(values['open-prs'])
      if (!Array.isArray(open)) throw new Error('목록이 아니다')
    } catch (e) {
      err(`board-sync: --open-prs: ${(e as Error).message}`)
      return 2
    }
  }
  const branches = new Map([...worktreePaths(repo)].map(([branch, path]) => [basename(path), branch]))
  let rules: LastPrRules | null | undefined
  const changed: string[] = []
  for (const item of items) {
    if (SKIP_STATUS.has(String(item.status))) continue
    const id = String(item.id)
    const cmds: string[][] = []
    let discovered: Pr | undefined
    const branch = branches.get(String(item.worktree)) || String(item.branch || '')
    if (!item.pr && branch) {
      if (open === null) {
        const got = ghJson<Pr[]>(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefName'], { cwd: repo })
        open = got.ok && Array.isArray(got.data) ? got.data : []
      }
      discovered = open.find((pr) => pr.headRefName === branch)
      if (!discovered) {
        const got = ghJson<Pr[]>(['pr', 'list', '--state', 'merged', '--head', branch, '--limit', '100', '--json', 'number,headRefName,state'], { cwd: repo })
        if (got.ok && Array.isArray(got.data)) discovered = got.data.find((pr) => pr.headRefName === branch && pr.state === 'MERGED')
      }
      if (discovered?.state === 'MERGED' && String(discovered.number) === prNumber(item['merged-pr'])) discovered = undefined
      if (discovered) {
        item.pr = String(discovered.number)
        cmds.push(['set', id, '--pr', String(item.pr), '--branch', branch])
      }
    }
    const merged = discovered?.state === 'MERGED' || (item.pr ? prMerged(item.pr, repo) : false)
    const old = (Array.isArray(item.details) ? item.details : []) as Detail[]
    let details = old.filter((d) => !textOf(d).startsWith(LEGACY_AUTO))
    let finish = false
    const after: string[][] = []
    const num = prNumber(item.pr)
    if (merged && pidFileAlive(join(pathOf('queue', repo), `finish-${num}.pid`))) {
      // 마무리가 배포를 확인한 뒤 판정과 표시(PR!, PR~)로 이 항목을 고친다. 여기서 먼저 고치면 그 표시를 덮는다
      out(`board-sync: ${id} 는 PR ${num} 의 마무리(finish-pr)가 돌고 있어 그쪽에 맡긴다`)
    } else if (merged) {
      const steps = boardSteps(boardBin, id, board)
      if (steps === null) {
        err(`board-sync: 단계 목록을 읽지 못했다: ${id}`)
        return 1
      }
      if (rules === undefined) rules = lastPrRules(repo)
      const verdict = judge(repo, num, rules)
      const label = verdict === null || verdict.last === null ? (verdict?.retry ? '다음 틱에 다시 판정' : '단계 수로 정함') : verdict.last ? '마지막' : '중간'
      if (verdict) out(`board-sync: ${id} 마지막 PR 판정: ${label}(${verdict.reason})`)
      if (!verdict?.retry) {
        const last = verdict?.last ?? (steps.filter((step) => !step.done).length <= 1)
        if (last) {
          finish = true
          details = withNote(details, null)
          after.push(...steps.filter((step) => !step.done).map((step) => ['step', id, String(step.number)]), ['set', id, 'done'])
        } else {
          const note = verdict?.last === false ? noteLine(verdict.prs, verdict.specs) : null
          details = withNote(details, note)
          // lib/board.ts 의 intermediateCommands 와 같은 순서다. 하위 항목은 위에서 한 번에 다시 쓴다
          after.push(...prSteps(steps, num).map((n) => ['step', id, String(n)]), ['set', id, '--pr', '', '--merged-pr', num])
        }
      }
    }
    const rewrite = details.length !== old.length || details.some((d, i) => d !== old[i])
    if (rewrite) cmds.push(['set', id, ...detailArgs(details)])
    cmds.push(...after)
    if (cmds.length === 0) continue
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
