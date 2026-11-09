# Phase 01. Orca 메시지로 전달하고 후속 작업을 기록한다

**Execution profile**: standard

## 목표

터미널에 입력하지 않고 worker 에게 답과 후속 작업을 보낸다.

**범위 외**: 코디네이터 대기 제거, core 분리, 루프 단계 분리.

## 컨텍스트

**요구사항**: REQ6 중 send-to-worker 경로, REQ18

**근거 문서**: `docs/features/orch-lib-layers/spec.md`, `docs/features/orch-lib-layers/design.md`의 「worker 에게 보내기와 후속 일」.
`worker/send-to-worker.ts` 의 reply 거절 처리와 launch-worker 복구 경로는 보존한다.
기록은 `lib/launched.ts` 의 recordLaunch 와 `lib/launch-history.ts` 의 recordHistory 를 쓴다.
두 함수의 상태 파일 쓰기는 범위 안이며 보드 등록과 이벤트 발행은 추가하지 않는다.

## 의도 메모

- nudge-worker 실행 대신 Orca 메시지 전달 결과를 믿는다. 화면 읽기가 필요한 끝난 dispatch 의 본문 전송만 화면 판정을 재사용한다.
- reopened 는 새 터미널을 만들므로 이전 handle 을 기록하지 않는다.

## 작업 항목

### 1. worker/send-to-worker.ts

활성 dispatch 는 reply/send 뒤 0 으로 끝내고 nudge 를 호출하지 않는다.
끝난 dispatch 의 --spec 은 permissionsOf, selectionVerdict(text, worktree || process.cwd(), {launch:true,retry:true,continuation:false}) 로 검사하고 spec-line 과 같은 한 줄을 send 한다.
follow_up/reopened 영수증의 dispatchId/taskId 와 새 worker-show 의 worker.agentTerminalHandle 또는 resource.terminalHandle 을 읽는다.
새 터미널 조회 실패는 빈 터미널과 경고로 기록하며 이미 보낸 작업을 다시 띄우지 않는다.
recordLaunch 와 recordHistory 에 앞 워크트리, 지시서 절대경로, 브랜치와 선택 정보를 남기고 FOLLOW-UP 을 낸다.
성공 영수증의 delivery 가 예상과 다르거나 dispatchId/taskId 가 없으면 5 와 경고로 끝내고 다시 띄우지 않는다. 기록 쓰기는 각각 따로 시도하고 실패를 stderr 에 알리되 이미 전달됐으므로 0 이다. 이 예외들도 테스트한다.
send 거절 때만 기존 launch-worker/agent_unconfigured 경로로 내린다.
끝난 dispatch 에 spec 없이 본문만 있고 화면이 working 이면 send 하고 기록 누락을 stderr 에 알린다.

### 2. `skills/orch/tests/send-to-worker.spec.ts` 테스트와 문서

send-to-worker.spec.ts 의 기존 입력 기대값을 메시지 전달로 바꾸고 nudge 미호출을 검증한다.
정상 follow_up, 닫힌 터미널 reopened, 새 터미널 조회 실패, 잘못된 허락/선택 줄, send 거절 복구를 검증한다.
cleanup-sweep 의 launchedOwn 이 reopened 의 새 터미널 기록을 인정하는 사례를 추가한다.
replying.md 와 짧은 출력 계약에서 바뀐 경로를 맞추고 변경 조각을 추가한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/send-to-worker.spec.ts skills/orch/tests/cleanup-sweep-launched.spec.ts
claude plugin test .
git diff --check
```

전체 테스트와 타입 검사는 CI 의 Tests 가 실행한다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/worker/send-to-worker.ts` | 수정 |
| `skills/orch/scripts/lib/launched.ts` | 수정 (설명) |
| `skills/orch/tests/send-to-worker.spec.ts` | 수정 |
| `skills/orch/tests/cleanup-sweep-launched.spec.ts` | 수정 (사례) |
| `skills/orch/references/replying.md` | 수정 |
| `docs/features/orch-cli/design.md` | 수정 (짧은 출력 계약) |
| `skills/orch/changes/send-wake.minor.md` | 신규 |
