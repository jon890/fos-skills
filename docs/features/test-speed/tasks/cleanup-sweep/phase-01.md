# Phase 01. 운영 진입점에 명령 주입 경계를 더한다

**Execution profile**: standard

## 목표

운영 진입점에 명령 주입 경계를 더한다.

**범위 외**: 정리 판정·출력 계약 변경, 실제 서비스 접근.

## 컨텍스트

**요구사항**: REQ2

**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md` 의 PR6 절.

## 의도 메모

기존 PR5 의 함수 주입과 프로세스 격리를 따른다. 독립 검토는 코디네이터에게 PR 생성 뒤 요청하며 자기 점검으로 통과 처리하지 않는다.

## 작업 항목

### 1. 구현과 회귀 검증

`cleanup-sweep.ts` 와 `notify-conflicts.ts` 의 main 에 선택 runner 를 받고 기존 본문은 withRun 안에서 호출한다. notify-conflicts 는 main 을 내보내고 CLI 직접 실행 조건을 둔다. 기존 테스트를 고치지 않고 전부 통과시킨다.

### 2. 기존 테스트 실행

`skills/orch/tests/cleanup-sweep-merge.spec.ts` 와 `skills/orch/tests/notify-conflicts.spec.ts` 의 기존 테스트를 수정하지 않고 실행해 출력·종료 코드 회귀를 검증한다.

### 3. 실제 CLI 대표 테스트

`skills/orch/tests/cleanup-sweep-run.spec.ts` 에 실제 CLI 의 help·인자 오류·dry-run·조회 실패 테스트를 더한다. 기존 테스트는 그대로 둔다.

## 검증

```bash
node scripts/run-tests.ts 'skills/orch/tests/cleanup-sweep*.spec.ts' skills/orch/tests/notify-conflicts.spec.ts skills/orch/tests/lib-proc.spec.ts
```

종료 코드 0 이고 기존 판정 단언이 통과해야 한다. 마지막 phase 에서는 저장소 전체 실행기와 plugin test 를 추가로 실행한다. 전후 측정은 기준 커밋과 구현 커밋을 measure.ts 에 전달해 같은 머신에서 번갈아 잰다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/cleanup/cleanup-sweep.ts` | 수정 |
| `skills/orch/scripts/queue/notify-conflicts.ts` | 수정 |
| `skills/orch/tests/cleanup-sweep-run.spec.ts` | 신규 |
| `docs/features/test-speed/design.md` | 수정 |
