// 브랜치의 워크트리와 그 워크트리의 worker-list 행 찾기 한 벌이다.
// 사용처: notify-conflicts.ts(충돌한 PR 의 worker 에게 알리기), orch-loop.ts(체크가 실패한 PR 의 worker 에게 알리기),
// orch-doctor.ts(--run 의 worker 판정은 workerRows, Orca 형식 점검은 missingRowKeys 를 쓴다).

import { isObject, objectOr } from '../core/json.ts'
import { LIVE_DISPATCH } from '../core/workers.ts'
import { git } from './git.ts'
import { orcaJson } from './orca.ts'
import type { RunOptions } from './proc.ts'

type Json = Record<string, unknown>

// orch 가 worker-list 행에서 읽는 키. `resource.` 는 그 안의 키다. Orca 출력 형식이 바뀌어 하나라도 빠지면 판정이 조용히 빈 값이 된다
// (2026-11-02 줄인 보기 전환으로 하루 동안 중복 띄우기, 정리 누락, 질문 놓침). orch-doctor 가 ORCA-SHAPE 로 알린다
export const ROW_KEYS = ['dispatchId', 'taskId', 'dispatchStatus', 'workerState', 'agentTerminalHandle', 'resource.worktreeId', 'resource.ownershipState'] as const

// 행에 없는 ROW_KEYS. 값이 null 인 것은 있는 것으로 본다(끝난 dispatch 의 터미널 handle 처럼 비어 있을 수 있다)
export function missingRowKeys(row: Json): string[] {
  return ROW_KEYS.filter((key) => {
    const [head, tail] = key.split('.')
    return tail === undefined ? !(head in row) : !(tail in objectOr(row[head]))
  })
}

// {브랜치: 워크트리 경로}.
export function worktreePaths(repo: string): Map<string, string> {
  const done = git(repo, ['worktree', 'list', '--porcelain'])
  const paths = new Map<string, string>()
  let path: string | null = null
  for (const line of done.code === 0 ? done.stdout.split('\n') : []) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('branch refs/heads/') && path) paths.set(line.slice('branch refs/heads/'.length), path)
  }
  return paths
}

// strict 는 doctor 가 쓰던 계약이다. 객체가 아닌 응답은 실패하고 객체가 아닌 행은 건너뛴다.
// 시간 초과로 실패한 페이지는 같은 인자로 한 번만 더 읽는다. 다른 실패는 바로 반환한다.
// worker-list 의 행을 모든 페이지에 걸쳐 읽는다. 첫 페이지만 읽으면 다른 worker 를 놓친다(lib/orca.ts 머리 주석).
export function workerRows(run: string | null, opts?: RunOptions, options: { strict?: boolean; requireShape?: boolean } = {}): { ok: true; rows: Json[] } | { ok: false; error: string } {
  const rows: Json[] = []
  const seen = new Set<string>()
  let cursor = ''
  for (;;) {
    const args = ['orchestration', 'worker-list', ...(run ? ['--run', run] : []), '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])]
    let got = orcaJson<unknown>(args, opts)
    if (!got.ok && got.timedOut) got = orcaJson<unknown>(args, opts)
    if (!got.ok) return got
    if (options.strict && !isObject(got.data)) return { ok: false, error: 'worker-list 의 응답이 객체가 아니다' }
    const result = objectOr(got.data)
    // 자동 진행은 목록 형식을 확인하지 못하면 worker 가 없다고 판단하지 않는다.
    // doctor 의 strict 조회는 누락 키를 따로 출력하므로 기존 동작을 유지한다.
    if (options.requireShape && (!Array.isArray(result.workers) || result.workers.some(row => !isObject(row) || missingRowKeys(row).length > 0))) {
      return { ok: false, error: 'worker-list 의 worker 목록이나 필수 키가 올바르지 않다' }
    }
    const listed = Array.isArray(result.workers) ? result.workers : []
    rows.push(...(options.strict ? listed.filter(isObject) : listed.map(value => objectOr(value))))
    const next = objectOr(result.page).nextCursor
    cursor = typeof next === 'string' ? next : ''
    if (!cursor) return { ok: true, rows }
    if (seen.has(cursor)) return { ok: false, error: 'worker-list 의 다음 페이지가 앞 페이지와 같다' }
    seen.add(cursor)
  }
}

// 그 워크트리의 worker-list 행. 살아 있는 dispatch 를 먼저 고르고, 같은 상태끼리는 목록의 뒤쪽이다. 없으면 null.
export function workerFor(rows: Json[], path: string): Json | null {
  const here = rows.filter((row) => String(objectOr(row.resource).worktreeId ?? '').endsWith(`::${path}`) && row.dispatchId)
  const live = here.filter((row) => LIVE_DISPATCH.has(String(row.dispatchStatus)))
  const pick = live.length > 0 ? live : here
  return pick.length > 0 ? pick[pick.length - 1] : null
}

export { LIVE_DISPATCH } from '../core/workers.ts'
