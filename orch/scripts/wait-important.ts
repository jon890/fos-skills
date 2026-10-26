// 코디네이터가 처리할 메시지가 올 때까지 기다린다. heartbeat 만 든 묶음은 ack 하고 계속 기다린다.
//
// `check --wait` 는 `--types` 를 깨어나는 조건으로만 쓰고, 돌려주는 delivery 는 그때 쌓인 묶음 전체다.
// heartbeat 만 든 묶음으로 깨어나면 코디네이터가 읽을 것 없이 ack 하고 다시 거느라 깨어남마다 한 턴을 쓴다.
// 이 명령이 그 묶음을 대신 ack 하고, 처리할 종류가 든 묶음이 오면 ack 하지 않고 그대로 낸다.
// 코디네이터는 그 묶음을 `triage-messages` 로 읽은 뒤 마지막 줄의 delivery id 를 다음 대기의 `--ack` 로 넘긴다.
//
// **Bash 도구의 `run_in_background` 로만 띄운다.** 셸의 `&` 나 `nohup` 으로 띄우면 끝나도 완료 알림이 오지 않는다.
// 플러그인 hook(`hooks/block-background-wait.ts`)이 그런 호출을 막는다.
//
// 사용법:
//     wait-important.ts --run RUN_ID [--ack DELIVERY_ID] [--types worker_done,question,escalation,status]
//                       [--timeout-ms 7000000] [--kill-stale] [--lost-interval-sec 60] [--ignore-lost ctx_...]
//                       [--lost-state FILE] [--ack-lost ctx_...] [--completion-contract ready|none] [--loop-repo DIR ...]
//
//     --run         기다릴 Run
//     --ack         앞 대기가 낸 delivery id. 첫 대기처럼 넘길 것이 없으면 뺀다
//     --types       깨어날 메시지 종류. 기본 worker_done,question,escalation,status
//     --timeout-ms  전체 대기 한도(ms). 기본 7000000. 하네스의 명령 한도(Bash 최대 7200000)보다 짧게 준다
//     --lost-interval-sec  대기하는 동안 Run 의 worker 상태를 볼 간격(초). 기본 60. 0 이면 보지 않는다. 아래 「끊긴 worker」
//     --ignore-lost  끊긴 worker 로 보지 않을 dispatch id. 여러 번 줄 수 있다. 아래 「끊긴 worker」
//     --lost-state  이미 알린 끊긴 dispatch 를 적는 파일. 기본 <orch 작업 폴더>/state/wait-important-lost.json. 아래 「끊긴 worker」
//     --ack-lost    확인한 끊긴 dispatch 를 처리함으로 기록하고 대기 없이 끝낸다. 여러 번 줄 수 있다.
//                   --ignore-lost 는 그 실행에서만 빼지만 이 옵션은 --lost-state 파일에 handled 로 덮어써 다음 실행부터 경고도 생략한다.
//                   파일을 쓰지 못하면 종료 코드 1 이고 확인한 것으로 처리하지 않는다. 다른 Run 의 기록과 아직 확인하지 않은 dispatch 는 유지한다
//     --completion-contract  ready(기본)는 앞선 PR 준비 상태를 검사한다. PR 없는 작업만 none 으로 끈다
//     --kill-stale  대기 자리를 쥔 프로세스 가운데 부모가 init(PID 1)인 것과 그 밑의 대기를 종료한다. 아래 「남은 대기」
//     --loop-repo   상주 루프(orch-loop.ts)의 알림과 생존을 볼 저장소. 여러 번 줄 수 있다. 주지 않으면 보지 않는다. 아래 「상주 루프」
//
// 완료 계약 (--completion-contract ready):
//     worker_done 이 오면 같은 Task·Dispatch·발신자가 앞서 `준비됨 #N, head <전체 40자리 SHA>` 상태를 보냈는지
//     `check --all` 로 읽어 대조한다(lib/completion.ts). 이미 ack 한 준비 상태도 읽으며 delivery 는 소비하지 않는다.
//     근거가 없거나 이력을 읽지 못하면 `의심스러운 worker_done` 으로 따로 표시하고 자동 ack 하지 않은 채 종료 코드 6 으로 끝난다.
//     `worker_done --outcome failed` 같은 명시적인 실패 보고는 준비 상태 없이도 처리할 묶음으로 낸다.
//
// 출력:
//     처리할 묶음이 오면 그 `check --json` 결과를 한 줄 JSON 으로 내고, 마지막 줄에 `LAST_DELIVERY <id>` 를 낸다.
//     시간 한도가 지나면 `TIMEOUT LAST_DELIVERY <id>` 를 낸다. id 는 ack 하지 못하고 남은 delivery 이고, 없으면 `-` 다.
//     `WATCH-ERROR <이유>` 는 코디네이터가 알아야 하는 조회 실패다. stderr 에도 남긴다. 하네스는 stderr 를 알림으로 보내지 않는다.
//         `check --wait` 가 실패해 종료 코드 1 로 끝날 때와, 끊긴 worker 확인용 `worker-list` 가 실패할 때(대기 시작 때와 대기 중 모두) 낸다.
//         같은 이유는 이유가 바뀌거나 조회가 한 번 성공할 때까지 다시 내지 않는다. `LAST_DELIVERY` 줄보다 늘 앞이다.
//         `waiter_exists`(종료 코드 4 와 stderr 의 프로세스 목록이 맡는다)와 완료 근거용 `check --all` 의 실패(종료 코드 6)는 내지 않는다.
//
// 이벤트(lib/events.ts 머리 주석의 「이벤트별 필드」). 둘 다 거부할 수 없고 핸들러의 실패는 `HOOK-FAIL` 줄만 남기고 종료 코드를 바꾸지 않는다.
//     worker-done  묶음 안의 worker_done 마다, 완료 근거를 판정한 뒤 JSON 줄을 내기 전. 근거가 있으면 evidence 가 ready 이고
//                  pr 은 준비 상태의 PR 번호로 `gh pr view` 를 읽어 채운다(읽지 못하면 null). 없으면 suspicious 이고 pr 은 null 이다.
//                  실패 보고와 `--completion-contract none` 의 대기에서는 내지 않는다
//     worker-lost  WORKER_LOST 줄을 처음 낼 때. LAST_DELIVERY 줄 앞. worker 는 worker-list 행의 값, stage 는 WORKER_LOST 줄의 값이다
//     repo 는 작업 디렉터리의 주 checkout, base 는 그 저장소의 origin/HEAD 브랜치(없으면 빈 문자열), run 은 --run 이다.
//
// 끊긴 worker:
//     기기가 재시작되어 worker 터미널이 사라져도 메시지는 오지 않아 대기가 끝나지 않는다.
//     그래서 대기하는 동안 `--lost-interval-sec` 마다 `orca orchestration worker-list --run <id> --json` 으로 상태를 본다.
//     한 번에 100행까지 오므로 page.nextCursor 끝까지 이어 읽는다(lib/orca.ts 머리 주석).
//     「끊김」 은 workerState 가 abandoned, failed, stopped 이거나 dispatchStatus 가 failed 이거나 단계가 terminal_missing 인 것이다.
//     단, completed/abandoned dispatch 와 성공·취소 결과는 터미널이 사라져도 제외한다.
//     끊긴 dispatch 를 찾으면 메시지를 기다리지 않고 `WORKER_LOST ctx_... stage=terminal_missing` 줄과
//     `LAST_DELIVERY <id>` 줄을 내고 종료 코드 5 로 끝난다. 지켜보는 대상은 둘이다.
//     1) 대기를 시작할 때 살아 있던(dispatchStatus 가 pending, dispatched, running) dispatch 가 대기하는 동안 끊긴 경우
//     2) 대기를 시작할 때 이미 끊겨 있는데 아직 처리하지 않은 dispatch. 재시작 뒤 새로 건 대기가 이 경우다.
//        이때는 `check` 를 부르지 않고 바로 5 로 끝난다
//     「처리했다」 고 보아 뺀다: 같은 task 에 그보다 나중에 만든 dispatch 가 있으면(다시 띄웠으므로),
//     task 가 completed 이거나 취소(failed 에 result 가 cancelled)면, `--ignore-lost` 로 준 id 면.
//     worker-list 행에는 만든 시각이 없어 나중 dispatch 는 `dispatch-show --task` 의 최신 dispatch id 로 판정한다.
//     그것이나 task-list 를 읽지 못하면 그 dispatch 는 시작할 때 지켜보지 않는다(이전 동작).
//     worker-list 를 읽지 못하면 그 번의 확인만 건너뛰고 WATCH-ERROR 를 낸다.
//     두 경우 모두 일부러 끝낸 dispatch 는 끊긴 것으로 보지 않는다. `dispatch-show` 의 termination_reason 이
//     operator_close(코디네이터나 정리 스크립트가 터미널을 닫았다)이거나, last_failure 의 provenance 가
//     worker_report(worker 가 `worker_done --outcome failed` 로 알렸다)인 것이다.
//     camelCase 필드도 읽으며, 실패 이유가 abandoned 인 명시적 포기도 제외한다.
//     알린 dispatch 와 일부러 끝냈다고 판정한 dispatch 는 `--lost-state` 파일에 Run 별로 적고 다음 대기부터 다시
//     알리거나 조회하지 않는다. worker_done 없이 같은 터미널에 일을 이어 준 옛 dispatch 가 대기를 걸 때마다 다시
//     깨우지 않게 하기 위해서다. 앞 대기가 알렸는데 아직 끊긴 채인 dispatch 는 깨우지 않고 stderr 에 한 줄로 남긴다.
//     다시 알리게 하려면 그 파일에서 Run 의 항목을 지운다.
//
// 상주 루프 (--loop-repo):
//     대기를 시작할 때와 --lost-interval-sec 간격의 확인마다 저장소 순서대로 본다. 간격이 0 이면 시작할 때만 본다.
//     끊긴 worker 확인(종료 코드 5)이 먼저다. 판정은 lib/loop.ts 의 readEvents 와 loopStatus 다.
//     알림 파일은 --run 의 Run 의 파일(state/loop-events/<Run>.jsonl)과 Run 이 없는 루프의 옛 파일(state/loop-events.jsonl)이다.
//     다른 Run 의 알림에는 깨어나지 않는다(ADR-012). 옛 파일은 Run 등록을 모르는 옛 루프와 Run 없이 띄운 루프가 쓴다.
//     --run 이 있으면 옛 파일은 loop.json 에 runs 가 없고 그 run 이 --run 의 Run 이거나 비었을 때(loop.json 이 없을 때 포함)만 읽는다.
//     옛 파일과 그 커서는 Run 마다 나뉘지 않아, 다른 Run 의 옛 루프 알림에 깨어나 커서를 옮기면 그 Run 의 코디네이터가 알림을 잃는다
//     - 알림 파일에 커서 뒤의 줄이 있으면 줄마다 `LOOP-EVENT <kind> <pr 또는 -> <text>` 를 모두 낸다. 잘려 잃은 구간이 있으면
//       그 앞에 `LOOP-EVENT GAP - seq <a>..<b> 를 잃었다` 를 낸다. 그다음 마지막 seq 로 커서를 쓰고, check --wait 그룹을 끝낸 뒤
//       `LAST_DELIVERY <id>` 와 종료 코드 7 로 끝난다. 커서를 쓰지 못하면 WATCH-ERROR 줄을 더 내고 그래도 7 이다.
//       줄은 이미 냈으므로 다음 대기가 같은 줄을 다시 낼 수 있다
//     - 루프가 죽었으면 `LOOP-DEAD <repo> <이유>`, `LAST_DELIVERY <id>` 와 종료 코드 8 로 끝난다.
//       pid 가 살아 있는 루프 프로세스인데 alive_at 만 오래됐으면(loopStatus 의 recheck) 바로 죽음으로 내지 않는다.
//       lib/loop.ts 의 recheckMs(생존 타이머 간격 ORCH_LOOP_ALIVE_SEC, 기본 30초에 5초를 더한 값)를 기다린 뒤 한 번 더 보고,
//       그때도 죽었으면 LOOP-DEAD 다. 잠들었다 깬 macOS 에서 루프의 타이머가 아직 alive_at 을 쓰지 못한 것을 죽음으로 보지 않으려는 것이다.
//       기다리는 동안에도 check --wait 와 끊긴 worker, 알림 파일은 지금처럼 본다. 간격이 0 이어도 다시 보는 확인 한 번은 한다
//     - 루프가 살아 있고 Run 등록을 아는 루프(loop.json 에 runs 가 있다)인데 --run 의 Run 이 등록되지 않았으면
//       `LOOP-DEAD <repo> run <Run> 미등록` 과 종료 코드 8 이다. 그 루프는 이 Run 의 질문 확인과 정리를 하지 않는다.
//       코디네이터가 orch-loop.ts --start --run 으로 등록한 뒤 다시 건다. 옛 루프에는 이 판정을 하지 않는다
//     한 번 깨어나면 끝난다. 알림 줄이 있으면 그 저장소의 죽음보다 먼저 낸다. 다음 대기가 죽음을 낸다.
//     <repo> 는 --loop-repo 의 주 checkout 이다.
//
// 남은 대기:
//     Run 의 대기 자리는 하나다. 앞 세션이 띄운 `check --wait` 가 남아 있으면 새 대기는 매번 `waiter_exists` 로
//     바로 끝난다. 다시 걸어도 같은 오류만 받으므로, 이 오류를 받으면 되풀이하지 않고 같은 사용자의 프로세스 가운데
//     이 Run 의 `check --wait` 와 `wait-important` 를 찾아 stderr 로 보여 주고 종료 코드 4 로 끝난다.
//     부모가 init 인 것과 그 밑에 딸린 것은 세션이 끝나 고아가 된 대기라 그 메시지를 받을 쪽이 없다.
//     `--kill-stale` 을 주면 그것만 종료한다.
//     부모가 살아 있는 것은 다른 세션이 아직 기다리는 중일 수 있어 종료하지 않는다.
//
// 끝내기:
//     `check --wait` 는 자기 프로세스 그룹으로 띄운다. SIGTERM, SIGINT, SIGHUP 을 받으면 그 그룹에 SIGTERM 을 보내고
//     stderr 에 한 줄을 남긴 뒤 128 + 신호 번호로 끝난다. 그 check 가 남으면 Run 의 대기 자리를 쥔 채 남아
//     다음 대기가 waiter_exists 로 막힌다. 그룹을 나눈 것은 끊긴 worker 를 찾았을 때 orca 와 그 자식을 함께 끝내기 위해서다.
//     그룹이 다르면 터미널이 앞 그룹에 보내는 신호가 check 에 닿지 않으므로 이 명령이 대신 전한다.
//     orca 가 --timeout-ms 가 지나도 끝나지 않으면 30초를 더 기다린 뒤 그룹을 끝내고 check 실패(WATCH-ERROR, 종료 코드 1)로 다룬다.
//
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts).
// ORCA 환경 변수로 orca 실행 파일을, PS 환경 변수로 ps 실행 파일을, GH 환경 변수로 gh 실행 파일을 바꾼다.
// ps 는 LC_ALL=C 로 부른다. 한국어 locale 의 lstart(「금 10/23 10:00:00 2026」)는 낱말 수가 달라 행을 읽지 못한다.
//
// 종료 코드:
//     0  처리할 묶음이 왔다
//     3  시간 한도가 지났다. 실패가 아니므로 마지막 줄의 id 로 다시 건다
//     4  이 Run 에 다른 대기가 있다(waiter_exists). 남은 프로세스를 정리한 뒤 다시 건다
//     5  처리하지 않은 끊긴 worker 가 있다(WORKER_LOST). references/launch.md 의 「끊긴 worker 다시 띄우기」 를 따른다.
//        같은 dispatch 는 다음 대기에서 다시 알리지 않는다
//     6  의심스러운 worker_done 이 있다. 자동 ack 하지 않으며 완료 검증 전에는 해제하지 않는다
//     7  상주 루프의 알림이 있다(LOOP-EVENT). 그 줄을 처리한 뒤 마지막 줄의 id 로 다시 건다
//     8  상주 루프가 죽었다(LOOP-DEAD). 루프를 다시 띄운 뒤 다시 건다
//     1  orca 가 그 밖의 오류를 냈다(runtime_unavailable 같은 것). 그 JSON 을 그대로 낸다
//     2  사용법 오류

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { classify, context, payload } from './lib/completion.ts'
import { fire, handlerFile } from './lib/events.ts'
import type { FireContext } from './lib/events.ts'
import { ghJson } from './lib/gh.ts'
import { defaultBase, mainCheckout } from './lib/git.ts'
import { isRegistered, loopStatus, readEvents, readLoop, recheckMs, writeCursor } from './lib/loop.ts'
import { orcaBin, orcaJson } from './lib/orca.ts'
import { makeParent, pathOf, warnLegacy } from './lib/paths.ts'
import { run, signalCode } from './lib/proc.ts'
import { pyJson, pyStr as text } from './lib/py.ts'

const USAGE = [
  '사용법: wait-important.ts --run RUN_ID [--ack DELIVERY_ID] [--types worker_done,question,escalation,status]',
  '                          [--timeout-ms 7000000] [--kill-stale] [--lost-interval-sec 60] [--ignore-lost ctx_...]',
  '                          [--lost-state FILE] [--ack-lost ctx_...] [--completion-contract ready|none] [--loop-repo DIR ...]',
].join('\n')
const DEFAULT_TYPES = 'worker_done,question,escalation,status'
const LIVE_STATUSES = new Set(['pending', 'dispatched', 'running'])
const LOST_WORKER_STATES = new Set(['abandoned', 'failed', 'stopped'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])
const HISTORY_TIMEOUT_MS = 30_000
// orca 는 --timeout-ms 에 끝난다. 그 뒤에도 남은 check 를 끝내기까지 더 기다리는 시간
const CHECK_GRACE_MS = 30_000

type Json = Record<string, unknown>
type Lost = [string, unknown]

function obj(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {}
}

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

// 같은 이유의 WATCH-ERROR 는 이유가 바뀌거나 조회가 한 번 성공할 때까지 다시 내지 않는다
let lastWatchError: string | null = null

function watchError(reason: string): void {
  const line = `WATCH-ERROR ${reason.replace(/\r?\n|\r/g, ' ')}`
  if (line !== lastWatchError) out(line)
  err(line)
  lastWatchError = line
}

function watchOk(): void {
  lastWatchError = null
}

// orca 명령 한 번의 result. 읽지 못하면 null 이다.
function orcaResult(args: string[], timeoutMs?: number): Json | null {
  const got = orcaJson<unknown>(['orchestration', ...args], timeoutMs ? { timeoutMs } : undefined)
  return got.ok ? obj(got.data) : null
}

// worker-list 의 workers 를 모든 페이지에 걸쳐 읽는다. 읽지 못하면 WATCH-ERROR 를 내고 null 이다.
function workerRows(runId: string): Json[] | null {
  const rows: Json[] = []
  const seen = new Set<string>()
  let cursor = ''
  for (;;) {
    const got = orcaJson<unknown>(['orchestration', 'worker-list', '--run', runId, '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])])
    if (!got.ok) {
      watchError(`끊긴 worker 를 확인하지 못했다: ${got.error}`)
      return null
    }
    const result = obj(got.data)
    const workers = Array.isArray(result.workers) ? result.workers : []
    rows.push(...workers.map(obj))
    const next = obj(result.page).nextCursor
    cursor = typeof next === 'string' ? next : ''
    if (!cursor) break
    if (seen.has(cursor)) {
      watchError('끊긴 worker 를 확인하지 못했다: worker-list 의 다음 페이지가 앞 페이지와 같다')
      return null
    }
    seen.add(cursor)
  }
  watchOk()
  return rows
}

function liveDispatches(rows: Json[]): Set<unknown> {
  return new Set(rows.filter((w) => w.dispatchId && LIVE_STATUSES.has(String(w.dispatchStatus))).map((w) => w.dispatchId))
}

// watched 에 든 dispatch 가운데 끊긴 것. [dispatch id, 단계]
function lostWorkers(rows: Json[], watched: Set<unknown>): Lost[] {
  const lost: Lost[] = []
  for (const w of rows) {
    if (!w.dispatchId || !watched.has(w.dispatchId)) continue
    // 정리로 터미널이 사라져도 이미 끝난 dispatch 는 끊김이 아니다
    if (w.dispatchStatus === 'completed' || w.dispatchStatus === 'abandoned') continue
    const projection = obj(w.projection)
    if (projection.outcome === 'succeeded' || projection.outcome === 'cancelled') continue
    const detail = obj(projection.stage).detail
    if (LOST_WORKER_STATES.has(String(w.workerState)) || w.dispatchStatus === 'failed' || detail === 'terminal_missing') {
      lost.push([String(w.dispatchId), detail || w.workerState])
    }
  }
  return lost
}

// 일부러 끝낸 dispatch 의 이유. 끊긴 것이면 null 이다. dispatch 는 `dispatch-show` 의 dispatch 다.
// operator_close 는 코디네이터나 정리 스크립트가 터미널을 닫은 것이고,
// worker_report 는 worker 가 실패를 메시지로 알린 것이다. 둘 다 코디네이터가 이미 안다.
function deliberateEnd(dispatch: Json): string | null {
  const termination = dispatch.terminationReason || dispatch.termination_reason
  if (termination === 'operator_close' || termination === 'worker_report') return termination
  let failure = dispatch.lastFailure || dispatch.last_failure
  if (failure === 'abandoned') return 'abandoned'
  if (typeof failure === 'string') {
    try {
      failure = JSON.parse(failure)
    } catch {
      failure = null
    }
  }
  return obj(failure).provenance === 'worker_report' ? 'worker_report' : null
}

// task 의 최신 dispatch(`dispatch-show --task`). 읽지 못하면 빈 객체다
function latestDispatch(taskId: unknown): Json {
  return obj(orcaResult(['dispatch-show', '--task', String(taskId)])?.dispatch)
}

function loadState(file: string): Json {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return obj(data)
  } catch {
    return {}
  }
}

// 이 Run 에서 이미 판정한 dispatch. {dispatch id: 「lost 시각」 이나 「operator_close 시각」}.
// 파일이 없거나 읽지 못하면 빈 객체다
function loadReported(file: string, runId: string): Json {
  return obj(loadState(file)[runId])
}

// 판정한 dispatch 를 Run 별로 적는다. kinds 는 {dispatch id: lost 나 일부러 끝낸 이유} 다.
// 쓰지 못하면 stderr 로 알리고 false 를 돌려준다. --ack-lost 는 이때 실패로 끝낸다.
function saveReported(file: string, runId: string, kinds: Record<string, string>, repo: string): boolean {
  if (Object.keys(kinds).length === 0) return true
  const data = loadState(file)
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const entry = obj(data[runId])
  data[runId] = entry
  for (const [dispatch, kind] of Object.entries(kinds)) {
    if (kind === 'handled' || !Object.hasOwn(entry, dispatch)) entry[dispatch] = `${kind} ${now}`
  }
  try {
    makeParent(file, repo)
    // 쓰는 도중에 끊겨도 앞 내용이 깨지지 않게 옆 파일에 쓰고 바꾼다
    const tmp = join(dirname(file), `${basename(file)}.${process.pid}.tmp`)
    writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`)
    renameSync(tmp, file)
    return true
  } catch (e) {
    err(`wait-important: 판정한 dispatch 를 ${file} 에 적지 못했다: ${(e as Error).message}`)
    return false
  }
}

// 다시 띄울 일이 없는 task. completed 이거나, 취소(failed 에 result 가 cancelled)한 것
function taskClosed(task: Json): boolean {
  return task.status === 'completed' || (task.status === 'failed' && String(task.result || '').toLowerCase().includes('cancel'))
}

// 대기를 시작할 때 이미 끊겨 있고 아직 처리하지 않은 dispatch 와, 일부러 끝낸 dispatch 와 그 이유.
// 처리한 것은 뺀다: --ignore-lost(이미 판정한 것 포함), 끝난 task, 같은 task 에 더 나중 dispatch 가 있는 것,
// 일부러 끝낸 것. 판정에 필요한 목록을 읽지 못하면 그 dispatch 는 지켜보지 않는다.
// 일부러 끝낸 것은 따로 돌려줘 기록하게 한다. 다음 대기가 같은 dispatch 를 다시 조회하지 않게 하기 위해서다.
function unhandledLost(runId: string, rows: Json[], ignore: Set<unknown>): { found: Lost[]; deliberate: Record<string, string> } {
  const candidates = lostWorkers(rows, new Set(rows.map((w) => w.dispatchId))).filter(([d]) => !ignore.has(d))
  if (candidates.length === 0) return { found: [], deliberate: {} }
  const tasks = orcaResult(['task-list', '--run', runId])?.tasks
  if (!Array.isArray(tasks)) return { found: [], deliberate: {} }
  const byTask = new Map(tasks.map(obj).map((t) => [t.id, t]))
  const taskOf = new Map(rows.map((w) => [w.dispatchId, w.taskId]))
  const found: Lost[] = []
  const deliberate: Record<string, string> = {}
  const latestOf = new Map<unknown, Json>()
  for (const [dispatch, stage] of candidates) {
    const taskId = taskOf.get(dispatch)
    const task = byTask.get(taskId)
    if (!task || taskClosed(task)) continue
    if (!latestOf.has(taskId)) latestOf.set(taskId, latestDispatch(taskId))
    const latest = latestOf.get(taskId) ?? {}
    if (latest.id !== dispatch) continue
    const reason = deliberateEnd(latest)
    if (reason) deliberate[dispatch] = reason
    else found.push([dispatch, stage])
  }
  return { found, deliberate }
}

// 대기하는 동안 끊긴 것 가운데 일부러 끝낸 것을 빼고, 그것은 watched 에서도 지운다
function dropDeliberate(rows: Json[], lost: Lost[], watched: Set<unknown>): Lost[] {
  const taskOf = new Map(rows.map((w) => [w.dispatchId, w.taskId]))
  const kept: Lost[] = []
  for (const [dispatch, stage] of lost) {
    const taskId = taskOf.get(dispatch)
    const latest = taskId ? latestDispatch(taskId) : {}
    if (latest.id === dispatch && deliberateEnd(latest)) {
      watched.delete(dispatch)
      continue
    }
    kept.push([dispatch, stage])
  }
  return kept
}

// 상주 루프 ------------------------------------------------------------------

type LoopWake = { code: 7 | 8; lines: string[]; cursor: { repo: string; seq: number; run: string | null } | null }

function oneLine(value: string): string {
  return value.replace(/\r?\n|\r/g, ' ')
}

// 죽음을 다시 볼 저장소와 그 시각(epoch ms). 머리 주석의 「상주 루프」
const recheckAt = new Map<string, number>()

// --run 의 대기가 옛 파일을 읽을지. runs 가 없고 run 이 이 Run 이거나 빈 루프의 것만 읽는다(머리 주석의 「상주 루프」)
function legacyFileOf(repo: string, run: string): boolean {
  const state = readLoop(repo)
  return state === null || (!Array.isArray(state.runs) && (!state.run || state.run === run))
}

// 깨어날 일이 있는 첫 저장소의 줄과 종료 코드. 없으면 null 이다. 머리 주석의 「상주 루프」
function loopWake(repos: string[], run: string | null): LoopWake | null {
  for (const repo of repos) {
    // 이 Run 의 알림 파일과 Run 이 없는 루프의 옛 파일. 머리 주석의 「상주 루프」
    for (const source of run ? (legacyFileOf(repo, run) ? [run, null] : [run]) : [null]) {
      let found: ReturnType<typeof readEvents> | null = null
      try {
        found = readEvents(repo, source)
      } catch (e) {
        watchError(`루프 알림을 읽지 못했다: ${repo}: ${(e as Error).message}`)
      }
      if (found && found.events.length > 0) {
        const lines = found.gap ? [`LOOP-EVENT GAP - seq ${found.gap[0]}..${found.gap[1]} 를 잃었다`] : []
        for (const event of found.events) lines.push(`LOOP-EVENT ${oneLine(String(event.kind))} ${event.pr ?? '-'} ${oneLine(String(event.text))}`)
        return { code: 7, lines, cursor: { repo, seq: found.events.reduce((max, event) => Math.max(max, event.seq), 0), run: source } }
      }
    }
    const now = Date.now()
    const status = loopStatus(repo, now)
    if (status.alive) {
      recheckAt.delete(repo)
      if (run && Array.isArray(status.state.runs) && !isRegistered(repo, run)) {
        return { code: 8, lines: [`LOOP-DEAD ${repo} run ${run} 미등록`], cursor: null }
      }
      continue
    }
    if (status.recheck) {
      const at = recheckAt.get(repo)
      if (at === undefined) recheckAt.set(repo, now + recheckMs())
      if (at === undefined || now < at) continue
    }
    return { code: 8, lines: [`LOOP-DEAD ${repo} ${status.reason}`], cursor: null }
  }
  return null
}

// 다음 확인까지의 ms. 간격 확인이 없고 다시 볼 루프도 없으면 null 이다
function nextLook(interval: number, periodic: boolean): number | null {
  const every = periodic && interval > 0 ? interval * 1000 : null
  if (recheckAt.size === 0) return every
  const due = Math.max(0, Math.min(...recheckAt.values()) - Date.now())
  return every === null ? due : Math.min(every, due)
}

// 루프의 줄을 내고 커서를 옮긴다. LAST_DELIVERY 줄은 부르는 쪽이 check --wait 그룹을 끝낸 뒤 낸다
function deliverLoop(wake: LoopWake): void {
  for (const line of wake.lines) out(line)
  if (!wake.cursor) return
  try {
    writeCursor(wake.cursor.repo, wake.cursor.seq, wake.cursor.run)
  } catch (e) {
    watchError(`루프 알림 커서를 쓰지 못했다: ${wake.cursor.repo}: ${(e as Error).message}`)
  }
}

type Checked = { kind: 'lost'; lost: Lost[]; rows: Json[] } | { kind: 'loop'; code: 7 | 8 } | { kind: 'done'; data: unknown; raw: string }

// 도는 check --wait 자식. 신호를 받으면 그 그룹을 끝낸다
let waiting: ChildProcess | null = null

function stopGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // 이미 끝났다
  }
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (waiting) stopGroup(waiting, 'SIGTERM')
    err(`wait-important: ${signal} 를 받아 check --wait 를 끝내고 나간다`)
    process.exit(signalCode(signal))
  })
}

// `check --wait --json` 한 번. 결과 JSON 과 원문을 낸다. JSON 이 아니면 data 가 null 이다.
// watched 가 있으면 interval 초마다 worker 상태를 보고, 끊긴 worker 가 있으면 check 를 멈추고 lost 를 낸다.
// loopRepos 가 있으면 같은 간격에 그 뒤로 상주 루프를 보고, 깨어날 일이 있으면 줄을 낸 뒤 check 를 멈추고 loop 를 낸다.
// lib/proc 의 runAsync 는 도는 자식을 도중에 끝낼 수 없어 직접 띄운다. 끝내지 못하고 나가면 그 check 가 대기 자리를 쥔 채 남는다.
// --timeout-ms 를 orca 에 넘기므로 orca 가 그 시간에 끝낸다(옛 명령과 같다). 그래도 끝나지 않으면 CHECK_GRACE_MS 뒤에 끝낸다.
function check(
  runId: string,
  types: string,
  ack: string | null,
  timeoutMs: number,
  watched: Set<unknown>,
  interval: number,
  loopRepos: string[],
): Promise<Checked> {
  const args = ['orchestration', 'check', '--run', runId, ...(ack ? ['--ack', ack] : []), '--wait', '--types', types, '--timeout-ms', String(timeoutMs), '--json']
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let timer: NodeJS.Timeout | undefined
    let stopped = false
    // keepalive 줄은 stderr 로 나온다. stdout 만 읽는다. 자기 그룹으로 띄워 끊을 때 orca 의 자식까지 함께 끝낸다
    const child = spawn(orcaBin(), args, { stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    waiting = child
    const settle = (value: Checked) => {
      clearTimeout(timer)
      clearTimeout(guard)
      waiting = null
      stopped = true
      resolve(value)
    }
    const guard = setTimeout(() => {
      if (stopped) return
      stopGroup(child, 'SIGKILL')
      settle({ kind: 'done', data: null, raw: `wait-important: check --wait 가 ${timeoutMs + CHECK_GRACE_MS}ms 안에 끝나지 않아 끝냈다` })
    }, timeoutMs + CHECK_GRACE_MS)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', (e: Error) => {
      if (!stopped) settle({ kind: 'done', data: null, raw: `wait-important: orca 를 실행하지 못했다: ${e.message}` })
    })
    child.on('close', () => {
      if (stopped) return
      const raw = Buffer.concat(chunks).toString('utf8')
      let data: unknown = null
      try {
        data = JSON.parse(raw)
      } catch {
        data = null
      }
      settle({ kind: 'done', data, raw })
    })
    const watchWorkers = watched.size > 0
    const periodic = watchWorkers || loopRepos.length > 0
    // 간격이 0 이면 worker 는 시작할 때만 본다. 다시 볼 루프가 있으면 그 시각에 루프만 본다
    const schedule = () => {
      const delay = nextLook(interval, periodic)
      if (delay !== null) timer = setTimeout(look, delay)
    }
    const look = () => {
      if (stopped) return
      if (watchWorkers && interval > 0) {
        const rows = workerRows(runId)
        let lost = rows && rows.length ? lostWorkers(rows, watched) : []
        lost = lost.length && rows ? dropDeliberate(rows, lost, watched) : []
        if (lost.length && rows) {
          stopGroup(child, 'SIGKILL')
          settle({ kind: 'lost', lost, rows })
          return
        }
      }
      const wake = loopWake(loopRepos, runId)
      if (wake) {
        deliverLoop(wake)
        stopGroup(child, 'SIGKILL')
        settle({ kind: 'loop', code: wake.code })
        return
      }
      schedule()
    }
    schedule()
  })
}

function isWaiterExists(data: unknown): boolean {
  const error = obj(data).error
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return false
  const e = error as Json
  return e.code === 'waiter_exists' || String(e.message ?? '').includes('active actionable waiter')
}

type Proc = [number, number, string, string]

// 같은 사용자의 프로세스 전체. 대기의 조상인 일반 셸도 포함한다.
function userProcesses(): Proc[] {
  const done = run([process.env.PS || 'ps', '-U', String(process.getuid?.() ?? ''), '-o', 'pid=,ppid=,lstart=,command='], { env: { LC_ALL: 'C' } })
  const rows: Proc[] = []
  for (const line of done.stdout.split('\n')) {
    // lstart 는 「Tue Oct 20 10:00:00 2026」 처럼 다섯 낱말이다
    const m = /^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S.*)$/.exec(line.trimStart())
    if (m) rows.push([Number(m[1]), Number(m[2]), m[3].split(/\s+/).join(' '), m[4]])
  }
  return rows
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 같은 사용자의 프로세스 가운데 이 Run 을 기다리는 것
function waiterProcesses(runId: string, rows: Proc[]): Proc[] {
  // 이 명령과 이것을 띄운 셸은 명령에 Run id 가 들어 있어도 남은 대기가 아니다
  const parent = new Map(rows.map(([pid, ppid]) => [pid, ppid]))
  const mine = new Set<number>()
  let pid = process.pid
  while (pid > 1 && !mine.has(pid)) {
    mine.add(pid)
    pid = parent.get(pid) ?? 0
  }
  const word = new RegExp(`(?<![\\w-])${escapeRegExp(runId)}(?![\\w-])`)
  return rows.filter(([pid, , , command]) => {
    if (mine.has(pid) || !word.test(command)) return false
    const waiting = command.includes('orchestration check') && command.includes('--wait')
    return waiting || command.includes('wait-important')
  })
}

// 부모가 init 인 대기와, 그 밑에 딸린 대기(셸 밑의 명령, 명령 밑의 check)
function stalePids(procs: Proc[], all: Proc[]): Set<number> {
  const waiters = new Set(procs.map(([pid]) => pid))
  // 앱도 init 의 자식이다. 일반 셸과 해당 Run 의 대기만 따라가 앱의 살아 있는 세션은 보존한다
  const parent = new Map<number, number>()
  for (const [pid, ppid, , command] of all) {
    if (waiters.has(pid) || SHELLS.has(basename(command.split(/\s+/)[0]).replace(/^-+/, ''))) parent.set(pid, ppid)
  }
  const stale = new Set([...parent].filter(([, ppid]) => ppid === 1).map(([pid]) => pid))
  for (let grew = true; grew; ) {
    grew = false
    for (const [pid, ppid] of parent) {
      if (stale.has(ppid) && !stale.has(pid)) {
        stale.add(pid)
        grew = true
      }
    }
  }
  return new Set([...stale].filter((pid) => waiters.has(pid)))
}

function reportWaiters(runId: string, killStale: boolean): void {
  const rows = userProcesses()
  const procs = waiterProcesses(runId, rows)
  err(`wait-important: Run ${runId} 에 이미 다른 대기가 있다(waiter_exists). 다시 걸어도 같은 오류만 받는다`)
  if (procs.length === 0) {
    err('  같은 사용자의 프로세스에서 찾지 못했다. 다른 사용자나 다른 머신의 대기일 수 있다')
    return
  }
  const staleSet = stalePids(procs, rows)
  for (const [pid, ppid, started, command] of procs) {
    const kind = staleSet.has(pid) ? '고아' : `부모 ${ppid} 살아 있음`
    err(`  PID ${pid}  ${kind}  시작 ${started}  ${command}`)
  }
  const live = procs.filter(([pid]) => !staleSet.has(pid)).map(([pid]) => pid)
  const stale = procs.filter(([pid]) => staleSet.has(pid)).map(([pid]) => pid)
  if (stale.length && killStale) {
    for (const pid of stale) {
      try {
        process.kill(pid, 'SIGTERM')
        err(`  PID ${pid} 를 종료했다`)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') err(`  PID ${pid} 를 종료하지 못했다: ${(e as Error).message}`)
      }
    }
  } else if (stale.length) {
    err(`  고아 대기는 받을 쪽이 없다. --kill-stale 을 더해 다시 걸거나 kill ${stale.join(' ')}`)
  }
  if (live.length) err('  부모가 살아 있는 대기는 다른 세션이 기다리는 중일 수 있다. 그 세션을 확인한 뒤 직접 종료한다')
}

class Usage extends Error {}

function integer(name: string, value: string): number {
  if (!/^\s*[+-]?\d+\s*$/.test(value)) throw new Usage(`${name} 는 정수여야 한다: ${value}`)
  return Number(value)
}

function float(name: string, value: string): number {
  const number = value.trim() === '' ? Number.NaN : Number(value)
  if (Number.isNaN(number)) throw new Usage(`${name} 는 수여야 한다: ${value}`)
  return number
}

// 이벤트 ------------------------------------------------------------------

// 이벤트의 공통 값. 핸들러가 없으면 쓰지 않으므로 처음 낼 때 한 번만 구한다
let eventContext: FireContext | null = null

function contextFor(runId: string): FireContext {
  if (!eventContext) {
    const repo = mainCheckout(process.cwd())
    eventContext = { repo, base: defaultBase(repo) ?? '', run: runId }
  }
  return eventContext
}

// 알림 이벤트다. 핸들러의 실패와 이벤트 실행기의 오류(설정 파일 오류 포함)는 종료 코드를 바꾸지 않는다.
// 대기의 종료 코드와 마지막 LAST_DELIVERY 줄은 코디네이터의 다음 동작을 고르는 계약이라, 여기서 던지면 그 줄 없이 끝난다
async function notify(event: string, input: Json, runId: string): Promise<void> {
  try {
    await fire(event, input, contextFor(runId))
  } catch (e) {
    err(`wait-important: ${event} 를 내지 못했다: ${(e as Error)?.message ?? String(e)}`)
  }
}

// 핸들러가 있는지(lib/events.ts 의 handlerFile). 없으면 fire 가 입력을 쓰지 않으므로 gh 조회를 건너뛴다.
// worker_done 마다 GitHub 를 부르지 않게 한다
function hasHandler(event: string, runId: string): boolean {
  return handlerFile(event, contextFor(runId).repo) !== null
}

// gh 로 준비 상태의 PR 을 읽어 이벤트의 pr 필드로 옮긴다. 읽지 못하면 null
function prOf(number: unknown, repo: string): Json | null {
  if (typeof number !== 'number') return null
  const got = ghJson<unknown>(['pr', 'view', String(number), '--json', 'number,title,headRefName,headRefOid,author,isDraft,url'], { cwd: repo })
  if (!got.ok || typeof got.data !== 'object' || got.data === null) return null
  const pr = got.data as Json
  return {
    number: pr.number ?? null,
    title: pr.title ?? null,
    branch: pr.headRefName ?? null,
    head: pr.headRefOid ?? null,
    author: obj(pr.author).login ?? null,
    draft: pr.isDraft ?? null,
    url: pr.url ?? null,
  }
}

async function workerDone(messages: Json[], runId: string): Promise<void> {
  if (!hasHandler('worker-done', runId)) return
  for (const message of messages) {
    if (message.type !== 'worker_done' && message.originalType !== 'worker_done') continue
    const verified = obj(message.completionVerification)
    if (verified.status !== 'ready' && verified.status !== 'suspicious') continue
    const [task, dispatch] = context(message)
    const ready = verified.status === 'ready'
    await notify(
      'worker-done',
      {
        worker: { task, dispatch, terminal: message.from_handle || message.fromHandle || null, worktree: null, spec: null },
        outcome: message.outcome || payload(message).outcome || null,
        evidence: ready ? 'ready' : 'suspicious',
        pr: ready ? prOf(verified.pr, contextFor(runId).repo) : null,
      },
      runId,
    )
  }
}

async function reportLost(lost: Lost[], rows: Json[], ack: string | null, state: string, runId: string, repo: string): Promise<number> {
  for (const [dispatch, stage] of lost) out(`WORKER_LOST ${dispatch} stage=${text(stage)}`)
  const rowOf = new Map(rows.map((w) => [w.dispatchId, w]))
  for (const [dispatch, stage] of lost) {
    const row = rowOf.get(dispatch) ?? {}
    await notify(
      'worker-lost',
      {
        worker: { task: row.taskId ?? null, dispatch, terminal: row.agentTerminalHandle ?? null, worktree: null, spec: null },
        stage: stage ?? null,
      },
      runId,
    )
  }
  out(`LAST_DELIVERY ${ack || '-'}`)
  saveReported(state, runId, Object.fromEntries(lost.map(([d]) => [d, 'lost'])), repo)
  return 5
}

// 본체 ------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  let values
  let timeoutMs: number
  let interval: number
  try {
    const options = {
      run: { type: 'string' },
      ack: { type: 'string' },
      types: { type: 'string', default: DEFAULT_TYPES },
      'timeout-ms': { type: 'string', default: '7000000' },
      'kill-stale': { type: 'boolean', default: false },
      'lost-interval-sec': { type: 'string', default: '60' },
      'ignore-lost': { type: 'string', multiple: true, default: [] },
      'lost-state': { type: 'string' },
      'ack-lost': { type: 'string', multiple: true, default: [] },
      'completion-contract': { type: 'string', default: 'ready' },
      'loop-repo': { type: 'string', multiple: true, default: [] },
      help: { type: 'boolean', short: 'h' },
    } as const
    values = parseArgs({ args: expandArgs(argv, options), options }).values
    if (values.help) {
      out(USAGE)
      return 0
    }
    if (values.run === undefined) throw new Usage('--run 이 필요하다')
    if (values['completion-contract'] !== 'ready' && values['completion-contract'] !== 'none') {
      throw new Usage(`--completion-contract 는 ready 나 none 이다: ${values['completion-contract']}`)
    }
    timeoutMs = integer('--timeout-ms', values['timeout-ms'] as string)
    interval = float('--lost-interval-sec', values['lost-interval-sec'] as string)
  } catch (e) {
    err(`${USAGE}\nwait-important: ${(e as Error).message}`)
    return 2
  }
  const runId = values.run as string
  const types = values.types as string
  const wanted = new Set(types.split(',').map((t) => t.trim()).filter(Boolean))
  if (wanted.size === 0 || timeoutMs <= 0 || interval < 0) {
    err('wait-important: --types 와 --timeout-ms 는 비어 있거나 0 일 수 없고 --lost-interval-sec 는 음수일 수 없다')
    return 2
  }
  const cwd = process.cwd()
  if (!values['lost-state']) warnLegacy(cwd, 'wait-important')
  const state = values['lost-state'] || join(pathOf('state', cwd), 'wait-important-lost.json')
  const ignoreLost = values['ignore-lost'] as string[]
  const ackLost = values['ack-lost'] as string[]
  if (ackLost.length) {
    if (!saveReported(state, runId, Object.fromEntries(ackLost.map((d) => [d, 'handled'])), cwd)) return 1
    out(`ACK_LOST ${ackLost.join(' ')}`)
    return 0
  }
  // 대기를 시작할 때 살아 있던 dispatch 와 처리하지 않은 끊긴 dispatch 를 지켜본다. 읽지 못하면 지켜보지 않는다
  let watched = new Set<unknown>()
  if (interval > 0) {
    const rows = workerRows(runId) ?? []
    const judged = loadReported(state, runId)
    const ignore = new Set<unknown>([...ignoreLost, ...Object.keys(judged)])
    // 앞 대기가 알렸는데 아직 끊긴 채인 dispatch 는 깨우지 않고 stderr 로만 남긴다
    const reported = new Set<unknown>(Object.entries(judged).filter(([, v]) => String(v).startsWith('lost')).map(([d]) => d))
    const still = lostWorkers(rows, reported)
      .map(([d]) => d)
      .filter((d) => !ignoreLost.includes(d))
      .sort()
    if (still.length) err(`wait-important: 앞 대기가 알린 끊긴 dispatch ${still.length}개가 아직 처리되지 않았다: ${still.join(' ')}`)
    // 이미 끊겨 있는데 처리하지 않은 dispatch 가 있으면 기다리지 않고 알린다
    const { found, deliberate } = unhandledLost(runId, rows, ignore)
    saveReported(state, runId, deliberate, cwd)
    if (found.length) return reportLost(found, rows, values.ack ?? null, state, runId, cwd)
    watched = new Set([...liveDispatches(rows)].filter((d) => !ignore.has(d)))
  }
  const loopRepos = (values['loop-repo'] as string[]).map((repo) => mainCheckout(resolve(repo)))
  const woke = loopWake(loopRepos, runId)
  if (woke) {
    deliverLoop(woke)
    out(`LAST_DELIVERY ${values.ack || '-'}`)
    return woke.code
  }

  const deadline = performance.now() + timeoutMs
  let ack: string | null = values.ack ?? null
  let skipped = 0
  for (;;) {
    const remaining = Math.trunc(deadline - performance.now())
    if (remaining <= 0) {
      out(`TIMEOUT LAST_DELIVERY ${ack || '-'}`)
      return 3
    }
    const checked = await check(runId, types, ack, remaining, watched, interval, loopRepos)
    if (checked.kind === 'lost') return reportLost(checked.lost, checked.rows, ack, state, runId, cwd)
    if (checked.kind === 'loop') {
      out(`LAST_DELIVERY ${ack || '-'}`)
      return checked.code
    }
    const data = checked.data
    if (typeof data !== 'object' || data === null || Array.isArray(data) || !(data as Json).ok) {
      out(checked.raw.trim() || 'wait-important: orca 출력이 JSON 이 아니다')
      if (isWaiterExists(data)) {
        out(`LAST_DELIVERY ${ack || '-'}`)
        reportWaiters(runId, values['kill-stale'] as boolean)
        return 4
      }
      const detail = (checked.raw.trim().split(/\r?\n|\r/).pop() ?? '').slice(0, 500)
      watchError(`check --wait 가 실패했다: ${detail || 'orca 출력이 JSON 이 아니다'}`)
      out(`LAST_DELIVERY ${ack || '-'}`)
      return 1
    }
    const result = obj((data as Json).result)
    // --ack 를 넘긴 호출이 성공했으면 그 delivery 는 처리됐다
    ack = null
    const messages = (Array.isArray(result.messages) ? result.messages : []).map(obj)
    const delivery = result.deliveryId
    if (messages.some((m) => wanted.has(String(m.type)))) {
      let suspicious = false
      if (values['completion-contract'] === 'ready' && messages.some((m) => m.type === 'worker_done')) {
        // 이미 ack 한 준비 상태도 읽는다. --all 은 delivery 를 소비하거나 ack 하지 않는다
        const history = orcaResult(['check', '--run', runId, '--all'], HISTORY_TIMEOUT_MS)
        const earlier = history && Array.isArray(history.messages) ? history.messages.map(obj) : []
        const classified = classify(messages, earlier)
        ;(data as Json).result = { ...result, messages: classified }
        suspicious = classified.some((m) => m.type === 'suspicious_worker_done')
        await workerDone(classified, runId)
      }
      out(pyJson(data))
      if (suspicious) out('의심스러운 worker_done: 앞선 PR 준비 상태를 확인하지 못했다. 완료 검증 전에 해제하지 않는다')
      out(`LAST_DELIVERY ${delivery || '-'}`)
      return suspicious ? 6 : 0
    }
    if (messages.length) {
      skipped += messages.length
      err(`heartbeat 같은 메시지 ${skipped} 개를 ack 하고 계속 기다린다`)
    }
    // heartbeat 만 든 묶음은 다음 호출에서 ack 한다. 시간 한도로 끝난 호출은 delivery 가 없다
    ack = delivery ? String(delivery) : null
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    err(`wait-important: ${(e as Error)?.stack ?? String(e)}`)
    process.exitCode = 1
  },
)
