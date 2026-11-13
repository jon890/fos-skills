// 사용 한도로 멈췄거나 재부팅으로 끊긴 worker 를 같은 워크트리에서 claude --resume / codex resume 으로 다시 띄워 같은 Task 에 잇는다.
// 사용법: resume-worker.ts --dispatch ID [--run ID] [--repo DIR] [--timeout-ms N]   (진입점: orch worker resume --dispatch <id>)
// 계약은 docs/features/limit-resume/spec.md 와 design.md 다. 세션 찾기와 실행 줄은 lib/resume.ts, 새 터미널 쪽은 resume-exec.ts 가 맡는다.
//
// 차례:
//     1. 잠금을 잡고 대상을 판정한다. limited 면 옛 화면 끝 20줄을 RESUME-SCREEN 으로 남긴다
//     2. request.json 을 쓰고 같은 워크트리에 새 터미널을 연다. 그 셸이 `node resume-exec.ts <폴더> && . <폴더>/launch.sh` 를 돈다.
//        Codex 면 새 터미널의 셸이 PATH 로 orch 를 못 찾으면(lib/worker-path.ts) 그 줄 앞에 `export PATH=~/.local/bin:"$PATH";` 를 더한다. 깔린 사본도 없으면 find 단계로 멈춘다
//     3. 새 터미널의 실행기가 자기 계정 환경에서 찾은 세션(found.json)을 기다린다(시한의 3할)
//     4. limited 면 옛 dispatch 를 abandon 하고 옛 터미널을 닫는다
//     5. 이번 실행의 nonce 를 담은 go 를 쓴다. 이때부터 셸이 exec 로 에이전트가 되어 세션에 붙는다. 옛 터미널을 닫은 뒤라 한 세션에 두 프로세스가 붙지 않는다
//     6. 새 터미널의 agentIdentity 가 요청 에이전트이고 화면이 idle, error, interrupted 가 될 때까지 기다린다
//        (resume 한 화면은 앞 대화의 한도 오류 줄이 다시 그려져 error 로 보일 수 있다)
//     7. worker-start --task <T> --terminal <새> --worktree path:<W> --run <Run> 으로 같은 Task 에 잇는다.
//        Task 가 failed, blocked 면 --retry-of <옛 dispatch> 를 붙인다
//     8. launched-workers 기록(실행 설정 agent, model, effort 포함)을 쓰고 RESUMED 를 낸다. 요청 폴더를 지운다. 실패하면 진단을 위해 남긴다
// Run 은 옛 dispatch 의 runId 다. --run 을 주면 그 값과 같은지만 본다. 다른 Run 의 worker 를 지금 Run 으로 잇지 않는다.
//
// 실행 설정은 그 dispatch 의 launched-workers 기록(앞 resume 이 적은 것)을 먼저, 없으면 worker-show 의 launch.effective, requested 를 본다.
// 대상 판정(worker-show, task-list, dispatch-show, terminal list):
//     limited  살아 있는 dispatch, 터미널이 열려 있고 화면이 사용 한도 안내(lib/sessions.ts 의 limitedScreen)    1~8 전부
//     restart  failed dispatch, Task 가 ready, 그 Task 의 마지막 dispatch, 그 터미널이 열려 있지 않음          화면·abandon·닫기 건너뜀
//     settled  abandoned dispatch, 그 Task 의 마지막 dispatch, 그 터미널이 열려 있지 않음(앞 실행이 정리한 뒤 실패) 화면·abandon·닫기 건너뜀
//     그 밖(정상 작업 중인 dispatch, 터미널이 열린 failed·abandoned, 구조화 worker, claude·codex 밖의 에이전트, 더 새 dispatch)은 거부한다.
//
// 출력 줄:
//     RESUME-TARGET <dispatch> kind=<limited|restart|settled> task=<Task> worktree=<경로> agent=<claude|codex>
//     RESUME-SCREEN 과 들여 쓴 줄          옛 터미널 화면 끝 20줄(limited 만). 닫기 전에 남긴다
//     RESUME-SESSION <세션 id> home=<기록 폴더> terminal=<새 터미널>
//     RESUME-WARN <이유>                   진행은 하지만 알릴 것
//     RESUMED <새 dispatch> <새 터미널> <세션 id>   성공. 종료 코드 0
//     RESUME-FAIL <단계> <이유> 다음 NEXT <명령>    실패
//
// 단계별 실패(단계: 종료 코드 / 옛 dispatch / 새 터미널 / NEXT):
//     target       3, 조회 실패는 1 / 그대로 / 없음 / 대상이 아닌 이유에 맞는 명령(orch worker adopt, 열린 터미널 확인)
//     find         3 / 그대로 / 닫는다 / 계정을 옛 worker 의 계정으로 되돌린 뒤 같은 명령, 안 되면 launch.md 「끊긴 worker 다시 띄우기」.
//                  새 터미널을 열지 못한 것도 이 단계다(NEXT 는 같은 명령)
//     cleanup      3 / abandon 이 실패했으면 그대로 / 닫는다 / 같은 명령(옛 터미널 닫기가 실패했으면 그것부터)
//     start-agent  3 / 정리됨 / 닫는다 / 같은 명령(정리된 dispatch 를 settled 로 받는다)
//     link         1 / 정리됨 / 닫지 않고 handle 을 낸다 / orch worker launch --task … -- --terminal <새> 하나. 같은 명령은 안내하지 않는다.
//                  잇기 전 Task 상태를 읽지 못한 것도 이 단계다(NEXT 는 상태 확인 뒤 worker-start)
//     3~6 단계에서 새 터미널을 닫지 못하면 RESUME-WARN 으로 그 handle 을 알린다. 잇기 뒤 기록 실패는 RESUME-WARN 으로 내고 RESUMED 를 낸다.
// 사용법 오류는 2 다. 재시도와 자동 대체(새 worker 띄우기)는 하지 않는다.
//
// 잠금(<orch 루트>/state/resume/<dispatch>/lock): 이미 있으면 그 pid 가 살아 있거나 그 terminal 이 열려 있을 때 RESUME-FAIL target 이다.
// 둘 다 아니면 옛 폴더를 비우고 새로 잡는다. 회수는 reclaim 파일을 잡은 실행 하나만 한다. 그래서 link 실패로 남은 터미널이 열려 있는 동안 같은 세션에 두 번째 프로세스를 띄우지 않는다.

import { closeTerminal as closeOrcaTerminal } from '../lib/orca.ts'
import { alive } from '../lib/process.ts'
import { objectOr } from '../core/json.ts'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { orchWord } from '../lib/commands.ts'
import { real } from '../lib/fs.ts'
import { mainCheckout } from '../lib/git.ts'
import { readLaunch, recordLaunch } from '../lib/launched.ts'
import { orca, orcaJson } from '../lib/orca.ts'
import { emit } from '../lib/output.ts'
import { ensure } from '../lib/paths.ts'
import { run } from '../lib/proc.ts'
import { shQuote } from '../lib/py.ts'
import { FOUND, GO, LOCK, readFound, writeRequest } from '../lib/resume.ts'
import type { Agent } from '../lib/resume.ts'
import { classify, screenLines, screenTail } from '../lib/screen.ts'
import { checkWorkerOrch, installedLauncherDir } from '../lib/worker-path.ts'
import { isStructured, limitedScreen, terminalRows } from '../lib/sessions.ts'
import { LIVE_DISPATCH, worktreePaths } from '../lib/workers.ts'

type Json = Record<string, unknown>
type Kind = 'limited' | 'restart' | 'settled'
type Stage = 'target' | 'find' | 'cleanup' | 'start-agent' | 'link'

const USAGE = '사용법: resume-worker.ts --dispatch ID [--run ID] [--repo DIR] [--timeout-ms N]'
const DEFAULT_TIMEOUT_MS = 100_000
// 실행기는 코디네이터의 시한보다 이만큼 더 go 를 기다린다. 코디네이터가 시한 끝에 go 를 써도 실행기가 먼저 포기하지 않게 한다
const GO_GRACE_MS = 30_000
const SCREEN_TAIL = 20
const READY_STATES = new Set(['idle', 'error', 'interrupted'])
const POLL_MS = 250
const AGENT_POLL_MS = 1_000

class Fail extends Error {
  readonly stage: Stage
  readonly next: string
  readonly code: number
  constructor(stage: Stage, reason: string, next: string, code = 3) {
    super(reason)
    this.stage = stage
    this.next = next
    this.code = code
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
function pidAlive(pid: unknown): boolean {
  return typeof pid === 'number' && alive(pid)
}

function openHandles(): Set<string> {
  return new Set(terminalRows().filter((t) => t.connected !== false && t.status !== 'exited').map((t) => text(t.handle)).filter(Boolean))
}

function screenOf(handle: string): string[] | null {
  const got = orcaJson<Json>(['terminal', 'read', '--terminal', handle, '--screen', '--limit', '40'])
  return got.ok ? screenTail(screenLines(got.data), SCREEN_TAIL) : null
}

// 옛 에이전트(claude)의 --plugin-dir. 자기 사용자의 프로세스 가운데 환경의 ORCA_TERMINAL_HANDLE 이 옛 터미널인 claude 를 고르고,
// 그 pid 의 실행 줄(환경 없이 다시 읽는다)에서 값을 읽는다. 환경 문자열은 대조에만 쓰고 출력하거나 남기지 않는다.
// Orca 의 terminal show 에 프로세스 id 가 없어 터미널에서 프로세스로 바로 가지 못한다(Orca 1.4.247 실측). 못 읽으면 null
function oldPluginDir(handle: string): string | null {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : null
  if (!uid) return null
  const listed = run(['ps', '-E', '-U', uid, '-o', 'pid=,command='])
  if (listed.code !== 0) return null
  const mark = `ORCA_TERMINAL_HANDLE=${handle}`
  for (const line of listed.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m || !/^(?:\S*\/)?claude\s/.test(m[2])) continue
    const at = m[2].indexOf(mark)
    if (at < 0 || !/^(?:\s|$)/.test(m[2].slice(at + mark.length))) continue
    const command = run(['ps', '-o', 'command=', '-p', m[1]])
    if (command.code !== 0) continue
    const dir = /--plugin-dir\s+(.+?\/orca-agent-view)(?=\s|$)/.exec(command.stdout) ?? /--plugin-dir\s+(\S+)/.exec(command.stdout)
    if (dir) return dir[1]
  }
  return null
}

type Target = {
  kind: Kind; dispatch: string; task: string; run: string; worktree: string; agent: Agent; model: string; effort: string | null
  oldTerminal: string | null; screen: string[]
}

function targetFail(reason: string, next: string, code = 3): Fail {
  return new Fail('target', reason, next, code)
}

function lookup<T>(args: string[]): T {
  const got = orcaJson<T>(args)
  if (!got.ok) throw targetFail(got.error, `orca 상태를 확인한 뒤 같은 명령`, 1)
  return got.data
}

function judge(dispatchId: string, runFlag: string | undefined, repo: string): Target {
  const shown = objectOr(lookup<Json>(['orchestration', 'worker-show', '--dispatch', dispatchId]))
  const dispatch = objectOr(shown.dispatch)
  const worker = objectOr(shown.worker)
  const options = objectOr(worker.startOptions)
  const runId = text(dispatch.runId)
  const task = text(dispatch.taskId)
  const status = text(dispatch.status)
  const adopt = `${orchWord()} worker adopt --repo ${shQuote(repo)}`
  if (!runId || !task) throw targetFail(`dispatch ${dispatchId} 의 Run 이나 Task 를 읽지 못했다`, adopt)
  if (runFlag && runFlag !== runId) throw targetFail(`--run ${runFlag} 이 dispatch 의 Run ${runId} 과 다르다`, `${orchWord()} worker resume --dispatch ${shQuote(dispatchId)}`)
  const handle = text(worker.agentTerminalHandle) || text(dispatch.assigneeHandle) || text(objectOr(shown.terminal).handle) || null
  if (isStructured(handle ?? '', options)) throw targetFail('구조화 worker 는 터미널이 없어 resume 대상이 아니다', 'references/launch.md 「끊긴 worker 다시 띄우기」')
  const launch = objectOr(options.launch)
  const effective = objectOr(launch.effective)
  const requested = objectOr(launch.requested)
  // worker resume 이 `worker-start --terminal` 로 이은 dispatch 는 Orca 가 실행 설정을 모른다. 그때 적어 둔 기록을 먼저 본다
  const recorded = readLaunch(repo, dispatchId)
  const agent = recorded?.agent || text(effective.agent) || text(requested.agent) || text(options.agent)
  const model = recorded?.model || text(effective.model) || text(requested.model)
  const effort = (recorded?.agent ? recorded.effort : null) || text(effective.effort) || text(requested.effort) || null
  if (agent !== 'claude' && agent !== 'codex') throw targetFail(`에이전트 ${agent || '-'} 는 resume 대상이 아니다(claude, codex 만)`, 'references/launch.md 「끊긴 worker 다시 띄우기」')
  if (!model) throw targetFail('dispatch 의 launch 기록에 모델이 없다', 'references/launch.md 「끊긴 worker 다시 띄우기」')
  const worktreeId = text(worker.worktreeId) || text(options.resolvedWorktreeId)
  const raw = worktreeId.includes('::') ? worktreeId.slice(worktreeId.indexOf('::') + 2) : text(options.worktree).replace(/^path:/, '')
  if (!raw || !existsSync(raw)) throw targetFail(`dispatch 의 워크트리 ${raw || '-'} 가 없다`, adopt)
  const worktree = real(resolve(raw))
  const open = openHandles()
  const oldOpen = !!handle && open.has(handle)
  const tasks = objectOr(lookup<Json>(['orchestration', 'task-list', '--run', runId])).tasks
  const taskStatus = text(objectOr((Array.isArray(tasks) ? tasks : []).find((t) => objectOr(t).id === task)).status)
  const latest = objectOr(objectOr(lookup<Json>(['orchestration', 'dispatch-show', '--task', task])).dispatch)
  if (text(latest.id) !== dispatchId) throw targetFail(`같은 Task 에 더 새 dispatch ${text(latest.id) || '-'} 가 있다`, `${orchWord()} worker resume --dispatch ${shQuote(text(latest.id) || dispatchId)} 또는 ${adopt}`)
  const base = { dispatch: dispatchId, task, run: runId, worktree, agent: agent as Agent, model, effort, oldTerminal: handle }
  if (LIVE_DISPATCH.has(status)) {
    if (!oldOpen) throw targetFail('살아 있는 dispatch 인데 터미널이 열려 있지 않다', adopt)
    const screen = screenOf(handle!)
    if (screen === null) throw targetFail(`옛 터미널 ${handle} 의 화면을 읽지 못했다`, `orca terminal read --terminal ${shQuote(handle!)} --screen`, 1)
    if (!limitedScreen(screen)) throw targetFail('살아 있는 dispatch 가 사용 한도 화면에서 멈춰 있지 않다(정상 작업 중일 수 있다)', adopt)
    return { ...base, kind: 'limited', screen }
  }
  if (oldOpen) throw targetFail(`${status} dispatch 의 터미널 ${handle} 이 아직 열려 있다. 같은 세션에 두 프로세스가 붙지 않게 거부한다`, `orca terminal close --terminal ${shQuote(handle!)} 뒤 같은 명령, 또는 ${adopt}`)
  if (status === 'failed' && taskStatus === 'ready') return { ...base, kind: 'restart', screen: [] }
  if (status === 'abandoned') return { ...base, kind: 'settled', screen: [] }
  throw targetFail(`dispatch 상태 ${status || '-'}, Task 상태 ${taskStatus || '-'} 는 resume 대상이 아니다`, adopt)
}

// 잠금. 앞 실행이 살아 있거나 그 결과 터미널이 열려 있으면 거부한다.
// 낡은 잠금의 회수는 reclaim 파일(O_EXCL)을 잡은 실행 하나만 하고, 잡은 뒤 잠금을 다시 읽어 판정한다.
// 두 실행이 같은 낡은 잠금을 읽고 차례로 지우면 뒤 실행이 앞 실행의 새 잠금까지 지워 같은 세션을 둘이 띄운다(PR #359 리뷰)
const RECLAIM = 'reclaim'

function tryLock(file: string): boolean {
  try {
    const fd = openSync(file, 'wx')
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), terminal: null }))
    closeSync(fd)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return false
  }
}

function readJson(file: string): Json {
  try {
    return objectOr(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // 쓰다 만 파일은 pid 와 터미널이 없는 것으로 본다
    return {}
  }
}

function lock(dir: string): void {
  const file = join(dir, LOCK)
  mkdirSync(dir, { recursive: true })
  if (tryLock(file)) return
  const guard = join(dir, RECLAIM)
  if (!tryLock(guard)) {
    const other = readJson(guard)
    throw targetFail(pidAlive(other.pid) ? '다른 실행이 낡은 잠금을 정리하고 있다' : `낡은 잠금을 정리하던 실행이 끝나지 않고 사라졌다(${guard})`,
      pidAlive(other.pid) ? '그 실행이 끝난 뒤 같은 명령' : `앞 실행의 터미널이 남지 않았는지 확인하고 rm ${shQuote(guard)} 뒤 같은 명령`)
  }
  try {
    // 회수 권한을 잡은 뒤의 잠금이 판정 대상이다. 그사이 다른 실행이 새로 잡았을 수 있다
    const held = readJson(file)
    const terminal = text(held.terminal)
    let open: Set<string>
    try {
      open = openHandles()
    } catch (error) {
      throw targetFail(`터미널 목록을 읽지 못했다: ${(error as Error).message}`, 'orca 상태를 확인한 뒤 같은 명령', 1)
    }
    if (pidAlive(held.pid) || (terminal && open.has(terminal))) {
      throw targetFail(`앞 실행이 진행 중이거나 결과 터미널 ${terminal || '-'} 이 열려 있다`,
        terminal ? `orca terminal read --terminal ${shQuote(terminal)} --screen 로 확인하고, 에이전트가 붙어 있으면 그 터미널로 잇는다` : '앞 실행이 끝날 때까지 기다린 뒤 같은 명령')
    }
    for (const name of readdirSync(dir)) if (name !== RECLAIM) rmSync(join(dir, name), { recursive: true, force: true })
    if (!tryLock(file)) throw targetFail('잠금을 잡지 못했다', '같은 명령')
  } finally {
    rmSync(guard, { force: true })
  }
}

function setLockTerminal(dir: string, terminal: string): void {
  const file = join(dir, LOCK)
  const held = objectOr(JSON.parse(readFileSync(file, 'utf8')))
  writeFileSync(file, JSON.stringify({ ...held, terminal }))
}

// 새 터미널을 닫는다. 닫지 못하면 남은 handle 을 알린다(그 터미널에 resume 한 에이전트가 붙어 있을 수 있다)
function closeNewTerminal(handle: string): void {
  if (!closeOrcaTerminal(handle, { checkResponse: false })) emit(`RESUME-WARN 새 터미널 ${handle} 을 닫지 못했다. orca terminal close --terminal ${shQuote(handle)} 로 닫는다`)
}

// 3~6 단계의 Fail 이 아닌 예외를 그 단계 이름으로 감싼다
function asStage(stage: Stage, error: unknown, next: string): Fail {
  return error instanceof Fail ? error : new Fail(stage, (error as Error).message, next)
}

async function waitFound(dir: string, until: number) {
  for (;;) {
    const found = existsSync(join(dir, FOUND)) ? readFound(dir) : null
    if (found) return found
    if (Date.now() > until) return null
    await sleep(POLL_MS)
  }
}

async function waitAgent(handle: string, agent: Agent, until: number): Promise<{ ready: boolean; state: string; lines: string[] }> {
  let state = 'unknown'
  let lines: string[] = []
  for (;;) {
    let identity: unknown = null
    try {
      identity = terminalRows().find((t) => t.handle === handle)?.agentIdentity ?? null
    } catch {
      identity = null
    }
    if (identity === agent) {
      lines = screenOf(handle) ?? lines
      state = classify(lines)
      if (READY_STATES.has(state)) return { ready: true, state, lines }
    } else {
      state = `agentIdentity=${identity === null ? '-' : String(identity)}`
    }
    if (Date.now() > until) return { ready: false, state, lines }
    await sleep(AGENT_POLL_MS)
  }
}

async function resume(dispatchId: string, runFlag: string | undefined, repo: string, timeoutMs: number): Promise<number> {
  const started = Date.now()
  const deadline = started + timeoutMs
  const again = `${orchWord()} worker resume --dispatch ${shQuote(dispatchId)}`
  const dir = join(ensure('state', repo), 'resume', dispatchId)
  lock(dir)
  const target = judge(dispatchId, runFlag, repo)
  emit(`RESUME-TARGET ${dispatchId} kind=${target.kind} task=${target.task} worktree=${target.worktree} agent=${target.agent}`)
  if (target.kind === 'limited') emit(['RESUME-SCREEN', ...target.screen.map((line) => `  ${line}`)].join('\n'), [], { fix: true })
  const pluginDir = target.kind === 'limited' && target.agent === 'claude' && target.oldTerminal ? oldPluginDir(target.oldTerminal) : null
  // 2. 요청을 쓰고 새 터미널을 연다
  for (const name of [FOUND, GO]) rmSync(join(dir, name), { force: true })
  const nonce = randomUUID()
  writeRequest(dir, { dispatch: dispatchId, worktree: target.worktree, agent: target.agent, model: target.model, effort: target.effort, pluginDir, goDeadline: deadline + GO_GRACE_MS, nonce })
  const execPath = join(dirname(import.meta.filename), 'resume-exec.ts')
  // 새 터미널의 셸이 PATH 로 orch 를 못 찾으면, 이 명령줄이 PATH 앞에 ~/.local/bin 을 더한다(launch.sh 를 셸에 source 하므로 에이전트가 이어받는다)
  // Claude worker 는 --plugin-dir 로 플러그인 bin/ 이 PATH 에 들어가 더하지 않는다
  const onPath = target.agent === 'claude' ? { ok: true as const } : checkWorkerOrch()
  let pathPrefix = ''
  if (!onPath.ok) {
    const dir = installedLauncherDir()
    if (!dir) throw new Fail('find', `새 터미널에서 orch 를 부를 수 없다. ${onPath.reason}`, `${orchWord()} doctor install-cli && ${again}`)
    pathPrefix = `export PATH=${shQuote(dir)}:"$PATH"; `
  }
  const command = `${pathPrefix}${shQuote(process.execPath)} --disable-warning=ExperimentalWarning ${shQuote(execPath)} ${shQuote(dir)} && . ${shQuote(join(dir, 'launch.sh'))}`
  const created = orcaJson<Json>(['terminal', 'create', '--worktree', `path:${target.worktree}`, '--title', 'resume', '--command', command])
  const fresh = created.ok ? text(objectOr(created.data.terminal).handle) || text(created.data.handle) : ''
  if (!fresh) throw new Fail('find', `새 터미널을 열지 못했다: ${created.ok ? '응답에 handle 이 없다' : created.error}`, again)
  setLockTerminal(dir, fresh)
  let session = ''
  let stage: Stage = 'find'
  try {
    // 3. 새 터미널의 실행기가 찾은 세션
    const found = await waitFound(dir, started + Math.floor(timeoutMs * 0.3))
    if (!found || !found.ok) {
      throw new Fail('find', found ? found.reason : '새 터미널의 실행기가 시한 안에 결과를 쓰지 않았다',
        `계정을 옛 worker 의 계정으로 되돌린 뒤 ${again}. 안 되면 references/launch.md 「끊긴 worker 다시 띄우기」 로 새 worker 와 재개 절`)
    }
    session = found.session
    emit(`RESUME-SESSION ${session} home=${found.home} terminal=${fresh}`)
    // 4. 옛 dispatch 정리
    stage = 'cleanup'
    if (target.kind === 'limited') {
      const abandoned = orcaJson<Json>(['orchestration', 'worker-abandon', '--dispatch', dispatchId])
      if (!abandoned.ok) throw new Fail('cleanup', `옛 dispatch 를 abandon 하지 못했다: ${abandoned.error}`, again)
      const closed = closeOrcaTerminal(target.oldTerminal!, { mode: 'result' })
      if (!closed.ok) throw new Fail('cleanup', `옛 터미널을 닫지 못했다: ${closed.error}`, `orca terminal close --terminal ${shQuote(target.oldTerminal!)} && ${again}`)
    }
    // 5. 출발 신호
    // 내용은 이번 실행의 nonce 다. 앞 실행의 고아 실행기는 이 go 로 출발하지 않는다
    stage = 'start-agent'
    writeFileSync(join(dir, GO), nonce)
    // 6. 에이전트 준비
    const ready = await waitAgent(fresh, target.agent, deadline)
    if (!ready.ready) {
      throw new Fail('start-agent', `시한 안에 ${target.agent} 가 입력을 받을 화면이 되지 않았다(마지막 상태 ${ready.state})${ready.lines.length ? `\n${ready.lines.map((l) => `  ${l}`).join('\n')}` : ''}`, again)
    }
  } catch (error) {
    // 3~6 단계의 실패는 새 터미널을 닫아 남는 자원이 없게 한다
    closeNewTerminal(fresh)
    throw asStage(stage, error, again)
  }
  // 7. 같은 Task 에 잇는다. 실패하면 연결이 이미 일어났을 수 있어 터미널을 닫지 않고 재시도하지 않는다
  const recoverySpec = readLaunch(repo, dispatchId)?.spec ?? '<지시서 경로>'
  const recovery = [orchWord(), 'worker', 'launch', '--spec', recoverySpec, '--repo', repo, '--task', target.task, '--run', target.run]
  const tasks = orcaJson<Json>(['orchestration', 'task-list', '--run', target.run])
  if (!tasks.ok) {
    // Task 상태를 모르면 --retry-of 를 정하지 못한다. 터미널은 남긴다
    throw new Fail('link', `Task 상태를 읽지 못했다(터미널 ${fresh} 은 남긴다): ${tasks.error}`,
      `orca orchestration task-list --run ${shQuote(target.run)} --json 로 Task 상태를 보고, failed·blocked 면 --retry-of ${shQuote(dispatchId)} 를 -- 앞에 붙여 ${[...recovery, '--', '--terminal', fresh].map(shQuote).join(' ')}`, 1)
  }
  const taskStatus = text(objectOr((Array.isArray(tasks.data.tasks) ? tasks.data.tasks : []).find((t) => objectOr(t).id === target.task)).status)
  const retry = taskStatus === 'failed' || taskStatus === 'blocked' ? ['--retry-of', dispatchId] : []
  const startArgs = ['orchestration', 'worker-start', '--task', target.task, ...retry, '--terminal', fresh, '--worktree', `path:${target.worktree}`, '--run', target.run, '--json']
  const linkNext = [...recovery, ...retry, '--', '--terminal', fresh].map(shQuote).join(' ')
  const linked = orca(startArgs)
  let receipt: Json = {}
  try {
    receipt = objectOr(JSON.parse(linked.stdout))
  } catch {
    // 형식이 다르면 아래에서 실패로 본다
  }
  const result = objectOr(receipt.result)
  const newDispatch = text(objectOr(result.dispatch).id) || text(result.dispatchId) || text(objectOr(result.worker).dispatchId)
  if (linked.code !== 0 || receipt.ok !== true || !newDispatch) {
    // receipt 의 잔여 자원과 request id 를 자르지 않는다(adopt-sessions, launch-worker 와 같다)
    const detail = `${linked.stdout} ${linked.stderr}`.trim().replace(/\s+/g, ' ')
    throw new Fail('link', `worker-start --terminal ${fresh} 가 실패했다(터미널은 남긴다): ${detail || `종료 코드 ${linked.code}`}`, linkNext, 1)
  }
  // 8. 기록
  // 이미 이어졌으므로 기록이 실패해도 RESUMED 를 낸다. 실패로 알리면 이어진 worker 옆에 새 worker 를 띄울 수 있다
  try {
    const branch = [...worktreePaths(repo)].find(([, path]) => real(path) === target.worktree)?.[0] ?? null
    const spec = readLaunch(repo, dispatchId)?.spec ?? null
    if (!spec) emit('RESUME-WARN spec 기록 없음')
    // 실행 설정을 옮겨 적어 이 dispatch 가 다시 멈췄을 때도 resume 할 수 있게 한다
    recordLaunch(repo, { ...(readLaunch(repo, dispatchId)?.completion === 'none' ? { completion: 'none' as const } : {}), dispatch: newDispatch, task: target.task, terminal: fresh, worktree: target.worktree, branch, run: target.run, spec,
      agent: target.agent, model: target.model, effort: target.effort })
  } catch (error) {
    emit(`RESUME-WARN launched-workers 기록을 쓰지 못했다: ${(error as Error).message}`)
  }
  emit(`RESUMED ${newDispatch} ${fresh} ${session}`)
  rmSync(dir, { recursive: true, force: true })
  return 0
}

async function main(): Promise<number> {
  const options = { dispatch: { type: 'string' }, run: { type: 'string' }, repo: { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' } } as const
  let values
  try {
    values = parseArgs({ args: expandArgs(process.argv.slice(2), options), options }).values
  } catch (error) {
    process.stderr.write(`${USAGE}\n${(error as Error).message}\n`)
    return 2
  }
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  const dispatch = values.dispatch ?? ''
  // dispatch id 는 요청 폴더 경로와 재귀 삭제에 쓰인다. lib/launched.ts 와 같은 규칙이다
  if (!/^[\w.-]+$/.test(dispatch) || dispatch.startsWith('.')) {
    process.stderr.write(`${USAGE}\n--dispatch 는 영문, 숫자, _, ., - 로 된 한 단계 이름이어야 한다\n`)
    return 2
  }
  const timeoutMs = values['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(values['timeout-ms'])
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write(`${USAGE}\n--timeout-ms 는 양의 정수다\n`)
    return 2
  }
  const repo = mainCheckout(values.repo ?? process.cwd())
  try {
    return await resume(dispatch, values.run, repo, timeoutMs)
  } catch (error) {
    if (!(error instanceof Fail)) {
      emit(`RESUME-FAIL target ${(error as Error).message}`)
      emit(`NEXT orca 상태를 확인한 뒤 ${orchWord()} worker resume --dispatch ${shQuote(dispatch)}`)
      return 1
    }
    emit(`RESUME-FAIL ${error.stage} ${error.message}`, [], { fix: true })
    emit(`NEXT ${error.next}`)
    return error.code
  }
}

process.exitCode = await main()
