# Phase 01. 메인 판별, 넘겨받기, 요청

**Execution profile**: standard

## 목표

저장소마다 메인 코디네이터 하나가 루프를 맡게 하고, 다른 코디네이터가 요청 번호로 일을 맡기고 답을 받게 한다.

**범위 외**: 메인이 아닌 세션의 쓰기 명령 거절과 우회 옵션, doctor 알림(PR2).

## 컨텍스트

**요구사항**: REQ1~REQ10, REQ13 의 PR1 몫

**근거 문서**: `docs/features/orch-main-coordinator/spec.md`, `docs/features/orch-main-coordinator/design.md`, `docs/adr/035-orch-main-coordinator.md`

기존 패턴: 루프 등록은 `skills/orch/scripts/lib/loop.ts`, 루프 알림은 `lib/run-notice.ts`, 이어받기 문서는 `lib/sessions.ts` 의 `handover`, 보드 쓰기는 `extensions/work-board/bin/board.ts`.

## 의도 메모

- 새 세션이 `run-use` 로 앞 Run 에 붙는 길은 기각했다. 새 세션의 Run 메일이 끊긴다(설계 「결정」).
- 요청 항목은 마일스톤 단계를 갖고 만든다. 단계 없는 항목은 마무리의 doing 쓰기가 거절된다.

## 작업 항목

### 1. 판정과 조회

`scripts/core/main-coordinator.ts`(judgeMain, replyTarget, nextRequestState, boardIds, ackOverdue), `scripts/lib/main-coordinator.ts`(findMain, runAlive).

### 2. 넘겨받기

`scripts/loop/lifecycle.ts` 의 mainGate, judgeAndTake, takeOver 와 넘겨받기 잠금. `scripts/loop/takeover.ts` 의 moveWorkers, pendingRuns, announce. `scripts/loop/orch-loop.ts` 의 `--take-over`, `--confirmed`, 종료 코드 6.

### 3. 요청

`scripts/lib/requests.ts`, `scripts/request/orch-request.ts`, `scripts/lib/commands.ts` 의 request 묶음, `scripts/lib/run-notice.ts` 의 source 옵션.

### 4. 알림과 자동 완료

`scripts/loop/steps/requests.ts`(13번 단계), `pipeline.request_ack_sec`, `scripts/queue/finish-pr.ts` 의 completeRequest, `scripts/status/orch-status.ts` 의 MAIN 줄.

### 5. 문서

ADR-035, ADR-012 대체 이동, `docs/data-schema.md`, `docs/flow.md`, `skills/orch/references/requests.md`, `SKILL.md`, `references/overlay.md`, `references/waiting.md`, 변경 조각.

### 6. 테스트

`skills/orch/tests/core-main-coordinator.spec.ts`, `request.spec.ts`, `takeover.spec.ts`, `loop-requests-step.spec.ts`, `orch-loop.spec.ts`, `orch-status.spec.ts`, `finish-pr.spec.ts`.

## 검증 명령

```bash
node --test skills/orch/tests/core-main-coordinator.spec.ts skills/orch/tests/request.spec.ts skills/orch/tests/takeover.spec.ts skills/orch/tests/loop-requests-step.spec.ts skills/orch/tests/orch-status.spec.ts
node --test skills/orch/tests/orch-loop.spec.ts skills/orch/tests/finish-pr.spec.ts
orch slot heavy --exclusive -- node scripts/run-tests.ts
claude plugin test .
```
