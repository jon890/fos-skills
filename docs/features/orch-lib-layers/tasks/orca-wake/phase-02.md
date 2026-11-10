# Phase 02. 완료 보고와 끊긴 worker, 미답변 질문을 감시한다

**Execution profile**: deep

## 목표

루프 알림을 Run 메시지로 보내고 완료·끊김·미답변 감시를 루프로 옮겨 질문을 놓치는 길을 없앤다.

**범위 외**: core 층과 큰 스크립트 분리, 머지 큐 정책 변경.

## 컨텍스트

**요구사항**: REQ5, REQ14, REQ15

**근거 문서**: `docs/features/orch-lib-layers/spec.md`, `docs/features/orch-lib-layers/design.md`.
## 의도 메모

- --from run:<Run> 으로 보내고 consumer_fenced 일 때만 --from 없이 한 번 재시도한다. 설계의 성공 실측과 PR2 의 거절 실측을 모두 만족한다. ORCA_TERMINAL_HANDLE 은 유지한다.
- 변경 파일 상한 경고는 스펙 DECISION9 의 확인된 PR3 경계로 유지한다. 자체 대기 폐기와 감시 이전을 따로 배포하면 감시가 빠지거나 메일을 소비하는 옛 대기가 남는다.
- 한 PR 로 한다. 스펙 DECISION9 의 PR3 단위이며 메일을 읽는 대기와 알림 파일을 동시에 끊어야 호환 경로가 메일을 빼앗지 않는다.
- 옛 NEXT_WAIT 는 안내 껍데기로 받아 종료 코드 2 로 끝낸다. 도는 옛 프로세스는 자동 종료하지 않고 WAITER-LEFT 로 알린다.

## 작업 항목

### 1. 완료 보고와 PR 없는 작업

launch-worker 에 --no-pr boolean 옵션을 더하고 Launch 스키마와 launched-workers/launch-history 읽기·쓰기에 completion: "none" 을 보존한다. retry/resume 은 보존하고 새 후속 Task 는 기본 PR 계약을 쓴다.
`skills/orch/scripts/loop/completion-watch.ts` 에 wait-important 의 verifyCompletion 과 workerDone 을 옮긴다. lib/completion classify 는 유지한다. worker_done 과 status 를 따로 check --all 로 읽는다. 100행에 밀리면 inbox 3000행으로 보충한다. 그래도 마지막 seen 시각에 닿지 못하면 WATCH-ERROR done 을 보내고 seen 을 진행하지 않아 다음 틱이 재시도한다. 최초 틱은 과거 id 만 저장한다. 신규 ready 는 worker-done 이벤트와 linkBoardPr 를 유지한다. suspicious 는 dispatch 별 한 번 알리고 completion:none 은 뺀다.

### 2. 끊김과 미답변

`skills/orch/scripts/lib/lost-workers.ts` 에 wait-important 의 unhandledLost/dropWorking 판정을 옮긴다. workerRows 를 재사용하고 일부러 종료·다른 dispatch 로 재시도·작업 중 화면은 제외한다. wait-important-lost.json 기록은 유지하고 알림 성공한 끊김만 기록한다.
루프의 watchWaiter 를 600초 넘은 기술 질문 id 묶음으로 바꾼다. 묶음 변경 때만 UNANSWERED 를 보낸다. 이전 루프 alive_at 이 오래됐으면 시작할 때 등록된 Run 에 LOOP-RESTARTED 를 보낸다.

### 3. 개발 테스트

`skills/orch/tests/completion-watch.spec.ts` 에 ready/suspicious/no-pr, 최초 baseline, status·done 각각 100행 초과, 보충 조회 부족과 seen 미진행/재시도를 확인한다. `skills/orch/tests/lost-workers.spec.ts` 에 끊김·일부러 종료·다른 retry·작업 중 화면·send 실패 보존을 확인한다. 루프 질문 테스트는 묶음 중복 억제와 질문 추가·해소를 관측한다. launch-worker 테스트는 --no-pr 기록을 확인한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/completion-watch.spec.ts skills/orch/tests/lost-workers.spec.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/orch-loop.spec.ts
claude plugin test .
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/loop/orch-loop.ts` | 수정 |
| `skills/orch/scripts/worker/launch-worker.ts` | 수정 |
| `skills/orch/scripts/worker/resume-worker.ts` | 수정 |
| `skills/orch/scripts/lib/launched.ts` | 수정 |
| `skills/orch/tests/launch-worker.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop.spec.ts` | 수정 |
| `skills/orch/scripts/lib/lost-workers.ts` | 신규 |
| `skills/orch/scripts/loop/completion-watch.ts` | 신규 |
| `skills/orch/tests/completion-watch.spec.ts` | 신규 |
| `skills/orch/tests/lost-workers.spec.ts` | 신규 |
