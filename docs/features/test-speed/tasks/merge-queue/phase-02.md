# Phase 02. 함수 가짜와 저장소 템플릿으로 전환한다

**Execution profile**: standard

## 목표

함수 가짜와 저장소 템플릿으로 전환한다.

**범위 외**: 다른 테스트 묶음과 큐 출력 계약 변경.

## 컨텍스트

**요구사항**: REQ1, REQ3, REQ6

**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md`

## 의도 메모

실제 jq 와 git 사본 검사, 신호 프로세스는 유지한다. 독립 검토는 코디네이터가 담당한다.

## 작업 항목

### 1. 실행 경계와 테스트 준비

기존 판정 단언을 유지하며 가짜 gh/git 을 함수로 주입한다. CLI 와 함수 가짜 대응, 주입 격리 테스트를 더한다. 실제 git 초기 상태를 templateRepo/copyRepo 로 복사한다.

### 2. `skills/orch/tests/merge-queue.spec.ts` 와 `skills/orch/tests/merge-queue-overlap.spec.ts` 회귀 검증

기존 테스트의 성공·실패·신호 단언을 실제로 실행한다. 첫 phase 는 기존 테스트를 수정하지 않는다.

## 검증

기존 정상·보류·사용법 오류와 겹침·hook·신호 단언이 통과해야 한다.

```bash
node scripts/run-tests.ts skills/orch/tests/merge-queue.spec.ts skills/orch/tests/merge-queue-overlap.spec.ts skills/orch/tests/merge-queue-runner.spec.ts
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/tests/merge-queue.spec.ts` | 수정 |
| `skills/orch/tests/merge-queue-overlap.spec.ts` | 수정 |
| `skills/orch/tests/fixtures/merge-queue-fakes.ts` | 수정 |
| `skills/orch/tests/fixtures/merge-queue-run.ts` | 신규 |
| `skills/orch/tests/merge-queue-runner.spec.ts` | 수정 |
| `docs/features/test-speed/design.md` | 수정 |
