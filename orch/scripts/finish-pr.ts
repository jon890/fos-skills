// PR 하나의 머지 뒤 마무리를 끝까지 한다: worker 정리, 배포 확인, 마지막 PR 판정, after-deploy 이벤트(업무 완료), 보드 done.
//
// 머지 큐(`merge_queue.ts`)를 건 자리에서 PR 마다 함께 건다. 보통은 `merge-with-finish.ts` 가 대신 건다.
// 코디네이터가 머지 뒤 단계를 잊거나, 정리가 GitHub 상태 반영보다 먼저 돌아 워크트리가 남는 일을 막는다.
//
// 사용법:
//     finish-pr.ts PR [--complete | --intermediate] [--repo DIR] [--config FILE] [옵션...]
//
//     1. PR 이 MERGED 가 될 때까지 기다린다(--merge-timeout). 머지 없이 닫히면 FINISH-FAIL 이다
//        머지된 것을 gh 로 직접 확인한 뒤에야 정리한다. 머지 직후 `cleanup-sweep.ts` 는 GitHub 상태가 아직
//        반영되지 않아 「살아 있는 터미널」 로 건너뛰고 워크트리를 남긴 적이 있다
//     2. --run 을 줬고 그 Run 에서 그 PR 브랜치의 워크트리에 살아 있는 dispatch(lib/workers.ts 의 workerFor, LIVE_DISPATCH)가 있으면
//        `send-to-worker --dispatch <id> --body "PR #<N> 이 MERGED 됐다(머지 커밋 <SHA>). ..." [--run <run>]` 으로 머지를 알린다.
//        머지된 줄 모르고 기다리는 worker 의 dispatch 가 살아 있으면 정리가 그 워크트리를 「살아 있는 worker」 로 건너뛴다.
//        보낸 뒤 --worker-done-timeout 동안 --poll-interval 마다 worker-list 로 그 dispatch 가 끝났는지 본다.
//        끝나면 `worker 끝남: <dispatch> (<상태>)`, 시간이 지나면 `worker 남음: <dispatch> 가 아직 살아 있다 ...` 를 남기고 정리로 넘어간다.
//        보내지 못했으면(send-to-worker 의 3, 5 같은 것) 기다리지 않는다. worker 목록을 읽지 못하면 알리지 않고 그 사실을 남긴다.
//        출력 줄은 `notify: ` 로 시작한다
//     3. 그 PR 브랜치의 worker 를 정리한다. `cleanup-sweep.ts --apply` 가 dispatch 해제, 터미널 닫기,
//        워크트리와 브랜치 삭제를 맡고, 이 명령은 그 브랜치의 워크트리가 사라졌는지 확인하며 다시 시도한다
//     4. --deploy-workflow 와 --deploy-branch 를 주면, 머지 커밋을 조상으로 가진 커밋의 배포 실행이
//        성공할 때까지 기다린다(--deploy-timeout). 뒤 커밋의 배포에 합쳐져 머지 커밋의 실행이 skipped 나
//        cancelled 로 끝나도 뒤 커밋의 실행이 성공하면 성공이다. 판정은 lib/deploy.ts 의 deployVerdict 가 소유한다
//     5. 이 PR 이 업무의 마지막 PR 인지 판정하고 `마지막 PR 판정: <마지막|중간>(근거)` 한 줄을 낸다(아래 「마지막 PR 판정」).
//        배포가 실패하거나 시간이 지나도 판정한다
//     6. --specs-dir 를 줬고 마지막 PR 이면 `브랜치:` 줄이 그 브랜치인 spec-*.md 를 지운다.
//        지우기는 lib/spec.ts 의 deleteSpecs 한 경로다. 살아 있는 dispatch(--run 의 Run, 없으면 모든 Run)가 쓰는 지시서와,
//        그 목록을 읽지 못한 실행에서는 지우지 않는다. 지시서 폴더가 orch 루트 밖이어도 지운다.
//        중간 PR 이면 지시서는 남긴다. 업무 하나가 PR 여럿이면 다음 PR 에도 지시서를 쓴다
//        마지막과 중간 모두, --specs-dir 와 상관없이 <orch 루트>/specs 의 이 PR 의 충돌 후속 지시서(spec-conflict-<PR>.md 와
//        옛 이름 spec-conflict-<PR>-<base SHA 앞 8자리>.md, lib/conflicts.ts 의 conflictSpecFiles)를 같은 deleteSpecs 로 지운다(ADR-015).
//        그 PR 이 머지되면 쓸모가 없다. 지울 것이 없으면 살아 있는 지시서 목록도 읽지 않는다
//     7. after-deploy 이벤트를 낸다. 배포가 실패하거나 시간이 지나도 낸다. 핸들러는 입력의 deploy 로 스스로 판단한다
//     8. 배포가 실패하거나 시간이 지났으면 보드를 건드리지 않고 FINISH-FAIL 이다
//     9. 보드 항목을 고친다(아래 「보드 항목」)
//
// 마지막 PR 판정:
//     --complete(merge-with-finish 의 `PR!`)면 마지막, --intermediate(`PR~`)면 중간이다. 둘 다 없으면 lib/last-pr.ts 의 judgeLastPr 로
//     판정한다. 규칙은 --task-pattern, --spec-task-pattern, --specs-dir 이고 조건은 그 모듈의 머리 주석이 소유한다.
//     판정하지 못하면 중간 PR 로 본다. 업무를 일찍 완료하는 것이 늦게 완료하는 것보다 되돌리기 어렵다.
//     근거 줄의 예: `마지막 PR 판정: 중간(업무 PROJ-12, 남은 PR #31 #33, 남은 지시서 spec-b.md)`
//
// 보드 항목:
//     --board-id 를 주면 판정과 상관없이 그 항목을 done 으로 바꾼다.
//     없으면 보드 파일(lib/board.ts 의 findBoardItems)에서 pr 칸에 이 PR 이 든 항목을 찾고, 없으면 pr 칸이 빈 항목 가운데
//     branch 가 PR 브랜치이거나 worktree 가 그 브랜치의 워크트리 이름(정리 전에 읽는다)인 항목을 찾는다.
//     브랜치로 찾을 때 done 항목과 merged-pr 에 이미 이 PR 이 든 항목은 뺀다.
//     마지막 PR 이면 그 항목을 done 으로 바꾼다. 중간 PR 이면 lib/board.ts 의 intermediateCommands 로 그 PR 번호의 단계를 끝내고,
//     하위 항목에 `남은 일: PR #31, 지시서 spec-b.md` 한 줄을 두고, pr 칸을 비우고 merged-pr 에 적는다.
//     merged-pr 에 적은 PR 은 board-sync.ts 가 다시 판정하지 않으므로 --intermediate 가 덮이지 않는다.
//     찾은 항목이 둘 이상이면 어느 것인지 알 수 없어 건너뛴다
//     마일스톤 항목(stages 칸이 있다, lib/milestones.ts)은 위 대신 mergedCommands 로 [pr], [merge] 단계와 배포가 성공했으면 [deploy] 단계를 끝낸다.
//     판정하지 못한 PR 은 board-sync.ts 와 같이 마지막으로 본다. 마지막 PR 이 done 지점(board.done_after, 기본 merge)에 닿았을 때만 done 으로 바꾸고, 아니면 doing 으로 두고 PR 을 merged-pr 에 적는다.
//     마지막 PR 은 pr 칸에 남겨 board-release.ts 가 찾게 한다. 중간 PR 은 pr 칸을 비우고 merged-pr 에 쌓는다
//
//     업무 완료(--complete-cmd)는 after-deploy 의 옛 칸이다. 다음 major 에서 지운다.
//     마지막 PR 이고, 배포가 성공했거나 배포 워크플로가 없고, PR 제목에서 --task-pattern 으로 업무 번호를 뽑았을 때만
//     `DEPRECATED --complete-cmd → hooks/after-deploy.ts` 줄과 함께 그 명령을 핸들러 자리에서 돌린다.
//     작업 디렉터리는 옛 명령과 같이 --repo 로 준 경로다. 연결된 워크트리를 주면 그 워크트리다(lib/events.ts 의 legacy).
//     --complete-cmd 가 없으면(업무 시스템이 없는 저장소) 이 단계만 건너뛰고 로그에 남긴다. 지시서는 지운다.
//     --complete 와 --complete-cmd 를 함께 주면 --task-pattern 도 있어야 한다
//
// 이벤트 입력(lib/events.ts 머리 주석의 「이벤트별 필드」): pr, merge_commit, deploy(success, failure, timeout, none),
//     last_of_task(마지막 PR 판정). base 는 PR 의 base, run 은 --run(없으면 null)이다.
//     업무 완료 명령과 <orch 루트>/hooks/after-deploy.ts 가 함께 있으면 머지를 기다리기 전에 사용법 오류로 끝난다.
//     업무 완료 명령이나 핸들러가 있으면 config.json 의 hooks.timeouts.after-deploy 값도 머지를 기다리기 전에 본다. 틀리면 사용법 오류다.
//     이벤트 실행기는 배포를 기다린 뒤에야 이 충돌을 알아채는데, 그때는 이미 머지와 정리가 끝났기 때문이다
//
// 실패로 남기는 것(이것들이 있어도 보드 done 은 돌고 마지막 줄이 FINISH-FAIL 이다):
//     PR 제목에서 업무 번호를 찾지 못했다, 업무 완료 명령이 실패하거나 시간을 넘겼다, after-deploy 핸들러가 실패했다,
//     보드 명령이 실패했다
//
// 옵션 (저장소마다 다른 값이다. --config 의 JSON 키는 옵션 이름의 하이픈을 밑줄로 바꾼 것이다):
//     --repo DIR            대상 저장소. 기본은 현재 디렉터리
//     --config FILE         옵션 값을 담은 JSON. 「finish」 절을 읽는다. 없으면 <orch 작업 폴더>/config.json 이 있을 때 쓴다. 명령줄이 우선한다.
//                           sweep_arg 는 설정의 목록 뒤에 명령줄의 값을 잇는다
//     --gh-host HOST        gh 와 git 에 줄 GH_HOST (예: github.example.com). 없으면 gh 가 정한다
//     --run RUN_ID          worker 를 찾을 Orca Run. 없으면 dispatch 해제는 건너뛰고 터미널만 경로로 찾는다
//     --base-branch NAME    cleanup-sweep.ts 의 --base
//     --sweep-arg ARG       cleanup-sweep.ts 에 더 넘길 인자. 하나씩 준다. 값이 `-` 로 시작하면 `--sweep-arg=--x` 로 쓴다
//     --specs-dir DIR       지시서 폴더. 상대경로는 --repo 기준이다. 마지막 PR 일 때만 `브랜치:` 줄이 이 PR 의 브랜치인
//                           spec-*.md 를 지운다. 중간 PR 에서는 지시서를 남기고 그 사실을 로그에 한 줄 남긴다
//     --deploy-workflow F   배포 워크플로 파일 이름 (예: deploy.yml)
//     --deploy-branch B     배포가 도는 브랜치 (예: develop)
//     --task-pattern RE     PR 제목에서 업무 번호를 뽑는 Python 정규식(lib/py.ts 의 pyRegExp). 첫 번째 그룹이 번호다
//                           (예: '^\[?(PROJ-[0-9]+)'). 번호는 영문, 숫자, `._/-` 만 받는다. 마지막 PR 판정에도 쓴다
//     --spec-task-pattern RE  지시서의 줄에서 업무 번호를 뽑는 Python 정규식. 첫 번째 그룹이 번호다
//                           (예: '^브랜치: `feature/(PROJ-[0-9]+)-'). --task-pattern 이 뽑는 번호와 같은 꼴을 뽑아야 한다.
//                           마지막 PR 판정이 남은 지시서를 찾는 데 쓴다
//     --complete            이 PR 이 업무의 마지막 PR 이다. 판정하지 않는다. --complete-cmd 없이도 쓴다(지시서 삭제만 한다)
//     --intermediate        이 PR 이 업무의 중간 PR 이다. 판정하지 않는다. --complete 와 함께 쓸 수 없다
//     --complete-cmd CMD    업무 완료 명령 틀. shlex 처럼 나누고(lib/py.ts 의 shSplit) 조각마다 {number} 를 업무 번호로 바꾼다.
//                           셸을 거치지 않는다 (예: 'task-cli complete {number}')
//     --board FILE          보드 파일. 기본은 work-board 의 board.ts 가 정한 위치. 상대경로면 주 checkout 기준
//     --board-id ID         판정과 상관없이 done 으로 바꿀 보드 항목. 없으면 보드 파일에서 찾는다(위 「보드 항목」)
//     --board-bin PATH      보드 명령. 기본은 BOARD_BIN 환경 변수, 없으면 이 저장소의 work-board/bin/board.ts
//     --merge-timeout MIN   머지 대기 한도(분). 기본 180
//     --deploy-timeout MIN  배포 대기 한도(분). 기본 120
//     --poll-interval SEC   확인 간격(초). 기본 60
//     --worker-done-timeout MIN  머지를 알린 worker 의 dispatch 가 끝나기를 기다리는 한도(분). 기본 10. 0 이면 알리기만 한다
//     --pid-file FILE       시작할 때 pid 를 쓰고 끝나면 지운다. 같은 PR 의 마무리가 둘 도는 것을 막을 때 쓴다
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts)
//
// CLEANUP_SWEEP 환경 변수로 정리 스크립트 경로를, SEND_TO_WORKER 로 worker 에게 보내는 명령을, BOARD_BIN 으로 보드 명령을, GH 와 GIT 로 실행 파일을, ORCA 로 orca 를 바꾼다.
// 정리 스크립트와 보드 명령은 확장자로 인터프리터를 고른다(lib/proc.ts 의 scriptCommand).
//
// 출력의 마지막 줄은 FINISH-DONE 이나 FINISH-FAIL 이다. 그 줄이 없으면 아직 돌고 있거나 죽은 것이다.
//
// 종료 코드: 0 FINISH-DONE, 1 FINISH-FAIL, 2 사용법 오류(설정 파일 오류, 업무 완료 명령과 핸들러가 함께 있음 포함)이거나
//           orch 작업 폴더를 옮기기 전이다(lib/paths.ts 「옛 구조」)

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { hasEventTags, findBoardItems, intermediateCommands, noteLine, readBoard } from './lib/board.ts'
import type { BoardDetail, BoardStep } from './lib/board.ts'
import { conflictSpecFiles } from './lib/conflicts.ts'
import { deployVerdict, parseRuns } from './lib/deploy.ts'
import { boardSettings, mergedCommands, stagesOf } from './lib/milestones.ts'
import type { StageKind, Stages } from './lib/milestones.ts'
import { extractTaskNumber, judgeLastPr, numberPattern, specFiles } from './lib/last-pr.ts'
import { ConfigError, loadConfig, section } from './lib/config.ts'
import { checkLegacy, eventTimeoutSec, fire, handlerFile } from './lib/events.ts'
import type { FireResult } from './lib/events.ts'
import { FINISH_KEYS, FINISH_OPTIONS as OPTIONS } from './lib/finish-options.ts'
import { real, realPath } from './lib/fs.ts'
import { gh } from './lib/gh.ts'
import { pollSeconds } from './lib/gh-budget.ts'
import { boardPath, pathOf, requireMigrated } from './lib/paths.ts'
import { run, runAsync, scriptCommand } from './lib/proc.ts'
import { pyStr, shSplit } from './lib/py.ts'
import { branchesOf, deleteSpecs, liveSpecPaths } from './lib/spec.ts'
import { LIVE_DISPATCH, workerFor, workerRows } from './lib/workers.ts'

const SCRIPT = fileURLToPath(import.meta.url)
const HERE = dirname(SCRIPT)
const CLEANUP_TRIES = 5
// 옛 명령의 자식 실행 시간 제한(초). 정리 스크립트만 600초였다
const RUN_TIMEOUT_MS = 300_000
const SWEEP_TIMEOUT_MS = 600_000
// send-to-worker 는 nudge-worker 를 5분까지 기다린다
const SEND_TIMEOUT_MS = 600_000
const LEGACY_KEY = '--complete-cmd'
const HOOK_PREFIX = '[hook after-deploy] '
const PR_FIELDS = 'state,mergeCommit,headRefName,title,number,headRefOid,author,isDraft,url,baseRefName'

type Args = {
  pr: string
  repo: string
  config: string | null
  ghHost: string | null
  run: string | null
  baseBranch: string | null
  sweepArg: string[]
  specsDir: string | null
  deployWorkflow: string | null
  deployBranch: string | null
  taskPattern: RegExp | null
  specTaskPattern: RegExp | null
  complete: boolean
  intermediate: boolean
  completeCmd: string | null
  board: string | null
  boardId: string | null
  boardBin: string
  mergeTimeout: number
  deployTimeout: number
  pollInterval: number
  workerDoneTimeout: number
  pidFile: string | null
}

type Merged = { merge: string; branch: string; title: string; pr: Record<string, unknown>; base: string }
type Deploy = 'none' | 'success' | 'failure' | 'timeout'

class Usage extends Error {}

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function now(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function log(line: string): void {
  out(`${now()} ${line}`)
}

function fail(reason?: string): number {
  if (reason) log(reason)
  out('FINISH-FAIL')
  return 1
}

// 머리 주석이 사용법을 소유한다. -h 와 --help 가 그것을 찍는다
function usageText(): string {
  const lines: string[] = []
  for (const line of readFileSync(SCRIPT, 'utf8').split('\n')) {
    if (!line.startsWith('//')) break
    lines.push(line.replace(/^\/\/ ?/, ''))
  }
  return lines.join('\n')
}

function gitBin(): string {
  return process.env.GIT || 'git'
}

function git(repo: string, args: string[]): { code: number; stdout: string } {
  return run([gitBin(), ...args], { cwd: repo, timeoutMs: RUN_TIMEOUT_MS })
}

// ---- 판정 ---------------------------------------------------------------------------------------------

// `git worktree list --porcelain` 출력에서 그 브랜치를 체크아웃한 워크트리 경로. 없으면 null
function worktreeForBranch(porcelain: string, branch: string): string | null {
  let path: string | null = null
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${branch}`) return path
  }
  return null
}

// ---- 옵션 ---------------------------------------------------------------------------------------------

function optional(value: unknown, key: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new ConfigError(`설정 파일의 finish.${key} 는 문자열이어야 한다`)
  return value
}

function minutes(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null) return fallback
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) throw new Usage(`${name} 은 수다: ${pyStr(value)}`)
  return n
}

// 명령줄을 읽고 설정 파일의 finish 절을 기본값으로 깐다. help 면 null 이다.
function parse(argv: string[]): Args | null {
  let values: Record<string, string | boolean | string[] | undefined>
  let positionals: string[]
  try {
    const parsed = parseArgs({ args: expandArgs(argv, OPTIONS), options: OPTIONS, allowPositionals: true })
    values = parsed.values as typeof values
    positionals = parsed.positionals
  } catch (e) {
    throw new Usage((e as Error).message)
  }
  if (values.help) return null
  if (positionals.length !== 1) throw new Usage(positionals.length === 0 ? 'PR 번호가 필요하다' : `PR 번호는 하나다: ${positionals.join(' ')}`)
  const cli = (name: string) => values[name] as string | undefined
  const configFile = cli('config') ?? null
  const cliRepo = cli('repo') ?? '.'
  const config = section<Record<string, unknown>>(loadConfig(cliRepo, configFile ? { file: configFile } : {}), 'finish', FINISH_KEYS)
  const pick = (name: string): string | null => cli(name) ?? optional(config[name.replaceAll('-', '_')], name.replaceAll('-', '_'))
  const configSweep = config.sweep_arg
  if (configSweep !== undefined && (!Array.isArray(configSweep) || !configSweep.every((v) => typeof v === 'string'))) {
    throw new ConfigError('sweep_arg 는 문자열 목록이다')
  }
  const configComplete = config.complete
  if (configComplete !== undefined && typeof configComplete !== 'boolean') throw new ConfigError('설정 파일의 finish.complete 는 true 나 false 여야 한다')
  const num = (name: string, fallback: number) => minutes(cli(name) ?? config[name.replaceAll('-', '_')], `--${name}`, fallback)

  // 업무 번호를 뽑는 정규식. 첫 번째 그룹이 번호다
  const pattern = (name: string): RegExp | null => {
    const source = pick(name)
    if (!source) return null
    try {
      return numberPattern(source, `--${name}`)
    } catch (e) {
      throw new Usage((e as Error).message)
    }
  }
  const configIntermediate = config.intermediate
  if (configIntermediate !== undefined && typeof configIntermediate !== 'boolean') {
    throw new ConfigError('설정 파일의 finish.intermediate 는 true 나 false 여야 한다')
  }
  const args: Args = {
    pr: positionals[0],
    repo: pick('repo') ?? '.',
    config: configFile,
    ghHost: pick('gh-host'),
    run: pick('run'),
    baseBranch: pick('base-branch'),
    sweepArg: [...((configSweep as string[] | undefined) ?? []), ...((values['sweep-arg'] as string[] | undefined) ?? [])],
    specsDir: pick('specs-dir'),
    deployWorkflow: pick('deploy-workflow'),
    deployBranch: pick('deploy-branch'),
    taskPattern: pattern('task-pattern'),
    specTaskPattern: pattern('spec-task-pattern'),
    // 명령줄의 표시(merge-with-finish 의 PR!, PR~)가 설정의 기본값보다 우선한다
    complete: values.complete === true || (values.intermediate !== true && configComplete === true),
    intermediate: values.intermediate === true || (values.complete !== true && configIntermediate === true),
    completeCmd: pick('complete-cmd'),
    board: pick('board'),
    boardId: pick('board-id'),
    boardBin: pick('board-bin') ?? (process.env.BOARD_BIN || resolve(HERE, '../../work-board/bin/board.ts')),
    mergeTimeout: num('merge-timeout', 180),
    deployTimeout: num('deploy-timeout', 120),
    pollInterval: num('poll-interval', 60),
    workerDoneTimeout: num('worker-done-timeout', 10),
    pidFile: pick('pid-file'),
  }
  if (Boolean(args.deployWorkflow) !== Boolean(args.deployBranch)) throw new Usage('--deploy-workflow 와 --deploy-branch 는 함께 준다')
  if (args.complete && args.intermediate) throw new Usage('--complete 와 --intermediate 는 함께 쓸 수 없다')
  if (args.complete && args.completeCmd && !args.taskPattern) throw new Usage('--complete-cmd 를 주면 --task-pattern 도 있어야 한다')
  if (args.completeCmd) {
    if (!args.completeCmd.includes('{number}')) throw new Usage('--complete-cmd 에 {number} 가 없다')
    let parts: string[]
    try {
      parts = shSplit(args.completeCmd)
    } catch (e) {
      throw new Usage(`--complete-cmd 를 나누지 못했다: ${(e as Error).message}`)
    }
    if (!parts.some((part) => part.includes('{number}'))) throw new Usage('--complete-cmd 에 {number} 가 없다')
  }
  if (!/^\d+$/.test(args.pr)) throw new Usage(`PR 번호가 아니다: ${args.pr}`)
  return args
}

// ---- 실행 ---------------------------------------------------------------------------------------------

// PR 이 MERGED 면 그 정보. 닫혔거나 시간이 지나면 null 이다. 조회에 실패하면 다음 확인까지 기다린다
async function waitMerged(args: Args, repo: string): Promise<Merged | null> {
  const deadline = Date.now() + args.mergeTimeout * 60_000
  for (;;) {
    const done = gh(['pr', 'view', args.pr, '--json', PR_FIELDS], { cwd: repo, timeoutMs: RUN_TIMEOUT_MS })
    let data: Record<string, unknown> | null = null
    if (done.code === 0) {
      try {
        const parsed: unknown = JSON.parse(done.stdout)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
      } catch {
        data = null
      }
    }
    const state = typeof data?.state === 'string' ? data.state : ''
    if (data && state === 'MERGED') {
      const text = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : '')
      const mergeCommit = data.mergeCommit as { oid?: unknown } | null | undefined
      const merge = typeof mergeCommit?.oid === 'string' ? mergeCommit.oid : ''
      const author = data.author as { login?: unknown } | null | undefined
      const pr = {
        number: Number(args.pr),
        title: text('title') || null,
        branch: text('headRefName') || null,
        head: text('headRefOid') || null,
        author: typeof author?.login === 'string' ? author.login : null,
        draft: data.isDraft === true,
        url: text('url') || null,
      }
      return { merge, branch: text('headRefName'), title: text('title'), pr, base: text('baseRefName') }
    }
    if (state === 'CLOSED') {
      log(`PR ${args.pr} 가 머지 없이 닫혔다`)
      return null
    }
    if (Date.now() >= deadline) {
      log(`PR ${args.pr} 머지를 기다리다 시간이 지났다`)
      return null
    }
    await sleep(args.pollInterval * 1000)
  }
}

function worktreePath(repo: string, branch: string): string | null {
  return worktreeForBranch(git(repo, ['worktree', 'list', '--porcelain']).stdout, branch)
}

function localBranchExists(repo: string, branch: string): boolean {
  return git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0
}

// 정리 스크립트를 돌려 그 브랜치의 워크트리와 로컬 브랜치가 사라질 때까지 다시 시도한다. 사라졌으면 true.
// 로컬 브랜치 이름이 PR 의 head 브랜치 이름과 다르면 head 이름으로는 워크트리가 보이지 않는다.
// 그래서 보이지 않아도 정리 스크립트를 한 번은 돌린다. 그 스크립트가 PR 을 upstream 이름 등으로 찾아 정리한다
async function cleanupWorker(args: Args, repo: string, branch: string): Promise<boolean> {
  const sweep = process.env.CLEANUP_SWEEP || join(HERE, 'cleanup-sweep.ts')
  const sweepArgs = ['--repo', repo, '--apply', '--kill-holders']
  if (args.run) sweepArgs.push('--run', args.run)
  if (args.baseBranch) sweepArgs.push('--base', args.baseBranch)
  sweepArgs.push(...args.sweepArg)
  for (let attempt = 1; attempt <= CLEANUP_TRIES; attempt++) {
    git(repo, ['fetch', '--prune', '-q', 'origin'])
    const done = await runAsync(scriptCommand(sweep, sweepArgs), { cwd: repo, timeoutMs: SWEEP_TIMEOUT_MS })
    // 옛 명령과 같이 stdout 과 stderr 를 이어 붙인 뒤 줄로 나눈다
    for (const line of (done.stdout + done.stderr).split('\n')) {
      if (line) log(`sweep: ${line.replace(/\r$/, '')}`)
    }
    if (!worktreePath(repo, branch) && !localBranchExists(repo, branch)) return true
    if (attempt < CLEANUP_TRIES) await sleep(args.pollInterval * 1000)
  }
  return false
}

// 머리 주석의 단계 2. 그 워크트리의 살아 있는 worker 에게 머지를 알리고, dispatch 가 끝나기를 기다린다
async function tellMerged(args: Args, runId: string, worktree: string, merge: string): Promise<void> {
  const found = workerRows(runId)
  if (!found.ok) {
    log(`notify: worker 목록을 읽지 못해 머지를 알리지 않았다: ${found.error}`)
    return
  }
  const row = workerFor(found.rows, worktree)
  if (!row || !LIVE_DISPATCH.has(String(row.dispatchStatus))) return
  const dispatch = String(row.dispatchId)
  const body = `PR #${args.pr} 이 MERGED 됐다(머지 커밋 ${merge}). gh pr view 로 확인한 뒤 worker_done 을 보내고 끝낸다`
  const send = process.env.SEND_TO_WORKER || join(HERE, 'send-to-worker.ts')
  const done = await runAsync(scriptCommand(send, ['--dispatch', dispatch, '--body', body, '--run', runId, '--no-reply']), {
    cwd: worktree,
    timeoutMs: SEND_TIMEOUT_MS,
  })
  for (const line of (done.stdout + done.stderr).split('\n')) {
    if (line) log(`notify: ${line.replace(/\r$/, '')}`)
  }
  // 1 은 보냈지만 턴 시작을 보지 못했고, 4 는 보냈지만 깨우지 못했다. 둘 다 메시지는 갔다(send-to-worker 머리 주석)
  if (![0, 1, 4].includes(done.code)) {
    log(`notify: ${dispatch} 에 머지를 알리지 못했다(종료 코드 ${done.code}). 기다리지 않고 정리한다`)
    return
  }
  log(`notify: ${dispatch} 에 PR #${args.pr} 머지를 알렸다. ${args.workerDoneTimeout}분까지 끝나기를 기다린다`)
  const deadline = Date.now() + args.workerDoneTimeout * 60_000
  for (;;) {
    const rows = workerRows(runId)
    const status = rows.ok ? String(rows.rows.find((r) => String(r.dispatchId) === dispatch)?.dispatchStatus ?? '') : null
    if (status !== null && !LIVE_DISPATCH.has(status)) {
      log(`notify: worker 끝남: ${dispatch} (${status || '목록에 없음'})`)
      return
    }
    if (Date.now() >= deadline) {
      log(`notify: worker 남음: ${dispatch} 가 아직 살아 있다. 정리가 그 워크트리를 살아 있는 worker 로 건너뛸 수 있다`)
      return
    }
    await sleep(args.pollInterval * 1000)
  }
}

function specsDirOf(args: Args, repo: string): string {
  const given = args.specsDir as string
  return isAbsolute(given) ? given : join(repo, given)
}

// 지시서 폴더에서 `브랜치:` 줄이 그 브랜치인 spec-*.md 를 지운다.
// root 는 orch 루트가 아니라 지시서 폴더 실경로의 부모다. deleteSpecs 는 root 밖의 파일을 남기는데, 옛 명령은
// 지시서 폴더가 orch 루트 밖이어도 지웠다. 지시서는 그 부모의 바로 아래 폴더에 있으므로 늘 root 안이다
function deleteBranchSpecs(args: Args, repo: string, branch: string): void {
  const specs = specFiles(specsDirOf(args, repo))
    .filter((spec) => branchesOf(spec.text).includes(branch))
    .map((spec) => spec.path)
  if (specs.length === 0) return
  deleteSpecs({ root: dirname(realPath(specsDirOf(args, repo))), specs, prBodies: [], live: liveSpecPaths(args.run), mode: 'delete', apply: true, log })
}

// 이 PR 의 충돌 후속 지시서를 지운다(머리 주석의 단계 6). root 는 deleteBranchSpecs 와 같이 지시서 폴더 실경로의 부모다
function deleteConflictSpecs(args: Args, repo: string): void {
  const specs = conflictSpecFiles(repo, Number(args.pr))
  if (specs.length === 0) return
  deleteSpecs({ root: dirname(realPath(pathOf('specs', repo))), specs, prBodies: [], live: liveSpecPaths(args.run), mode: 'delete', apply: true, log })
}

// 머리 주석의 「마지막 PR 판정」. 판정하지 못하면 중간 PR 이다. reason 은 근거 줄의 괄호 안이다
// prs 와 specs 는 남은 PR 과 지시서다. 보드의 남은 일 줄에 쓴다
// known 은 판정했는지다. 판정하지 못해 중간으로 본 것이면 false 다
function judgeLast(args: Args, repo: string, merged: Merged): { last: boolean; known: boolean; reason: string; prs: string[]; specs: string[] } {
  if (args.complete) return { last: true, known: true, reason: '--complete 로 지정', prs: [], specs: [] }
  if (args.intermediate) return { last: false, known: true, reason: '--intermediate 로 지정', prs: [], specs: [] }
  const rules = { taskPattern: args.taskPattern, specTaskPattern: args.specTaskPattern, specsDir: args.specsDir ? specsDirOf(args, repo) : null }
  const verdict = judgeLastPr(repo, { number: args.pr, title: merged.title, branch: merged.branch }, rules)
  return { last: verdict.last === true, known: verdict.last !== null, reason: verdict.reason, prs: verdict.prs, specs: verdict.specs }
}

async function waitDeployed(args: Args, repo: string, merge: string): Promise<{ deploy: Deploy; sha: string }> {
  const deadline = Date.now() + args.deployTimeout * 60_000
  const branch = args.deployBranch as string
  let attempt = 0
  const isAncestor = (ancestor: string, sha: string) => git(repo, ['merge-base', '--is-ancestor', ancestor, sha]).code === 0
  for (;;) {
    git(repo, ['fetch', '-q', 'origin', branch])
    const done = gh(['run', 'list', '--branch', branch, '--workflow', args.deployWorkflow as string, '--limit', '15', '--json', 'headSha,status,conclusion'], {
      cwd: repo,
      timeoutMs: RUN_TIMEOUT_MS,
    })
    const { verdict, sha } = deployVerdict(done.code === 0 ? parseRuns(done.stdout) : [], merge, isAncestor)
    if (verdict !== 'wait') return { deploy: verdict, sha }
    if (Date.now() >= deadline) return { deploy: 'timeout', sha: '' }
    await sleep((args.pollInterval < 60 ? args.pollInterval : pollSeconds(attempt++, args.pollInterval)) * 1000)
  }
}

// 그 항목의 stages 칸(lib/milestones.ts). 옛 단계 항목이거나 보드를 읽지 못하면 null 이다
function milestoneStages(args: Args, repo: string, item: string): Stages | null {
  try {
    const row = readBoard(boardPath(repo, args.board)).find((i) => pyStr(i.id) === item)
    return row ? stagesOf(row) : null
  } catch {
    return null
  }
}

// 사건 꼬리표 항목은 PR 단위 일괄 완료 대신 board-sync 가 단계별로 반영한다.
function taggedBoardItem(args: Args, repo: string, item: string): boolean {
  try {
    const row = readBoard(boardPath(repo, args.board)).find((i) => pyStr(i.id) === item)
    return row ? hasEventTags(row) : false
  } catch {
    return false
  }
}

// 머리 주석의 「보드 항목」 에서 찾은 항목. 없거나 둘 이상이면 null 이고, 둘 이상이면 알린다
function pickBoardItem(args: Args, repo: string, branch: string, worktree: string | null): { id: string; by: 'pr' | 'branch' } | null {
  const found = findBoardItems(boardPath(repo, args.board), args.pr, branch, worktree)
  if (found === null) return null
  if (found.ids.length > 1) {
    log(`보드 항목이 둘 이상이라 건너뛴다: PR ${args.pr} -> ${found.ids.join(', ')}`)
    return null
  }
  return { id: found.ids[0], by: found.by }
}

function board(args: Args, repo: string, argv: string[]): boolean {
  const cmd = scriptCommand(args.boardBin, [...argv, '--file', boardPath(repo, args.board)])
  const done = run(cmd, { cwd: repo, timeoutMs: RUN_TIMEOUT_MS })
  if (done.code !== 0) log(`보드 명령이 실패했다: ${done.stderr.trim()}`)
  return done.code === 0
}

function setBoardDone(args: Args, repo: string, item: string): boolean {
  return board(args, repo, ['set', item, 'done', '--worktree', '', '--pr', '', '--next', ''])
}

// 보드 항목과 그 단계 목록. 읽지 못하면 알리고 null 이다
function boardRow(args: Args, repo: string, item: string): { row: Record<string, unknown>; steps: BoardStep[] } | null {
  const file = boardPath(repo, args.board)
  let row: Record<string, unknown> | undefined
  try {
    row = readBoard(file).find((i) => pyStr(i.id) === item)
  } catch {
    row = undefined
  }
  const steps = run(scriptCommand(args.boardBin, ['steps', item, '--file', file]), { cwd: repo, timeoutMs: RUN_TIMEOUT_MS })
  let parsed: unknown = null
  try {
    parsed = JSON.parse(steps.stdout)
  } catch {
    parsed = null
  }
  if (!row || steps.code !== 0 || !Array.isArray(parsed)) {
    log(`보드 ${item} 의 단계 목록을 읽지 못했다: ${steps.stderr.trim()}`)
    return null
  }
  return { row, steps: parsed as BoardStep[] }
}

// 중간 PR 을 옛 단계 항목에 반영한다(lib/board.ts 의 intermediateCommands). 항목이나 단계 목록을 읽지 못하면 false 다
function setBoardIntermediate(args: Args, repo: string, item: string, note: string | null): boolean {
  const got = boardRow(args, repo, item)
  if (!got) return false
  const details = (Array.isArray(got.row.details) ? got.row.details : []) as BoardDetail[]
  return intermediateCommands(item, details, got.steps, args.pr, note, got.row['merged-pr']).every((cmd) => board(args, repo, cmd))
}

// 마일스톤 항목(stages 칸이 있다)에 머지와 배포를 반영한다(lib/milestones.ts 의 mergedCommands). 배포가 성공했으면 [deploy] 단계까지 끝낸다.
// 마지막 PR 이 done 지점에 닿았으면 done 이다. 결과는 done, doing, 실패(false) 셋이다
function setBoardMilestone(args: Args, repo: string, item: string, stages: Stages, deploy: Deploy, last: boolean, note: string | null): 'done' | 'doing' | false {
  let doneAfter: StageKind | null
  try {
    doneAfter = boardSettings(repo).doneAfter
  } catch (e) {
    log(`보드 설정을 읽지 못했다: ${(e as Error).message}`)
    return false
  }
  const got = boardRow(args, repo, item)
  if (!got) return false
  const made = mergedCommands({ ...got.row, id: item }, got.steps, stages, args.pr, deploy === 'success' ? 'deploy' : 'merge', { last, doneAfter, note })
  if (!made.cmds.every((cmd) => board(args, repo, cmd))) return false
  return made.done ? 'done' : 'doing'
}

function failLabel(r: FireResult): string {
  if (r.code !== null) return String(r.code)
  return r.result === 'timeout' ? 'timeout' : 'lock'
}

async function finish(args: Args, repo: string): Promise<number> {
  const merged = await waitMerged(args, repo)
  if (merged === null) return fail()
  const { merge, branch, title } = merged
  log(`PR ${args.pr} 머지됨 ${merge.slice(0, 9)} (${branch})`)

  // 보드 항목을 워크트리 이름으로도 찾는다. 정리가 워크트리를 지우므로 그 전에 읽는다
  const worktree = branch ? worktreePath(repo, branch) : null
  if (worktree && args.run) await tellMerged(args, args.run, worktree, merge)
  if (!(await cleanupWorker(args, repo, branch))) {
    log(`정리 남음: ${branch} 의 워크트리나 로컬 브랜치가 남았다. cleanup-sweep.ts 출력을 본다`)
  }

  let deploy: Deploy = 'none'
  if (args.deployWorkflow) {
    const got = await waitDeployed(args, repo, merge)
    deploy = got.deploy
    if (deploy === 'success') log(`배포 성공 ${got.sha.slice(0, 9)}`)
    else if (deploy === 'failure') log(`배포 실패 ${got.sha.slice(0, 9)}`)
    else log('배포를 기다리다 시간이 지났다')
  }
  const deployed = deploy === 'success' || deploy === 'none'

  const verdict = judgeLast(args, repo, merged)
  const last = verdict.last
  log(`마지막 PR 판정: ${last ? '마지막' : '중간'}(${verdict.reason})`)
  deleteConflictSpecs(args, repo)
  if (args.specsDir) {
    if (last) deleteBranchSpecs(args, repo, branch)
    else log('지시서 유지: 업무의 마지막 PR 이 아니다')
  }

  const problems: string[] = []
  let number: string | null = null
  if (last && deployed) {
    if (!args.completeCmd) log('업무 완료 단계 건너뜀: --complete-cmd 가 없다')
    else {
      number = extractTaskNumber(title, args.taskPattern as RegExp)
      if (number === null) problems.push(`PR 제목에서 업무 번호를 찾지 못했다: ${title}`)
    }
  }
  const legacy =
    number !== null && args.completeCmd
      ? { key: LEGACY_KEY, argv: shSplit(args.completeCmd).map((part) => part.replaceAll('{number}', number as string)), env: {} }
      : undefined
  // 옛 명령은 업무 완료 명령 출력의 마지막 줄을 결과 줄에 붙였다. 출력은 접두를 붙여 그대로 내고 마지막 줄만 기억한다
  let lastLine = ''
  const input = { pr: merged.pr, merge_commit: merge || null, deploy, last_of_task: last }
  try {
    const result = await fire('after-deploy', input, {
      repo,
      base: merged.base || args.baseBranch || '',
      run: args.run,
      legacy,
      out: (line) => {
        out(line)
        if (line.startsWith(HOOK_PREFIX) && line.slice(HOOK_PREFIX.length).trim()) lastLine = line.slice(HOOK_PREFIX.length).trim()
      },
    })
    const failed = result.result === 'fail' || result.result === 'timeout'
    if (legacy && result.result === 'pass') log(`업무 ${number} 완료 처리: ${lastLine}`)
    else if (legacy && failed) problems.push(`업무 ${number} 완료 명령이 실패했다(종료 코드 ${failLabel(result)}): ${lastLine}`)
    else if (failed) problems.push('after-deploy 핸들러가 실패했다')
  } catch (e) {
    process.stderr.write(`after-deploy 를 내지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
    out('HOOK-FAIL after-deploy error')
    problems.push(legacy ? `업무 ${number} 완료 명령을 돌리지 못했다` : 'after-deploy 핸들러가 실패했다')
  }

  if (!deployed) return fail(problems.join('; '))
  const item = args.boardId ? { id: args.boardId, by: 'id' as const } : pickBoardItem(args, repo, branch, worktree ? basename(worktree) : null)
  const stages = item && item.by !== 'id' ? milestoneStages(args, repo, item.id) : null
  if (item && taggedBoardItem(args, repo, item.id)) {
    log(`보드 ${item.id} 는 사건 꼬리표가 있어 board-sync 에 맡긴다`)
  } else if (item && stages) {
    // 마일스톤 항목은 done 지점에 닿을 때까지 doing 으로 둔다. 중간 PR 은 merged-pr 에 쌓아 board-sync 가 다시 판정하지 않는다.
    // 판정하지 못한 PR 은 board-sync 와 같이 마지막으로 본다. done 지점 전이면 doing 으로 남아 업무 완료로 번지지 않는다
    const boardLast = last || !verdict.known
    const result = setBoardMilestone(args, repo, item.id, stages, deploy, boardLast, boardLast ? null : noteLine(verdict.prs, verdict.specs))
    if (result === 'done') log(`보드 ${item.id} done${item.by === 'branch' ? '(브랜치로 찾았다)' : ''}`)
    else if (result === 'doing') log(`보드 ${item.id} 는 ${boardLast ? 'done 지점 전이라' : '중간 PR 이라'} 단계만 끝내고 PR ${args.pr} 를 merged-pr 에 적었다`)
    else problems.push(`보드 ${item.id} 에 PR ${args.pr} 를 반영하지 못했다`)
  } else if (item && (last || item.by === 'id')) {
    if (setBoardDone(args, repo, item.id)) log(`보드 ${item.id} done${item.by === 'branch' ? '(브랜치로 찾았다)' : ''}`)
    else problems.push(`보드 ${item.id} 를 done 으로 바꾸지 못했다`)
  } else if (item) {
    // 중간 PR 은 merged-pr 에 적어 board-sync 가 다시 판정하지 않게 한다. 다시 판정하면 PR~ 를 덮는다
    if (setBoardIntermediate(args, repo, item.id, noteLine(verdict.prs, verdict.specs))) {
      log(`보드 ${item.id} 는 중간 PR 이라 done 으로 바꾸지 않고 PR ${args.pr} 를 merged-pr 에 적었다`)
    } else problems.push(`보드 ${item.id} 에 중간 PR 을 적지 못했다`)
  }
  if (problems.length > 0) return fail(problems.join('; '))
  out('FINISH-DONE')
  return 0
}

async function main(argv: string[]): Promise<number> {
  let args: Args | null
  try {
    args = parse(argv)
  } catch (e) {
    if (!(e instanceof Usage) && !(e instanceof ConfigError)) throw e
    process.stderr.write(`finish-pr: ${e.message}\n`)
    return 2
  }
  if (args === null) {
    out(usageText())
    return 0
  }
  if (!args.config && !requireMigrated(args.repo, 'finish-pr')) return 2
  try {
    if (args.completeCmd) checkLegacy('after-deploy', args.repo, LEGACY_KEY)
    // after-deploy 는 머지와 배포를 기다린 뒤에 난다. 시간 제한 값이 틀린 것을 그때 알면 정리와 배포가 이미 끝났다
    if (args.completeCmd || handlerFile('after-deploy', args.repo)) eventTimeoutSec('after-deploy', args.repo)
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    process.stderr.write(`finish-pr: ${e.message}\n`)
    return 2
  }
  if (args.ghHost) process.env.GH_HOST = args.ghHost
  const repo = real(args.repo)
  const pidFile = args.pidFile
  if (pidFile) {
    mkdirSync(dirname(resolve(pidFile)), { recursive: true })
    writeFileSync(pidFile, String(process.pid))
  }
  try {
    return await finish(args, repo)
  } finally {
    if (pidFile) {
      try {
        unlinkSync(pidFile)
      } catch {
        // 이미 없으면 지울 것이 없다
      }
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`)
    process.exitCode = 1
  },
)
