// 자동 머지(ADR-016): queue.auto_merge 가 true 이고 열린 PR 을 읽은 틱에만 돈다. PR 하나의 판정은 core/merge-readiness.ts 의 조건 표가 소유하고,
//     이 단계는 읽기, 기록, 띄우기만 한다. 큐는 저장소에 하나만 둔다. 두 큐가 같은 base 를 움직이면 서로의 최신화 판정이 무효가 된다.
//     큐를 건 뒤의 판정(필수 체크, 스레드, mergeable)은 머지 큐가 다시 한다. 여기 판정은 멈출 큐를 걸지 않으려는 앞 단계다.
//     업무의 마지막 PR 표시(!, ~)는 붙이지 않는다. 마무리가 ADR-014 대로 판정한다.
//     기록은 state/auto-merge.json 이다(ready, tried, clashes, blocked, queue. 형식은 docs/data-schema.md). 없거나 깨졌으면 빈 기록이고,
//     단계가 끝날 때 옆 파일에 쓰고 rename 한다. 쓰지 못하면 로그에 남기고, 단계가 예외 없이 끝났으면 오류 이유로 낸다. 큐 로그는 state/auto-merge/<YYYYMMDDTHHMMSSZ>.log 다. queue 폴더에 두면 틱의 정리(cleanup.ts)가
//     끝난 로그를 휴지통으로 옮겨(lib/queue-logs.ts) 끝 줄을 읽기 전에 사라진다.
//     1. 기록에서 이번 틱의 내 열린 PR 이 아닌 PR 의 ready, blocked 항목과 tried, clashes 의 `<PR>@…` 키를 지운다.
//        오래된 로그는 정기 정리(cleanup/steps/state.ts)에서 휴지통으로 옮긴다.
//     2. PS -Ao pid=,command= 를 읽는다. 0 이 아니면 `프로세스 목록을 읽지 못했다` 로 단계를 끝낸다.
//        queue 기록의 pid 줄이 없거나 그 명령줄에 `merge-with-finish.` 가 없으면 끝난 큐다. pid 를 다른 프로세스가 다시 받았을 수 있어
//        살아 있는지만으로 보지 않는다. 끝 줄은 로그에서 QUEUE-DONE, QUEUE-HELD 로 시작하는 마지막 줄, 없으면 `STOP ` 으로 시작하는
//        마지막 줄, 그것도 없으면 `끝 줄 없음` 이다. 머지 큐는 끝 줄 뒤에 after-queue 와 정리 출력을 같은 로그에 이어 쓰므로 마지막 줄이 끝 줄이 아니다.
//        merge-with-finish 가 큐를 걸기 전에 끝나면(사용법 오류, 마무리를 띄우지 못함) 끝 줄은 `끝 줄 없음` 이고 이유는 로그에 있다.
//        AUTO-MERGE-END(pr null, text `<끝 줄> log=<로그>`. 로그를 읽지 못하면 끝 줄 자리에 `로그 없음`)를 기록의 run 으로 쓰고 기록을 비운다.
//        큐가 실행권을 잡지 못해 아무것도 걸지 않고 끝났으면(로그에 QUEUE-DUP 나 QUEUE-CLAIM-FAIL 줄이 있다. lib/pr-claim.ts) 끝 줄은 그 마지막 줄이고,
//        그때 건 PR 의 tried 를 모두 지워 다음 틱이 다시 판정한다. QUEUE-DUP 줄에 나온 PR 도 지운다. 그 PR 을 쥔 큐도 다른 PR 에서 막혀
//        물러났을 수 있어, 아무도 맡지 않은 PR 이 `이미 건 HEAD` 로 남는다(PR 558, PR 568 리뷰). 쥔 큐가 도는 동안에는 아래 큐 확인이 다시 걸기를 막는다
//        아직 돌면 이 틱에는 걸지 않는다. 명령줄에 `merge_queue.`, `merge-queue.sh`, `merge-with-finish.` 가 든 줄이 있어도 걸지 않는다.
//        머신 전체를 보므로 다른 저장소의 큐나 테스트 실행도 막는다. 거는 쪽으로는 틀리지 않아 그대로 둔다
//        걸지 않은 틱에는 큐가 무엇을 기다리는지 로그에 한 줄씩 쓴다. 명령줄에 `merge_queue.` 가 든 프로세스의 차례 기록(lib/queue-turn.ts)마다
//        `AUTO-MERGE-HELD pid <pid> #<차례 PR> <단계> <분>분 남은 #a #b` 이고, 차례 기록이 하나도 없으면 도는 큐 프로세스마다
//        `AUTO-MERGE-HELD pid <pid> 차례 기록 없음: <명령줄 앞 160자>` 다. 코디네이터가 따로 건 큐가 자동 머지를 막을 때 무엇을 기다리는지
//        loop.log 로 알게 하려는 것이다. Run 메시지로는 보내지 않는다. 도는 큐에 PR 을 덧붙이지 않는 이유는 docs/adr/020-orch-loop-refresh.md 에 있다
//     3. 대상: Run id 와 지시서 폴더가 둘 다 있는 Run 의 지시서(lib/last-pr.ts 의 specFiles)의 `브랜치:` 줄에 든 내 열린 PR 이다.
//        같은 브랜치는 앞 Run 의 것이다. Run id 가 없는 칸은 큐의 --run 과 알림의 Run 을 정할 수 없어 보지 않는다.
//        보드 파일이 있으면 한 번 읽는다. 읽지 못하면 `보드를 읽지 못했다: <이유>` 로 걸지 않는다. 보류 표시를 놓친 채 걸지 않으려는 것이다.
//        판정은 lib/merge-readiness.ts 의 checkReadiness(light, auto, stopAtFirst, skip: migration)다. 조건, 순서, 대기 문구는
//        core/merge-readiness.ts 의 조건 표가 소유한다(ADR-037). 처음 걸린 이유의 wait 로 `AUTO-MERGE-WAIT #<PR> <wait>` 를 로그에만 쓰고 넘어간다.
//        이 단계가 넘기는 값(known)은 아래다. 그 밖의 값(봇 영수증)은 checkReadiness 가 읽는다.
//        - 체크: 이번 틱의 롤업(OwnPr.rollup)을 CI 감시가 읽은 필수 체크 이름(ciNames)으로 판단한다(core/checks.ts 의 currentChecks).
//          CI 감시의 기록(ci)은 보지 않는다. 그 PR 의 base 규칙을 읽지 못했으면 `CI 규칙을 읽지 못했다`, 이번 틱에 이름이 없으면 `CI 없음` 이다.
//        - 지시서 보류: lib/auto-merge.ts 의 specHold. 이유에 비공개 낱말(lib/private-words.ts 의 목록)이 있으면 위치로 바꾼다(redactLine).
//        - 보드 항목: 위에서 한 번 읽은 목록.
//        - 미해결 스레드: THREADS_CMD(없으면 defaultThreadsCmd)를 저장소 폴더에서 OWNER, REPO, PR, GH_HOST 로 돌린다. 숫자가 아니면 조회 실패다.
//        - PR 본문 보류와 리뷰 체크: gh pr view --json statusCheckRollup,files,body,headRefOid 한 번을 나눠 쓴다. 본문 보류도 redactLine 을 거친다.
//          그 조회의 files 는 4 의 마이그레이션 판정에 쓴다.
//        리뷰 판정 규칙은 core/auto-merge.ts 머리 주석의 「judgeReview」 가 소유한다. 리뷰 댓글의 문구는 보지 않는다.
//        영수증도 리뷰 체크 성공도 없어 멈추면(review-missing) unreviewed[<PR>@<HEAD>] 가 없을 때만 AUTO-MERGE-NO-REVIEW 를 그 PR 지시서의 Run 으로 쓰고 기록한다.
//        text 는 `HEAD <앞 8자리> 에 <없는 것>이 없다. 봇 영수증이나 리뷰 체크가 이 HEAD 에 생기면 다음 틱이 건다` 다.
//        리뷰가 결과 없이 실패한 PR 을 코디네이터가 알게 하려는 것이다.
//        통과하면 리뷰 판정의 근거를 둔다. 리뷰 설정이 없으면 근거는 `queue.auto_review 없음` 이다.
//        기능 PR(지시서의 「루프를 쓴다」)은 리뷰 설정이 없으면 걸지 않고 기다린다(조건 표의 review-config, compat featureOnly)
//        스레드 명령이나 gh 조회가 실패하면(wait 가 없는 조회 실패) 그 읽기가 만든 문구를 오류 이유로 남기고 그 PR 은 넘어간다.
//        마무리(finish-<PR>.pid)가 살아 있는지는 보지 않는다. 마무리는 머지를 180분까지 기다려 큐가 그 PR 을 보류한 뒤에도 살아 있다.
//        merge-with-finish 는 도는 마무리를 그대로 쓰므로 다시 걸어도 마무리가 겹치지 않는다.
//        통과한 PR 은 ready[<PR>] 에 {head, at} 를 둔다. 같은 HEAD 면 at 을 그대로 둔다. at 이 큐 순서의 준비 시각이다
//     4. 마이그레이션: 준비된 PR 이 더한 파일(lib/reservations.ts 의 addedPaths. changeType 이 ADDED, RENAMED, COPIED 이거나 없는 행)에
//        migrationOf 가 있으면, 마이그레이션 번호 예약(ADR-017, lib/reservations.ts 의 readReservations. 잠금 없이 읽는다)과
//        PR 의 base 마다 git fetch --quiet origin <base> 와 모듈 폴더마다 git ls-tree -r --name-only origin/<base> 로 base 의 최고 번호를,
//        gh pr list --state open --limit 200 --json number,headRefName,baseRefName,files 로 같은 base 의 열린 PR 의 번호와
//        브랜치마다의 열린 PR 번호를 읽는다. 예약과 브랜치마다의 번호는 base 에 묶이지 않아 모든 base 에 같은 값을 쓴다.
//        실패하면 오류 이유(예약은 `마이그레이션 예약을 읽지 못했다: <이유>`)로 남기고 마이그레이션이 있는 PR 은 이 틱에 걸지 않는다.
//        형식이 틀린 예약 항목이 있으면(readReservations 의 skipped) `마이그레이션 예약 <n> 개의 형식이 틀렸다. reserve-migration.ts --prune 으로 뺀다`,
//        열린 PR 조회가 200 줄 이상이면 `열린 PR 이 200 개 이상이라 마이그레이션 목록이 잘렸을 수 있다` 로 같게 다룬다. 버린 예약이나 잘린 PR 의 번호를 놓친 채 높은 번호 PR 을 걸지 않으려는 것이다.
//        예약 가운데 그 PR 브랜치의 것과, 예약한 브랜치의 열린 PR 이 같은 (모듈, 번호)를 이미 더한 것은 뺀다(lib/auto-merge.ts 의 reservedFor).
//        judgeMigrations 의 clash 가 있으면 걸지 않는다. 이유는 `<모듈> <label>: <이유>` 를 `; ` 로 이은 것이고, clashes[<PR>@<HEAD>] 와
//        다를 때만 MIGRATION-CLASH(pr 그 PR, text 그 이유)를 그 PR 지시서의 Run 으로 쓴다.
//        lower 가운데 걸 후보(clash 가 없는 준비된 PR)에 없는 PR 이나 예약이 있으면 걸지 않는다. 예약은 걸 후보에 들 수 없어 늘 기다린다.
//        blocked[<PR>] 에 {head, since, fired} 를 둔다(같은 HEAD 면 since 를 둔다). 막는 쪽 이름은 PR 이면 `#<PR> <label>`, 예약이면
//        `<브랜치> 의 예약 <label>` 이다. since 에서 migrations.blocked_after_sec 가 지났고 fired 가 아니면 MIGRATION-BLOCKED(pr 기다리는 PR, text
//        `<모듈> <label> 이 <막는 쪽> 을 <분>분 기다린다. 막는 쪽 worker 가 reserve-migration.ts --again 으로 번호를 다시 받는다.
//        막는 브랜치를 버렸으면 지운 뒤 reserve-migration.ts --prune`)를 쓰고 fired 를 둔다. 아니면 `AUTO-MERGE-WAIT #<PR> <모듈> <label> 이
//        <막는 쪽> 을 기다린다` 를 로그에 쓴다.
//        막힘이 풀린 PR 과 이번 틱의 걸 후보가 아닌 PR 의 항목은 지운다. 기다리던 PR 이 준비에서 빠졌다 같은 HEAD 로 돌아와도
//        옛 since 로 바로 알리지 않게 한다. migrations.before 에 그 모듈의 명령이 없으면(beforeCommand)
//        `#<PR> 의 모듈 <모듈> 에 migrations.before 규칙이 없다` 로 걸지 않는다
//     5. 순서: queueOrder 로 정하고 첫 PR 의 Run 의 PR 만 남긴다. 빠진 PR 이 lower 인 PR 도 빼고, 남는 집합이 바뀌지 않을 때까지
//        queueOrder 부터 되풀이한다. 되풀이로 빠진 PR 은 blocked 에 두지 않고 다음 틱에 다시 본다. 묶음은 남은 PR 로 줄이고 둘 미만이면 뺀다
//     6. 띄우기: 직전에 2 의 프로세스 목록을 한 번 더 읽어, 도는 큐가 있으면 띄우지 않고 2 와 같은 AUTO-MERGE-HELD 줄을 쓴다. 판정하는 사이 코디네이터가 큐를 걸었을 수 있다.
//        MERGE_WITH_FINISH --repo <repo> --run <Run> --continue-on-hold [--chain a,b]... [--sweep-arg <값>]... <PR>[:<머지 전 명령>]... 를
//        작업 디렉터리 repo, stdin 무시, stdout 과 stderr 는 큐 로그로 분리(detached, unref)해 띄운다. --sweep-arg 는 queue.sweep_args 가
//        목록일 때 sweepArgs 로 --run 을 큐의 Run 으로 맞춘 항목이다. 머지 전 명령은 beforeCommand 의 명령이다.
//        띄웠으면 queue 기록에 {pid, log, run, prs, at}, tried[<PR>@<HEAD>] 에 지금 시각을 두고, 건 PR 마다
//        `AUTO-MERGE-BASIS #<PR> HEAD <앞 8자리> <3 의 근거>` 를 로그에 쓴 뒤 AUTO-MERGE(pr null,
//        text `#<a> #<b> run=<Run> log=<로그>`)를 그 Run 으로 쓰고 같은 줄을 로그에도 쓴다. 어느 판정으로 걸었는지 나중에 로그로 확인하려는 것이다.
//     오류 이유는 `; ` 로 이어 errors 의 auto-merge 에 둔다(errors.ts 머리 주석의 「오류 줄 억제」). 바꿀 수 있는 명령은 orch-loop.ts 머리 주석의 「환경 변수」 의
//     MERGE_WITH_FINISH, THREADS_CMD, PS 다.

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentChecks } from '../../core/checks.ts'
import { isObject } from '../../core/json.ts'
import type { Fact, Facts } from '../../core/merge-readiness.ts'
import { beforeCommand, prHold, judgeMigrations, maxByModule, migrationOf, queueOrder, reservedFor, sweepArgs, watchedDirs } from '../../lib/auto-merge.ts'
import type { Migration, MigrationJudgement, OpenMigrations, ReservedMigrations } from '../../lib/auto-merge.ts'
import { readBoard } from '../../lib/board.ts'
import type { BoardItem } from '../../lib/board.ts'
import { orchWord, scriptPath } from '../../lib/commands.ts'
import { featureLoopRequested } from '../../lib/feature-evidence.ts'
import { isFile } from '../../lib/fs.ts'
import { ghJson } from '../../lib/gh.ts'
import { git } from '../../lib/git.ts'
import { checkReadiness, defaultThreadsCmd } from '../../lib/merge-readiness.ts'
import type { PrTarget } from '../../lib/merge-readiness.ts'
import { specTargets } from '../../lib/spec-targets.ts'
import { boardPath } from '../../lib/board-file.ts'
import { makeParent, pathOf } from '../../lib/paths.ts'
import { run as runSync, scriptCommand } from '../../lib/proc.ts'
import { turnLine } from '../../lib/queue-turn.ts'
import { isQueueCommand } from '../../lib/queue-process.ts'
import type { PrivateWord } from '../../lib/private-words.ts'
import { readPrivateWords, redactLine } from '../../lib/private-words.ts'
import { addedPaths, readReservations } from '../../lib/reservations.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import type { Context, StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { processes, queueTurns } from './queue-turns.ts'
import type { Proc } from './queue-turns.ts'
import { iso, lines, log, oneLine } from './shared.ts'
import type { OwnPr, TickRun } from './shared.ts'

// 진입 파일(orch-loop.ts)이 있는 loop 폴더. 기본 스레드 명령(lib/merge-readiness.ts 의 defaultThreadsCmd)의 경로를 잇는 데 쓴다
const LOOP_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

// AUTO-MERGE-HELD 줄에 옮기는 명령줄의 앞 글자 수
const HELD_COMMAND_CHARS = 160

// 마이그레이션을 보는 열린 PR 조회의 최대 줄 수. 이만큼 오면 잘렸을 수 있다(머리 주석의 「자동 머지」 4)
const MIGRATION_PR_LIMIT = 200

type Ready = { head: string; at: string }

type Blocked = { head: string; since: string; fired: boolean }

type QueueRecord = { announced?: boolean; pid: number; log: string; run: string; prs: number[]; at: string }

// state/auto-merge.json(머리 주석의 「자동 머지」, docs/data-schema.md)
type AutoMergeState = {
  ready: Record<string, Ready>
  tried: Record<string, string>
  clashes: Record<string, string>
  // `<PR>@<HEAD>` 에서 AUTO-MERGE-NO-REVIEW 를 쓴 시각으로. 같은 HEAD 는 다시 알리지 않는다
  unreviewed: Record<string, string>
  blocked: Record<string, Blocked>
  queue: QueueRecord | null
}

// 판정을 통과한 PR. run 은 그 PR 지시서의 Run 이다
// basis 는 리뷰 판정의 통과 근거다. 큐를 걸 때 AUTO-MERGE-BASIS 줄로 로그에 남긴다
type Candidate = { pr: OwnPr; run: string; migrations: Migration[]; basis: string }

function autoMergeFile(repo: string): string {
  return join(pathOf('state', repo), 'auto-merge.json')
}

// 형식이 맞는 항목만 남긴다
function pickEntries<T>(value: unknown, ok: (entry: unknown) => boolean): Record<string, T> {
  const found: Record<string, T> = {}
  if (isObject(value)) for (const [key, entry] of Object.entries(value)) if (ok(entry)) found[key] = entry as T
  return found
}

function queueRecord(value: unknown): QueueRecord | null {
  if (!isObject(value) || !Number.isInteger(value.pid) || typeof value.log !== 'string' || typeof value.run !== 'string' || typeof value.at !== 'string') return null
  if (!Array.isArray(value.prs) || !value.prs.every((n) => Number.isInteger(n))) return null
  return { ...(typeof value.announced === 'boolean' ? { announced: value.announced } : {}), pid: value.pid as number, log: value.log, run: value.run, prs: value.prs as number[], at: value.at }
}

// 파일이 없거나 깨졌으면 빈 기록이다
function readAutoMerge(file: string): AutoMergeState {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // 없거나 깨졌다
  }
  const raw = isObject(parsed) ? parsed : {}
  const text = (entry: unknown) => typeof entry === 'string'
  return {
    ready: pickEntries<Ready>(raw.ready, (e) => isObject(e) && typeof e.head === 'string' && typeof e.at === 'string'),
    tried: pickEntries<string>(raw.tried, text),
    clashes: pickEntries<string>(raw.clashes, text),
    unreviewed: pickEntries<string>(raw.unreviewed, text),
    blocked: pickEntries<Blocked>(raw.blocked, (e) => isObject(e) && typeof e.head === 'string' && typeof e.since === 'string' && typeof e.fired === 'boolean'),
    queue: queueRecord(raw.queue),
  }
}

// lib/loop.ts 의 replace 와 같다. 옆 파일에 쓰고 rename 한다
function writeAutoMerge(file: string, repo: string, state: AutoMergeState): void {
  if (!existsSync(file)) makeParent(file, repo)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 1)}\n`)
  renameSync(temporary, file)
}

// 이번 틱의 내 열린 PR 이 아닌 PR 의 항목을 지운다(머리 주석의 「자동 머지」 1)
function pruneAutoMerge(state: AutoMergeState, open: Set<string>): void {
  for (const map of [state.ready, state.blocked]) for (const key of Object.keys(map)) if (!open.has(key)) delete map[key]
  for (const map of [state.tried, state.clashes, state.unreviewed]) {
    for (const key of Object.keys(map)) {
      const at = key.indexOf('@')
      if (at < 0 || !open.has(key.slice(0, at))) delete map[key]
    }
  }
}

function queueRunning(list: Proc[]): boolean {
  return list.some((p) => isQueueCommand(p.command))
}

// 도는 큐 때문에 이 틱의 자동 머지를 미룬다. 큐가 무엇을 기다리는지 로그에 한 줄씩 남긴다(머리 주석의 「자동 머지」 2)
function logHeld(repo: string, list: Proc[]): void {
  const turns = queueTurns(repo, list)
  if (turns.length > 0) {
    for (const turn of turns) log(`AUTO-MERGE-HELD ${turnLine(turn, Date.now())}`)
    return
  }
  for (const p of list.filter((row) => isQueueCommand(row.command))) {
    log(`AUTO-MERGE-HELD pid ${p.pid} 차례 기록 없음: ${p.command.slice(0, HELD_COMMAND_CHARS)}`)
  }
}

// 끝난 큐 로그의 끝 줄(머리 주석의 「자동 머지」 2)
function queueEndLine(file: string): string {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return '로그 없음'
  }
  const rows = text.split(/\r?\n/)
  return (
    rows.findLast((line) => line.startsWith('QUEUE-DONE') || line.startsWith('QUEUE-HELD')) ??
    rows.findLast((line) => line.startsWith('STOP ')) ??
    rows.findLast((line) => NOT_ADMITTED.test(line)) ??
    '끝 줄 없음'
  )
}

// 큐가 실행권을 잡지 못해 아무것도 걸지 않고 끝났을 때 로그에 남는 줄(lib/pr-claim.ts 의 refusal)
const NOT_ADMITTED = /^(QUEUE-DUP|QUEUE-CLAIM-FAIL)\b/

// 걸지 못하고 끝난 큐가 건 PR 의 tried 를 모두 지운다(머리 주석의 「자동 머지」 2)
function forgetNotAdmitted(state: AutoMergeState, queue: QueueRecord): void {
  let rows: string[]
  try {
    rows = readFileSync(queue.log, 'utf8').split(/\r?\n/)
  } catch {
    return
  }
  if (!rows.some((line) => NOT_ADMITTED.test(line))) return
  for (const n of queue.prs) {
    for (const key of Object.keys(state.tried)) if (key.startsWith(`${n}@`) && state.tried[key] === queue.at) delete state.tried[key]
  }
}

// 더한 파일의 마이그레이션. 더한 파일은 lib/reservations.ts 의 addedPaths 가 고른다(머리 주석의 「자동 머지」 4)
function addedMigrations(files: unknown, dirs: Record<string, string | string[]>): Migration[] {
  const found: Migration[] = []
  for (const path of addedPaths(files)) {
    const migration = migrationOf(path, dirs)
    if (migration) found.push(migration)
  }
  return found
}

// 판정(머리 주석의 「자동 머지」 3). 조건과 순서는 core/merge-readiness.ts 의 조건 표가 소유하고, 여기서는 틱이 읽은 값과 루프의 읽기 함수를 넘긴다.
// wait 은 AUTO-MERGE-WAIT 의 이유, error 는 오류 이유다. missing 은 봇 영수증도 리뷰 체크 성공도 없어 멈췄다는 뜻이다. AUTO-MERGE-NO-REVIEW 를 낸다
async function judgeTarget(
  ctx: Context,
  pr: OwnPr,
  hold: string | null,
  feature: boolean,
  names: string[] | undefined,
  stale: Set<number>,
  state: AutoMergeState,
  items: BoardItem[],
  words: PrivateWord[] = [],
): Promise<{ wait: string; missing?: boolean } | { error: string } | { migrations: Migration[]; basis: string }> {
  // 루프의 읽기 함수가 만든 실패 문구. checkReadiness 는 이유 문구를 비공개 낱말로 가리므로 오류 줄에는 이 원문을 쓴다
  let failure: string | null = null
  const failed = (error: string): { ok: false; error: string } => {
    failure = error
    return { ok: false, error }
  }
  const checks: Fact<Facts['checks']> = stale.has(pr.number)
    ? { ok: false, error: 'CI 규칙을 읽지 못했다', wait: 'CI 규칙을 읽지 못했다' }
    : names === undefined
      ? { ok: false, error: 'CI 없음', wait: 'CI 없음' }
      : { ok: true, value: currentChecks(pr.rollup, pr.head) }
  const threads = (): Fact<string> => {
    const [owner, name] = pr.slug.split('/')
    const command = process.env.THREADS_CMD || defaultThreadsCmd(LOOP_DIR)
    const got = runSync(['bash', '-c', command], { cwd: ctx.repo, env: { OWNER: owner, REPO: name, PR: String(pr.number), GH_HOST: pr.host } })
    const count = got.stdout.trim()
    if (got.code !== 0 || !/^\d+$/.test(count)) {
      return failed(`#${pr.number} 의 미해결 스레드를 읽지 못했다(종료 코드 ${got.code}): ${oneLine((got.stderr || got.stdout).trim())}`)
    }
    return { ok: true, value: String(Number(count)) }
  }
  // 본문 보류, 리뷰 체크, 마이그레이션 파일을 한 번의 조회로 읽는다
  let view: { ok: true; data: Record<string, unknown> } | { ok: false; error: string } | undefined
  const viewed = () => {
    if (view === undefined) {
      const got = ghJson<unknown>(['pr', 'view', String(pr.number), '--json', 'statusCheckRollup,files,body,headRefOid'], { cwd: ctx.repo })
      view = got.ok ? { ok: true, data: isObject(got.data) ? got.data : {} } : { ok: false, error: `#${pr.number} 의 리뷰와 파일을 읽지 못했다: ${oneLine(got.error)}` }
    }
    return view
  }
  const holdBody = (): Fact<string | null> => {
    const got = viewed()
    if (!got.ok) return failed(got.error)
    const body = got.data.body
    const found = typeof body === 'string' ? prHold(body) : null
    return { ok: true, value: found === null ? null : redactLine(found, words, 'PR 본문', body as string) }
  }
  const reviewRollup = (): Fact<unknown> => {
    const got = viewed()
    return got.ok ? { ok: true, value: got.data.statusCheckRollup } : failed(got.error)
  }
  const target: PrTarget = { repo: ctx.repo, number: pr.number, head: pr.head, base: pr.base, branch: pr.branch, host: pr.host, slug: pr.slug, draft: pr.draft }
  const readiness = await checkReadiness(
    target,
    { scope: 'light', auto: { attempted: Object.hasOwn(state.tried, `${pr.number}@${pr.head}`) }, stopAtFirst: true, skip: ['migration'], compat: { featureOnly: { feature } } },
    {
      known: { checks, specHold: { ok: true, value: hold }, boardItems: { ok: true, value: items }, threads, holdBody, reviewRollup },
      required: names ?? [],
      allowNoChecks: false,
    },
  )
  const first = readiness.reasons[0]
  if (first) {
    if (first.wait === undefined) return { error: failure ?? first.text }
    return first.code === 'review-missing' ? { wait: first.wait, missing: true } : { wait: first.wait }
  }
  const files = view?.ok ? view.data.files : undefined
  return { migrations: addedMigrations(files, watchedDirs(ctx.autoMerge.dirs, ctx.autoMerge.watch)), basis: readiness.basis ?? 'queue.auto_review 없음' }
}

// base 마다의 최고 번호와 같은 base 의 열린 PR 의 번호, 예약, 브랜치마다의 열린 PR 번호(머리 주석의 「자동 머지」 4).
// 예약과 openByBranch 는 base 에 묶이지 않아 모든 base 에 같은 값을 쓴다
function migrationContext(
  ctx: Context,
  bases: string[],
):
  | {
      ok: true
      baseMax: Map<string, Map<string, Migration>>
      others: Map<string, OpenMigrations[]>
      reserved: ReservedMigrations[]
      openByBranch: Map<string, Migration[]>
    }
  | { ok: false; error: string } {
  const dirs = watchedDirs(ctx.autoMerge.dirs, ctx.autoMerge.watch)
  const reserved: ReservedMigrations[] = []
  let read: ReturnType<typeof readReservations>
  try {
    read = readReservations(ctx.repo)
  } catch (e) {
    return { ok: false, error: `마이그레이션 예약을 읽지 못했다: ${oneLine(e)}` }
  }
  // 형식이 틀린 예약을 버린 채 보면 그 번호보다 높은 PR 을 건다
  if (read.skipped > 0) return { ok: false, error: `마이그레이션 예약 ${read.skipped} 개의 형식이 틀렸다. ${orchWord()} queue reserve prune 으로 뺀다` }
  for (const r of read.list) {
    const migration: Migration = { module: r.module, version: r.version, label: r.label, path: r.path }
    const entry = reserved.find((item) => item.branch === r.branch)
    if (entry) entry.migrations.push(migration)
    else reserved.push({ branch: r.branch, migrations: [migration] })
  }
  const baseMax = new Map<string, Map<string, Migration>>()
  for (const base of bases) {
    const fetched = git(ctx.repo, ['fetch', '--quiet', 'origin', base])
    if (fetched.code !== 0) return { ok: false, error: `origin ${base} 를 받지 못했다(종료 코드 ${fetched.code}): ${oneLine(fetched.stderr.trim())}` }
    const paths: string[] = []
    for (const dir of new Set(Object.values(dirs).flat())) {
      const listed = git(ctx.repo, ['ls-tree', '-r', '--name-only', `origin/${base}`, '--', dir])
      if (listed.code !== 0) return { ok: false, error: `origin/${base} 의 ${dir} 를 읽지 못했다(종료 코드 ${listed.code}): ${oneLine(listed.stderr.trim())}` }
      paths.push(...lines(listed.stdout))
    }
    baseMax.set(base, maxByModule(paths, dirs))
  }
  const got = ghJson<unknown>(['pr', 'list', '--state', 'open', '--limit', String(MIGRATION_PR_LIMIT), '--json', 'number,headRefName,baseRefName,files'], {
    cwd: ctx.repo,
  })
  if (!got.ok) return { ok: false, error: oneLine(got.error) }
  if (!Array.isArray(got.data)) return { ok: false, error: '열린 PR 의 파일 목록이 목록이 아니다' }
  // 잘린 목록에서 빠진 PR 의 번호를 놓친 채 걸지 않는다
  if (got.data.length >= MIGRATION_PR_LIMIT) return { ok: false, error: `열린 PR 이 ${MIGRATION_PR_LIMIT} 개 이상이라 마이그레이션 목록이 잘렸을 수 있다` }
  const others = new Map<string, OpenMigrations[]>()
  const openByBranch = new Map<string, Migration[]>()
  for (const row of got.data) {
    if (!isObject(row) || !Number.isInteger(row.number) || typeof row.baseRefName !== 'string') continue
    const migrations = addedMigrations(row.files, dirs)
    others.set(row.baseRefName, [...(others.get(row.baseRefName) ?? []), { pr: row.number as number, migrations }])
    if (typeof row.headRefName === 'string') openByBranch.set(row.headRefName, [...(openByBranch.get(row.headRefName) ?? []), ...migrations])
  }
  return { ok: true, baseMax, others, reserved, openByBranch }
}

function launchDetached(argv: string[], cwd: string, fd: number): Promise<{ ok: true; pid: number } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', fd, fd], detached: true })
    child.once('error', (e) => resolve({ ok: false, error: e.message }))
    child.once('spawn', () => {
      child.unref()
      resolve(child.pid === undefined ? { ok: false, error: 'pid 가 없다' } : { ok: true, pid: child.pid })
    })
  })
}

// 자동 머지(머리 주석의 「자동 머지」). 결과는 errors.auto-merge 에 둘 이유다. 기록은 단계가 끝나거나 예외로 끝날 때 쓴다
async function autoMerge(ctx: Context, mine: OwnPr[], names: Map<number, string[]> | undefined, stale: Set<number>, runs: TickRun[]): Promise<string | null> {
  const file = autoMergeFile(ctx.repo)
  const state = readAutoMerge(file)
  const errors = new Set<string>()
  // 단계가 예외로 끝났으면 쓰기 실패보다 그 예외를 던진다. 예외가 없으면 쓰기 실패를 오류 이유로 낸다
  let failed = true
  try {
    await autoMergeStep(ctx, mine, names, stale, runs, state, errors)
    failed = false
  } finally {
    try {
      writeAutoMerge(file, ctx.repo, state)
    } catch (e) {
      log(`orch-loop: state/auto-merge.json 을 쓰지 못했다: ${oneLine(e)}`)
      if (!failed) errors.add(`state/auto-merge.json 을 쓰지 못했다: ${oneLine(e)}`)
    }
  }
  return errors.size > 0 ? [...errors].join('; ') : null
}

// Run 에 Orca 메시지로 쓰고 같은 줄을 로그에 쓴다. 쓰지 못하면 false 다. 기록을 남기지 않아 다음 틱이 다시 쓴다
function notifyAutoMerge(ctx: Context, kind: string, pr: number | null, text: string, run: string): boolean {
  log(`${kind} ${pr === null ? '' : `#${pr} `}${text}`)
  try {
    sendNotice(kind, pr, text, run)
    return true
  } catch (e) {
    log(`orch-loop: Orca 알림을 보내지 못했다: ${oneLine(e)}`)
    return false
  }
}

async function autoMergeStep(
  ctx: Context,
  mine: OwnPr[],
  names: Map<number, string[]> | undefined,
  stale: Set<number>,
  runs: TickRun[],
  state: AutoMergeState,
  errors: Set<string>,
): Promise<void> {
  // 1. 지난 항목
  pruneAutoMerge(state, new Set(mine.map((pr) => String(pr.number))))
  const logs = join(pathOf('state', ctx.repo), 'auto-merge')

  // 2. 앞선 큐와 도는 큐
  const listed = processes()
  if (!listed) {
    errors.add('프로세스 목록을 읽지 못했다')
    return
  }
  if (state.queue) {
    const queue = state.queue
    if (queue.announced === false) {
      if (!notifyAutoMerge(ctx, 'AUTO-MERGE', null, `${queue.prs.map(n => `#${n}`).join(' ')} run=${queue.run} log=${queue.log}`, queue.run)) return
      queue.announced = true
    }
    if (listed.some((p) => p.pid === queue.pid && p.command.includes('merge-with-finish.'))) {
      logHeld(ctx.repo, listed)
      return
    }
    if (!notifyAutoMerge(ctx, 'AUTO-MERGE-END', null, `${queueEndLine(queue.log)} log=${queue.log}`, queue.run)) return
    forgetNotAdmitted(state, queue)
    state.queue = null
  }
  if (queueRunning(listed)) {
    logHeld(ctx.repo, listed)
    return
  }

  // 3. 대상과 판정. 같은 브랜치는 앞 Run 의 지시서가 정한다
  const targets = specTargets(ctx.repo, runs)
  // 보드는 틱에 한 번 읽는다. 읽지 못하면 보류 표시를 놓친 채 걸지 않도록 이 틱은 걸지 않는다
  let items: BoardItem[] = []
  const boardFile = boardPath(ctx.repo)
  if (isFile(boardFile)) {
    try {
      items = readBoard(boardFile).filter(isObject) as BoardItem[]
    } catch (e) {
      errors.add(`보드를 읽지 못했다: ${oneLine(e)}`)
      return
    }
  }
  const ready: Candidate[] = []
  const words = readPrivateWords()
  for (const pr of mine) {
    const target = targets.get(pr.branch)
    if (!target) continue
    const hold = target.hold === null ? null : redactLine(target.hold, words, '지시서', target.text)
    const judged = await judgeTarget(ctx, pr, hold, featureLoopRequested(target.text), names?.get(pr.number), stale, state, items, words)
    if ('error' in judged) {
      errors.add(judged.error)
      continue
    }
    if ('wait' in judged) {
      log(`AUTO-MERGE-WAIT #${pr.number} ${judged.wait}`)
      const key = `${pr.number}@${pr.head}`
      if (judged.missing && !Object.hasOwn(state.unreviewed, key)) {
        const text = `${judged.wait}. 봇 영수증이나 리뷰 체크가 이 HEAD 에 생기면 다음 틱이 건다`
        if (notifyAutoMerge(ctx, 'AUTO-MERGE-NO-REVIEW', pr.number, text, target.run)) state.unreviewed[key] = iso()
      }
      continue
    }
    const key = String(pr.number)
    if (state.ready[key]?.head !== pr.head) state.ready[key] = { head: pr.head, at: iso() }
    ready.push({ pr, run: target.run, migrations: judged.migrations, basis: judged.basis })
  }

  // 4. 마이그레이션 겹침
  const judgements = new Map<number, MigrationJudgement>()
  let candidates = ready
  const migrating = ready.filter((c) => c.migrations.length > 0)
  if (migrating.length > 0) {
    const read = migrationContext(ctx, [...new Set(migrating.map((c) => c.pr.base))])
    if (!read.ok) {
      errors.add(read.error)
      candidates = ready.filter((c) => c.migrations.length === 0)
    } else {
      for (const c of migrating) {
        const reserved = reservedFor(c.pr.branch, read.reserved, read.openByBranch)
        judgements.set(
          c.pr.number,
          judgeMigrations(c.pr.number, c.migrations, read.baseMax.get(c.pr.base) ?? new Map(), read.others.get(c.pr.base) ?? [], reserved),
        )
      }
    }
  }
  const clean: Candidate[] = []
  for (const c of candidates) {
    const clashes = judgements.get(c.pr.number)?.clashes ?? []
    if (clashes.length === 0) {
      clean.push(c)
      continue
    }
    const reason = clashes.map((clash) => `${clash.module} ${clash.label}: ${clash.reason}`).join('; ')
    const key = `${c.pr.number}@${c.pr.head}`
    if (state.clashes[key] === reason) log(`AUTO-MERGE-WAIT #${c.pr.number} 마이그레이션 겹침: ${reason}`)
    else if (notifyAutoMerge(ctx, 'MIGRATION-CLASH', c.pr.number, reason, c.run)) state.clashes[key] = reason
  }

  // 걸 후보에 없는 더 낮은 번호의 PR 과 예약. 예약은 PR 이 없어 걸 후보에 들 수 없으므로 늘 기다린다
  const byNumber = new Map(clean.map((c) => [c.pr.number, c]))
  const waitsFor = (c: Candidate, set: Set<number>) =>
    (judgements.get(c.pr.number)?.lower ?? []).filter((lower) => lower.pr === null || !set.has(lower.pr))
  let set = new Set(byNumber.keys())
  const first = new Set(set)
  for (const c of clean) {
    const key = String(c.pr.number)
    const blockers = waitsFor(c, first)
    if (blockers.length === 0) {
      delete state.blocked[key]
      continue
    }
    set.delete(c.pr.number)
    const before = state.blocked[key]
    const entry = before && before.head === c.pr.head ? before : { head: c.pr.head, since: iso(), fired: false }
    state.blocked[key] = entry
    const blocker = blockers[0]
    const holder = blocker.pr === null ? `${blocker.branch} 의 예약 ${blocker.label}` : `#${blocker.pr} ${blocker.label}`
    const waited = Date.now() - Date.parse(entry.since)
    if (!entry.fired && waited > ctx.autoMerge.blockedAfterSec * 1000) {
      const text =
        `${blocker.module} ${blocker.mine} 이 ${holder} 을 ${Math.floor(waited / 60_000)}분 기다린다. ` +
        `막는 쪽 worker 가 ${orchWord()} queue reserve --again 으로 번호를 다시 받는다. 막는 브랜치를 버렸으면 지운 뒤 ${orchWord()} queue reserve prune`
      if (notifyAutoMerge(ctx, 'MIGRATION-BLOCKED', c.pr.number, text, c.run)) entry.fired = true
    } else {
      log(`AUTO-MERGE-WAIT #${c.pr.number} ${blocker.module} ${blocker.mine} 이 ${holder} 을 기다린다`)
    }
  }
  // 이번 틱의 걸 후보가 아닌 PR 의 막힘은 지운다. 준비에서 빠졌다 같은 HEAD 로 돌아온 PR 이 옛 since 로 바로 알리지 않게 한다
  for (const key of Object.keys(state.blocked)) if (!byNumber.has(Number(key))) delete state.blocked[key]

  // 머지 전 명령
  const commands = new Map<number, string | null>()
  for (const c of clean) {
    if (!set.has(c.pr.number)) continue
    const got = beforeCommand(
      c.migrations.map((m) => m.module),
      ctx.autoMerge.before,
    )
    if (got.ok) {
      commands.set(c.pr.number, got.command)
    } else {
      errors.add(`#${c.pr.number} 의 모듈 ${got.module} 에 migrations.before 규칙이 없다`)
      set.delete(c.pr.number)
    }
  }

  // 5. 순서. 첫 PR 의 Run 만 남기고, 빠진 PR 을 기다리는 PR 을 뺀다. 남는 집합이 바뀌지 않을 때까지 되풀이한다
  let planned: { order: number[]; chains: number[][] } = { order: [], chains: [] }
  let queueRun = ''
  for (;;) {
    if (set.size === 0) return
    planned = queueOrder([...set].map((n) => ({ pr: n, readyAt: state.ready[String(n)]?.at ?? '', migrations: byNumber.get(n)?.migrations ?? [] })))
    queueRun = byNumber.get(planned.order[0])?.run ?? ''
    const kept = new Set(planned.order.filter((n) => byNumber.get(n)?.run === queueRun))
    const snapshot = new Set(kept)
    for (const n of snapshot) {
      const c = byNumber.get(n)
      if (c && waitsFor(c, snapshot).length > 0) kept.delete(n)
    }
    if (kept.size === set.size) break
    set = kept
  }
  const order = planned.order
  const chains = planned.chains.map((chain) => chain.filter((n) => set.has(n))).filter((chain) => chain.length >= 2)

  // 6. 띄우기. 판정하는 사이 코디네이터가 큐를 걸었을 수 있어 프로세스 목록을 다시 본다
  const again = processes()
  if (!again) {
    errors.add('프로세스 목록을 읽지 못했다')
    return
  }
  if (queueRunning(again)) {
    logHeld(ctx.repo, again)
    return
  }
  const args = ['--repo', ctx.repo, '--run', queueRun, '--continue-on-hold']
  for (const chain of chains) args.push('--chain', chain.join(','))
  for (const arg of sweepArgs(ctx.sweepArgs, queueRun) ?? []) args.push('--sweep-arg', arg)
  for (const n of order) {
    const command = commands.get(n)
    args.push(command ? `${n}:${command}` : String(n))
  }
  const queueLog = join(logs, `${iso().replace(/[-:]/g, '').replace(/\.\d+/, '')}.log`)
  makeParent(queueLog, ctx.repo)
  const fd = openSync(queueLog, 'a')
  let launched: Awaited<ReturnType<typeof launchDetached>>
  try {
    launched = await launchDetached(scriptCommand(process.env.MERGE_WITH_FINISH || scriptPath('merge-with-finish'), args), ctx.repo, fd)
  } finally {
    closeSync(fd)
  }
  if (!launched.ok) {
    errors.add(`merge-with-finish 를 띄우지 못했다: ${oneLine(launched.error)}`)
    return
  }
  const at = iso()
  state.queue = { pid: launched.pid, log: queueLog, run: queueRun, prs: order, at }
  for (const n of order) state.tried[`${n}@${byNumber.get(n)?.pr.head}`] = at
  for (const n of order) log(`AUTO-MERGE-BASIS #${n} HEAD ${byNumber.get(n)?.pr.head.slice(0, 8)} ${byNumber.get(n)?.basis}`)
  state.queue.announced = notifyAutoMerge(ctx, 'AUTO-MERGE', null, `${order.map((n) => `#${n}`).join(' ')} run=${queueRun} log=${queueLog}`, queueRun)
}

export async function runAutoMerge(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { runs } = ctx
  const { prs, ciNames, ciStale } = state
  const { report, errors } = reporter(ctx)
  // 8. 자동 머지. queue.auto_merge 가 false 거나 열린 PR 을 읽지 못한 틱은 errors.auto-merge 를 그대로 둔다
  if (prs.ok && ctx.autoMerge.enabled) {
    try {
      report('auto-merge', await autoMerge(ctx, prs.mine, ciNames, ciStale, runs))
    } catch (e) {
      report('auto-merge', oneLine(e))
    }
  }
  return { errors }
}
