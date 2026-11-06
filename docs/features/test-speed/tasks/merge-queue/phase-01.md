# Phase 01. 명령 주입 경계를 더하고 기존 테스트를 유지한다

**Execution profile**: standard

## 목표

명령 주입 경계를 더하고 기존 테스트를 유지한다.

**범위 외**: 다른 테스트 묶음과 큐 출력 계약 변경.

## 컨텍스트

**요구사항**: REQ2

**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md`

## 의도 메모

실제 jq 와 git 사본 검사, 신호 프로세스는 유지한다. 독립 검토는 코디네이터가 담당한다.

## 작업 항목

### 1. 실행 경계와 테스트 준비

proc 의 withRun/runProcess 와 큐의 main import 경계를 더한다. 기존 merge-queue 테스트를 고치지 않고 통과시킨다.

### 2. `skills/orch/tests/merge-queue-runner.spec.ts` 의 주입 격리와 import 회귀 테스트를 더한다

`fakeRun` 을 별도 비동기 흐름에 주입하고 실제 실행 위임과 복구를 확인한다.

### 3. `skills/orch/tests/merge-queue.spec.ts` 와 `skills/orch/tests/merge-queue-overlap.spec.ts` 회귀 검증

기존 테스트의 성공·실패·신호 단언을 실제로 실행한다. 첫 phase 는 기존 테스트를 수정하지 않는다.

## 검증

기존 정상·보류·사용법 오류와 겹침·hook·신호 단언이 통과해야 한다.

```bash
node scripts/run-tests.ts skills/orch/tests/merge-queue.spec.ts skills/orch/tests/merge-queue-overlap.spec.ts skills/orch/tests/merge-queue-runner.spec.ts
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/lib/proc.ts` | 수정 |
| `skills/orch/scripts/queue/merge_queue.ts` | 수정 |
| `skills/orch/changes/test-speed-merge-queue.patch.md` | 신규 |
| `skills/orch/tests/merge-queue-runner.spec.ts` | 신규 |
| `docs/features/test-speed/design.md` | 수정 |
