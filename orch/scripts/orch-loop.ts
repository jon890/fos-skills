// 저장소마다 하나 도는 상주 루프다. 틱마다 질문 확인, 정리(원격 브랜치 포함), 보드 동기화, CI 감시와 알림, tick 이벤트, 충돌 PR 처리를 한다.
// 코디네이터를 깨워야 하는 일은 알림 파일(state/loop-events.jsonl)에 적고, 코디네이터의 wait-important --loop-repo 가 그 파일로 깨어난다.
// 루프는 상태로만 판정한다. 루프가 없던 동안 생긴 일은 다음 틱이 다시 보므로, 죽으면 다시 띄우기만 하면 된다.
// 상태 파일의 읽기, 생존 판정, 알림 파일과 커서는 lib/loop.ts 가 소유한다. 형식은 docs/data-schema.md 「orch 루트에 더하는 파일」 이다.
//
// 사용법:
//     orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] (--start | --stop | --status | --foreground) [--once]
//     orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] --tick --tick-number N      (내부용. 부모가 띄운다)
//
//     --repo         대상 저장소. 주 checkout 으로 바꿔 쓴다
//     --run          질문을 확인하고 정리에 넘길 Run. 없으면 config.json 의 finish.run 이다
//     --specs-dir    정리에 넘길 지시서 폴더. 없으면 finish.specs_dir 이고, 둘 다 없으면 넘기지 않는다
//     --start        살아 있는 루프가 없으면 자기 자신을 --foreground 로 분리해(detached, stdio ignore) 띄우고, 자식이 loop.json 에
//                    자기 pid 를 쓸 때까지 10초까지 기다린다. 하네스의 백그라운드 명령이 아니라 시간 한도에 묶이지 않는다
//                    LOOP-STARTED <pid> run=<Run id 또는 -> 와 0. 10초 안에 쓰지 않으면 자식을 끝내고 LOOP-START-FAIL <이유> 와 1.
//                    살아 있는 루프가 있으면 요청한 Run 과 같든 다르든 띄우지 않고 LOOP-RUNNING <pid> run=<기존 Run id 또는 -> 와 4.
//                    Run 이 다르면 --stop 뒤 다시 --start 한다
//     --stop         loop.json 의 pid 에 TERM 을 보내고 20초까지 끝나기를 기다린다. LOOP-STOPPED <pid> 와 0,
//                    루프가 없으면 LOOP-NOT-RUNNING 과 0, 20초 뒤에도 살아 있으면 LOOP-STOP-TIMEOUT <pid> 와 1.
//                    pid 가 살아 있어도 그 명령줄에 orch-loop 가 없으면 루프가 아니다. 죽은 루프의 pid 를 다른 프로세스가 다시 받았을 수 있다
//     --status       LOOP-ALIVE <pid> run=<…> last_tick=<…> alive_at=<…> 와 0, LOOP-DEAD <repo> <이유> 와 1. 판정은 lib/loop.ts 의 loopStatus
//     --foreground   지금 프로세스에서 틱을 돈다. --start 의 자식과 테스트가 쓴다. 신호를 받으면 진행 중인 자식을 끝내고 128 + 신호 번호
//     --once         --foreground 와 함께 틱 한 번만 돌고 0 으로 끝난다
//     --tick, --tick-number N
//                    틱 하나를 돌고 끝난다. --foreground 의 부모가 틱마다 띄운다. N 은 1 부터다.
//                    stdout 마지막 줄에 {"tick_at": <ISO 8601 UTC>, "errors": {<출처>: <이유 또는 null>}, "open_prs": <번호 목록 또는 null>,
//                    "ci": {<PR 번호>: {"head": <SHA>, "state": <passed, failed, pending>}}} 을 내고 0. 열린 PR 을 읽지 못한 틱은 ci 가 없다
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts)
//
// 한 저장소에 하나: --foreground 는 시작할 때 state/loop.lock 을 wx 로 만들어 자기 pid 를 적고, 끝날 때 자기 pid 가 든 잠금만 지운다.
//     죽은 pid 의 잠금은 lib/events.ts 의 reclaim 으로 회수한다. 살아 있는 pid 가 쥐고 있으면 LOOP-RUNNING 과 4 다.
//     --start 는 loopStatus 와 이 잠금을 함께 본다.
//
// 틱: 부모는 틱 자식 하나가 끝나면 pipeline.tick_sec 을 기다린 뒤 다음 틱 자식을 띄운다. 겹치지 않는다.
//     틱을 자식 프로세스로 떼어 낸 것은 lib 의 조회(질문 조회, gh)가 동기라, 같은 프로세스에서 돌면 그동안 생존 타이머가 돌지 못해서다.
//     틱 자식이 하는 일(순서대로, 하나가 실패해도 다음을 한다):
//     1. 질문 확인. Run id 가 있을 때만. lib/questions.ts 의 poll(재알림 600초, watch-questions 의 기본과 같다)을 부르고
//        알릴 줄마다 QUESTION 이나 REMINDER 줄을 로그에 쓰고 worker-question 을 낸다. REMINDER 는 알림 파일에도 쓴다.
//        새 질문(QUESTION)은 알림 파일에 쓰지 않는다. 코디네이터의 wait-important 가 question 메시지로 이미 깨어난다
//     2. 정리. cleanup-sweep --repo <repo> --kill-holders --remote-branches --apply [--run <run>] [--specs-dir <dir>]
//     3. 보드 동기화. 보드 파일(lib/paths.ts 의 boardPath)이 없으면 건너뛴다. 있으면 board-sync --repo <repo>
//     4. CI 감시. 아래 「CI 감시」
//     5. tick 이벤트. 입력은 tick(틱 번호)과 open_prs(내 열린 PR 번호 목록. 읽지 못하면 null)다(lib/events.ts 머리 주석의 「이벤트별 필드」).
//     6. 충돌 처리. 아래 「충돌 처리」. 끝난 dispatch 에 이어 쓰면 65분까지 걸려 마지막에 둔다. 밀리는 것은 다음 틱뿐이다
//     열린 PR 은 틱마다 gh pr list 한 번으로 읽어 4, 5, 6 이 함께 쓴다. 내 PR 은 lib/gh.ts 의 ownAuthors 와 isOwnPr 로 가린다
//     틱 자식은 loop.json 을 읽기만 한다(이전 errors 와 ci 를 보려고). 부모가 결과 줄을 합쳐 last_tick(결과의 tick_at), ticks, errors,
//     ci(결과에 있을 때만 통째로 바꾼다)를 쓴다.
//     결과 줄 앞의 출력과 stderr 는 부모가 로그로 옮긴다. 틱 자식이 0 이 아니거나 결과 줄 없이 끝나면 last_tick 은 그대로 두고
//     errors.tick 에 그 이유(`종료 코드 <n>`, `결과 줄 없음`)를 둔다.
//
// CI 감시: 내 열린 PR 가운데 draft 가 아닌 것마다 필수 체크 상태를 정한다. 다른 사람의 PR 과 draft 는 보지 않는다.
//     필수 체크 이름은 lib/gh.ts 의 requiredNames(queue.required, 없으면 base 의 저장소 규칙. 같은 base 의 규칙은 틱마다 한 번 읽는다),
//     상태는 ciState(queue.skipped_is_missing 을 따른다)다. 머지 큐의 기본 판정(--allow-fail 없음)과 같다. 필수가 아닌 체크의 실패도
//     failed 이고, passed 는 실패가 없고 필수 체크가 모두 나타났고 롤업의 체크가 모두 끝난 때다. 필수 체크 목록이 비면 나타난 체크 전부로
//     판정한다. 루프는 --allow-fail 을 모른다. 머지 큐에 --allow-fail 을 주는 저장소에서는 루프가 실패로 알린 PR 도 큐는 머지할 수 있다.
//     loop.json 의 ci[<PR>] 와 HEAD 와 상태가 같으면 넘어간다. 다르면 새 값을 결과의 ci 에 담고, passed 로 바뀌었으면 ci-passed 를,
//     failed 로 바뀌었으면 그 PR 의 worker 에게 보내고 알림 파일에 CI-FAILED 를 쓴 뒤 ci-failed 를 낸다(입력은 lib/events.ts 머리 주석의
//     「이벤트별 필드」). 같은 HEAD 에서 다시 돌린 체크가 통과로 바뀌면 ci-passed 를 낸다. 새 HEAD 는 새로 판정한다.
//     결과의 ci 는 이번 틱에 본 내 열린 PR 의 값이라 닫힌 PR 의 항목은 빠진다. draft 와 규칙을 읽지 못한 base 의 PR 처럼 이번 틱에
//     판정하지 않은 PR 은 이전 값을 그대로 옮긴다. 지우면 다음 틱에 같은 HEAD 의 실패를 다시 알린다.
//     규칙을 읽지 못한 base 는 errors.ci 로 `WATCH-ERROR ci: …` 를 쓴다(아래 「오류 줄 억제」).
//     worker 에게 보내기: Run id 가 있고, 그 PR 브랜치의 워크트리(lib/workers.ts 의 worktreePaths)에 살아 있는 dispatch(workerFor,
//     LIVE_DISPATCH)가 있을 때만 send-to-worker --dispatch <id> --body <본문> --run <run> 으로 보낸다. 끝난 dispatch 에 후속 지시서로
//     이어 쓰지 않는다. 그때는 CI-FAILED 로 코디네이터가 판단한다. CI-FAILED 의 text 는 `<실패한 체크 이름>: <worker 결과>` 이고 worker 결과는
//     `보냈다 <dispatch>`, `깨우지 못했다(종료 코드 4)`, `보내지 못했다(종료 코드 <n>)`, `살아 있는 dispatch 없음`, `Run id 없음`,
//     `worker 목록을 읽지 못했다` 가운데 하나다.
//
// 충돌 처리: 내 열린 PR 의 base 충돌을 그 PR 을 만든 기존 worker 에게 풀게 한다. notify-conflicts 와 같은 함수, 같은 기록
//     (state/notify-conflicts.json), 같은 send-to-worker 종료 코드 분류(notify-conflicts.ts 머리 주석의 표)를 쓴다(lib/conflicts.ts).
//     그래서 머지 큐 뒤의 notify-conflicts 와 틱이 같은 (PR, base SHA) 를 두 번 보내지 않는다. 새 worker 는 띄우지 않는다.
//     내 열린 PR 이 없으면 git fetch 없이 끝낸다. 열린 PR 을 읽지 못한 틱은 건너뛴다.
//     1. lib/conflicts.ts 의 findConflicts(base 는 origin/HEAD 가 가리키는 브랜치, 없으면 main). 실패하면 `WATCH-ERROR conflicts: …`
//     2. 내 PR 만 남긴다. 작성자를 정하지 못하면 `WATCH-ERROR conflicts: …` 를 쓰고 그 틱의 충돌 처리를 끝낸다
//     3. 기록에 있는 (PR, base SHA) 는 넘어간다. 아니면 브랜치의 워크트리와 worker 행(lib/workers.ts)을 찾아 resolveConflict 와
//        concludeConflict 를 부른다. 워크트리나 dispatch 가 없으면 orphan 이다. worker-list 를 읽지 못하면 그 PR 은 기록하지 않고
//        `WATCH-ERROR conflicts: worker 목록을 읽지 못했다: …` 를 쓴다
//     4. orphan 이면 알림 파일에 CONFLICT-ORPHAN(pr 은 PR 번호, text 는 이유)을 쓴다
//     5. send-to-worker 가 2(사용법 오류)로 끝나면 그 틱의 충돌 처리를 멈추고 `WATCH-ERROR conflicts: send-to-worker 사용법 오류` 를 쓴다.
//        notify-conflicts 는 2 로 끝나지만 루프는 끝내지 않는다. 끝내면 질문 확인도 멈춘다
//     resolveConflict 의 줄(`<dispatch> 에 알렸다` 따위)은 로그에 쓴다. send-to-worker 를 틱 자식 안에서 기다리는 동안에도
//     부모의 생존 타이머가 alive_at 을 쓴다.
//
// 생존 타이머: 부모가 틱과 따로 ORCH_LOOP_ALIVE_SEC(양수 초, 기본 30)마다 loop.json 의 alive_at 을 쓴다. 시작할 때도 한 번 쓴다.
//     그래서 긴 틱(정리의 대기, 끝난 dispatch 이어 쓰기)도 죽은 것으로 보이지 않는다.
//
// loop.json: pid, run, repo, tick_sec, started_at, alive_at, last_tick, ticks, errors, ci. 시각은 ISO 8601 UTC 다. 부모만 쓴다.
//     시작할 때 앞 loop.json 의 errors 와 ci 를 이어받는다. 다시 띄운 루프가 같은 실패를 다시 알리지 않게 한다.
//
// 오류 줄 억제: errors 는 출처마다 마지막 오류 이유다. 출처는 questions(질문 조회), cleanup(정리 명령이 0 이 아닌 종료),
//     board(보드 동기화가 0 이 아닌 종료), prs(열린 PR 조회), ci(필수 체크 규칙 조회), hook(tick 핸들러), conflicts(충돌 처리),
//     tick(틱 자식이 0 이 아니거나 결과 줄 없이 끝남)이다.
//     tick 만 부모가 판정한다. 출처의 이유가 이전과 다를 때만 알림 파일에 쓴다. hook 은 `HOOK-FAIL tick <종료 코드, timeout, lock>`,
//     나머지는 `WATCH-ERROR <출처>: <이유>` 다. 알림 파일의 text 는 이 줄에서 kind 를 뺀 나머지(`tick 1`, `questions: offline`)다.
//     REMINDER 의 text 도 줄에서 `REMINDER ` 를 뺀 나머지다. 한 번 성공하면 이유를 지우고, 다시 실패하면 다시 쓴다. loop.log 에는 실패할 때마다 쓴다.
//     하네스는 백그라운드 명령의 stderr 를 알리지 않으므로 실패도 알림 파일로 보낸다. 틱마다 같은 실패로 코디네이터를 깨우지 않으려고 억제한다.
//     알림 파일의 HOOK-FAIL 은 tick 핸들러의 것만이다. worker-question 핸들러의 실패는 loop.log 의 HOOK-FAIL 줄로만 남는다.
//
// 로그: 모든 줄을 state/loop.log 에 붙이고 stdout 에도 쓴다. 붙이기 전에 1MB 를 넘으면 loop.log.1 로 돌린다.
//     --start 의 자식은 stdio 를 버린다. 파일 서술자를 자식에 넘기지 않는 것은 돌린 뒤에도 자식이 loop.log.1 에 쓰게 되기 때문이다.
//     틱 자식은 stdout 에만 쓴다. 부모가 그 줄을 loop.log 로 옮기므로 두 번 쓰이지 않는다.
//     잡지 않은 예외와 거부된 promise 는 스택을 로그에 남기고 1 로 끝난다.
//
// 설정: pipeline.tick_sec(양수, 기본 300), finish.run, finish.specs_dir, queue.required, queue.skipped_is_missing(true 나 false).
//     finish 절은 lib/finish-options.ts 의 FINISH_KEYS 로, queue 절은 lib/config.ts 의 QUEUE_KEYS 로 읽는다.
//     pipeline.enabled 는 읽지 않는다. 이 루프가 하는 일은 모두 그 값과 무관하게 돈다.
//
// 환경 변수: ORCA(orca 실행 파일), GH(gh 실행 파일), CLEANUP_SWEEP(정리 명령. 기본은 이 폴더의 cleanup-sweep.ts),
//     BOARD_SYNC(보드 동기화 명령. 기본은 이 폴더의 board-sync.ts), SEND_TO_WORKER(worker 에게 보내는 명령. CI 감시와 충돌 처리가
//     쓴다. 기본은 이 폴더의 send-to-worker.ts), ORCH_LOOP_ALIVE_SEC(생존 타이머 간격)
//
// 종료 코드:
//     0  성공. --start 가 띄웠다, --stop 이 멈췄거나 루프가 없다, --status 가 살아 있다, --once 와 --tick 이 끝났다
//     1  --start 실패, --stop 시간 초과, --status 가 죽었다, 잡지 않은 예외
//     2  사용법 오류와 설정 오류(ConfigError, ORCH_LOOP_ALIVE_SEC 가 양수가 아님)
//     4  살아 있는 루프가 있다(LOOP-RUNNING)
//     128 + 신호 번호  --foreground 나 --tick 이 신호를 받았다

import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { ConfigError, loadConfig, PIPELINE_KEYS, QUEUE_KEYS, section } from './lib/config.ts'
import { concludeConflict, findConflicts, loadNotified, notifiedFile, notifiedKey, resolveConflict, SEND_MS } from './lib/conflicts.ts'
import type { OpenPr, WorkerFound } from './lib/conflicts.ts'
import { fire, reclaim } from './lib/events.ts'
import { FINISH_KEYS } from './lib/finish-options.ts'
import { isFile } from './lib/fs.ts'
import { apiTarget, ciState, failedCheck, ghJson, isOwnPr, ownAuthors, requiredNames } from './lib/gh.ts'
import type { CiCheck, Names } from './lib/gh.ts'
import { defaultBase, mainCheckout } from './lib/git.ts'
import { appendEvent, lockFile, loopStatus, readLoop, writeLoop } from './lib/loop.ts'
import type { LoopState } from './lib/loop.ts'
import { boardPath, makeParent, pathOf } from './lib/paths.ts'
import { NO_LIMIT_MS, run as runSync, runAsync, scriptCommand, signalCode, stopChildren, stopping } from './lib/proc.ts'
import type { RunResult } from './lib/proc.ts'
import { alive } from './lib/process.ts'
import { notifyQuestion, poll } from './lib/questions.ts'
import { LIVE_DISPATCH, workerFor, workerRows, worktreePaths } from './lib/workers.ts'

const USAGE = [
  '사용법: orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] (--start | --stop | --status | --foreground) [--once]',
  '        orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] --tick --tick-number N',
].join('\n')
const SELF = fileURLToPath(import.meta.url)
const HERE = dirname(SELF)
const DEFAULT_TICK_SEC = 300
const DEFAULT_ALIVE_SEC = 30
const REMIND_AFTER_SEC = 600
const START_WAIT_MS = 10_000
const STOP_WAIT_MS = 20_000
const POLL_MS = 100
const LOG_LIMIT = 1_048_576
// finish-pr 이 정리 명령에 주는 시간 제한과 같다
const SWEEP_TIMEOUT_MS = 600_000
// wx 로 만든 직후 pid 를 쓰기 전의 빈 잠금을 깨진 잠금으로 회수하지 않게, 이 시간 안의 빈 파일은 쥔 것으로 본다(lib/events.ts 와 같다)
const EMPTY_LOCK_GRACE_MS = 2_000
const MODES = ['start', 'stop', 'status', 'foreground', 'tick'] as const

type Mode = (typeof MODES)[number]
type Context = { repo: string; run: string | null; specsDir: string | null; tickSec: number; skippedIsMissing: boolean }
type CiEntry = { head: string; state: 'passed' | 'failed' | 'pending' }
type TickResult = { tick_at: string; errors: Record<string, string | null>; open_prs: number[] | null; ci?: Record<string, CiEntry> }

class Usage extends Error {}

// 로그 ------------------------------------------------------------------

// 틱 자식은 stdout 에만 쓴다(머리 주석의 「로그」)
let logFile: string | null = null

function log(line: string): void {
  if (logFile) {
    try {
      try {
        if (statSync(logFile).size > LOG_LIMIT) renameSync(logFile, `${logFile}.1`)
      } catch {
        // 아직 없다
      }
      appendFileSync(logFile, `${line}\n`)
    } catch (e) {
      process.stderr.write(`orch-loop: ${logFile} 에 쓰지 못했다: ${(e as Error).message}\n`)
    }
  }
  process.stdout.write(`${line}\n`)
}

function oneLine(value: unknown): string {
  return String((value as Error)?.message ?? value).replace(/\r?\n|\r/g, ' ')
}

function iso(): string {
  return new Date().toISOString()
}

// 설정 ------------------------------------------------------------------

function optionalString(value: unknown, key: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new ConfigError(`설정 파일의 ${key} 는 문자열이어야 한다`)
  return value
}

function context(repo: string, run: string | undefined, specsDir: string | undefined): Context {
  const config = loadConfig(repo)
  const pipeline = section<{ tick_sec?: unknown }>(config, 'pipeline', PIPELINE_KEYS)
  const finish = section<{ run?: unknown; specs_dir?: unknown }>(config, 'finish', FINISH_KEYS)
  const queue = section<{ skipped_is_missing?: unknown }>(config, 'queue', QUEUE_KEYS)
  const skipped = queue.skipped_is_missing ?? false
  if (typeof skipped !== 'boolean') throw new ConfigError('설정 파일의 queue.skipped_is_missing 은 true 나 false 여야 한다')
  const tickSec = pipeline.tick_sec ?? DEFAULT_TICK_SEC
  if (typeof tickSec !== 'number' || !Number.isFinite(tickSec) || tickSec <= 0) {
    throw new ConfigError(`설정 파일의 pipeline.tick_sec 은 양수여야 한다: ${JSON.stringify(tickSec)}`)
  }
  return {
    repo,
    run: run || optionalString(finish.run, 'finish.run'),
    specsDir: specsDir || optionalString(finish.specs_dir, 'finish.specs_dir'),
    tickSec,
    skippedIsMissing: skipped,
  }
}

function aliveSec(): number {
  const raw = process.env.ORCH_LOOP_ALIVE_SEC
  if (raw === undefined || raw === '') return DEFAULT_ALIVE_SEC
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Usage(`ORCH_LOOP_ALIVE_SEC 는 양수 초여야 한다: ${raw}`)
  return value
}

function passArgs(ctx: Context): string[] {
  return ['--repo', ctx.repo, ...(ctx.run ? ['--run', ctx.run] : []), ...(ctx.specsDir ? ['--specs-dir', ctx.specsDir] : [])]
}

// 잠금 ------------------------------------------------------------------

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

function createLock(lock: string): boolean {
  let fd: number
  try {
    fd = openSync(lock, 'wx')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
  try {
    writeSync(fd, String(process.pid))
  } finally {
    closeSync(fd)
  }
  return true
}

// 잠금을 쥔 살아 있는 pid. 없거나 죽었으면 null
function lockHolder(lock: string): number | null {
  const text = (readText(lock) ?? '').trim()
  return /^\d+$/.test(text) && alive(Number(text)) ? Number(text) : null
}

function freshEmpty(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs < EMPTY_LOCK_GRACE_MS
  } catch {
    return false
  }
}

// 잠금을 얻으면 null, 살아 있는 다른 루프가 쥐고 있으면 그 pid 다.
async function takeLock(lock: string, repo: string): Promise<number | null> {
  makeParent(lock, repo)
  const deadline = Date.now() + START_WAIT_MS
  while (Date.now() < deadline) {
    if (createLock(lock)) return null
    const seen = readText(lock)
    if (seen === null) continue
    const text = seen.trim()
    if (/^\d+$/.test(text) && alive(Number(text))) return Number(text)
    if (text === '' && freshEmpty(lock)) {
      await sleep(POLL_MS)
      continue
    }
    if (reclaim(lock, seen) === 'wait') await sleep(POLL_MS)
  }
  throw new Error(`${lock} 를 ${START_WAIT_MS / 1000}초 안에 얻지 못했다`)
}

function releaseLock(lock: string): void {
  try {
    if ((readText(lock) ?? '').trim() === String(process.pid)) unlinkSync(lock)
  } catch {
    // 이미 없거나 다른 루프가 쥐었다. 남의 잠금은 지우지 않는다
  }
}

// --start, --stop, --status ------------------------------------------------

function runOf(state: LoopState | null, pid: number): string {
  return state && Number(state.pid) === pid && state.run ? state.run : '-'
}

// pid 의 명령줄에 orch-loop 가 들어 있는지. 죽은 루프의 pid 를 다른 프로세스가 받았으면 그 프로세스에 신호를 보내지 않는다
function isLoopProcess(pid: number): boolean {
  if (!alive(pid)) return false
  const done = runSync(['ps', '-o', 'command=', '-p', String(pid)], { env: { LC_ALL: 'C' } })
  return done.code === 0 && done.stdout.includes('orch-loop')
}

function running(repo: string): { pid: number; run: string } | null {
  const status = loopStatus(repo, Date.now())
  if (status.alive) return { pid: Number(status.state.pid), run: status.state.run || '-' }
  const holder = lockHolder(lockFile(repo))
  return holder === null ? null : { pid: holder, run: runOf(readLoop(repo), holder) }
}

async function start(ctx: Context): Promise<number> {
  const found = running(ctx.repo)
  if (found) {
    log(`LOOP-RUNNING ${found.pid} run=${found.run}`)
    return 4
  }
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SELF, ...passArgs(ctx), '--foreground'], {
    cwd: ctx.repo,
    detached: true,
    stdio: 'ignore',
  })
  let exited: number | null = null
  let failed: string | null = null
  child.on('exit', (code, signal) => {
    exited = code ?? signalCode(signal ?? 'SIGTERM')
  })
  child.on('error', (e) => {
    failed = e.message
  })
  child.unref()
  const pid = child.pid
  const deadline = Date.now() + START_WAIT_MS
  while (Date.now() < deadline) {
    if (failed !== null) {
      log(`LOOP-START-FAIL 루프를 띄우지 못했다: ${failed}`)
      return 1
    }
    const state = readLoop(ctx.repo)
    if (pid !== undefined && state && Number(state.pid) === pid) {
      log(`LOOP-STARTED ${pid} run=${state.run || '-'}`)
      return 0
    }
    if (exited !== null) {
      log(`LOOP-START-FAIL 루프가 loop.json 을 쓰기 전에 종료 코드 ${exited} 로 끝났다`)
      return 1
    }
    await sleep(POLL_MS)
  }
  // 늦게라도 살아나 따로 도는 루프를 남기지 않는다. 실패로 알린 루프가 돌면 코디네이터가 모르는 루프가 된다
  if (pid !== undefined) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 이미 끝났다
    }
  }
  log(`LOOP-START-FAIL ${START_WAIT_MS / 1000}초 안에 loop.json 에 pid ${pid ?? '-'} 를 쓰지 않아 끝냈다`)
  return 1
}

async function stop(repo: string): Promise<number> {
  const candidates = [Number(readLoop(repo)?.pid), lockHolder(lockFile(repo)) ?? Number.NaN]
  const pid = candidates.find((p) => isLoopProcess(p))
  if (pid === undefined) {
    log('LOOP-NOT-RUNNING')
    return 0
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
  }
  const deadline = Date.now() + STOP_WAIT_MS
  while (alive(pid)) {
    if (Date.now() >= deadline) {
      log(`LOOP-STOP-TIMEOUT ${pid}`)
      return 1
    }
    await sleep(POLL_MS)
  }
  log(`LOOP-STOPPED ${pid}`)
  return 0
}

function status(repo: string): number {
  const found = loopStatus(repo, Date.now())
  if (!found.alive) {
    log(`LOOP-DEAD ${repo} ${found.reason}`)
    return 1
  }
  const { state } = found
  log(`LOOP-ALIVE ${state.pid} run=${state.run || '-'} last_tick=${state.last_tick || '-'} alive_at=${state.alive_at}`)
  return 0
}

// --foreground ------------------------------------------------------------

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== '')
}

// 틱 자식의 출력에서 결과 줄을 꺼내고 나머지를 로그로 옮긴다
function tickResult(done: RunResult): { result: TickResult | null; reason: string | null } {
  const out = lines(done.stdout)
  let result: TickResult | null = null
  const last = out.at(-1)
  if (last !== undefined) {
    try {
      const parsed = JSON.parse(last) as TickResult
      if (parsed && typeof parsed === 'object' && typeof parsed.tick_at === 'string') {
        result = parsed
        out.pop()
      }
    } catch {
      // 결과 줄이 아니다
    }
  }
  for (const line of [...out, ...lines(done.stderr)]) log(line)
  if (done.code !== 0) return { result: null, reason: `종료 코드 ${done.code}` }
  if (!result) return { result: null, reason: '결과 줄 없음' }
  return { result, reason: null }
}

async function foreground(ctx: Context, once: boolean, interval: number): Promise<number> {
  const lock = lockFile(ctx.repo)
  const holder = await takeLock(lock, ctx.repo)
  if (holder !== null) {
    log(`LOOP-RUNNING ${holder} run=${runOf(readLoop(ctx.repo), holder)}`)
    return 4
  }
  process.on('exit', () => releaseLock(lock))
  const previous = readLoop(ctx.repo)
  const errors = previous && typeof previous.errors === 'object' && previous.errors !== null && !Array.isArray(previous.errors) ? previous.errors : {}
  const ci = ciEntries(previous?.ci)
  const now = iso()
  const state: LoopState = {
    pid: process.pid,
    run: ctx.run,
    repo: ctx.repo,
    tick_sec: ctx.tickSec,
    started_at: now,
    alive_at: now,
    last_tick: null,
    ticks: 0,
    errors: { ...errors },
    ci,
  }
  writeLoop(ctx.repo, state)
  if (!ctx.run) log('경고: Run id 가 없어 질문 확인을 건너뛴다. --run 이나 finish.run 으로 준다')
  const timer = setInterval(() => {
    state.alive_at = iso()
    try {
      writeLoop(ctx.repo, state)
    } catch (e) {
      log(`orch-loop: loop.json 에 alive_at 을 쓰지 못했다: ${oneLine(e)}`)
    }
  }, interval * 1000)
  try {
    for (let n = 1; ; n++) {
      log(`tick ${n} ${iso()}`)
      const done = await runAsync(scriptCommand(SELF, [...passArgs(ctx), '--tick', '--tick-number', String(n)]), { cwd: ctx.repo, timeoutMs: NO_LIMIT_MS })
      // 신호로 끝내는 중이면 끊긴 틱을 실패로 알리지 않는다
      const signal = stopping()
      if (signal) return signalCode(signal)
      const { result, reason } = tickResult(done)
      if (result) {
        state.last_tick = result.tick_at
        for (const [source, value] of Object.entries(result.errors ?? {})) state.errors[source] = value ?? null
        // 열린 PR 을 읽지 못한 틱은 ci 가 없다. 그때는 이전 값을 둔다
        if (isObject(result.ci)) state.ci = ciEntries(result.ci)
      }
      state.ticks = n
      if (reason !== null) {
        log(`WATCH-ERROR tick: ${reason}`)
        if (state.errors.tick !== reason) {
          try {
            appendEvent(ctx.repo, 'WATCH-ERROR', null, `tick: ${reason}`)
          } catch (e) {
            log(`orch-loop: 알림 파일에 쓰지 못했다: ${oneLine(e)}`)
          }
        }
      }
      state.errors.tick = reason
      state.alive_at = iso()
      writeLoop(ctx.repo, state)
      if (once) return 0
      await sleep(ctx.tickSec * 1000)
    }
  } finally {
    clearInterval(timer)
  }
}

// --tick ------------------------------------------------------------------

// 내 열린 PR 의 행. CI 감시가 쓰는 필드를 함께 읽는다
type OwnPr = {
  number: number
  title: string | null
  branch: string
  head: string
  author: string
  draft: boolean
  base: string
  url: string
  host: string
  slug: string
  rollup: unknown
}
type Prs = { ok: true; mine: OwnPr[] } | { ok: false; error: string }
const PR_FIELDS = 'number,author,url,title,headRefName,headRefOid,isDraft,baseRefName,statusCheckRollup'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function openPrs(repo: string): Prs {
  const got = ghJson<unknown>(['pr', 'list', '--state', 'open', '--limit', '200', '--json', PR_FIELDS], { cwd: repo })
  if (!got.ok) return got
  if (!Array.isArray(got.data)) return { ok: false, error: 'gh pr list 의 출력이 목록이 아니다' }
  const authors = new Map<string, string[]>()
  const mine: OwnPr[] = []
  for (const pr of got.data) {
    if (!isObject(pr) || !Number.isInteger(pr.number)) return { ok: false, error: 'gh pr list 의 행을 읽지 못했다' }
    const url = typeof pr.url === 'string' ? pr.url : ''
    const target = apiTarget(url)
    const host = target?.host
    if (!target || !host) return { ok: false, error: `PR #${pr.number} 의 URL 을 읽지 못했다` }
    if (!authors.has(host)) {
      const own = ownAuthors(repo, host)
      if (!own) return { ok: false, error: `내 PR 의 작성자를 정하지 못했다(${host} 의 gh api user 실패). config.json 의 pipeline.authors 로 준다` }
      authors.set(host, own)
    }
    const login = isObject(pr.author) && typeof pr.author.login === 'string' ? pr.author.login : ''
    if (!login || !isOwnPr({ author: { login } }, authors.get(host) ?? [])) continue
    const text = (value: unknown) => (typeof value === 'string' ? value : '')
    mine.push({
      number: pr.number as number,
      title: typeof pr.title === 'string' ? pr.title : null,
      branch: text(pr.headRefName),
      head: text(pr.headRefOid),
      author: login,
      draft: pr.isDraft === true,
      base: text(pr.baseRefName),
      url,
      host,
      slug: target.slug,
      rollup: pr.statusCheckRollup,
    })
  }
  return { ok: true, mine }
}

// loop.json 의 ci 에서 형식이 맞는 항목만 남긴다
function ciEntries(value: unknown): Record<string, CiEntry> {
  const entries: Record<string, CiEntry> = {}
  if (!isObject(value)) return entries
  for (const [number, entry] of Object.entries(value)) {
    if (isObject(entry) && typeof entry.head === 'string' && (entry.state === 'passed' || entry.state === 'failed' || entry.state === 'pending')) {
      entries[number] = { head: entry.head, state: entry.state }
    }
  }
  return entries
}

function prInput(pr: OwnPr): Record<string, unknown> {
  return { number: pr.number, title: pr.title, branch: pr.branch || null, head: pr.head || null, author: pr.author, draft: pr.draft, url: pr.url }
}

// 틱 안에서 한 번만 읽는 워크트리 목록과 worker 행
type Lookup = { paths?: Map<string, string>; rows?: ReturnType<typeof workerRows> }

// 체크가 실패한 PR 의 살아 있는 dispatch 에 보낸다. 결과는 CI-FAILED 의 text 에 붙일 말이다(머리 주석의 「CI 감시」)
async function tellWorker(ctx: Context, pr: OwnPr, failed: CiCheck[], lookup: Lookup): Promise<string> {
  if (!ctx.run) return 'Run id 없음'
  lookup.paths ??= worktreePaths(ctx.repo)
  const path = lookup.paths.get(pr.branch)
  if (!path) return '살아 있는 dispatch 없음'
  lookup.rows ??= workerRows(ctx.run)
  if (!lookup.rows.ok) {
    log(`orch-loop: worker 목록을 읽지 못했다: ${oneLine(lookup.rows.error)}`)
    return 'worker 목록을 읽지 못했다'
  }
  const row = workerFor(lookup.rows.rows, path)
  if (!row || !LIVE_DISPATCH.has(String(row.dispatchStatus))) return '살아 있는 dispatch 없음'
  const dispatch = String(row.dispatchId)
  const shown = failed.map((check) => (check.url ? `${check.name} ${check.url}` : check.name)).join(', ')
  const body = `PR #${pr.number} 의 체크가 실패했다: ${shown}. 실패를 고치고 검사를 다시 돌린 뒤 push 한다. 끝나면 status 로 알린다.`
  const send = process.env.SEND_TO_WORKER || join(HERE, 'send-to-worker.ts')
  const sent = await runAsync(scriptCommand(send, ['--dispatch', dispatch, '--body', body, '--run', ctx.run]), { cwd: ctx.repo, timeoutMs: SEND_MS })
  relay(sent)
  if (sent.code === 0) return `보냈다 ${dispatch}`
  if (sent.code === 4) return '깨우지 못했다(종료 코드 4)'
  return `보내지 못했다(종료 코드 ${sent.code})`
}

async function fireCi(event: 'ci-passed' | 'ci-failed', ctx: Context, pr: OwnPr, checks: CiCheck[], required: string[]): Promise<void> {
  try {
    // 핸들러의 실패는 fire 가 낸 HOOK-FAIL 줄로만 남는다. 알림 파일의 HOOK-FAIL 은 tick 핸들러의 것만이다
    await fire(event, { pr: prInput(pr), checks, required }, { repo: ctx.repo, base: pr.base, run: ctx.run })
  } catch (e) {
    log(`orch-loop: ${event} 를 내지 못했다: ${oneLine(e)}`)
  }
}

// CI 감시(머리 주석의 「CI 감시」). ci 는 결과 줄에 담을 값, error 는 errors.ci 에 둘 이유다
async function watchCi(ctx: Context, mine: OwnPr[], previous: Record<string, CiEntry>, lookup: Lookup): Promise<{ ci: Record<string, CiEntry>; error: string | null }> {
  const ci: Record<string, CiEntry> = {}
  const rules = new Map<string, Names>()
  const errors: string[] = []
  for (const pr of mine) {
    const key = String(pr.number)
    const before = previous[key]
    if (pr.draft) {
      if (before) ci[key] = before
      continue
    }
    const where = `${pr.host} ${pr.slug} ${pr.base}`
    let names = rules.get(where)
    if (!names) {
      try {
        names = requiredNames(ctx.repo, pr.host, pr.slug, pr.base)
      } catch (e) {
        names = { ok: false, error: oneLine(e) }
      }
      rules.set(where, names)
      if (!names.ok) errors.push(`${pr.base} 의 필수 체크 규칙을 읽지 못했다: ${oneLine(names.error)}`)
    }
    if (!names.ok) {
      if (before) ci[key] = before
      continue
    }
    const judged = ciState(pr.rollup, names.names, ctx.skippedIsMissing)
    const entry: CiEntry = { head: pr.head, state: judged.state }
    ci[key] = entry
    if (before && before.head === entry.head && before.state === entry.state) continue
    if (entry.state === 'passed') {
      log(`CI-PASSED #${pr.number} ${pr.head.slice(0, 8)}`)
      await fireCi('ci-passed', ctx, pr, judged.checks, names.names)
    } else if (entry.state === 'failed') {
      const failed = judged.checks.filter(failedCheck)
      let told: string
      try {
        told = await tellWorker(ctx, pr, failed, lookup)
      } catch (e) {
        told = `보내지 못했다(${oneLine(e)})`
      }
      const text = `${failed.map((check) => check.name).join(', ')}: ${told}`
      log(`CI-FAILED #${pr.number} ${text}`)
      try {
        appendEvent(ctx.repo, 'CI-FAILED', pr.number, text)
      } catch (e) {
        log(`orch-loop: 알림 파일에 쓰지 못했다: ${oneLine(e)}`)
      }
      await fireCi('ci-failed', ctx, pr, judged.checks, names.names)
    }
  }
  return { ci, error: errors.length > 0 ? errors.join('; ') : null }
}

// 충돌 처리(머리 주석의 「충돌 처리」). 결과는 errors.conflicts 에 둘 이유다
async function handleConflicts(ctx: Context, lookup: Lookup): Promise<string | null> {
  const base = defaultBase(ctx.repo) ?? 'main'
  const found = findConflicts(ctx.repo, base)
  if (!found.ok) return oneLine(found.error)
  const { baseSha } = found
  const authors = new Map<string, string[]>()
  const mine: { pr: OpenPr; files: string[] }[] = []
  for (const item of found.found) {
    const host = apiTarget(item.pr.url)?.host
    if (!host) return `#${item.pr.number} 의 PR URL 을 읽지 못했다: ${JSON.stringify(item.pr.url ?? null)}`
    if (!authors.has(host)) {
      const own = ownAuthors(ctx.repo, host)
      if (!own) return `내 PR 의 작성자를 정하지 못했다(${host} 의 gh api user 실패). config.json 의 pipeline.authors 로 준다`
      authors.set(host, own)
    }
    if (isOwnPr({ author: { login: item.pr.author?.login ?? '' } }, authors.get(host) ?? [])) mine.push(item)
  }
  const statePath = notifiedFile(ctx.repo)
  const state = loadNotified(statePath)
  const fireCtx = { repo: ctx.repo, base, run: ctx.run }
  const errors = new Set<string>()
  for (const { pr, files } of mine) {
    if (Object.hasOwn(state, notifiedKey(pr.number, baseSha))) continue
    log(`#${pr.number} CONFLICTING ${pr.headRefName}: ${files.join(' ')}`)
    lookup.paths ??= worktreePaths(ctx.repo)
    const path = lookup.paths.get(pr.headRefName)
    let target: WorkerFound
    if (!path) {
      target = { orphan: '워크트리 없음. 새 worker 는 띄우지 않는다' }
    } else {
      lookup.rows ??= workerRows(ctx.run ?? '')
      if (!lookup.rows.ok) {
        // 알리지도 기록하지도 않는다. 다음 틱이 다시 본다
        errors.add(`worker 목록을 읽지 못했다: ${oneLine(lookup.rows.error)}`)
        continue
      }
      const row = workerFor(lookup.rows.rows, path)
      target = row ? { path, row } : { orphan: '그 워크트리의 dispatch 없음. 새 worker 는 띄우지 않는다' }
    }
    const outcome = await resolveConflict({ repo: ctx.repo, base, baseSha, pr, files, found: target, run: ctx.run, dryRun: false, out: log })
    if (outcome.kind === 'usage') {
      errors.add('send-to-worker 사용법 오류')
      break
    }
    if (outcome.kind !== 'record') continue
    await concludeConflict(statePath, ctx.repo, fireCtx, pr, files, baseSha, outcome)
    if (outcome.action === 'orphan') {
      try {
        appendEvent(ctx.repo, 'CONFLICT-ORPHAN', pr.number, outcome.reason ?? '')
      } catch (e) {
        log(`orch-loop: 알림 파일에 쓰지 못했다: ${oneLine(e)}`)
      }
    }
  }
  return errors.size > 0 ? [...errors].join('; ') : null
}

function relay(done: RunResult): void {
  for (const line of [...lines(done.stdout), ...lines(done.stderr)]) log(line)
}

async function tick(ctx: Context, n: number): Promise<number> {
  const loaded = readLoop(ctx.repo)
  const before = loaded?.errors
  const previous = isObject(before) ? before : {}
  const errors: Record<string, string | null> = {}
  // 출처의 실패를 기록한다. 이유가 이전과 다를 때만 알림 파일에 쓴다(머리 주석의 「오류 줄 억제」).
  // 로그 줄은 `<kind> <text>` 이고 알림 파일의 text 는 kind 를 뺀 나머지다. logged 면 그 줄은 이미 stdout 에 나갔다(fire 의 HOOK-FAIL 줄)
  const report = (source: string, reason: string | null, kind = 'WATCH-ERROR', text = `${source}: ${reason}`, logged = false) => {
    errors[source] = reason
    if (reason === null) return
    if (!logged) log(`${kind} ${text}`)
    if (previous[source] === reason) return
    try {
      appendEvent(ctx.repo, kind, null, text)
    } catch (e) {
      log(`orch-loop: 알림 파일에 쓰지 못했다: ${oneLine(e)}`)
    }
  }

  // 1. 질문 확인
  if (ctx.run) {
    let notices: ReturnType<typeof poll>['notices'] = []
    try {
      notices = poll(ctx.run, join(pathOf('state', ctx.repo), 'questions-seen.json'), Date.now() / 1000, REMIND_AFTER_SEC, ctx.repo).notices
      report('questions', null)
    } catch (e) {
      report('questions', oneLine(e))
    }
    for (const notice of notices) {
      log(notice.line)
      if (notice.reminder) {
        try {
          appendEvent(ctx.repo, 'REMINDER', null, notice.line.replace(/^REMINDER /, ''))
        } catch (e) {
          log(`orch-loop: 알림 파일에 쓰지 못했다: ${oneLine(e)}`)
        }
      }
      await notifyQuestion(notice, ctx.repo, ctx.run, 'orch-loop')
    }
  } else {
    report('questions', null)
  }

  // 2. 정리
  try {
    const sweep = process.env.CLEANUP_SWEEP || join(HERE, 'cleanup-sweep.ts')
    const args = ['--repo', ctx.repo, '--kill-holders', '--remote-branches', '--apply']
    if (ctx.run) args.push('--run', ctx.run)
    if (ctx.specsDir) args.push('--specs-dir', ctx.specsDir)
    const done = await runAsync(scriptCommand(sweep, args), { cwd: ctx.repo, timeoutMs: SWEEP_TIMEOUT_MS })
    relay(done)
    report('cleanup', done.code === 0 ? null : `종료 코드 ${done.code}`)
  } catch (e) {
    report('cleanup', oneLine(e))
  }

  // 3. 보드 동기화
  try {
    if (isFile(boardPath(ctx.repo))) {
      const sync = process.env.BOARD_SYNC || join(HERE, 'board-sync.ts')
      const done = await runAsync(scriptCommand(sync, ['--repo', ctx.repo]), { cwd: ctx.repo, timeoutMs: SWEEP_TIMEOUT_MS })
      relay(done)
      report('board', done.code === 0 ? null : `종료 코드 ${done.code}`)
    } else {
      report('board', null)
    }
  } catch (e) {
    report('board', oneLine(e))
  }

  // 열린 PR 은 한 번만 읽어 CI 감시와 tick 이벤트가 함께 쓴다
  let prs: Prs
  try {
    prs = openPrs(ctx.repo)
  } catch (e) {
    prs = { ok: false, error: oneLine(e) }
  }
  report('prs', prs.ok ? null : oneLine(prs.error))
  const openPrNumbers = prs.ok ? prs.mine.map((pr) => pr.number) : null

  // 4. CI 감시. 열린 PR 을 읽지 못한 틱은 결과에 ci 를 넣지 않아 부모가 이전 값을 둔다
  let ci: Record<string, CiEntry> | undefined
  // CI 감시와 충돌 처리가 함께 쓴다
  const lookup: Lookup = {}
  if (prs.ok) {
    try {
      const watched = await watchCi(ctx, prs.mine, ciEntries(loaded?.ci), lookup)
      ci = watched.ci
      report('ci', watched.error)
    } catch (e) {
      report('ci', oneLine(e))
    }
  }

  // 5. tick 이벤트
  try {
    const fired = await fire('tick', { tick: n, open_prs: openPrNumbers }, { repo: ctx.repo, base: defaultBase(ctx.repo) ?? '', run: ctx.run })
    if (fired.result === 'fail' || fired.result === 'timeout') {
      const reason = fired.result === 'timeout' ? 'timeout' : String(fired.code ?? 'lock')
      report('hook', reason, 'HOOK-FAIL', `tick ${reason}`, true)
    } else {
      report('hook', null)
    }
  } catch (e) {
    report('hook', oneLine(e))
  }

  // 6. 충돌 처리. 내 열린 PR 이 없으면 git fetch 없이 끝낸다. 열린 PR 을 읽지 못한 틱은 건너뛰고 errors.conflicts 를 그대로 둔다
  if (prs.ok) {
    try {
      report('conflicts', prs.mine.length > 0 ? await handleConflicts(ctx, lookup) : null)
    } catch (e) {
      report('conflicts', oneLine(e))
    }
  }

  const result: TickResult = { tick_at: iso(), errors, open_prs: openPrNumbers, ...(ci ? { ci } : {}) }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return 0
}

// 본체 ------------------------------------------------------------------

let exiting = false
function onSignal(signal: NodeJS.Signals): void {
  if (exiting) return
  exiting = true
  // 진행 중인 자식(틱 자식, 정리 명령, 핸들러 그룹)을 끊은 뒤에 끝낸다. 그냥 끝내면 자식이 남는다
  void stopChildren(signal).finally(() => process.exit(signalCode(signal)))
}

function fatal(e: unknown): void {
  log(`orch-loop: ${(e as Error)?.stack ?? String(e)}`)
  if (exiting) return
  exiting = true
  void stopChildren('SIGTERM').finally(() => process.exit(1))
}

async function main(argv: string[]): Promise<number> {
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
  if (mode === 'stop') return stop(repo)
  if (mode === 'status') return status(repo)

  let ctx: Context
  try {
    ctx = context(repo, values.run, values['specs-dir'])
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    process.stderr.write(`orch-loop: ${e.message}\n`)
    return 2
  }
  if (mode === 'start') return start(ctx)
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  process.on('SIGHUP', onSignal)
  process.on('uncaughtException', fatal)
  process.on('unhandledRejection', fatal)
  if (mode === 'tick') return tick(ctx, tickNumber)
  logFile = join(pathOf('state', repo), 'loop.log')
  makeParent(logFile, repo)
  return foreground(ctx, values.once as boolean, interval)
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    log(`orch-loop: ${(e as Error)?.stack ?? String(e)}`)
    process.exitCode = 1
  },
)
