// 머지 큐(merge.ts 의 readyToMerge)와 `orch queue gate`(queue/gate.ts)가 머지 전 조건을 묻는 자리.
// 조건의 원본은 core/merge-readiness.ts 의 조건 표다(ADR-037). 여기는 lib/merge-readiness.ts 의 checkReadiness 를 부르고 범위만 고른다.
// 걸린 이유는 첫 이유에서 멈추지 않고 모두 모은다. 고친 뒤 다시 걸었을 때 다음 이유로 또 멈추는 일을 줄이려는 것이다.
// PR 본문의 기능 완료 근거 블록은 판정에 쓰지 않는다. worker 가 적은 글이 아니라 이미 있는 사실만 본다(사용자 결정 2026-11-24).

import { checkReadiness } from '../../lib/merge-readiness.ts'
import type { ConditionKind, PrTarget, ReadinessAsk, ReadOptions } from '../../lib/merge-readiness.ts'
import { requiredChecks } from './checks.ts'
import type { Pr, StepContext } from './model.ts'
import { Conflict, HeadChanged, Stop, WorkerFix } from './model.ts'
import type { GateReason, StepState } from './model.ts'
import { field } from './pr.ts'
import { log, nap, out, stop } from './runtime.ts'

// ci 는 체크, threads·evidence·migration·private 은 worker 가 고칠 것, conflict 는 base 와의 충돌, review 는 설정한 리뷰 조건, lookup 은 조회 실패다
export type { GateKind, GateReason } from './model.ts'

export type GateChecks = 'none' | 'failed' | 'all'

// PR 하나의 값을 읽어 state.pr 과 필수 체크 목록을 채운다. 이미 MERGED 면 merged, OPEN 이 아니면 멈춘다
export async function loadPr(stepContext: StepContext, state: StepState, n: string): Promise<'open' | 'merged'> {
  const o = state.o
  const p: Pr = (state.pr = {
    n,
    ph: '',
    branch: '',
    cross: false,
    apiHost: '',
    owner: '',
    repo: '',
    base: '',
    beforeHead: null,
    judgments: 0,
    judgedBase: null,
    ov: [],
    title: null,
    author: null,
    draft: false,
    url: '',
  })

  const st = await field(stepContext, state, n, 'state', '.state')
  if (st === 'MERGED') {
    log(`${n} 이미 MERGED`)
    state.sweepBase = state.sweepBase || (await field(stepContext, state, n, 'baseRefName', '.baseRefName'))
    return 'merged'
  }
  if (st !== 'OPEN') stop(`${n} state=${st || '조회 실패'}`)

  // 검사 대상 HEAD 를 체크를 보기 전에 고정한다
  p.ph = await field(stepContext, state, n, 'headRefOid', '.headRefOid')
  p.branch = await field(stepContext, state, n, 'headRefName', '.headRefName')
  const cross = await field(stepContext, state, n, 'isCrossRepository', '.isCrossRepository')
  if (!p.ph) stop(`${n} headRefOid 조회 실패`)
  if (!p.branch) stop(`${n} headRefName 조회 실패`)
  if (cross !== 'true' && cross !== 'false') stop(`${n} isCrossRepository 조회 실패`)
  p.cross = cross === 'true'

  // https://<호스트>/<owner>/<repo>/pull/<번호>. `://` 가 없으면 호스트가 비어 조회 실패다
  const url = await field(stepContext, state, n, 'url', '.url')
  const scheme = url.indexOf('://')
  const [host, owner, repo] = (scheme >= 0 ? url.slice(scheme + 3) : '').split('/')
  p.apiHost = host ?? ''
  p.owner = owner ?? ''
  p.repo = repo ?? ''
  if (!(p.owner && p.repo && p.apiHost)) stop(`${n} url 조회 실패`)
  p.url = url
  // 이벤트 입력의 pr 을 채운다. 조회하지 못했으면 핸들러에 틀린 값을 넘기지 않도록 멈춘다
  const info = await field(stepContext, state, n, 'title,author,isDraft', '{title, author: .author.login, isDraft} | tojson')
  try {
    const parsed = JSON.parse(info) as { title: unknown; author: unknown; isDraft: unknown }
    p.title = typeof parsed.title === 'string' ? parsed.title : null
    p.author = typeof parsed.author === 'string' ? parsed.author : null
    p.draft = parsed.isDraft === true
  } catch {
    stop(`${n} title, author, isDraft 조회 실패`)
  }
  p.base = await field(stepContext, state, n, 'baseRefName', '.baseRefName')
  if (!p.base) stop(`${n} baseRefName 조회 실패`)
  state.sweepBase = p.base

  const req = requiredChecks(state)
  for (const name of o.allowFail) {
    if (req.includes(name)) stop(`${n} --allow-fail 의 ${name} 는 필수 체크다. 필수 체크의 실패는 허용할 수 없다`)
  }
  state.requiredChecks = req
  return 'open'
}

// 관문과 머지 큐의 판단 대상
export function readinessTarget(state: StepState): PrTarget {
  const p = state.p
  return { repo: state.repoDir, number: Number(p.n), head: p.ph, base: p.base, branch: p.branch, host: p.apiHost, slug: `${p.owner}/${p.repo}`, draft: p.draft, cross: p.cross }
}

// 머지 큐 옵션(스펙 DECISION10)과 재시도 값. 체크가 하나도 없어도 필수 체크 이름이 비었으면 통과로 본다(PR6 전까지의 지금 동작)
export function readOptions(stepContext: StepContext, state: StepState): ReadOptions {
  const o = state.o
  return {
    ghRepo: o.repo,
    threadsCmd: o.threadsCmd,
    required: state.requiredChecks,
    allowFail: o.allowFail,
    allowNoChecks: true,
    retries: state.ghRetries,
    retrySeconds: state.ghRetrySeconds,
    nap: (seconds) => nap(stepContext, seconds),
  }
}

// 관문과 머지 큐가 지금 동작을 지키려고 남긴 compat 값(설계 「커밋과 PR 순서」)
const COMPAT = { noDraft: true, oldHolds: true, checkHeadStop: true } as const

// 머지 전 조건을 묻는다. head 이유는 머지 큐가 다시 시도하는 HeadChanged 로, 체크 조회 중의 HEAD 변경은 다시 시도하지 않는 보류로 던진다
export async function askReadiness(stepContext: StepContext, state: StepState, ask: Omit<ReadinessAsk, 'scope'>) {
  const n = state.p.n
  const readiness = await checkReadiness(readinessTarget(state), { scope: 'full', ...ask, compat: { ...COMPAT, ...ask.compat } }, readOptions(stepContext, state))
  const head = readiness.reasons.find((r) => r.kind === 'head')
  if (head?.code === 'head-checks') stop(`${n} ${head.text}`)
  if (head) throw new HeadChanged(`${n} ${head.text}`)
  return readiness
}

// 머지 전 조건에 걸린 이유를 모두 모은다. summary 는 로그에 남길 `fails=0 threads=0 mergeable=MERGEABLE` 꼴이다.
// notes 는 막지 않고 보이기만 하는 `통합 테스트 생략 <모듈>: <이유>` 줄이다. 보류는 묻지 않는다(관문은 HOLD 줄로, 머지 큐는 refuseSpecHold 로 따로 본다).
// 지금 HEAD 를 기준으로 본다. 조회 실패는 lookup 이유로 모으고, 검사하는 사이 HEAD 가 바뀌면 HeadChanged 를 던진다
export async function gateReasons(stepContext: StepContext, state: StepState, checks: GateChecks): Promise<{ reasons: GateReason[]; summary: string; notes: string[] }> {
  const skip: ConditionKind[] = checks === 'none' ? ['ci', 'hold'] : ['hold']
  const readiness = await askReadiness(stepContext, state, { skip, compat: { checksAfterWait: checks === 'failed' } })
  return { reasons: readiness.reasons.map((r) => ({ kind: r.kind as GateReason['kind'], text: r.text })), summary: readiness.summary, notes: readiness.notes }
}

// 관문의 HOLD 줄. 지시서 보류가 먼저고, 없으면 PR 본문의 보류다. 본문을 읽지 못하면 보류 없음으로 둔다(PR5 가 알리게 바꾼다)
export async function holdLine(stepContext: StepContext, state: StepState): Promise<string | null> {
  const readiness = await askReadiness(stepContext, state, { only: ['hold'] })
  return readiness.reasons.find((r) => r.kind === 'hold')?.text ?? null
}

// 머지 큐의 보류 확인. 본문을 읽지 못하면 멈추고, 보류가 있으면 GATE-HOLD 줄을 내고 멈춘다
export async function refuseSpecHold(stepContext: StepContext, state: StepState): Promise<void> {
  const readiness = await askReadiness(stepContext, state, { only: ['hold', 'draft'] })
  const lookup = readiness.reasons.find((r) => r.kind === 'lookup')
  if (lookup) stop(`${state.p.n} ${lookup.text}`)
  const hold = readiness.reasons.find((r) => r.kind === 'hold')
  if (!hold) return
  out(`GATE-HOLD ${hold.text}`)
  stop(`${state.p.n} 머지 보류: ${hold.text}`)
}

// 모은 이유로 그 PR 을 멈춘다. 이유가 여럿이어도 STOP 줄 하나와 worker 에게 보내는 보류 이유 하나에 모두 담는다.
// 충돌이 있으면 큐에서 빼는 충돌 처리로, worker 가 고칠 것(스레드, 통합 테스트 기록)이 있으면 worker 에게 알리는 보류로, 그 밖에는 알리지 않는 보류로 간다.
// 체크 실패는 상주 루프의 CI 감시가 worker 에게 알리므로 체크만 걸렸을 때는 알리지 않는다
// 리뷰 판정 대기와 보류는 일반 보류다. 리뷰 봇 재실행과 worker 수정 중 어느 쪽이 필요한지 알 수 없어 자동 알림을 보내지 않는다
export function holdWith(state: StepState, reasons: GateReason[]): never {
  const n = state.p.n
  const joined = reasons.map((r) => r.text).join('; ')
  if (reasons.some((r) => r.kind === 'conflict')) throw new Conflict(`${n} ${joined}`)
  if (reasons.some((r) => r.kind === 'threads' || r.kind === 'evidence' || r.kind === 'migration' || r.kind === 'private')) {
    // 스레드는 worker 가 고치는 동안 다른 PR 을 먼저 처리하고 정리 전에 한 번 다시 본다
    throw new WorkerFix(`${n} ${joined}`, joined, reasons.some((r) => r.kind === 'threads'))
  }
  throw new Stop(`${n} ${joined}`)
}
