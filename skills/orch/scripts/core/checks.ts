// CI 롤업에서 지금 실행을 고르고 실패, 진행 중, 미등장 체크를 판단한다.

// 실패로 보는 체크 실행의 결론과 커밋 상태 값이다.
export const FAILED_CONCLUSIONS: readonly string[] = ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']
export const FAILED_STATES: readonly string[] = ['FAILURE', 'ERROR']

export type CiCheck = { name: string; status: string | null; conclusion: string | null; url: string | null }
export type CiState = { state: 'passed' | 'failed' | 'pending'; checks: CiCheck[] }

function field(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' ? value : null
}

// 롤업 행의 이름. 체크 실행은 name, 커밋 상태는 context 다.
export function checkName(row: Record<string, unknown>): string | null {
  return field(row, 'name') ?? field(row, 'context')
}

function failedRow(row: Record<string, unknown>): boolean {
  return FAILED_CONCLUSIONS.includes(field(row, 'conclusion') ?? '') || FAILED_STATES.includes(field(row, 'state') ?? '')
}

// 체크 실행은 status 가 COMPLETED 가 아니면, 커밋 상태는 state 가 PENDING 이나 EXPECTED 면 아직이다
function pendingRow(row: Record<string, unknown>): boolean {
  const state = field(row, 'state')
  return (field(row, 'status') ?? 'COMPLETED') !== 'COMPLETED' || state === 'PENDING' || state === 'EXPECTED'
}

// ciState 가 낸 체크가 실패인가. status 는 체크 실행의 status 나 커밋 상태의 state 다. 체크 실행의 status 에는 FAILURE, ERROR 가 없다
export function failedCheck(check: CiCheck): boolean {
  return FAILED_CONCLUSIONS.includes(check.conclusion ?? '') || FAILED_STATES.includes(check.status ?? '')
}

// 실패한 체크가 모두 CANCELLED 인가. 코디네이터가 CI 를 일부러 취소하면 코드 실패가 아니라서 worker 에게 고치라고 보내지 않는다
export function cancelledOnly(failed: readonly CiCheck[]): boolean {
  return failed.length > 0 && failed.every((check) => check.conclusion === 'CANCELLED' && !FAILED_STATES.includes(check.status ?? ''))
}

// gh 는 commits(last:1) 의 롤업을 낸다. HEAD 와 같은 응답에서 읽고 도중의 push 는 호출자가 막는다.
// 같은 워크플로와 이름의 더 늦게 시작한 실행이 확인되면 이전 실행을 뺀다. 시각을 모르면 실패를 숨기지 않는다.
export function currentChecks(rollup: unknown, head?: string): Record<string, unknown>[] {
  const rows = (Array.isArray(rollup) ? rollup : []).filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row),
  ).filter((row) => !head || !field(row, 'headSha') || field(row, 'headSha') === head)
  const workflow = (row: Record<string, unknown>): string | null => {
    const flat = field(row, 'workflowName')
    if (flat) return flat
    const suite = row.checkSuite as { workflowRun?: { workflow?: { name?: unknown } } } | null
    const name = suite?.workflowRun?.workflow?.name
    return typeof name === 'string' && name ? name : null
  }
  const sameSource = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
    const left = workflow(a), right = workflow(b)
    return left !== null && left === right || left === null && right === null && !!field(a, 'context') && !!field(b, 'context')
  }
  const started = (row: Record<string, unknown>): number => {
    const value = field(row, 'startedAt') ?? ''
    return value.startsWith('0001-') ? Number.NaN : Date.parse(value)
  }
  return rows.filter((row) => !rows.some((newer) =>
    sameSource(row, newer) && !!checkName(row) && checkName(newer) === checkName(row) &&
    started(newer) > started(row),
  ))
}

type CheckOptions = {
  required: readonly string[]
  allowFail?: readonly string[]
  allowNoChecks: boolean
}

export function judgeChecks(rows: readonly Record<string, unknown>[], options: CheckOptions) {
  const { required, allowFail, allowNoChecks } = options
  const failed: string[] = []
  const allowedFailed: string[] = []
  const seen = new Set<string>()
  let pending = 0
  const checks = rows.map((row) => {
    const name = checkName(row)
    const conclusion = field(row, 'conclusion')
    if (name !== null) seen.add(name)
    if (failedRow(row)) {
      if (name !== null && allowFail?.includes(name)) allowedFailed.push(name)
      else failed.push(name ?? '')
    }
    if (pendingRow(row)) pending++
    return {
      name: name ?? '',
      status: field(row, 'status') ?? field(row, 'state'),
      conclusion,
      url: field(row, 'detailsUrl') ?? field(row, 'targetUrl'),
    }
  })
  const missing = required.filter((name) => !seen.has(name))
  const none = rows.length === 0
  const state: CiState['state'] = failed.length > 0 ? 'failed'
    : pending > 0 || missing.length > 0 || (none && !allowNoChecks) ? 'pending' : 'passed'
  return { state, failed, allowedFailed, pending, missing, none, checks }
}

export function ciState(rollup: unknown, required: readonly string[], head?: string, allowNoChecks = false): CiState {
  const rows = currentChecks(rollup, head)
  const { state, checks } = judgeChecks(rows, { required, allowNoChecks })
  return { state, checks }
}

// 루프의 최신화는 필수 체크만 본다. 필수 체크 이름이 비면 나타난 체크를 모두 본다.
export function requiredCiState(rollup: unknown, required: readonly string[], head?: string, allowNoChecks = false): CiState['state'] {
  const rows = currentChecks(rollup, head)
  const wanted = new Set(required)
  const selected = wanted.size === 0 ? rows : rows.filter((row) => wanted.has(checkName(row) ?? ''))
  return judgeChecks(selected, { required, allowNoChecks }).state
}
