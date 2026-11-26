// 필수 CI 체크 조회와 대기.

import { checkName, judgeChecks } from '../../core/checks.ts'
import { queuePollSeconds } from '../../lib/gh-budget.ts'
import { ruleChecks } from '../../lib/gh.ts'
import { run } from '../../lib/proc.ts'
import type { StepContext } from './model.ts'
import { CheckStop, NotReady, RUNNING_SINCE_JQ, SETTLED_JQ, SETTLED_SEC } from './model.ts'
import type { StepState } from './model.ts'
import { checkRows } from './pr.ts'
import { chomp, log, nap, stop } from './runtime.ts'

export function requiredChecks(state: StepState): string[] {
  const o = state.o
  const p = state.p
  let req = o.required
  if (req.length === 0) {
    const got = ruleChecks(p.apiHost, `${p.owner}/${p.repo}`, p.base, { reportDetails: true })
    if (!got.ok) {
      if (got.parseError !== undefined) throw got.parseError
      stop(`${p.n} 필수 체크 규칙 조회 실패. --required 로 준다`)
    }
    if (got.planLimited) {
      log(`${p.n} 경고: 이 플랜은 저장소 규칙을 읽을 수 없다(HTTP 403, 플랜 제한). 필수 체크 목록을 비어 있는 것으로 본다`)
    }
    req = got.names
  }
  if (req.length === 0) {
    if (o.upToDate) stop(`${p.n} 필수 체크 목록이 비어 있어 --require-up-to-date 를 쓸 수 없다. --required 로 준다`)
    if (o.updateDocs) stop(`${p.n} 문서 PR 갱신에는 필수 체크 목록이 필요하다. --required 로 준다`)
    log(`${p.n} 필수 체크 목록이 비어 있다. 지금 있는 체크만 기다린다`)
  }
  return req
}

// 기존 실패 재확인과 진행 중·미등장 조회는 각각 스냅샷 캐시를 읽는다.
export async function queueChecks(stepContext: StepContext, state: StepState, fresh = false) {
  const rows = await checkRows(stepContext, state, fresh)
  if (rows === null) return null
  return judgeChecks(rows, {
    required: state.requiredChecks,
    allowFail: state.o.allowFail,
    allowNoChecks: true,
  })
}

export function sortedCheckNames<T extends string | null>(names: readonly T[]): T[] {
  // jq 의 unique 와 같이 null 을 먼저 두고 이름을 코드 포인트 순으로 정렬한다.
  return [...new Set(names)].sort((a, b) => {
    if (a === null) return -1
    if (b === null) return 1
    return Buffer.compare(Buffer.from(a), Buffer.from(b))
  })
}

async function checkTime(stepContext: StepContext, state: StepState, jq: string): Promise<string> {
  const rows = await checkRows(stepContext, state)
  if (rows === null) return ''
  const filtered = run(['jq', '-r', jq], { input: JSON.stringify({ statusCheckRollup: rows }) })
  return filtered.code === 0 ? chomp(filtered.stdout) : ''
}

// --ci-expected-sec 에서 지금 도는 체크 가운데 가장 먼저 시작한 것의 경과를 뺀 초. 옵션이 없거나 시작 시각을 모르면 null 이다
export async function expectedCiLeft(stepContext: StepContext, state: StepState): Promise<number | null> {
  if (!state.o.ciExpectedSec) return null
  const started = await checkTime(stepContext, state, RUNNING_SINCE_JQ)
  const at = Date.parse(started)
  if (!started || !Number.isFinite(at)) return null
  return Number(state.o.ciExpectedSec) - (Date.now() - at) / 1000
}

// 롤업의 마지막 체크가 끝난 뒤 지난 초. 끝난 시각이 없는 체크(StatusContext 는 시작 시각을 쓴다)가 있거나 읽지 못하면 -1 이다
export async function settledSec(stepContext: StepContext, state: StepState): Promise<number> {
  const latest = await checkTime(stepContext, state, SETTLED_JQ)
  const at = Date.parse(latest)
  return latest && Number.isFinite(at) ? (Date.now() - at) / 1000 : -1
}

export async function waitChecks(stepContext: StepContext, state: StepState): Promise<void> {
  const n = state.p.n
  if (state.mode === 'quick') {
    // 앞지르기는 기다리지 않는다. 지금 모두 통과했고 끝난 지 SETTLED_SEC 가 지났을 때만 이어 간다
    const f = (await queueChecks(stepContext, state, true))?.failed.length
    const pending = (await queueChecks(stepContext, state))?.pending
    const missing = (await queueChecks(stepContext, state))?.missing.length
    if (f !== 0 || pending !== 0 || missing !== 0) throw new NotReady(`체크가 끝나지 않았거나 실패했다(fails=${f ?? '?'} pending=${pending ?? '?'} missing=${missing ?? '?'})`)
    if ((await settledSec(stepContext, state)) < SETTLED_SEC) throw new NotReady(`체크가 끝난 지 ${SETTLED_SEC}초가 지나지 않았다`)
    return
  }
  const timeout = state.rechecking ? Math.min(5, Number(state.o.checkTimeout)) : Number(state.o.checkTimeout)
  const limit = Math.max(0, timeout * 60 - (state.rechecking ? state.recheckWaited : 0))
  const missingLimit = Number(state.o.missingTimeout) * 60
  let waited = 0
  // 진행 중인 체크가 없는데 나타나지 않은 필수 체크가 남은 채로 지난 초
  let idle = 0
  let attempt = 0
  for (;;) {
    let f = (await queueChecks(stepContext, state, waited >= limit || (missingLimit > 0 && idle >= missingLimit)))?.failed.length
    if (f !== 0) f = (await queueChecks(stepContext, state, true))?.failed.length
    if ((f ?? 0) !== 0) throw new CheckStop(n, `실패한 체크 ${f} 개`)
    const pending = (await queueChecks(stepContext, state))?.pending
    const missing = (await queueChecks(stepContext, state))?.missing.length
    if (pending === undefined || missing === undefined) stop(`${n} 체크 조회 실패`)
    if (pending === 0 && missing === 0) break
    if (waited >= limit) {
      const names = (await queueChecks(stepContext, state))?.missing.join(',') ?? ''
      throw new CheckStop(n, `체크 대기 ${timeout}분 초과(진행 중 ${pending}, 나타나지 않은 필수 체크 ${names})`)
    }
    if (pending !== 0) idle = 0
    if (missingLimit > 0 && idle >= missingLimit) {
      const names = (await queueChecks(stepContext, state))?.missing.join(', ') ?? ''
      const rows = await checkRows(stepContext, state)
      const seen = JSON.stringify(sortedCheckNames((rows ?? []).map(checkName)))
      throw new CheckStop(
        n,
        `진행 중인 체크가 없는데 필수 체크가 ${state.o.missingTimeout}분째 나타나지 않는다(나타나지 않은 필수 체크 ${names}). ` +
          `PR 에 붙은 체크: ${seen}. 필수 체크 이름이 틀렸을 수 있다(쉼표가 든 이름은 --required-check 로 준다)`,
      )
    }
    const expectedLeft = pending !== 0 ? await expectedCiLeft(stepContext, state) : null
    const seconds = Math.min(queuePollSeconds(attempt++, Number(state.o.pollMinSec), Number(state.o.pollMaxSec), expectedLeft), Math.max(0, limit - waited),
      pending === 0 && missingLimit > 0 ? Math.max(0, missingLimit - idle) : Infinity)
    await nap(stepContext, seconds)
    if (state.rechecking) state.recheckWaited += seconds
    waited += seconds
    if (pending === 0) idle += seconds
    else idle = 0
  }
  // 체크가 끝난 직후에 새 체크가 붙는 경우가 있어 잠시 뒤 다시 본다.
  // 차례가 왔을 때 이미 모두 끝나 있었고 마지막 체크가 끝난 지 SETTLED_SEC 초가 지났으면 그 기다림은 이미 지난 것이라 건너뛴다.
  // 상주 루프가 미리 최신화해 CI 를 통과한 PR 이 차례마다 1분씩 더 기다리지 않게 한다
  if (attempt === 0 && (await settledSec(stepContext, state)) >= SETTLED_SEC) {
    log(`${n} 체크가 ${SETTLED_SEC}초 넘게 전에 끝나 있어 다시 보는 대기를 건너뛴다`)
    return
  }
  const settle = state.rechecking ? Math.min(60, Math.max(0, timeout * 60 - state.recheckWaited)) : 60
  if (state.rechecking && settle < 60) throw new CheckStop(n, `체크 대기 ${timeout}분 초과(체크 안정화 대기 포함)`)
  await nap(stepContext, settle)
  if (state.rechecking) state.recheckWaited += settle
  const pending = (await queueChecks(stepContext, state, true))?.pending
  const missing = (await queueChecks(stepContext, state))?.missing.length
  if (!(pending === 0 && missing === 0)) {
    throw new CheckStop(n, `새로 붙은 체크가 아직 돈다(진행 중 ${pending ?? '?'}, 미등장 ${missing ?? '?'}). 다시 돌린다`)
  }
}
