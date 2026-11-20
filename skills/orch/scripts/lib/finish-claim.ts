// 마무리(queue/finish-pr.ts --pid-file)의 시작과 끝. PR 하나의 마무리는 실행권(lib/pr-claim.ts 의 finish)을 쥔 프로세스 하나만 돈다.
//
// 띄우는 쪽(merge-with-finish.ts, orch followup done)의 pid 파일 확인은 「이미 돈다」 를 알리려는 것이고, 겹침은 마무리 자신이 막는다.
// 실행권을 잡지 못한 마무리는 FINISH-RUNNING 을 내고 아무것도 하지 않고 끝난다.
//
// pid 파일(finish-<PR>.pid)은 실행권을 쥔 동안에만 쓰고 지운다. 그래서 끝나는 마무리가 새 마무리의 pid 파일을 지우지 못한다.
// 죽은 pid 가 남은 pid 파일은 읽는 쪽(lib/process.ts 의 pidFileAlive)이 돌지 않는 것으로 본다.
//
// 다시 돌기 표시(<orch 루트>/state/finish-rerun/<PR>): 도는 마무리가 끝날 때 한 번 더 돌라는 요청이다. orch followup done 이 쓴다.
//   저장소와 PR 번호로 정한 자리에 둔다. pid 파일 옆에 두면 로그 폴더를 따로 준 마무리(--finish-log-dir)와 followup done 이 다른 자리를 본다(PR 568 리뷰)
//   쓰는 쪽  표시를 쓴 뒤 pid 파일을 본다. 살아 있으면 그대로 두고, 아니면 표시를 둔 채 새 마무리를 띄운다
//   시작     실행권을 잡으면 표시를 지운다. 지금 시작하는 실행이 그 요청보다 뒤라 요청을 대신한다
//   끝       표시가 있으면 가져가 한 번 더 돈다. 없으면 pid 파일을 지우고 실행권을 놓은 뒤 표시를 한 번 더 본다.
//            있으면 실행권을 먼저 다시 잡고 표시를 가져가 돈다. 다른 마무리가 먼저 잡았으면 표시를 두고 끝낸다.
//            그 마무리가 시작할 때나 끝날 때 가져간다. 남의 표시를 먼저 가져가지 않으려고 실행권을 잡은 뒤에만 가져간다
//   표시를 쓴 뒤에 실행권이 쥐어져 있는 것을 본 요청은, 쥔 쪽이 놓은 뒤의 확인에서 반드시 보인다.
//   그래서 끝나는 마무리와 새 요청이 어떤 순서로 겹쳐도 요청 뒤에 시작한 실행이 하나는 있다(PR 558 리뷰의 겹침).

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { makeParent, pathOf } from './paths.ts'
import { claimFile, prNumber, releaseClaim, takeClaim } from './pr-claim.ts'
import type { Claim, Holder } from './pr-claim.ts'

export function rerunFile(repo: string, pr: string | number): string {
  return join(pathOf('state', repo), 'finish-rerun', prNumber(pr))
}

// 머리 주석의 「쓰는 쪽」 이 표시를 남긴다
export function askRerun(repo: string, pr: string | number): void {
  const file = rerunFile(repo, pr)
  makeParent(file, repo)
  writeFileSync(file, '')
}

// 표시가 있으면 지우고 true. 지우기 하나라 둘이 겹쳐도 한쪽만 가져간다
export function takeRerun(repo: string, pr: string | number): boolean {
  try {
    unlinkSync(rerunFile(repo, pr))
    return true
  } catch {
    return false
  }
}

export type Begin = { kind: 'run'; claim: Claim } | { kind: 'running'; holder: Holder } | { kind: 'unknown'; reason: string }

// 이 프로세스나 쥔 쪽의 시작 시각을 읽지 못하면(ps 실패) 잠깐 뒤 다시 본다. 한 번의 실패로 마무리가 통째로 빠지지 않게 한다
const UNKNOWN_TRIES = 3
const UNKNOWN_WAIT_MS = 300

function claimFinish(repo: string, pr: string | number, pidFile: string): Begin {
  const pause = new Int32Array(new SharedArrayBuffer(4))
  let reason = ''
  for (let i = 0; i < UNKNOWN_TRIES; i++) {
    if (i > 0) Atomics.wait(pause, 0, 0, UNKNOWN_WAIT_MS)
    const taken = takeClaim(claimFile(repo, 'finish', pr), { note: 'finish' })
    if (taken.kind === 'held') return { kind: 'running', holder: taken.holder }
    if (taken.kind === 'mine') return { kind: 'unknown', reason: '이 프로세스가 이미 이 PR 의 마무리 실행권을 쥐고 있다' }
    if (taken.kind === 'unknown') {
      reason = taken.reason
      continue
    }
    mkdirSync(dirname(resolve(pidFile)), { recursive: true })
    writeFileSync(pidFile, String(process.pid))
    return { kind: 'run', claim: taken.claim }
  }
  return { kind: 'unknown', reason }
}

function dropFinish(pidFile: string, claim: Claim): void {
  try { unlinkSync(pidFile) } catch { /* 이미 없다 */ }
  releaseClaim(claim)
}

// 머리 주석의 「시작」
export function beginFinish(repo: string, pr: string | number, pidFile: string): Begin {
  const begun = claimFinish(repo, pr, pidFile)
  if (begun.kind === 'run') takeRerun(repo, pr)
  return begun
}

// 머리 주석의 「끝」 앞 절반. 표시가 있으면 true 이고 실행권을 그대로 쥔다. 없으면 pid 파일을 지우고 실행권을 놓는다
export function rerunOrRelease(repo: string, pr: string | number, pidFile: string, claim: Claim): boolean {
  if (takeRerun(repo, pr)) return true
  dropFinish(pidFile, claim)
  return false
}

// 머리 주석의 「끝」 뒤 절반. 놓은 뒤에 들어온 표시를 본다. 다시 돌아야 하면 새 실행권을 낸다.
// 실행권을 확인하지 못하면 표시를 둔 채 lost 를 낸다. 다음 마무리가 가져간다
export function retakeForRerun(repo: string, pr: string | number, pidFile: string): { kind: 'rerun'; claim: Claim } | { kind: 'done' } | { kind: 'lost'; reason: string } {
  // 다시 잡았는데 표시가 없으면(다른 마무리가 그 사이 가져갔다) 놓고 처음부터 다시 본다. 다시 쥔 동안 들어온 표시를 놓치지 않는다
  for (;;) {
    if (!existsSync(rerunFile(repo, pr))) return { kind: 'done' }
    const again = claimFinish(repo, pr, pidFile)
    if (again.kind === 'running') return { kind: 'done' }
    if (again.kind === 'unknown') return { kind: 'lost', reason: again.reason }
    if (takeRerun(repo, pr)) return { kind: 'rerun', claim: again.claim }
    dropFinish(pidFile, again.claim)
  }
}
