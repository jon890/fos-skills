// 사용법: orch queue gate PR [--wait] [--repo DIR]
//
// 머지 큐가 머지 전에 보는 조건을 머지 없이 한 번 돌려 본다. worker 는 「준비됨」 을 보내기 전에 이 명령이 통과해야 한다.
// 조건은 머지 큐와 같은 조건 표(core/merge-readiness.ts, ADR-037)가 판정한다. 규칙을 두 곳에 두지 않는다.
// draft PR 은 준비되지 않은 것으로 본다.
//   1. 필수 체크가 모두 나타나 끝났고 실패가 없다. 기본은 현재 상태만 보고, --wait 를 주면 필수 체크가 나타나 끝날 때까지 기다린다.
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
// 종료 코드: 0 통과, 1 걸림(조회 실패 포함. 확인하지 못했으면 통과로 보지 않는다), 2 사용법 오류(설정 파일 오류 포함)
// PR 을 열거나 고쳐 push 한 턴에서 --wait 로 검사한다. GATE-OK 뒤 「준비됨」 status 를 보낸다.
// HOLD 가 있으면 이유를 모두 status 에 적는다. GATE-FAIL 이면 출력된 조건을 해결한 뒤 다시 검사한다.
//
// MERGE_QUEUE_GH_RETRIES, MERGE_QUEUE_GH_RETRY_SECONDS, MERGE_QUEUE_SLEEP_SCALE 는 머지 큐와 같다.

import { existsSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError, loadConfig } from '../lib/config.ts'
import { repoArgProblem } from '../lib/git.ts'
import { pathOf } from '../lib/paths.ts'
import type { run } from '../lib/proc.ts'
import { withRun } from '../lib/proc.ts'
import { queueDefaults } from '../lib/queue-defaults.ts'
import { waitChecks } from './steps/checks.ts'
import { gateReasons, loadPr } from './steps/gate.ts'
import type { GateReason, StepContext } from './steps/model.ts'
import { CheckStop, Stop, StepState, Usage } from './steps/model.ts'
import { parseArgs, usageText } from './steps/options.ts'
import { readQueueEnv } from './steps/setup.ts'

const SCRIPT = fileURLToPath(import.meta.url)
const stepContext: StepContext = { script: SCRIPT, here: dirname(SCRIPT), sleepScale: 1 }

function print(lines: string[]): void {
  process.stdout.write(`${lines.join('\n')}\n`)
}

// 판정 줄과 이유 줄. 이유가 없으면 통과다.
// notes(통합 테스트 생략 줄)는 판정과 상관없이 그 뒤에 붙는다
export function gateLines(n: string, reasons: GateReason[], notes: string[] = []): string[] {
  const ready = reasons.filter((r) => r.stage === 'ready')
  const holds = reasons.filter((r) => r.stage === 'merge')
  const result = ready.length === 0 ? [`GATE-OK ${n}`] : [`GATE-FAIL ${n}`, ...ready.map((r) => `  ${r.text}`)]
  return [...result, ...notes, ...holds.map((r) => `HOLD ${r.text}`)]
}

async function gate(state: StepState, n: string): Promise<{ reasons: GateReason[]; notes: string[] }> {
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
    const { reasons, notes } = await gateReasons(stepContext, state, ci ? 'none' : 'all')
    return { reasons: ci ? [ci, ...reasons] : reasons, notes }
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
    const { reasons, notes } = await gate(state, n)
    print(gateLines(n, reasons, notes))
    return reasons.some((r) => r.stage === 'ready') ? 1 : 0
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
