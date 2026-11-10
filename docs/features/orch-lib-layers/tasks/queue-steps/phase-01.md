# Phase 01. 머지 큐 단계를 나눈다

**Execution profile**: standard

## 목표

머지 큐의 진입 파일에는 단계 호출과 결과 수집을 남기고 단계별 구현을 분리한다.

**범위 외**: loop/steps, cleanup/steps, 출력·종료 코드·기록 변경, 실제 브랜치 삭제, 새 의존성.

## 컨텍스트

**요구사항**: REQ12, REQ13

**근거 문서**: `docs/features/orch-lib-layers/spec.md`, `docs/features/orch-lib-layers/design.md` 의 단계 파일과 동작 같음 확인.

기존 Queue 의 setup, processPr, bringUpToDate, waitChecks, runAfterMerged 와 attempt 를 직접 옮긴다.
`lib/gh.ts`, `lib/proc.ts`, `lib/events.ts` 와 core 판정의 재수출을 유지한다. 이 모듈의 실행·로그·캐시·파일 쓰기는 이번 이동의 범위 안이며 바꾸지 않는다.

## 의도 메모

- 상속이나 prototype 조립 대신 명시적인 함수 호출을 쓴다. 단계 함수는 StepContext 와 StepState 를 받고 기존 반환값 또는 오류 이유를 돌려준다.
- StepContext 는 진입 파일 위치와 대기 배율을 소유한다. StepState 는 Queue 의 기존 실행 상태를 담는다. 오류 뒤에도 정리와 신호 처리가 같은 상태를 보도록 상태 갱신 순서를 유지한다.
- attempt 는 기존 오류 분류와 changes 를 반환한다. 진입 루프와 앞지르기 루프는 각 호출의 changes 를 Object.assign 으로 한 번만 합친다. 충돌 목록은 이 결과로 넘긴다.
- copy, 현재 PR, 체크 재시도 상태는 동일한 StepState 참조에 즉시 반영하여 오류·신호 정리가 읽는다. 하위 도우미는 기존 scalar/void 반환과 실행 횟수를 유지한다.
- 공개 조합 단계 setup, selectQueue, afterQueue, sweep 은 공통 StepResult<T> 로 종료 종류, 최종 상태 조각과 예상 오류를 반환한다. 진입 파일은 각 결과의 changes 를 한 번 합친다. setup 의 Usage/ConfigError 와 afterQueue 의 ConfigError 는 결과로 넘기고, 예상하지 못한 오류만 던진다. 하위 도우미의 기존 오류 전파는 attempt 가 같은 오류 타입으로 분류한다.
- 제어 예외 생성자는 model.ts 의 같은 정의를 쓰고 instanceof 분류를 유지한다. 이미 생긴 외부 효과를 취소하거나 재실행하지 않는다.
- SCRIPT/HERE 는 기존 진입 파일 위치를 유지한다. 도움말은 기존 파일 맨 위 설명을 계속 읽는다.
- 기존 테스트의 기대값과 golden 파일을 고치지 않는다. 이 PR 은 스펙이 지정한 단일 큐 분리이므로 이동량이 커도 다른 분리 작업을 섞지 않는다.

## 작업 항목

### 1. 단계 함수와 실행 상태

`skills/orch/scripts/queue/steps/` 아래 model.ts(타입·오류·실행 상태), runtime.ts(출력·대기·공통 실행), options.ts(옵션), setup.ts(시작 전 검사·임시 사본), pr.ts(PR 조회·이벤트 입력·차례 기록), overlap.ts(변경 파일 겹침), checks.ts(CI 대기), update.ts(base 최신화), verify.ts(합친 사본 검사), merge.ts(머지 전 조건·머지·원격 브랜치), finish.ts(머지 뒤 이벤트·정리 전달), select.ts(차례·보류·앞지르기·재판정 루프)로 기존 코드를 옮긴다.
`queue/merge_queue.ts` 의 main 주입 계약과 직접 실행 가드를 유지하고 준비·selectQueue 결과(config/held/done)·머지 뒤 이벤트·정리를 연결한다. 진입 파일에는 차례 선택과 재판정 루프를 남기지 않는다. 관련 경로를 쓰는 소비자를 찾아 조정한다.

### 2. skills/orch/tests/merge-queue-runner.spec.ts 의 회귀 확인과 기록

`skills/orch/tests/merge-queue-runner.spec.ts` 를 수정한다. 기존 merge-queue, overlap, runner 테스트가 정상 머지·체크 실패·충돌·HEAD 변경·신호·앞지르기를 그대로 검증한다.
runner 테스트에는 단계 모듈 import 의 부수효과가 없고 충돌 결과를 합친 뒤 같은 상태를 유지하는 사례를 더한다. 오류·신호 뒤 정리는 기존 실제 CLI 테스트로 확인한다. 구조 검사는 경계와 순환 의존이 없는지 확인한다.
변경 조각 `skills/orch/changes/queue-steps.patch.md` 에 동작을 유지하는 내부 분리를 적는다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/merge-queue.spec.ts skills/orch/tests/merge-queue-overlap.spec.ts skills/orch/tests/merge-queue-runner.spec.ts skills/orch/tests/core-boundary.spec.ts skills/orch/tests/core-dedup.spec.ts skills/orch/tests/core-values.spec.ts skills/orch/tests/script-folders.spec.ts skills/orch/tests/golden.spec.ts
node scripts/run-tests.ts --tsc-only
git diff --exit-code origin/main HEAD -- skills/orch/tests/golden
```

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ12 | 분리 구현 완료 | 진입 파일·export·호출 관계를 읽는다 | 본 파일은 순서와 결과 수집만 소유하고 순환 의존이 없다 | 로컬 | 코디네이터 | 없음 | PR 전 |
| REQ13 | jq·bash 및 임시 저장소 | 위 큐·golden 테스트 명령 실행 | 정상·실패·호환·경쟁의 출력·종료 코드·상태가 같다 | 로컬 | worker | 없음 | PR 전 |
| REQ13 | main 의 고정 입력 기록 | 위 golden 경로 diff 실행 | 차이 없이 종료 코드 0 | 로컬 | worker | 없음 | PR 전 |
| REQ13 | PR 생성 | CI 저장소 검증 확인 | 현재 HEAD 의 필수 검사 성공 | CI | worker | push | PR 뒤 |

선행 조건은 main 에 들어온 고정 입력 기록과 jq·bash 이다. 실제 저장소의 머지·삭제는 실행하지 않는다. 독립 코드 리뷰는 PR 생성 뒤 코디네이터에게 요청한다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/queue/merge_queue.ts` | 수정 |
| `skills/orch/scripts/queue/steps/model.ts` | 신규 |
| `skills/orch/scripts/queue/steps/runtime.ts` | 신규 |
| `skills/orch/scripts/queue/steps/options.ts` | 신규 |
| `skills/orch/scripts/queue/steps/setup.ts` | 신규 |
| `skills/orch/scripts/queue/steps/pr.ts` | 신규 |
| `skills/orch/scripts/queue/steps/overlap.ts` | 신규 |
| `skills/orch/scripts/queue/steps/checks.ts` | 신규 |
| `skills/orch/scripts/queue/steps/update.ts` | 신규 |
| `skills/orch/scripts/queue/steps/verify.ts` | 신규 |
| `skills/orch/scripts/queue/steps/merge.ts` | 신규 |
| `skills/orch/scripts/queue/steps/finish.ts` | 신규 |
| `skills/orch/scripts/queue/steps/select.ts` | 신규 |
| `skills/orch/tests/merge-queue-runner.spec.ts` | 수정 |
| `skills/orch/changes/queue-steps.patch.md` | 신규 |
