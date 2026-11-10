// routing 기록 (--apply일 때, --run과 무관):
//     최근 띄우기 이력의 브랜치에서 머지 없이 닫힌 PR과 마무리 표시가 없는 머지 PR만 기록한다.
//     마무리가 worker 종료를 기다리는 동안에는 finish-pr이 기록하도록 맡긴다. 기록 실패는 정리를 막지 않는다.
//     ORCA_USAGE_DIR로 토큰 사용량 폴더를 바꾼다. 기록 형식과 수집은 lib/routing-log.ts가 소유한다.
//
// 머지 큐 로그 (저장소마다 워크트리와 브랜치 정리 뒤에 한 번. --run 이 없어도 한다):
//     <orch>/queue(lib/paths.ts 의 queue, merge-with-finish.ts 의 --finish-log-dir 기본값)에 남은 끝난 로그를 휴지통으로 옮긴다.
//     지우지 않고 handoff-cleanup.ts 와 같은 방식(--trash, <휴지통>/queue/<이름>)으로 옮긴다.
//     마무리 로그(finish-<PR>.out 과 .pid), 머지 큐 로그의 조건과 실패 로그를 남기는 시간은 lib/queue-logs.ts 머리 주석이 소유한다.
//     돌고 있는 프로세스의 로그와 모르는 파일은 건드리지 않는다. 출력은 `머지 큐 로그를 휴지통으로 옮길 것`, `머지 큐 로그 옮김`, `머지 큐 로그를 남긴다` 다.


// 머지 큐 로그 정리가 쓰는 실제 조회. PR 상태는 번호를 묶어 한 번에 읽고(lib/pr-lookup.ts 의 states) 읽지 못한 번호는 담지 않는다
import type { StepContext, StepResult, StepState } from './context.ts'
import { git, lines } from './shared.ts'
import { lookupOf } from './prs.ts'
import { lsofOpenedBy, sweepQueueLogs } from '../../lib/queue-logs.ts'
import { migrateLegacyNotices } from '../legacy-notices.ts'
import { pathOf } from '../../lib/paths.ts'
import { pruneMerged } from '../../lib/pr-lookup.ts'

function queueLogHost(repo: string) {
  return {
    now: () => Date.now(),
    openedBy: lsofOpenedBy,
    prStates: (numbers: number[]) => lookupOf(repo).states(numbers),
  }
}

export async function cleanupState(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { repo, args, log } = ctx
  migrateLegacyNotices(repo, args.trash, args.apply, log)
  sweepQueueLogs({ dir: pathOf('queue', repo), trash: args.trash, apply: args.apply, log, host: queueLogHost(repo) })
  pruneMerged(repo, new Set(lines(git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').out)))
  return {}
}
