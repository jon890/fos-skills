# Phase 05. 검증과 문서 정리

**Execution profile**: standard

## 목표

검증과 문서 정리로 기존 동작을 유지한다.

**범위 외**: loop-steps, queue-steps, cleanup-steps 구현.

## 컨텍스트

**요구사항**: REQ10, REQ11, REQ13

**근거 문서**: `docs/features/orch-lib-layers/spec.md`, `docs/features/orch-lib-layers/design.md`

## 의도 메모

새 의존 없이 폴더와 소스 검사로 경계를 지킨다.

## 작업 항목

### 1. 구현과 테스트

두 층 ADR 을 쓰고 코드 구조 문서와 orch README 에 책임과 경계 검사 경로를 연결한다. 변경 조각을 더한다. 고친 곳의 기존 테스트만 로컬 실행하고 전체 테스트는 CI 에 맡긴다. 독립 verify 와 문서 검토자는 읽기 전용으로 검토한다. 실제 외부 동작 변경이 없어 실제 Orca 인수 검증은 필요하지 않다. docs-consolidate 는 관련 스펙·설계·구조 문서를 대조하고 후보 또는 후보 없음 근거를 PR 에 남긴다. 검증 절차와 결과를 PR 에 보존한 뒤 이 계획 폴더만 지운다.

## 검증

```bash
claude plugin test .
node scripts/run-tests.ts --tsc-only
node skills/orch/tests/fixtures/golden-run.ts
GOLDEN_COMMIT=$(git log --reverse --format=%H origin/main..HEAD -- skills/orch/tests/golden | head -1)
git diff --exit-code "$GOLDEN_COMMIT" HEAD -- skills/orch/tests/golden
node --test skills/orch/tests/golden.spec.ts
```

종료 코드 0, 고정 입력 기록 차이 없음이 기대값이다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `docs/adr/028-orch-core-layer.md` | 신규 |
| `docs/adr/INDEX.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `skills/orch/README.md` | 수정 |
| `skills/orch/changes/core-layer.patch.md` | 신규 |
