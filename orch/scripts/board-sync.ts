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
// 모든 항목(done, goal 포함)의 worktree 칸이 git 워크트리 목록에 없는 이름이면 칸을 비운다. 끝난 worker 의 워크트리를 정리한 뒤
// 창이 「worker 없음」 을 보이지 않게 한다. 워크트리 목록을 읽지 못하면 비우지 않는다
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
import { taggedBoardSteps, boardSteps, detailArgs, detailText as textOf, noteLine, prNumbers, prSteps, withNote } from './lib/board.ts'
import type { BoardDetail as Detail } from './lib/board.ts'
import { deployVerdict, parseRuns } from './lib/deploy.ts'
import type { DeployVerdict, RunRow } from './lib/deploy.ts'
import { git } from './lib/git.ts'
import { judgeLastPr, rulesFrom } from './lib/last-pr.ts'
import { advanceCommands, boardSettings, mergedCommands, stagesOf } from './lib/milestones.ts'
import type { BoardSettings } from './lib/milestones.ts'
import { pidFileAlive } from './lib/process.ts'
import type { LastPrRules, LastPrVerdict } from './lib/last-pr.ts'
import { worktreePaths } from './lib/workers.ts'
import { gh, ghJson } from './lib/gh.ts'
import { boardPath, pathOf } from './lib/paths.ts'
import { run, scriptCommand } from './lib/proc.ts'
import { pyStr } from './lib/py.ts'
import { parseEventTag } from '../../work-board/hooks/event-tags.js'

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
  const got = ghJson<{ title?: unknown; headRefName?: unknown }>(['pr', 'view', num, '--json', 'title,headRefName'], { cwd: repo, killSignal: 'SIGKILL' })
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
  const names = worktreeNames(repo)
  let rules: LastPrRules | null | undefined
  let settings: BoardSettings | null | undefined
  const runs: { runs: RunRow[] | null } = { runs: null }
  const tagStates = new Map<string, string | null>()
  const stateFor = (pr: unknown): string | null => {
    const num = prNumber(pr)
    if (!num) return null
    if (!tagStates.has(num)) tagStates.set(num, prState(num, repo))
    return tagStates.get(num) ?? null
  }
  const changed: string[] = []
  for (const item of items) {
    const id = String(item.id)
    const cmds: string[][] = []
    const after: string[][] = []
    let finish = false
    // 끝난 worker 의 워크트리가 정리됐으면 칸을 비운다. done 과 goal 항목도 본다
    if (names !== null && typeof item.worktree === 'string' && item.worktree && !names.has(item.worktree)) cmds.push(['set', id, '--worktree', ''])
    const old = (Array.isArray(item.details) ? item.details : []) as Detail[]
    let details = old
    const tagged = item.status === 'done' ? [] : taggedBoardSteps(boardBin, id, board, item)
    if (tagged === null) {
      err(`board-sync: 단계 목록을 읽지 못했다: ${id}`)
      return 1
    }
    if (tagged.length > 0) {
      // 꼬리표가 있는 수동 항목과 goal 은 사건별로만 끝낸다. 다른 단계나 항목 상태는 바꾸지 않는다.
      for (const step of tagged.filter((step) => !step.done)) {
        const tag = parseEventTag(step.text)!
        if (tag.event === 'release') continue
        const state = stateFor(tag.pr)
        let reached = tag.event === 'pr' ? state === 'OPEN' || state === 'MERGED' : tag.event === 'merge' && state === 'MERGED'
        if (tag.event === 'deploy' && state === 'MERGED') {
          if (settings === undefined) {
            try { settings = boardSettings(repo) }
            catch (e) {
              err(`board-sync: 보드 설정을 읽지 못해 배포 반영을 건너뛴다: ${(e as Error).message}`)
              settings = null
            }
          }
          reached = Boolean(settings?.deploy && deployedNow(repo, tag.pr, settings.deploy, runs) === 'success')
        }
        if (reached) after.push(['step', id, String(step.number)])
      }
    } else if (!SKIP_STATUS.has(String(item.status))) {
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
          // 그 브랜치의 가장 최근 머지가 merged-pr 에 들었으면 이미 반영한 머지라 다시 연결하지 않는다. 더 옛 머지도 보지 않는다
          if (discovered && prNumbers(item['merged-pr']).has(String(discovered.number))) discovered = undefined
        }
        if (discovered) {
          item.pr = String(discovered.number)
          cmds.push(['set', id, '--pr', String(item.pr), '--branch', branch])
        }
      }
      const state = discovered ? (discovered.state ?? 'OPEN') : stateFor(item.pr)
      const merged = state === 'MERGED'
      details = old.filter((d) => !textOf(d).startsWith(LEGACY_AUTO))
      const num = prNumber(item.pr)
      const stages = stagesOf(item)
      if (merged && pidFileAlive(join(pathOf('queue', repo), `finish-${num}.pid`))) {
        // 마무리가 배포를 확인한 뒤 판정과 표시(PR!, PR~)로 이 항목을 고친다. 여기서 먼저 고치면 그 표시를 덮는다
        out(`board-sync: ${id} 는 PR ${num} 의 마무리(finish-pr)가 돌고 있어 그쪽에 맡긴다`)
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
          if (deployPending() && deployedNow(repo, num, deploy as { workflow: string; branch: string }, runs) === 'success') {
            const got = advanceCommands(id, steps, stages, 'deploy', { last: true, doneAfter })
            after.push(...got.cmds)
            finish = got.done
          }
        } else if (settings !== null) {
          if (rules === undefined) rules = lastPrRules(repo)
          const verdict = judge(repo, num, rules)
          const label = verdict === null || verdict.last === null ? (verdict?.retry ? '다음 틱에 다시 판정' : '마지막으로 봄') : verdict.last ? '마지막' : '중간'
          if (verdict) out(`board-sync: ${id} 마지막 PR 판정: ${label}(${verdict.reason})`)
          if (!verdict?.retry) {
            const last = verdict?.last ?? true
            const reached = deployPending() && deployedNow(repo, num, deploy as { workflow: string; branch: string }, runs) === 'success' ? 'deploy' : 'merge'
            const note = verdict?.last === false ? noteLine(verdict.prs, verdict.specs) : null
            const got = mergedCommands({ ...item, details }, steps, stages, num, reached, { last, doneAfter, note })
            after.push(...got.cmds)
            finish = got.done
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
        const label = verdict === null || verdict.last === null ? (verdict?.retry ? '다음 틱에 다시 판정' : '단계 수로 정함') : verdict.last ? '마지막' : '중간'
        if (verdict) out(`board-sync: ${id} 마지막 PR 판정: ${label}(${verdict.reason})`)
        if (!verdict?.retry) {
          const last = verdict?.last ?? (steps.filter((step) => !step.done).length <= 1)
          if (last) {
            finish = true
            details = withNote(details, null)
            after.push(...steps.filter((step) => !step.done).map((step) => ['step', id, String(step.number)]), ['set', id, 'done', '--worktree', ''])
          } else {
            const note = verdict?.last === false ? noteLine(verdict.prs, verdict.specs) : null
            details = withNote(details, note)
            // lib/board.ts 의 intermediateCommands 와 같은 순서다. 하위 항목은 위에서 한 번에 다시 쓴다
            const mergedPrs = [...new Set([...prNumbers(item['merged-pr']), num])].join(', ')
            after.push(...prSteps(steps, num).map((n) => ['step', id, String(n)]), ['set', id, '--pr', '', '--merged-pr', mergedPrs])
          }
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
      const done = run(scriptCommand(boardBin, [...cmd, '--file', board]), { killSignal: 'SIGKILL' })
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
    const done = run(scriptCommand(join(HERE, 'goal-progress.ts'), cmd), { killSignal: 'SIGKILL' })
    if (done.stderr) process.stderr.write(done.stderr)
  }
  out(`board-sync: ${changed.join(', ') || '바뀐 항목 없음'}`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
