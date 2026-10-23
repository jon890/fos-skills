// 이벤트 실행기다. 명령은 `await fire('before-merge', input, ctx)` 한 줄로 저장소의 핸들러를 부른다.
// 핸들러 찾기, 잠금, 시간 제한, 실행 기록, 종료 코드 해석, 가드 환경을 이 모듈 한 곳이 소유한다.
// 이벤트 이름과 시점은 docs/flow.md 의 「orch 이벤트」, 이벤트별 입력 필드는 docs/data-schema.md 의 「이벤트별 필드」 가 정한다.
//
// 핸들러: <orch 루트>/hooks/<이벤트>.ts 하나. `node --disable-warning=ExperimentalWarning <파일>` 로 띄운다.
//   작업 디렉터리는 ctx.cwd, 없으면 주 checkout 이다. stdin 에 JSON 객체 하나를 쓴다.
//   그 객체는 input 위에 공통 필드(version, event, repo, base, run, time)를 덮은 것이다.
//
// 환경: process.env 위에 아래를 둔다.
//   ORCH_EVENT, ORCH_REPO(주 checkout), ORCH_DIR(orch 루트 절대경로)
//   PATH        맨 앞에 가드 폴더(lib/guard)
//   ORCA, GH    가드 폴더의 shim 절대경로
//   ORCH_REAL_ORCA, ORCH_REAL_GH  진짜 실행 파일의 절대경로. 찾지 못하면 넘기지 않는다
//   진짜 실행 파일은 가드 폴더를 PATH 에 넣기 전에 찾는다. orcaBin(), ghBin() 의 기본값은 이름이라, 그대로 넘기면
//   shim 이 PATH 맨 앞의 자기 자신을 다시 불러 node 프로세스가 끝없이 생긴다. `/` 가 든 값은 절대경로로 바꾸고
//   (그 실경로가 가드 폴더 안이면 버리고 이름으로 찾는다), 이름이면 PATH 를 앞에서부터 보며 가드 폴더가 아닌 곳의 실행 파일을 고른다.
//   가드는 실수 방지 장치이고 보안 경계가 아니다. ORCH_REAL_* 가 보이므로 핸들러가 일부러 부르면 우회된다.
//
// 종료 코드와 결과(FireResult.result):
//   핸들러가 없고 legacy 도 없다   none. 줄도 기록도 없다
//   0                              pass
//   10, 거부할 수 있는 이벤트      reject. 이유는 stdout 의 마지막 빈 줄 아닌 줄. `HOOK-REJECT <이벤트> <이유>`
//   10, 나머지 이벤트, 그 밖        fail. `HOOK-FAIL <이벤트> <종료 코드>`. 시그널로 죽으면 128 + 신호 번호다
//   시간 초과                       timeout, code null. `HOOK-FAIL <이벤트> timeout`
//   잠금을 얻지 못함               fail, code null. `HOOK-FAIL <이벤트> lock`
//   거부를 1 이 아니라 10 으로 둔 것은 node 가 잡지 않은 예외에 1 을 내기 때문이다. 1 을 거부로 읽으면 죽은 핸들러가 의도한 거부가 된다.
//   거부할 수 있는 이벤트에서 fail 과 timeout 을 거부처럼 멈출지는 부르는 명령이 정한다(docs/flow.md 의 「갈래」).
//
// 시간 제한: EVENTS 의 기본값을 config.json 의 hooks.timeouts.<이벤트>(초, 양수)가 덮는다.
//   넘으면 프로세스 그룹에 TERM, 10초 뒤에도 그룹이 살아 있으면 KILL 이다. 자식은 detached 로 띄워 새 그룹을 만든다.
//   그래서 핸들러가 띄운 bash -c 의 손자 프로세스도 함께 끝난다.
//   spawnSync 를 쓰지 않는 이유: TERM 을 무시하는 자식이면 시간이 지나도 돌아오지 않아 KILL 을 보낼 수 없고,
//   출력 한도(maxBuffer)를 넘으면 자식이 죽으며, 줄을 그때그때 out 으로 옮길 수 없다(Node 22.18 실측).
//
// 출력: 핸들러의 stdout 과 stderr 를 줄 단위로 나눠 `[hook <이벤트>] ` 를 붙여 바로 out 으로 보낸다. 메모리에 모으지 않고
//   크기 한도도 없다. out 의 기본은 process.stdout 에 한 줄씩 쓰는 것이다.
//
// 잠금: <orch 루트>/state/hooks/<이벤트>.lock. 배타 생성(wx)하고 자기 pid 를 쓴다. 다른 살아 있는 pid 가 쥐고 있으면
//   0.5초 간격으로 다시 보며 그 이벤트의 시간 제한 + 15초를 기다린다. 쥔 쪽은 시간 제한과 KILL 유예 10초 안에 끝나기 때문이다.
//   셋 이상 겹쳐 앞의 실행들이 시간 제한 가까이 돌면 뒤 실행이 lock 실패로 끝나는 것은 의도한 동작이다.
//   끝나면(예외 포함) 자기 pid 가 든 잠금만 지운다.
//
// 기록: <orch 루트>/state/hooks.jsonl 에 결과마다 한 줄(time, event, handler, exit, result, duration_ms, reason).
//   none 은 적지 않는다. legacy 실행의 handler 는 legacy:<key> 다. 더하기 전에 1MB 를 넘으면 hooks.jsonl.1 로 옮긴다.
//   duration_ms 는 잠금 대기를 포함해 fire 가 걸린 시간이다.
//
// legacy: 옛 설정 칸(queue.before 등)을 핸들러처럼 돌리는 어댑터다. 다음 major 에서 지운다.
//   argv 를 셸 없이 그대로 띄운다. 셸이 필요한 옛 칸은 부르는 쪽이 ['bash', '-c', 명령] 을, finish.complete_cmd 는
//   shlex 식으로 나눈 argv 를 넘긴다. PR 제목에서 뽑은 값이 셸에 들어가지 않게 하기 위해서다.
//   legacy.env 는 process.env 위에 덮고, ORCH_* 와 가드 PATH, ORCA, GH 는 핸들러와 같게 그 위에 다시 둔다.
//   실행 전에 `DEPRECATED <key> → hooks/<이벤트>.ts` 줄을 낸다. 시간 제한, 잠금, 기록, 종료 코드 해석, 출력 접두는 핸들러와 같다.
//   핸들러 파일과 legacy 가 함께 있으면 ConfigError 다. 명령은 사용법 오류(종료 코드 2)로 바꾼다.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants as fsConstants,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { constants as osConstants } from 'node:os'
import { basename, delimiter, join, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ConfigError, HOOKS_KEYS, loadConfig, section } from './config.ts'
import { mainCheckout } from './git.ts'
import { ghBin } from './gh.ts'
import { orcaBin } from './orca.ts'
import { ensure, orchDir, pathOf } from './paths.ts'
import { alive } from './process.ts'

type EventSpec = { rejectable: boolean; timeoutSec: number }

const SHORT = 120
const LONG = 1800

function spec(rejectable: boolean, timeoutSec: number = SHORT): EventSpec {
  return Object.freeze({ rejectable, timeoutSec })
}

export const EVENTS: Readonly<Record<string, EventSpec>> = Object.freeze({
  'before-launch': spec(true),
  'worker-launched': spec(false),
  'worker-question': spec(false),
  'worker-done': spec(false),
  'worker-lost': spec(false),
  'before-ready': spec(true),
  'pr-ready': spec(false),
  'ci-passed': spec(false),
  'ci-failed': spec(false),
  'ci-missing': spec(false),
  'pr-conflict': spec(false),
  'before-merge': spec(true, LONG),
  'verify-merged': spec(true, LONG),
  'after-merge': spec(false),
  'after-queue': spec(false, LONG),
  'after-deploy': spec(false, LONG),
  'before-cleanup': spec(true),
  'after-cleanup': spec(false),
  tick: spec(false),
  'session-resume': spec(false),
})

export type FireResult = { result: 'none' | 'pass' | 'reject' | 'fail' | 'timeout'; code: number | null; reason: string; durationMs: number }
export type FireContext = {
  repo: string
  base: string
  run: string | null
  cwd?: string
  legacy?: { key: string; argv: string[]; env: Record<string, string> }
  out?: (line: string) => void
}

const CONTRACT_VERSION = 1
const REJECT_CODE = 10
const KILL_GRACE_MS = 10_000
const LOCK_EXTRA_MS = 15_000
const LOCK_POLL_MS = 500
// wx 로 만든 직후 pid 를 쓰기 전의 빈 파일을 깨진 잠금으로 회수하지 않게, 이 시간 안의 빈 파일은 쥔 것으로 본다.
const EMPTY_LOCK_GRACE_MS = 2_000
const LOG_LIMIT = 1_048_576

const GUARD_DIR = fileURLToPath(new URL('./guard', import.meta.url))

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function real(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return resolve(target)
  }
}

function insideGuard(target: string): boolean {
  const root = real(GUARD_DIR)
  const full = real(target)
  return full === root || full.startsWith(root + sep)
}

function executable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// 가드 폴더를 PATH 에 넣기 전에 진짜 실행 파일의 절대경로를 찾는다. 찾지 못하면 null.
function realBin(value: string, name: string): string | null {
  if (value.includes('/')) {
    const full = resolve(value)
    if (!insideGuard(full)) return full
    // 바깥 fire 의 핸들러가 다시 코어 명령을 불러 ORCA 가 shim 을 가리키는 경우다. shim 을 넘기면 126 으로 거부되므로 이름으로 찾는다.
    value = name
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const full = resolve(dir, value)
    if (insideGuard(full)) continue
    if (executable(full)) return full
  }
  return null
}

function handlerEnv(event: string, repo: string, legacyEnv: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const realOrca = realBin(orcaBin(), 'orca')
  const realGh = realBin(ghBin(), 'gh')
  const env: NodeJS.ProcessEnv = { ...process.env, ...(legacyEnv ?? {}) }
  delete env.ORCH_REAL_ORCA
  delete env.ORCH_REAL_GH
  if (realOrca) env.ORCH_REAL_ORCA = realOrca
  if (realGh) env.ORCH_REAL_GH = realGh
  env.ORCH_EVENT = event
  env.ORCH_REPO = repo
  env.ORCH_DIR = orchDir(repo)
  env.PATH = process.env.PATH ? `${GUARD_DIR}${delimiter}${process.env.PATH}` : GUARD_DIR
  env.ORCA = join(GUARD_DIR, 'orca')
  env.GH = join(GUARD_DIR, 'gh')
  return env
}

function timeoutSec(event: string, repo: string): number {
  const hooks = section<{ timeouts?: unknown }>(loadConfig(repo), 'hooks', HOOKS_KEYS)
  const timeouts = hooks.timeouts
  if (timeouts === undefined) return EVENTS[event].timeoutSec
  if (typeof timeouts !== 'object' || timeouts === null || Array.isArray(timeouts)) {
    throw new ConfigError('설정 파일의 hooks.timeouts 는 이벤트 이름에서 초로 가는 객체여야 한다')
  }
  const table = timeouts as Record<string, unknown>
  const unknown = Object.keys(table)
    .filter((key) => !Object.hasOwn(EVENTS, key))
    .sort()
  if (unknown.length > 0) throw new ConfigError(`설정 파일의 hooks.timeouts 에 모르는 이벤트가 있다: ${unknown.join(', ')}`)
  const value = table[event]
  if (value === undefined) return EVENTS[event].timeoutSec
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`설정 파일의 hooks.timeouts.${event} 는 양수(초)여야 한다`)
  }
  return value
}

// 잠금 ------------------------------------------------------------------

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

// 잠금 파일의 내용. 없으면 null.
function readLock(lock: string): string | null {
  try {
    return readFileSync(lock, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

function held(lock: string, content: string): boolean {
  const text = content.trim()
  if (text === '') {
    try {
      return Date.now() - statSync(lock).mtimeMs < EMPTY_LOCK_GRACE_MS
    } catch {
      return false
    }
  }
  return /^\d+$/.test(text) && alive(Number(text))
}

// 죽은 pid(깨진 내용 포함)의 잠금을 회수한다.
// 두 실행이 같은 죽은 pid 를 함께 회수하면, 읽고 지우는 방식으로는 A 가 지우고 새로 만든 잠금을 B 가 지울 수 있다.
// 그래서 잠금 파일을 고유 이름으로 rename 해 내 것으로 떼어 낸 뒤, 그 내용이 처음 읽은 값과 같은지 대조한다.
//   같다    처음 본 죽은 잠금을 떼어 낸 것이다. 지우고 wx 생성을 다시 시도한다
//   다르다  다른 실행이 먼저 회수하고 새로 만든 잠금을 떼어 낸 것이다. linkSync 로 잠금 자리에 되돌리고 다시 기다린다.
//           link 는 대상이 있으면 EEXIST 로 실패하고 덮어쓰지 않는다. rename 으로 되돌리면 그 사이 또 다른 실행이 만든 잠금을
//           덮어 두 실행이 함께 돌 수 있지만, link 는 그러지 않으므로 먼저 회수한 실행의 배타성이 지켜진다.
//           EEXIST 면 그 사이 다른 실행이 새 잠금을 만든 것이다. 떼어 낸 파일만 지우고 다시 기다린다
//   없다    다른 실행이 먼저 옮겼다. wx 생성을 다시 시도한다
// wx 가 한 실행만 통과시키므로 둘이 함께 회수해도 새 잠금은 하나다.
// seen 은 부르는 쪽이 처음 읽은 내용이다. 그 뒤에 잠금이 바뀐 경합을 테스트가 흉내 낼 수 있게 내보낸다.
export function reclaim(lock: string, seen: string): 'retry' | 'wait' {
  const moved = `${lock}.reclaim-${process.pid}-${randomUUID()}`
  try {
    renameSync(lock, moved)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'retry'
    throw e
  }
  const now = readLock(moved)
  if (now !== seen) {
    try {
      linkSync(moved, lock)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  try {
    unlinkSync(moved)
  } catch {
    // 떼어 낸 파일은 이 실행만 아는 이름이다. 지우지 못해도 잠금 판정에는 영향이 없다.
  }
  return now === seen ? 'retry' : 'wait'
}

async function acquire(lock: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs
  for (;;) {
    if (createLock(lock)) return true
    const seen = readLock(lock)
    if (seen === null) continue
    if (!held(lock, seen) && reclaim(lock, seen) === 'retry') continue
    if (Date.now() >= deadline) return false
    await sleep(LOCK_POLL_MS)
  }
}

function release(lock: string): void {
  try {
    if ((readLock(lock) ?? '').trim() === String(process.pid)) unlinkSync(lock)
  } catch {
    // 이미 없거나 다른 실행이 쥐었다. 남의 잠금은 지우지 않는다.
  }
}

// 기록 ------------------------------------------------------------------

function record(repo: string, entry: { event: string; handler: string; exit: number | null; result: FireResult['result']; durationMs: number; reason: string }): void {
  const file = join(ensure('state', repo), 'hooks.jsonl')
  try {
    if (statSync(file).size > LOG_LIMIT) renameSync(file, `${file}.1`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const line = {
    time: new Date().toISOString(),
    event: entry.event,
    handler: entry.handler,
    exit: entry.exit,
    result: entry.result,
    duration_ms: entry.durationMs,
    reason: entry.reason,
  }
  appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
}

// 실행 ------------------------------------------------------------------

function lines(emit: (line: string) => void): { push: (chunk: Buffer) => void; end: () => void } {
  const decoder = new StringDecoder('utf8')
  let rest = ''
  const flush = (text: string) => emit(text.endsWith('\r') ? text.slice(0, -1) : text)
  return {
    push(chunk) {
      rest += decoder.write(chunk)
      let at = rest.indexOf('\n')
      while (at >= 0) {
        flush(rest.slice(0, at))
        rest = rest.slice(at + 1)
        at = rest.indexOf('\n')
      }
    },
    end() {
      rest += decoder.end()
      if (rest) flush(rest)
      rest = ''
    },
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH: 그룹에 남은 프로세스가 없다.
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

type Outcome = { timedOut: boolean; code: number | null; error: string | null; lastLine: string }

function execute(argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number; prefix: string; out: (line: string) => void }): Promise<Outcome> {
  return new Promise((done) => {
    let settled = false
    let timedOut = false
    let lastLine = ''
    let timer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const outLines = lines((line) => {
      if (line.trim()) lastLine = line
      opts.out(`${opts.prefix}${line}`)
    })
    const errLines = lines((line) => opts.out(`${opts.prefix}${line}`))

    const finish = (outcome: Omit<Outcome, 'lastLine'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      outLines.end()
      errLines.end()
      done({ ...outcome, lastLine })
    }

    child.stdout.on('data', (chunk: Buffer) => outLines.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => errLines.push(chunk))
    // 핸들러가 stdin 을 읽기 전에 끝나면 EPIPE 가 난다. 결과는 종료 코드로 판정하므로 무시한다. 무시하지 않으면 코어가 죽는다.
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input)

    child.on('error', (e: NodeJS.ErrnoException) => {
      // 띄우지 못한 경우만 여기서 끝낸다(node 가 없거나 작업 디렉터리가 없다). 띄운 뒤의 오류는 close 에서 판정한다.
      if (child.pid === undefined) finish({ timedOut: false, code: e.code === 'ENOENT' ? 127 : 1, error: `${argv[0]} 를 실행하지 못했다: ${e.message}` })
    })
    // 끝 판정은 exit 가 아니라 close 로 한다. exit 직후에는 파이프에 남은 출력이 아직 out 으로 오지 않았을 수 있다.
    // 핸들러가 백그라운드 자식에게 stdout 을 넘기면 close 가 그 자식이 끝날 때까지 늦어진다. 그때는 시간 제한 경로가 그룹에
    // TERM, KILL 을 보내 끝을 보장한다. 그룹을 벗어난 손자가 파이프를 쥐고 있어도 KILL 뒤에는 파이프를 닫아 close 를 부른다.
    child.on('close', (status: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) return finish({ timedOut: true, code: null, error: null })
      if (signal) {
        const number = (osConstants.signals as Record<string, number>)[signal] ?? 0
        return finish({ timedOut: false, code: 128 + number, error: null })
      }
      finish({ timedOut: false, code: status ?? 1, error: null })
    })

    timer = setTimeout(() => {
      if (child.pid === undefined) return
      const pid = child.pid
      timedOut = true
      killGroup(pid, 'SIGTERM')
      killTimer = setTimeout(() => {
        if (groupAlive(pid)) killGroup(pid, 'SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
      }, KILL_GRACE_MS)
    }, opts.timeoutMs)
  })
}

function emptyResult(): FireResult {
  return { result: 'none', code: null, reason: '', durationMs: 0 }
}

export async function fire(event: string, input: Record<string, unknown>, ctx: FireContext): Promise<FireResult> {
  if (!Object.hasOwn(EVENTS, event)) throw new Error(`모르는 이벤트: ${event}. ${Object.keys(EVENTS).join(', ')} 중 하나다`)
  const repo = mainCheckout(ctx.repo)
  const file = join(pathOf('hooks', repo), `${event}.ts`)
  const hasHandler = isFile(file)
  const legacy = ctx.legacy
  if (hasHandler && legacy) {
    throw new ConfigError(`${event} 의 핸들러 ${file} 와 옛 설정 칸 ${legacy.key} 가 함께 있다. 어느 쪽이 맞는지 정할 수 없어 하나만 둔다`)
  }
  if (!hasHandler && !legacy) return emptyResult()

  const spec = EVENTS[event]
  const seconds = timeoutSec(event, repo)
  const out = ctx.out ?? ((line: string) => void process.stdout.write(`${line}\n`))
  const handler = legacy ? `legacy:${legacy.key}` : file
  const argv = legacy ? legacy.argv : [process.execPath, '--disable-warning=ExperimentalWarning', file]
  if (argv.length === 0) throw new ConfigError(`옛 설정 칸 ${legacy?.key} 의 명령이 비었다`)
  const started = Date.now()
  const finish = (result: FireResult['result'], code: number | null, reason: string): FireResult => {
    const durationMs = Date.now() - started
    record(repo, { event, handler, exit: code, result, durationMs, reason })
    if (result === 'reject') out(`HOOK-REJECT ${event} ${reason}`)
    else if (result === 'fail') out(`HOOK-FAIL ${event} ${code ?? 'lock'}`)
    else if (result === 'timeout') out(`HOOK-FAIL ${event} timeout`)
    return { result, code, reason, durationMs }
  }

  if (legacy) out(`DEPRECATED ${legacy.key} → hooks/${event}.ts`)

  const lock = join(ensure('hooks-state', repo), `${event}.lock`)
  if (!(await acquire(lock, seconds * 1000 + LOCK_EXTRA_MS))) {
    return finish('fail', null, `잠금을 얻지 못했다: ${lock} 를 쥔 실행이 ${seconds + LOCK_EXTRA_MS / 1000}초 안에 끝나지 않았다`)
  }
  try {
    const payload = { ...input, version: CONTRACT_VERSION, event, repo, base: ctx.base, run: ctx.run, time: new Date().toISOString() }
    const outcome = await execute(argv, {
      cwd: ctx.cwd ?? repo,
      env: handlerEnv(event, repo, legacy?.env),
      input: JSON.stringify(payload),
      timeoutMs: seconds * 1000,
      prefix: `[hook ${event}] `,
      out,
    })
    if (outcome.timedOut) return finish('timeout', null, `시간 제한 ${seconds}초를 넘겼다`)
    if (outcome.error) return finish('fail', outcome.code, outcome.error)
    if (outcome.code === 0) return finish('pass', 0, '')
    if (outcome.code === REJECT_CODE && spec.rejectable) return finish('reject', REJECT_CODE, outcome.lastLine)
    return finish('fail', outcome.code, `종료 코드 ${outcome.code}`)
  } finally {
    release(lock)
  }
}

// hooks/ 바로 아래의 .ts 파일 가운데 이름이 EVENTS 에 없는 것의 경로. doctor 가 UNKNOWN-HOOK 경고에 쓴다.
// 하위 폴더는 보지 않는다. 핸들러가 import 하는 모듈을 두는 자리(예: hooks/lib/)라 경고하면 안 된다.
export function unknownHandlers(repo: string): string[] {
  const dir = pathOf('hooks', repo)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.name.endsWith('.ts') && isFile(join(dir, entry.name)))
    .filter((entry) => !Object.hasOwn(EVENTS, basename(entry.name, '.ts')))
    .map((entry) => join(dir, entry.name))
    .sort()
}

