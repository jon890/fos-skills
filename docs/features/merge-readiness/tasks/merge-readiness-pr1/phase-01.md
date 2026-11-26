# Phase 01. CI 체크 판단과 필수 체크 조회 공통화

**Execution profile**: standard

## 목표

머지 큐와 루프가 실패, 진행 중, 미등장 체크를 한곳에서 판단하도록 옮긴다. 기존 출력과 종료 조건을 유지한다.

**범위 외** 머지 조건 표 연결, draft 옵션 제거, 체크 없음과 보류 규칙 변경, 자동 머지 조건 변경.

## 컨텍스트

**요구사항** REQ1

**근거 문서**: `docs/features/merge-readiness/spec.md`, `docs/features/merge-readiness/technical-design.md`

## 의도 메모

- 체크가 없을 때 큐는 필수 이름이 비었으면 통과하고 루프는 계속 기다린다. SKIPPED 옵션을 켜면 큐는 필수 체크 등장 여부에서만 해당 행을 빼고 루프는 판단에서 행을 뺀다.
- 체크 롤업을 읽는 시점과 HEAD 확인, 캐시 무효화, 대기 시간 계산을 유지한다. 규칙 API 조회 오류, 해석 오류, 플랜 제한은 구분한다.

## 작업 항목

### 1. 체크 판단을 순수 함수로 옮긴다

`currentChecks`와 `judgeChecks`를 `core/checks.ts`에 둔다. `lib/gh.ts`는 기존 체크 관련 공개 함수와 타입을 다시 내보낸다. 큐의 체크 대기, 관문, 머지 직전 확인에서 jq로 계산하던 실패, 진행 중, 미등장을 공통 함수 결과로 읽는다. 시각 계산에 쓰는 jq는 유지한다.

### 2. 필수 체크 이름을 같은 함수로 읽는다

큐에서도 `ruleChecks`를 쓴다. 명시한 필수 체크가 있으면 규칙 API를 건너뛰고, 플랜 제한이면 기존 경고와 빈 목록을 사용한다. 규칙 응답 해석 오류는 예외로 전파한다.

### 3. 경계 사례를 검증한다

`core-checks.spec.ts`에서 허용한 실패, SKIPPED, EXPECTED, 필수 체크 이름과 빈 롤업의 차이를 확인한다. 기존 orch 테스트의 기대값과 고정 입력은 유지한다.

## 검증

```bash
node scripts/run-tests.ts --concurrency 2 skills/orch/tests
git diff --check
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/core/checks.ts` | 신규 |
| `skills/orch/scripts/lib/gh.ts` | 수정 |
| `skills/orch/scripts/queue/steps/checks.ts` | 수정 |
| `skills/orch/scripts/queue/steps/gate.ts` | 수정 |
| `skills/orch/scripts/queue/steps/merge.ts` | 수정 |
| `skills/orch/scripts/queue/steps/model.ts` | 수정 |
| `skills/orch/scripts/queue/steps/pr.ts` | 수정 |
| `skills/orch/scripts/queue/steps/runtime.ts` | 수정 |
| `skills/orch/tests/core-checks.spec.ts` | 신규 |

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 저장소 의존 설치 | `node scripts/run-tests.ts --concurrency 2 skills/orch/tests` | 체크 판단, 관문, 머지 큐, 루프 테스트와 고정 입력의 기존 기대값 통과 | 로컬 가짜 gh | worker | 없음 | PR 전 |
| REQ1 | PR 생성 | GitHub Actions의 Tests 결과 확인 | 저장소 전체 테스트 통과 | GitHub Actions | 코디네이터 | push | PR 뒤 |
