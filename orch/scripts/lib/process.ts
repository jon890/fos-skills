// pid 생존 확인과 작업 디렉터리 점유 프로세스 찾기의 한 벌이다.

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { run } from './proc.ts'

// EPERM 은 그 pid 의 프로세스가 있지만 신호를 보낼 권한이 없다는 뜻이라 살아 있다고 본다.
// EPERM 을 죽음으로 읽으면 같은 PR 의 마무리를 겹쳐 걸 수 있었다.
// 정수가 아니거나 1 미만이면 process.kill 을 부르지 않는다. process.kill(0, 0) 은 자기 프로세스 그룹에 보내져 늘 성공하므로
// 깨진 pid 파일이 살아 있는 것으로 읽혀 잠금이 회수되지 않는다.
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// dir 이나 그 하위를 작업 디렉터리로 쓰는 프로세스의 pid 와 작업 디렉터리.
// 조회에 실패하면 빈 목록이 아니라 ok: false 를 낸다. 부르는 쪽은 이것을 「누군가 쥐고 있다」 로 본다.
// 빈 목록으로 내면 쓰는 중인 워크트리를 지울 수 있어서다.
export function cwdHolders(dir: string): { ok: true; holders: { pid: number; cwd: string }[] } | { ok: false; error: string } {
  // macOS 의 임시 폴더는 /var 와 /private/var 로 갈리고 lsof 는 실경로를 내므로 dir 을 실경로로 바꿔 비교한다.
  let target: string
  try {
    target = realpathSync(dir)
  } catch {
    target = resolve(dir)
  }
  const done = run(['lsof', '-d', 'cwd', '-Fpn'])
  // lsof 는 맞는 프로세스가 없으면 1 로 끝난다. 그 밖의 종료 코드는 안전을 증명하지 못한다.
  if (done.code !== 0 && done.code !== 1) {
    return { ok: false, error: `작업 디렉터리 점유 프로세스를 조회하지 못했다(lsof 종료 코드 ${done.code}): ${done.stderr.trim()}` }
  }
  const holders: { pid: number; cwd: string }[] = []
  let pid: number | null = null
  for (const line of done.stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
    } else if (line.startsWith('n') && pid !== null && Number.isInteger(pid)) {
      const cwd = line.slice(1)
      if (cwd === target || cwd.startsWith(`${target}/`)) holders.push({ pid, cwd })
    }
  }
  return { ok: true, holders }
}
