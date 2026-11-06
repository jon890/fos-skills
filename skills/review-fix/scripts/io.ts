// 이 폴더의 명령이 함께 쓰는 출력, 자식 프로세스 실행, 진입 판정.
// 출력은 자식 프로세스와 같은 fd 에 쓰므로 순서가 바뀌지 않게 동기로 쓴다.

import { spawnSync } from 'node:child_process'
import { realpathSync, writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeNewlines, pyDecode } from './kit/py.ts'

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

export type Captured = { code: number; stdout: string; stderr: string }

// subprocess.run(capture_output=True, text=True) 와 같다. stdout 과 stderr 를 줄바꿈을 \n 으로 바꿔 읽고 stdin 은 물려준다.
// 실행 파일을 띄우지 못하면 던진다. 신호로 끝난 자식은 0 이 아닌 코드로 센다
export function capture(argv: string[], env?: NodeJS.ProcessEnv): Captured {
  const done = spawnSync(argv[0], argv.slice(1), { env, stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 1 << 30 })
  if (done.error) throw done.error
  return {
    code: done.status ?? 128,
    stdout: normalizeNewlines(pyDecode(done.stdout)),
    stderr: normalizeNewlines(pyDecode(done.stderr)),
  }
}
