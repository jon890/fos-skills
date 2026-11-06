// 이 폴더의 명령이 함께 쓰는 출력, 표준 입력, 자식 프로세스 실행, 진입 판정.
// 출력은 자식 프로세스와 같은 fd 에 쓰므로 순서가 바뀌지 않게 동기로 쓴다.

import { spawnSync } from 'node:child_process'
import { constants } from 'node:os'
import { readSync, realpathSync, writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeNewlines, pyDecode, pyReadText } from './kit/py.ts'

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

// sys.stdin.read(). POSIX 의 표준 입력은 줄바꿈을 바꾸지 않는다(파일을 읽는 read_text 와 다르다). UTF-8 이 아니면 던진다
export function readStdin(): string {
  const chunks: Buffer[] = []
  const buf = Buffer.alloc(1 << 16)
  for (;;) {
    let n: number
    try {
      n = readSync(0, buf, 0, buf.length, null)
    } catch (error) {
      // 비동기 파이프가 아직 비었다. 다시 읽는다
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue
      if ((error as NodeJS.ErrnoException).code === 'EOF') break
      throw error
    }
    if (n === 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
  }
  return pyDecode(Buffer.concat(chunks))
}

export type Captured = { code: number; stdout: string; stderr: string }

// subprocess.run(capture_output=True, text=True) 와 같다. stdout 과 stderr 를 줄바꿈을 \n 으로 바꿔 읽는다.
// 실행 파일을 띄우지 못하면 던진다. 신호로 끝난 자식은 0 이 아닌 코드로 센다
export function capture(argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Captured {
  const done = spawnSync(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 1 << 30 })
  if (done.error) throw done.error
  return {
    code: returncode(done),
    stdout: normalizeNewlines(pyDecode(done.stdout)),
    stderr: normalizeNewlines(pyDecode(done.stderr)),
  }
}

// Popen.returncode. 신호로 끝나면 신호 번호의 음수다
export function returncode(done: { status: number | null; signal: NodeJS.Signals | null }): number {
  if (done.status !== null) return done.status
  return done.signal ? -(constants.signals[done.signal] ?? 1) : 1
}

// 명령을 돌리지 못한 경우를 가리는 오류. 부르는 쪽이 「검사를 실행하지 못했다」 로 알리고 2 로 끝낸다
export class ValueError extends Error {}

const ERRNO: Record<string, [number, string]> = {
  ENOENT: [2, 'No such file or directory'],
  EACCES: [13, 'Permission denied'],
  ENOTDIR: [20, 'Not a directory'],
  EISDIR: [21, 'Is a directory'],
  EEXIST: [17, 'File exists'],
  ELOOP: [40, 'Too many levels of symbolic links'],
}

// Python OSError 의 문구. 파일 이름을 따옴표로 둘러 붙인다
export function osErrorText(error: NodeJS.ErrnoException, path?: string): string {
  const known = error.code ? ERRNO[error.code] : undefined
  if (!known) return error.message
  const target = path ?? error.path
  return `[Errno ${known[0]}] ${known[1]}${target ? `: '${target}'` : ''}`
}

// Path.read_text(encoding="utf-8"). 줄바꿈을 \n 으로 바꾸고 UTF-8 이 아니면 던진다. 파일 오류의 문구는 Python OSError 를 따른다
export function readTextFile(path: string): string {
  try {
    return pyReadText(path)
  } catch (error) {
    const failure = error as NodeJS.ErrnoException
    if (typeof failure?.code === 'string' && failure.code in ERRNO) failure.message = osErrorText(failure, path)
    throw error
  }
}

// OSError 와 ValueError(JSON 해석, UTF-8 해석 포함)에 해당하는 오류인가. 그 밖의 오류는 프로그램 결함이라 그대로 던진다
export function isExpected(error: unknown): error is Error {
  if (error instanceof ValueError || error instanceof SyntaxError) return true
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && (code in ERRNO || code === 'ERR_ENCODING_INVALID_ENCODED_DATA' || code.startsWith('E'))
}
