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
// runAsync 는 시간을 넘기면 TERM 을 보내고, 10초 뒤에도 살아 있으면 KILL 을 보낸다.
// runAsync 는 자식이 끝난 뒤 2초 안에 출력 파이프가 닫히지 않으면(백그라운드 손자가 쥐고 있다) 파이프를 닫고 자식의 종료 코드를 낸다.
// 손자가 그 뒤에 쓴 출력은 버린다. 끝난 자식에는 시간 제한을 적용하지 않으므로 이때 124 가 아니다.

import { spawn, spawnSync } from 'node:child_process'
import { constants } from 'node:os'
import { extname } from 'node:path'

export type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean }
export type RunOptions = {
  cwd?: string
  // process.env 위에 덮는다. 값이 undefined 인 키는 자식 환경에서 지운다.
  env?: Record<string, string | undefined>
  input?: string
  timeoutMs?: number
  // 출력 한도(바이트, stdout 과 stderr 각각). 테스트가 256MB 를 실제로 만들지 않게 하려고 둔 내부용 칸이다.
  maxBuffer?: number
}

const DEFAULT_TIMEOUT_MS = 60_000
// spawnSync 의 기본 1MB 를 넘으면 자식이 SIGTERM 으로 죽는다. orca 조회 출력이 수십 MB 까지 간 기록이 있다.
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024
const KILL_GRACE_MS = 10_000
const PIPE_GRACE_MS = 2_000

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
    killSignal: 'SIGTERM',
    maxBuffer,
    encoding: 'utf8',
  })
  const stdout = done.stdout ?? ''
  const stderr = done.stderr ?? ''
  // 판정 순서: error.code 를 signal 보다 먼저 본다. spawnSync 는 ETIMEDOUT 과 ENOBUFS 에서도 signal: SIGTERM 을 함께 내므로
  // signal 을 먼저 보면 124 와 1 이 143 으로 바뀐다(Node 22.18 실측).
  const err = done.error as NodeJS.ErrnoException | undefined
  if (err) {
    if (err.code === 'ETIMEDOUT') return { code: 124, stdout, stderr, timedOut: true }
    if (err.code === 'ENOBUFS') return overflow(stdout, stderr, maxBuffer)
    return spawnFailure(argv, err, stdout, stderr)
  }
  if (done.signal) return { code: signalCode(done.signal), stdout, stderr, timedOut: false }
  return { code: done.status ?? 1, stdout, stderr, timedOut: false }
}

export function runAsync(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
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

    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: childEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe'] })

    // TERM 을 보내고 10초 뒤에도 끝나지 않았으면 KILL 을 보낸다.
    const terminate = () => {
      if (terminating) return
      terminating = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, KILL_GRACE_MS)
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

// 명령끼리 서로 부를 때 쓴다. 확장자로 인터프리터를 고르고, 모르는 확장자는 그대로 실행한다.
export function scriptCommand(script: string, args: string[]): string[] {
  switch (extname(script)) {
    case '.ts':
      return ['node', '--disable-warning=ExperimentalWarning', script, ...args]
    case '.py':
      return ['python3', script, ...args]
    case '.sh':
      return ['bash', script, ...args]
    case '.zsh':
      return ['zsh', script, ...args]
    default:
      return [script, ...args]
  }
}
