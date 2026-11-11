# Phase 01. 보드 다음 단계를 알리고 대기를 끝낸다

**Execution profile**: deep

## 목표

REQ4, REQ5, REQ6, REQ9, REQ10, REQ11 을 구현해 코디네이터가 다음 단계를 이어 가게 한다.

**범위 외**: 보드 표시 편집 명령과 worker 자동 실행, 머지 알림 글.

## 컨텍스트

**요구사항**: REQ4, REQ5, REQ6, REQ9, REQ10, REQ11

**근거 문서**: `docs/features/board-auto-advance/spec.md`, `docs/features/board-auto-advance/design.md`

`firstPendingStep`, `itemBusy`, `stepLaunches` 를 재사용한다. 단계 조회는 보드 프로세스를 실행하고,
조회 실패는 오류로 남긴다. workerRows 의 shapeStatus 옵션으로 원본 목록 형식 확인 결과를 같은 조회에 실어 rowsOf 캐시가 보존하게 한다. 기존 호출자의 결과 형식은 유지한다. 틱의 `rowsOf` 와 열린 PR 결과를 재사용하고 외부 목록을 다시 읽지 않는다.
`sendNotice` 는 전송 실패를 던지므로 성공한 기록만 저장한다.

## 의도 메모

- movement 기록과 알림 기록을 분리해 idle_min=0 에서도 알린다.
- worker·PR 조회 실패는 없음으로 보지 않는다. 같은 글의 기록은 worker 가 떠도 유지한다.
- 보드 쓰기는 기존 board.ts step 의 잠금을 사용한다. 상태는 시각 wait 때문에 바꾸지 않는다.

## 작업 항목

### 1. 알림과 한도 기록

core/step-ready.ts 에 순수 후보·중복·재알림 판단을 둔다. lib/step-ready.ts 는 보드·단계·기록을 읽고
lib/worker-limited.ts 는 머신별 시각을 읽고 쓴다. 기존 file-lock.ts 의 withFileLock 으로 파일 옆 잠금을 잡은 뒤 다시 읽어 max(기존 시각, 새 시각)를 임시 파일과 rename 으로 저장한다. auto-check 는 한도 30분 내 거절한다.
알림 단계는 stalls 의 limitedNotified 전이를 기록하고 movement 다음에 실행한다.
예를 들어 항목 a, 단계 `2. [auto] 다음` 의 제목은 `STEP-READY a auto 2. [auto] 다음`, 본문은 `a 2. [auto] 다음` 이다. payload 는 `{source: "orch-loop", kind: "STEP-READY", pr: null, repo: 저장소 기본 checkout}` 이고 억제 키에도 repo 를 넣는다.

### 2. 멈춤과 시각 wait

lib/workers.ts 의 workerRows 가 같은 조회에서 shapeStatus 옵션으로 모든 페이지의 원본 형식을 검사해 shapeOk 를 반환하고, loop/steps/shared.ts 의 rowsOf 가 이 옵션을 켜 캐시에 보존한다. 옵션을 안 쓴 기존 호출자의 반환 형식은 유지한다. 잘못된 목록과 필수 키 누락은 orch-loop-step-ready.spec.ts 의 rawWorkers 사례로 확인한다.

liveWorkerOn 을 core/workers.ts 로 옮겨 auto-advance 와 movement 의 순환 참조를 피한다. collectStages 는 첫 미완료 표시와 띄운 기록·열린 PR·열린 dispatch 를 stalledStages 에 넘긴다.
표시 없는 줄은 기존 길을 유지하고, 실행한 auto 는 doing/wait 와 빈 연결 필드에서도 감지한다.
시각 wait 는 보드 동기화에서 첫 단계와 무관하게 완료하고, 잘못된 날짜는 건너뛴다.
board.md 의 PR A 과도기 안내를 실제 동작으로 맞추고 변경 조각을 추가한다.

### 3. `skills/orch/tests/core-step-ready.spec.ts` 와 `skills/orch/tests/orch-loop-step-ready.spec.ts` 테스트

단위 테스트로 기록 유지·글 변경·한도 재알림의 경계와 날짜 파싱을 확인한다.
실제 보드 도구·가짜 CLI 로 틱을 실행해 동일 틱 알림, 재시작, 전송 실패 재시도,
조회 실패와 ask, 설정 false, 한도 기록과 멈춘 실행 auto 를 확인한다.
기존 loop-order/golden 결과는 새 오류 출처 외 의도하지 않은 변경이 없는지 확인한다.

## 검증

```bash
node --test skills/orch/tests/core-step-ready.spec.ts skills/orch/tests/orch-loop-step-ready.spec.ts skills/orch/tests/lib-movement.spec.ts skills/orch/tests/board-auto-check.spec.ts skills/orch/tests/board-sync.spec.ts skills/orch/tests/loop-order.spec.ts skills/orch/tests/run-notice.spec.ts skills/orch/tests/worker-limited.spec.ts
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/core/step-ready.ts` | 신규 |
| `skills/orch/scripts/lib/step-ready.ts` | 신규 |
| `skills/orch/scripts/lib/worker-limited.ts` | 신규 |
| `skills/orch/scripts/loop/steps/step-ready.ts` | 신규 |
| `skills/orch/tests/core-step-ready.spec.ts` | 신규 |
| `skills/orch/tests/orch-loop-step-ready.spec.ts` | 신규 |
| `skills/orch/scripts/core/auto-advance.ts` | 수정 |
| `skills/orch/scripts/lib/auto-advance.ts` | 수정 |
| `skills/orch/scripts/core/movement.ts` | 수정 |
| `skills/orch/scripts/lib/movement.ts` | 수정 |
| `skills/orch/scripts/loop/steps/movement.ts` | 수정 |
| `skills/orch/scripts/loop/steps/context.ts` | 수정 |
| `skills/orch/scripts/loop/steps/errors.ts` | 수정 |
| `skills/orch/scripts/loop/orch-loop.ts` | 수정 |
| `skills/orch/scripts/lib/run-notice.ts` | 수정 |
| `skills/orch/scripts/board/board-sync.ts` | 수정 |
| `skills/orch/tests/lib-movement.spec.ts` | 수정 |
| `skills/orch/tests/board-auto-check.spec.ts` | 수정 |
| `skills/orch/tests/board-sync.spec.ts` | 수정 |
| `skills/orch/references/board.md` | 수정 |
| `skills/orch/changes/board-step-ready.minor.md` | 신규 |
| `docs/data-schema.md` | 수정 |
| `skills/orch/references/replying.md` | 수정 |
| `skills/orch/tests/run-notice.spec.ts` | 수정 |
| `skills/orch/references/overlay.md` | 수정 |
| `skills/orch/scripts/lib/workers.ts` | 수정 |
| `skills/orch/scripts/loop/steps/shared.ts` | 수정 |
| `skills/orch/tests/worker-limited.spec.ts` | 신규 |
| `skills/orch/scripts/core/workers.ts` | 수정 |
| `skills/orch/tests/golden/loop/**/result.json` | 수정 |
| `skills/orch/tests/loop-order/**/result.json` | 수정 |
