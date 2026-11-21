// 이 폴더의 명령이 함께 쓰는 출력, 진입 판정, 파일 읽기, 자식 프로세스 실행.
// 출력은 자식 프로세스와 같은 fd 에 쓰므로 순서가 바뀌지 않게 동기로 쓴다.

import { spawnSync } from 'node:child_process'
import { accessSync, closeSync, constants as fsConstants, openSync, readFileSync, readSync, realpathSync, statSync, writeSync } from 'node:fs'
import { constants } from 'node:os'
import { fileURLToPath } from 'node:url'
import { normalizeNewlines, PY_SPACE as PY_SPACE_CLASS } from './kit/py.ts'
import { osErrorMessage, pyRepr } from './pylike.ts'

export function write(fd: 1 | 2, text: string): void {
  let buf = Buffer.from(text)
  while (buf.length) {
    try {
      buf = buf.subarray(writeSync(fd, buf))
    } catch (error) {
      // 파이프가 가득 찼다. 비워질 때까지 다시 쓴다
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
    }
  }
}

// import.meta.main 은 Node 24.2 부터 있다. 24.0·24.1 에서 아무것도 하지 않고 0 으로 끝나지 않게 경로로도 본다.
// 심볼릭 링크로 불리면 argv[1] 은 링크 경로이고 import.meta.url 은 실체 경로라 둘 다 실체로 바꿔 비교한다
export function isMain(url: string, flag: boolean | undefined): boolean {
  if (flag) return true
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url))
  } catch {
    return false
  }
}

// open(path, encoding="utf-8").read(). 줄바꿈을 \n 으로 바꾸고 잘못된 바이트는 던진다(UnicodeDecodeError 는 ValueError 다)
export function readTextStrict(path: string): string {
  return normalizeNewlines(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)))
}

// `-` 이면 표준 입력, 아니면 파일을 strict UTF-8 로 읽는다. sys.stdin.read() 또는 open(path, encoding="utf-8").read() 와 같다
export function readInput(path: string): string {
  const bytes = path === '-' ? readFileSync(0) : readFileSync(path)
  return normalizeNewlines(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
}

// 파일의 앞 maxLines 줄. open(path, encoding="utf-8", errors="replace") 를 줄 단위로 읽는 것과 같다. 줄바꿈은 \n, \r, \r\n 이다
export function readFirstLines(path: string, maxLines: number): string[] {
  const fd = openSync(path, 'r')
  try {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    const chunk = Buffer.alloc(65536)
    let text = ''
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null)
      if (n === 0) break
      text += decoder.decode(chunk.subarray(0, n), { stream: true })
      // 줄바꿈이 maxLines 개 넘게 모이면 충분하다. 끝이 \r 이면 \r\n 의 앞쪽일 수 있어 하나 더 본다
      if ((text.match(/\r\n|[\n\r]/g) ?? []).length > maxLines) break
    }
    text += decoder.decode()
    const lines = normalizeNewlines(text).split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    return lines.slice(0, maxLines)
  } finally {
    closeSync(fd)
  }
}

// Popen.returncode. 신호로 끝나면 신호 번호의 음수다
export function returncode(done: { status: number | null; signal: NodeJS.Signals | null }): number {
  if (done.status !== null) return done.status
  return done.signal ? -(constants.signals[done.signal] ?? 1) : 1
}

const DEFAULT_PATH = '/usr/bin:/bin'

// shutil.which. PATH 가 비어 있으면 못 찾고, 없으면 기본 경로를 쓴다
export function which(name: string): string | null {
  const path = process.env.PATH ?? DEFAULT_PATH
  if (!path) return null
  for (const dir of path.split(':')) {
    const candidate = `${dir || '.'}/${name}`
    try {
      if (!statSync(candidate).isDirectory()) {
        accessSync(candidate, fsConstants.X_OK)
        return candidate
      }
    } catch {
      continue
    }
  }
  return null
}

// 폭을 코드 포인트 수로 센 str.ljust, rjust
export function ljust(text: string, width: number): string {
  const n = [...text].length
  return n >= width ? text : text + ' '.repeat(width - n)
}

export function rjust(text: string, width: number): string {
  const n = [...text].length
  return n >= width ? text : ' '.repeat(width - n) + text
}

// subprocess.run(argv, capture_output=True, text=True, timeout=...) 의 결과. 시간 초과와 실행 실패는 던지지 않고 failure 로 돌려준다
export type RunResult = { code: number; stdout: string; stderr: string; failure: 'timeout' | 'oserror' | null; message: string }

export type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutSec?: number; closeStdin?: boolean; mergeStderr?: boolean }

const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function runText(argv: string[], opts: RunOptions = {}): RunResult {
  const command = opts.mergeStderr ? ['/bin/sh', '-c', 'exec "$@" 2>&1', 'sh', ...argv] : argv
  // timeout=0 은 Python 에서 바로 시간 초과다. Node 에서 0 은 제한 없음이라 1ms 로 바꾼다
  const timeout = opts.timeoutSec === undefined ? undefined : Math.max(1, Math.round(opts.timeoutSec * 1000))
  const done = spawnSync(command[0], command.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    timeout,
    killSignal: 'SIGKILL',
    stdio: [opts.closeStdin ? 'ignore' : 'inherit', 'pipe', 'pipe'],
    maxBuffer: 1 << 30,
  })
  if (done.error) {
    const code = (done.error as NodeJS.ErrnoException).code
    if (code === 'ETIMEDOUT') {
      return { code: -9, stdout: '', stderr: '', failure: 'timeout', message: `Command '[${argv.map(pyRepr).join(', ')}]' timed out after ${opts.timeoutSec} seconds` }
    }
    return { code: 127, stdout: '', stderr: '', failure: 'oserror', message: osErrorMessage(done.error, opts.cwd !== undefined && code === 'ENOENT' && opts.cwd !== '' && !statOk(opts.cwd) ? opts.cwd : argv[0]) }
  }
  return {
    code: returncode(done),
    stdout: normalizeNewlines(STRICT.decode(done.stdout)),
    stderr: normalizeNewlines(STRICT.decode(done.stderr)),
    failure: null,
    message: '',
  }
}

function statOk(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

// time.sleep(seconds)
export function sleep(seconds: number): void {
  if (seconds < 0) throw new Error('sleep length must be non-negative')
  if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)
}

// str.rstrip()
const TRAILING_SPACE = new RegExp(`${PY_SPACE_CLASS}+$`)
export function rstrip(text: string): string {
  return text.replace(TRAILING_SPACE, '')
}

// subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=...). 시간 초과와 실행 실패는 종료 코드 124 와 오류 문장이다
export function gitRun(repo: string, args: string[], opts: { timeoutSec?: number; env?: NodeJS.ProcessEnv } = {}): RunResult {
  const done = runText(['git', '-C', repo, ...args], { timeoutSec: opts.timeoutSec ?? 30, env: opts.env })
  return done.failure ? { code: 124, stdout: '', stderr: done.message, failure: done.failure, message: done.message } : done
}

// subprocess.run(argv, capture_output=True, timeout=..., stdin=DEVNULL).returncode == 0. 출력은 읽지 않는다
export function runOk(argv: string[], timeoutSec = 60): boolean {
  const done = spawnSync(argv[0], argv.slice(1), { timeout: Math.max(1, Math.round(timeoutSec * 1000)), killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 })
  return !done.error && done.status === 0
}
