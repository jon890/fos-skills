// check-deck 이 쓰는 출력과 진입 판정. 자식 프로세스와 같은 fd 에 쓰는 일이 없어도 순서가 바뀌지 않게 동기로 쓴다.

import { writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// import.meta.main 은 Node 24.2 부터 있다. 24.0·24.1 에서 아무것도 하지 않고 0 으로 끝나지 않게 경로로도 본다
export function isMain(url: string, flag: boolean | undefined): boolean {
  return Boolean(flag) || (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(url))
}
