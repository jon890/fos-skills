import { boardWorkerRows, rowsReviewPr } from '../core/board-workers.ts'
// --worker-ends 는 루프 내부용이다. 끝난 worker 의 dispatch 와 done|lost 객체를 받아 작업 중 줄을 끝낸다.
// 구현·후속 줄이 있는 항목은 리뷰 항목이 아니다. 리뷰·검증 줄만 있으면 그 줄의 worker_done 으로도 닫는다.
// 보드(board.json)에서 PR 이 머지된 항목을 done 으로 바꾸고 목표 진행률을 다시 센다.
//
// 하위 줄은 코디네이터가 쓰는 번호 붙은 단계만 둔다. 이 스크립트는 상태 줄을 쓰지 않는다.
// PR 상태나 커밋 같은 자동 줄은 읽기 어렵고 단계와 섞여 보드를 흐린다(사용자 요청).
//
//     - pr 칸의 PR 이 MERGED 면 업무의 마지막 PR 인지 판정한다(lib/last-pr.ts 의 judgeLastPr, 규칙은 config.json 의 finish 절
//       task_pattern, spec_task_pattern, specs_dir). 마지막이어도 그 PR 번호의 단계만 끝내고, 남은 단계가 없을 때만 done 으로 바꾼다.
//       중간이면 그 PR 번호(#N)가 적힌 단계만 끝내고 pr 칸을 비우고, 하위 항목에 `남은 일: PR #31 #33, 지시서 spec-b.md` 한 줄을 둔다.
//       그 줄은 단계 줄이 아니라 진행률에 세지 않고, 다음 판정 때 새 줄로 바꾼다
//     - gh 조회가 실패해 판정하지 못하면 그 항목을 고치지 않고 다음 틱에 다시 판정한다
//     - 그 밖의 이유로 판정하지 못하면(task_pattern 이 없다, 제목에 업무 번호가 없다) 그 PR 번호의 단계만 끝낸다.
//       남은 단계가 있으면 pr 칸을 비우고 merged-pr 에 적는다.
//       머지 뒤 검증이나 후속 PR 이 남은 항목을 끝난 것으로 보지 않기 위해서다. finish 절이 틀렸으면 stderr 에 한 줄 남기고 PR 번호의 단계만 끝낸다
//     - 그 PR 의 마무리(finish-pr)가 돌고 있으면(<orch 작업 폴더>/queue/finish-<PR>.pid 의 프로세스가 살아 있으면) 머지를 반영하지 않는다.
//       마무리가 배포 뒤 판정과 표시(PR!, PR~)로 항목을 고친다. merge-with-finish --finish-log-dir 로 폴더를 바꾸면 보지 못한다
//     - done 으로 바꿀 때는 남은 일 줄을 지운다
//     - 단계를 모두 끝낸 doing 항목: 마일스톤 항목이 아니고, 열린 PR 이 없고(pr 칸이 비었거나 CLOSED), worktree 칸의 워크트리와
//       branch 칸의 브랜치 워크트리가 git 목록에 없고, 남은 일 줄이 없고, 단계(steps)가 하나 이상이며 모두 끝났으면 done 으로 바꾼다.
//       머지 뒤 남은 단계를 코디네이터가 직접 끝낸 항목이 doing 으로 남아 사용자가 물었다(2026-11-03). 워크트리 목록을 읽지 못하면
//       worktree 칸이 빈 항목만 본다. 살아 있는 worker 는 워크트리가 있으므로 워크트리로 가린다
//     - 단계 줄 판정과 끝내기는 보드 명령에 맡긴다. `steps` 로 단계 목록을 받고 `step <id> <n>` 으로 끝낸다.
//       단계 줄 판정은 이 스크립트에서 하지 않는다. 옛 자동 줄을 지울 때만 완료 값을 CLI 입력 표시로 전달한다
//     - 예전 버전이 남긴 「자동: 」 줄은 지운다
//     - --goal 을 주면 끝에 goal-progress.ts 로 목표 진행률을 다시 센다
//
// 마일스톤 항목(stages 칸이 있는 항목, lib/milestones.ts, ADR-018)은 위 규칙 대신 사건으로 단계를 끝낸다:
//     - pr 칸의 PR 이 열려 있으면 [pr] 단계를 끝낸다
//     - 머지됐으면 위와 같이 마지막 PR 인지 판정하고 lib/milestones.ts 의 mergedCommands 로 [pr], [merge] 단계를 끝낸다.
//       판정하지 못하면(gh 조회 실패는 빼고) 마지막 PR 로 본다. 마일스톤 항목은 마지막 PR 이어도 done 지점 전이면 doing 으로 남아
//       잘못 본 값이 업무 완료로 번지지 않는다. 마지막 PR 은 pr 칸에 두고 merged-pr 에도 적어 다음 틱에 다시 판정하지 않는다.
//       중간 PR 은 pr 칸을 비우고 merged-pr 에 쌓고 남은 일 줄을 둔다
//     - 항목에 끝나지 않은 [deploy] 단계가 있고 config.json 에 finish.deploy_workflow 와 deploy_branch 가 있으면, 머지 커밋이 든 배포 실행이
//       성공했는지 틱마다 한 번 본다(lib/deploy.ts). 성공이면 [deploy] 단계까지 끝낸다. 배포 실행 목록은 틱마다 한 번만 읽는다
//     - 마지막 PR 이 done 지점(board.done_after, 기본 merge)에 닿으면 done 으로 바꾸고 worktree 칸을 비운다
//     - [release] 단계는 이 스크립트가 끝내지 않는다. board-release.ts 가 끝낸다
//     - config.json 의 board 절이 틀리면 stderr 에 한 줄 남기고 마일스톤 항목의 머지 반영을 건너뛴다
//
// 수동 사건 단계: 줄 끝의 (#PR번호 pr|merge|deploy|release) 를 board.ts 와 같은 파서로 읽는다.
//     꼬리표가 있는 항목은 goal 도 사건별 단계만 끝내고 항목 상태와 꼬리표 없는 줄은 그대로 둔다.
//     release 는 board-release.ts 에 맡긴다.
//
// 갱신 필요: 끝나지 않은 단계의 글에 이미 머지된 PR 번호(#N)가 있고 이 틱이 그 단계를 끝내지 않으면, 항목 id, 단계 번호, PR 번호를 알린다.
//     자동으로 끝내지 않는다. 일이 끝났는지는 사람이 정한다. stages 가 가리키는 단계, 사건 꼬리표나 자동 진행 표시가 있는 단계,
//     머지 반영을 미룬 항목(기능 검증, 마무리 진행, 다시 판정)과 done 항목은 알리지 않는다. 짧은 출력은 `BOARD <id> update-needed <단계> PR #<번호>` 다.
//     같은 항목·단계·PR·글은 한 번만 알린다(lib/board-stale.ts 의 기록). 해결돼 목록에서 빠졌다가 다시 생기거나 단계 글이 바뀌면 다시 알린다
//
// 모든 항목(done, goal 포함)의 worktree 칸이 git 워크트리 목록에 없는 이름이면 칸을 비운다. 끝난 worker 의 워크트리를 정리한 뒤
// 창이 「worker 없음」 을 보이지 않게 한다. 워크트리 목록을 읽지 못하면 비우지 않는다
//
// 사용법:
//     board-sync.ts [--board PATH] [--repo DIR] [--goal GOAL_ID --goal-items FILE] [--dry-run]
//
//     --board       board.json. 기본은 work-board 의 board.ts 가 정한 위치
//     --board-bin   항목을 고치는 명령. 기본은 BOARD_BIN 환경 변수, 없으면 이 저장소의 extensions/work-board/bin/board.ts
//     --repo        gh 를 돌릴 저장소. 기본은 현재 디렉터리
//     PR 을 처음 연결할 때 finish.task_pattern 으로 읽은 업무 번호도 빈 task-ref 에 넣는다.
//     --open-prs    루프가 이미 읽은 열린 PR JSON 목록(number, headRefName, title). 없으면 직접 조회한다
//     --completed-items 루프 내부용. worker_done 을 받은 dispatch 가 맡은 리뷰·검증 보드 항목 id JSON 목록. 그 항목만 끝낸다.
//     --completed-reviews 루프 내부용. 지시서에 보드 항목 id 가 없는 dispatch 의 worker_done 을 받은 리뷰 PR 번호 JSON 목록. id 가 정확히 review-pr-N 인 항목만 끝낸다.
//                   리뷰·검증 항목(그 id 의 가장 최근 지시서에 `리뷰 PR: #N` 이 있거나, 지시서를 못 읽으면 id 가 review-pr-N, verify-pr-N 꼴, 뒤에 -r2 같은 꼬리가 붙어도 된다)은 worker_done 을 받았거나 대상 PR 이 MERGED 면 남은 단계를 끝내고 done 으로 바꾼다.
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
// 짧은 출력(진입점의 orch board sync, lib/output.ts): 바꾼 항목마다 `BOARD <id> done|updated`(dry-run 은 would-done, would-update), 끝 줄 `BOARD-SYNC <바뀐 항목 수>` 다.
// 종료 코드: 0 반영했다(또는 --dry-run), 1 보드를 읽지 못했거나 보드 명령이 실패했다, 2 사용법 오류

import { reviewPrOfItem, reviewPrsByItem, reviewOriginsByItem, isReviewItem } from '../lib/review.ts'
import { loadNotified, saveNotified, staleKey, textRev } from '../lib/board-stale.ts'
import { prTaskRef } from '../lib/board.ts'
import { recordUnmatched, unmatchedRecords, pruneUnmatched } from '../lib/board-unmatched.ts'
import { readBoard } from '../lib/board.ts'
import type { BoardStep } from '../core/board.ts'
import { featureCompletionProblem } from '../lib/feature-evidence.ts'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { ConfigError, loadConfig, section } from '../lib/config.ts'
import { FINISH_KEYS } from '../lib/finish-options.ts'
import { taggedBoardSteps, boardSteps, detailArgs, detailText as textOf, NOTE, noteLine, prNumbers, prSteps, withNote, BOARD_BIN, guardedCommands, linesRev, staleBoardWrite } from '../lib/board.ts'
import type { BoardDetail as Detail } from '../lib/board.ts'
import { deployVerdict, parseRuns } from '../lib/deploy.ts'
import type { DeployVerdict, RunRow } from '../lib/deploy.ts'
import { git } from '../lib/git.ts'
import { judgeLastPr, rulesFrom } from '../lib/last-pr.ts'
import { advanceCommands, boardSettings, mergedCommands, stagesOf } from '../lib/milestones.ts'
import type { BoardSettings } from '../lib/milestones.ts'
import { pidFileAlive } from '../lib/process.ts'
import type { LastPrRules, LastPrVerdict } from '../lib/last-pr.ts'
import { worktreePaths } from '../lib/workers.ts'
import { gh, ghJson } from '../lib/gh.ts'
import { boardPath } from '../lib/board-file.ts'
import { pathOf } from '../lib/paths.ts'
import { run, scriptCommand } from '../lib/proc.ts'
import { pyStr } from '../lib/py.ts'
import { waitTimeMs } from '../core/step-ready.ts'
import { withoutEvidence } from '../core/evidence.ts'
import { parseStepMark } from '../../../../extensions/work-board/hooks/step-marks.js'
import { stageTag, parseEventTag } from '../../../../extensions/work-board/hooks/event-tags.js'
import { emit, short } from '../lib/output.ts'
import { scriptPath } from '../lib/commands.ts'

const USAGE = '사용법: board-sync.ts [--board PATH] [--board-bin PATH] [--repo DIR] [--goal GOAL_ID [--goal-items FILE]] [--dry-run]'
const LEGACY_AUTO = '자동: '
const SKIP_STATUS = new Set(['done', 'goal'])

const OPTIONS = {
  'worker-ends': { type: 'string' },
  board: { type: 'string' },
  'board-bin': { type: 'string' },
  repo: { type: 'string' },
  'open-prs': { type: 'string' },
  'completed-reviews': { type: 'string' },
  'completed-items': { type: 'string' },
  goal: { type: 'string' },
  'goal-items': { type: 'string' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

// 짧은 출력(진입점의 orch board sync)은 아래 brief 줄만 낸다. `board-sync: …` 설명 줄은 판정 줄이 아니라 버린다
function out(line: string): void {
  emit(line)
}

function brief(line: string): void {
  if (short()) process.stdout.write(`${line}\n`)
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

// pr 칸의 첫 PR 의 상태(OPEN, MERGED, CLOSED). 조회에 실패하면 null 이다
function prState(pr: unknown, repo: string): string | null {
  const num = prNumber(pr)
  if (!num) return null
  const done = gh(['pr', 'view', num, '--json', 'state', '--jq', '.state'], { cwd: repo, killSignal: 'SIGKILL' })
  return done.code === 0 ? done.stdout.trim() : null
}

// git 워크트리 폴더 이름들. 목록을 읽지 못하면 null 이다
function worktreeNames(repo: string): Set<string> | null {
  const done = git(repo, ['worktree', 'list', '--porcelain'])
  if (done.code !== 0) return null
  return new Set(done.stdout.split('\n').flatMap((line) => (line.startsWith('worktree ') ? [basename(line.slice('worktree '.length))] : [])))
}

// 머지 커밋이 배포됐는지(lib/deploy.ts). 배포 실행 목록은 한 번만 읽어 runs 에 둔다. 머지 커밋을 읽지 못하면 wait 이다
function deployedNow(repo: string, num: string, deploy: { workflow: string; branch: string }, cache: { runs: RunRow[] | null }): DeployVerdict {
  const merge = gh(['pr', 'view', num, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid'], { cwd: repo, killSignal: 'SIGKILL' })
  const oid = merge.code === 0 ? merge.stdout.trim() : ''
  if (!/^[0-9a-f]{7,64}$/.test(oid)) return 'wait'
  if (cache.runs === null) {
    git(repo, ['fetch', '-q', 'origin', deploy.branch])
    const runs = gh(['run', 'list', '--branch', deploy.branch, '--workflow', deploy.workflow, '--limit', '15', '--json', 'headSha,status,conclusion'], { cwd: repo })
    cache.runs = runs.code === 0 ? parseRuns(runs.stdout) : []
  }
  return deployVerdict(cache.runs, oid, (ancestor, sha) => git(repo, ['merge-base', '--is-ancestor', ancestor, sha]).code === 0).verdict
}

// finish 절의 판정 규칙. 설정이 틀리면 알리고 null 이다(PR 번호의 단계만 끝낸다)
function lastPrRules(repo: string): LastPrRules | null {
  try {
    return rulesFrom(section<Record<string, unknown>>(loadConfig(repo), 'finish', FINISH_KEYS), repo)
  } catch (e) {
    if (!(e instanceof ConfigError) && !(e instanceof Error)) throw e
    err(`board-sync: 마지막 PR 판정 규칙을 읽지 못해 PR 번호의 단계만 끝낸다: ${(e as Error).message}`)
    return null
  }
}

// 머지한 PR 의 제목과 브랜치로 마지막 PR 인지 판정한다. 규칙(task_pattern)이 없으면 null 이다. PR 을 읽지 못하면 retry 다
function judge(repo: string, num: string, rules: LastPrRules | null): LastPrVerdict | null {
  if (!rules?.taskPattern) return null
  const got = ghJson<{ title?: unknown; headRefName?: unknown }>(['pr', 'view', num, '--json', 'title,headRefName'], { cwd: repo, killSignal: 'SIGKILL' })
  if (!got.ok || typeof got.data !== 'object' || got.data === null) {
    return { last: null, retry: true, number: null, prs: [], specs: [], reason: `PR ${num} 의 제목과 브랜치를 읽지 못했다` }
  }
  const title = typeof got.data.title === 'string' ? got.data.title : ''
  const branch = typeof got.data.headRefName === 'string' ? got.data.headRefName : ''
  return judgeLastPr(repo, { number: num, title, branch }, rules)
}

// 끝나지 않았는데 머지된 PR 번호(#N)를 가리키는 단계. 이 틱의 명령이 끝낼 단계, stages 가 가리키는 사건 단계,
// 사건 꼬리표나 자동 진행 표시가 있는 단계는 따로 끝나므로 뺀다. 단계 목록을 읽지 못하면 null 이다
function staleSteps(
  item: Record<string, unknown>, id: string, commands: string[][], boardBin: string, board: string,
  stateFor: (pr: unknown) => string | null,
): { number: number; pr: string; text: string }[] | null {
  if (!/#\d/.test(JSON.stringify([item.details, item.next]))) return []
  const steps = boardSteps(boardBin, id, board)
  if (steps === null) return null
  const scheduled = new Set(commands.filter((cmd) => cmd[0] === 'step' && cmd[1] === id).map((cmd) => Number(cmd[2])))
  const events = Object.values(stagesOf(item) ?? {})
  const known = prNumbers(item['merged-pr'])
  const found: { number: number; pr: string; text: string }[] = []
  for (const step of steps) {
    if (step.done || scheduled.has(step.number) || events.includes(step.number)) continue
    if (stageTag(step.text) !== null || parseEventTag(step.text) || parseStepMark(step.text)?.mark) continue
    const pr = [...new Set([...withoutEvidence(step.text).matchAll(/#([1-9]\d*)(?!\d)/g)].map((m) => m[1]))]
      .find((num) => known.has(num) || stateFor(num) === 'MERGED')
    if (pr) found.push({ number: step.number, pr, text: step.text })
  }
  return found
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
  const boardBin = values['board-bin'] || process.env.BOARD_BIN || BOARD_BIN
  let board: string
  try {
    board = values.board ? resolve(values.board) : boardPath(resolve(values.repo ?? '.'))
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    err(`board-sync: ${e.message.replace(/\s+/g, ' ')}`)
    return 2
  }
  const repo = resolve(values.repo ?? '.')
  const dryRun = values['dry-run'] === true
  let workerEnds: Record<string, 'done' | 'lost'>
  try {
    const parsed: unknown = JSON.parse(values['worker-ends'] ?? '{}')
    if (!isRecord(parsed) || !Object.values(parsed).every((value) => value === 'done' || value === 'lost')) throw new Error('dispatch 와 done|lost 객체가 아니다')
    workerEnds = parsed as Record<string, 'done' | 'lost'>
  } catch (e) {
    err(`board-sync: --worker-ends: ${(e as Error).message}`)
    return 2
  }
  let completedReviews: number[] = []
  try {
    const parsed: unknown = JSON.parse(values['completed-reviews'] ?? '[]')
    if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n > 0)) throw new Error('PR 번호 목록이 아니다')
    completedReviews = parsed
  } catch (e) {
    err(`board-sync: --completed-reviews: ${(e as Error).message}`)
    return 2
  }
  let completedItems: string[] = []
  try {
    const parsed: unknown = JSON.parse(values['completed-items'] ?? '[]')
    if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string')) throw new Error('항목 id 목록이 아니다')
    completedItems = parsed
  } catch (e) {
    err(`board-sync: --completed-items: ${(e as Error).message}`)
    return 2
  }
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

  type Pr = { title?: string; number: number; headRefName: string; state?: string }
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
  const reviewOrigins = reviewOriginsByItem(repo, items)
  const branches = new Map([...worktreePaths(repo)].map(([branch, path]) => [basename(path), branch]))
  const names = worktreeNames(repo)
  const liveBranches = new Set(branches.values())
  let rules: LastPrRules | null | undefined
  let reviewItems: Map<string, number | null> | undefined
  let settings: BoardSettings | null | undefined
  const runs: { runs: RunRow[] | null } = { runs: null }
  const deployments = new Map<string, DeployVerdict>()
  const deploymentFor = (num: string, deploy: { workflow: string; branch: string }): DeployVerdict => {
    if (!deployments.has(num)) deployments.set(num, deployedNow(repo, num, deploy, runs))
    return deployments.get(num)!
  }
  const tagStates = new Map<string, string | null>()
  const stateFor = (pr: unknown): string | null => {
    const num = prNumber(pr)
    if (!num) return null
    if (!tagStates.has(num)) tagStates.set(num, prState(num, repo))
    return tagStates.get(num) ?? null
  }
  const changed: string[] = []
  const notified = loadNotified(repo)
  let notifiedChanged = false
  const now = Date.now()
  itemsLoop:
  for (const item of items) {
    const id = String(item.id)
    const cmds: string[][] = []
    const after: string[][] = []
    let finish = false
    // 이번 틱에 머지 반영을 미룬 항목(기능 검증, 마무리 진행, 다시 판정)은 끝나지 않은 단계를 갱신 필요로 알리지 않는다
    let hold = false
    let reflected: { pr: string; steps: BoardStep[] } | null = null
    // 끝난 worker 의 워크트리가 정리됐으면 칸을 비운다. done 과 goal 항목도 본다
    const workerRows = boardWorkerRows(item)
    const missing = new Set<string>()
    for (const row of workerRows.filter((row) => row.status === 'working')) {
      const end = row.dispatch && Object.hasOwn(workerEnds, row.dispatch) ? workerEnds[row.dispatch] : null
      if (end) cmds.push(['worker-end', id, end, '--dispatch', row.dispatch!])
      else if (names !== null && !names.has(row.worktree) && !missing.has(row.worktree)) {
        missing.add(row.worktree)
        cmds.push(['worker-end', id, 'lost', '--worktree', row.worktree, '--clear'])
      }
    }
    if (names !== null && typeof item.worktree === 'string' && item.worktree && !names.has(item.worktree) && !workerRows.some((row) => row.status === 'working' && row.worktree === item.worktree)) cmds.push(['set', id, '--worktree', ''])
    const old = (Array.isArray(item.details) ? item.details : []) as Detail[]
    let details = old
    const tagged = item.status === 'done' ? [] : taggedBoardSteps(boardBin, id, board, item)
    if (tagged === null) {
      err(`board-sync: 단계 목록을 읽지 못했다: ${id}`)
      return 1
    }
    // 시각 대기는 첫 미완료 여부와 무관하게 그 줄만 끝낸다. 상태는 바꾸지 않는다.
    if (item.status !== 'done' && JSON.stringify([item.details, item.next]).includes('[wait:')) {
      const steps = boardSteps(boardBin, id, board)
      if (steps === null) { err(`board-sync: 단계 목록을 읽지 못했다: ${id}`); return 1 }
      const events = Object.values(stagesOf(item) ?? {})
      for (const step of steps) {
        if (step.done || events.includes(step.number) || stageTag(step.text) !== null) continue
        const mark = parseStepMark(step.text)
        const at = mark?.mark === 'wait' ? waitTimeMs(mark.condition) : null
        if (at !== null && at <= now) after.push(['step', id, String(step.number)])
      }
    }
    reviewItems ??= reviewPrsByItem(repo)
    const reviewOnly = isReviewItem(item, reviewOrigins)
    const target = reviewOnly ? rowsReviewPr(item) ?? reviewPrOfItem(id, reviewItems) : null
    const review = target === null ? null : [id, String(target)]
    const endedNow = cmds.some((cmd) => cmd[0] === 'worker-end')
    const endedAfterChange = typeof item.stepAt === 'string' && workerRows.some((row) =>
      typeof row.endedAt === 'string' && Date.parse(row.endedAt) > Date.parse(String(item.stepAt)))
    const rowsDone = reviewOnly && workerRows.length > 0 && (endedNow || endedAfterChange) &&
      !workerRows.some((row) => row.status === 'working' && !(row.dispatch && Object.hasOwn(workerEnds, row.dispatch)) && !(names !== null && !names.has(row.worktree)))
    const reviewDone = !SKIP_STATUS.has(String(item.status)) && (rowsDone || (review &&
      ((!Array.isArray(item.workers) && (completedItems.includes(id) || (/^review-pr-\d+$/.test(id) && completedReviews.includes(target!)))) || stateFor(review[1]) === 'MERGED')))
    if (reviewDone) {
      const steps = boardSteps(boardBin, id, board)
      if (steps === null) { err(`board-sync: 단계 목록을 읽지 못했다: ${id}`); return 1 }
      after.push(...steps.filter((step) => !step.done).map((step) => ['step', id, String(step.number)]), ['set', id, 'done', '--worktree', ''])
      finish = true
    } else if (review) {
      // 리뷰 브랜치에는 구현 PR 을 연결하지 않는다. 리뷰 완료 보고나 대상 PR 머지로만 끝낸다.
    } else if (tagged.length > 0) {
      // 꼬리표가 있는 수동 항목과 goal 은 사건별로만 끝낸다. 다른 단계나 항목 상태는 바꾸지 않는다.
      for (const step of tagged.filter((step) => !step.done)) {
        const tag = parseEventTag(step.text)!
        if (tag.event === 'release') continue
        const state = stateFor(tag.pr)
        if (state === 'MERGED' && featureCompletionProblem(repo, tag.pr, String(item.branch || ''))) continue
        let reached = tag.event === 'pr' ? state === 'OPEN' || state === 'MERGED' : tag.event === 'merge' && state === 'MERGED'
        if (tag.event === 'deploy' && state === 'MERGED') {
          if (settings === undefined) {
            try { settings = boardSettings(repo) }
            catch (e) {
              err(`board-sync: 보드 설정을 읽지 못해 배포 반영을 건너뛴다: ${(e as Error).message}`)
              settings = null
            }
          }
          reached = Boolean(settings?.deploy && deploymentFor(tag.pr, settings.deploy) === 'success')
        }
        if (reached) after.push(['step', id, String(step.number)])
      }
    } else if (!SKIP_STATUS.has(String(item.status))) {
      let discovered: Pr | undefined
      const branch = branches.get(String(item.worktree)) || String(item.branch || '')
      if (!item.pr && branch) {
        if (open === null) {
          const got = ghJson<Pr[]>(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefName,title'], { cwd: repo })
          open = got.ok && Array.isArray(got.data) ? got.data : []
        }
        discovered = open.find((pr) => pr.headRefName === branch)
        if (!discovered) {
          const got = ghJson<Pr[]>(['pr', 'list', '--state', 'merged', '--head', branch, '--limit', '100', '--json', 'number,headRefName,state,title'], { cwd: repo })
          if (got.ok && Array.isArray(got.data)) discovered = got.data.find((pr) => pr.headRefName === branch && pr.state === 'MERGED')
          // 그 브랜치의 가장 최근 머지가 merged-pr 에 들었으면 이미 반영한 머지라 다시 연결하지 않는다. 더 옛 머지도 보지 않는다
          if (discovered && prNumbers(item['merged-pr']).has(String(discovered.number))) discovered = undefined
        }
        if (discovered) {
          item.pr = String(discovered.number)
          const ref = prTaskRef(repo, discovered.title ?? '')
          cmds.push(['set', id, '--pr', String(item.pr), '--branch', branch, ...(ref ? ['--fill', `--task-ref=${ref}`] : [])])
        }
      }
      const state = discovered ? (discovered.state ?? 'OPEN') : stateFor(item.pr)
      const merged = state === 'MERGED'
      details = old.filter((d) => !textOf(d).startsWith(LEGACY_AUTO))
      const num = prNumber(item.pr)
      const stages = stagesOf(item)
      const pendingFeature = merged && num ? featureCompletionProblem(repo, num, branch) : null
      if (pendingFeature) {
        hold = true
        out(`board-sync: ${id} 는 기능 검증이 남았다: ${pendingFeature}`)
        brief(`BOARD ${id} pending-feature ${pendingFeature}`)
      } else if (merged && pidFileAlive(join(pathOf('queue', repo), `finish-${num}.pid`))) {
        // 마무리가 배포를 확인한 뒤 판정과 표시(PR!, PR~)로 이 항목을 고친다. 여기서 먼저 고치면 그 표시를 덮는다
        hold = true
        out(`board-sync: ${id} 는 PR ${num} 의 마무리(finish-pr)가 돌고 있어 그쪽에 맡긴다`)
        brief(`BOARD ${id} finishing PR ${num}`)
      } else if (stages && (state === 'OPEN' || merged)) {
        const steps = boardSteps(boardBin, id, board)
        if (steps === null) {
          err(`board-sync: 단계 목록을 읽지 못했다: ${id}`)
          return 1
        }
        if (settings === undefined) {
          try {
            settings = boardSettings(repo)
          } catch (e) {
            err(`board-sync: 보드 설정을 읽지 못해 마일스톤 항목의 머지 반영을 건너뛴다: ${(e as Error).message}`)
            settings = null
          }
        }
        const doneAfter = settings?.doneAfter ?? null
        const deploy = settings?.deploy ?? null
        // 끝나지 않은 [deploy] 단계가 있고 배포 설정이 있을 때만 배포를 본다
        const deployPending = () => deploy !== null && stages.deploy !== undefined && steps.some((step) => step.number === stages.deploy && !step.done)
        if (state === 'OPEN') {
          after.push(...advanceCommands(id, steps, stages, 'pr', { last: false, doneAfter }).cmds)
        } else if (settings !== null && prNumbers(item['merged-pr']).has(num)) {
          // 이미 반영한 마지막 PR 이다. 배포만 기다린다
          if (deployPending() && deploymentFor(num, deploy as { workflow: string; branch: string }) === 'success') {
            const got = advanceCommands(id, steps, stages, 'deploy', { last: true, doneAfter })
            after.push(...got.cmds)
            finish = got.done
          }
        } else if (settings !== null) {
          if (rules === undefined) rules = lastPrRules(repo)
          const verdict = judge(repo, num, rules)
          const label = verdict === null || verdict.last === null ? (verdict?.retry ? '다음 틱에 다시 판정' : '마지막으로 봄') : verdict.last ? '마지막' : '중간'
          if (verdict) out(`board-sync: ${id} 마지막 PR 판정: ${label}(${verdict.reason})`)
          if (verdict?.retry) hold = true
          if (!verdict?.retry) {
            const last = verdict?.last ?? true
            const reached = deployPending() && deploymentFor(num, deploy as { workflow: string; branch: string }) === 'success' ? 'deploy' : 'merge'
            const note = verdict?.last === false ? noteLine(verdict.prs, verdict.specs) : null
            const got = mergedCommands({ ...item, details }, steps, stages, num, reached, { last, doneAfter, note })
            after.push(...got.cmds)
            finish = got.done
            reflected = { pr: num, steps }
          }
        }
      } else if (merged && !stages) {
        const steps = boardSteps(boardBin, id, board)
        if (steps === null) {
          err(`board-sync: 단계 목록을 읽지 못했다: ${id}`)
          return 1
        }
        if (rules === undefined) rules = lastPrRules(repo)
        const verdict = judge(repo, num, rules)
        const label = verdict === null || verdict.last === null ? (verdict?.retry ? '다음 틱에 다시 판정' : 'PR 번호의 단계만 끝냄') : verdict.last ? '마지막' : '중간'
        if (verdict) out(`board-sync: ${id} 마지막 PR 판정: ${label}(${verdict.reason})`)
        if (verdict?.retry) hold = true
        if (!verdict?.retry) {
          const last = verdict?.last !== false
          const matched = prSteps(steps, num)
          finish = last && steps.every((step) => step.done || matched.includes(step.number))
          const note = verdict?.last === false ? noteLine(verdict.prs, verdict.specs) : null
          details = withNote(details, note)
          after.push(...matched.map((n) => ['step', id, String(n)]))
          if (finish) after.push(['set', id, 'done', '--worktree', ''])
          else {
            const mergedPrs = [...new Set([...prNumbers(item['merged-pr']), num])].join(', ')
            after.push(['set', id, 'doing', '--pr', '', '--merged-pr', mergedPrs])
          }
          reflected = { pr: num, steps }
        }
      } else if (item.status === 'doing' && !stages && state !== 'OPEN' && (!num || state === 'CLOSED')) {
        // 머리 주석의 「단계를 모두 끝낸 doing 항목」
        const worktree = typeof item.worktree === 'string' ? item.worktree : ''
        const working = (worktree !== '' && (names === null || names.has(worktree))) || (branch !== '' && liveBranches.has(branch))
        if (!working && !details.some((d) => textOf(d).startsWith(NOTE))) {
          const steps = boardSteps(boardBin, id, board)
          if (steps === null) {
            err(`board-sync: 단계 목록을 읽지 못했다: ${id}`)
            return 1
          }
          if (steps.length > 0 && steps.every((one) => one.done)) {
            finish = true
            out(`board-sync: ${id} 는 단계를 모두 끝냈고 열린 PR, 워크트리, 남은 일 줄이 없어 done 으로 바꾼다`)
            after.push(['set', id, 'done', '--worktree', ''])
          }
        }
      }
    }
    if (!hold && !finish && !review && item.status !== 'done') {
      const stale = staleSteps(item, id, [...cmds, ...after], boardBin, board, stateFor)
      if (stale === null) {
        err(`board-sync: 단계 목록을 읽지 못했다: ${id}`)
        return 1
      }
      // 같은 항목·단계·PR·글은 한 번만 알린다. 해결돼 목록에서 빠지면 기록도 지워 다시 생기면 알린다
      const seen = notified[id] ?? {}
      const next: Record<string, string> = {}
      for (const { number, pr, text } of stale) {
        const key = staleKey(number, pr)
        next[key] = textRev(text)
        if (seen[key] === next[key]) continue
        out(`board-sync: ${id} 갱신 필요: ${number} 번 단계가 머지된 PR #${pr} 를 가리키지만 끝나지 않았다. 자동으로 끝내지 않는다. 일이 끝났으면 orch board step ${id} ${number} done 으로 끝내고, 앞으로 자동으로 끝내려면 orch board step ${id} ${number} text "<줄 전체>" --on "${pr} merge" 로 사건을 붙인다`)
        brief(`BOARD ${id} update-needed ${number} PR #${pr}`)
      }
      if (JSON.stringify(seen) !== JSON.stringify(next)) {
        if (Object.keys(next).length > 0) notified[id] = next
        else delete notified[id]
        notifiedChanged = true
      }
    }
    const rewrite = details.length !== old.length || details.some((d, i) => d !== old[i])
    const commands = guardedCommands([
      ...(rewrite ? [['set', id, ...detailArgs(details)]] : []), ...cmds, ...after,
    ], linesRev(item))
    cmds.splice(0, cmds.length, ...commands)
    if (cmds.length === 0) continue
    if (dryRun) {
      changed.push(id)
      if (short()) brief(`BOARD ${id} ${finish ? 'would-done' : 'would-update'}`)
      else out([id + (finish ? ' -> done' : ''), ...cmds.map((c) => c.join(' '))].join('\n  '))
      continue
    }
    for (const cmd of cmds) {
      const done = run(scriptCommand(boardBin, [...cmd, '--file', board]), { killSignal: 'SIGKILL' })
      if (done.code !== 0) {
        if (staleBoardWrite(cmd, done)) {
          err(`board-sync: ${id} 의 줄이 바뀌어 다음 틱에 다시 읽는다`)
          brief(`BOARD ${id} stale`)
          continue itemsLoop
        }
        if (done.stderr) process.stderr.write(done.stderr)
        err(`board-sync: 보드 명령이 실패했다: ${id}`)
        return 1
      }
    }
    if (reflected && !finish) {
      const line = recordUnmatched(repo, item, reflected.steps, reflected.pr)
      if (line) out(line)
    }
    changed.push(id)
    brief(`BOARD ${id} ${finish ? 'done' : 'updated'}`)
  }
  // 알린 기록은 dry-run 이 아닐 때만 남긴다. 보드에서 사라진 항목의 기록은 지운다
  if (!dryRun) {
    for (const id of Object.keys(notified)) {
      if (!items.some((row) => String(row.id) === id)) { delete notified[id]; notifiedChanged = true }
    }
    if (notifiedChanged) saveNotified(repo, notified)
  }
  if (!dryRun) {
    const records = unmatchedRecords(repo)
    if (Object.keys(records).length > 0) {
      const current = readBoard(board)
      const rows = new Map<string, BoardStep[] | null | undefined>()
      for (const id of Object.keys(records)) {
        rows.set(id, current.some((row) => row.id === id) ? boardSteps(boardBin, id, board) ?? undefined : null)
      }
      pruneUnmatched(repo, rows)
    }
  }
  if (values.goal && !dryRun) {
    const cmd = [values.goal, '--board', board, '--board-bin', boardBin]
    if (values['goal-items']) cmd.push('--items-file', values['goal-items'], '--details')
    const done = run(scriptCommand(scriptPath('goal-progress'), cmd), { killSignal: 'SIGKILL' })
    if (done.stderr) process.stderr.write(done.stderr)
  }
  if (short()) brief(`BOARD-SYNC ${changed.length}`)
  else out(`board-sync: ${changed.join(', ') || '바뀐 항목 없음'}`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
