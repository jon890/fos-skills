// 머지 뒤 마무리(finish-pr.ts)가 그 PR 에 돈 적이 있는지 남기는 표시다. 사용처: finish-pr.ts(남긴다), cleanup-sweep.ts(본다).
//
// 코디네이터가 급할 때 `gh pr merge` 로 바로 머지하면 마무리(배포 확인, 업무 완료, 보드 done)가 빠진다. 상주 루프의 정리는 워크트리만 치워
// 빠진 줄 아무도 모른다(2026-11-02 PR 다섯 개). 머지 큐의 로그(finish-<PR>.out)는 끝나면 휴지통으로 옮겨져 근거로 쓸 수 없어 따로 남긴다.
//
// 위치: <orch 루트>/state/finish-started/<PR 번호>. 내용은 남긴 시각(ISO 8601 UTC) 한 줄이다. 지우지 않는다.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensure, pathOf } from './paths.ts'

const DIR = 'finish-started'

function valid(pr: string | number): boolean {
  return /^\d+$/.test(String(pr))
}

// 실패하면 던진다
export function markFinishStarted(repo: string, pr: string | number): void {
  if (!valid(pr)) throw new Error(`PR 번호가 아니다: ${pr}`)
  const dir = join(ensure('state', repo), DIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, String(pr)), `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}\n`)
}

export function finishStarted(repo: string, pr: string | number): boolean {
  return valid(pr) && existsSync(join(pathOf('state', repo), DIR, String(pr)))
}
