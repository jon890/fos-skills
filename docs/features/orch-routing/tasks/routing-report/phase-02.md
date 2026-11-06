# Phase 02. 집계 명령과 사용 안내

## 목표

PR 을 연 effective 모델별 품질과 첫 모델별 재시도 비율을 출력한다.

**Execution profile**: standard

**범위 외**: 선택 정책 변경과 실제 기록 후속 검증.

## 컨텍스트

**요구사항**: REQ7

**근거 문서**: `docs/features/orch-routing/spec.md`, `docs/features/orch-routing/design.md`

## 의도 메모

기록은 관측용이다. 보고서는 손상된 줄을 경고하고 건너뛰지만 쓰기는 기존 데이터를 버리지 않도록 경로와 줄 번호를 포함해 실패한다.

## 작업 항목

### 1. 구현과 개발 테스트

`routing/routing-report.ts` 와 `lib/routing-report.ts` 를 만들고 명령 표에 등록한다. 저장소 반복 인자와 날짜 필터, JSON·Markdown·짧은 출력을 제공한다. 가격은 agent-selection 표에서 읽고 캐시 배수는 출처 주석과 함께 둔다. 누락은 0으로 만들지 않는다. 명령 표 기존 문맥 검사를 따르며 repo 기본 문맥을 받는다.

`skills/orch/tests/routing-report.spec.ts` 에 임시 두 저장소의 고정 기록을 써서 중앙값·평균·첫 dispatch 비율, 요청/effective 차이, null·미등록 모델·손상 줄·날짜·출력 형식을 검증한다. 실측 기록 안내와 변경 조각을 더한다.

## 검증

```bash
node --test skills/orch/tests/routing-report.spec.ts
node scripts/run-tests.ts skills/orch/tests/routing-report.spec.ts skills/orch/tests/lib-commands.spec.ts
node scripts/run-tests.ts
claude plugin test .
```

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ7 | 임시 두 저장소에 고정 JSONL | `node scripts/run-tests.ts skills/orch/tests/routing-report.spec.ts` | 고정 집계값과 경고 일치 | Node 24 이상 | 없음 | PR 전 |


환경은 Node 24 이상과 임시 저장소다. 선행 조건은 phase 01 완료이며 PR 전에 실행한다. REQ7 은 `node scripts/run-tests.ts skills/orch/tests/routing-report.spec.ts` 로 실제 CLI 를 호출하여 두 저장소 집계와 필터, 비용 누락, 표본 적음, 깨진 줄 경고를 대조한다. 기대값은 테스트의 고정 수치와 같다.

실제 기록 후속 검증은 머지 뒤 코디네이터가 fos-skills 와 ai-analysis 에서 `orch routing report --repo "$FOS_REPO" --repo "$ANALYSIS_REPO" --full` 을 실행한다. 환경 변수에는 각 저장소 경로를 넣는다. 기록이 쌓인 뒤 모델·effort·행과 표본 수를 원본 JSONL 에 대조한다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/lib/routing-report.ts` | 신규 |
| `skills/orch/scripts/routing/routing-report.ts` | 신규 |
| `skills/orch/scripts/lib/commands.ts` | 수정 |
| `skills/orch/tests/routing-report.spec.ts` | 신규 |
| `skills/orch/references/agent-selection.md` | 수정 |
| `skills/orch/changes/routing-report.minor.md` | 신규 |
