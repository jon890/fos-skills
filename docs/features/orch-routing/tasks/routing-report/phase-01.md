# Phase 01. 기록 읽기의 오류 위치

## 목표

손상된 줄 뒤의 정상 기록을 보고서에서 읽는다.

**Execution profile**: standard

**범위 외**: 선택 정책 변경과 실제 기록 후속 검증.

## 컨텍스트

**요구사항**: REQ7

**근거 문서**: `docs/features/orch-routing/spec.md`, `docs/features/orch-routing/design.md`

## 의도 메모

기록은 관측용이다. 보고서는 손상된 줄을 경고하고 건너뛰지만 쓰기는 기존 데이터를 버리지 않도록 경로와 줄 번호를 포함해 실패한다.

## 작업 항목

### 1. 구현과 개발 테스트

`routingRecords` 에 오류 처리 콜백을 더한다. 기본은 예외로 두고 파일 경로와 실제 줄 번호를 붙인다. `skills/orch/tests/lib-routing-log.spec.ts` 에 손상 줄, 빈 줄, 정상 후속 줄과 쓰기 실패 시 원본 보존을 검증한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/lib-routing-log.spec.ts
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/lib/routing-log.ts` | 수정 |
| `skills/orch/tests/lib-routing-log.spec.ts` | 수정 |
