---
name: planning
description: |
  사용자가 확인한 기능 스펙을 읽고 PR 하나의 구현 작업과 검증 명령을 만든다.
  "계획 세워줘", "task 파일 만들어줘", "PR 로 나눠줘", "스펙 구현 계획", "리팩토링 계획", "planning" 요청에 쓴다.
  "이 기능 설계해 보자" 처럼 동작과 설계를 정하는 요청은 spec 이 맡는다. 구현은 build-with-teams 가 맡는다.
metadata:
  version: "4.1.0"
---
# planning

**목표: 확인한 기능 스펙을 지금 구현할 PR 하나의 실행 계획으로 만든다. 구현자는 이 대화를 보지 못해도 계획만 읽고 실행한다.**

- **사용자에게 제품 결정을 묻지 않는다.** 사용자 동작, 권한, 데이터 보존, 외부 계약, 운영에 닿는 새 결정이 나오면 spec 으로 돌려보낸다.
  예외는 새 의존 추가처럼 되돌리기 어려운 기술 선택이다. 대안 둘 이상을 비교해 묻는다.
- 기능의 설계와 인수 조건은 스펙이 소유한다. 계획은 순서, 변경 파일, 검증 명령을 소유한다.

## 워크플로우 개요

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 입력과 설정 | `check_feature.py "$SPEC"` 종료 코드가 0 이다(스펙 없는 계획은 범위가 한 문장으로 정해졌다). 레포 설정을 읽었다 | [`monorepo.md`](references/monorepo.md) |
| 2 | 코드 대조 | phase 에 인용할 식별자, 호출 경계, 스키마를 실제 정의에서 읽었다. 재사용할 모듈의 부수 효과를 범위 안이나 밖에 적었다 | |
| 3 | PR 범위 | 이번 PR 의 요구사항 ID 와 `pr_scope` 가 정해졌고, 뒤 PR 은 `deferred` 에 목표와 선행 조건만 있다 | [`plan-size.md`](references/plan-size.md) |
| 4 | task 작성 | index 와 phase 를 썼고, 바뀌는 전역 문서와 ADR 을 갱신했다 | [`task-create.md`](references/task-create.md) |
| 5 | 검사와 critic | `verify_task.py` 종료 코드가 0 이고, critic 판정이 통과다 | [critic 계약](../build-with-teams/references/role-critic.md) |
| 6 | 인계 | 스펙 경로, plan 경로, 요구사항 ID 와 검사 결과를 넘겼다 | |

어느 단계에서든 새 사용자 결정이 나오면 spec 으로 돌려보내고 멈춘다. 스펙이 다시 확인되면 1부터 잇는다.

## 1. 입력과 설정

[기능 문서와 단계 인계](../spec/references/feature-docs.md)를 읽는다.
[레포 설정 탐색](references/monorepo.md)에 따라 검증 명령, 작업 공간, docs/tasks 경로를 읽는다.

`$SKILL_DIR` 은 planning 번들이고 `$SPEC` 은 대상 저장소 루트 기준 스펙 경로다. 아래 명령은 대상 저장소 루트에서 실행한다.

```bash
python3 "$SKILL_DIR/scripts/check_feature.py" "$SPEC"
```

종료 코드가 0 이 아니면 계획을 쓰지 않는다. 확인 줄이 없거나 결정 표가 닫히지 않은 스펙은 spec 으로 돌려보낸다.
스펙이 없는데 동작이나 설계를 정해야 하는 요청이면 spec 을 먼저 부른다.

**스펙 없는 계획**: 기능 루프를 쓰지 않는 긴 작업(정리, 이전, 리팩터링)을 세션이 끊겨도 이어받게 계획서로 남길 때만 쓴다.
범위는 사용자 요청이나 지시서가 정한다. `spec`, `requirements` 필드 없이 4단계부터 같은 규칙으로 쓴다.

## 2. 코드 대조

스펙과 관련 코드를 읽는다. phase 에 기존 식별자, 스키마, 경로를 적기 전에 그 정의를 코드에서 읽는다.
`docs/` 와 맞는 것만으로는 모자라고 코드와도 맞아야 한다. 구현자가 어긋남을 찾으면 계획을 다시 고쳐야 한다.
재사용하는 모듈은 부수 효과(남기는 로그, 드는 비용)까지 함께 받는다. 그 파일을 열어 확인하고 범위 안이나 밖에 적는다.

## 3. PR 범위

[plan 크기](references/plan-size.md)에 맞춰 이번 PR 의 요구사항을 고른다. 가능한 한 API·데이터·테스트를 함께 완성하는 동작 단위로 자른다.
뒤 PR 은 목표와 선행 조건만 `deferred` 에 남기고 상세 phase 를 미리 쓰지 않는다.

## 4. task 작성

[task 작성 규칙](references/task-create.md)으로 번호를 정하고 index 와 phase 를 만든다.
같은 문서의 「문서 영향과 ADR」 대로, 이번 PR 이 바꾸는 전역 문서와 ADR 만 갱신한다. 기능 스펙이 소유한 설계를 전역 문서에 다시 적지 않는다.

기능 계획은 기존 index 스키마에 다음 필드를 더한다. 경로는 대상 저장소 루트 기준이다.

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

## 5. 검사와 critic

`$PLAN` 은 tasks 아래 디렉터리 이름이며 `$TASKS_DIR` 기본값은 `tasks` 다.
기능 계획이면 이 검사가 스펙의 확인 줄과 요구사항 연결도 함께 본다.

```bash
python3 "$SKILL_DIR/scripts/verify_task.py" "$PLAN" --tasks-dir "$TASKS_DIR"
```

통과하면 [critic 계약](../build-with-teams/references/role-critic.md)으로 계획을 검토한다.
[팀원 위임 계약](../build-with-teams/references/team-spawn.md)을 따른 독립 검토자에게 스펙과 plan 을 함께 준다.
테스트가 인수 조건을 증명하는지 확인하고, 계획 결함만 수정한다. 새 제품 결정은 spec 으로 반환한다.
critic 은 diff 가 아니라 계획을 보므로 verify 의 코드 리뷰나 PR 자동 리뷰와 겹치지 않는다.

## 6. 인계

스펙 경로, plan 경로, 요구사항 ID 와 검사·critic 결과를 orch 에 넘긴다.
계획서만 통과한 것은 구현 완료가 아니다. 이후 build-with-teams 가 구현하고 verify 가 인수 검증한다.

## 문서 소유권

| 문서 | 소유하는 것 |
| --- | --- |
| 기능 spec/design | 요구사항, 인수 조건, 결정, API·데이터·테스트 설계 |
| 기존 공유 계약·ADR | 기능들이 함께 지킬 규칙과 장기 결정 |
| tasks/plan | 이번 PR 의 작업 순서·변경 파일·검증 명령 |
