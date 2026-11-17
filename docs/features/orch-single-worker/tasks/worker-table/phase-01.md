# Phase 01. 행별 worker 선택과 예외 기록

**Execution profile**: standard

## 목표
행마다 정해진 worker 를 쓰고, 다르게 띄울 때 이유와 실제 worker 를 기록한다.

**범위 외**: PR1 커밋 검사와 사용 한도 표 변경.

## 컨텍스트
**요구사항**: REQ2, REQ3, REQ4, REQ5, REQ6, REQ7, REQ8, REQ9

**근거 문서**: `docs/features/orch-single-worker/spec.md`, `docs/features/orch-single-worker/design.md`

## 의도 메모
기존 선택 검사와 기록 경계를 재사용한다. 사용 한도 표와 옛 이력 파서는 바꾸지 않는다.

## 작업 항목
### 1. agent-selection 표를 에이전트·모델·effort 로 읽고 값 전체를 정확히 비교한다. review 는 기존 다른 제공자 선택을 재사용한다.
### 2. 새 지시서의 비교 칸과 experiment 를 거절하고, active 및 확인된 이어하기는 허용한다. 후보 밖 이유와 실제 worker 전체를 출력과 영구 이력의 `effective.candidateOverride` 에 남긴다. `skills/orch/scripts/lib/launched.ts` 의 Effective 타입과 `docs/data-schema.md` 를 함께 맞춘다.
### 3. SKILL, spec-writing, 공통·리뷰·검증 템플릿과 관련 문서를 새 규칙에 맞춘다. 변경 조각을 남긴다.
### 4. skills/orch/tests/lib-selection.spec.ts 와 CLI 테스트
`skills/orch/tests/lib-selection.spec.ts` 선택 단위 테스트와 lint·launch·review CLI 테스트에서 정상, 값별 불일치, 예외 기록, 옛 실행 호환을 검증한다. REQ8 보드 생성은 코디네이터가 머지 때 맡는다.

## 검증
```bash
node scripts/run-tests.ts skills/orch/tests
node scripts/run-tests.ts --tsc-only
claude plugin test .
```
누적 전체 검증은 heavy slot 으로 실행한다. 모든 명령의 종료 코드는 0 이어야 한다.

## 변경 파일
| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/lib/selection.ts` | 수정 |
| `skills/orch/scripts/lib/spec.ts` | 수정 |
| `skills/orch/scripts/lib/review-spec.ts` | 수정 |
| `skills/orch/scripts/spec/spec-lint.ts` | 수정 |
| `skills/orch/scripts/spec/review-spec.ts` | 수정 |
| `skills/orch/scripts/worker/launch-worker.ts` | 수정 |
| `skills/orch/references/agent-selection.md` | 수정 |
| `skills/orch/references/spec-writing.md` | 수정 |
| `skills/orch/SKILL.md` | 수정 |
| `skills/orch/templates/spec-common.md` | 수정 |
| `skills/orch/templates/spec-review.md` | 수정 |
| `skills/orch/templates/spec-verify.md` | 수정 |
| `skills/orch/scripts/lib/launched.ts` | 수정 |
| `docs/data-schema.md` | 수정 |
| `docs/features/orch-routing/design.md` | 수정 |
| `docs/features/orch-routing/evidence.md` | 수정 |
| `skills/orch/tests/lib-spec.spec.ts` | 수정 |
| `skills/orch/tests/lib-selection.spec.ts` | 수정 |
| `skills/orch/tests/spec-lint.spec.ts` | 수정 |
| `skills/orch/tests/launch-worker.spec.ts` | 수정 |
| `skills/orch/tests/review-spec.spec.ts` | 수정 |
| `skills/orch/tests/**` | 수정 |
| `skills/orch/changes/single-worker-table.minor.md` | 신규 |
