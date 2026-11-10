# Phase 01. 루프 알림을 메시지로 옮긴다

**Execution profile**: deep

## 목표

루프 알림을 Run 메시지로 보내고 완료·끊김·미답변 감시를 루프로 옮겨 질문을 놓치는 길을 없앤다.

**범위 외**: core 층과 큰 스크립트 분리, 머지 큐 정책 변경.

## 컨텍스트

**요구사항**: REQ3, REQ4, REQ6, REQ9, REQ16

**근거 문서**: `docs/features/orch-lib-layers/spec.md`, `docs/features/orch-lib-layers/design.md`.
## 의도 메모

- --from run:<Run> 으로 보내고 consumer_fenced 일 때만 --from 없이 한 번 재시도한다. 설계의 성공 실측과 PR2 의 거절 실측을 모두 만족한다. ORCA_TERMINAL_HANDLE 은 유지한다.
- 변경 파일 상한 경고는 스펙 DECISION9 의 확인된 PR3 경계로 유지한다. 자체 대기 폐기와 감시 이전을 따로 배포하면 감시가 빠지거나 메일을 소비하는 옛 대기가 남는다.
- 한 PR 로 한다. 스펙 DECISION9 의 PR3 단위이며 메일을 읽는 대기와 알림 파일을 동시에 끊어야 호환 경로가 메일을 빼앗지 않는다.
- 옛 NEXT_WAIT 는 안내 껍데기로 받아 종료 코드 2 로 끝낸다. 도는 옛 프로세스는 자동 종료하지 않고 WAITER-LEFT 로 알린다.

## 작업 항목

### 1. 메시지 보내기

`skills/orch/scripts/lib/run-notice.ts` 에 notifyRun(run, kind, text, pr?) 을 만든다. --from run:<Run> 으로 보내고 consumer_fenced 일 때만 --from 없이 한 번 재시도한다. ORCA_TERMINAL_HANDLE 은 유지한다. 설계의 성공 실측과 PR2 의 거절 실측을 함께 만족한다.
`skills/orch/scripts/lib/loop.ts` 의 알림 파일 쓰기를 중단하고 읽기 API 는 phase 03 까지 유지한다. 기존 루프, queue 의 appendEvent 호출을 notifyRun 으로 바꾼다. 성공한 전송만 CI·충돌·멈춤·움직임·자동머지·errors 중복 억제 상태에 적는다. 실패는 NOTICE-FAIL 로그와 다음 틱 재시도로 처리한다.

### 2. 결정 알림과 옛 파일 정리

decision-pending 기본 핸들러는 notifyRun 을 부른다. lib/decisions 는 사용자 활동 판정을 제거하되 저장소 핸들러 우선과 실패 재시도를 유지한다. 입력 기록 hook 을 제거한다. lib/user-active 와 user-active CLI 는 옛 wait 소비자의 import 를 위해 phase 03 까지 유지한다.
`skills/orch/scripts/cleanup/legacy-notices.ts` 에 옛 파일 정리를 만든다. loop-events 는 cursor 뒤 알림을 Run 에 전송한 뒤 성공한 파일만 휴지통으로 옮긴다. 전송 실패 파일은 남긴다. wait 와 no-wait 도 휴지통으로 옮긴다.

### 3. 개발 테스트

`skills/orch/tests/run-notice.spec.ts` 에 정상·consumer_fenced·일반 실패·Run 분리·환경 보존을 확인한다. 기존 lib-loop, decisions, 루프 알림과 cleanup-state 테스트를 메시지 관측으로 바꾸고 실패 뒤 재시도와 파일 보존을 확인한다. `skills/orch/tests/decisions.spec.ts` 에 저장소 핸들러 우선과 대화 중에도 전달되는 사례를 둔다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/run-notice.spec.ts skills/orch/tests/lib-loop.spec.ts skills/orch/tests/decisions.spec.ts skills/orch/tests/orch-loop.spec.ts skills/orch/tests/orch-loop-ci.spec.ts skills/orch/tests/orch-loop-stall.spec.ts skills/orch/tests/orch-loop-conflict.spec.ts skills/orch/tests/orch-loop-auto-merge.spec.ts skills/orch/tests/cleanup-sweep-state.spec.ts
claude plugin test .
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/lib/loop.ts` | 수정 |
| `skills/orch/scripts/lib/decisions.ts` | 수정 |
| `skills/orch/scripts/handlers/decision-pending.ts` | 수정 |
| `skills/orch/scripts/loop/orch-loop.ts` | 수정 |
| `skills/orch/scripts/queue/merge_queue.ts` | 수정 |
| `skills/orch/scripts/cleanup/cleanup-sweep.ts` | 수정 |
| `skills/orch/hooks/hooks.json` | 수정 |
| `skills/orch/tests/lib-loop.spec.ts` | 수정 |
| `skills/orch/tests/decisions.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-ci.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-stall.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-conflict.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-auto-merge.spec.ts` | 수정 |
| `skills/orch/tests/cleanup-sweep-state.spec.ts` | 수정 |
| `skills/orch/scripts/lib/run-notice.ts` | 신규 |
| `skills/orch/scripts/cleanup/legacy-notices.ts` | 신규 |
| `skills/orch/tests/run-notice.spec.ts` | 신규 |
| `skills/orch/hooks/record-user-input.ts` | 삭제 |
| `skills/orch/tests/coordinator-hooks.spec.ts` | 수정 |
