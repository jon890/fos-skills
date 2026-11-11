// 저장소마다 하나 도는 상주 루프다. 여러 세션의 Run 을 함께 맡는다(ADR-012, lifecycle.ts 머리 주석의 「Run」). 틱마다 질문 확인, 정리(원격 브랜치 포함), 보드 동기화, CI 감시와 알림, tick 이벤트, 자동 머지, 충돌 PR 처리를 한다.
// 코디네이터를 깨워야 하는 일은 그 Run 에 Orca status 메시지로 보낸다. 전송은 lib/run-notice.ts 가 맡는다.
// 루프는 상태로만 판정한다. 루프가 없던 동안 생긴 일은 다음 틱이 다시 보므로, 죽으면 다시 띄우기만 하면 된다.
// 상태 파일의 읽기, 생존 판정과 Run 등록은 lib/loop.ts 가 소유한다. 형식은 docs/data-schema.md 「orch 루트에 더하는 파일」 이다.
//
// 사용법:
//     orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] (--start | --stop [--all] | --status | --foreground) [--once]
//     orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] --tick --tick-number N      (내부용. 부모가 띄운다)
//
//     --repo         대상 저장소. 주 checkout 으로 바꿔 쓴다
//     --run          루프에 등록하거나 뺄 Run. 없으면 config.json 의 finish.run 이다
//     --specs-dir    그 Run 의 정리에 넘길 지시서 폴더. 없으면 finish.specs_dir 이고, 둘 다 없으면 넘기지 않는다. 등록 파일에 적는다
//     --start        Run 이 있으면 먼저 이 프로세스가 그 Run 을 조회할 수 있는지 본다(lifecycle.ts 머리 주석의 「명의」). consumer_fenced 면 띄우지도
//                    합류하지도 않고 LOOP-START-FENCED <Run> <묶인 Run> 과 `안내: …` 한 줄, 5 다.
//                    그다음 등록한다(lib/loop.ts 의 registerRun). 살아 있는 루프가 없으면 자기 자신을 --foreground 로
//                    분리해(detached, stdio ignore) 띄우고, 자식이 loop.json 에 자기 pid 를 쓸 때까지 10초까지 기다린다.
//                    하네스의 백그라운드 명령이 아니라 시간 한도에 묶이지 않는다.
//                    LOOP-STARTED <pid> run=<Run id 또는 -> 와 0. 10초 안에 쓰지 않으면 자식을 끝내고 LOOP-START-FAIL <이유> 와 1.
//                    살아 있는 루프가 없을 때의 등록은 registered_at 을 지금으로 새로 쓴다(lifecycle.ts 머리 주석의 「Run」).
//                    자식이 4(다른 --start 가 띄운 루프가 먼저 잠금을 쥐었다)로 끝나면 그 루프가 살아 있는지 다시 보고, 있으면 아래 합류와 같다.
//                    살아 있는 루프가 있으면 띄우지 않는다. 그 Run 이 아직 등록되지 않았으면 등록하고 LOOP-JOINED <pid> run=<Run id> 와 0.
//                    다만 그 루프의 묶인 Run(loop.json 의 bound_run)이 이 Run 과 다르거나 bound_run 이 없으면(옛 루프, 명의를 읽지 못한 루프)
//                    등록하지 않고 LOOP-START-FENCED <Run> <묶인 Run 또는 unknown> 과 `안내: …` 한 줄, 5 다. 막 뜨는 루프는 loop.json 을
//                    쓸 때까지 10초까지 기다려 판정한다
//                    그 루프가 막 뜨는 중(loop.json 의 pid 가 아직 그 루프의 것이 아니다)이면 이미 등록된 Run 이어도 registered_at 을
//                    새로 쓴다. 뜨는 루프가 앞 루프의 alive_at 이전 등록을 지울 때 이 Run 을 지우지 않게 하려는 것이다.
//                    이미 등록됐거나 Run 이 없으면 LOOP-RUNNING <pid> run=<Run id> 와 4.
//                    Run 등록을 모르는 옛 루프(loop.json 에 runs 가 없다)면 등록하지 않고 LOOP-RUNNING 과 4 이고, Run 이 다르면
//                    `안내: …` 한 줄을 더 낸다. 그 루프를 띄운 세션이 --stop 뒤 새 orch 로 다시 띄워야 한다.
//                    짧은 출력(진입점의 orch loop …, lib/output.ts)은 `안내:` 줄을 내지 않고, 옛 루프 안내만 `LOOP-LEGACY <pid> run=<그 루프의 Run>` 으로 낸다
//     --stop         --run 을 주면 그 Run 의 등록만 지운다. 다른 Run 이 남으면 루프를 멈추지 않고
//                    LOOP-LEFT <pid> run=<Run id> runs=<남은 Run 목록> 와 0, 등록돼 있지 않았으면 LOOP-NOT-REGISTERED run=<Run id> 와 0.
//                    옛 루프가 다른 Run 의 것이면 멈추지 않고 LOOP-NOT-REGISTERED 와 안내 줄, 0 이다.
//                    옛 알림 파일은 --stop 에서 건드리지 않고 cleanup/legacy-notices.ts 가 전달한 뒤 휴지통으로 옮긴다.
//                    --run 이 없고 finish.run 도 없으면 등록된 Run 이 하나라도 있을 때 멈추지 않고 LOOP-STOP-SHARED <pid> runs=<목록> 와 1 이다.
//                    등록이 하나여도 다른 세션의 Run 일 수 있어, 다른 세션의 루프를 끊지 않으려는 것이다. --all 을 주면 모두 지우고 멈춘다.
//                    등록을 뺀 뒤 신호를 보내기 직전에 다른 세션이 합류했으면 멈추지 않고 LOOP-LEFT <pid> run=<Run id> runs=<목록> 와 0 이다.
//                    남은 Run 이 없으면 아래처럼 루프 프로세스를 멈춘다.
//                    loop.json 의 pid 에 TERM 을 보내고 20초까지 끝나기를 기다린다. LOOP-STOPPED <pid> 와 0,
//                    루프가 없으면 LOOP-NOT-RUNNING 과 0, 20초 뒤에도 살아 있으면 LOOP-STOP-TIMEOUT <pid> 와 1.
//                    pid 가 살아 있어도 그 명령줄에 orch-loop 가 없으면 루프가 아니다. 죽은 루프의 pid 를 다른 프로세스가 다시 받았을 수 있다.
//                    ps 로 판정할 수 없으면(lib/loop.ts 의 isLoopProcess 가 null) 신호를 보내지 않고 LOOP-STOP-UNKNOWN <pid> <이유> 와 1.
//                    루프가 아닌 프로세스에 TERM 을 보내지 않으려는 것이다
//     --status       LOOP-ALIVE <pid> run=<…> last_tick=<…> alive_at=<…> 와 0, LOOP-DEAD <repo> <이유> 와 1. 판정은 lib/loop.ts 의 loopStatus
//     --foreground   지금 프로세스에서 틱을 돈다. --start 의 자식과 테스트가 쓴다. 신호를 받으면 진행 중인 틱 자식을 끝내고(lifecycle.ts 머리 주석의 「틱 자식」)
//                    128 + 신호 번호
//     --once         --foreground 와 함께 틱 한 번만 돌고 0 으로 끝난다
//     --all          --stop 과 함께, --run 없이 준다. 등록된 Run 을 모두 지우고 루프를 멈춘다
//     --tick, --tick-number N
//                    틱 하나를 돌고 끝난다. --foreground 의 부모가 틱마다 띄운다. N 은 1 부터다.
//                    stdout 마지막 줄에 {"tick_at": <ISO 8601 UTC>, "errors": {<출처>: <이유 또는 null>}, "open_prs": <번호 목록 또는 null>,
//                    "ci": {<PR 번호>: {"head": <SHA>, "state": <passed, failed, pending>}}, "stalls": {<dispatch>: <멈춤 항목>}} 을 내고 0.
//                    열린 PR 을 읽지 못한 틱은 ci 가 없고, 멈춤 확인이 예외로 끝난 틱은 stalls 가 없다. 멈춤 항목은 steps/stalls.ts 머리 주석의 「멈춤 확인」 이다
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts)
//
// 파일: 이 파일은 인자를 읽어 모드를 고르고, --tick 이면 단계를 차례로 불러 결과 줄을 낸다. 나머지는 아래 파일이 소유한다.
//     lifecycle.ts       --start, --stop, --status, --foreground. 「한 저장소에 하나」, 「명의」, 「Run」, 「틱 자식」, 「생존 타이머」, 「loop.json」
//     steps/context.ts   설정 읽기와 단계가 주고받는 값. 「설정」, 「틱의 Run」
//     steps/errors.ts    오류 이유 기록과 알림. 「오류 줄 억제」
//     steps/shared.ts    로그와 worker 찾기. 「로그」, 「알림의 Run」, 「worker 찾기」
//     steps/<단계>.ts    아래 「틱」 의 단계 하나씩
//
// 틱: --tick 은 아래 단계를 순서대로 부른다. 하나가 실패해도 다음을 한다. 단계마다의 일과 알림은 그 단계 파일 머리 주석이 소유한다.
//     1. 질문 확인. steps/questions.ts
//     2. 열린 PR 조회. steps/prs.ts
//     3. 보드 동기화(워크트리 정리 전). steps/board.ts. 이어서 사용자 결정 알림. steps/decisions.ts
//     4. 정리. steps/cleanup.ts
//     5. CI 감시. steps/ci.ts
//     5-1. 머지 알림. steps/merged.ts
//     6. 멈춤 확인. steps/stalls.ts
//     6-1. 움직임 확인. steps/movement.ts
//     6-2. 다음 단계 알림. steps/step-ready.ts
//     7. tick 이벤트. steps/tick-event.ts
//     8. 자동 머지. steps/auto-merge.ts
//     8-1. 큐 기록. steps/queue-turns.ts
//     9. 충돌 처리. steps/conflicts.ts. 끝난 dispatch 에 이어 쓰면 65분까지 걸려 마지막에 둔다. 밀리는 것은 다음 틱뿐이다
//     9-1. 최신화. steps/refresh.ts. 충돌 처리가 받은 base 와 PR HEAD 를 쓰므로 그 뒤에 둔다
//     10. 자리 보유 확인. steps/heavy-slot.ts
//     11. 미답변 질문 확인. steps/unanswered.ts
//     12. 모아 보내기와 완료 보고·끊긴 worker 확인. steps/reports.ts
//     단계는 설정과 이번 틱의 Run(StepContext), 앞 단계가 낸 값(StepState)을 받아 바꿀 값과 오류 이유(StepResult)를 돌려준다(steps/context.ts).
//     tick 이 결과를 차례로 합쳐 결과 줄을 낸다. 부모가 결과 줄을 loop.json 에 합치는 규칙은 lifecycle.ts 머리 주석의 「틱 자식」 이다.
//
// 알림 방식: 코디네이터가 할 일이 있는 kind 는 그 틱에 Run 메시지로 바로 보내고, WATCH-ERROR, LEGACY-NOTICE, STAGE-STALLED, LOOP-RESTARTED 는 loop.log 에 남긴 뒤
//     state/notice-digest/<Run>.json 에 모아 pipeline.digest_sec(기본 1800)마다 DIGEST 하나로 보낸다. 같은 WATCH-ERROR 가 연속 세 틱 넘게 이어지면 바로 보낸다.
//     한 Run 에 여러 저장소의 루프가 있으면 lib/run-notice.ts 가 머신 폴더의 run-notices/<Run>/<해시> 로 다른 루프가 보낸 같은 알림을 건너뛴다.
//     어떤 kind 가 어느 쪽인지의 표는 lib/notice-digest.ts 와 references/waiting.md 가 갖는다. 틱마다 Run 별로 flushDigest 를 부른다.
//
// 환경 변수: ORCA(orca 실행 파일), GH(gh 실행 파일), HEAVY_SLOT_DIR, HEAVY_HOLD_MAX(자리 보유 확인), CLEANUP_SWEEP(정리 명령. 기본은 이 폴더의 cleanup-sweep.ts),
//     BOARD_SYNC(보드 동기화 명령. 기본은 이 폴더의 board-sync.ts), SEND_TO_WORKER(worker 에게 보내는 명령. CI 감시와 충돌 처리가
//     쓴다. 최신화도 쓴다. 기본은 이 폴더의 send-to-worker.ts), ORCH_LOOP_ALIVE_SEC(생존 타이머 간격),
//     MERGE_WITH_FINISH(자동 머지가 띄우는 큐 명령. 기본은 이 폴더의 merge-with-finish.ts),
//     THREADS_CMD(미해결 스레드 수를 내는 bash 명령. 환경 변수 OWNER, REPO, PR, GH_HOST 를 받는다. 기본은 머지 큐의 기본 --threads-cmd 와
//     같은 review-fix 의 review_threads.ts), PS(프로세스 목록 명령. 자동 머지와 최신화가 쓴다. 기본 ps)
//
// 종료 코드:
//     0  성공. --start 가 띄웠다, --stop 이 멈췄거나 루프가 없다, --status 가 살아 있다, --once 와 --tick 이 끝났다
//     1  --start 실패, --stop 시간 초과나 루프 프로세스인지 판정하지 못함, --status 가 죽었다, 잡지 않은 예외
//     2  사용법 오류와 설정 오류(ConfigError, ORCH_LOOP_ALIVE_SEC 가 양수가 아님)
//     4  살아 있는 루프가 있다(LOOP-RUNNING)
//     5  --start 가 명의 때문에 띄우지도 합류하지도 않았다(LOOP-START-FENCED)
//     128 + 신호 번호  --foreground 나 --tick 이 신호를 받았다. --tick 의 부모가 사라지면 129(SIGHUP)

import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { ConfigError } from '../lib/config.ts'
import { mainCheckout } from '../lib/git.ts'
import { DEFAULT_ALIVE_SEC } from '../lib/loop.ts'
import { withRun } from '../lib/proc.ts'
import type { RunOptions, RunResult } from '../lib/proc.ts'
import { setNoticeOwner } from '../lib/run-notice.ts'
import { aliveSec, foreground, handleSignals, start, status, stop, Usage, watchParent } from './lifecycle.ts'
import { runAutoMerge } from './steps/auto-merge.ts'
import { syncBoard } from './steps/board.ts'
import { checkCi } from './steps/ci.ts'
import { sweepRuns } from './steps/cleanup.ts'
import { settleConflicts } from './steps/conflicts.ts'
import { context, initialState, stepContext } from './steps/context.ts'
import type { Context, StepResult, StepState, TickResult } from './steps/context.ts'
import { notifyPendingDecisions } from './steps/decisions.ts'
import { checkHeavySlot } from './steps/heavy-slot.ts'
import { notifyMerged } from './steps/merged.ts'
import { checkMovement } from './steps/movement.ts'
import { openNumbers, readOpenPrs } from './steps/prs.ts'
import { checkQuestions } from './steps/questions.ts'
import { relayQueueTurns } from './steps/queue-turns.ts'
import { refreshPrs } from './steps/refresh.ts'
import { checkReports } from './steps/reports.ts'
import { iso, log } from './steps/shared.ts'
import { notifyStepReady } from './steps/step-ready.ts'
import { checkStalls } from './steps/stalls.ts'
import { fireTick } from './steps/tick-event.ts'
import { checkUnanswered } from './steps/unanswered.ts'

const USAGE = [
  '사용법: orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] (--start | --stop [--all] | --status | --foreground) [--once]',
  '        orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] --tick --tick-number N',
].join('\n')

const SELF = fileURLToPath(import.meta.url)

const MODES = ['start', 'stop', 'status', 'foreground', 'tick'] as const

type Mode = (typeof MODES)[number]

// 틱 하나. 머리 주석의 「틱」 순서대로 단계를 부르고 결과를 합쳐 결과 줄을 낸다
async function tick(config: Context, n: number): Promise<number> {
  const ctx = stepContext(config, n)
  const state = initialState()
  collect(state, await checkQuestions(ctx, state))
  collect(state, await readOpenPrs(ctx, state))
  collect(state, await syncBoard(ctx, state))
  collect(state, await notifyPendingDecisions(ctx, state))
  collect(state, await sweepRuns(ctx, state))
  collect(state, await checkCi(ctx, state))
  collect(state, await notifyMerged(ctx, state))
  collect(state, await checkStalls(ctx, state))
  collect(state, await checkMovement(ctx, state))
  collect(state, await notifyStepReady(ctx, state))
  collect(state, await fireTick(ctx, state))
  collect(state, await runAutoMerge(ctx, state))
  collect(state, await relayQueueTurns(ctx, state))
  collect(state, await settleConflicts(ctx, state))
  collect(state, await refreshPrs(ctx, state))
  collect(state, await checkHeavySlot(ctx, state))
  collect(state, await checkUnanswered(ctx, state))
  collect(state, await checkReports(ctx, state))
  const { errors, ci, stalls } = state
  const result: TickResult = { tick_at: iso(), errors, open_prs: openNumbers(state.prs), ...(ci ? { ci } : {}), ...(stalls ? { stalls } : {}) }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return 0
}

// 단계 결과를 합친다. 오류 이유는 출처마다 덧쓰고 나머지 칸은 통째로 바꾼다
function collect(state: StepState, result: StepResult): void {
  const { errors, ...rest } = result
  Object.assign(state.errors, errors)
  Object.assign(state, rest)
}

// 실행 범위만 주입한다. 기본 진입점과 자식 실행은 실제 CLI 그대로다.
export function main(argv: string[], runner?: (argv: string[], opts?: RunOptions) => RunResult, entrypoint = SELF): Promise<number> {
  return runner ? withRun(runner, () => executeMain(argv, entrypoint)) : executeMain(argv, entrypoint)
}

async function executeMain(argv: string[], entrypoint: string): Promise<number> {
  let values
  let mode: Mode
  let tickNumber = 0
  let interval = DEFAULT_ALIVE_SEC
  try {
    const options = {
      repo: { type: 'string' },
      run: { type: 'string' },
      'specs-dir': { type: 'string' },
      start: { type: 'boolean', default: false },
      stop: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      foreground: { type: 'boolean', default: false },
      once: { type: 'boolean', default: false },
      tick: { type: 'boolean', default: false },
      'tick-number': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } as const
    values = parseArgs({ args: expandArgs(argv, options), options }).values
    if (values.help) {
      process.stdout.write(`${USAGE}\n`)
      return 0
    }
    const chosen = MODES.filter((name) => values[name])
    if (chosen.length !== 1) throw new Usage('--start, --stop, --status, --foreground, --tick 가운데 하나만 준다')
    mode = chosen[0]
    if (!values.repo) throw new Usage('--repo 가 필요하다')
    if (values.once && mode !== 'foreground') throw new Usage('--once 는 --foreground 와 함께 준다')
    if (values.all && (mode !== 'stop' || values.run)) throw new Usage('--all 은 --run 없이 --stop 과 함께 준다')
    if ((mode === 'tick') !== (values['tick-number'] !== undefined)) throw new Usage('--tick 과 --tick-number 는 함께 준다')
    if (mode === 'tick') {
      const raw = values['tick-number'] as string
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Usage(`--tick-number 는 1 이상의 정수다: ${raw}`)
      tickNumber = Number(raw)
    }
    if (mode === 'foreground') interval = aliveSec()
  } catch (e) {
    process.stderr.write(`${USAGE}\norch-loop: ${(e as Error).message}\n`)
    return 2
  }
  const repo = mainCheckout(resolve(values.repo as string))
  if (mode === 'stop') {
    let run = (values.run as string | undefined) || null
    if (!run && !values.all) {
      try {
        run = context(repo, undefined, undefined).run
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e
        process.stderr.write(`orch-loop: ${e.message}\n`)
        return 2
      }
    }
    return stop(repo, run, values.all as boolean)
  }
  if (mode === 'status') return status(repo)

  let ctx: Context
  try {
    ctx = context(repo, values.run, values['specs-dir'])
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    process.stderr.write(`orch-loop: ${e.message}\n`)
    return 2
  }
  setNoticeOwner(ctx.repo)
  if (mode === 'start') return start(ctx, entrypoint)
  handleSignals()
  if (mode === 'tick') {
    watchParent()
    return tick(ctx, tickNumber)
  }
  return foreground(ctx, values.once as boolean, interval, entrypoint)
}

export function reportError(e: unknown): void {
  log(`orch-loop: ${(e as Error)?.stack ?? String(e)}`)
  process.exitCode = 1
}

if (import.meta.main || (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === SELF)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    reportError,
  )
}
