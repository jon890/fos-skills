# Phase 02. 함수 전환과 인수 검증

**Execution profile**: standard

## 목표
fixture의 비동기 Orca와 spec 판정을 함수로 호출한다. 함수 예외와 import 보호 회귀를 추가하고 실제 CLI 대응을 유지한다.

**범위 외**: 사용자 동작·출력 계약·실행기 동시 수 변경.

## 컨텍스트
스펙 DECISION4·DECISION16, 기술 설계 PR9를 따른다. 기존 fixture 상태와 단언은 유지한다.
**요구사항**: REQ1, REQ3, REQ4
**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md`

## 의도 메모
lib/proc의 공통 실행은 유지한다. hook·shell 가짜·신호는 실제 프로세스로 검증한다. 독립 검토는 PR 뒤 코디네이터가 제공하며 대기다.

## 작업 항목

### 1. 실행 경계와 회귀 검증
fixture의 비동기 Orca와 spec 판정을 함수로 호출한다. 함수 예외와 import 보호 회귀를 추가하고 실제 CLI 대응을 유지한다.

### 2. `skills/orch/tests/wait-important.spec.ts`와 `skills/orch/tests/launch-worker-functions.spec.ts`의 회귀 검증

launch-worker.spec.ts, spec-line.spec.ts, spec-lint.spec.ts의 기존 단언을 수정하지 않고 실행한다.

## 검증
```bash
node scripts/run-tests.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/spec-line.spec.ts skills/orch/tests/spec-lint.spec.ts skills/orch/tests/wait-important.spec.ts skills/orch/tests/launch-worker-functions.spec.ts skills/orch/tests/lib-proc*.spec.ts
```
종료 코드 0과 기존 단언 통과를 확인한다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/tests/fixtures/launch-worker-run.ts` | 수정 |
| `skills/orch/tests/launch-worker-functions.spec.ts` | 수정 |
| `skills/orch/changes/top-files-functions.patch.md` | 수정 |
| `skills/orch/tests/wait-important.spec.ts` | 수정 |
| `skills/orch/tests/fixtures/wait-important-run.ts` | 신규 |

## 인수 검증 계획

준비: 동일 머신, 기준 019f9b6과 구현 HEAD, 독점 heavy slot, 기존 가짜 상태를 쓴다.
절차: 대상 회귀와 proc 회귀를 실행한다. `node scripts/run-tests.ts`를 옵션 없이 실행한다. `node modules/testkit/measure.ts --before 019f9b6 --after HEAD --runs 3 skills/orch/tests/launch-worker.spec.ts skills/orch/tests/wait-important.spec.ts`로 번갈아 측정한다.
기대 결과: 기존 판정·CLI 대응 통과, 파일별 전후 기동 수와 시간, 기동 감소 비율을 기록한다. 시간·시작과 끝 load·전체 파일 시간 합을 PR에 보존한다.
환경과 시점: 주입 뒤 기존 테스트, 함수 전환 뒤 회귀, 최종 커밋 뒤 전체 실행과 측정, push 뒤 CI. 저부하 2분 확인은 코디네이터의 통합 단계에 인계한다.

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 기존 fixture, 기준 커밋 | 대상 회귀·전체 실행·전후 측정 | 같은 판정, 기동 감소, 결과 기록 | 동일 머신 heavy slot | 없음 | PR 전 |
| REQ3 | 기존 fixture, 기준 커밋 | 대상 회귀·전체 실행·전후 측정 | 같은 판정, 기동 감소, 결과 기록 | 동일 머신 heavy slot | 없음 | PR 전 |
| REQ4 | 최종 HEAD, 저부하 독점 자리 | 옵션 없는 전체 실행 | 실제 전체 시간 120초 이하 | 코디네이터 test-speed 13단계 | push | PR 뒤 |


후속 검증 담당은 코디네이터다. 이 PR은 REQ4의 비용 감소 근거만 제공하며 위 저부하 전체 확인 전에는 기능 전체 완료로 판단하지 않는다.
