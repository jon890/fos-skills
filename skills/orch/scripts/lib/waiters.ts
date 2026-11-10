// 한 Run 의 살아 있는 대기(wait-important)와 질문 감시(watch-questions) 프로세스를 찾는다.
// 사용처: orch-doctor.ts(session-resume 의 waiters), loop/lifecycle.ts(루프를 띄울 때 남은 옛 대기를 WAITER-LEFT 로 알리기).
//
// `ps -axo pid=,command=` 의 행 가운데 명령줄에 `wait-important` 나 `watch-questions` 와 Run id(낱말)가 든 것의 pid 다. 다음 행은 뺀다.
//     - `orchestration check` 행. wait-important 가 띄운 자식이라 대기 하나를 두 번 세게 된다
//     - 셸 행(sh, bash, zsh, dash, fish 가 띄운 `-c` 명령). 대기 자신이 아니라 그것을 띄운 셸이다
//     - 부르는 프로세스 자신
// PS 환경 변수로 ps 실행 파일을 바꾼다. ps 는 LC_ALL=C 로 부른다(wait-important 와 같다).
// ps 를 읽지 못하면 null 이다. 부르는 쪽이 「모름」 으로 다룬다(대기가 없다고 단정하지 않는다).

import { basename } from 'node:path'
import { run } from './proc.ts'

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function waiterPids(runId: string): { ok: true; pids: number[] } | { ok: false; error: string } {
  const done = run([process.env.PS || 'ps', '-axo', 'pid=,command='], { env: { LC_ALL: 'C' } })
  if (done.code !== 0) return { ok: false, error: `프로세스 목록을 읽지 못했다(ps 종료 코드 ${done.code}): ${done.stderr.trim()}` }
  const word = new RegExp(`(?<![\\w-])${escapeRegExp(runId)}(?![\\w-])`)
  const pids: number[] = []
  for (const line of done.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const command = m[2]
    if (pid === process.pid || !word.test(command)) continue
    if (!command.includes('wait-important') && !command.includes('watch-questions')) continue
    // 가짜 orca 의 경로처럼 `wait-important` 가 든 orca 명령줄도 자식 check 다
    if (/\borchestration\s+check\b/.test(command)) continue
    if (SHELLS.has(basename(command.split(/\s+/)[0]).replace(/^-+/, ''))) continue
    pids.push(pid)
  }
  return { ok: true, pids }
}
