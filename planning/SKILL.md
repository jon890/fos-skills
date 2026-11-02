---
name: planning
description: |
  합의한 기능 스펙을 읽고 PR 하나의 구현 작업과 검증 명령을 만든다.
  "계획 세워줘", "task 파일 만들어줘", "스펙 구현 계획", "리팩토링 계획", "planning" 요청에 쓴다.
  동작과 설계가 미정이면 spec 에서 먼저 정한다. 구현은 build-with-teams 가 맡는다.
metadata:
  version: "3.1.0"
---
# planning

**목표: 확정한 기능 스펙을 지금 구현할 PR 하나의 실행 계획으로 만든다.**

## 입력과 설정

[기능 문서와 단계 인계](../spec/references/feature-docs.md)를 읽는다.
[레포 설정 탐색](references/monorepo.md)에 따라 검증 명령, 작업 공간, docs/tasks 경로를 읽는다.
스펙이 없으면 `spec` 으로 요구사항과 필요한 설계를 먼저 정한다. 같은 합의를 두 번 받지 않는다.
`spec` 필드가 없는 기존 계획의 재개·수정 요청일 때만 [기존 계획의 호환 절차](references/legacy-workflow.md)를 쓴다.

## 절차

1. 스펙과 관련 코드를 읽고 식별자·호출 경계·스키마를 실제 정의와 대조한다. 구현에 필요한 미결정이 있으면 spec 으로 돌려보낸다.
2. [plan 크기](references/plan-size.md)에 맞춰 이번 PR 의 요구사항을 고른다. 가능한 한 API·데이터·테스트를 함께 완성하는 동작 단위로 자른다.
   뒤 PR 은 목표와 선행 조건만 `deferred` 에 남기고 상세 phase 를 미리 쓰지 않는다.
3. [task 작성 규칙](references/task-create.md)으로 index 와 phase 를 만든다. 기능 설계는 스펙이 소유하며 전역 문서 다섯 개를 매번 갱신하지 않는다.
4. 아래 검사를 실행한 뒤 [critic 계약](../build-with-teams/references/role-critic.md)으로 계획을 검토한다.
   [팀원 위임 계약](../build-with-teams/references/team-spawn.md)을 따른 독립 검토자에게 스펙과 plan 을 함께 준다.
   테스트가 인수 조건을 증명하는지 확인하고, 계획 결함만 수정한다. 새 제품 결정은 spec 으로 반환한다.
5. 스펙 경로, plan 경로, 요구사항 ID 와 검증 결과를 orch 에 넘긴다.

`$SKILL_DIR` 은 planning 번들이다. `$PLAN` 은 tasks 아래 디렉터리 이름이며 `$TASKS_DIR` 기본값은 `tasks` 다. 아래 명령은 대상 저장소 루트에서 실행한다.

```bash
python3 "$SKILL_DIR/scripts/verify_task.py" "$PLAN" --tasks-dir "$TASKS_DIR"
```

## 기능 계획의 연결 필드

기존 index 스키마에 다음 필드를 더한다. 경로는 대상 저장소 루트 기준이다.

```json
{
  "spec": "docs/features/run-cancel/spec.md",
  "requirements": ["R1", "R2"],
  "phases": [
    {"number": 1, "file": "phase-01.md", "execution_profile": "standard", "requirements": ["R1", "R2"]}
  ]
}
```

이 예시는 추가 필드만 보여준다. name, status, total_phases, current_phase, pr_scope, deferred 는 기존 규칙대로 채운다.
스펙의 모든 요구사항을 한 PR 에 넣을 필요는 없다. 각 phase 는 맡은 ID 를 컨텍스트에 적고 같은 phase 안에서 테스트한다.
기능별 ID 는 `<스펙 경로>#R1` 로 구분한다. 전역 요구사항 번호를 만들지 않는다.

## 완료 기준

이번 PR 의 요구사항과 phase 가 연결되고, 실행할 테스트와 기대값이 있으며, 형식 검사와 critic 검토를 통과했다.
계획서만 통과한 것은 구현 완료가 아니다. 이후 build-with-teams 가 구현하고 verify 가 인수 검증한다.

## 문서 소유권

| 문서 | 소유하는 것 |
| --- | --- |
| 기능 spec/design | 요구사항, 인수 조건, API·데이터·테스트 설계 |
| 기존 공유 계약·ADR | 기능들이 함께 지킬 규칙과 장기 결정 |
| tasks/plan | 이번 PR 의 작업 순서·변경 파일·검증 명령 |

기존 계획의 prd/flow/code-architecture/data-schema/adr 문서 배치는 호환 절차가 소유한다.
새 기능에는 [기능 문서 규칙](../spec/references/feature-docs.md)을 적용한다.
