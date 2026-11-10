// 큐 실행 상태와 제어 오류. 단계 사이에서 같은 정의를 쓴다.

import { scriptPath } from '../../lib/commands.ts'
import type { ConfigError } from '../../lib/config.ts'
import { FAILED_CONCLUSIONS, FAILED_STATES } from '../../lib/gh.ts'

// 첫 판정 뒤에 base 가 움직여 다시 판정하는 횟수의 상한. 넘으면 멈춘다
export const REJUDGE_LIMIT = 5
export const DOCS_ONLY_NOTE = '--docs-glob 은 hooks/after-queue.ts 나 hooks/verify-merged.ts 와 함께 쓴다(--up-to-date-when overlap 과도 쓴다)'
// 사본 이름(merge-queue-pr<PR>-<pid>)을 찾는 glob `merge-queue-pr[0-9]*-[0-9]*` 와 같다
export const COPY_NAME = /^merge-queue-pr[0-9].*-[0-9].*$/s
// 머지 큐가 내는 이벤트다.
export const QUEUE_EVENTS = ['before-merge', 'verify-merged', 'after-merge', 'after-queue'] as const
export type QueueEvent = (typeof QUEUE_EVENTS)[number]
export type GhPr = { number: number; author: { login: string } | null; url: string }

// 롤업에 나타난 체크 이름(체크 실행은 name, 커밋 상태는 context)
export const ROLL_NAMES = '[.statusCheckRollup[] | (.name // .context)]'
export const ROLL_NAMES_NO_SKIPPED = '[.statusCheckRollup[] | select((.conclusion // "") != "SKIPPED") | (.name // .context)]'
export const PENDING =
  '[.statusCheckRollup[] | select((.status // "COMPLETED") != "COMPLETED" or (.state // "") == "PENDING" ' +
  'or (.state // "") == "EXPECTED")] | length'
// 롤업의 마지막 끝난 시각. 체크 실행은 completedAt, 커밋 상태는 startedAt 이다. 시각이 없는 체크가 하나라도 있으면 빈 값이다
export const SETTLED_JQ =
  '[.statusCheckRollup[] | (.completedAt // .startedAt // "")] | ' +
  'if length == 0 or any(.[]; . == "" or startswith("0001-")) then "" else max end'
// 도는 체크 가운데 가장 먼저 시작한 시각. 없으면 빈 값이다
export const RUNNING_SINCE_JQ =
  '[.statusCheckRollup[] | select((.status // "COMPLETED") != "COMPLETED" or (.state // "") == "PENDING") | (.startedAt // "")] | ' +
  'map(select(. != "" and (startswith("0001-") | not))) | if length == 0 then "" else min end'
// 체크가 끝난 뒤 새 체크가 붙는지 다시 보기 전에 기다리는 초. waitChecks 의 nap(60) 과 같다
export const SETTLED_SEC = 60
// 실패 판정의 목록은 상주 루프와 한 벌이다(lib/gh.ts 머리 주석의 「필수 체크 판정」)
export const FAIL_SEL =
  `select(((.conclusion // "") | test("${FAILED_CONCLUSIONS.join('|')}")) ` + `or ((.state // "") | test("${FAILED_STATES.join('|')}")))`

// 사용법 오류. 종료 코드 2 로 끝난다. 메시지가 비면 머리 주석을 찍는다
export class Usage extends Error {}

// PR 하나가 조건에 못 미쳐 멈춘다. 종료 코드 1 이고 --stop-on-hold 가 아니면 다음 PR 로 간다
export class Stop extends Error {}

export class HeadChanged extends Stop {}

// 필수 체크를 기다리다 넘지 못한 보류(실패, 대기 초과, 나타나지 않음). 다른 보류 이유와 한 번에 내려고 이유(reason)를 따로 둔다.
// 메시지는 `<PR> <이유>` 다. 머지 큐는 이것을 잡아 스레드, 충돌, 근거 블록의 이유를 함께 모아 STOP 한다(steps/gate.ts)
export class CheckStop extends Stop {
  reason: string
  constructor(n: string, reason: string) {
    super(`${n} ${reason}`)
    this.reason = reason
  }
}

// PR 하나가 base 와 충돌한다. 머리 주석의 「충돌」 대로 큐에서 빼고 다음 PR 로 간다
export class Conflict extends Stop {}

// worker 가 고쳐야 하는 보류. 머리 주석의 「보류」 대로 그 PR 의 살아 있는 worker 에게 이유를 보낸다. why 가 보낼 이유다
export class WorkerFix extends Stop {
  why: string
  retryable: boolean
  constructor(message: string, why: string, retryable = false) {
    super(message)
    this.why = why
    this.retryable = retryable
  }
}

// 차례 PR 이 update-branch 뒤 체크를 기다려야 한다. 머리 주석의 「앞지르기」 대로 그 대기를 미룬다. Stop 이 아니다
export class Deferred extends Error {
  n: string
  files: string[]
  constructor(n: string, files: string[]) {
    super(`${n} 앞지르기`)
    this.n = n
    this.files = files
  }
}

// 앞지르기 시도에서 PR 이 아직 준비되지 않았다(체크가 돌거나 최신화가 필요하거나 미룬 PR 과 겹친다). 그 PR 은 제 차례에 다시 본다
export class NotReady extends Error {}

export type Mode = 'normal' | 'defer' | 'quick'
export type Attempt =
  | { kind: 'merged' }
  | { kind: 'held'; reason: string; retryable?: boolean }
  | { kind: 'config'; error: ConfigError }
  | { kind: 'deferred'; deferred: Deferred }
  | { kind: 'not-ready'; reason: string }

export type Options = {
  repo: string
  method: string
  threadsCmd: string
  checkTimeout: string
  missingTimeout: string
  required: string[]
  allowFail: string[]
  upToDate: boolean
  upToDateWhen: string
  sharedPaths: string
  unitPrefix: string
  unitGroups: string[]
  keepBranch: boolean
  sweep: boolean
  sweepArgs: string[]
  overlap: boolean
  verifyWhen: string
  docsGlob: string
  updateDocs: boolean
  continueOnHold: boolean
  pollMinSec: string
  pollMaxSec: string
  ciExpectedSec: string
  skippedMissing: boolean
  copyDir: string
  lastOfTask: string[]
  chains: string[][]
  items: string[]
}

// PR 하나를 처리하는 동안 쓰는 값
export type Pr = {
  n: string
  ph: string
  branch: string
  cross: boolean
  apiHost: string
  owner: string
  repo: string
  base: string
  beforeHead: string | null
  judgments: number
  judgedBase: string | null
  ov: string[]
  title: string | null
  author: string | null
  draft: boolean
  url: string
}

export class StepState {
  o: Options
  overlapUnits: string
  sweepBase = ''
  // [번호, code|docs]. after-queue 입력을 만들 때 읽는다
  merged: [string, 'code' | 'docs'][] = []
  held: string[] = []
  // 충돌로 뺀 PR. held 에도 든다
  conflicted: string[] = []
  copy = ''
  afterFailed = false
  // after-merge 가 실패하거나 시간을 넘겼다. 모두 머지했으면 종료 코드 3 이다
  notifyFailed = false
  // 주 checkout 이 아니라 --repo 로 옮겨 간 작업 디렉터리다. 이벤트의 repo 와 핸들러 위치는 fire 가 이것으로 정한다
  repoDir = ''
  // 큐를 시작할 때 있던 핸들러 파일의 이벤트. 입력에 조회가 드는 이벤트(after-merge)와 검사를 켜는 이벤트(verify-merged)가 본다
  hooks = new Set<QueueEvent>()
  // 합친 사본 검사를 하는가. hooks/verify-merged.ts 가 있으면 한다
  verify = false
  // 호스트마다 「내 PR」 작성자 목록. null 은 정하지 못한 것이다
  authors = new Map<string, string[] | null>()
  realTmp = ''
  copyDir = ''
  ghRetries = 3
  ghRetrySeconds = 10
  pr: Pr | null = null
  q: { missing: string; failed: string; allowedFailed: string } = { missing: '', failed: '', allowedFailed: '' }
  // 차례 기록(lib/queue-turn.ts)의 prs. 차례 PR 부터 큐 끝까지다
  remaining: number[] = []
  turnWarned = false
  // 처음 쓴 차례 기록의 경로. 다음부터는 폴더와 git 무시 확인 없이 바로 쓴다
  turnPath = ''
  // 차례 기록의 held. 뺀 PR 과 이유다
  heldReasons: { pr: number; reason: string }[] = []
  // processPr 의 방식. defer 는 update-branch 뒤 대기를 미루고, quick 은 기다리지 않고 바로 머지할 수 있을 때만 머지한다
  mode: Mode = 'normal'
  // 앞지르기 중이면 미룬 차례 PR 이 바꾼 파일. quick 의 PR 이 이것과 겹치면 앞지르지 않는다
  against: { n: string; files: string[] } | null = null
  // 마지막 재판정에서만 CI 대기를 최대 5분으로 줄인다. 보통 차례의 대기 설정은 그대로다.
  rechecking = false
  recheckWaited = 0
  retryItems = new Set<string>()

  constructor(opts: Options) {
    this.o = opts
    this.overlapUnits = process.env.OVERLAP_UNITS ?? scriptPath('overlap_units')
  }

  get p(): Pr {
    if (!this.pr) throw new Error('처리 중인 PR 이 없다')
    return this.pr
  }

}

export type StepContext = { script: string; here: string; sleepScale: number }
// 단계는 최종 상태 조각과 결과를 함께 돌려준다. 신호 정리가 읽는 진행 상태는 같은 객체에 즉시 반영한다.
export type StepResult<T extends object = {}> = T & { changes: Partial<StepState> }

export type SelectionResult = StepResult<{ kind: 'config'; error: ConfigError } | { kind: 'held' } | { kind: 'done' }>
