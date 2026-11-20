// 사용 한도에 걸린 worker 를 같은 워크트리와 지시서로 다른 에이전트나 모델로 다시 띄운다.
// 사용법: relaunch-worker.ts --dispatch ID --run ID [--repo DIR] [--dirty-ack REASON] [--working-ack REASON] [--lint-ack REASON] [--watch SEC] [--not-main REASON] -- WORKER_ARGS...
//         (진입점: orch worker relaunch --dispatch <id> -- <worker 인자>)
//
// 같은 제공자로 앞 세션을 이어 갈 수 있으면 `orch worker resume` 을 먼저 쓴다(references/agent-selection.md 「사용 한도에 걸렸을 때」).
// 이 명령은 제공자나 모델을 바꿔 새 worker 로 이어받을 때다. 새 worker 는 앞 대화를 모르므로 지시서의 재개 절은 코디네이터가 쓴다.
//
// 차례. 1~6 은 아무것도 바꾸지 않는다. 하나라도 걸리면 옛 worker 를 건드리지 않고 멈춘다.
//     잠금: 1 에서 저장소를 안 뒤 dispatch 하나에 실행 하나만 돌게 잠근다(lib/relaunch-hold.ts 의 lockRelaunch). 다른 실행이 살아 있으면 RELAUNCH-REFUSED 다
//     1. worker-show 로 옛 dispatch 의 Run, Task, 상태, 터미널, 워크트리를 읽는다
//     2. 그 Run 이 --run(진입점은 run-current 로 채운다)과 같은지 본다. 다른 Run 의 worker 는 그 Run 의 코디네이터가 다시 띄운다
//     3. 그 dispatch 의 띄우기 기록(lib/launched.ts, 없으면 lib/launch-history.ts)이 이 저장소에 있고, 기록의 워크트리가 1 의 워크트리와 같은지 본다.
//        지시서는 기록의 spec 이다. 기록이 없으면 이 Run 이 띄운 worker 인지 확인할 수 없어 멈춘다
//     4. 같은 Task 에 더 새 dispatch 가 없는지 본다(dispatch-show --task). 그것이 살아 있으면 「새 worker 가 이미 떠 있다」 로 멈춘다.
//        상태가 completed 면 다시 띄우지 않는다(`orch worker continue` 를 쓴다)
//     4-1. 살아 있는 dispatch 는 화면이 사용 한도 안내인지 본다(lib/sessions.ts 의 limitedScreen, 구조화 worker 는 structuredScreen).
//        아니거나 화면을 읽지 못하면 정상 작업 중일 수 있어 멈춘다. 일부러 바꾸는 것이면 --working-ack <이유> 로 넘긴다
//     5. 지시서의 `worker 선택:` 줄을 WORKER_ARGS 와 대조한다(launch-worker 의 selectionReject).
//        에이전트, 모델, effort 가 다르면 `RELAUNCH-FIX <지시서>:<줄 번호>` 와 고칠 줄을 내고 멈춘다. 지시서는 고치지 않는다
//        에이전트에 없는 모델과 effort(lib/model-check.ts)는 이 대조보다 먼저 거부한다. 자식이 abandon 뒤에 거부하면 옛 세션으로 돌아갈 수 없다
//     6. 워크트리에 옛 터미널 밖의 터미널이 있으면 목록을 내고 멈춘다. 커밋 안 된 변경이 있고 --dirty-ack 이 없으면 목록을 내고 멈춘다
//     6-1. launch-worker --preflight 를 자식으로 불러 띄우기 전 검사(Claude 프로필, orch PATH, `허락:` 줄, orch 폴더 이전, 설정, spec-lint)를 미리 한다.
//        걸리면 자식의 출력을 그대로 내고 RELAUNCH-REFUSED 다. before-launch 이벤트의 거부는 9 의 자식에서만 난다
//     7. 보존 표시(lib/relaunch-hold.ts)를 쓴다. 다시 띄우는 동안 cleanup 이 그 워크트리와 지시서를 지우지 않는다
//     8. 옛 dispatch 가 살아 있으면 worker-abandon 한다. 오류가 나면 worker-show 로 다시 읽어 아직 살아 있을 때만 표시를 지운다
//        (끝났거나 읽지 못하면 표시를 남긴다). 옛 터미널이 목록에 있으면(꺼진 것도) 닫는다.
//        닫은 뒤 SHELL_WAIT_MS(2초, RELAUNCH_SHELL_WAIT_MS 로 바꾼다) 동안 그 워크트리에 새로 생긴 에이전트 없는 터미널을 닫는다.
//        Orca 는 worker 터미널을 닫으면 그 탭에 빈 셸을 다시 연다(lib/idle-shells.ts). 남겨 두면 자식이 남은 터미널로 거부한다.
//        6 에서 옛 터미널 밖의 터미널이 없음을 봤으므로 그 사이에 생긴 터미널만 닫는다. 닫을 때마다 `RELAUNCH-SHELL <handle>` 을 낸다
//     9. Task 상태를 다시 읽어 failed, blocked 면 --retry-of <옛 dispatch> 를, ready 면 그것 없이(그 밖의 상태는 RELAUNCH-FAIL task)
//        launch-worker --spec <기록의 지시서> --repo <주 checkout> --task <Task> --run <Run> 을 자식으로 부른다. 자식의 출력은 그대로 낸다
//    10. 자식이 새 dispatch 를 띄웠으면(LAUNCHED 나 STALLED-START 줄) 보존 표시를 지운다. 살아 있는 새 dispatch 가 워크트리를 지킨다.
//        띄우지 못했으면 표시를 남긴다. 같은 명령을 다시 부르면 abandon 된 옛 dispatch 를 받아 8 을 건너뛰고 9 부터 한다
//
// 출력 줄:
//     RELAUNCH-TARGET <dispatch> task=<Task> status=<상태> worktree=<경로> spec=<지시서>
//     RELAUNCH-FIX <지시서>:<줄 번호> <고칠 줄>                5 에서 멈춤. 종료 코드 1
//     RELAUNCH-REFUSED <이유>                                  1~6-1 에서 멈춤(옛 worker 그대로). 종료 코드 3, 터미널과 변경 목록, 한도로 보지 않은 화면 끝은 들여 써서 뒤에 낸다
//     RELAUNCH-FAIL <단계> <이유> NEXT <명령>                  7~9 의 실패. 종료 코드 1(launch 단계는 자식의 종료 코드).
//                                                              보존 표시는 남는다(8 에서 dispatch 가 살아 있는 abandon 실패는 지운다). NEXT 는 받은 옵션을 그대로 다시 준다
//     RELAUNCHED <옛 dispatch> <새 dispatch>                   성공. 종료 코드 0. 그 앞에 자식의 LAUNCHED 줄이 있다
//     자식이 STALLED-START 로 끝나면 자식의 종료 코드(1)를 그대로 낸다
// 사용법 오류는 2 다. WORKER_ARGS 에 --terminal, --task, --retry-of 를 주면 사용법 오류다.

import { guardWrite, MAIN_GUARD_OPTIONS } from '../lib/main-guard.ts'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { objectOr } from '../core/json.ts'
import { LIVE_DISPATCH } from '../core/workers.ts'
import { expandArgs } from '../lib/args.ts'
import { orchWord, scriptPath } from '../lib/commands.ts'
import { real } from '../lib/fs.ts'
import { mainCheckout } from '../lib/git.ts'
import { checkLaunchSettings } from '../lib/model-check.ts'
import { outdatedPick, resolvedCodexModel } from '../lib/model-generation.ts'
import { pinnedSelection } from '../lib/selection.ts'
import { launchHistory } from '../lib/launch-history.ts'
import { readLaunch } from '../lib/launched.ts'
import { closeTerminal, orcaJson } from '../lib/orca.ts'
import { shortEnv } from '../lib/output.ts'
import { runAsync, scriptCommand } from '../lib/proc.ts'
import { shQuote } from '../lib/py.ts'
import { holdRelaunch, lockRelaunch, releaseRelaunch, unlockRelaunch } from '../lib/relaunch-hold.ts'
import { terminalRows } from '../lib/sessions.ts'
import { limitedScreen, structuredScreen, isStructured } from '../lib/sessions.ts'
import { screenLines } from '../lib/screen.ts'
import { selectionsOf } from '../lib/spec.ts'
import { leftTerminals, selectionReject, uncommitted } from './launch-worker.ts'

type Json = Record<string, unknown>

const USAGE = '사용법: relaunch-worker.ts --dispatch ID --run ID [--repo DIR] [--dirty-ack REASON] [--working-ack REASON] [--lint-ack REASON] [--watch SEC] [--not-main REASON] -- WORKER_ARGS...'
// 자식 launch-worker 는 워크트리 대기, worker-start, --watch 를 모두 기다린다. --watch 초에 이만큼 더 준다
const LAUNCH_MS = 900_000
const SHOWN = 50
const SCREEN_SHOWN = 8
const SHELL_WAIT_MS = 2000
const SHELL_POLL_MS = 500
const TASK_STARTABLE = new Set(['ready', 'failed', 'blocked'])

class Refused extends Error {
  detail: string[]
  constructor(reason: string, detail: string[] = []) {
    super(reason)
    this.detail = detail
  }
}

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function lookup(args: string[]): Json {
  const got = orcaJson<Json>(args)
  if (!got.ok) throw new Refused(`orca ${args.slice(0, 2).join(' ')} 를 읽지 못했다: ${got.error}`)
  return objectOr(got.data)
}

function passValue(passthru: string[], name: string): string | null {
  const at = passthru.indexOf(name)
  return at >= 0 && at + 1 < passthru.length ? passthru[at + 1] : null
}

// 지시서의 첫 `worker 선택:` 줄을 WORKER_ARGS 의 에이전트, 모델, effort 로 바꾼 줄. 행, 이유, 후보 밖 칸은 그대로 둔다.
// 바꿀 수 없으면(형식이 다른 줄) null 이다
export function fixedSelectionLine(line: string, agent: string | null, model: string | null, effort: string | null): string | null {
  const m = /^(.*?worker 선택:\s*)`([^`]*)`\s*`([^`]*)`\s*effort\s*`([^`]*)`(.*)$/.exec(line)
  if (!m || !agent || !model) return null
  return `${m[1]}\`${agent}\` \`${model}\` effort \`${effort ?? '기본'}\`${m[5]}`
}

type Target = {
  dispatch: string
  run: string
  task: string
  status: string
  terminal: string | null
  worktree: string
  repo: string
  spec: string
  shown: Json
  previous: { agent: string | null; model: string | null; effort: string | null; spec: string | null }
}

// 차례 1~4. 막으면 Refused 를 던진다
function target(dispatch: string, run: string, repoArg: string | null): Target {
  const shown = lookup(['orchestration', 'worker-show', '--dispatch', dispatch])
  const head = objectOr(shown.dispatch)
  const worker = objectOr(shown.worker)
  const options = objectOr(worker.startOptions)
  const runId = text(head.runId)
  const task = text(head.taskId)
  const status = text(head.status)
  if (!runId || !task) throw new Refused(`dispatch ${dispatch} 의 Run 이나 Task 를 읽지 못했다`)
  if (runId !== run) throw new Refused(`dispatch ${dispatch} 는 Run ${runId} 의 worker 다. 이 Run(${run})의 것이 아니라 다시 띄우지 않는다. 그 Run 의 코디네이터가 다시 띄운다`)
  const worktreeId = text(worker.worktreeId) || text(options.resolvedWorktreeId)
  const raw = worktreeId.includes('::') ? worktreeId.slice(worktreeId.indexOf('::') + 2) : text(options.worktree).replace(/^path:/, '')
  if (!raw || !existsSync(raw)) throw new Refused(`dispatch 의 워크트리 ${raw || '-'} 가 없다`)
  const worktree = real(resolve(raw))
  const repo = repoArg ? mainCheckout(repoArg) : mainCheckout(worktree)
  const recorded = readLaunch(repo, dispatch) ?? launchHistory(repo).find((row) => row.dispatch === dispatch) ?? null
  if (!recorded) throw new Refused(`이 저장소(${repo})에 dispatch ${dispatch} 의 띄우기 기록이 없다. 이 Run 이 띄운 worker 인지 확인할 수 없다`)
  if (real(recorded.worktree) !== worktree) throw new Refused(`띄우기 기록의 워크트리 ${recorded.worktree} 가 Orca 의 워크트리 ${worktree} 와 다르다`)
  if (recorded.run && recorded.run !== run) throw new Refused(`띄우기 기록의 Run ${recorded.run} 이 이 Run(${run})과 다르다`)
  const spec = recorded.spec ?? ''
  if (!spec || !existsSync(spec)) throw new Refused(`띄우기 기록의 지시서 ${spec || '-'} 가 없다. 지시서를 되살린 뒤 orch worker launch --task 로 띄운다`)
  const latest = objectOr(lookup(['orchestration', 'dispatch-show', '--task', task]).dispatch)
  if (text(latest.id) && text(latest.id) !== dispatch) {
    const newer = text(latest.id)
    if (LIVE_DISPATCH.has(text(latest.status))) throw new Refused(`새 worker 가 이미 떠 있다(같은 Task 의 dispatch ${newer}, 상태 ${text(latest.status)}). 다시 띄우지 않는다. orch worker status 로 그 worker 를 본다`)
    throw new Refused(`같은 Task 에 더 새 dispatch ${newer} 가 있다. 그 dispatch 로 다시 부른다`)
  }
  if (status === 'completed') throw new Refused(`dispatch ${dispatch} 는 completed 다. PR 이 열려 있으면 ${orchWord()} worker continue --dispatch ${shQuote(dispatch)} 를 쓴다`)
  if (!LIVE_DISPATCH.has(status) && status !== 'failed' && status !== 'abandoned') throw new Refused(`dispatch 상태 ${status || '-'} 는 다시 띄울 대상이 아니다`)
  const terminal = text(worker.agentTerminalHandle) || text(head.assigneeHandle) || recorded.terminal || null
  return {
    dispatch, run, task, status, terminal, worktree, repo, spec, shown,
    previous: { agent: recorded.agent ?? null, model: recorded.model ?? null, effort: recorded.effort ?? null, spec: recorded.spec ?? null },
  }
}

// 차례 5. 고칠 줄을 내고 멈춰야 하면 Refused 대신 RELAUNCH-FIX 줄 목록을 돌려준다. 다른 선택 문제는 Refused 다
function selectionCheck(t: Target, passthru: string[]): string[] {
  const agent = passValue(passthru, '--agent')
  const model = passValue(passthru, '--model')
  const effort = passValue(passthru, '--effort')
  const sameSpec = !t.previous.spec || real(t.previous.spec) === real(t.spec)
  const continuation = sameSpec && t.previous.agent === agent && t.previous.model === model && (t.previous.effort ?? null) === effort
  const rejected = selectionReject(t.spec, passthru, t.repo, true, continuation)
  if (!rejected) return []
  const textOf = readFileSync(t.spec, 'utf8')
  const [selection] = selectionsOf(textOf)
  const differs = !!selection && (selection.agent !== agent || selection.model !== model || (selection.effort === '기본' ? null : selection.effort) !== effort)
  if (!differs) throw new Refused(`지시서의 \`worker 선택:\` 줄이 선택 검사를 통과하지 못한다: ${rejected}`)
  const line = textOf.split('\n')[selection.no - 1] ?? ''
  const fixed = fixedSelectionLine(line, agent, model, effort)
  return [
    `RELAUNCH-FIX ${t.spec}:${selection.no} ${fixed ?? '(형식이 달라 고칠 줄을 만들지 못했다)'}`,
    `  지금 줄: ${line}`,
    `  ${rejected}`,
    '  지시서를 고친 뒤 같은 명령을 다시 부른다. 행의 후보가 아니면 `후보 밖: <이유>` 도 적는다',
  ]
}

// 차례 4-1. 살아 있는 dispatch 가 사용 한도 화면에서 멈춰 있는지. 아니면 Refused(--working-ack 이 있으면 통과)
function limitCheck(t: Target, workingAck: string | null): void {
  if (!LIVE_DISPATCH.has(t.status) || workingAck !== null) return
  const ack = '일부러 바꾸는 것이면 --working-ack <이유> 를 준다'
  const startOptions = objectOr(t.shown.worker).startOptions
  if (t.terminal && isStructured(t.terminal, startOptions)) {
    const seen = structuredScreen(t.shown)
    if (!seen.limited) throw new Refused(`살아 있는 구조화 worker 가 사용 한도로 멈추지 않았다(정상 작업 중일 수 있다). ${ack}`, seen.lines.slice(-SCREEN_SHOWN))
    return
  }
  if (!t.terminal) throw new Refused(`살아 있는 dispatch 의 터미널을 몰라 사용 한도 화면인지 볼 수 없다. ${ack}`)
  const read = orcaJson<Json>(['terminal', 'read', '--terminal', t.terminal, '--screen', '--limit', '40'])
  if (!read.ok) throw new Refused(`옛 터미널 ${t.terminal} 의 화면을 읽지 못해 사용 한도인지 볼 수 없다: ${read.error}. ${ack}`)
  const lines = screenLines(read.data)
  if (!limitedScreen(lines)) throw new Refused(`살아 있는 dispatch 가 사용 한도 화면에서 멈춰 있지 않다(정상 작업 중일 수 있다). ${ack}`, lines.filter((l) => l.trim()).slice(-SCREEN_SHOWN))
}

// 차례 8 의 빈 셸 닫기. before 는 옛 터미널을 닫기 전 목록의 handle 이다. 닫지 못한 handle 을 돌려준다
async function closeReopenedShells(worktree: string, before: Set<string>): Promise<string[]> {
  const raw = process.env.RELAUNCH_SHELL_WAIT_MS
  const wait = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : SHELL_WAIT_MS
  const deadline = Date.now() + wait
  const failed = new Set<string>()
  for (;;) {
    let rows: Json[] = []
    try {
      rows = terminalRows()
    } catch {
      rows = []
    }
    for (const row of rows) {
      const handle = text(row.handle)
      if (!handle || before.has(handle) || failed.has(handle) || row.worktreePath !== worktree || row.agentIdentity) continue
      before.add(handle)
      if (closeTerminal(handle, { mode: 'result' }).ok) out(`RELAUNCH-SHELL ${handle} Orca 가 다시 연 빈 셸을 닫았다`)
      else failed.add(handle)
    }
    const left = deadline - Date.now()
    if (left <= 0) return [...failed]
    await new Promise((done) => setTimeout(done, Math.min(SHELL_POLL_MS, left)))
  }
}

// 목록에 남은 터미널 handle. 꺼진 터미널도 센다. launch-worker 의 남은 터미널 검사(leftTerminals)가 상태를 보지 않고 세기 때문이다
function listedHandles(): Set<string> {
  return new Set(terminalRows().map((t) => text(t.handle)).filter(Boolean))
}

type Args = { dispatch: string; run: string; repo: string | null; dirtyAck: string | null; workingAck: string | null; lintAck: string | null; watch: string | null; notMain?: string; passthru: string[] }

function parse(argv: string[]): Args | 'help' | string {
  const split = argv.includes('--') ? argv.indexOf('--') : argv.length
  const passthru = argv.slice(split + 1)
  const options = {
    ...MAIN_GUARD_OPTIONS,
    dispatch: { type: 'string' },
    run: { type: 'string' },
    repo: { type: 'string' },
    'dirty-ack': { type: 'string' },
    'working-ack': { type: 'string' },
    'lint-ack': { type: 'string' },
    watch: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } as const
  let values
  try {
    values = parseArgs({ args: expandArgs(argv.slice(0, split), options, ['dirty-ack', 'working-ack', 'lint-ack']), options }).values
  } catch (e) {
    return (e as Error).message
  }
  if (values.help) return 'help'
  if (!values.dispatch) return '--dispatch 가 필요하다'
  if (!/^[\w.-]+$/.test(values.dispatch) || values.dispatch.startsWith('.')) return `dispatch id 형식이 아니다: ${values.dispatch}`
  if (!values.run) return '--run 이 필요하다. 코디네이터 터미널에서 orch worker relaunch 로 부른다'
  if (!passValue(passthru, '--agent') || !passValue(passthru, '--model')) return '-- 뒤에 새 worker 의 --agent 와 --model 을 준다'
  for (const name of ['--terminal', '--task', '--retry-of', '--worktree', '--spec']) {
    if (passthru.includes(name)) return `${name} 는 relaunch 가 정한다. -- 뒤에 주지 않는다`
  }
  const ack = (name: 'dirty-ack' | 'working-ack' | 'lint-ack') => (values[name] === undefined ? null : String(values[name]).trim())
  if (ack('dirty-ack') === '' || ack('working-ack') === '' || ack('lint-ack') === '') return '--dirty-ack, --working-ack, --lint-ack 에는 이유를 적는다'
  if (values.watch !== undefined && !/^\d+$/.test(values.watch)) return '--watch 는 초 단위 정수다'
  return {
    dispatch: values.dispatch, run: values.run, repo: values.repo ?? null, dirtyAck: ack('dirty-ack'), workingAck: ack('working-ack'), lintAck: ack('lint-ack'),
    watch: values.watch ?? null, notMain: values['not-main'], passthru,
  }
}

// 같은 명령을 다시 부르는 줄(NEXT)
function again(a: Args): string {
  const parts = [orchWord(), 'worker', 'relaunch', '--dispatch', a.dispatch]
  if (a.repo) parts.push('--repo', a.repo)
  if (a.dirtyAck) parts.push('--dirty-ack', a.dirtyAck)
  if (a.workingAck) parts.push('--working-ack', a.workingAck)
  if (a.lintAck) parts.push('--lint-ack', a.lintAck)
  if (a.watch !== null) parts.push('--watch', a.watch)
  if (a.notMain !== undefined) parts.push('--not-main', a.notMain)
  return [...parts.map((p, i) => (i === 0 ? p : shQuote(p))), '--', ...a.passthru.map(shQuote)].join(' ')
}

export async function main(argv: string[], execute: typeof runAsync = runAsync): Promise<number> {
  const a = parse(argv)
  if (a === 'help') {
    out(USAGE)
    return 0
  }
  if (typeof a === 'string') {
    process.stderr.write(`${USAGE}\nrelaunch-worker: ${a}\n`)
    return 2
  }
  let t: Target
  try {
    t = target(a.dispatch, a.run, a.repo)
  } catch (e) {
    return refused(e)
  }
  const holder = lockRelaunch(t.repo, t.dispatch)
  if (holder !== null) return refused(new Refused(`같은 dispatch 를 다시 띄우는 다른 실행(pid ${holder})이 돌고 있다. 끝난 뒤 결과를 보고 필요하면 다시 부른다`))
  try {
    return await relaunch(a, t, execute)
  } finally {
    unlockRelaunch(t.repo, t.dispatch)
  }
}

function refused(e: unknown): number {
  if (!(e instanceof Refused)) throw e
  out(`RELAUNCH-REFUSED ${e.message}`)
  for (const line of e.detail) out(`  ${line}`)
  return 3
}

// 띄우는 자식 launch-worker 의 공통 인자
function childArgs(a: Args, t: Target, retry: boolean): string[] {
  const args = ['--spec', t.spec, '--repo', t.repo, '--task', t.task, ...(retry ? ['--retry-of', t.dispatch] : []), '--run', t.run]
  if (a.lintAck) args.push('--lint-ack', a.lintAck)
  if (a.notMain !== undefined) args.push('--not-main', a.notMain)
  return args
}

function relay(result: { stdout: string; stderr: string }): void {
  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`)
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`)
}

async function relaunch(a: Args, t: Target, execute: typeof runAsync): Promise<number> {
  const launcher = process.env.LAUNCH_WORKER || scriptPath('launch-worker')
  try {
    out(`RELAUNCH-TARGET ${t.dispatch} task=${t.task} status=${t.status} worktree=${t.worktree} spec=${t.spec}`)
    // launch 는 세대를 바꾼 뒤의 모델을 띄우므로 같은 값을 검사한다. `후보 밖:` 으로 정한 모델은 그대로 검사한다(launch-worker 머리 주석의 「0-0-1」)
    const agent = passValue(a.passthru, '--agent')
    const effort = passValue(a.passthru, '--effort')
    let pinned = false
    try { pinned = pinnedSelection(readFileSync(t.spec, 'utf8')) } catch { /* 지시서 문제는 아래 선택 검사가 알린다 */ }
    const model = pinned ? passValue(a.passthru, '--model') : resolvedCodexModel(agent, passValue(a.passthru, '--model'), effort)
    const outdated = pinned ? outdatedPick(agent, model, effort) : null
    if (outdated) throw new Refused(outdated)
    const settings = checkLaunchSettings({ agent, model, effort })
    if (settings.reject) throw new Refused(settings.reject)
    limitCheck(t, a.workingAck)
    if (a.workingAck !== null && LIVE_DISPATCH.has(t.status)) out(`working-ack: ${a.workingAck}`)
    const fix = selectionCheck(t, a.passthru)
    if (fix.length) {
      for (const line of fix) out(line)
      return 1
    }
    let others: string
    try {
      others = leftTerminals(t.worktree, t.terminal ?? '')
    } catch (e) {
      throw new Refused(`남은 터미널을 확인하지 못했다: ${(e as Error).message.replace(/^거부: /, '')}`)
    }
    if (others) throw new Refused('워크트리에 옛 worker 밖의 터미널이 있다. 누구의 것인지 보고 닫은 뒤 다시 부른다', others.split('\n'))
    const dirty = uncommitted(t.worktree)
    if (dirty.length && a.dirtyAck === null) {
      const shown = dirty.slice(0, SHOWN)
      if (dirty.length > SHOWN) shown.push(`... 외 ${dirty.length - SHOWN}개`)
      throw new Refused(`워크트리에 커밋 안 된 변경이 ${dirty.length}개 있다. 새 worker 가 이어받을 변경이면 --dirty-ack <이유> 를 준다`, shown)
    }
    // 6-1. 옛 dispatch 로 이력을 찾게 --retry-of 를 준다. 띄우지 않으므로 Task 상태와 상관없다
    const pre = await execute(scriptCommand(launcher, [...childArgs(a, t, true), '--preflight', '--', ...a.passthru]), { timeoutMs: LAUNCH_MS, env: shortEnv() })
    if (pre.code !== 0 || !/^PREFLIGHT-OK$/m.test(pre.stdout)) {
      relay(pre)
      throw new Refused(`launch-worker 의 띄우기 전 검사가 종료 코드 ${pre.code} 로 멈췄다. 위 거부를 고친 뒤 같은 명령을 다시 부른다`)
    }
  } catch (e) {
    return refused(e)
  }

  const guard = guardWrite(t.repo, 'worker launch', a.notMain, { worktree: t.worktree })
  if (guard.code !== 0) return guard.code

  const next = again(a)
  try {
    holdRelaunch(t.repo, { dispatch: t.dispatch, worktree: t.worktree, spec: t.spec })
  } catch (e) {
    out(`RELAUNCH-FAIL hold 보존 표시를 쓰지 못했다: ${(e as Error).message} NEXT ${next}`)
    return 1
  }
  if (LIVE_DISPATCH.has(t.status)) {
    const abandoned = orcaJson<Json>(['orchestration', 'worker-abandon', '--dispatch', t.dispatch])
    if (!abandoned.ok) {
      // 오류여도 abandon 이 됐을 수 있다. 아직 살아 있다고 확인했을 때만 표시를 거둔다
      const reread = orcaJson<Json>(['orchestration', 'worker-show', '--dispatch', t.dispatch])
      const now = reread.ok ? text(objectOr(objectOr(reread.data).dispatch).status) : ''
      const stillLive = LIVE_DISPATCH.has(now)
      if (stillLive) releaseRelaunch(t.repo, t.dispatch)
      const kept = stillLive ? '옛 worker 는 그대로다' : `dispatch 상태 ${now || '확인 못 함'}. 워크트리 보존 표시는 남겼다`
      out(`RELAUNCH-FAIL abandon 옛 dispatch 를 abandon 하지 못했다: ${abandoned.error}. ${kept} NEXT ${next}`)
      return 1
    }
  }
  let listed: Set<string>
  try {
    listed = listedHandles()
  } catch (e) {
    out(`RELAUNCH-FAIL close 터미널 목록을 읽지 못했다: ${(e as Error).message} NEXT ${next}`)
    return 1
  }
  if (t.terminal && listed.has(t.terminal)) {
    const closed = closeTerminal(t.terminal, { mode: 'result' })
    if (!closed.ok) {
      out(`RELAUNCH-FAIL close 옛 터미널 ${t.terminal} 을 닫지 못했다: ${closed.error} NEXT orca terminal close --terminal ${shQuote(t.terminal)} 뒤 ${next}`)
      return 1
    }
    const stuck = await closeReopenedShells(t.worktree, listed)
    if (stuck.length) {
      out(`RELAUNCH-FAIL close 옛 터미널을 닫은 뒤 생긴 터미널 ${stuck.join(', ')} 을 닫지 못했다 NEXT ${stuck.map((h) => `orca terminal close --terminal ${shQuote(h)}`).join(' && ')} 뒤 ${next}`)
      return 1
    }
  }
  const tasks = orcaJson<Json>(['orchestration', 'task-list', '--run', t.run])
  const list = tasks.ok ? objectOr(tasks.data).tasks : null
  const taskStatus = text(objectOr((Array.isArray(list) ? list : []).find((row) => objectOr(row).id === t.task)).status)
  if (!taskStatus) {
    out(`RELAUNCH-FAIL task Task ${t.task} 의 상태를 읽지 못했다${tasks.ok ? '' : `: ${tasks.error}`} NEXT ${next}`)
    return 1
  }
  if (!TASK_STARTABLE.has(taskStatus)) {
    out(`RELAUNCH-FAIL task Task ${t.task} 의 상태 ${taskStatus} 에서는 다시 띄울 수 없다(ready, failed, blocked 만). 워크트리 보존 표시는 남겼다 NEXT orca orchestration task-list --run ${shQuote(t.run)} 로 상태를 본 뒤 ${next}`)
    return 1
  }
  const args = childArgs(a, t, taskStatus === 'failed' || taskStatus === 'blocked')
  if (a.watch !== null) args.push('--watch', a.watch)
  if (a.dirtyAck) args.push('--dirty-ack', a.dirtyAck)
  const launched = await execute(scriptCommand(launcher, [...args, '--', ...a.passthru]), {
    timeoutMs: Number(a.watch ?? 90) * 1000 + LAUNCH_MS,
    env: shortEnv(),
  })
  relay(launched)
  const started = /^(?:LAUNCHED|STALLED-START) (\S+)/m.exec(launched.stdout)
  if (started) {
    releaseRelaunch(t.repo, t.dispatch)
    if (launched.code === 0) out(`RELAUNCHED ${t.dispatch} ${started[1]}`)
    return launched.code
  }
  out(`RELAUNCH-FAIL launch launch-worker 가 종료 코드 ${launched.code} 로 끝나 새 worker 를 띄우지 못했다. 워크트리 보존 표시는 남겼다 NEXT ${next}`)
  return launched.code === 0 ? 1 : launched.code
}

if (import.meta.main || (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (e) => {
      process.stderr.write(`relaunch-worker: ${(e as Error)?.stack ?? String(e)}\n`)
      process.exitCode = 1
    },
  )
}
