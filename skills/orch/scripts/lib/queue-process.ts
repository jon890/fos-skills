// 상주 루프와 직접 건 큐가 같은 명령줄 판정을 쓴다.
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { mainCheckout } from './git.ts'
import { run } from './proc.ts'

export type Proc = { pid: number; command: string }

export function isQueueCommand(command: string): boolean {
  return ['merge_queue.', 'merge-queue.sh', 'merge-with-finish.'].some((name) => command.includes(name))
}

export function processes(): Proc[] | null {
  const done = run([process.env.PS || 'ps', '-Ao', 'pid=,command='], { env: { LC_ALL: 'C' } })
  if (done.code !== 0) return null
  return done.stdout.split('\n').flatMap((line) => {
    const found = /^\s*(\d+)\s+(.*)$/.exec(line)
    return found ? [{ pid: Number(found[1]), command: found[2] }] : []
  })
}

// 프로세스의 작업 폴더. lsof 로 읽고, 읽지 못하면 null 이다. LSOF 환경 변수로 실행 파일을 바꾼다
export function procCwd(pid: number): string | null {
  const done = run([process.env.LSOF || 'lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { env: { LC_ALL: 'C' }, timeoutMs: 10_000 })
  if (done.code !== 0) return null
  const line = done.stdout.split('\n').find((row) => row.startsWith('n/'))
  return line ? line.slice(1) : null
}

// 큐 프로세스가 다루는 저장소 경로. 명령줄의 --repo 값(상대경로면 작업 폴더 기준), 없으면 작업 폴더다. 알 수 없으면 null 이다.
// 명령줄은 공백으로 나눠 읽으므로 공백이 든 경로는 앞부분만 읽는다. 그때는 그 경로가 없어 다른 저장소로 본다
export function queueRepoOf(proc: Proc, cwd: (pid: number) => string | null = procCwd): string | null {
  const words = proc.command.split(/\s+/)
  let value: string | null = null
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '--repo' && i + 1 < words.length) value = words[i + 1]
    else if (words[i].startsWith('--repo=')) value = words[i].slice('--repo='.length)
  }
  if (value && isAbsolute(value)) return value
  const dir = cwd(proc.pid)
  if (!dir) return null
  return value ? resolve(dir, value) : dir
}

// 이 저장소(repo)의 머지 큐 프로세스. 상주 루프의 자동 머지가 다른 저장소의 큐나 테스트가 띄운 큐에 막히지 않게 한다(2026-11-20 fos-assistant).
// known 은 이 저장소의 차례 기록과 맡은 PR 기록에 든 pid 다. 그 밖의 큐 명령줄은 queueRepoOf 의 경로가 이 저장소의 주 checkout 일 때만 센다.
// 경로를 알 수 없으면 이 저장소의 큐로 센다. 다른 저장소 큐를 기다리는 것보다 같은 base 를 두 큐가 움직이는 쪽이 나쁘다.
// 경로가 없으면(지운 임시 저장소) 이 저장소가 아니다
export function repoQueues(list: Proc[], repo: string, known: ReadonlySet<number>, cwd: (pid: number) => string | null = procCwd): Proc[] {
  const main = mainCheckout(repo)
  return list.filter((proc) => {
    if (!isQueueCommand(proc.command)) return false
    if (known.has(proc.pid)) return true
    const dir = queueRepoOf(proc, cwd)
    if (dir === null) return true
    return existsSync(dir) && mainCheckout(dir) === main
  })
}
