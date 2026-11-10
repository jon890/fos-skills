# 두 층 분리 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ10 | 분리된 core 와 임시 금지 import | `node scripts/run-tests.ts skills/orch/tests/core-boundary.spec.ts` | 정상 코드는 통과하고 금지 import·표현은 파일과 줄을 내며 거부 | 격리된 로컬 프로세스 | worker | 없음 | PR 전 |
| REQ11 | 합친 공통 함수와 기존 호출자 | `node scripts/run-tests.ts skills/orch/tests/core-dedup.spec.ts` 와 변경한 호출자의 기존 테스트 | 정의가 한 곳이며 기존 기대값 유지 | 임시 저장소·가짜 명령 | worker | 없음 | PR 전 |
| REQ13 | 첫 기록 커밋과 고정 입력 사례 | `node skills/orch/tests/fixtures/golden-run.ts` 와 phase 02 의 GOLDEN_COMMIT 조회 후 `git diff --exit-code "$GOLDEN_COMMIT" HEAD -- skills/orch/tests/golden` | 출력·stderr·종료 코드·상태와 기록 파일 차이 없음 | 고정 시각·임시 저장소·가짜 명령 | worker | 없음 | PR 전 |
