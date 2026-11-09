// 이 폴더의 명령이 함께 쓰는 출력, 진입 판정, 파일 읽기, 자식 프로세스 실행.
// 출력은 자식 프로세스와 같은 fd 에 쓰므로 순서가 바뀌지 않게 동기로 쓴다.

import { spawnSync } from 'node:child_process'
import { accessSync, closeSync, constants as fsConstants, openSync, readFileSync, readSync, realpathSync, statSync, writeSync } from 'node:fs'
import { constants } from 'node:os'
import { fileURLToPath } from 'node:url'
import { normalizeNewlines } from './kit/py.ts'

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

// Path.read_text(encoding="utf-8", errors="replace"). 줄바꿈을 \n 으로 바꾸고 잘못된 바이트는 U+FFFD 로 바꾼다. BOM 은 지우지 않는다
export function readTextReplace(path: string): string {
  return normalizeNewlines(new TextDecoder('utf-8', { ignoreBOM: true }).decode(readFileSync(path)))
}

// 같은 UTF-8 대체 규칙으로 파일을 조금씩 읽는다. 줄 끝은 빼고, 마지막 개행 없는 줄도 낸다.
// 청크 사이 UTF-8 문자와 CRLF 를 이어 처리한다. 중간에 반복을 끝내도 파일을 닫는다.
export function* iterTextLinesReplace(path: string, chunkSize = 64 * 1024): Generator<string> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError('chunkSize must be a positive integer')
  const buffer = Buffer.alloc(chunkSize)
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  const fd = openSync(path, 'r')
  const fragments: string[] = []
  let afterCR = false
  try {
    while (true) {
      const size = readSync(fd, buffer, 0, buffer.length, null)
      let text = decoder.decode(buffer.subarray(0, size), { stream: size !== 0 })
      if (text) {
        if (afterCR && text.startsWith('\n')) text = text.slice(1)
        afterCR = text.endsWith('\r')
        let start = 0
        for (const match of text.matchAll(/\r\n|\r|\n/g)) {
          fragments.push(text.slice(start, match.index))
          const line = fragments.join('')
          fragments.length = 0
          yield line
          start = match.index + match[0].length
        }
        if (start < text.length) fragments.push(text.slice(start))
      }
      if (size === 0) break
    }
    if (fragments.length) yield fragments.join('')
  } finally {
    closeSync(fd)
  }
}

// bytes.decode("utf-8", errors="replace")
export function decodeReplace(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
}

// Popen.returncode. 신호로 끝나면 신호 번호의 음수다
export function returncode(done: { status: number | null; signal: NodeJS.Signals | null }): number {
  if (done.status !== null) return done.status
  return done.signal ? -(constants.signals[done.signal] ?? 1) : 1
}

export type Captured = { code: number; stdout: string; stderr: string; missing: boolean }

// subprocess.run(capture_output=True, text=True). 줄바꿈을 \n 으로 바꿔 읽는다. 실행 파일이 없으면 missing 이다.
// 출력이 UTF-8 이 아니면 옛 명령처럼 던진다
export function capture(argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Captured {
  const done = spawnSync(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 1 << 30 })
  if (done.error) {
    if ((done.error as NodeJS.ErrnoException).code === 'ENOENT') return { code: 127, stdout: '', stderr: '', missing: true }
    throw done.error
  }
  const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  return { code: returncode(done), stdout: normalizeNewlines(strict.decode(done.stdout)), stderr: normalizeNewlines(strict.decode(done.stderr)), missing: false }
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
