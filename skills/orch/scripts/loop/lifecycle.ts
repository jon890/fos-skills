// 상주 루프의 시작과 멈춤, 한 저장소에 하나만 돌게 하는 잠금, 틱 자식을 띄우고 결과를 loop.json 에 합치는 부모(--foreground)다.
// 사용법과 종료 코드는 orch-loop.ts 머리 주석이, 틱 자식이 하는 일은 steps/ 의 단계 파일이 소유한다.
//
// 한 저장소에 하나: --foreground 는 시작할 때 state/loop.lock 을 wx 로 만들어 자기 pid 를 적고, 끝날 때 자기 pid 가 든 잠금만 지운다.
//     죽은 pid 의 잠금은 lib/events.ts 의 reclaim 으로 회수한다. pid 가 살아 있어도 루프 프로세스(lib/loop.ts 의 isLoopProcess)가
//     아니면 죽은 잠금으로 보고 회수한다. 죽은 루프의 pid 를 다른 프로세스가 다시 받았을 수 있다.
//     pid 가 살아 있는데 ps 로 판정할 수 없으면(isLoopProcess 가 null) 루프가 쥔 것으로 보고 회수하지 않는다. 잘못 회수하면 루프가 둘이 된다.
//     살아 있는 루프가 쥐고 있으면 LOOP-RUNNING 과 4 다.
//     --start 는 loopStatus 와 이 잠금을 함께 본다.
//
// 명의: Orca 는 orchestration 호출의 호출자를 그 프로세스가 나온 터미널로 정한다. 환경 변수를 빼도 바뀌지 않는다(실측).
//     루프는 --start 한 터미널의 명의를 물려받으므로, 그 터미널이 다른 Run 에 묶였으면 이 Run 의 질문 조회가 consumer_fenced
//     ("This caller is bound to Run X, not Run Y")로 틱마다 실패한다. 그래서 --start 는 띄우거나 합류하기 전에
//     `orca orchestration check --run <Run> --peek --types question` 을 한 번 불러 본다. 묶인 Run 은 오류 문구에서 읽고,
//     없으면 run-current 로 읽고, 그것도 못 읽으면 unknown 이다. consumer_fenced 가 아닌 실패는 명의 문제로 보지 않고 stderr 에 적고 진행한다.
//     --foreground 는 시작할 때 자기가 묶인 Run 을 loop.json 의 bound_run 에 적는다. --start 가 띄운 자식은 부모가 띄우기 전에 run-current 로
//     읽어 ORCH_LOOP_BOUND 로 넘긴 값을 쓰고 다시 조회하지 않는다. 조회가 느려도 시작 대기 한도 안에 loop.json 을 쓰게 하려는 것이다.
//     직접 띄운 --foreground 는 run-current 로 읽는다. 묶이지 않았으면 null 이고,
//     읽지 못하면 적지 않는다. 묶이지 않은 루프는 여러 Run 을 조회할 수 있어 합류를 받는다.
//
// Run(ADR-012): 루프는 lib/loop.ts 의 「Run 등록」 이 정한 Run 들을 맡는다. 앞이 주 Run 이다.
//     부모는 틱마다 등록을 읽어 loop.json 의 runs(목록)와 run(주 Run)에 적는다. 등록된 Run 이 있던 루프는 마지막 Run 이 빠지면
//     다음 틱 전에 LOOP-EMPTY 줄을 내고 0 으로 끝난다. 처음부터 등록이 없던 루프(Run 없이 띄웠다)는 --stop 까지 돈다.
//     --foreground 는 시작할 때 다른 Run 의 등록 가운데 registered_at 이 앞 loop.json 의 alive_at(앞 루프가 마지막으로 살아 있던 때)
//     이전인 것을 지우고 --run(또는 finish.run)을 등록한다. 루프가 죽은 뒤 끝난 세션의 Run 을 계속 맡지 않게 하려는 것이다.
//     그 뒤의 등록은 남긴다. 살아 있는 루프 없이 --start 한 세션은 등록의 registered_at 을 새로 쓰므로, 루프가 죽어 여러 세션이 함께
//     --start 해도 서로의 등록을 지우지 않는다. 앞 loop.json 이 없으면(alive_at 을 읽지 못하면) 지우지 않는다.
//     지운 Run 의 세션이 살아 있으면 LOOP-RESTARTED 메시지나 doctor 의 미등록 안내를 따라 다시 등록한다.
//     --stop 도 --run 이 없으면 finish.run 을 쓴다.
//
// 틱 자식: 부모는 틱 자식 하나가 끝나면 pipeline.tick_sec 을 기다린 뒤 다음 틱 자식을 띄운다. 겹치지 않는다.
//     틱을 자식 프로세스로 떼어 낸 것은 lib 의 조회(질문 조회, gh)가 동기라, 같은 프로세스에서 돌면 그동안 생존 타이머가 돌지 못해서다.
//     틱 자식은 자기 프로세스 그룹으로 띄운다(lib/proc.ts runAsync 의 group). 부모가 신호를 받으면 그 그룹 전체에 TERM 을 보내고,
//     TICK_STOP_GRACE_MS 뒤에도 그룹이 남아 있으면 KILL 을 보낸다. 이 유예는 틱 자식이 자기 자식을 끝내는 유예(lib/proc.ts 의
//     STOP_GRACE_MS)보다 길다. 같으면 틱 자식이 손자(정리 명령 같은 것)에 KILL 을 보내기 전에 부모의 KILL 이 틱 자식에 닿아 손자가 남는다.
//     부모가 KILL 로 죽으면 신호를 전하지 못한다. 그래서 틱 자식은 PARENT_POLL_MS(2초)마다 시작할 때의 부모 pid 를 보고, process.ppid 가
//     바뀌었거나 그 pid 가 죽었으면 SIGHUP 을 받은 것처럼 자기 자식을 끝내고 129 로 끝난다. 동기 조회(질문 조회, gh) 중에는 그 조회가
//     끝난 뒤에 본다. 부모가 없으면 stdout 을 읽는 쪽도 없으므로 그 뒤의 쓰기 오류(EPIPE)는 버린다.
//     틱 자식은 loop.json 을 읽기만 한다(이전 errors, ci, stalls 를 보려고). 부모가 결과 줄을 합쳐 last_tick(결과의 tick_at), ticks, errors,
//     ci 와 stalls(결과에 있을 때만 통째로 바꾼다)를 쓴다.
//     결과 줄 앞의 출력과 stderr 는 부모가 로그로 옮긴다. 결과 줄을 읽었으면 종료 코드와 상관없이 합친다. 버리면 그 틱이 이미 알린
//     CI 상태가 loop.json 에 남지 않아 다음 틱이 같은 실패를 다시 알린다. 틱 자식이 0 이 아니면 errors.tick 에 `종료 코드 <n>` 을 둔다.
//     결과 줄 없이 끝나면 last_tick 은 그대로 두고 errors.tick 에 `종료 코드 <n>`(0 이 아닐 때)이나 `결과 줄 없음` 을 둔다.
//
// 생존 타이머: 부모가 틱과 따로 ORCH_LOOP_ALIVE_SEC(양수 초, 기본 30)마다 loop.json 의 alive_at 을 쓴다. 시작할 때도 한 번 쓴다.
//     그래서 긴 틱(정리의 대기, 끝난 dispatch 이어 쓰기)도 죽은 것으로 보이지 않는다.
//
// loop.json: pid, run(주 Run), runs(등록된 Run 목록), repo, tick_sec, started_at, alive_at, last_tick, ticks, errors, ci, stalls. 시각은 ISO 8601 UTC 다. 부모만 쓴다.
//     시작할 때 앞 loop.json 의 errors, ci, stalls 를 이어받는다. 다시 띄운 루프가 같은 실패를 다시 알리지 않게 한다.

import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isObject } from '../core/json.ts'
import { envMs } from '../lib/env.ts'
import { reclaim } from '../lib/events.ts'
import { DEFAULT_ALIVE_SEC, isLoopProcess, isRegistered, lockFile, loopStatus, readLoop, registeredRuns, registerRun, unregisterRun, writeLoop } from '../lib/loop.ts'
import type { LoopState } from '../lib/loop.ts'
import { orcaJson } from '../lib/orca.ts'
import { short } from '../lib/output.ts'
import { makeParent, pathOf } from '../lib/paths.ts'
import { NO_LIMIT_MS, runAsync, scriptCommand, signalCode, STOP_GRACE_MS, stopChildren, stopping } from '../lib/proc.ts'
import type { RunResult } from '../lib/proc.ts'
import { alive } from '../lib/process.ts'
import { sendNotice } from '../lib/run-notice.ts'
import { waiterPids } from '../lib/waiters.ts'
import type { Context, TickResult } from './steps/context.ts'
import { dropStaleErrors } from './steps/errors.ts'
import { ciEntries, iso, lines, log, oneLine, setLogFile, stallEntries } from './steps/shared.ts'

function startWaitMs(): number { return envMs('ORCH_LOOP_START_WAIT_SEC', 10) }

const STOP_WAIT_MS = 20_000

const POLL_MS = 100

// --start 의 명의 확인 조회 한도
const PROBE_MS = 30_000

// wx 로 만든 직후 pid 를 쓰기 전의 빈 잠금을 깨진 잠금으로 회수하지 않게, 이 시간 안의 빈 파일은 쥔 것으로 본다(lib/events.ts 와 같다)
const EMPTY_LOCK_GRACE_MS = 2_000

// 부모가 틱 자식 그룹에 TERM 을 보낸 뒤 KILL 까지 기다리는 시간. 틱 자식의 STOP_GRACE_MS 보다 길다(머리 주석의 「틱 자식」)
const TICK_STOP_GRACE_MS = STOP_GRACE_MS + 3_000

// 틱 자식이 부모가 살아 있는지 보는 간격(머리 주석의 「틱 자식」)
const PARENT_POLL_MS = 2_000

export class Usage extends Error {}

export function aliveSec(): number {
  const raw = process.env.ORCH_LOOP_ALIVE_SEC
  if (raw === undefined || raw === '') return DEFAULT_ALIVE_SEC
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Usage(`ORCH_LOOP_ALIVE_SEC 는 양수 초여야 한다: ${raw}`)
  return value
}

function passArgs(ctx: Context): string[] {
  return ['--repo', ctx.repo, ...(ctx.run ? ['--run', ctx.run] : []), ...(ctx.specsDir ? ['--specs-dir', ctx.specsDir] : [])]
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

function createLock(lock: string): boolean {
  let fd: number
  try {
    fd = openSync(lock, 'wx')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
  try {
    writeSync(fd, String(process.pid))
  } finally {
    closeSync(fd)
  }
  return true
}

// 잠금에 적힌 pid. 없거나 정수가 아니면 NaN
function lockPid(lock: string): number {
  const text = (readText(lock) ?? '').trim()
  return /^\d+$/.test(text) ? Number(text) : Number.NaN
}

// 잠금을 쥔 살아 있는 루프의 pid. 없거나, 죽었거나, 루프 프로세스가 아니면 null. 판정할 수 없으면 루프로 본다(머리 주석의 「한 저장소에 하나」)
function lockHolder(lock: string): number | null {
  const pid = lockPid(lock)
  return isLoopProcess(pid) !== false ? pid : null
}

function freshEmpty(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs < EMPTY_LOCK_GRACE_MS
  } catch {
    return false
  }
}

// 잠금을 얻으면 null, 살아 있는 다른 루프가 쥐고 있으면 그 pid 다.
async function takeLock(lock: string, repo: string): Promise<number | null> {
  makeParent(lock, repo)
  const deadline = Date.now() + startWaitMs()
  while (Date.now() < deadline) {
    if (createLock(lock)) return null
    const seen = readText(lock)
    if (seen === null) continue
    const text = seen.trim()
    // 루프 프로세스가 아닌 pid 는 죽은 잠금이다. 아래 reclaim 으로 회수한다. 판정할 수 없으면(null) 회수하지 않는다
    if (/^\d+$/.test(text) && isLoopProcess(Number(text)) !== false) return Number(text)
    if (text === '' && freshEmpty(lock)) {
      await sleep(POLL_MS)
      continue
    }
    if (reclaim(lock, seen) === 'wait') await sleep(POLL_MS)
  }
  throw new Error(`${lock} 를 ${startWaitMs() / 1000}초 안에 얻지 못했다`)
}

function releaseLock(lock: string): void {
  try {
    if ((readText(lock) ?? '').trim() === String(process.pid)) unlinkSync(lock)
  } catch {
    // 이미 없거나 다른 루프가 쥐었다. 남의 잠금은 지우지 않는다
  }
}

function runOf(state: LoopState | null, pid: number): string {
  return state && Number(state.pid) === pid && state.run ? state.run : '-'
}

function running(repo: string): { pid: number; run: string } | null {
  const status = loopStatus(repo, Date.now())
  if (status.alive) return { pid: Number(status.state.pid), run: status.state.run || '-' }
  const holder = lockHolder(lockFile(repo))
  return holder === null ? null : { pid: holder, run: runOf(readLoop(repo), holder) }
}

// 옛 루프는 loop.json 에 runs 가 없다. Run 등록을 모른다(ADR-012)
function legacyLoop(state: LoopState | null, pid?: number): boolean {
  return state !== null && !Array.isArray(state.runs) && (pid === undefined || Number(state.pid) === pid)
}

const LEGACY_HINT = '안내: 이 루프는 Run 등록을 모르는 옛 orch 로 띄운 루프다. 그 루프를 띄운 세션이 --stop 한 뒤 새 orch 로 --start 하면 여러 Run 을 함께 맡는다'

// 옛 루프 안내. 짧은 출력(진입점의 orch loop …)은 안내 줄을 내지 않으므로, 정상 루프의 LOOP-RUNNING 과 가리게 판정 줄로 낸다
function legacyHint(pid: unknown, run: unknown): void {
  log(short() ? `LOOP-LEGACY ${pid ?? '-'} run=${run || '-'}` : LEGACY_HINT)
}

// 살아 있는 루프에 이 Run 을 더한다. 이미 맡고 있거나 Run 이 없으면 전처럼 LOOP-RUNNING 이다(orch-loop.ts 머리 주석의 --start).
// raced 는 띄운 자식이 다른 --start 의 루프에 잠금을 져 4 로 끝난 경우다. 이 Run 은 띄우기 전에 등록했으므로 합류로 본다.
// loop.json 의 pid 가 찾은 pid 와 다르면 루프가 막 뜨는 중이다. 그 루프는 시작할 때 앞 루프의 alive_at 이전 등록을 지우므로,
// 이미 등록된 Run 이어도 registered_at 을 새로 써서 지워지지 않게 한다(머리 주석의 「Run」)
async function joinLoop(ctx: Context, found: { pid: number; run: string }, raced: boolean): Promise<number> {
  const state = readLoop(ctx.repo)
  const starting = state === null || Number(state.pid) !== found.pid
  const registered = ctx.run ? isRegistered(ctx.repo, ctx.run) : false
  if (ctx.run && legacyLoop(state, found.pid)) {
    // 옛 루프는 등록을 읽지 않는다. 띄우기 전에 쓴 등록을 남기지 않는다
    if (raced) unregisterRun(ctx.repo, ctx.run)
    log(`LOOP-RUNNING ${found.pid} run=${found.run}`)
    if (found.run !== ctx.run) legacyHint(found.pid, found.run)
    return 4
  }
  if (ctx.run && (raced || !registered)) {
    // 루프는 띄운 터미널의 명의로 조회한다. 묶인 Run 이 다르거나 모르면 이 Run 의 질문을 읽지 못하니 합류하지 않는다(머리 주석의 「명의」)
    const bound = await loopBound(ctx.repo, found.pid)
    if (bound !== null && bound !== ctx.run) {
      if (raced) unregisterRun(ctx.repo, ctx.run)
      log(`LOOP-START-FENCED ${ctx.run} ${bound}`)
      log(
        `안내: 도는 루프(pid ${found.pid})는 ${bound === UNKNOWN_BOUND ? '명의를 알 수 없어(loop.json 에 bound_run 이 없다)' : `Run ${bound} 에 묶여`} ` +
          `Run ${ctx.run} 의 질문을 읽지 못한다. 그 루프가 맡은 Run 이 모두 빠진 뒤 Run ${ctx.run} 의 코디네이터 세션에서 --start 한다`,
      )
      return 5
    }
  }
  if (ctx.run) {
    registerRun(ctx.repo, ctx.run, ctx.specsDir, starting, process.env.ORCA_TERMINAL_HANDLE)
    if (raced || !registered) {
      log(`LOOP-JOINED ${found.pid} run=${ctx.run}`)
      return 0
    }
  }
  log(`LOOP-RUNNING ${found.pid} run=${ctx.run && isRegistered(ctx.repo, ctx.run) ? ctx.run : found.run}`)
  return 4
}

// 머리 주석의 「명의」. Orca 는 이 프로세스가 나온 터미널로 호출자를 정한다
const FENCED = 'consumer_fenced'

const UNKNOWN_BOUND = 'unknown'
const UNBOUND = 'unbound'

// --start 가 자식 루프에 넘기는 명의. {"run": <Run id 또는 null>} 이고, 읽지 못했으면 {} 다
const BOUND_ENV = 'ORCH_LOOP_BOUND'

// 이 프로세스가 묶인 Run. 묶이지 않았으면 null, 읽지 못하면 undefined 다
function boundRun(): string | null | undefined {
  const got = orcaJson<{ run?: { id?: unknown } | null } | null>(['orchestration', 'run-current'], { timeoutMs: PROBE_MS })
  if (!got.ok) return undefined
  const id = got.data?.run?.id
  return typeof id === 'string' && id ? id : null
}

// --start 가 넘긴 명의. 넘기지 않았으면(--foreground 를 직접 띄웠다) 여기서 읽는다. 결과의 뜻은 boundRun 과 같다
function inheritedBound(): string | null | undefined {
  const raw = process.env[BOUND_ENV]
  if (raw === undefined) return boundRun()
  try {
    const parsed = JSON.parse(raw) as { run?: unknown }
    if (!('run' in parsed)) return undefined
    return typeof parsed.run === 'string' && parsed.run ? parsed.run : null
  } catch {
    return undefined
  }
}

// 이 프로세스가 run 을 조회하지 못하면(consumer_fenced) 묶인 Run 을, 조회하면 null 을 낸다.
// 다른 이유로 실패하면 명의 문제로 보지 않고 null 이다. 그 실패는 루프의 질문 확인이 WATCH-ERROR 로 알린다.
// 터미널에 묶인 Run 이 없는 오류(run-current 가 비거나 오류가 대상 Run 을 가리킨다)는 UNBOUND 다
function callerFenced(run: string): string | null {
  const got = orcaJson<unknown>(['orchestration', 'check', '--run', run, '--peek', '--types', 'question'], { timeoutMs: PROBE_MS })
  if (got.ok) return null
  if (!got.error.includes(FENCED)) {
    process.stderr.write(`orch-loop: Run ${run} 조회 확인이 실패해 명의를 판정하지 못하고 진행한다: ${got.error}\n`)
    return null
  }
  const named = /bound to Run ([^\s,.'"\\]+)/.exec(got.error)?.[1]
  if (named === run) return UNBOUND
  const bound = named ?? boundRun()
  if (bound === null || bound === run) return UNBOUND
  return typeof bound === 'string' && bound ? bound : UNKNOWN_BOUND
}

// 도는 루프가 묶인 Run. 묶이지 않았으면 null, 모르면 UNKNOWN_BOUND 다. 막 뜨는 루프는 loop.json 을 쓸 때까지 기다린다
async function loopBound(repo: string, pid: number): Promise<string | null> {
  const deadline = Date.now() + startWaitMs()
  for (;;) {
    const state = readLoop(repo)
    if (state && Number(state.pid) === pid) {
      if (!('bound_run' in state)) return UNKNOWN_BOUND
      return typeof state.bound_run === 'string' && state.bound_run ? state.bound_run : null
    }
    if (Date.now() >= deadline || !alive(pid)) return UNKNOWN_BOUND
    await sleep(POLL_MS)
  }
}

export async function start(ctx: Context, entrypoint: string): Promise<number> {
  if (ctx.run) {
    // 띄운 루프는 이 프로세스의 명의를 물려받는다. 이 Run 을 읽지 못하면 띄우지도 합류하지도 않는다(머리 주석의 「명의」)
    const bound = callerFenced(ctx.run)
    if (bound === UNBOUND) {
      log(`LOOP-START-UNBOUND ${ctx.run}`)
      log(`안내: 이 터미널은 어떤 Run 에도 묶이지 않아 Run ${ctx.run} 의 질문을 읽지 못한다. 먼저 묶고 다시 --start 한다: orca orchestration run-use --id ${ctx.run}`)
      return 5
    }
    if (bound !== null) {
      log(`LOOP-START-FENCED ${ctx.run} ${bound}`)
      log(`안내: 이 터미널은 Run ${bound} 에 묶여 Run ${ctx.run} 의 질문을 읽지 못한다. Run ${ctx.run} 의 코디네이터 세션에서 --start 한다`)
      return 5
    }
  }
  const found = running(ctx.repo)
  if (found) return joinLoop(ctx, found, false)
  // registered_at 을 새로 쓴다. 새로 뜬 루프는 앞 루프의 alive_at 뒤에 쓴 등록을 살아 있는 세션의 것으로 보고 남긴다(머리 주석의 「Run」)
  if (ctx.run) registerRun(ctx.repo, ctx.run, ctx.specsDir, true, process.env.ORCA_TERMINAL_HANDLE)
  // 자식은 이 프로세스의 명의를 물려받는다. 명의 조회는 느릴 수 있어 시작 대기 한도를 쓰기 전에 여기서 한 번 읽어 넘긴다(머리 주석의 「명의」)
  const bound = boundRun()
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entrypoint, ...passArgs(ctx), '--foreground'], {
    cwd: ctx.repo,
    env: { ...process.env, [BOUND_ENV]: JSON.stringify(bound === undefined ? {} : { run: bound }) },
    detached: true,
    stdio: 'ignore',
  })
  let exited: number | null = null
  let failed: string | null = null
  child.on('exit', (code, signal) => {
    exited = code ?? signalCode(signal ?? 'SIGTERM')
  })
  child.on('error', (e) => {
    failed = e.message
  })
  child.unref()
  const pid = child.pid
  const deadline = Date.now() + startWaitMs()
  while (Date.now() < deadline) {
    if (failed !== null) {
      log(`LOOP-START-FAIL 루프를 띄우지 못했다: ${failed}`)
      return 1
    }
    const state = readLoop(ctx.repo)
    if (pid !== undefined && state && Number(state.pid) === pid) {
      log(`LOOP-STARTED ${pid} run=${state.run || '-'}`)
      return 0
    }
    if (exited === 4) {
      // 동시에 --start 한 다른 세션의 루프가 먼저 잠금을 쥐었다. 그 루프에 합류한다
      const other = running(ctx.repo)
      if (other) return await joinLoop(ctx, other, true)
    }
    if (exited !== null) {
      log(`LOOP-START-FAIL 루프가 loop.json 을 쓰기 전에 종료 코드 ${exited} 로 끝났다`)
      return 1
    }
    await sleep(POLL_MS)
  }
  // 늦게라도 살아나 따로 도는 루프를 남기지 않는다. 실패로 알린 루프가 돌면 코디네이터가 모르는 루프가 된다
  if (pid !== undefined) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 이미 끝났다
    }
  }
  log(`LOOP-START-FAIL ${startWaitMs() / 1000}초 안에 loop.json 에 pid ${pid ?? '-'} 를 쓰지 않아 끝냈다`)
  return 1
}

// orch-loop.ts 머리 주석의 --stop. run 을 주면 그 Run 만 빼고, 남은 Run 이 없을 때만 루프를 멈춘다
export async function stop(repo: string, run: string | null, all: boolean): Promise<number> {
  const state = readLoop(repo)
  if (run !== null) {
    if (legacyLoop(state) && state?.run && state.run !== run && isLoopProcess(Number(state.pid)) !== false) {
      // 옛 루프는 다른 Run 의 것이다. 그 세션의 루프를 끊지 않는다
      log(`LOOP-NOT-REGISTERED run=${run}`)
      legacyHint(state.pid, state.run)
      return 0
    }
    const removed = unregisterRun(repo, run)
    const left = registeredRuns(repo)
    // 등록돼 있지 않던 Run 은 루프를 멈추지 않는다. Run 없이 띄운 루프는 --run 없는 --stop 으로 멈춘다
    if (!removed && !legacyLoop(state)) {
      log(`LOOP-NOT-REGISTERED run=${run}`)
      return 0
    }
    if (left.length > 0) {
      log(`LOOP-LEFT ${state?.pid ?? '-'} run=${run} runs=${left.map((e) => e.run).join(',')}`)
      return 0
    }
    return stopProcess(repo, run)
  } else if (!all) {
    const runs = registeredRuns(repo)
    // 등록이 하나뿐이어도 다른 세션의 Run 일 수 있다. --run 없이는 멈추지 않는다
    if (runs.length > 0 && isLoopProcess(Number(state?.pid)) !== false) {
      log(`LOOP-STOP-SHARED ${state?.pid ?? '-'} runs=${runs.map((e) => e.run).join(',')}`)
      log('Run 이 등록된 루프는 --run 없이 멈추지 않는다. 자기 Run 만 빼려면 --stop --run, 모두 멈추려면 --stop --all 이다')
      return 1
    }
  }
  for (const entry of registeredRuns(repo)) {
    unregisterRun(repo, entry.run)
  }
  return stopProcess(repo, null)
}

// left 는 방금 등록을 뺀 Run 이다. 있으면 신호를 보내기 직전에 등록을 다시 본다. 마지막 Run 을 뺀 사이 다른 세션이 합류했으면 멈추지 않는다
async function stopProcess(repo: string, left: string | null): Promise<number> {
  const joined = left !== null ? registeredRuns(repo) : []
  if (joined.length > 0) {
    log(`LOOP-LEFT ${readLoop(repo)?.pid ?? '-'} run=${left} runs=${joined.map((e) => e.run).join(',')}`)
    return 0
  }
  const candidates = [Number(readLoop(repo)?.pid), lockPid(lockFile(repo))]
  const verdicts = candidates.map((p) => ({ pid: p, loop: isLoopProcess(p) }))
  const pid = verdicts.find((v) => v.loop === true)?.pid
  if (pid === undefined) {
    // 루프가 아닌 프로세스에 TERM 을 보내지 않는다(orch-loop.ts 머리 주석의 --stop)
    const unknown = verdicts.find((v) => v.loop === null)
    if (unknown) {
      log(`LOOP-STOP-UNKNOWN ${unknown.pid} ps 로 루프 프로세스인지 판정하지 못해 신호를 보내지 않았다`)
      return 1
    }
    log('LOOP-NOT-RUNNING')
    return 0
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
  }
  const deadline = Date.now() + STOP_WAIT_MS
  while (alive(pid)) {
    if (Date.now() >= deadline) {
      log(`LOOP-STOP-TIMEOUT ${pid}`)
      return 1
    }
    await sleep(POLL_MS)
  }
  log(`LOOP-STOPPED ${pid}`)
  return 0
}

export function status(repo: string): number {
  const found = loopStatus(repo, Date.now())
  if (!found.alive) {
    log(`LOOP-DEAD ${repo} ${found.reason}`)
    return 1
  }
  const { state } = found
  log(`LOOP-ALIVE ${state.pid} run=${state.run || '-'} last_tick=${state.last_tick || '-'} alive_at=${state.alive_at}`)
  return 0
}

// 틱 자식의 출력에서 결과 줄을 꺼내고 나머지를 로그로 옮긴다
function tickResult(done: RunResult): { result: TickResult | null; reason: string | null } {
  const out = lines(done.stdout)
  let result: TickResult | null = null
  const last = out.at(-1)
  if (last !== undefined) {
    try {
      const parsed = JSON.parse(last) as TickResult
      if (parsed && typeof parsed === 'object' && typeof parsed.tick_at === 'string') {
        result = parsed
        out.pop()
      }
    } catch {
      // 결과 줄이 아니다
    }
  }
  for (const line of [...out, ...lines(done.stderr)]) log(line)
  // 결과 줄이 있으면 종료 코드와 상관없이 낸다(머리 주석의 「틱 자식」)
  if (done.code !== 0) return { result, reason: `종료 코드 ${done.code}` }
  if (!result) return { result: null, reason: '결과 줄 없음' }
  return { result, reason: null }
}

export async function foreground(ctx: Context, once: boolean, interval: number, entrypoint: string): Promise<number> {
  stopGraceMs = TICK_STOP_GRACE_MS
  const file = join(pathOf('state', ctx.repo), 'loop.log')
  setLogFile(file)
  makeParent(file, ctx.repo)
  if (ctx.run) {
    const found = waiterPids(ctx.run)
    if (found.ok) for (const pid of found.pids) log(`WAITER-LEFT ${pid}: 옛 대기를 직접 종료한다: kill ${pid}`)
  }
  const lock = lockFile(ctx.repo)
  const holder = await takeLock(lock, ctx.repo)
  if (holder !== null) {
    log(`LOOP-RUNNING ${holder} run=${runOf(readLoop(ctx.repo), holder)}`)
    return 4
  }
  process.on('exit', () => releaseLock(lock))
  // 새로 뜬 루프는 앞 루프가 마지막으로 살아 있던 때(alive_at)까지의 등록을 지운다. 끝난 세션의 Run 을 계속 맡지 않게 한다.
  // 그 뒤의 등록은 살아 있는 세션이 동시에 --start 한 것이라 남긴다. 앞 loop.json 이 없으면 지우지 않는다(머리 주석의 「Run」)
  const before = readLoop(ctx.repo)
  const cutoff = typeof before?.alive_at === 'string' ? Date.parse(before.alive_at) : Number.NaN
  const restartNotices: Record<string, string> = {}
  if (isObject(before?.restart_notices)) for (const [run, since] of Object.entries(before.restart_notices)) {
    if (typeof since === 'string') restartNotices[run] = since
  }
  if (Number.isFinite(cutoff) && Date.now() - cutoff > Math.max(3 * (before?.tick_sec ?? 300), 120) * 1000) {
    for (const entry of registeredRuns(ctx.repo)) {
      restartNotices[entry.run] ??= before!.alive_at
    }
  }
  for (const entry of registeredRuns(ctx.repo)) {
    if (entry.run === ctx.run || !Number.isFinite(cutoff)) continue
    const at = Date.parse(entry.registered_at)
    if (Number.isFinite(at) && at > cutoff) continue
    unregisterRun(ctx.repo, entry.run)
    log(`앞 루프의 Run ${entry.run} 등록을 지웠다. 그 세션이 살아 있으면 LOOP-RESTARTED 메시지나 doctor 안내를 따라 다시 등록한다`)
  }
  if (ctx.run) registerRun(ctx.repo, ctx.run, ctx.specsDir)
  let runs = registeredRuns(ctx.repo).map((entry) => entry.run)
  // 등록된 Run 이 있던 루프는 마지막 Run 이 빠지면 끝난다. 처음부터 Run 이 없던 루프는 --stop 까지 돈다(머리 주석의 「Run」)
  let hadRuns = runs.length > 0
  const previous = readLoop(ctx.repo)
  const errors = previous && typeof previous.errors === 'object' && previous.errors !== null && !Array.isArray(previous.errors) ? previous.errors : {}
  const ci = ciEntries(previous?.ci)
  const stalls = stallEntries(previous?.stalls)
  // 뒤의 --start 가 합류를 판정할 수 있게 이 프로세스가 묶인 Run 을 적는다. 읽지 못하면 적지 않는다(머리 주석의 「명의」)
  const bound = inheritedBound()
  const now = iso()
  const state: LoopState = {
    pid: process.pid,
    ...(bound === undefined ? {} : { bound_run: bound }),
    run: runs[0] ?? ctx.run,
    runs,
    repo: ctx.repo,
    tick_sec: ctx.tickSec,
    restart_notices: restartNotices,
    started_at: now,
    alive_at: now,
    last_tick: null,
    ticks: 0,
    errors: { ...errors },
    ci,
    stalls,
  }
  writeLoop(ctx.repo, state)
  if (runs.length === 0 && !ctx.run) log('경고: Run id 가 없어 질문 확인을 건너뛴다. --run 이나 finish.run 으로 준다')
  const timer = setInterval(() => {
    state.alive_at = iso()
    try {
      writeLoop(ctx.repo, state)
    } catch (e) {
      log(`orch-loop: loop.json 에 alive_at 을 쓰지 못했다: ${oneLine(e)}`)
    }
  }, interval * 1000)
  try {
    for (let n = 1; ; n++) {
      runs = registeredRuns(ctx.repo).map((entry) => entry.run)
      if (hadRuns && runs.length === 0) {
        log('LOOP-EMPTY 등록된 Run 이 없어 루프를 끝낸다')
        return 0
      }
      hadRuns ||= runs.length > 0
      state.runs = runs
      state.run = runs[0] ?? ctx.run
      for (const [run, since] of Object.entries(restartNotices)) {
        try { sendNotice('LOOP-RESTARTED', null, `${since} 부터 멈춰 있었다`, run, ctx.repo); delete restartNotices[run] }
        catch (e) {
          log(`NOTICE-FAIL LOOP-RESTARTED ${oneLine(e)}`)
          // 앞 루프의 등록을 뺀 Run 은 더 맡지 않는다. 실패한 알림을 다음 틱이나 시작으로 넘기지 않는다.
          if (!isRegistered(ctx.repo, run)) delete restartNotices[run]
        }
      }
      log(`tick ${n} ${iso()}`)
      const done = await runAsync(scriptCommand(entrypoint, [...passArgs(ctx), '--tick', '--tick-number', String(n)]), {
        cwd: ctx.repo,
        timeoutMs: NO_LIMIT_MS,
        group: true,
      })
      // 신호로 끝내는 중이면 끊긴 틱을 실패로 알리지 않는다
      const signal = stopping()
      if (signal) return signalCode(signal)
      const { result, reason } = tickResult(done)
      if (result) {
        state.last_tick = result.tick_at
        for (const [source, value] of Object.entries(result.errors ?? {})) state.errors[source] = value ?? null
        // 열린 PR 을 읽지 못한 틱은 ci 가 없다. 그때는 이전 값을 둔다
        if (isObject(result.ci)) state.ci = ciEntries(result.ci)
        // 멈춤 확인이 실패한 틱은 stalls 가 없다. 그때도 이전 값을 둔다
        if (isObject(result.stalls)) state.stalls = stallEntries(result.stalls)
      }
      state.ticks = n
      const tickKey = state.run ? `tick@${state.run}` : 'tick'
      if (reason !== null) {
        log(`WATCH-ERROR tick: ${reason}`)
        if (state.errors[tickKey] !== reason) {
          try {
            sendNotice('WATCH-ERROR', null, `tick: ${reason}`, state.run, ctx.repo)
            state.errors[tickKey] = reason
          } catch (e) {
            log(`orch-loop: Orca 알림을 보내지 못했다: ${oneLine(e)}`)
          }
        }
      }
      if (reason === null || state.errors[tickKey] === reason) state.errors[tickKey] = reason
      dropStaleErrors(state.errors, runs, state.run)
      state.alive_at = iso()
      writeLoop(ctx.repo, state)
      if (once) return 0
      await sleep(ctx.tickSec * 1000)
    }
  } finally {
    clearInterval(timer)
  }
}

let exiting = false

// 신호를 받았을 때 자식에 TERM 뒤 KILL 까지 주는 유예. --foreground 의 부모만 늘린다(머리 주석의 「틱 자식」)
let stopGraceMs = STOP_GRACE_MS

function onSignal(signal: NodeJS.Signals): void {
  if (exiting) return
  exiting = true
  // 진행 중인 자식(틱 자식 그룹, 정리 명령, 핸들러 그룹)을 끊은 뒤에 끝낸다. 그냥 끝내면 자식이 남는다
  void stopChildren(signal, stopGraceMs).finally(() => process.exit(signalCode(signal)))
}

// 틱 자식이 부모(--foreground)가 사라졌는지 본다(머리 주석의 「틱 자식」)
export function watchParent(): void {
  const parent = process.ppid
  setInterval(() => {
    if (process.ppid === parent && alive(parent)) return
    // stdout 을 읽던 부모가 없다. 쓰기 오류가 잡지 않은 예외가 되어 끝내기를 방해하지 않게 버린다
    process.stdout.on('error', () => {})
    process.stderr.on('error', () => {})
    onSignal('SIGHUP')
  }, PARENT_POLL_MS).unref()
}

function fatal(e: unknown): void {
  log(`orch-loop: ${(e as Error)?.stack ?? String(e)}`)
  if (exiting) return
  exiting = true
  void stopChildren('SIGTERM', stopGraceMs).finally(() => process.exit(1))
}

// 신호와 잡지 않은 예외의 처리기를 건다. --foreground 와 --tick 만 부른다
export function handleSignals(): void {
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  process.on('SIGHUP', onSignal)
  process.on('uncaughtException', fatal)
  process.on('unhandledRejection', fatal)
}
