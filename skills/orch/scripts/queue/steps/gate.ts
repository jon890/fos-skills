// 머지 전 조건 판정. 머지 큐(merge.ts 의 readyToMerge)와 `orch queue gate`(queue/gate.ts)가 같은 함수를 쓴다.
// 조건은 여기 한 곳에만 둔다: 필수 체크, 미해결 리뷰 스레드, base 와의 충돌, 설정한 리뷰 판정, 기능 완료 근거 블록(독립 리뷰 줄 포함),
// 통합 테스트 기록(queue.integration_tests 가 있을 때만), 마이그레이션 번호, 공개 저장소의 비공개 낱말(private-words.ts).
// 첫 이유에서 멈추지 않고 걸린 이유를 모두 모아 돌려준다. 고친 뒤 다시 걸었을 때 다음 이유로 또 멈추는 일을 줄이려는 것이다.

import { autoMergeConfig } from '../../lib/auto-merge.ts'
import { judgePrReview } from '../../lib/review-judgement.ts'
import { loadConfig } from '../../lib/config.ts'
import { integrationNeeds, integrationProblems, integrationRules } from '../../core/integration-evidence.ts'
import { acceptsVerifiedCommit, featureBranch, featureEvidenceProblem } from '../../lib/feature-evidence.ts'
import { ghJson } from '../../lib/gh.ts'
import { NO_LIMIT_MS, runAsync } from '../../lib/proc.ts'
import { migrationReasons } from './migrations.ts'
import { privateReasons } from './private-words.ts'
import { mask, readPrivateWords } from '../../lib/private-words.ts'
import { requiredChecks } from './checks.ts'
import type { Pr, StepContext } from './model.ts'
import { Conflict, FAIL_SEL, HeadChanged, PENDING, ROLL_NAMES, ROLL_NAMES_NO_SKIPPED, Stop, WorkerFix } from './model.ts'
import type { GateReason, StepState } from './model.ts'
import { fetchPrRefs } from './overlap.ts'
import { api, field, prEnv } from './pr.ts'
import { chomp, log, namesJson, nap, stop } from './runtime.ts'

// ci 는 체크, threads·evidence·migration·private 은 worker 가 고칠 것, conflict 는 base 와의 충돌, review 는 설정한 리뷰 조건, lookup 은 조회 실패다
export type { GateKind, GateReason } from './model.ts'

export type GateChecks = 'none' | 'failed' | 'all'

// PR 하나의 값을 읽어 state.pr, state.q 를 채운다. 이미 MERGED 면 merged, OPEN 이 아니면 멈춘다
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

  const req = requiredChecks(stepContext, state)
  for (const name of o.allowFail) {
    if (req.includes(name)) stop(`${n} --allow-fail 의 ${name} 는 필수 체크다. 필수 체크의 실패는 허용할 수 없다`)
  }
  const roll = o.skippedMissing ? ROLL_NAMES_NO_SKIPPED : ROLL_NAMES
  const allowed = `(.name // .context) as $nm | (${namesJson(o.allowFail)} | any(. == $nm))`
  state.q = {
    missing: `((${namesJson(req)}) - ${roll})`,
    failed: `[.statusCheckRollup[] | ${FAIL_SEL} | select(${allowed} | not)] | length`,
    allowedFailed: `[.statusCheckRollup[] | ${FAIL_SEL} | select(${allowed}) | (.name // .context)] | unique | .[]`,
  }
  return 'open'
}

// 머지 전 조건에 걸린 이유를 모두 모은다. summary 는 로그에 남길 `fails=0 threads=0 mergeable=MERGEABLE` 꼴이다.
// notes 는 막지 않고 보이기만 하는 `통합 테스트 생략 <모듈>: <이유>` 줄이다.
// 지금 HEAD 를 기준으로 본다. 조회 실패는 lookup 이유로 모으고, 검사하는 사이 HEAD 가 바뀌면 HeadChanged 를 던진다
export async function gateReasons(stepContext: StepContext, state: StepState, checks: GateChecks): Promise<{ reasons: GateReason[]; summary: string; fixed: string[]; notes: string[] }> {
  const o = state.o
  const p = state.p
  const n = p.n
  const reasons: GateReason[] = []
  const facts: string[] = []
  // 리뷰 판정이 block 을 반영 완료로 푼 `REVIEW-FIXED …` 줄. orch queue gate 가 GATE-OK 뒤에 낸다
  const fixed: string[] = []
  // 미해결 스레드 수. 조회하지 못했으면 null 이라 block 을 반영 완료로 풀지 않는다
  let unresolved: number | null = null
  const notes: string[] = []

  if (checks !== 'none') {
    const f = await field(stepContext, state, n, 'statusCheckRollup', state.q.failed)
    facts.push(`fails=${f}`)
    if (f !== '0') reasons.push({ kind: 'ci', text: f ? `실패한 체크 ${f} 개` : '체크 조회 실패' })
    if (checks === 'all') {
      const pending = await field(stepContext, state, n, 'statusCheckRollup', PENDING)
      const missing = await field(stepContext, state, n, 'statusCheckRollup', `${state.q.missing} | length`)
      if (pending !== '0' || missing !== '0') {
        const names = missing && missing !== '0' ? await field(stepContext, state, n, 'statusCheckRollup', `${state.q.missing} | join(", ")`) : ''
        reasons.push({ kind: 'ci', text: `체크가 아직 끝나지 않았다(진행 중 ${pending || '?'}, 나타나지 않은 필수 체크 ${names || missing || '?'})` })
      }
    }
  }

  const threads = await runAsync(['bash', '-c', o.threadsCmd], { env: { ...prEnv(stepContext, state), GH_HOST: p.apiHost, ORCH_GH_CACHE: '0' }, timeoutMs: NO_LIMIT_MS })
  // 옛 명령은 스레드 명령의 stderr 를 받지 않고 그대로 흘렸다
  if (threads.stderr) process.stderr.write(threads.stderr)
  if (threads.code !== 0) {
    reasons.push({ kind: 'lookup', text: '스레드 조회 실패' })
  } else {
    const t = chomp(threads.stdout)
    facts.push(`threads=${t}`)
    if (/^\d+$/.test(t)) unresolved = Number(t)
    if (t !== '0') reasons.push({ kind: 'threads', text: `미해결 리뷰 스레드 ${t} 개` })
  }

  let m = await field(stepContext, state, n, 'mergeable', '.mergeable')
  for (let i = 0; i < 4; i++) {
    if (m !== 'UNKNOWN') break
    await nap(stepContext, 20)
    m = await field(stepContext, state, n, 'mergeable', '.mergeable')
  }
  facts.push(`mergeable=${m}`)
  if (m === 'CONFLICTING') reasons.push({ kind: 'conflict', text: `base(${p.base}) 와 충돌한다(mergeable=CONFLICTING)` })
  else if (m !== 'MERGEABLE') reasons.push({ kind: 'mergeable', text: `mergeable=${m || '조회 실패'}` })

  const review = autoMergeConfig(loadConfig(state.repoDir)).review
  if (review) {
    const got = ghJson<{ reviews: unknown; comments: unknown; headRefOid: string; body: string }>(['pr', 'view', n, '--json', 'reviews,comments,headRefOid,body', '--jq', '.'], { cwd: o.repo, cache: false })
    if (!got.ok || !got.data || !Array.isArray(got.data.reviews) || !Array.isArray(got.data.comments)) {
      reasons.push({ kind: 'lookup', text: '리뷰 판정 조회 실패' })
    } else if (got.data.headRefOid !== p.ph) {
      throw new HeadChanged(`${n} 리뷰 조회 중 HEAD 가 바뀌었다`)
    } else {
      const feature = Boolean(featureBranch(o.repo, p.branch)) || (typeof got.data.body === 'string' && got.data.body.includes('fos-feature-evidence'))
      const target = { host: p.apiHost, slug: `${p.owner}/${p.repo}`, number: n }
      const judged = judgePrReview(state.repoDir, { head: p.ph, branch: p.branch, base: p.base, target }, got.data, review, feature, unresolved)
      if (!judged.ok) reasons.push({ kind: 'review', text: !review.trustedBots && judged.missing && judged.condition === 'verdict-on-head' ? `HEAD ${p.ph.slice(0, 8)} 에 리뷰 판정이 없다` : judged.wait })
      else fixed.push(...(judged.fixed ?? []))
    }
  }

  const evidence = ghJson<{ body: string; headRefOid: string }>(['pr', 'view', n, '--json', 'body,headRefOid', '--jq', '.'], { cwd: o.repo, cache: false })
  if (!evidence.ok) {
    reasons.push({ kind: 'lookup', text: '기능 완료 근거 또는 HEAD 조회 실패' })
  } else if (evidence.data.headRefOid !== p.ph) {
    throw new HeadChanged(`${n} 검사 뒤 HEAD 가 바뀌었다 checked=${p.ph.slice(0, 8)} now=${String(evidence.data.headRefOid ?? '').slice(0, 8)}`)
  } else {
    // 통합 테스트 기록의 커밋도 기능 완료 근거와 같은 예외로 받는다.
    const accept = (verified: string): boolean => fetchPrRefs(stepContext, state) &&
      acceptsVerifiedCommit(state.repoDir, p.ph, verified, p.base)
    const problem = featureEvidenceProblem(evidence.data.body ?? '', p.ph, featureBranch(o.repo, p.branch), false, accept)
    if (problem) reasons.push({ kind: 'evidence', text: problem })
    const integration = integrationReasons(stepContext, state, evidence.data.body ?? '', accept)
    reasons.push(...integration.reasons)
    notes.push(...integration.notes)
  }
  reasons.push(...migrationReasons(state))
  reasons.push(...privateReasons(stepContext, state, evidence.ok && typeof evidence.data.body === 'string' ? evidence.data.body : null))
  // 이유와 알림 줄에는 PR 본문에서 옮긴 글(통합 테스트 생략 이유, 근거 칸 값)이 섞인다. gate 출력과 큐 로그로 나가기 전에 비공개 낱말을 가린다
  const words = readPrivateWords()
  if (words.length === 0) return { reasons, summary: facts.join(' '), fixed, notes }
  return { reasons: reasons.map((r) => ({ ...r, text: mask(r.text, words) })), summary: facts.join(' '), fixed, notes: notes.map((note) => mask(note, words)) }
}

// 통합 테스트 기록(core/integration-evidence.ts). 규칙이 없으면 바뀐 파일을 읽지 않는다. 바뀐 파일은 REST 로 끝까지 읽는다(gh pr view 의 files 는 100개까지다).
// 이름을 바꾼 파일은 옛 경로도 본다. REST 도 3000개까지라 그보다 큰 PR 은 모듈을 놓칠 수 있다
function integrationReasons(stepContext: StepContext, state: StepState, body: string, accept: (commit: string) => boolean): { reasons: GateReason[]; notes: string[] } {
  const rules = integrationRules(loadConfig(state.repoDir))
  if (rules.length === 0) return { reasons: [], notes: [] }
  const p = state.p
  const files = api(stepContext, state, `repos/${p.owner}/${p.repo}/pulls/${p.n}/files?per_page=100`, '--paginate', '--jq', '.[] | .filename, (.previous_filename // empty)')
  if (files.code !== 0) return { reasons: [{ kind: 'lookup', text: '통합 테스트 대상 파일 조회 실패' }], notes: [] }
  const needs = integrationNeeds(files.stdout.split('\n').filter(Boolean), rules)
  const judged = integrationProblems(body, p.ph, needs, accept)
  return { reasons: judged.reasons.map((text) => ({ kind: 'evidence', text })), notes: judged.notes }
}

// 모은 이유로 그 PR 을 멈춘다. 이유가 여럿이어도 STOP 줄 하나와 worker 에게 보내는 보류 이유 하나에 모두 담는다.
// 충돌이 있으면 큐에서 빼는 충돌 처리로, worker 가 고칠 것(스레드, 근거 블록)이 있으면 worker 에게 알리는 보류로, 그 밖에는 알리지 않는 보류로 간다.
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
