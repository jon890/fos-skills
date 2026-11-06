# Phase 01. 띄우기 우회와 변경된 모델의 행 누락을 막는다

**Execution profile**: standard

## 목표

PR-B 후속 P3를 회귀 테스트로 재현하고 고친다.

**범위 외**: 모델 선택 정책 변경.

## 컨텍스트

**요구사항**: REQ5 구현에 앞선 PR-B 후속 수정.

**근거 문서**: `docs/features/orch-routing/spec.md`, `docs/features/orch-routing/design.md`.
`require-spec-line.ts`의 rawRetry와 `launch-worker.ts`의 continuation 판정을 수정한다.

## 의도 메모

- 단순 문자열 검색은 echo·주석을 오탐하므로 명령 위치에서만 검사한다.
- 옛 지시서 행 누락은 같은 지시서와 같은 모델·effort를 이어 쓰는 경우만 허용한다.

## 작업 항목

### 1. hook이 전역 옵션, 괄호, if·then, time으로 감싼 직접 재시도를 거부하도록 한다.
### 2. 같은 Task라도 모델·effort를 바꿔 다시 띄우면 행이 필요하도록 한다.
### 3. `skills/orch/tests/coordinator-hooks.spec.ts`와 launch-worker.spec.ts 회귀 테스트

기존 허용 경로와 새 거부 경로를 검증한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/coordinator-hooks.spec.ts skills/orch/tests/launch-worker.spec.ts
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/hooks/require-spec-line.ts` | 수정 |
| `skills/orch/scripts/worker/launch-worker.ts` | 수정 |
| `skills/orch/tests/coordinator-hooks.spec.ts` | 수정 |
| `skills/orch/tests/launch-worker.spec.ts` | 수정 |
