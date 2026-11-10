# Phase 03. 혼합 파일의 순수 판정 분리

**Execution profile**: standard

## 목표

혼합 파일의 순수 판정 분리로 기존 동작을 지킨다.

**범위 외**: 외부 동작과 후속 단계 분리.

## 컨텍스트

**요구사항**: REQ10, REQ11

**근거 문서**: `docs/features/orch-lib-layers/spec.md`, `docs/features/orch-lib-layers/design.md`

## 작업 항목

### 1. 함수 이동과 테스트

movement: 타입과 worktreeOf, livenessOf, tailHash, markScreen, judgeWorker, openRows, pendingStep, stalledStages, idleNotices, stageNotices, readRecords, workerLine, stageLine 을 core 로 옮기고 lib 는 조회·설정·수집을 맡는다. workers 의 LIVE_DISPATCH 는 core/workers.ts 에 두고 재수출한다. questions: Message, Notice, unanswered, ageSeconds, brief, questionLocations, dispatchOf 를 core 로 옮기고 snapshot/poll/closedReason/파일 작업은 lib 에 둔다. decisions: Entry, hash, flatten, lines, isUserDecision, decisionEntries, sameKeys 를 core 로 옮기고 retryMs 와 notifyDecisions 는 lib 에 둔다. loop: 상태 타입과 runKey, judgeLoop(state: LoopState | null, now: number, pidAlive: boolean, loopProcess: boolean | null = null): LoopStatus 로 값을 받아 결과를 내는 함수 를 core 로 옮기고 lib loopStatus 는 readLoop/alive/isLoopProcess 를 맡는다. process 확인은 만료된 살아 있는 pid 에서만 실행하며 false 일 때 recheck 를 빼고 true/null 은 보존한다. conflicts: notifiedKey 를 core 로 옮긴다. refresh: 타입·상수, joined, refreshSettings, verdict, aheadInQueue, isRecord, inFlight 를 core 로 옮기고 git/files 는 lib 에 둔다. lost-workers: Json/Lost 타입, lostWorkers, retriedLost, deliberateEnd, taskClosed 를 core 로 옮기고 조회·쓰기·watchLost 는 lib 에 둔다. lib 의 원래 export 를 유지한다. tests/core-boundary.spec.ts 는 import type 포함 core 경계와 금지 표현 및 core 테스트의 fake-bin·환경 조작을 거부하며 임시 금지 파일로 검사 자체도 검증한다.

### 2. 경계 테스트

`skills/orch/tests/core-boundary.spec.ts` 에 import 거부와 순수 테스트 검사를 구현한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/core-boundary.spec.ts skills/orch/tests/lib-movement.spec.ts skills/orch/tests/questions.spec.ts skills/orch/tests/decisions.spec.ts skills/orch/tests/lib-refresh.spec.ts skills/orch/tests/lib-loop.spec.ts skills/orch/tests/lost-workers.spec.ts skills/orch/tests/notify-conflicts.spec.ts skills/orch/tests/core-values.spec.ts
node skills/orch/tests/fixtures/golden-run.ts
GOLDEN_COMMIT=$(git log --reverse --format=%H origin/main..HEAD -- skills/orch/tests/golden | head -1)
git diff --exit-code "$GOLDEN_COMMIT" HEAD -- skills/orch/tests/golden
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/**/*.ts` | 수정 |
| `skills/orch/scripts/core/*.ts` | 신규 |
| `skills/orch/tests/core-boundary.spec.ts` | 신규 |
| `skills/orch/tests/core-values.spec.ts` | 수정 |
