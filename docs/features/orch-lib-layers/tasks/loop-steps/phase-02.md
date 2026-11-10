# Phase 02. 루프를 lifecycle 과 단계 파일로 나눈다

**Execution profile**: standard

## 목표

`skills/orch/scripts/loop/orch-loop.ts`(3028줄)에는 인자 해석, 모드 고르기, 틱 단계를 차례로 부르고 결과 줄을 내는 일만 남긴다.
틱 단계의 구현과 그 설명은 `loop/steps/` 로, 잠금·시작·멈춤·생존 타이머는 `loop/lifecycle.ts` 로 옮긴다. 단계 하나를 고칠 때 그 단계 파일만 바뀌게 하려는 것이다.

**범위 외**: 출력·종료 코드·상태 파일·알림 순서 변경, `loop/completion-watch.ts` 와 `loop/stalled-workers.ts` 이동, `queue/`, `cleanup/`, `core/` 의 코드 변경, work-board, 새 의존성.

## 컨텍스트

**요구사항**: REQ12, REQ13

**근거 문서**: `docs/features/orch-lib-layers/spec.md` 의 REQ12, REQ13, DECISION10 과 `docs/features/orch-lib-layers/design.md` 의 「단계 파일」, 「동작 같음 확인」

- 본보기는 먼저 머지된 두 쪼개기다. `skills/orch/scripts/cleanup/cleanup-sweep.ts` 는 단계를 `Object.assign(state, await 단계(ctx, state))` 로 차례로 부르고, `cleanup/steps/context.ts` 가 `StepContext`, `StepState`, `StepResult` 를 둔다. 단계 파일 맨 위에는 그 단계의 설명이 있다.
- 지금 `orch-loop.ts` 의 `tick` 함수는 단계 사이에 `waiting`, `pendingDecisions`, `prs`, `ci`, `ciStale`, `lookup`, `base`, `stalls`, `tails`, 충돌 찾기 결과를 넘긴다. 또 `report()` 닫힌 함수로 오류 이유를 `errors` 에 적으며 그 자리에서 로그와 Run 알림을 낸다.
- 고정 입력 기록(`skills/orch/tests/golden/loop/*/result.json`)은 틱 자식의 stdout(로그 줄과 결과 줄), stderr, 종료 코드, `.orch` 아래 상태 파일을 글자 그대로 비교한다. 그래서 로그 줄의 순서, 결과 줄 `errors` 의 키 순서, 바깥 호출 순서가 지금과 같아야 한다.
- 고정 입력 기록은 Run 하나만 본다. Run 이 둘일 때의 순서는 phase 01 이 옮기기 전 코드로 만든 순서 기록(`skills/orch/tests/loop-order/`)이 본다. 이 phase 는 그 기록을 고치지 않는다.
- `--start` 는 `main()` 의 `entrypoint`(기본 `SELF`, `orch-loop.ts` 자신의 경로)를 자식으로 띄우고, `--foreground` 는 같은 경로를 `--tick` 으로 띄운다. `lib/loop.ts` 의 `isLoopProcess` 는 명령줄의 `orch-loop` 로 루프를 알아본다. 진입 파일 경로와 `lib/commands.ts` 의 행은 바꾸지 않는다.
- 자동 머지의 기본 스레드 명령은 `${HERE}/../../../review-fix/scripts/review_threads.ts` 를 글자로 잇는다. `HERE` 는 `loop/` 폴더다.
- `skills/orch/tests/script-folders.spec.ts` 는 묶음 폴더 바로 아래의 `.ts` 가 명령 표의 스크립트이거나 `helpers` 목록에 적힌 보조 스크립트인지 본다. 하위 폴더(`steps/`)는 보지 않는다.
- 로그 함수 `log` 는 모듈 변수 `logFile` 에 쓴다. `executeMain` 이 `--foreground` 에서만 `logFile` 을 정한다.

## 의도 메모

- **옮긴 함수의 본문은 글자 그대로 둔다.** 이름, 인자, 본문을 바꾸지 않고 `export` 만 붙인다. 리뷰어가 `git diff --color-moved` 로 옮긴 것과 새로 쓴 것을 가려 읽게 하려는 것이다. 새로 쓰는 코드는 단계 함수(틱 본문에서 떼어 낸 조각), `StepContext`·`StepState`·`StepResult`, 오류 기록기, 진입 파일의 `tick()` 뿐이다.
- 본문이 바뀌는 예외는 넷이다. `foreground` 첫머리에 `executeMain` 의 세 줄이 들어온다. `executeMain` 은 그 세 줄과 처리기 등록 다섯 줄이 빠지고 `handleSignals()` 한 줄이 들어온다. `judgeTarget` 의 `HERE` 는 `LOOP_DIR` 이 된다. `logFile` 에 값을 넣던 줄은 `setLogFile(file)` 호출이 된다. 옮긴 주석 가운데 다른 파일의 절을 가리키게 된 것은 파일 이름을 붙인다.
- **오류 이유는 단계가 그 자리에서 알리고, 값만 결과로 돌려준다.** 설계는 「StepResult 는 상태 조각과 오류 이유를 담는다」 고 했다. 알림과 로그를 단계가 끝난 뒤로 미루면 Run 이 여럿일 때 로그 줄 순서가 바뀌어 REQ13 을 어긴다. 그래서 `steps/errors.ts` 의 `reporter(ctx)` 가 지금의 `report()` 와 같은 일을 하며 단계마다의 `errors` 를 모으고, 단계는 그것을 `StepResult.errors` 로 돌려준다. 진입 파일의 `collect` 가 `Object.assign(state.errors, result.errors)` 로 차례로 합친다. 오류 출처 하나는 단계 하나만 쓰므로 키 순서가 지금과 같다.
- **단계를 건너뛰는 조건은 단계 안에 둔다.** `prs.ok`, `ctx.autoMerge.enabled`, `ctx.refresh.slots > 0` 같은 조건을 진입 파일에 두면 진입 파일이 단계의 사정을 알게 된다. 건너뛴 단계는 빈 결과를 돌려준다.
- **완료 보고·끊긴 worker 확인과 DIGEST 보내기는 한 단계로 둔다.** 지금 Run 마다 DIGEST, 완료 보고, 끊긴 worker 순서로 번갈아 돈다. 둘로 나누면 Run 이 여럿일 때 호출 순서가 바뀐다.
- 기각: 단계 목록을 배열로 두고 돌리기. 호출 줄이 그대로 보이는 쪽이 순서를 읽기 쉽고 `cleanup-sweep.ts` 와 꼴이 같다.
- 기각: 설정 읽기(`context()`)를 `loop/config.ts` 로 따로 두기. 묶음 폴더 바로 아래 파일이 늘어 `script-folders.spec.ts` 의 보조 스크립트 표가 길어진다. `steps/context.ts` 가 단계 입력과 함께 갖는다.
- 기존 테스트의 기대값과 `tests/golden` 은 고치지 않는다. 고쳐야 통과하면 멈추고 코디네이터에게 묻는다(스펙 DECISION10).
- 같은 때에 `fix/orch-inbox-sender-key` 가 `core/completion.ts`, `loop/completion-watch.ts` 를 고친다. 이 phase 는 두 파일을 건드리지 않는다.

## 작업 항목

### 1. `skills/orch/scripts/loop/steps/` 의 공통 파일

| 파일 | 담는 것(지금 `orch-loop.ts` 의 이름) |
| --- | --- |
| `steps/shared.ts` | 머리 주석 「로그」, 「Run」 의 「알림의 Run」·「worker 찾기」. `LOG_LIMIT`, `logFile` 과 새 `setLogFile(file)`, `log`, `oneLine`, `iso`, `lines`, `relay`, `SWEEP_TIMEOUT_MS`, 타입 `CiEntry`, `StallState`, `Stall`, `OwnPr`, `Prs`, `TickRun`, `Lookup`, `Owner`, `Waiting`, 함수 `rowsOf`, `ownerOf`, `primaryRun`, loop.json 의 ci 와 stalls 를 읽는 `ciEntries`, `stallEntries`(부모와 틱 자식이 함께 쓴다) |
| `steps/context.ts` | 머리 주석 「설정」 과 「Run」 가운데 틱 자식이 맡는 Run 문장. `DEFAULT_TICK_SEC`, `DEFAULT_STALL_TICKS`, 타입 `Context`, `optionalString`, `stallTicks`, `context`, `tickRuns`, 타입 `TickResult`. 새 타입 `StepContext`(= `Context` 에 `tick`, `runs`, `primary`, `loaded`, `previous`, `lookup` 을 더한 것), `StepState`, `StepResult`(= `Partial<StepState>`), 새 함수 `stepContext(config, n)` 과 `initialState()` |
| `steps/errors.ts` | 머리 주석 「오류 줄 억제」. `SHARED_SOURCES`, `dropStaleErrors`, 새 `reporter(ctx)`(틱 본문의 `keyOf` 와 `report` 를 그대로 옮긴다. `primary`, `previous` 는 `ctx` 에서 읽고 `errors` 는 단계마다 새로 만든다) |

`StepState` 의 칸: `errors`, `waiting`, `pending`(지금의 `pendingDecisions`), `prs`, `ci?`, `ciStale`, `base`, `stalls?`, `tails`, `conflictBase`, `found`. `stepContext` 는 지금 `tick()` 첫머리와 같은 순서로 `readLoop`, `tickRuns` 를 부른다.

### 2. 단계 파일

단계마다 `export async function <이름>(ctx: StepContext, state: StepState): Promise<StepResult>` 하나를 두고, 틱 본문의 그 조각을 옮긴다. 머리 주석의 해당 절은 그 파일 맨 위로 옮긴다.

| 순서 | 파일 | 단계 함수 | 옮기는 함수와 머리 주석 |
| --- | --- | --- | --- |
| 1 | `steps/questions.ts` | `checkQuestions` | 「틱」 1. `REMIND_AFTER_SEC`, `askers` |
| 2 | `steps/prs.ts` | `readOpenPrs` | 「틱」 2. `PR_FIELDS`, `openPrs` |
| 3 | `steps/board.ts` | `syncBoard` | 「틱」 3 |
| 3 뒤 | `steps/decisions.ts` | `notifyPendingDecisions` | 「틱」 3 의 결정 문장 |
| 4 | `steps/cleanup.ts` | `sweepRuns` | 「틱」 4. `relayFinishMissing` |
| 5 | `steps/ci.ts` | `checkCi` | 「CI 감시」. `prInput`, `CANCELLED_ONLY`, `tellWorker`, `fireCi`, `runOfPr`, `watchCi` |
| 5-1 | `steps/merged.ts` | `notifyMerged` | 「머지 알림」. `tellMerged` |
| 6 | `steps/stalls.ts` | `checkStalls` | 「멈춤 확인」. `watchStalls`, `notifyStall` |
| 6-1 | `steps/movement.ts` | `checkMovement` | 「움직임 확인」. `watchMovement` |
| 7 | `steps/tick-event.ts` | `fireTick` | 「틱」 7 |
| 8 | `steps/auto-merge.ts` | `runAutoMerge` | 「자동 머지」. `AUTO_MERGE_LOG_KEEP_MS` 부터 `REVIEW_CHAIN_LIMIT` 까지의 상수, `Ready` 부터 `Candidate` 까지의 타입, `autoMergeFile` 부터 `autoMergeStep` 까지(아래 큐 기록 파일로 가는 셋은 뺀다) |
| 8-1 | `steps/queue-turns.ts` | `relayQueueTurns` | 「큐 기록」. `Proc`, `processes`, `queueTurns`, `watchQueueTurns` |
| 9 | `steps/conflicts.ts` | `settleConflicts` | 「충돌 처리」 와 그 앞의 시작 확인 시간 초과 문장. `handleConflicts` |
| 9-1 | `steps/refresh.ts` | `refreshPrs` | 「최신화」. `refreshBehind`, `tellRefresh` |
| 10 | `steps/heavy-slot.ts` | `checkHeavySlot` | 「자리 보유 확인」 |
| 11 | `steps/unanswered.ts` | `checkUnanswered` | 「미답변 질문 확인」. `watchUnanswered` |
| 끝 | `steps/reports.ts` | `checkReports` | 완료 보고·끊김 문장. Run 마다 `flushDigest`, `watchCompletions`, `watchLost` |

- `steps/auto-merge.ts` 는 `HERE` 대신 `const LOOP_DIR = dirname(dirname(fileURLToPath(import.meta.url)))` 를 두고 `${LOOP_DIR}/../../../review-fix/scripts/review_threads.ts` 로 잇는다. 명령 글자가 지금과 같다.
- `checkStalls` 는 `defaultBase(ctx.repo) ?? ''` 를 try 밖에서 읽어 `base` 로 돌려주고, 실패해도 `tails` 를 돌려준다. `settleConflicts` 는 `conflictBase` 와 `found` 를 돌려주고 `refreshPrs` 가 그것을 읽는다.
- 옮긴 주석의 「머리 주석의 「X」」 가 다른 파일의 절을 가리키게 되면 `steps/ci.ts 머리 주석의 「CI 감시」` 처럼 파일을 붙인다.

### 3. `skills/orch/scripts/loop/lifecycle.ts`

머리 주석 「한 저장소에 하나」, 「명의」, 「Run」(등록과 `--foreground` 시작), 「틱」 의 부모·자식 프로세스 문장과 결과 줄 합치기 문장, 「생존 타이머」, 「loop.json」 을 옮긴다.
옮기는 이름: `startWaitMs`, `STOP_WAIT_MS`, `POLL_MS`, `PROBE_MS`, `EMPTY_LOCK_GRACE_MS`, `TICK_STOP_GRACE_MS`, `PARENT_POLL_MS`, `Usage`, `aliveSec`, `passArgs`, `readText`, `createLock`, `lockPid`, `lockHolder`, `freshEmpty`, `takeLock`, `releaseLock`, `runOf`, `running`, `legacyLoop`, `LEGACY_HINT`, `legacyHint`, `joinLoop`, `FENCED`, `UNKNOWN_BOUND`, `BOUND_ENV`, `boundRun`, `inheritedBound`, `callerFenced`, `loopBound`, `start`, `stop`, `stopProcess`, `status`, `tickResult`, `foreground`, `exiting`, `stopGraceMs`, `onSignal`, `watchParent`, `fatal`.

- `executeMain` 이 하던 신호·예외 처리기 다섯 개 등록은 새 `handleSignals()` 로 묶는다.
- `executeMain` 이 `foreground()` 직전에 하던 세 줄(`stopGraceMs = TICK_STOP_GRACE_MS`, 로그 파일 정하기, `makeParent`)은 `foreground()` 첫머리로 옮긴다. 실행 순서는 같다.
- import 방향: `lifecycle.ts` 는 `steps/shared.ts`, `steps/context.ts`, `steps/errors.ts` 만 import 한다(로그, `Context`·`TickResult` 타입, `ciEntries`·`stallEntries`, `dropStaleErrors`). 단계 파일은 `lifecycle.ts` 를 import 하지 않고, 아무도 `orch-loop.ts` 를 import 하지 않는다. 진입 경로는 지금처럼 `entrypoint` 인자로 받는다.

### 4. `skills/orch/scripts/loop/orch-loop.ts`

- 머리 주석에는 첫 문단, 「사용법」, 「틱」 의 단계 순서, 「알림 방식」, 「환경 변수」, 「종료 코드」 와 옮긴 절이 어느 파일에 있는지의 목록만 남긴다.
- 「틱」 의 단계 순서는 위 「단계 파일」 표대로 새로 쓴다. 번호마다 이름과 단계 파일(`steps/questions.ts` 꼴)을 적는다. 3번에는 결정 알림(`steps/decisions.ts`)을 잇고, 11번은 옛 「대기 확인」 이 아니라 「미답변 질문 확인」(`steps/unanswered.ts`)으로 적고, 끝에 12번으로 모아 보내기와 완료 보고·끊긴 worker 확인(`steps/reports.ts`)을 더한다. 9번과 9-1번의 순서 이유 문장은 그대로 둔다.
- 코드는 `USAGE`, `SELF`, `MODES`, `Mode`, `tick`, `main`, `executeMain`, `reportError`, 직접 실행 가드만 남긴다. `tick()` 은 `stepContext` 와 `initialState` 를 만들고 위 표의 순서대로 `collect` 로 각 단계의 결과를 `state` 에 합친 뒤(오류 이유는 `state.errors` 에, 나머지 칸은 `state` 에) 지금과 같은 결과 줄을 낸다.

### 5. 가리키는 곳 고치기

`orch-loop.ts` 머리 주석의 절(「」)이나 옮긴 함수 이름을 가리키던 곳을 옮긴 파일로 고친다. 「orch-loop.ts 가 읽는다」 처럼 루프 프로그램 전체를 가리키는 말은 그대로 둔다. 「틱」 을 가리키는 `docs/flow.md` 의 tick 행은 그 절이 진입 파일에 남으므로 그대로 둔다. ADR 과 `docs/features/` 는 그때의 배치를 적은 기록이라 이 phase 에서 고치지 않는다(`script-folders.spec.ts` 머리 주석과 같은 기준).
work-board 는 범위 밖이라 고치지 않고 PR 본문 「남은 일」 에 적는다: `extensions/work-board/hooks/register.js` 의 `judgeTarget`, `extensions/work-board/bin/merge-queue.ts` 의 `LOG_LIMIT`, `extensions/work-board/bin/worker-marks.ts` 의 `watchMovement`·`waitingOf`.

| 절 | 새 자리 | 고칠 파일 |
| --- | --- | --- |
| 「최신화」 | `loop/steps/refresh.ts` | `docs/data-schema.md`, `skills/orch/references/overlay.md`, `skills/orch/references/cleanup.md`, `skills/orch/scripts/lib/refresh.ts`, `skills/orch/scripts/lib/gh.ts`, `skills/orch/tests/orch-loop-refresh.spec.ts` |
| 「멈춤 확인」 | `loop/steps/stalls.ts` | `docs/data-schema.md`, `skills/orch/references/hooks.md`, `skills/orch/scripts/core/screen.ts`, `skills/orch/scripts/lib/events.ts`, `skills/orch/scripts/lib/movement.ts` |
| 「자동 머지」 | `loop/steps/auto-merge.ts` | `docs/data-schema.md`, `docs/flow.md`, `skills/orch/references/cleanup.md`, `skills/orch/references/verification.md`, `skills/orch/scripts/core/auto-merge.ts`, `skills/orch/tests/orch-loop-auto-merge.spec.ts` |
| 「자리 보유 확인」 | `loop/steps/heavy-slot.ts` | `skills/orch/references/heavy-checks.md`, `skills/orch/scripts/lib/heavy-hold.ts` |
| 「움직임 확인」 | `loop/steps/movement.ts` | `skills/orch/scripts/lib/movement.ts`, `skills/orch/scripts/loop/stalled-workers.ts` |
| 「큐 기록」 | `loop/steps/queue-turns.ts` | `skills/orch/scripts/lib/queue-turn.ts` |
| 「명의」, 「Run」, `state/loop.lock` | `loop/lifecycle.ts` | `skills/orch/scripts/doctor/orch-doctor.ts`, `skills/orch/scripts/lib/loop.ts`, `skills/orch/scripts/lib/events.ts`, `skills/orch/tests/orch-loop.spec.ts` |
| `ownerOf` | `loop/steps/shared.ts` | `skills/orch/scripts/lib/tell-worker.ts` |

`docs/code-architecture.md` 「배치」 의 `orch-loop.ts` 줄을 고치고 `loop/lifecycle.ts`, `loop/steps/` 줄을 더한다.

### 6. 이 phase 를 검증하는 `skills/orch/tests/loop-steps.spec.ts`, `loop-order.spec.ts` 와 `script-folders.spec.ts`

- `skills/orch/tests/loop-steps.spec.ts`(신규). 정상 사례: 진입 파일 머리 주석 「틱」 에 적힌 단계 파일의 순서와 `tick` 이 부르는 단계 함수의 순서가 같고, `steps/` 의 단계 파일이 모두 한 번씩 불린다. `lifecycle.ts` 가 `start`, `stop`, `status`, `foreground` 를 내보낸다. 자동 머지의 기본 스레드 명령이 가리키는 `review_threads.ts` 가 실제로 있다. 실패 사례: 진입 파일의 함수 정의가 `tick`, `collect`, `main`, `executeMain`, `reportError` 밖에 있으면 실패한다(단계 구현을 진입 파일로 되돌리면 깨진다). `lifecycle.ts` 나 단계 파일이 `orch-loop.ts` 를 import 하거나 단계 파일이 `lifecycle.ts` 를 import 하면 실패한다.
- `skills/orch/tests/loop-order.spec.ts`(phase 01 이 만든 것)가 Run 이 둘인 틱의 로그 줄, 결과 줄, 바깥 호출 순서를 옮기기 전 기록과 비교한다. 기록 파일은 고치지 않는다.
- `skills/orch/tests/script-folders.spec.ts`(수정). 그 파일의 `helpers` 목록에 `'loop/lifecycle.ts'` 한 줄을 더한다. 기대값을 바꾸는 것이 아니라 새 보조 스크립트를 등록하는 것이다(`loop/completion-watch.ts` 와 같은 꼴).
- 동작은 기존 테스트(`orch-loop*.spec.ts`, `lib-loop.spec.ts`, `golden.spec.ts`)가 기대값 그대로 본다.

### 7. 변경 조각

`skills/orch/changes/loop-steps.patch.md` 에 「상주 루프를 단계 파일과 lifecycle 로 나눴고 출력, 종료 코드, 상태 파일은 그대로다」 를 `- ` 항목 하나로 적는다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/loop-steps.spec.ts skills/orch/tests/loop-order.spec.ts skills/orch/tests/orch-loop.spec.ts skills/orch/tests/orch-loop-auto-merge.spec.ts skills/orch/tests/orch-loop-ci.spec.ts skills/orch/tests/orch-loop-conflict.spec.ts skills/orch/tests/orch-loop-import.spec.ts skills/orch/tests/orch-loop-refresh.spec.ts skills/orch/tests/orch-loop-run.spec.ts skills/orch/tests/orch-loop-stall.spec.ts skills/orch/tests/lib-loop.spec.ts skills/orch/tests/completion-watch.spec.ts skills/orch/tests/lost-workers.spec.ts skills/orch/tests/orch-status.spec.ts skills/orch/tests/orch-entry.spec.ts skills/orch/tests/script-folders.spec.ts skills/orch/tests/check-peek.spec.ts skills/orch/tests/core-boundary.spec.ts skills/orch/tests/core-dedup.spec.ts skills/orch/tests/core-values.spec.ts skills/orch/tests/golden.spec.ts skills/orch/tests/events-doc.spec.ts skills/orch/tests/docs-contract.spec.ts
node scripts/run-tests.ts scripts/tests
node scripts/run-tests.ts --tsc-only
node skills/orch/tests/fixtures/golden-run.ts
git diff --exit-code origin/main HEAD -- skills/orch/tests/golden
```

모두 종료 코드 0 이어야 한다. 마지막 줄은 커밋 뒤에 돌린다. 커밋 전에는 `git status --short skills/orch/tests/golden skills/orch/tests/loop-order` 가 비어 있는지 본다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ12 | 분리 구현 커밋 | `node scripts/run-tests.ts skills/orch/tests/loop-steps.spec.ts` 를 돌리고, 진입 파일의 `tick()` 과 import 를 읽는다 | 테스트 통과. 진입 파일에는 인자 해석, 모드 고르기, 단계 호출과 결과 줄만 있고 `lifecycle.ts` 와 단계 파일이 진입 파일을 import 하지 않는다 | 로컬 작업 공간 | worker | 없음 | PR 전 |
| REQ12 | 분리 구현 커밋 | `awk '/^import /{f=1} f' skills/orch/scripts/loop/orch-loop.ts \| wc -l` 로 첫 import 부터의 줄 수를 세고 단계 파일 목록을 본다 | 진입 파일의 코드가 200줄 아래이고 위 「단계 파일」 표의 파일이 모두 있다 | 로컬 작업 공간 | worker | 없음 | PR 전 |
| REQ13 | main 의 고정 입력 기록 | `node skills/orch/tests/fixtures/golden-run.ts` | 루프 틱 세 사례(ci-conflict, unanswered-stopped, offline)를 포함해 모든 사례가 기록과 같다. 종료 코드 0 | 로컬 작업 공간(가짜 실행 파일과 고정 시계) | worker | 없음 | PR 전 |
| REQ13 | 커밋한 HEAD | `git diff --exit-code origin/main HEAD -- skills/orch/tests/golden` | 차이 없음, 종료 코드 0 | 로컬 작업 공간 | worker | 없음 | PR 전 |
| REQ13 | 분리 구현 커밋 | 위 「검증」 의 루프 테스트 명령. `git diff origin/main HEAD -- skills/orch/tests` 로 바뀐 테스트 줄을 읽는다 | 기존 테스트가 통과한다. 바뀐 테스트 줄은 새 파일 `loop-steps.spec.ts`, `script-folders.spec.ts` 의 보조 스크립트 한 줄, 머리 주석의 가리킴뿐이고 기대값(assert 의 값)은 그대로다 | 로컬 작업 공간 | worker | 없음 | PR 전 |
| REQ13 | Run 이 둘 등록된 틱의 순서 기록(phase 01 이 옮기기 전 코드로 만든 `skills/orch/tests/loop-order/`) | `node scripts/run-tests.ts skills/orch/tests/loop-order.spec.ts` 를 돌리고 `git diff --exit-code <phase 01 커밋> HEAD -- skills/orch/tests/loop-order` 를 본다 | 테스트 통과, 기록 차이 없음. Run 이 둘일 때 로그 줄 순서, 결과 줄 errors 의 키 순서, 가짜 실행 파일이 받은 호출 순서가 옮기기 전과 같다 | 로컬 작업 공간(가짜 실행 파일과 고정 시계) | worker | 없음 | PR 전 |
| REQ13 | PR 생성 | `gh pr checks` 로 CI 의 `Tests` 를 확인한다 | 현재 HEAD 의 필수 검사 성공(전체 테스트와 tsc) | CI | worker | push | PR 뒤 |

실제 Orca 로 루프를 띄우는 검증은 하지 않는다. 겉 동작을 바꾸지 않는 PR 이고, 같은 경로를 가짜 orca·gh 로 도는 기존 테스트와 고정 입력 기록이 본다. 독립 코드 리뷰는 PR 을 연 뒤 코디네이터에게 요청한다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/loop/orch-loop.ts` | 수정 |
| `skills/orch/scripts/loop/lifecycle.ts` | 신규 |
| `skills/orch/scripts/loop/steps/shared.ts` | 신규 |
| `skills/orch/scripts/loop/steps/context.ts` | 신규 |
| `skills/orch/scripts/loop/steps/errors.ts` | 신규 |
| `skills/orch/scripts/loop/steps/questions.ts` | 신규 |
| `skills/orch/scripts/loop/steps/prs.ts` | 신규 |
| `skills/orch/scripts/loop/steps/board.ts` | 신규 |
| `skills/orch/scripts/loop/steps/decisions.ts` | 신규 |
| `skills/orch/scripts/loop/steps/cleanup.ts` | 신규 |
| `skills/orch/scripts/loop/steps/ci.ts` | 신규 |
| `skills/orch/scripts/loop/steps/merged.ts` | 신규 |
| `skills/orch/scripts/loop/steps/stalls.ts` | 신규 |
| `skills/orch/scripts/loop/steps/movement.ts` | 신규 |
| `skills/orch/scripts/loop/steps/tick-event.ts` | 신규 |
| `skills/orch/scripts/loop/steps/auto-merge.ts` | 신규 |
| `skills/orch/scripts/loop/steps/queue-turns.ts` | 신규 |
| `skills/orch/scripts/loop/steps/conflicts.ts` | 신규 |
| `skills/orch/scripts/loop/steps/refresh.ts` | 신규 |
| `skills/orch/scripts/loop/steps/heavy-slot.ts` | 신규 |
| `skills/orch/scripts/loop/steps/unanswered.ts` | 신규 |
| `skills/orch/scripts/loop/steps/reports.ts` | 신규 |
| `skills/orch/scripts/loop/stalled-workers.ts` | 수정 (가리킴) |
| `skills/orch/scripts/core/screen.ts` | 수정 (가리킴) |
| `skills/orch/scripts/core/auto-merge.ts` | 수정 (가리킴) |
| `skills/orch/scripts/lib/refresh.ts` | 수정 (가리킴) |
| `skills/orch/scripts/lib/gh.ts` | 수정 (가리킴) |
| `skills/orch/scripts/lib/events.ts` | 수정 (가리킴) |
| `skills/orch/scripts/lib/movement.ts` | 수정 (가리킴) |
| `skills/orch/scripts/lib/heavy-hold.ts` | 수정 (가리킴) |
| `skills/orch/scripts/lib/queue-turn.ts` | 수정 (가리킴) |
| `skills/orch/scripts/lib/loop.ts` | 수정 (가리킴) |
| `skills/orch/scripts/lib/tell-worker.ts` | 수정 (가리킴) |
| `skills/orch/scripts/doctor/orch-doctor.ts` | 수정 (가리킴) |
| `skills/orch/references/overlay.md` | 수정 (가리킴) |
| `skills/orch/references/cleanup.md` | 수정 (가리킴) |
| `skills/orch/references/hooks.md` | 수정 (가리킴) |
| `skills/orch/references/verification.md` | 수정 (가리킴) |
| `skills/orch/references/heavy-checks.md` | 수정 (가리킴) |
| `docs/data-schema.md` | 수정 (가리킴) |
| `docs/flow.md` | 수정 (가리킴) |
| `docs/code-architecture.md` | 수정 (배치 줄) |
| `skills/orch/tests/loop-steps.spec.ts` | 신규 |
| `skills/orch/tests/script-folders.spec.ts` | 수정 (보조 스크립트 한 줄) |
| `skills/orch/tests/orch-loop-refresh.spec.ts` | 수정 (머리 주석의 가리킴) |
| `skills/orch/tests/orch-loop-auto-merge.spec.ts` | 수정 (머리 주석의 가리킴) |
| `skills/orch/tests/orch-loop.spec.ts` | 수정 (주석의 가리킴) |
| `skills/orch/changes/loop-steps.patch.md` | 신규 |
