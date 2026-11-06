// 큐의 판정 함수는 별도 환경에서 실행하고 gh/git 가짜만 같은 프로세스의 함수로 부른다.
// 실제 CLI 와 신호 경계 테스트는 merge_queue.ts 를 직접 실행한다.
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../../scripts/queue/merge_queue.ts'
import { runProcess } from '../../scripts/lib/proc.ts'
import type { RunOptions, RunResult } from '../../scripts/lib/proc.ts'
import { FAKE_GH, FAKE_GIT } from './merge-queue-fakes.ts'

const require = createRequire(import.meta.url)
const bodies = {
  gh: new Function('require', 'process', FAKE_GH),
  git: new Function('require', 'process', FAKE_GIT),
}

// 실행 파일과 같은 본문에 argv, 환경, 출력, 종료 경계만 제공한다. 상태 파일과 jq 는 실제로 쓴다.
export function statefulRun(fakeGit: boolean) {
  return (argv: string[], opts: RunOptions = {}): RunResult => {
    const command = basename(argv[0])
    if (command !== 'gh' && !(command === 'git' && fakeGit)) return runProcess(argv, opts)
    let stdout = ''
    let stderr = ''
    let code = 0
    const exited = Symbol('fake-exit')
    const fakeFs = {
      ...fs,
      writeSync(fd: number, data: string | Uint8Array) {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString()
        if (fd === 1) stdout += text
        else if (fd === 2) stderr += text
        else throw new Error(`가짜 출력 파일 번호: ${fd}`)
        return Buffer.byteLength(text)
      },
    }
    try {
      bodies[command as keyof typeof bodies]((name: string) => name === 'node:fs' ? fakeFs : require(name), {
        argv: [process.execPath, argv[0], ...argv.slice(1)],
        env: { ...process.env, ...opts.env },
        exit(status = 0) { code = status; throw exited },
      })
    } catch (error) {
      if (error !== exited) {
        code = 1
        stderr += `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
      }
    }
    return { code, stdout, stderr, timedOut: false }
  }
}

if (import.meta.main || (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), statefulRun(process.env.MERGE_QUEUE_FAKE_GIT === '1')).then(
    (code) => { process.exitCode = code },
    (error) => { console.error(error); process.exitCode = 1 },
  )
}
