// 사용법: orch queue gate PR [--wait] [--repo DIR]
//
// 머지 큐가 머지 전에 보는 조건을 머지 없이 한 번 돌려 본다. worker 는 「준비됨」 을 보내기 전에 이 명령이 통과해야 한다.
// 조건은 머지 큐와 같은 조건 표(core/merge-readiness.ts, ADR-037)가 판정한다. 규칙을 두 곳에 두지 않는다.
// draft PR 은 준비되지 않은 것으로 본다.
//   1. 체크가 나타났고, 필수 체크가 빠짐없이 끝났으며 실패가 없다. --wait 를 주면 체크가 나타나 끝날 때까지 기다린다.
//      CI 가 없는 저장소는 queue.allow_no_checks 로 빈 체크 목록을 허용할 수 있다.
//   2. 미해결 리뷰 스레드가 없다
//   3. base 와 충돌하지 않는다(mergeable 이 MERGEABLE)
//   4. queue.auto_review 에 trusted_bots 나 review_checks 가 있으면 지금 HEAD 의 봇 영수증이나 리뷰 체크 success 가 있다(core/auto-merge.ts 의 judgeReview)
//   5. 설정에 queue.integration_tests 가 있으면 바뀐 모듈마다 통합 테스트 통과 기록이 지금 HEAD 에 있거나 생략 이유가 있다(core/integration-evidence.ts)
//   6. 공개 저장소면 PR 본문과 댓글·리뷰에 비공개 낱말이 없다(steps/private-words.ts). 걸리면 위치만 낸다
// PR 본문의 기능 완료 근거 블록은 보지 않는다(사용자 결정 2026-11-24).
// 걸린 이유는 첫 이유에서 멈추지 않고 모두 낸다. base 최신화, 겹침 판정, 합친 사본 검사, before-merge 이벤트는 머지 큐만 한다.
//
// 옵션은 머지 큐와 같은 이름과 뜻이다(--repo, --required, --required-check, --allow-fail, --allow-fail-check, --threads-cmd).
// 명령줄에 없는 옵션은 머지 큐(merge-with-finish.ts)와 같은 길로 설정 파일의 queue 절(queue.required 등)에서 채운다. 명령줄에 준 옵션이 우선한다.
// --wait 는 머지 큐와 같은 --check-timeout, --missing-timeout, --poll-min-sec, --poll-max-sec 를 쓴다.
//   체크가 끝난 뒤 queue.auto_review.trusted_bots 가 있고 남은 이유가 봇 리뷰뿐이면 봇 리뷰도 기다린다(아래 「봇 리뷰 대기」).
// --review-timeout MIN  --wait 가 봇 리뷰를 기다리는 한도(분). 기본 20, 0 이면 기다리지 않는다.
//                       Codex 리뷰가 보통 10분 안에 끝나고, 길어도 상한 안에 끝나지 않으면 GATE-PENDING 으로 넘긴다
//
// 봇 리뷰 대기(--wait):
//   걸린 이유가 모두 리뷰 조건(kind review)이고 그 가운데 하나라도 아래면 기다린다. 다른 이유가 함께 있으면 바로 GATE-FAIL 이다.
//     - 지금 HEAD 의 봇 영수증도 리뷰 체크 success 도 없다(봇이 아직 리뷰를 시작하지 않았을 수 있다)
//     - 믿는 봇이 지금 HEAD 를 리뷰하는 중이다. 요약 댓글의 codex-review-state 가 그 HEAD 를 진행 중으로 적었거나, 대기 중인 리뷰가 있거나,
//       봇이 PR 본문에 👀 를 달았고 그 HEAD 의 영수증도 끝난 리뷰 상태도 없다(lib/review-bot.ts 의 botReviewInProgress)
//   영수증 인정과 P1·P2 판정은 바꾸지 않는다. 리뷰가 끝나 P1·P2 지적이 남았으면 GATE-FAIL 이다.
//   기다리는 동안 1분마다 `REVIEW-WAIT <PR> <분>분째 봇 리뷰를 기다린다(<이유>)` 를 낸다
// 머지 큐 전용 옵션을 주어도 받지만 쓰지 않는다. PR 은 하나만 받고 `PR:명령` 꼴은 받지 않는다.
//
// 출력(판정 줄은 `orch --full` 이어도 그대로다):
//   GATE-OK <PR>
//                 조건은 core/auto-merge.ts 머리 주석의 「judgeReview」 가 소유한다. GATE-FAIL 일 때는 내지 않는다
//   통합 테스트 생략 <모듈>: <이유>
//                 판정 줄과 이유 줄 뒤에 붙는다. PR 본문이 이유를 적어 통합 테스트 기록 없이 넘긴 모듈이다. 판정에는 넣지 않는다
//   HOLD <이유>     지시서·PR 본문·보드의 머지 보류나 조회 실패를 한 줄씩 낸다. 보류는 gate 종료 코드에 넣지 않는다
//   GATE-FAIL <PR>
//     <이유>        걸린 이유를 한 줄씩. PR 을 읽지 못하거나 이미 MERGED 이거나 OPEN 이 아니어도 GATE-FAIL 이다
//   GATE-PENDING <PR>
//     <이유>        --wait 가 --review-timeout 안에 봇 리뷰 끝을 보지 못했다. 첫 줄은 기다린 시간, 다음 줄부터 남은 리뷰 이유다.
//                 실패가 아니다. 같은 명령으로 다시 기다리거나 봇에 리뷰를 다시 요청한다
// 종료 코드: 0 통과, 1 걸림(조회 실패 포함. 확인하지 못했으면 통과로 보지 않는다), 2 사용법 오류(설정 파일 오류 포함), 3 봇 리뷰 대기 한도 초과(GATE-PENDING)
// PR 을 열거나 고쳐 push 한 턴에서 --wait 로 검사한다. GATE-OK 뒤 「준비됨」 status 를 보낸다.
// HOLD 가 있으면 이유를 모두 status 에 적는다. GATE-FAIL 이면 출력된 조건을 해결한 뒤 다시 검사한다. GATE-PENDING 이면 다시 기다린다.
//
// MERGE_QUEUE_GH_RETRIES, MERGE_QUEUE_GH_RETRY_SECONDS, MERGE_QUEUE_SLEEP_SCALE 는 머지 큐와 같다.

import { existsSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TrustedReviewBot } from '../core/auto-merge.ts'
import { autoMergeConfig } from '../core/auto-merge.ts'
import { allowNoChecksOf } from '../core/config.ts'
import type { Reason } from '../core/merge-readiness.ts'
import { ConfigError, loadConfig } from '../lib/config.ts'
import { repoArgProblem } from '../lib/git.ts'
import { pathOf } from '../lib/paths.ts'
import type { run } from '../lib/proc.ts'
import { withRun } from '../lib/proc.ts'
import { queuePollSeconds } from '../lib/gh-budget.ts'
import { queueDefaults } from '../lib/queue-defaults.ts'
import { botReviewInProgress, loadBotReviewSnapshot } from '../lib/review-bot.ts'
import { WAIT_NOTE_SEC, waitChecks } from './steps/checks.ts'
import { gateReasons, loadPr } from './steps/gate.ts'
import type { GateReason, StepContext } from './steps/model.ts'
import { CheckStop, Stop, StepState, Usage } from './steps/model.ts'
import { parseArgs, usageText } from './steps/options.ts'
import { log, nap } from './steps/runtime.ts'
import { readQueueEnv } from './steps/setup.ts'

const SCRIPT = fileURLToPath(import.meta.url)
const stepContext: StepContext = { script: SCRIPT, here: dirname(SCRIPT), sleepScale: 1 }

function print(lines: string[]): void {
  process.stdout.write(`${lines.join('\n')}\n`)
}

// 판정 줄과 이유 줄. 이유가 없으면 통과다.
// notes(통합 테스트 생략 줄)는 판정과 상관없이 그 뒤에 붙는다. pending 은 봇 리뷰 대기 한도를 넘긴 이유이고, 있으면 GATE-PENDING 이다
export function gateLines(n: string, reasons: GateReason[], notes: string[] = [], pending?: string): string[] {
  const ready = reasons.filter((r) => r.stage === 'ready')
  const holds = reasons.filter((r) => r.stage === 'merge')
  const result = ready.length === 0 ? [`GATE-OK ${n}`]
    : pending ? [`GATE-PENDING ${n}`, `  ${pending}`, ...ready.map((r) => `  ${r.text}`)]
      : [`GATE-FAIL ${n}`, ...ready.map((r) => `  ${r.text}`)]
  return [...result, ...notes, ...holds.map((r) => `HOLD ${r.text}`)]
}

type GateResult = { reasons: GateReason[]; notes: string[]; pending?: string }

// 머리 주석의 「봇 리뷰 대기」. 더 기다리면 풀릴 수 있는 리뷰 이유만 남았는가
function reviewPending(state: StepState, reasons: readonly Reason[], bots: readonly TrustedReviewBot[]): boolean {
  const ready = reasons.filter((r) => r.stage === 'ready')
  if (ready.length === 0 || !ready.every((r) => r.kind === 'review')) return false
  if (ready.some((r) => r.code === 'review-missing')) return true
  const p = state.p
  const snapshot = loadBotReviewSnapshot(state.repoDir, { host: p.apiHost, slug: `${p.owner}/${p.repo}`, number: p.n }, p.ph)
  return snapshot.ok && bots.some((bot) => botReviewInProgress(p.ph, snapshot.data, bot))
}

// 머리 주석의 「봇 리뷰 대기」. 한도 안에 풀리지 않으면 pending 이유를 붙여 돌려준다
async function waitReview(state: StepState, first: { reasons: Reason[]; notes: string[] }): Promise<GateResult> {
  const bots = autoMergeConfig(loadConfig(state.repoDir)).review?.trustedBots ?? []
  const limit = Number(state.o.reviewTimeout) * 60
  let readiness = first
  if (bots.length === 0 || limit === 0) return readiness
  let waited = 0
  let attempt = 0
  let notes = 0
  while (reviewPending(state, readiness.reasons, bots)) {
    if (waited >= limit) return { ...readiness, pending: `봇 리뷰를 ${state.o.reviewTimeout}분 기다렸지만 끝나지 않았다` }
    const seconds = Math.min(queuePollSeconds(attempt++, Number(state.o.pollMinSec), Number(state.o.pollMaxSec)), limit - waited)
    await nap(stepContext, seconds)
    waited += seconds
    if (Math.floor(waited / WAIT_NOTE_SEC) > notes) {
      notes = Math.floor(waited / WAIT_NOTE_SEC)
      const why = readiness.reasons.find((r) => r.stage === 'ready')?.text ?? ''
      log(`REVIEW-WAIT ${state.p.n} ${Math.floor(waited / 60)}분째 봇 리뷰를 기다린다(${why})`)
    }
    readiness = await gateReasons(stepContext, state, 'all')
  }
  // 진행 표시는 판정 뒤에 따로 읽는다. 그 사이 리뷰가 끝났으면 남은 리뷰 이유가 낡았으니 한 번 더 판정한다
  if (waited > 0 && readiness.reasons.some((r) => r.kind === 'review')) readiness = await gateReasons(stepContext, state, 'all')
  return readiness
}

async function gate(state: StepState, n: string): Promise<GateResult> {
  try {
    if ((await loadPr(stepContext, state, n)) === 'merged') return { reasons: [{ kind: 'lookup', stage: 'ready', text: '이미 MERGED 라 머지 전 조건을 볼 필요가 없다' }], notes: [] }
    let ci: GateReason | null = null
    if (state.o.wait) {
      try {
        await waitChecks(stepContext, state)
      } catch (e) {
        if (!(e instanceof CheckStop)) throw e
        ci = { kind: 'ci', stage: 'ready', text: e.reason }
      }
    }
    const readiness = await gateReasons(stepContext, state, ci ? 'none' : 'all')
    if (ci) return { reasons: [ci, ...readiness.reasons], notes: readiness.notes }
    return state.o.wait ? await waitReview(state, readiness) : readiness
  } catch (e) {
    if (!(e instanceof Stop)) throw e
    // 조회 실패와 HEAD 변경은 확인하지 못한 것이다. 통과로 보지 않고 이유로 낸다
    return { reasons: [{ kind: 'lookup', stage: 'ready', text: e.message.startsWith(`${n} `) ? e.message.slice(n.length + 1) : e.message }], notes: [] }
  }
}

export function main(argv: string[], runner?: typeof run): Promise<number> {
  return runner ? withRun(runner, () => mainImpl(argv)) : mainImpl(argv)
}

async function mainImpl(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    print([usageText(stepContext)])
    return 0
  }
  let state: StepState
  let n: string
  try {
    const scale = process.env.MERGE_QUEUE_SLEEP_SCALE ?? '1'
    stepContext.sleepScale = Number(scale)
    if (!scale.trim() || !Number.isFinite(stepContext.sleepScale) || stepContext.sleepScale < 0) throw new Usage(`MERGE_QUEUE_SLEEP_SCALE 는 0 이상의 수다: ${scale}`)
    // 명령줄에 없는 옵션은 머지 큐와 같은 길로 설정 파일의 queue 절에서 채운다(lib/queue-defaults.ts). 명령줄이 우선한다
    const repoAt = argv.indexOf('--repo')
    const repoArg = repoAt >= 0 && repoAt + 1 < argv.length ? argv[repoAt + 1] : '.'
    const repoPre = repoArgProblem(repoArg)
    if (repoPre) throw new Usage(repoPre)
    const config = loadConfig(repoArg)
    const opts = parseArgs([...queueDefaults(pathOf('config', repoArg), argv, config), ...argv], 'gate')
    if (opts.items.length !== 1 || opts.items[0].includes(':')) throw new Usage('PR 번호를 하나만 준다(PR:명령 꼴은 받지 않는다)')
    n = opts.items[0]
    const repoProblem = repoArgProblem(opts.repo)
    if (repoProblem) throw new Usage(repoProblem)
    state = new StepState(opts)
    state.allowNoChecks = allowNoChecksOf(config)
    try {
      process.chdir(opts.repo)
    } catch (e) {
      throw new Usage(`${opts.repo} 로 이동하지 못했다: ${(e as Error).message}`)
    }
    state.repoDir = process.cwd()
    readQueueEnv(stepContext, state)
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`)
      return 2
    }
    if (!(e instanceof Usage)) throw e
    process.stderr.write(`${e.message}\n${usageText(stepContext)}\n`)
    return 2
  }
  try {
    const { reasons, notes, pending } = await gate(state, n)
    print(gateLines(n, reasons, notes, pending))
    if (!reasons.some((r) => r.stage === 'ready')) return 0
    return pending ? 3 : 1
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    process.stderr.write(`${e.message}\n`)
    return 2
  }
}

if (import.meta.main || (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (e) => {
      process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`)
      process.exitCode = 1
    },
  )
}
