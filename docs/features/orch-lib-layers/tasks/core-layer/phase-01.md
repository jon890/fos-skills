# Phase 01. 기존 동작 기록

**Execution profile**: standard

## 목표

기존 동작 기록로 기존 동작을 유지한다.

**범위 외**: loop-steps, queue-steps, cleanup-steps 구현.

## 컨텍스트

**요구사항**: REQ13

**근거 문서**: `docs/features/orch-lib-layers/spec.md`, `docs/features/orch-lib-layers/design.md`

## 의도 메모

새 의존 없이 폴더와 소스 검사로 경계를 지킨다.

## 작업 항목

### 1. 입력과 기록 만들기

기존 main 제품 코드를 바꾸지 않고 fixed-clock.ts 와 golden-run.ts 를 만든다. tests/golden 에 루프 틱(CI 실패·충돌, 미답변·멈춤, 조회 실패), 큐(머지, CI 실패, 충돌), 정리(머지, 살아 있는 worker, 옛 상태)의 입력과 출력·stderr·종료 코드·상태를 남긴다. 기존 merge-queue-run.ts, cleanup-sweep-run.ts 와 fake-bin.ts 를 재사용한다. 첫 커밋은 이 기록과 실행기만 담는다. 두 번 실행해 기록이 같아야 한다. `tests/golden/<스크립트>/<사례>/input.json` 은 인자·가짜 응답 표·초기 상태를, result.json 은 출력·stderr·종료 코드·종료 뒤 상태를 담는다. Date 는 node --import fixed-clock.ts 로 고정한다. 캐시 generation UUID 도 preload 에서 고정하여 결과에서는 임시 경로와 PID 만 정규화한다. 기존 merge-queue-fakes.ts 를 큐에, fake-bin.ts 응답 표를 루프와 정리에 재사용한다. 제품 진입점을 자식 프로세스로 실행해 실제 출력과 상태 경계를 본다.

## 검증

```bash
node skills/orch/tests/fixtures/golden-run.ts --record
node skills/orch/tests/fixtures/golden-run.ts
node --test skills/orch/tests/golden.spec.ts
```

종료 코드 0, 고정 입력 기록 차이 없음이 기대값이다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/tests/golden.spec.ts` | 신규 |
| `skills/orch/tests/fixtures/fixed-clock.ts` | 신규 |
| `skills/orch/tests/fixtures/golden-run.ts` | 신규 |
| `skills/orch/tests/golden/` | 신규 |
