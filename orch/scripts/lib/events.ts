// 이벤트 실행기다. 명령은 `await fire('before-merge', input, ctx)` 한 줄로 저장소의 핸들러를 부른다.
// 핸들러 찾기, 잠금, 시간 제한, 실행 기록, 종료 코드 해석, 가드 환경을 이 모듈 한 곳이 소유한다.
// 이벤트 이름과 시점은 docs/flow.md 의 「orch 이벤트」, 이벤트별 입력 필드는 아래 「공통 필드」 와 「이벤트별 필드」 가 정한다.
//
// 핸들러: <orch 루트>/hooks/<이벤트>.ts 하나. `node --disable-warning=ExperimentalWarning <파일>` 로 띄운다.
//   작업 디렉터리는 ctx.cwd, 없으면 주 checkout 이다. stdin 에 JSON 객체 하나를 쓴다.
//   그 객체는 input 위에 공통 필드(version, event, repo, base, run, time)를 덮은 것이다.
//
// 공통 필드: 모든 입력에 있다. 이벤트별 필드는 그 위에 더한다.
//   version  number. 계약 버전. 지금은 1. 필드를 빼거나 뜻을 바꾸면 올린다
//   event    string. 이벤트 이름
//   repo     string. 주 checkout 의 절대경로
//   base     string. 기준 브랜치. 명령이 --base 를 받지 않았고 origin/HEAD 도 읽지 못하면 빈 문자열이다
//   run      string 또는 null. Orca Run id. 모르면 null
//   time     string. ISO 8601 UTC
//
// pr 객체와 worker 객체: PR 을 다루는 이벤트는 pr 을, worker 를 다루는 이벤트는 worker 를 받는다.
//   pr      number, title, branch, head(40자리 SHA), author, draft, url
//   worker  task, dispatch, terminal, worktree, spec. 모르는 값은 null 이다
//
// 이벤트별 필드
//   before-launch, worker-launched  worker, branch, agent, model, effort
//   worker-question  worker, message(id, type, subject, body), reminder(bool), age_sec
//   worker-done  worker, outcome, evidence(ready 또는 suspicious), pr(있으면).
//       worker_done --outcome failed 같은 실패 보고와 --completion-contract none 의 대기에서는 내지 않는다
//   worker-lost  worker, stage
//   worker-stalled  worker, state(error 또는 idle. lib/screen.ts 의 화면 상태), since(그 상태를 처음 본 틱의 ISO 8601 UTC 시각),
//       ticks(같은 상태와 같은 마지막 메시지 묶음을 본 틱 수. 핸들러가 처리한 뒤로 다시 센다), lines(빈 줄을 뺀 화면 끝 줄 목록. 핸들러가 직접 판정할 때 쓴다).
//       상주 루프가 그 Run 의 살아 있는 dispatch 화면에서 같은 멈춤을 pipeline.stall_ticks 의 틱 수만큼 본 때 낸다.
//       핸들러가 0 으로 끝나면 같은 화면이 그 틱 수만큼 더 이어질 때 다시 내고, 아니면 그 멈춤에는 다시 내지 않는다(orch-loop.ts 의 「멈춤 확인」).
//       10 은 처리하지 않고 코디네이터에게 넘긴다는 뜻이다(HOOK-REJECT). 같은 상태가 이어지는 동안 since 는 그대로라 핸들러는 since 로 횟수를 센다
//   before-ready, pr-ready  pr, ready_count(이미 ready 인 내 PR 수), slots
//   ci-passed, ci-failed, ci-missing  pr, checks(이름, 상태, 결론, URL 의 목록), required(이름 목록)
//   pr-conflict  pr, base_head, files, worker(터미널이 없으면 null), action
//       action 은 notified(살아 있는 dispatch 에 보냄), resumed(남은 터미널에 후속 지시서로 이어 씀), orphan(이어 쓰지 못함)이다
//   before-merge  pr, owner, name(GitHub 저장소 이름), last_of_task(bool)
//   verify-merged  pr, copy(사본 절대경로), base_head, changed_files, overlap_files
//   after-merge  pr, merge_commit, remote_branch_deleted(bool), retargeted(base 를 옮긴 PR 번호 목록)
//   after-queue  merged_prs, code_prs, held_prs
//   after-deploy  pr, merge_commit, deploy(success, failure, timeout, none), last_of_task(bool)
//   before-cleanup  worktree, branch, pr(있으면), worker(있으면)
//   after-cleanup  removed(경로 목록), skipped(경로와 이유의 목록)
//   tick  tick(루프 시작 뒤 몇 번째인지), open_prs(내 열린 PR 번호 목록. 읽지 못하면 null), primary(bool. 주 Run 이거나 Run 이 없는 루프면 true).
//       루프에 등록된 Run 마다 한 번씩 나고 공통 필드 run 이 그 Run 이다(ADR-012). 저장소 공유 일은 primary 일 때만 한다
//   session-resume  loop_alive(bool. 이 Run 을 맡는 루프가 살아 있는지. 살아 있어도 등록되지 않았으면 false), waiters(살아 있는 wait-important 대기와 watch-questions 질문 감시의 pid 목록.
//       그 자식인 orchestration check 와 셸 행은 세지 않는다), unanswered(질문 id 목록)
//
// 환경: process.env 위에 아래를 둔다.
//   ORCH_EVENT, ORCH_REPO(주 checkout), ORCH_DIR(orch 루트 절대경로)
//   ORCH_CHECKOUT  ctx.repo 로 받은 경로의 실경로. 부른 명령이 --repo 로 받은 checkout 이고, 연결된 워크트리면 그 워크트리다.
//                  명령이 호출된 작업 디렉터리다. migrate-orch-dir --hooks 가 만든 핸들러가 옛 명령을 이 경로에서 부른다
//   PATH        맨 앞에 가드 폴더(lib/guard)
//   ORCA, GH    가드 폴더의 shim 절대경로
//   ORCH_REAL_ORCA, ORCH_REAL_GH  진짜 실행 파일의 절대경로. 찾지 못하면 넘기지 않는다
//   ORCH_SCRIPTS  orch 의 scripts 폴더 절대경로. 플러그인 설치 경로는 커밋마다 바뀌어 핸들러가 코어 명령(nudge-worker, send-to-worker)을 찾는 데 쓴다.
//                 worker 에게 입력하는 코어 명령은 ORCH_REAL_ORCA 로 orca 를 부르므로 가드에 막히지 않는다. 핸들러는 그 명령으로만 입력한다
//   진짜 실행 파일은 가드 폴더를 PATH 에 넣기 전에 찾는다. orcaBin(), ghBin() 의 기본값은 이름이라, 그대로 넘기면
//   shim 이 PATH 맨 앞의 자기 자신을 다시 불러 node 프로세스가 끝없이 생긴다. `/` 가 든 값은 절대경로로 바꾸고
//   (그 실경로가 가드 폴더 안이면 버리고 이름으로 찾는다), 이름이면 PATH 를 앞에서부터 보며 가드 폴더가 아닌 곳의 실행 파일을 고른다.
//   가드는 실수 방지 장치이고 보안 경계가 아니다. ORCH_REAL_* 가 보이므로 핸들러가 일부러 부르면 우회된다.
//
// 종료 코드와 결과(FireResult.result):
//   핸들러가 없다   none. 줄도 기록도 없다
//   0                              pass
//   10, 거부할 수 있는 이벤트      reject. 이유는 stdout 의 마지막 빈 줄 아닌 줄. `HOOK-REJECT <이벤트> <이유>`
//                                  그런 줄이 없으면 이유는 `(이유 없음)` 이다. 줄 끝이 비어 거부인지 알아보기 어렵지 않게 한다
//   10, 나머지 이벤트, 그 밖        fail. `HOOK-FAIL <이벤트> <종료 코드>`. 시그널로 죽으면 128 + 신호 번호다
//   시간 초과                       timeout, code null. `HOOK-FAIL <이벤트> timeout`
//   잠금을 얻지 못함               fail, code null. `HOOK-FAIL <이벤트> lock`
//   거부를 1 이 아니라 10 으로 둔 것은 node 가 잡지 않은 예외에 1 을 내기 때문이다. 1 을 거부로 읽으면 죽은 핸들러가 의도한 거부가 된다.
//   거부할 수 있는 이벤트에서 fail 과 timeout 을 거부처럼 멈출지는 부르는 명령이 정한다(docs/flow.md 의 「갈래」).
//
// 시간 제한: EVENTS 의 기본값을 config.json 의 hooks.timeouts.<이벤트>(초, 양수)가 덮는다. 값이 틀리면 ConfigError 다.
//   eventTimeoutSec 가 fire 와 같은 값과 검사를 낸다. 머지 뒤에 나는 이벤트의 설정 오류를 시작하기 전에 알리려는 명령이 부른다.
//   넘으면 프로세스 그룹에 TERM, KILL 유예(기본 10초, ORCH_KILL_GRACE_SEC) 뒤에도 그룹이 살아 있으면 KILL 이다. 자식은 detached 로 띄워 새 그룹을 만든다.
//   그래서 핸들러가 띄운 bash -c 의 손자 프로세스도 함께 끝난다.
//   핸들러는 끝났는데 백그라운드 손자가 stdout 이나 stderr 를 쥐고 있으면 파이프가 닫히지 않는다. 그때는 시간 제한까지
//   기다리지 않는다. 핸들러가 끝나고 2초 안에 파이프가 닫히지 않으면 그룹에 TERM, 다시 2초 뒤에도 닫히지 않으면
//   그룹이 살아 있을 때 KILL 을 보내고 파이프를 닫는다. 결과는 핸들러의 종료 코드로 판정한다. 손자가 그 뒤에 쓴 출력은 버린다.
//   spawnSync 를 쓰지 않는 이유: TERM 을 무시하는 자식이면 시간이 지나도 돌아오지 않아 KILL 을 보낼 수 없고,
//   출력 한도(maxBuffer)를 넘으면 자식이 죽으며, 줄을 그때그때 out 으로 옮길 수 없다(Node 22.18 실측).
//
// 신호: 띄운 그룹은 lib/proc.ts 의 trackChild 로 기억한다. 부른 명령이 신호를 받아 stopChildren 을 부르면 그룹에 TERM,
//   유예 뒤 KILL 이 간다. 그 뒤의 fire 는 띄우지 않고 fail 이다(종료 코드는 128 + 받은 신호 번호).
//
// 출력: 핸들러의 stdout 과 stderr 를 줄 단위로 나눠 `[hook <이벤트>] ` 를 붙여 바로 out 으로 보낸다. 메모리에 모으지 않고
//   크기 한도도 없다. out 의 기본은 process.stdout 에 한 줄씩 쓰는 것이다.
//
// 잠금: <orch 루트>/state/hooks/<이벤트>.lock. 배타 생성(wx)하고 자기 pid 를 쓴다. 다른 살아 있는 pid 가 쥐고 있으면
//   0.5초 간격으로 다시 보며 그 이벤트의 시간 제한에 KILL 유예의 1.5배(기본 15초)를 더해 기다린다. 쥔 쪽은 시간 제한과 KILL 유예 안에 끝나기 때문이다.
//   셋 이상 겹쳐 앞의 실행들이 시간 제한 가까이 돌면 뒤 실행이 lock 실패로 끝나는 것은 의도한 동작이다.
//   잠금을 얻으면 핸들러를 띄우기 직전에 잠금 파일이 아직 자기 pid 인지 다시 읽는다. 아니면 다시 기다린다.
//   끝나면(예외 포함) 자기 pid 가 든 잠금만 지운다.
//   보장 범위: 살아 있는 pid 의 잠금은 wx 가 한 실행만 통과시킨다. 죽은 잠금을 둘이 함께 회수해도 한 실행만 돈다.
//   셋이 겹치면 드물게 둘이 함께 돈다. A 가 회수하려고 B 가 새로 만든 잠금을 떼어 낸 사이 C 가 wx 로 만들고,
//   B 가 그보다 먼저 다시 읽기를 지나 핸들러를 띄웠으면 B 와 C 가 함께 돈다. 다시 읽기는 B 가 아직 띄우기 전인 경우만 막는다.
//   같은 죽은 잠금을 세 실행이 몇 밀리초 안에 함께 회수해야 생기는 경합이라 그대로 둔다.
//   같은 잠금을 acquireLock, ownsLock, releaseLock 으로 내보낸다. reserve-migration.ts 가 lib/reservations.ts 의 예약 잠금(lockFile)에 이것을 쓴다.
//
// 기록: <orch 루트>/state/hooks.jsonl 에 결과마다 한 줄(time, event, handler, exit, result, duration_ms, reason).
//   none 은 적지 않는다. 더하기 전에 1MB 를 넘으면 hooks.jsonl.1 로 옮긴다.
//   duration_ms 는 잠금 대기를 포함해 fire 가 걸린 시간이다.
//   기록을 쓰지 못하면 예외를 내지 않고 stderr 에 경고 한 줄을 낸다. 결과와 HOOK-* 줄은 그대로 낸다.
//   기록은 사후 확인용이라, 그 실패로 핸들러의 거부나 실패가 부르는 명령에 전해지지 않으면 안 되기 때문이다.
//

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants as fsConstants,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ConfigError, HOOKS_KEYS, loadConfig, section } from './config.ts'
import { inside, isFile, real } from './fs.ts'
import { mainCheckout } from './git.ts'
import { ghBin } from './gh.ts'
import { orcaBin } from './orca.ts'
import { ensureIgnored, NAMES, orchDir, pathOf } from './paths.ts'
import { killGraceMs } from './env.ts'
import { groupAlive, killGroup, signalCode, stoppedReason, stopping, trackChild } from './proc.ts'
import { alive } from './process.ts'

type EventSpec = { rejectable: boolean; timeoutSec: number }

const SHORT = 120
const LONG = 1800

function spec(rejectable: boolean, timeoutSec: number = SHORT): EventSpec {
  return Object.freeze({ rejectable, timeoutSec })
}

export const EVENTS: Readonly<Record<string, EventSpec>> = Object.freeze({
  'before-launch': spec(true),
  'worker-launched': spec(false),
  'worker-question': spec(false),
  'worker-done': spec(false),
  'worker-lost': spec(false),
  // 거부는 넘김이다. 핸들러가 처리하지 않고 코디네이터에게 넘긴다(orch-loop.ts 의 「멈춤 확인」)
  'worker-stalled': spec(true),
  'before-ready': spec(true),
  'pr-ready': spec(false),
  'ci-passed': spec(false),
  'ci-failed': spec(false),
  'ci-missing': spec(false),
  'pr-conflict': spec(false),
  'before-merge': spec(true, LONG),
  'verify-merged': spec(true, LONG),
  'after-merge': spec(false),
  'after-queue': spec(false, LONG),
  'after-deploy': spec(false, LONG),
  'before-cleanup': spec(true),
  'after-cleanup': spec(false),
  tick: spec(false),
  'session-resume': spec(false),
})

export type FireResult = { result: 'none' | 'pass' | 'reject' | 'fail' | 'timeout'; code: number | null; reason: string; durationMs: number }
export type FireContext = {
  repo: string
  base: string
  run: string | null
  cwd?: string
  out?: (line: string) => void
}

const CONTRACT_VERSION = 1
const REJECT_CODE = 10
// 핸들러가 끝난 뒤 출력 파이프가 닫히기를 기다리는 시간. 넘으면 그룹에 TERM, 같은 시간을 더 기다려 KILL 이다.
const PIPE_GRACE_MS = 2_000
const NO_REASON = '(이유 없음)'
const LOCK_POLL_MS = 500
// wx 로 만든 직후 pid 를 쓰기 전의 빈 파일을 깨진 잠금으로 회수하지 않게, 이 시간 안의 빈 파일은 쥔 것으로 본다.
const EMPTY_LOCK_GRACE_MS = 2_000
const LOG_LIMIT = 1_048_576

const GUARD_DIR = fileURLToPath(new URL('./guard', import.meta.url))
const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function insideGuard(target: string): boolean {
  return inside(real(target), real(GUARD_DIR))
}

function executable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK)
  } catch {
    return false
  }
  return isFile(file)
}

// 가드 폴더를 PATH 에 넣기 전에 진짜 실행 파일의 절대경로를 찾는다. 찾지 못하면 null.
function realBin(value: string, name: string): string | null {
  if (value.includes('/')) {
    const full = resolve(value)
    if (!insideGuard(full)) return full
    // 바깥 fire 의 핸들러가 다시 코어 명령을 불러 ORCA 가 shim 을 가리키는 경우다. shim 을 넘기면 126 으로 거부되므로 이름으로 찾는다.
    value = name
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const full = resolve(dir, value)
    if (insideGuard(full)) continue
    if (executable(full)) return full
  }
  return null
}

function handlerEnv(event: string, repo: string, root: string, checkout: string): NodeJS.ProcessEnv {
  const realOrca = realBin(orcaBin(), 'orca')
  const realGh = realBin(ghBin(), 'gh')
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ORCH_REAL_ORCA
  delete env.ORCH_REAL_GH
  if (realOrca) env.ORCH_REAL_ORCA = realOrca
  if (realGh) env.ORCH_REAL_GH = realGh
  env.ORCH_EVENT = event
  env.ORCH_REPO = repo
  env.ORCH_DIR = root
  env.ORCH_CHECKOUT = checkout
  env.ORCH_SCRIPTS = SCRIPTS_DIR
  env.PATH = process.env.PATH ? `${GUARD_DIR}${delimiter}${process.env.PATH}` : GUARD_DIR
  env.ORCA = join(GUARD_DIR, 'orca')
  env.GH = join(GUARD_DIR, 'gh')
  return env
}

function timeoutSec(event: string, repo: string, root: string): number {
  const hooks = section<{ timeouts?: unknown }>(loadConfig(repo, { file: join(root, NAMES.config) }), 'hooks', HOOKS_KEYS)
  const timeouts = hooks.timeouts
  if (timeouts === undefined) return EVENTS[event].timeoutSec
  if (typeof timeouts !== 'object' || timeouts === null || Array.isArray(timeouts)) {
    throw new ConfigError('설정 파일의 hooks.timeouts 는 이벤트 이름에서 초로 가는 객체여야 한다')
  }
  const table = timeouts as Record<string, unknown>
  const unknown = Object.keys(table)
    .filter((key) => !Object.hasOwn(EVENTS, key))
    .sort()
  if (unknown.length > 0) throw new ConfigError(`설정 파일의 hooks.timeouts 에 모르는 이벤트가 있다: ${unknown.join(', ')}`)
  const value = table[event]
  if (value === undefined) return EVENTS[event].timeoutSec
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`설정 파일의 hooks.timeouts.${event} 는 양수(초)여야 한다`)
  }
  return value
}

// 이벤트의 시간 제한(초). fire 가 쓰는 값과 같고, config.json 의 hooks.timeouts 가 틀리면 같은 ConfigError 다
export function eventTimeoutSec(event: string, repo: string): number {
  if (!Object.hasOwn(EVENTS, event)) throw new Error(`모르는 이벤트: ${event}. ${Object.keys(EVENTS).join(', ')} 중 하나다`)
  const main = mainCheckout(repo)
  return timeoutSec(event, main, orchDir(main))
}

// 잠금 ------------------------------------------------------------------

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

// 잠금 파일의 내용. 없으면 null.
function readLock(lock: string): string | null {
  try {
    return readFileSync(lock, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

function held(lock: string, content: string): boolean {
  const text = content.trim()
  if (text === '') {
    try {
      return Date.now() - statSync(lock).mtimeMs < EMPTY_LOCK_GRACE_MS
    } catch {
      return false
    }
  }
  return /^\d+$/.test(text) && alive(Number(text))
}

// 죽은 pid(깨진 내용 포함)의 잠금을 회수한다.
// 두 실행이 같은 죽은 pid 를 함께 회수하면, 읽고 지우는 방식으로는 A 가 지우고 새로 만든 잠금을 B 가 지울 수 있다.
// 그래서 잠금 파일을 고유 이름으로 rename 해 내 것으로 떼어 낸 뒤, 그 내용이 처음 읽은 값과 같은지 대조한다.
//   같다    처음 본 죽은 잠금을 떼어 낸 것이다. 지우고 wx 생성을 다시 시도한다
//   다르다  다른 실행이 먼저 회수하고 새로 만든 잠금을 떼어 낸 것이다. linkSync 로 잠금 자리에 되돌리고 다시 기다린다.
//           link 는 대상이 있으면 EEXIST 로 실패하고 덮어쓰지 않는다. rename 으로 되돌리면 그 사이 또 다른 실행이 만든 잠금을
//           덮어쓰므로 link 를 쓴다.
//           EEXIST 면 그 사이 또 다른 실행이 새 잠금을 만든 것이다. 떼어 낸 파일만 지우고 다시 기다린다.
//           이때 먼저 회수한 실행은 잠금을 잃는다. 그 실행이 핸들러를 띄우기 전이면 다시 읽기에서 알아채고 기다리지만,
//           이미 띄웠으면 두 실행이 함께 돈다(머리 주석의 「잠금」 이 적은 보장 범위)
//   없다    다른 실행이 먼저 옮겼다. wx 생성을 다시 시도한다
// wx 가 한 실행만 통과시키므로 둘이 함께 회수해도 새 잠금은 하나다.
// seen 은 부르는 쪽이 처음 읽은 내용이다.
// 사용처: 이 모듈의 핸들러 잠금(acquireLock)과 orch-loop.ts 의 state/loop.lock. 루프의 잠금도 같은 wx 와 pid 방식이라 회수를 한 벌로 둔다.
// 테스트도 import 한다. 읽은 뒤 잠금이 바뀐 경합을 seen 으로 흉내 낸다.
export function reclaim(lock: string, seen: string): 'retry' | 'wait' {
  const moved = `${lock}.reclaim-${process.pid}-${randomUUID()}`
  try {
    renameSync(lock, moved)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'retry'
    throw e
  }
  const now = readLock(moved)
  if (now !== seen) {
    try {
      linkSync(moved, lock)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  try {
    unlinkSync(moved)
  } catch {
    // 떼어 낸 파일은 이 실행만 아는 이름이다. 지우지 못해도 잠금 판정에는 영향이 없다.
  }
  return now === seen ? 'retry' : 'wait'
}

// deadline(epoch ms)까지 잠금을 얻으려 한다. 다시 읽기에서 잠금을 잃어 다시 부를 때도 처음 정한 기한을 쓴다.
// 잠금 폴더는 만들지 않는다. 부르는 쪽이 먼저 만든다(createLock 의 wx 는 폴더가 없으면 ENOENT 로 던진다).
export async function acquireLock(lock: string, deadline: number): Promise<boolean> {
  for (;;) {
    if (createLock(lock)) return true
    const seen = readLock(lock)
    if (seen === null) continue
    if (!held(lock, seen) && reclaim(lock, seen) === 'retry') continue
    if (Date.now() >= deadline) return false
    await sleep(LOCK_POLL_MS)
  }
}

export function ownsLock(lock: string): boolean {
  return (readLock(lock) ?? '').trim() === String(process.pid)
}

export function releaseLock(lock: string): void {
  try {
    if (ownsLock(lock)) unlinkSync(lock)
  } catch {
    // 이미 없거나 다른 실행이 쥐었다. 남의 잠금은 지우지 않는다.
  }
}

// 기록 ------------------------------------------------------------------

function record(root: string, entry: { event: string; handler: string; exit: number | null; result: FireResult['result']; durationMs: number; reason: string }): void {
  const file = join(root, NAMES.state, 'hooks.jsonl')
  const line = {
    time: new Date().toISOString(),
    event: entry.event,
    handler: entry.handler,
    exit: entry.exit,
    result: entry.result,
    duration_ms: entry.durationMs,
    reason: entry.reason,
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > LOG_LIMIT) renameSync(file, `${file}.1`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
  } catch (e) {
    process.stderr.write(`orch 이벤트 기록을 쓰지 못했다(${entry.event} ${entry.result}): ${file}: ${(e as Error).message}\n`)
  }
}

// 실행 ------------------------------------------------------------------

function lines(emit: (line: string) => void): { push: (chunk: Buffer) => void; end: () => void } {
  const decoder = new StringDecoder('utf8')
  let rest = ''
  const flush = (text: string) => emit(text.endsWith('\r') ? text.slice(0, -1) : text)
  return {
    push(chunk) {
      rest += decoder.write(chunk)
      let at = rest.indexOf('\n')
      while (at >= 0) {
        flush(rest.slice(0, at))
        rest = rest.slice(at + 1)
        at = rest.indexOf('\n')
      }
    },
    end() {
      rest += decoder.end()
      if (rest) flush(rest)
      rest = ''
    },
  }
}

type Outcome = { timedOut: boolean; code: number | null; error: string | null; lastLine: string }

function execute(argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number; prefix: string; out: (line: string) => void }): Promise<Outcome> {
  const signal = stopping()
  if (signal) return Promise.resolve({ timedOut: false, code: signalCode(signal), error: stoppedReason(argv, signal), lastLine: '' })
  return new Promise((done) => {
    let settled = false
    let timedOut = false
    let lastLine = ''
    let timer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    let pipeTimer: NodeJS.Timeout | undefined
    let exited: { status: number | null; signal: NodeJS.Signals | null } | null = null
    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    trackChild(child, true)
    const outLines = lines((line) => {
      if (line.trim()) lastLine = line
      opts.out(`${opts.prefix}${line}`)
    })
    const errLines = lines((line) => opts.out(`${opts.prefix}${line}`))

    const finish = (outcome: Omit<Outcome, 'lastLine'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(pipeTimer)
      outLines.end()
      errLines.end()
      done({ ...outcome, lastLine })
    }

    child.stdout.on('data', (chunk: Buffer) => outLines.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => errLines.push(chunk))
    // 핸들러가 stdin 을 읽기 전에 끝나면 EPIPE 가 난다. 결과는 종료 코드로 판정하므로 무시한다. 무시하지 않으면 코어가 죽는다.
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input)

    child.on('error', (e: NodeJS.ErrnoException) => {
      // 띄우지 못한 경우만 여기서 끝낸다(node 가 없거나 작업 디렉터리가 없다). 띄운 뒤의 오류는 close 에서 판정한다.
      if (child.pid === undefined) finish({ timedOut: false, code: e.code === 'ENOENT' ? 127 : 1, error: `${argv[0]} 를 실행하지 못했다: ${e.message}` })
    })
    // 끝 판정은 exit 가 아니라 close 로 한다. exit 직후에는 파이프에 남은 출력이 아직 out 으로 오지 않았을 수 있다.
    // 핸들러가 백그라운드 자식에게 stdout 을 넘기면 close 가 그 자식이 끝날 때까지 늦어진다.
    //   핸들러가 스스로 끝났으면 시간 제한 타이머를 지우고, PIPE_GRACE_MS 안에 close 가 없으면 그룹에 TERM 을 보낸다.
    //   다시 PIPE_GRACE_MS 뒤에도 없으면 그룹이 살아 있을 때 KILL 을 보내고 파이프를 닫는다. 종료 코드는 exit 에서 받은 값이다.
    //   시간 제한으로 끝낸 경우는 시간 제한 경로가 TERM, KILL 을 보내고 파이프를 닫는다.
    // 그룹을 벗어난 손자(setsid)가 파이프를 쥐고 있어도 마지막에 파이프를 닫으므로 close 가 온다.
    child.on('exit', (status: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut || child.pid === undefined) return
      const pid = child.pid
      exited = { status, signal }
      clearTimeout(timer)
      pipeTimer = setTimeout(() => {
        killGroup(pid, 'SIGTERM')
        pipeTimer = setTimeout(() => {
          if (groupAlive(pid)) killGroup(pid, 'SIGKILL')
          child.stdout.destroy()
          child.stderr.destroy()
        }, PIPE_GRACE_MS)
      }, PIPE_GRACE_MS)
    })
    child.on('close', (status: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) return finish({ timedOut: true, code: null, error: null })
      const end = exited ?? { status, signal }
      if (end.signal) return finish({ timedOut: false, code: signalCode(end.signal), error: null })
      finish({ timedOut: false, code: end.status ?? 1, error: null })
    })

    timer = setTimeout(() => {
      if (child.pid === undefined) return
      const pid = child.pid
      timedOut = true
      killGroup(pid, 'SIGTERM')
      killTimer = setTimeout(() => {
        if (groupAlive(pid)) killGroup(pid, 'SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
      }, killGraceMs())
    }, opts.timeoutMs)
  })
}

// 이벤트의 핸들러 파일 <orch 루트>/hooks/<이벤트>.ts. 없으면 null 이다. fire 가 부르는 파일과 같다.
// 핸들러가 없으면 입력을 만들 필요가 없어, 입력에 비싼 조회가 드는 쪽(wait-important 의 gh)이 먼저 본다.
export function handlerFile(event: string, repo: string): string | null {
  const file = handlerPath(event, orchDir(repo))
  return isFile(file) ? file : null
}

function handlerPath(event: string, root: string): string {
  return join(root, NAMES.hooks, `${event}.ts`)
}

function emptyResult(): FireResult {
  return { result: 'none', code: null, reason: '', durationMs: 0 }
}

export async function fire(event: string, input: Record<string, unknown>, ctx: FireContext): Promise<FireResult> {
  if (!Object.hasOwn(EVENTS, event)) throw new Error(`모르는 이벤트: ${event}. ${Object.keys(EVENTS).join(', ')} 중 하나다`)
  // 주 checkout 과 orch 루트를 한 번만 구해 아래에 넘긴다. pathOf, ensure, loadConfig 가 저마다 구하면 git 을 여러 번 부른다.
  const repo = mainCheckout(ctx.repo)
  const root = orchDir(repo)
  const file = handlerPath(event, root)
  const hasHandler = isFile(file)
  if (!hasHandler) return emptyResult()

  const spec = EVENTS[event]
  const seconds = timeoutSec(event, repo, root)
  const out = ctx.out ?? ((line: string) => void process.stdout.write(`${line}\n`))
  const handler = file
  const argv = [process.execPath, '--disable-warning=ExperimentalWarning', file]
  const started = Date.now()
  const finish = (result: FireResult['result'], code: number | null, reason: string): FireResult => {
    const durationMs = Date.now() - started
    record(root, { event, handler, exit: code, result, durationMs, reason })
    if (result === 'reject') out(`HOOK-REJECT ${event} ${reason}`)
    else if (result === 'fail') out(`HOOK-FAIL ${event} ${code ?? 'lock'}`)
    else if (result === 'timeout') out(`HOOK-FAIL ${event} timeout`)
    return { result, code, reason, durationMs }
  }

  const checkout = real(ctx.repo)
  const lockDir = join(root, NAMES['hooks-state'])
  mkdirSync(lockDir, { recursive: true })
  ensureIgnored(repo)
  const lock = join(lockDir, `${event}.lock`)
  // 쥔 쪽은 시간 제한과 KILL 유예 안에 끝나므로, 유예의 1.5배(기본 15초)를 더 기다린다
  const lockExtraMs = killGraceMs() * 1.5
  const deadline = Date.now() + seconds * 1000 + lockExtraMs
  try {
    let env: NodeJS.ProcessEnv
    let payload: Record<string, unknown>
    for (;;) {
      if (!(await acquireLock(lock, deadline))) {
        return finish('fail', null, `잠금을 얻지 못했다: ${lock} 를 쥔 실행이 ${seconds + lockExtraMs / 1000}초 안에 끝나지 않았다`)
      }
      env = handlerEnv(event, repo, root, checkout)
      payload = { ...input, version: CONTRACT_VERSION, event, repo, base: ctx.base, run: ctx.run, time: new Date().toISOString() }
      // 띄우기 직전에 잠금이 아직 내 것인지 다시 읽는다. 죽은 잠금을 다른 실행이 회수하다 내 새 잠금을 떼어 냈으면
      // 그 사이 또 다른 실행이 잠금을 만들었을 수 있다. 내 것이 아니면 다시 기다린다(머리 주석의 「잠금」).
      if (ownsLock(lock)) break
    }
    const outcome = await execute(argv, {
      cwd: ctx.cwd ?? repo,
      env,
      input: JSON.stringify(payload),
      timeoutMs: seconds * 1000,
      prefix: `[hook ${event}] `,
      out,
    })
    if (outcome.timedOut) return finish('timeout', null, `시간 제한 ${seconds}초를 넘겼다`)
    if (outcome.error) return finish('fail', outcome.code, outcome.error)
    if (outcome.code === 0) return finish('pass', 0, '')
    if (outcome.code === REJECT_CODE && spec.rejectable) return finish('reject', REJECT_CODE, outcome.lastLine || NO_REASON)
    return finish('fail', outcome.code, `종료 코드 ${outcome.code}`)
  } finally {
    releaseLock(lock)
  }
}

// hooks/ 바로 아래의 .ts 파일 가운데 이름이 EVENTS 에 없는 것의 경로. doctor 가 UNKNOWN-HOOK 경고에 쓴다.
// 하위 폴더는 보지 않는다. 핸들러가 import 하는 모듈을 두는 자리(예: hooks/lib/)라 경고하면 안 된다.
export function unknownHandlers(repo: string): string[] {
  const dir = pathOf('hooks', repo)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.name.endsWith('.ts') && isFile(join(dir, entry.name)))
    .filter((entry) => !Object.hasOwn(EVENTS, basename(entry.name, '.ts')))
    .map((entry) => join(dir, entry.name))
    .sort()
}

