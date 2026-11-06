# Phase 01. 루프 실행 경계를 주입한다

## 목표

기존 실행을 기본값으로 두고 main 과 틱 자식 진입점을 주입한다.

**Execution profile**: standard

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ6

**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md` 의 PR5 절.

## 의도 메모

루프의 전역 환경과 신호 상태는 프로세스로 격리하고, 같은 프로세스에서 평가하는 가짜 명령만 줄인다. 운영 출력 계약과 git 판정은 바꾸지 않는다. 독립 검토는 지시서에 따라 PR 생성 뒤 코디네이터에게 맡기며 대기로 기록한다.

**범위 외**: 다른 테스트 묶음과 운영 출력 계약 변경.

## 작업 항목

### 1. 실행과 테스트 경계

`main` 을 내보내고 `withRun` 으로 주입 범위를 묶는다. start 와 foreground 의 자기 호출 경로를 인자로 전달한다. 직접 실행 판정으로 import 부작용을 막는다. 기존 테스트를 고치지 않고 실행한다.

### 2. import 경계 테스트

`skills/orch/tests/orch-loop-import.spec.ts` 에서 import 시 출력과 신호 처리기가 생기지 않고 main 을 내보내는지 확인한다.

## 검증

```bash
node scripts/run-tests.ts 'skills/orch/tests/orch-loop*.spec.ts' skills/orch/tests/lib-proc.spec.ts
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/loop/orch-loop.ts` | 수정 |
| `docs/features/test-speed/design.md` | 수정 |
| `skills/orch/tests/orch-loop-import.spec.ts` | 신규 |
