# Phase 03. 옛 대기를 막고 문서를 맞춘다

**Execution profile**: deep

## 목표

루프 알림을 Run 메시지로 보내고 완료·끊김·미답변 감시를 루프로 옮겨 질문을 놓치는 길을 없앤다.

**범위 외**: core 층과 큰 스크립트 분리, 머지 큐 정책 변경.

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ8, REQ17, REQ19

**근거 문서**: `docs/features/orch-lib-layers/spec.md`, `docs/features/orch-lib-layers/design.md`.
## 의도 메모

- --from run:<Run> 으로 보내고 consumer_fenced 일 때만 --from 없이 한 번 재시도한다. 설계의 성공 실측과 PR2 의 거절 실측을 모두 만족한다. ORCA_TERMINAL_HANDLE 은 유지한다.
- 변경 파일 상한 경고는 스펙 DECISION9 의 확인된 PR3 경계로 유지한다. 자체 대기 폐기와 감시 이전을 따로 배포하면 감시가 빠지거나 메일을 소비하는 옛 대기가 남는다.
- 한 PR 로 한다. 스펙 DECISION9 의 PR3 단위이며 메일을 읽는 대기와 알림 파일을 동시에 끊어야 호환 경로가 메일을 빼앗지 않는다.
- 옛 NEXT_WAIT 는 안내 껍데기로 받아 종료 코드 2 로 끝낸다. 도는 옛 프로세스는 자동 종료하지 않고 WAITER-LEFT 로 알린다.

## 작업 항목

### 1. 옛 명령 안내

wait 껍데기 전환과 같은 커밋에서 lib/loop 의 알림 파일 API 와 lib/user-active 를 제거한다.

`skills/orch/scripts/lib/retired.ts` 에 retiredMain 을 만들고 commands 행에 retired 를 더한다. 진입점은 문맥 조회 전에 한 줄 안내와 2 를 낸다. wait 스크립트는 retiredMain 껍데기로 둔다. nudge-worker 는 --state/--classify 화면 읽기만 남긴다. 옛 NEXT_WAIT 는 메일을 읽지 않고 같은 안내로 끝난다.
doctor 는 저장소 hooks 의 nudge 호출을 NUDGE-HANDLER 로, 남은 대기 프로세스를 WAITER-LEFT 로 알린다. 루프 시작도 대기를 알리고 자동 종료하지 않는다.

### 2. 문서와 ADR

waiting 을 Orca 깨움과 사용자 답 우선 규칙으로 다시 쓰고 hooks 예시를 worker send 로 바꾼다. SKILL/README, CLI 안내, data-schema 의 없어진 파일 항목을 맞춘다. 깨우기 ADR 을 만들고 ADR-012/013 의 관련 부분을 대체 관계로 잇는다. changes 조각을 추가한다.

### 3. 개발 테스트

`skills/orch/tests/retired.spec.ts` 로 새 CLI·legacy·직접 경로·NEXT_WAIT 옵션의 한 줄 안내와 2, Orca 무조회를 확인한다. `skills/orch/tests/check-peek.spec.ts` 로 check 호출이 peek/all 을 쓰고 ack 하지 않는 것을 확인한다. 기존 nudge/doctor/launcher/docs-contract 테스트를 바뀐 계약에 맞춘다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/retired.spec.ts skills/orch/tests/check-peek.spec.ts skills/orch/tests/nudge-worker.spec.ts skills/orch/tests/orch-doctor.spec.ts skills/orch/tests/orch-launcher.spec.ts skills/orch/tests/coordinator-hooks.spec.ts
claude plugin test .
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/bin/orch.ts` | 수정 |
| `skills/orch/scripts/lib/commands.ts` | 수정 |
| `skills/orch/scripts/wait/*.ts` | 수정 |
| `skills/orch/scripts/worker/nudge-worker.ts` | 수정 |
| `skills/orch/scripts/doctor/orch-doctor.ts` | 수정 |
| `skills/orch/scripts/loop/orch-loop.ts` | 수정 |
| `skills/orch/SKILL.md` | 수정 |
| `skills/orch/README.md` | 수정 |
| `skills/orch/references/*.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `docs/adr/*.md` | 수정 |
| `skills/orch/tests/nudge-worker.spec.ts` | 수정 |
| `skills/orch/tests/orch-doctor.spec.ts` | 수정 |
| `skills/orch/tests/orch-launcher.spec.ts` | 수정 |
| `skills/orch/tests/coordinator-hooks.spec.ts` | 수정 |
| `skills/orch/scripts/lib/retired.ts` | 신규 |
| `skills/orch/tests/retired.spec.ts` | 신규 |
| `skills/orch/tests/check-peek.spec.ts` | 신규 |
| `skills/orch/changes/orca-wake.minor.md` | 신규 |
| `skills/orch/scripts/lib/user-active.ts` | 삭제 |
| `skills/orch/scripts/lib/loop.ts` | 수정 |
