// 머지 커밋이 배포됐는지 판정하는 한 벌이다. finish-pr.ts 가 배포를 기다리며, board-sync.ts 가 틱마다 한 번 쓴다.

export type RunRow = { headSha?: unknown; status?: unknown; conclusion?: unknown }
export type DeployVerdict = 'success' | 'failure' | 'wait'

// 머지 커밋이 배포됐는지 판정한다. success, failure 는 그 실행의 커밋과 함께, wait 은 sha 없이 낸다.
// runs 는 `gh run list --json headSha,status,conclusion` 의 목록이다. 머지 커밋과 같거나 그 뒤 커밋의 실행만 센다.
//   - 센 실행 중 성공이 하나라도 있으면 성공이다. 머지 커밋의 실행이 뒤 커밋의 실행에 합쳐져
//     skipped 나 cancelled 로 끝나도 뒤 커밋이 성공하면 이 커밋은 배포된 것이다
//   - 성공이 없고 아직 끝나지 않은 실행이 있으면 기다린다. 그 실행이 뒤 커밋의 것일 수 있다
//   - 성공도 진행 중도 없고 실패나 취소가 있으면 실패다. skipped 만 있으면 기다린다
export function deployVerdict(runs: RunRow[], merge: string, isAncestor: (ancestor: string, sha: string) => boolean): { verdict: DeployVerdict; sha: string } {
  let failed = ''
  let waiting = false
  for (const row of runs) {
    const sha = typeof row.headSha === 'string' ? row.headSha : ''
    if (!sha || !isAncestor(merge, sha)) continue
    if (row.status !== 'completed') waiting = true
    else if (row.conclusion === 'success') return { verdict: 'success', sha }
    else if (['failure', 'cancelled', 'timed_out', 'startup_failure'].includes(String(row.conclusion))) failed = failed || sha
  }
  if (waiting) return { verdict: 'wait', sha: '' }
  if (failed) return { verdict: 'failure', sha: failed }
  return { verdict: 'wait', sha: '' }
}

// `gh run list --json headSha,status,conclusion` 의 출력. 읽지 못하면 빈 목록이다
export function parseRuns(stdout: string): RunRow[] {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return Array.isArray(parsed) ? (parsed.filter((row) => typeof row === 'object' && row !== null) as RunRow[]) : []
  } catch {
    return []
  }
}
