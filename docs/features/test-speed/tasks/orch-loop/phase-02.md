# Phase 02. 테스트 준비와 가짜 명령을 재사용한다

## 목표

기존 단언을 유지한 채 가짜 명령의 기동과 초기 git 준비를 줄인다.

**Execution profile**: standard

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ6

**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md` 의 PR5 절.

## 의도 메모

루프의 전역 환경과 신호 상태는 프로세스로 격리하고, 같은 프로세스에서 평가하는 가짜 명령만 줄인다. 운영 출력 계약과 git 판정은 바꾸지 않는다. 독립 검토는 지시서에 따라 PR 생성 뒤 코디네이터에게 맡기며 대기로 기록한다.

**범위 외**: 다른 테스트 묶음과 운영 출력 계약 변경.

## 작업 항목

### 1. 실행과 테스트 경계

fixture 는 gh/orca/ps 의 실행 파일 본문을 함수로 호출한다. 예외를 실패 결과로 바꾸고 지연·신호·실제 명령은 기존 실행으로 보낸다. 같은 입력에 대한 실행 파일과 함수의 결과·기록을 비교한다. 동기 호출 도우미만 fixture 로 옮기고 직접 spawn 하는 신호 사례는 실제 CLI 를 유지한다. 저장소는 testkit 템플릿을 복사하고 파일별 초기 파일을 넣은 템플릿을 재사용한다. 변경 조각을 더한다.

## 검증

```bash
node scripts/run-tests.ts 'skills/orch/tests/orch-loop*.spec.ts' skills/orch/tests/lib-proc.spec.ts
claude plugin test .
node scripts/run-tests.ts
```

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 가짜 명령과 임시 저장소 | 기존 루프 계열·proc·가짜 대응 테스트 실행 | 기존 단언과 함수 대응 통과 | 로컬 | 없음 | PR 전 |
| REQ2 | 기존 테스트 | 주입 경계만 더한 커밋에서 기존 테스트 실행 | 기존 판정 통과 | 로컬 | 없음 | PR 전 |
| REQ3 | 기준·구현 커밋 | measure.ts 로 대상 파일 전후 교대 실행 | 시간·부하·기동 수·비율 기록, 기동 수 감소 | 같은 머신 | 없음 | PR 전 |
| REQ6 | 변경 diff | linkBin 과 templateRepo/copyRepo 사용 대조 | 본문·저장소 재사용, 상태 독립 | 로컬 | 없음 | PR 전 |
| REQ1 | push 한 PR | Tests 와 독립 리뷰 확인 | CI 통과, 지적 반영 또는 합의 | GitHub | push | PR 뒤 |

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/tests/fixtures/orch-loop-run.ts` | 신규 |
| `skills/orch/tests/orch-loop-run.spec.ts` | 신규 |
| `skills/orch/tests/orch-loop.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-ci.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-stall.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-auto-merge.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-conflict.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-refresh.spec.ts` | 수정 |
| `skills/orch/changes/testkit-orch-loop.patch.md` | 신규 |
| `skills/orch/tests/fixtures/orch-loop-repo.ts` | 신규 |
