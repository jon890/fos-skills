// 이 폴더의 명령이 함께 쓰는 출력, 표준 입력, 진입 판정.
// 출력은 자식 프로세스와 같은 fd 에 쓰므로 순서가 바뀌지 않게 동기로 쓴다.

import { readSync, realpathSync, writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pyDecode } from './kit/py.ts'

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
