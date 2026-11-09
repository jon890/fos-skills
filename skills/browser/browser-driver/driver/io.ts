// 출력과 직접 실행 판정. 출력은 자식 프로세스와 같은 fd 에 쓰므로 순서가 바뀌지 않게 동기로 쓴다.

import { realpathSync, writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { currentRuntime } from './runtime.ts'

export function write(fd: 1 | 2, text: string): void {
  // 짝 없는 서로게이트는 UTF-8 로 쓸 수 없다. Python 은 UnicodeEncodeError 로 끝난다
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) throw new Error("'utf-8' codec can't encode character: surrogates not allowed")
  const runtime = currentRuntime()
  if (runtime) return runtime.write(fd, text)
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

// print(text)
export const print = (text: string): void => write(1, `${text}\n`)
export const eprint = (text: string): void => write(2, `${text}\n`)

// import.meta.main 은 Node 24.2 부터 있다. 24.0·24.1 에서 아무것도 하지 않고 0 으로 끝나지 않게 경로로도 본다.
// 심볼릭 링크로 불리면 argv[1] 은 링크 경로이고 import.meta.url 은 실체 경로라 둘 다 실체로 바꿔 견준다
export function isMain(url: string, flag: boolean | undefined): boolean {
  if (flag) return true
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url))
  } catch {
    return false
  }
}
