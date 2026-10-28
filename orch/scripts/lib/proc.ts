// 자식 프로세스 실행의 한 벌이다. orch 명령은 외부 명령을 모두 이 모듈로 부른다.
//
// run 과 runAsync 는 예외를 던지지 않고 RunResult 를 낸다. code 는 아래로 정한다.
//   정상 종료        자식의 종료 코드
//   실행 파일 없음   127 (이유는 stderr)
//   시간 초과        124 (timedOut: true)
//   출력 한도 초과   1   (ENOBUFS 와 이유는 stderr)
//   시그널로 죽음    128 + 신호 번호 (SIGKILL 은 137)
//
// run 은 동기(spawnSync)다. 시간을 넘긴 자식이 TERM 을 무시하면 그 자식이 스스로 끝날 때까지 돌아오지 않는다
// (Node 22.18 실측: 500ms 제한에 4초 넘게 걸렸다). 병렬이 필요하거나 TERM 을 무시할 수 있는 자식은 runAsync 로 부른다.
// runAsync 는 시간을 넘기면 TERM 을 보내고, KILL 유예(기본 10초, ORCH_KILL_GRACE_SEC) 뒤에도 살아 있으면 KILL 을 보낸다.
// runAsync 에 group: true 를 주면 자식을 detached 로 띄워 새 프로세스 그룹을 만든다. 시간 초과와 stopChildren 의 신호가
// 그 그룹 전체(손자 포함)에 간다. 자식이 신호를 받아 손자를 끝내는 중에 죽어도 손자가 남지 않게 하려는 것이다.
// runAsync 는 자식이 끝난 뒤 2초 안에 출력 파이프가 닫히지 않으면(백그라운드 손자가 쥐고 있다) 파이프를 닫고 자식의 종료 코드를 낸다.
// 손자가 그 뒤에 쓴 출력은 버린다. 끝난 자식에는 시간 제한을 적용하지 않으므로 이때 124 가 아니다.
//
// scriptCommand 는 명령끼리 부를 때 확장자로 인터프리터를 고른다. 규칙은 그 함수 위 주석이 소유한다.
//
// runInherit 는 자식의 stdin, stdout, stderr 를 이 프로세스의 것으로 물려준다. 출력을 모으지 않아 자식이 쓰는 대로 바로 나간다.
// 옛 명령이 subprocess.run 을 캡처 없이 부르던 자리(send-to-worker 의 nudge-worker, launch-worker)에 쓴다.
// 진행 줄이 자식이 끝난 뒤에 몰려 나오면 코디네이터가 그동안 멈춘 것으로 본다.
// 반환은 { code, timedOut } 이고 code 와 시간 제한, TERM 뒤 KILL 은 runAsync 와 같다. 출력 한도는 없다.
// 띄우기 전에 이 프로세스의 stdout 과 stderr 를 비운다. macOS 에서 파이프로 가는 쓰기는 비동기라,
// 비우지 않으면 앞서 쓴 줄이 자식의 출력보다 뒤에 나온다.
//
// execCommand 는 이 프로세스를 다른 명령으로 바꾼다(execvp). 옛 명령이 os.execvp 로 명령을 이어받던 자리
// (heavy-slot 의 가벼운 검사와 중첩 호출, mem-gate 의 명령)에 쓴다. pid, 신호, 표준 입출력이 그대로 명령에 넘어간다.
// 판정과 함정은 그 함수 위 주석이 소유한다.
//
// 진행 중인 자식: runAsync, runInherit 와 lib/events.ts 의 핸들러 실행이 띄운 자식을 끝날 때까지 기억한다(trackChild).
// 신호를 받은 명령은 끝내기 전에 stopChildren 을 불러 자식을 남기지 않는다. 기억한 자식에 TERM 을 보내고,
// 유예(기본 STOP_GRACE_MS, 2초) 뒤에도 살아 있으면 KILL 을 보낸다. 그룹으로 띄운 자식(핸들러, group 을 준 runAsync)은 그룹 전체에 보낸다.
// 자식도 stopChildren 으로 자기 자식을 끝내는 명령이면, 부르는 쪽은 유예를 STOP_GRACE_MS 보다 길게 준다.
// 같은 유예면 자식이 손자에게 KILL 을 보내기 전에 부르는 쪽의 KILL 이 자식에 닿을 수 있다.
// stopChildren 을 부른 뒤에는 runAsync, runInherit, 핸들러 실행이 새 자식을 띄우지 않고 128 + 받은 신호 번호로 끝난다.
// 유예 동안에도 부른 쪽의 흐름은 이어 돌기 때문이다. 동기 실행(run)은 막지 않는다. 신호 처리기가 기다리는 동안 부른 쪽이
// run 으로 쓰기 호출(머지 같은 것)을 할 수 있으므로, 그 자리는 부르는 쪽이 stopping() 을 보고 막는다.

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, closeSync, constants as fsConstants, openSync, readSync, statSync } from 'node:fs'
import { constants } from 'node:os'
import { delimiter, extname, join } from 'node:path'

import { killGraceMs } from './env.ts'

export type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean }
export type RunOptions = {
  cwd?: string
  // process.env 위에 덮는다. 값이 undefined 인 키는 자식 환경에서 지운다.
  env?: Record<string, string | undefined>
  input?: string
  timeoutMs?: number
  killSignal?: NodeJS.Signals
  // 출력 한도(바이트, stdout 과 stderr 각각). 테스트가 256MB 를 실제로 만들지 않게 하려고 둔 내부용 칸이다.
  maxBuffer?: number
  // runAsync 만 읽는다. true 면 자식을 새 프로세스 그룹으로 띄운다(머리 주석)
  group?: boolean
}

const DEFAULT_TIMEOUT_MS = 60_000
// spawnSync 의 기본 1MB 를 넘으면 자식이 SIGTERM 으로 죽는다. orca 조회 출력이 수십 MB 까지 간 기록이 있다.
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024
const PIPE_GRACE_MS = 2_000
export const STOP_GRACE_MS = 2_000
const STOP_POLL_MS = 50
// 옛 명령이 시간 제한을 두지 않던 호출에 준다. setTimeout 이 받는 최댓값(약 24.8일)이고, 넘기면 Node 가 1ms 로 바꾼다
export const NO_LIMIT_MS = 2 ** 31 - 1

function childEnv(env: RunOptions['env']): NodeJS.ProcessEnv | undefined {
  if (!env) return undefined
  const merged: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  return merged
}

// 시그널로 죽은 자식의 종료 코드. 셸과 같이 128 + 신호 번호이고, 모르는 신호는 128 이다.
export function signalCode(signal: NodeJS.Signals): number {
  const number = (constants.signals as Record<string, number>)[signal]
  return 128 + (number ?? 0)
}

// 진행 중인 자식 ---------------------------------------------------------------

type Tracked = { child: ChildProcess; group: boolean }
const tracked = new Set<Tracked>()
let stopSignal: NodeJS.Signals | null = null

// 그룹 전체에 신호를 보낸다. 그룹에 남은 프로세스가 없으면(ESRCH) 넘긴다
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH: 그룹에 남은 프로세스가 없다.
  }
}

export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// 띄운 자식을 끝날 때까지(close) 기억한다. group 은 detached 로 띄워 자식의 pid 가 그룹 번호인 경우다.
// 띄우지 못한 자식(pid 없음)은 기억할 것이 없다
export function trackChild(child: ChildProcess, group: boolean): void {
  if (child.pid === undefined) return
  const entry = { child, group }
  tracked.add(entry)
  child.once('close', () => tracked.delete(entry))
}

// stopChildren 이 받은 신호. 부르기 전이면 null 이다. 띄우기 전과 쓰기 호출 전에 본다
export function stopping(): NodeJS.Signals | null {
  return stopSignal
}

function trackedAlive(entry: Tracked): boolean {
  const pid = entry.child.pid as number
  if (entry.group) return groupAlive(pid)
  return entry.child.exitCode === null && entry.child.signalCode === null
}

function signalTracked(entry: Tracked, signal: NodeJS.Signals): void {
  const pid = entry.child.pid as number
  if (entry.group) killGroup(pid, signal)
  else entry.child.kill(signal)
}

// 기억한 자식에 TERM 을 보내고 모두 끝나거나 graceMs 가 지나기를 기다린 뒤, 남은 것에 KILL 을 보낸다.
// 이 뒤로는 새 자식을 띄우지 않는다(머리 주석의 「진행 중인 자식」)
export async function stopChildren(signal: NodeJS.Signals, graceMs = STOP_GRACE_MS): Promise<void> {
  stopSignal ??= signal
  const targets = [...tracked]
  for (const entry of targets) signalTracked(entry, 'SIGTERM')
  const deadline = Date.now() + graceMs
  while (targets.some(trackedAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS))
  }
  for (const entry of targets) if (trackedAlive(entry)) signalTracked(entry, 'SIGKILL')
}

// stopChildren 뒤에 띄우지 않은 자식의 이유. lib/events.ts 도 같은 문구를 낸다
export function stoppedReason(argv: string[], signal: NodeJS.Signals): string {
  return `${argv[0]} 를 띄우지 않았다: ${signal} 를 받아 끝내는 중이다`
}

function spawnFailure(argv: string[], err: NodeJS.ErrnoException, stdout: string, stderr: string): RunResult {
  const reason = `${argv[0]} 를 실행하지 못했다: ${err.code ?? ''} ${err.message}`.trim()
  return { code: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: stderr ? `${stderr}\n${reason}` : reason, timedOut: false }
}

function overflow(stdout: string, stderr: string, maxBuffer: number): RunResult {
  const reason = `ENOBUFS: 출력이 한도 ${maxBuffer} 바이트를 넘어 자식을 끝냈다`
  return { code: 1, stdout, stderr: stderr ? `${stderr}\n${reason}` : reason, timedOut: false }
}

export function run(argv: string[], opts: RunOptions = {}): RunResult {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
  const done = spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env: childEnv(opts.env),
    input: opts.input,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    killSignal: opts.killSignal ?? 'SIGTERM',
    maxBuffer,
    encoding: 'utf8',
  })
  const stdout = done.stdout ?? ''
  const stderr = done.stderr ?? ''
  // 판정 순서: error.code 를 signal 보다 먼저 본다. spawnSync 는 ETIMEDOUT 과 ENOBUFS 에서도 signal: SIGTERM 을 함께 내므로
  // signal 을 먼저 보면 124 와 1 이 143 으로 바뀐다(Node 22.18 실측).
  // 자식이 stdin 을 읽기 전에 끝나면 EPIPE 가 붙지만 status 는 채워진다. 결과는 종료 코드로 판정하므로 무시한다(runAsync 와 같다).
  const err = done.error as NodeJS.ErrnoException | undefined
  if (err && err.code !== 'EPIPE') {
    if (err.code === 'ETIMEDOUT') return { code: 124, stdout, stderr, timedOut: true }
    if (err.code === 'ENOBUFS') return overflow(stdout, stderr, maxBuffer)
    return spawnFailure(argv, err, stdout, stderr)
  }
  if (done.signal) return { code: signalCode(done.signal), stdout, stderr, timedOut: false }
  return { code: done.status ?? 1, stdout, stderr, timedOut: false }
}

export function runAsync(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
  if (stopSignal) return Promise.resolve({ code: signalCode(stopSignal), stdout: '', stderr: stoppedReason(argv, stopSignal), timedOut: false })
  return new Promise((resolve) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    const size = { out: 0, err: 0 }
    let timedOut = false
    let overflowed = false
    let settled = false
    let terminating = false
    let timer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    let pipeTimer: NodeJS.Timeout | undefined

    const text = () => ({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(pipeTimer)
      resolve(result)
    }

    const group = opts.group ?? false
    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: childEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe'], detached: group })
    trackChild(child, group)

    // TERM 을 보내고 KILL 유예 뒤에도 끝나지 않았으면 KILL 을 보낸다. 그룹으로 띄웠으면 그룹 전체에 보낸다
    const entry: Tracked = { child, group }
    const terminate = () => {
      if (terminating || child.pid === undefined) return
      terminating = true
      signalTracked(entry, 'SIGTERM')
      killTimer = setTimeout(() => {
        if (trackedAlive(entry)) signalTracked(entry, 'SIGKILL')
      }, killGraceMs())
    }
    const collect = (chunks: Buffer[], key: 'out' | 'err') => (chunk: Buffer) => {
      if (overflowed) return
      size[key] += chunk.length
      if (size[key] > maxBuffer) {
        overflowed = true
        terminate()
        return
      }
      chunks.push(chunk)
    }

    child.stdout.on('data', collect(out, 'out'))
    child.stderr.on('data', collect(err, 'err'))
    // 자식이 stdin 을 읽기 전에 끝나면 EPIPE 가 난다. 결과는 종료 코드로 판정하므로 무시한다.
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')

    child.on('error', (e: NodeJS.ErrnoException) => {
      // 띄우지 못한 경우만 여기서 끝낸다. 띄운 뒤의 오류(kill 실패 등)는 close 에서 판정한다.
      if (child.pid === undefined) {
        const { stdout, stderr } = text()
        finish(spawnFailure(argv, e, stdout, stderr))
      }
    })
    // 자식이 끝났는데 손자가 출력 파이프를 쥐고 있으면 close 가 오지 않는다. 시간 초과나 한도 초과로 끝낸 경우에는 바로,
    // 스스로 끝난 경우에는 PIPE_GRACE_MS 뒤에 파이프를 닫아 close 를 부른다. 바로 닫지 않는 것은 파이프에 남은 출력을 받기 위해서다.
    // 끝난 자식에 시간 제한 타이머가 뒤늦게 돌아 124 를 내지 않게 여기서 지운다.
    let exited: { status: number | null; signal: NodeJS.Signals | null } | null = null
    const closePipes = () => {
      child.stdout.destroy()
      child.stderr.destroy()
    }
    child.on('exit', (status: number | null, signal: NodeJS.Signals | null) => {
      exited = { status, signal }
      clearTimeout(timer)
      if (timedOut || overflowed) closePipes()
      else pipeTimer = setTimeout(closePipes, PIPE_GRACE_MS)
    })
    child.on('close', (status: number | null, signal: NodeJS.Signals | null) => {
      const { stdout, stderr } = text()
      if (timedOut) return finish({ code: 124, stdout, stderr, timedOut: true })
      if (overflowed) return finish(overflow(stdout, stderr, maxBuffer))
      const end = exited ?? { status, signal }
      if (end.signal) return finish({ code: signalCode(end.signal), stdout, stderr, timedOut: false })
      finish({ code: end.status ?? 1, stdout, stderr, timedOut: false })
    })

    timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  })
}

function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => resolve())
  })
}

export async function runInherit(argv: string[], opts: Omit<RunOptions, 'input' | 'maxBuffer'> = {}): Promise<{ code: number; timedOut: boolean }> {
  await Promise.all([flush(process.stdout), flush(process.stderr)])
  if (stopSignal) {
    process.stderr.write(`${stoppedReason(argv, stopSignal)}\n`)
    return { code: signalCode(stopSignal), timedOut: false }
  }
  return new Promise((resolve) => {
    let timedOut = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve({ code, timedOut })
    }
    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: childEnv(opts.env), stdio: 'inherit' })
    trackChild(child, false)
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (child.pid !== undefined) return
      process.stderr.write(`${spawnFailure(argv, e, '', '').stderr}\n`)
      finish(e.code === 'ENOENT' ? 127 : 1)
    })
    // 파이프가 없어 손자가 출력을 쥐어도 기다릴 것이 없다. 자식이 끝나면 바로 판정한다
    child.on('exit', (status: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) return finish(124)
      if (signal) return finish(signalCode(signal))
      finish(status ?? 1)
    })
    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, killGraceMs())
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  })
}

// 명령끼리 서로 부를 때 쓴다. 확장자로 인터프리터를 고른다.
//     .ts    이 프로세스의 node(process.execPath). PATH 의 node 가 24 보다 낮아도 지금 도는 node 로 띄운다
//     .sh    bash
//     .zsh   zsh
//     그 밖  python3. `.py` 와 확장자 없는 파일, 모르는 확장자가 모두 여기다.
//            옛 Python 명령의 script_command 가 .sh 와 .zsh 가 아니면 모두 Python 으로 띄웠다.
//            SPEC_LINE, MAKE_WORKTREE, NUDGE_WORKER, LAUNCH_WORKER 로 바꾼 도구를 옛 명령과 같게 실행하려는 것이다
export function scriptCommand(script: string, args: string[]): string[] {
  switch (extname(script)) {
    case '.ts':
      return [process.execPath, '--disable-warning=ExperimentalWarning', script, ...args]
    case '.sh':
      return ['bash', script, ...args]
    case '.zsh':
      return ['zsh', script, ...args]
    default:
      return ['python3', script, ...args]
  }
}

// execve 가 받는 실행 파일 형식의 앞 4바이트(big-endian). Mach-O 32/64비트와 그 반대 바이트 순서, fat(universal), ELF 다
const EXEC_MAGIC = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0x7f454c46]

// 앞 바이트가 `#!` 이거나 EXEC_MAGIC 이면 true. `#!` 없는 셸 스크립트처럼 execve 가 ENOEXEC 로 거절할 파일은 false 다.
// 파일을 읽지 못하면 true 다. 읽기 권한 없이 실행 권한만 있는 바이너리는 execve 가 실행한다.
function execFormat(path: string): boolean {
  const head = Buffer.alloc(4)
  let size: number
  try {
    const fd = openSync(path, 'r')
    try {
      size = readSync(fd, head, 0, 4, 0)
    } finally {
      closeSync(fd)
    }
  } catch {
    return true
  }
  if (size >= 2 && head[0] === 0x23 && head[1] === 0x21) return true
  return size === 4 && EXEC_MAGIC.includes(head.readUInt32BE(0))
}

// argv[0] 을 옛 명령의 os.execvp 처럼 찾는다. `/` 가 있으면 그 경로만, 없으면 PATH 의 폴더를 앞에서부터 본다(빈 칸은 현재 폴더).
// 실행할 수 없거나 형식이 틀린 파일은 건너뛰고 다음 폴더를 본다. 쓸 것이 없으면 처음 만난 실패로 판정한다.
//     126  실행할 수 없는 파일(실행 권한이 없거나 파일이 아니다)
//     1    형식이 틀린 파일(os.execvp 의 OSError ENOEXEC 를 옛 명령이 1 로 끝냈다)
//     127  아무것도 없다
function findExecutable(name: string): { path: string } | { code: 1 | 126 | 127 } {
  // PATH 가 없을 때 execvp 가 쓰는 기본값이다
  const dirs = name.includes('/') ? [''] : (process.env.PATH ?? '/usr/bin:/bin').split(delimiter)
  let failed: 1 | 126 | undefined
  for (const dir of dirs) {
    const candidate = name.includes('/') ? name : join(dir || '.', name)
    let stat
    try {
      stat = statSync(candidate)
    } catch {
      continue
    }
    try {
      if (!stat.isFile()) throw new Error('not a file')
      accessSync(candidate, fsConstants.X_OK)
    } catch {
      failed ??= 126
      continue
    }
    if (execFormat(candidate)) return { path: candidate }
    failed ??= 1
  }
  return { code: failed ?? 127 }
}

// 이 프로세스를 argv 의 명령으로 바꾼다. 바꾸면 돌아오지 않는다. 돌아오면 바꾸지 못한 것이고 종료 코드를 낸다.
//     127  명령이 없다. stderr 에 `<label>: command not found: <명령>`
//     126  실행할 수 없다. stderr 에 `<label>: command is not executable: <명령>`
//     1    실행 파일 형식이 아니다(`#!` 없는 스크립트 같은 것). stderr 에 `<label>: exec format error: <명령>`
// 실행 파일은 먼저 찾아 확인한 뒤 넘긴다. process.execve 는 실패하면 예외를 던지지 않고 프로세스를 abort(종료 코드 134)한다
// (Node 24.15 실측: 없는 경로에 ENOENT 와 네이티브 스택을 내고 죽었다). PATH 도 찾지 않으므로 경로를 풀어 넘긴다.
// 넘기기 전에 쓴 출력은 동기로 써야 한다. 파이프로 가는 비동기 쓰기는 exec 와 함께 사라진다.
export function execCommand(argv: string[], label: string): number {
  const found = findExecutable(argv[0])
  if ('code' in found) {
    const reason = { 1: 'exec format error', 126: 'command is not executable', 127: 'command not found' }[found.code]
    process.stderr.write(`${label}: ${reason}: ${argv[0]}\n`)
    return found.code
  }
  process.execve!(found.path, argv, process.env as Record<string, string>)
  return 1
}
