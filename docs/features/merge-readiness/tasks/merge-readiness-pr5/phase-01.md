# Phase 01. 관문과 머지 큐에 draft 와 머지 보류 적용

**Execution profile**: standard

## 목표

관문은 draft 를 거절하고 확인한 보류와 보류 조회 실패를 모두 알린다. 머지 큐는 draft 나 보류가 있으면 base 갱신과 체크 대기 전에 멈춘다.

**범위 외** 체크 없음은 PR6, 리뷰 설정·HEAD 변경·머지 직전 체크 재확인은 PR7 에서 다룬다.

## 컨텍스트

**요구사항**: REQ2, REQ3

**근거 문서**: `docs/features/merge-readiness/spec.md`, `docs/features/merge-readiness/technical-design.md`

## 작업 항목

### 1. 공통 판단과 보류 조회

`ReadinessCompat` 의 `noDraft` 와 `oldHolds` 를 걷어낸다. 지시서와 보드는 없으면 보류 없음, 읽지 못하면 조회 실패로 구분한다. `specTargets` 는 브랜치별 지시서와 조회 실패 경로를 함께 돌려준다. 루프는 보류를 확인할 수 없는 틱에 자동 머지를 걸지 않는다. 관문과 머지 큐의 스레드 명령 출력도 정수인지 검사한다.

### 2. 명령 출력과 문서

관문은 조건 표를 한 번 물어 준비 조건 결과와 `HOLD` 줄을 낸다. 머지 큐는 차례 시작과 머지 직전에 draft 와 보류를 묻고, 중간 판단에도 보류를 포함한다. 보류마다 `GATE-HOLD` 줄을 찍고 `STOP` 이유는 한 줄에 모은다. 명령 맨 위 설명과 보류 안내를 갱신한다.

### 3. 공통 판단과 호출부 테스트

변경 파일 표의 `skills/orch/tests/core-merge-readiness.spec.ts`, `skills/orch/tests/lib-merge-readiness.spec.ts`, `skills/orch/tests/queue-gate.spec.ts`, `skills/orch/tests/merge-queue.spec.ts`, `skills/orch/tests/orch-loop-auto-merge.spec.ts` 에 사례를 넣는다. snapshot 으로 draft, 보류 순서와 보류 조회 실패의 단계를 확인한다. 어댑터는 지시서와 보드의 없음·읽기 실패를 구분하는지 확인한다. 가짜 gh 로 관문과 머지 큐의 출력, 종료 코드, draft 에서 체크 대기를 시작하지 않는지를 확인한다. 고정 입력 기록은 중간 판단에 보류가 들어가 PR 본문 조회가 한 번 더 생기는 부분만 갱신한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/core-merge-readiness.spec.ts skills/orch/tests/lib-merge-readiness.spec.ts skills/orch/tests/queue-gate.spec.ts skills/orch/tests/merge-queue.spec.ts skills/orch/tests/orch-loop-auto-merge.spec.ts skills/orch/tests/golden.spec.ts
node scripts/run-tests.ts skills/orch/tests
git diff --check
```

위 명령은 모두 종료 코드 0 을 기대한다. 저장소 전체 테스트와 타입 검사는 PR CI 에서 실행한다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ2 | 지시서·본문·보드 보류가 있는 열린 PR | `queue-gate.spec.ts` 의 사례로 관문과 큐 실행 | 관문은 보류마다 HOLD 를 내고 통과한다. 큐는 보류마다 GATE-HOLD 를 내고 머지 전에 멈춘다 | 가짜 gh 와 격리된 파일 | worker | 없음 | PR 전 |
| REQ2 | 본문, 보드, 지시서 조회가 실패하는 열린 PR | `queue-gate.spec.ts` 의 실패 사례로 관문과 큐 실행 | 관문은 실패한 조회를 HOLD 로 알린다. 큐는 머지하지 않는다 | 가짜 gh 와 격리된 파일 | worker | 없음 | PR 전 |
| REQ3 | 체크가 성공한 draft PR | `queue-gate.spec.ts` 의 draft 사례로 관문과 큐 실행 | 관문은 GATE-FAIL 을 내고 큐는 체크 대기 전에 멈춘다 | 가짜 gh 와 격리된 파일 | worker | 없음 | PR 전 |

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/core/merge-readiness.ts` | 수정 |
| `skills/orch/scripts/lib/last-pr.ts` | 수정 |
| `skills/orch/scripts/lib/merge-readiness.ts` | 수정 |
| `skills/orch/scripts/lib/spec-targets.ts` | 수정 |
| `skills/orch/scripts/loop/steps/auto-merge.ts` | 수정 |
| `skills/orch/scripts/queue/gate.ts` | 수정 |
| `skills/orch/scripts/queue/merge_queue.ts` | 수정 |
| `skills/orch/scripts/queue/steps/gate.ts` | 수정 |
| `skills/orch/scripts/queue/steps/merge.ts` | 수정 |
| `skills/orch/scripts/queue/steps/model.ts` | 수정 |
| `skills/orch/scripts/queue/steps/spec-hold.ts` | 수정 |
| `skills/orch/tests/core-merge-readiness.spec.ts` | 수정 |
| `skills/orch/tests/lib-merge-readiness.spec.ts` | 수정 |
| `skills/orch/tests/queue-gate.spec.ts` | 수정 |
| `skills/orch/tests/fixtures/merge-queue-fakes.ts` | 수정 |
| `skills/orch/tests/merge-queue.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-auto-merge.spec.ts` | 수정 |
| `docs/flow.md` | 수정 |
| `skills/orch/references/cleanup.md` | 수정 |
| `skills/orch/references/spec-writing.md` | 수정 |
| `skills/orch/references/replying.md` | 수정 |
| `skills/orch/tests/golden/queue/ci-failure/result.json` | 수정 |
| `skills/orch/tests/golden/queue/conflict/result.json` | 수정 |
| `skills/orch/tests/golden/queue/merge/result.json` | 수정 |
