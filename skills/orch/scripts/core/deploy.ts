// 머지 커밋이 배포됐는지 판정하는 한 벌이다. finish-pr.ts 가 배포를 기다리며, board-sync.ts 가 틱마다 한 번 쓴다.

export type RunRow = { headSha?: unknown; status?: unknown; conclusion?: unknown }
export type DeployVerdict = 'success' | 'failure' | 'wait'
// note 는 판정 근거 한 줄이다. skipped 만 남은 때만 채운다. 그 밖은 빈 문자열이다
export type Deployed = { verdict: DeployVerdict; sha: string; note: string }

export const SKIPPED_NOTE = '배포가 건너뛰어졌다'

// 머지 커밋이 배포됐는지 판정한다. success, failure 는 그 실행의 커밋과 함께, wait 은 sha 없이 낸다.
// runs 는 `gh run list --json headSha,status,conclusion` 의 목록이다. 머지 커밋과 같거나 그 뒤 커밋의 실행만 센다.
// tip 은 배포 브랜치의 원격 끝 커밋이다. 모르면 빈 문자열이고, 그때는 skipped 만 남아도 기다린다.
//   - 센 실행 중 성공이 하나라도 있으면 성공이다. 머지 커밋의 실행이 뒤 커밋의 실행에 합쳐져
//     skipped 나 cancelled 로 끝나도 뒤 커밋이 성공하면 이 커밋은 배포된 것이다
//   - 성공이 없고 아직 끝나지 않은 실행이 있으면 기다린다. 그 실행이 뒤 커밋의 것일 수 있다
//   - 성공도 진행 중도 없고 실패나 취소가 있으면 실패다
//   - 센 실행이 skipped 뿐이면 tip 으로 판정한다. 배포 브랜치에 연달아 머지하면 앞 커밋의 CI 가 concurrency 로 취소되고
//     배포가 skipped 로 끝난다(2026-11-04 develop 에서 다섯 번). 그 배포는 뒤 커밋이 맡는다.
//       tip 의 실행도 skipped 다            실패다. note 는 SKIPPED_NOTE. 더 뒤 커밋이 없어 아무도 배포하지 않는다
//       tip 이 머지 커밋의 뒤 커밋이다      기다린다. note 는 「뒤 커밋 <tip> 에 포함됨, 그 배포를 기다린다」
//       tip 을 모르거나 그 밖               기다린다
//   - 센 실행이 없으면 기다린다. 실행이 아직 생기지 않았다
export function deployVerdict(runs: RunRow[], merge: string, isAncestor: (ancestor: string, sha: string) => boolean, tip = ''): Deployed {
  let failed = ''
  let waiting = false
  const skipped = new Set<string>()
  for (const row of runs) {
    const sha = typeof row.headSha === 'string' ? row.headSha : ''
    if (!sha || !isAncestor(merge, sha)) continue
    if (row.status !== 'completed') waiting = true
    else if (row.conclusion === 'success') return { verdict: 'success', sha, note: '' }
    else if (['failure', 'cancelled', 'timed_out', 'startup_failure'].includes(String(row.conclusion))) failed = failed || sha
    else if (row.conclusion === 'skipped') skipped.add(sha)
  }
  if (waiting) return { verdict: 'wait', sha: '', note: '' }
  if (failed) return { verdict: 'failure', sha: failed, note: '' }
  if (skipped.size === 0 || !tip) return { verdict: 'wait', sha: '', note: '' }
  if (skipped.has(tip)) return { verdict: 'failure', sha: tip, note: SKIPPED_NOTE }
  if (tip !== merge && isAncestor(merge, tip)) return { verdict: 'wait', sha: '', note: `뒤 커밋 ${tip} 에 포함됨, 그 배포를 기다린다` }
  return { verdict: 'wait', sha: '', note: '' }
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
