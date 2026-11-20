// pid 생존 확인과 작업 디렉터리 점유 프로세스 찾기의 한 벌이다.

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { inside, real } from './fs.ts'
import { run } from './proc.ts'

// EPERM 은 그 pid 의 프로세스가 있지만 신호를 보낼 권한이 없다는 뜻이라 살아 있다고 본다.
// EPERM 을 죽음으로 읽으면 같은 PR 의 마무리를 겹쳐 걸 수 있었다.
// keepOnUnknownError 는 기존 캐시 잠금처럼 ESRCH 로 확인한 종료만 회수할 때 쓴다.
// 정수가 아니거나 1 미만이면 process.kill 을 부르지 않는다. process.kill(0, 0) 은 자기 프로세스 그룹에 보내져 늘 성공하므로
// 깨진 pid 파일이 살아 있는 것으로 읽혀 잠금이 회수되지 않는다.

export function alive(pid: number, options: { keepOnUnknownError?: boolean } = {}): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'EPERM' || (options.keepOnUnknownError === true && code !== 'ESRCH')
  }
}

// 다시 돌기 요청: pid 파일로 하나만 도는 명령(마무리)에 「끝난 뒤 한 번 더 돌라」 를 남긴다. 표시는 `<pid 파일>.rerun` 이다.
//   요청하는 쪽(requestRerun)은 표시를 먼저 쓰고 pid 를 본다. 살아 있으면 'queued' 로, 도는 쪽이 끝나기 전에 표시를 가져간다.
//   죽었으면 표시를 스스로 가져가 'start' 를 낸다. 그 사이 도는 쪽이 먼저 가져갔으면 'queued' 다.
//   도는 쪽(takeRerun)은 pid 파일을 지운 뒤 표시를 가져간다. 가져갔으면 pid 파일을 다시 쓰고 한 번 더 돈다.
//   표시 가져가기는 파일 지우기 하나라서 양쪽이 겹쳐도 한쪽만 가져간다. 그래서 요청이 사라지지도 두 번 돌지도 않는다
export function rerunFile(pidFile: string): string {
  return `${pidFile}.rerun`
}

export function requestRerun(pidFile: string): 'queued' | 'start' {
  writeFileSync(rerunFile(pidFile), '')
  if (pidFileAlive(pidFile)) return 'queued'
  return takeRerun(pidFile) ? 'start' : 'queued'
}

export function takeRerun(pidFile: string): boolean {
  try {
    rmSync(rerunFile(pidFile))
    return true
  } catch {
    return false
  }
}

// pid 파일에 적힌 프로세스가 살아 있는지. 파일이 없거나 정수가 아니면 false 다
export function pidFileAlive(file: string): boolean {
  let text: string
  try {
    text = readFileSync(file, 'utf8').trim()
  } catch {
    return false
  }
  return /^\d+$/.test(text) && alive(Number(text))
}

// dir 이나 그 하위를 작업 디렉터리로 쓰는 프로세스의 pid 와 작업 디렉터리.
// 조회에 실패하면 빈 목록이 아니라 ok: false 를 낸다. 부르는 쪽은 이것을 「누군가 쥐고 있다」 로 본다.
// 빈 목록으로 내면 쓰는 중인 워크트리를 지울 수 있어서다.
export function cwdHolders(dir: string): { ok: true; holders: { pid: number; cwd: string }[] } | { ok: false; error: string } {
  // macOS 의 임시 폴더는 /var 와 /private/var 로 갈리고 lsof 는 실경로를 내므로 dir 을 실경로로 바꿔 비교한다.
  const target = real(dir)
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
      if (inside(cwd, target)) holders.push({ pid, cwd })
    }
  }
  return { ok: true, holders }
}
