# Phase 02. 함수 가짜와 템플릿으로 옮기고 측정한다

**Execution profile**: standard

## 목표

함수 가짜와 템플릿으로 옮기고 측정한다.

**범위 외**: 정리 판정·출력 계약 변경, 실제 서비스 접근.

## 컨텍스트

**요구사항**: REQ1, REQ3, REQ6

**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md` 의 PR6 절.

## 의도 메모

기존 PR5 의 함수 주입과 프로세스 격리를 따른다. 독립 검토는 코디네이터에게 PR 생성 뒤 요청하며 자기 점검으로 통과 처리하지 않는다.

## 작업 항목

### 1. 구현과 회귀 검증

fixture 의 동기 CommonJS 가짜를 같은 본문의 함수로 실행한다. `skills/orch/tests/cleanup-sweep-run.spec.ts` 에 같은 본문의 성공·실패·pid·출력·종료·기록 대응 검증을 더한다. 실제 git·hook·remove-worktree 경계를 유지하고 호출별 프로세스 격리를 남긴다. notify-conflicts 초기 저장소를 파일을 넣은 템플릿으로 복사하고 실행 파일은 linkBin 으로 재사용한다. 대응 테스트와 CLI 대표 테스트로 성공·실패·예외·출력·상태를 대조한다. 전체 검사와 measure.ts 의 전후 시간·기동 수를 남긴다.

### 2. 기존 테스트 실행

`skills/orch/tests/cleanup-sweep-merge.spec.ts` 와 `skills/orch/tests/notify-conflicts.spec.ts` 의 기존 테스트를 수정하지 않고 실행해 출력·종료 코드 회귀를 검증한다.

## 검증

```bash
node scripts/run-tests.ts 'skills/orch/tests/cleanup-sweep*.spec.ts' skills/orch/tests/notify-conflicts.spec.ts skills/orch/tests/lib-proc.spec.ts
```

종료 코드 0 이고 기존 판정 단언이 통과해야 한다. 마지막 phase 에서는 저장소 전체 실행기와 plugin test 를 추가로 실행한다. 전후 측정은 기준 커밋과 구현 커밋을 measure.ts 에 전달해 같은 머신에서 번갈아 잰다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/tests/fixtures/cleanup-sweep.ts` | 수정 |
| `skills/orch/tests/fixtures/cleanup-sweep-run.ts` | 신규 |
| `skills/orch/tests/fixtures/notify-conflicts-run.ts` | 신규 |
| `skills/orch/tests/notify-conflicts.spec.ts` | 수정 |
| `skills/orch/tests/cleanup-sweep-docker.spec.ts` | 수정 |
| `skills/orch/tests/cleanup-sweep-run.spec.ts` | 수정 |
| `skills/orch/changes/testkit-cleanup-sweep.patch.md` | 신규 |
