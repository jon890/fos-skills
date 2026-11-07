# Phase 01. 실행 주입 경계

**Execution profile**: standard

## 목표
main의 asyncRunner를 lintGate·prepareReview·executeMain에 전달한다. spec-line·spec-lint의 main을 export하고 실경로 직접 실행 보호를 둔다. wait-important main에도 동기 runner를 받고 오류 처리기를 공유한다. 기존 테스트를 그대로 실행한다.

**범위 외**: 사용자 동작·출력 계약·실행기 동시 수 변경.

## 컨텍스트
스펙 DECISION4·DECISION16, 기술 설계 PR9를 따른다. 기존 fixture 상태와 단언은 유지한다.
**요구사항**: REQ1, REQ3, REQ4
**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md`

## 의도 메모
lib/proc의 공통 실행은 유지한다. hook·shell 가짜·신호는 실제 프로세스로 검증한다. 독립 검토는 PR 뒤 코디네이터가 제공하며 대기다.

## 작업 항목

### 1. 실행 경계와 회귀 검증
main의 asyncRunner를 lintGate·prepareReview·executeMain에 전달한다. spec-line·spec-lint의 main을 export하고 실경로 직접 실행 보호를 둔다. wait-important main에도 동기 runner를 받고 오류 처리기를 공유한다. 기존 테스트를 그대로 실행한다.

### 2. `skills/orch/tests/launch-worker-functions.spec.ts`의 import 회귀를 추가하고 기존 테스트 실행

launch-worker.spec.ts, spec-line.spec.ts, spec-lint.spec.ts의 기존 단언을 수정하지 않고 실행한다.

## 검증
```bash
node scripts/run-tests.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/spec-line.spec.ts skills/orch/tests/spec-lint.spec.ts skills/orch/tests/wait-important.spec.ts skills/orch/tests/launch-worker-functions.spec.ts
```
종료 코드 0과 기존 단언 통과를 확인한다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/worker/launch-worker.ts` | 수정 |
| `skills/orch/scripts/spec/spec-line.ts` | 수정 |
| `skills/orch/scripts/spec/spec-lint.ts` | 수정 |
| `docs/features/test-speed/design.md` | 수정 |
| `skills/orch/tests/launch-worker-functions.spec.ts` | 신규 |
| `skills/orch/scripts/wait/wait-important.ts` | 수정 |
| `skills/orch/changes/top-files-functions.patch.md` | 신규 |
