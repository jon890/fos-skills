# Phase 01. 선택 검사와 띄우기 이력

**Execution profile**: standard

## 목표

새 띄우기에 모델 선택 검사를 적용하고 정리 뒤에도 남는 이력을 기록한다.

**범위 외**: routing-log 수집과 보고 명령.

## 컨텍스트

**요구사항**: REQ1, REQ4, REQ6, REQ8

**근거 문서**: `docs/features/orch-routing/spec.md`, `docs/features/orch-routing/design.md`

`lib/spec.ts` 에서 지시서를 읽고 `selectionVerdict` 를 lint 와 launch 차례 0 에서 공유한다. 행 id 는 번들의 모델 표가 소유한다. resume 이 이미 쓰는 Launch 의 agent/model/effort 를 재사용한다.

## 의도 메모

- launched-workers 는 정리가 지우므로 영구 이력과 합치지 않는다.
- 이전 지시서가 이미 활성 상태면 선택 검사를 생략한다. 새 띄우기는 행이 없으면 거부한다.
- 직접 worker-start 재시도는 검사를 우회하므로 launch-worker 로 모은다.

## 작업 항목

### 1. row/highReason/experiment 파서와 선택 판정을 구현한다. 잘못된 표, 근거 dispatch, 후보와 effort 불일치, ack 우회 방지를 검증한다.
### 2. Launch 키와 launch-history 를 구현한다. terminal 상속, retry 제외, 자동 재시도의 마지막 이력, 옛 기록 호환을 검증한다.
### 3. launch-worker 의 task/retry-of 경로와 hook 을 구현하고 문서 계약과 변경 조각을 맞춘다.

### 4. 테스트 파일

`skills/orch/tests/lib-selection.spec.ts` 와 기존 launch/lint 테스트에서 위 정상·실패 경계를 실행한다.

## 검증

```bash
node --test skills/orch/tests/lib-selection.spec.ts
node scripts/run-tests.ts skills/orch/tests/lib-selection.spec.ts skills/orch/tests/lib-spec.spec.ts skills/orch/tests/spec-lint.spec.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/coordinator-hooks.spec.ts skills/orch/tests/resume-worker.spec.ts
claude plugin test .
node scripts/run-tests.ts
```

## 인수 검증 계획

환경은 임시 저장소와 가짜 Orca 이며 실제 worker 는 띄우지 않는다. PR 전 실행한다.

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 가짜 이력 | Opus high 이상에 유효·무효 근거와 옛 dispatch 를 넣고 lint/launch 실행 | 유효 근거와 모델 없는 옛 기록만 통과, ack 으로 우회 불가 | 임시 저장소 | 없음 | PR 전 |
| REQ4 | 가짜 Orca | 가짜 worker-start 로 새 실행·terminal·retry 실행 | 요청값·effective·experiment 와 영구 이력이 남고 옛 Launch 도 읽힘 | 임시 저장소 | 없음 | PR 전 |
| REQ6 | 후보 이력 | 실험 이름·후보 변경·배정 동률·retry 이력 실행 | 꼴/후보 밖 거부, 가장 적은 후보 선택, retry 는 집계 제외 | 임시 저장소 | 없음 | PR 전 |
| REQ8 | 문서 표 | 행 없는 지시서를 active 와 새 대상으로 검사 | active 는 호환, 새 띄우기는 거부, 문서 표 id 와 대조 | 임시 저장소 | 없음 | PR 전 |

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/lib/spec.ts` | 수정 |
| `skills/orch/scripts/lib/selection.ts` | 신규 |
| `skills/orch/scripts/lib/launch-history.ts` | 신규 |
| `skills/orch/scripts/lib/launched.ts` | 수정 |
| `skills/orch/scripts/lib/bundle.ts` | 수정 |
| `skills/orch/scripts/spec/spec-lint.ts` | 수정 |
| `skills/orch/scripts/worker/launch-worker.ts` | 수정 |
| `skills/orch/hooks/require-spec-line.ts` | 수정 |
| `skills/orch/tests/lib-selection.spec.ts` | 신규 |
| `skills/orch/tests/lib-spec.spec.ts` | 수정 |
| `skills/orch/tests/spec-lint.spec.ts` | 수정 |
| `skills/orch/tests/launch-worker.spec.ts` | 수정 |
| `skills/orch/tests/coordinator-hooks.spec.ts` | 수정 |
| `skills/orch/references/spec-writing.md` | 수정 |
| `skills/orch/references/launch.md` | 수정 |
| `skills/orch/references/waiting.md` | 수정 |
| `skills/orch/references/replying.md` | 수정 |
| `skills/orch/references/agent-selection.md` | 수정 |
| `skills/orch/SKILL.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `skills/orch/changes/selection-history.minor.md` | 신규 |
| `skills/orch/scripts/worker/resume-worker.ts` | 수정 |
| `skills/orch/tests/resume-worker.spec.ts` | 수정 |
