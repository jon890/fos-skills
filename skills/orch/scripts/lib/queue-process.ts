// 상주 루프와 직접 건 큐가 같은 명령줄 판정을 쓴다.
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
