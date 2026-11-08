# Phase 01. 실제 대기와 finish-pr 반복 비용을 줄인다

**Execution profile**: standard

## 목표

판정 단언과 실제 삭제·신호 경계를 유지하며 반복 실행 비용을 줄인다.

**범위 외**: launch-worker·cleanup-sweep·browser-driver와 동시 수 기본값.

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ4

**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md` PR10.

## 의도 메모

프로세스 격리는 유지하고 동기 가짜 조회만 함수 평가한다. 삭제를 가짜로 바꾸지 않는다.

## 작업 항목

### 1. 실행 경계와 준비 이력

finish-pr main·reportError를 내보내고 withRun·직접 실행 보호를 추가한다. 기존 테스트를 먼저 돌린다. 이후 stateful-run fixture와 copyRepo 템플릿을 적용하고 종료 코드별 CLI 대응을 남긴다.

### 2. `skills/orch/tests/finish-pr.spec.ts`와 실제 대기 테스트

orch-loop 시작 한도 기본 10초는 유지하고 해당 테스트만 짧게 주입한다. 생존·재확인 시간 비율을 유지하며 doctor 지연은 질문에만 준다. run-tests background는 파일 신호로 해제한다.

## 인수 검증 계획

환경은 같은 macOS/Node 머신과 임시 git 저장소다. 외부 서비스에는 닿지 않는다. PR 전에 기존 판정·출력·파일 단언, 성공·실패·사용법 CLI 대응을 실행한다. 측정은 독점 heavy 자리에서 기준/구현을 번갈아 실행하고 기동 수·load·전체 동시 8 끝 줄과 파일 시간 합을 PR에 남긴다. 독립 리뷰는 PR 뒤 코디네이터에게 요청한다.

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 임시 저장소와 가짜 조회 | 대상 테스트와 CLI 대응 실행 | 기존 단언과 종료 코드 일치 | macOS Node | 없음 | PR 전 |
| REQ3 | 기준·구현 커밋 | 독점 자리에서 교차 측정과 전체 실행 | 실패 0, 기동 수 감소, 3분 안팎 목표와 비교 | 같은 머신 | 없음 | PR 전 |

| REQ2 | 임시 저장소 | CLI 대응 실행 | 종료 코드·출력 일치 | macOS Node | 없음 | PR 전 |
| REQ4 | 같은 머신 | 옵션 없는 전체 실행 | 3분 안팎 목표와 비교 | macOS Node | 없음 | PR 전 |

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/finish-pr.spec.ts skills/orch/tests/orch-loop.spec.ts skills/orch/tests/orch-loop-conflict.spec.ts skills/orch/tests/orch-doctor.spec.ts skills/orch/tests/wait-important.spec.ts scripts/tests/run-tests.spec.ts
node skills/orch/bin/orch.ts slot heavy --exclusive -- node scripts/run-tests.ts
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/queue/finish-pr.ts` | 수정 |
| `skills/orch/scripts/loop/orch-loop.ts` | 수정 |
| `skills/orch/scripts/lib/env.ts` | 수정 |
| `skills/orch/tests/fixtures/finish-pr-run.ts` | 신규 |
| `skills/orch/tests/finish-pr.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-conflict.spec.ts` | 수정 |
| `skills/orch/tests/orch-doctor.spec.ts` | 수정 |
| `skills/orch/tests/wait-important.spec.ts` | 수정 |
| `scripts/tests/run-tests.spec.ts` | 수정 |
| `docs/features/test-speed/spec.md` | 수정 |
| `docs/features/test-speed/design.md` | 수정 |
| `skills/orch/changes/clock-finish.patch.md` | 신규 |
