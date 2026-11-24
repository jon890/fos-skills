// 리뷰로 인정하는 CI 체크(queue.auto_review.review_checks)의 상태를 statusCheckRollup 에서 읽는다.
//
// 이름이 같은 실행이 여럿이면 가장 늦게 시작한 것만 본다(lib/gh.ts 의 currentChecks 와 같다. 다시 돌린 실행이 앞 결과를 가린다).
// StatusContext 는 이름이 context, 결과가 state 에 있다.
//
// 통과(reviewCheckPassed): 마지막 실행이 success 로 끝났다. 자동 머지와 gate 의 리뷰 판정(core/auto-merge.ts 의 judgeReview)이 쓴다.
// 도는 중(reviewRunning): 마지막 실행이 아직 끝나지 않았다(CheckRun 의 conclusion 이 비었고 status 가 COMPLETED 가 아니거나 StatusContext 의 state 가
//     PENDING, EXPECTED). 체크가 없으면 도는 중이 아니다. 최신화가 이 동안 HEAD 를 옮기지 않게 한다(loop/steps/refresh.ts 머리 주석의 「최신화」).
//     리뷰 체크는 Ready 때나 push 때 돌아, 끝나기 전에 HEAD 가 바뀌면 그 결과를 버리게 된다.

function field(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' ? value : null
}

// 시작 시각을 읽지 못한 실행(대기 중인 재실행은 startedAt 이 없다)은 가장 늦게 시작한 것으로 본다(PR 619 리뷰).
// 옛 success 가 대기 중인 재실행을 가려 통과로 보이거나 최신화가 HEAD 를 옮기지 않게 하려는 것이다
const started = (row: Record<string, unknown>) => {
  const at = Date.parse(field(row, 'startedAt') ?? '')
  return Number.isNaN(at) ? Infinity : at
}

// 이름이 check 인 체크 가운데 가장 늦게 시작한 것. 시각이 같으면 목록에서 뒤의 것이다. 없으면 null 이다
function latestRun(rollup: unknown, check: string): Record<string, unknown> | null {
  if (!Array.isArray(rollup)) return null
  const rows = rollup.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && (field(row as Record<string, unknown>, 'name') ?? field(row as Record<string, unknown>, 'context')) === check)
  return rows.reduce<Record<string, unknown> | null>((best, row) => (best === null || started(row) >= started(best) ? row : best), null)
}

// 머리 주석의 「통과」
export function reviewCheckPassed(rollup: unknown, check: string): boolean {
  const latest = latestRun(rollup, check)
  if (!latest) return false
  return (field(latest, 'conclusion') ?? field(latest, 'state')) === 'SUCCESS'
}

// 머리 주석의 「도는 중」
export function reviewRunning(rollup: unknown, check: string): boolean {
  const latest = latestRun(rollup, check)
  if (!latest) return false
  const state = field(latest, 'state')
  if (state !== null) return state === 'PENDING' || state === 'EXPECTED'
  return !field(latest, 'conclusion') && field(latest, 'status') !== 'COMPLETED'
}
