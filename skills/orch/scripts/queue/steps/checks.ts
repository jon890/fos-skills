// 필수 CI 체크 조회와 대기.

import { queuePollSeconds } from '../../lib/gh-budget.ts'
import { parseNames, RULES_JQ, rulesPlanLimited } from '../../lib/gh.ts'
import type { StepContext } from './model.ts'
import { NotReady, PENDING, ROLL_NAMES, RUNNING_SINCE_JQ, SETTLED_JQ, SETTLED_SEC } from './model.ts'
import type { StepState } from './model.ts'
import { api, field } from './pr.ts'
import { chomp, log, nap, stop } from './runtime.ts'

export function requiredChecks(stepContext: StepContext, state: StepState): string[] {
  const o = state.o
  const p = state.p
  let req = o.required
  if (req.length === 0) {
    const done = api(stepContext, state, `repos/${p.owner}/${p.repo}/rules/branches/${p.base}`, '--jq', RULES_JQ)
    if (done.code === 0) {
      req = parseNames(chomp(done.stdout))
    } else if (rulesPlanLimited(done.stderr)) {
      // 무료 플랜의 비공개 저장소는 규칙 API 를 읽을 수 없다. 필수 체크 목록이 없는 것으로 다룬다
      log(`${p.n} 경고: 이 플랜은 저장소 규칙을 읽을 수 없다(HTTP 403, 플랜 제한). 필수 체크 목록을 비어 있는 것으로 본다`)
      req = []
    } else {
      stop(`${p.n} 필수 체크 규칙 조회 실패. --required 로 준다`)
    }
  }
  if (req.length === 0) {
    if (o.upToDate) stop(`${p.n} 필수 체크 목록이 비어 있어 --require-up-to-date 를 쓸 수 없다. --required 로 준다`)
    if (o.updateDocs) stop(`${p.n} 문서 PR 갱신에는 필수 체크 목록이 필요하다. --required 로 준다`)
    log(`${p.n} 필수 체크 목록이 비어 있다. 지금 있는 체크만 기다린다`)
  }
  return req
}

// --ci-expected-sec 에서 지금 도는 체크 가운데 가장 먼저 시작한 것의 경과를 뺀 초. 옵션이 없거나 시작 시각을 모르면 null 이다
export async function expectedCiLeft(stepContext: StepContext, state: StepState): Promise<number | null> {
  if (!state.o.ciExpectedSec) return null
  const started = await field(stepContext, state, state.p.n, 'statusCheckRollup', RUNNING_SINCE_JQ)
  const at = Date.parse(started)
  if (!started || !Number.isFinite(at)) return null
  return Number(state.o.ciExpectedSec) - (Date.now() - at) / 1000
}

// 롤업의 마지막 체크가 끝난 뒤 지난 초. 끝난 시각이 없는 체크(StatusContext 는 시작 시각을 쓴다)가 있거나 읽지 못하면 -1 이다
export async function settledSec(stepContext: StepContext, state: StepState): Promise<number> {
  const latest = await field(stepContext, state, state.p.n, 'statusCheckRollup', SETTLED_JQ)
  const at = Date.parse(latest)
  return latest && Number.isFinite(at) ? (Date.now() - at) / 1000 : -1
}

export async function waitChecks(stepContext: StepContext, state: StepState): Promise<void> {
  const n = state.p.n
  const q = state.q
  if (state.mode === 'quick') {
    // 앞지르기는 기다리지 않는다. 지금 모두 통과했고 끝난 지 SETTLED_SEC 가 지났을 때만 이어 간다
    const f = await field(stepContext, state, n, 'statusCheckRollup', q.failed, true)
    const pending = await field(stepContext, state, n, 'statusCheckRollup', PENDING)
    const missing = await field(stepContext, state, n, 'statusCheckRollup', `${q.missing} | length`)
    if (f !== '0' || pending !== '0' || missing !== '0') throw new NotReady(`체크가 끝나지 않았거나 실패했다(fails=${f || '?'} pending=${pending || '?'} missing=${missing || '?'})`)
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
    let f = await field(stepContext, state, n, 'statusCheckRollup', q.failed, waited >= limit || (missingLimit > 0 && idle >= missingLimit))
    if (f !== '0') f = await field(stepContext, state, n, 'statusCheckRollup', q.failed, true)
    if ((f || '0') !== '0') stop(`${n} 실패한 체크 ${f} 개`)
    const pending = await field(stepContext, state, n, 'statusCheckRollup', PENDING)
    const missing = await field(stepContext, state, n, 'statusCheckRollup', `${q.missing} | length`)
    if (!pending || !missing) stop(`${n} 체크 조회 실패`)
    if (pending === '0' && missing === '0') break
    if (waited >= limit) {
      const names = await field(stepContext, state, n, 'statusCheckRollup', `${q.missing} | join(",")`)
      stop(`${n} 체크 대기 ${timeout}분 초과(진행 중 ${pending}, 나타나지 않은 필수 체크 ${names})`)
    }
    if (pending !== '0') idle = 0
    if (missingLimit > 0 && idle >= missingLimit) {
      const names = await field(stepContext, state, n, 'statusCheckRollup', `${q.missing} | join(", ")`)
      const seen = await field(stepContext, state, n, 'statusCheckRollup', `${ROLL_NAMES} | unique | tojson`)
      stop(
        `${n} 진행 중인 체크가 없는데 필수 체크가 ${state.o.missingTimeout}분째 나타나지 않는다(나타나지 않은 필수 체크 ${names}). ` +
          `PR 에 붙은 체크: ${seen || '[]'}. 필수 체크 이름이 틀렸을 수 있다(쉼표가 든 이름은 --required-check 로 준다)`,
      )
    }
    const expectedLeft = pending !== '0' ? await expectedCiLeft(stepContext, state) : null
    const seconds = Math.min(queuePollSeconds(attempt++, Number(state.o.pollMinSec), Number(state.o.pollMaxSec), expectedLeft), Math.max(0, limit - waited),
      pending === '0' && missingLimit > 0 ? Math.max(0, missingLimit - idle) : Infinity)
    await nap(stepContext, seconds)
    if (state.rechecking) state.recheckWaited += seconds
    waited += seconds
    if (pending === '0') idle += seconds
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
  if (state.rechecking && settle < 60) stop(`${n} 체크 대기 ${timeout}분 초과(체크 안정화 대기 포함)`)
  await nap(stepContext, settle)
  if (state.rechecking) state.recheckWaited += settle
  const pending = await field(stepContext, state, n, 'statusCheckRollup', PENDING, true)
  const missing = await field(stepContext, state, n, 'statusCheckRollup', `${q.missing} | length`)
  if (!(pending === '0' && missing === '0')) {
    stop(`${n} 새로 붙은 체크가 아직 돈다(진행 중 ${pending || '?'}, 미등장 ${missing || '?'}). 다시 돌린다`)
  }
}
