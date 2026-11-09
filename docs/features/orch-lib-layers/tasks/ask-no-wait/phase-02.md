# Phase 02. 인수 검증과 계획서 지우기

**Execution profile**: standard

## 목표

phase 01 의 동작을 실제 Orca 에서 확인하고, 구현을 마친 이 계획서를 같은 PR 에서 지운다.

**범위 외**: 코디네이터 쪽 대기 변경(계획 orca-wake).

## 컨텍스트

**요구사항**: REQ7, REQ8

**근거 문서**: `docs/features/orch-lib-layers/spec.md`(REQ7), `docs/features/orch-lib-layers/design.md`(「검증 전략」)

- 실제 Orca 검증은 worker 를 띄워야 한다. 구현 worker 는 다른 worker 를 띄우지 못하므로 아래 표의 절차를 ask 로 코디네이터에게 맡기고 결과를 PR 본문 증거에 옮긴다.
- 계획서는 그 계획을 구현한 PR 에서 지운다(plan 의 `plan-lifecycle.md`).

## 작업 항목

### 1. 인수 검증

아래 「인수 검증 계획」 을 실행하고 결과를 PR 본문의 `templates/feature-evidence.md` 양식에 적는다.

### 2. 계획서 지우기

인수 검증을 마친 뒤 `docs/features/orch-lib-layers/tasks/ask-no-wait/` 를 지우는 커밋을 따로 만든다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ7 | 이 브랜치를 담은 플러그인 번들, 실측용 Run 과 worker 하나 | worker 가 `orch worker ask --from <자기 handle> --question "색을 하나 골라 주세요"` 를 전경으로 돌리고 턴을 끝낸다. 코디네이터가 `orca orchestration reply` 로 답한다 | 명령이 몇 초 안에 `ASKED <id>` 와 0 으로 끝난다. 답 뒤 worker 화면에 「You have 1 orchestration message」 가 들어오고 worker 가 `check` 로 답을 읽는다 | 실제 Orca 1.4.254 이상, 메인 Run 과 떨어진 실측용 세션 | 없음 | PR 전 |
| REQ7 | 같은 worker | `--timeout-ms 600000 --max-wait 3600000` 을 붙여 같은 명령을 부른다 | stderr 에 무시 안내 한 줄, `ASKED <id>` 와 0 | 같은 환경 | 없음 | PR 전 |
| REQ8 | 같은 worker | `orch worker ask --from <handle> --resume <id>` | 안내 한 줄과 2. `orca orchestration inbox --terminal run:<Run>` 에 새 질문이 없다 | 같은 환경 | 없음 | PR 전 |
| REQ7 | 공통 지시서 틀 | `skills/orch/templates/spec-common.md` 에서 `run_in_background`, `--max-wait`, `TIMEOUT` 을 grep 으로 센다 | 셋 모두 0 줄 | 작업 공간 | 없음 | PR 전 |

## 검증

```bash
node scripts/run-tests.ts
test ! -e docs/features/orch-lib-layers/tasks/ask-no-wait
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `docs/features/orch-lib-layers/tasks/ask-no-wait/index.json` | 삭제 |
| `docs/features/orch-lib-layers/tasks/ask-no-wait/phase-01.md` | 삭제 |
| `docs/features/orch-lib-layers/tasks/ask-no-wait/phase-02.md` | 삭제 |
