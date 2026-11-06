# Phase 03. 느린 테스트를 전환하고 측정한다

**Execution profile**: standard

## 목표

느린 테스트를 전환하고 측정한다. 운영 판정과 호출별 프로세스 격리를 유지한다.

**범위 외**: 운영 출력 계약과 merge 판정 변경.

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ6

**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md` 의 PR7 절.

## 의도 메모

실제 git 과 비동기·신호 경계는 남긴다. 중복 평가기부터 분리하고 주입 커밋은 기존 테스트 그대로 검증한다.
독립 검토는 지시서대로 코디네이터에게 넘기며 대기로 기록한다.

## 작업 항목

### 1. `skills/orch/tests/launch-worker.spec.ts`: 설계 PR7 의 경계를 구현하고 기존 단언을 유지한다.
- `skills/orch/tests/orch-doctor.spec.ts`: 설계 PR7 의 경계를 구현하고 기존 단언을 유지한다.
- `skills/orch/tests/fixtures/launch-worker-run.ts`: 설계 PR7 의 경계를 구현하고 기존 단언을 유지한다.
- `skills/orch/tests/fixtures/orch-doctor-run.ts`: 설계 PR7 의 경계를 구현하고 기존 단언을 유지한다.
- `skills/orch/tests/worker-doctor-run.spec.ts`: 설계 PR7 의 경계를 구현하고 기존 단언을 유지한다.
- `skills/orch/changes/testkit-launch-worker.patch.md`: 설계 PR7 의 경계를 구현하고 기존 단언을 유지한다.

### 2. 기존 테스트 실행

같은 phase 에서 기존 launch-worker.spec.ts, orch-doctor.spec.ts 와 가짜 대응 테스트를 실행한다. 주입 커밋에서는 단언과 테스트 파일을 수정하지 않는다.

### 3. `skills/orch/tests/orch-loop-run.spec.ts` 로 깨진 상태의 실제 실행 경계를 검증한다

공통 평가기를 분리할 때 지연 판정용 상태 파일의 파싱 예외도 실제 명령 실패로 돌려준다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/orch-doctor.spec.ts skills/orch/tests/orch-loop-run.spec.ts skills/orch/tests/cleanup-sweep-run.spec.ts skills/orch/tests/lib-proc.spec.ts
```

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ2 | 임시 저장소 | 대상 파일과 기존 가짜 대응 테스트를 실행기로 돌리고 기본 전체 실행을 잇는다 | 기존 출력·종료·상태 단언과 타입·Python 검사 통과 | 로컬 Node | 없음 | PR 전 |
| REQ1 | 같은 입력 | 실제 CLI 와 fixture 의 성공·오류를 같은 입력으로 비교한다 | stdout·stderr·종료 코드 일치 | 로컬 Node | 없음 | PR 전 |
| REQ3 | 기준·구현 커밋 | measure.ts 에 기준·구현 커밋과 대상 파일을 주고 전후 번갈아 실행한다 | 시간·preload 기동 수·부하·실패 수 표 보존 | 같은 머신 | 없음 | PR 전 |
| REQ6 | 가짜 본문 | linkBin 을 쓰고 기존 testkit inode 검사를 실행한다 | 같은 본문은 같은 원본 inode 재사용 | 로컬 Node | 없음 | PR 전 |

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/tests/launch-worker.spec.ts` | 수정 |
| `skills/orch/tests/orch-doctor.spec.ts` | 수정 |
| `skills/orch/tests/fixtures/launch-worker-run.ts` | 신규 |
| `skills/orch/tests/fixtures/orch-doctor-run.ts` | 신규 |
| `skills/orch/tests/worker-doctor-run.spec.ts` | 신규 |
| `skills/orch/changes/testkit-launch-worker.patch.md` | 신규 |
| `skills/orch/tests/fixtures/orch-loop-run.ts` | 수정 |
| `skills/orch/tests/orch-loop-run.spec.ts` | 수정 |
