---
name: plan
description: |
  사용자가 확인한 기능 스펙과 기술 설계를 읽고 PR 하나의 구현 작업과 검증 명령을 만든다.
  "계획 세워줘", "task 파일 만들어줘", "PR 로 나눠줘", "스펙 구현 계획", "리팩토링 계획", "plan" 요청에 쓴다.
  "이 기능 설계해 보자" 처럼 요구사항은 spec, 구조와 경계 설계는 technical-design 이 맡는다. 구현은 implementation 가 맡는다.
metadata:
  version: "5.5.2"
---
# plan

**목표: 확인한 기능 스펙을 지금 구현할 PR 하나의 실행 계획으로 만든다. 구현자는 이 대화를 보지 못해도 계획만 읽고 실행한다.**

- **사용자에게 제품 결정을 묻지 않는다.** 사용자 동작, 권한, 데이터 보존, 외부 계약, 운영에 닿는 새 결정이 나오면 spec 으로 돌려보낸다.
  예외는 새 의존 추가처럼 되돌리기 어려운 기술 선택이다. technical-design 으로 돌려 대안과 영향을 확인한다.
- 인수 조건은 spec, 구조와 검증 전략은 technical-design 이 소유한다. 계획은 순서, 변경 파일, 검증 명령을 소유한다.

## 워크플로우 개요

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 입력과 설정 | `check_feature.py "$SPEC"` 종료 코드가 0 이다(스펙 없는 계획은 범위가 한 문장으로 정해졌다). 레포 설정을 읽었다 | [`monorepo.md`](references/monorepo.md) |
| 2 | 코드 대조 | phase 에 인용할 식별자, 호출 경계, 스키마를 실제 정의에서 읽었다. 재사용할 모듈의 부수 효과를 범위 안이나 밖에 적었다 | |
| 3 | PR 범위 | 이번 PR 의 요구사항 ID 와 `pr_scope` 가 정해졌고, 뒤 PR 은 `deferred` 에 목표와 선행 조건만 있다 | [`plan-size.md`](references/plan-size.md) |
| 4 | task 작성 | 양식으로 index·phase·인수 검증 계획을 썼고, 필요한 책임 문서 변경을 반영했다. 도메인 규칙 변경이 있으면 도메인 문서·출력 계약 수정과 규칙별 확인 사례가 작업에 들어 있다([문서 소유권의 「단계별 책임」](../spec/references/document-ownership.md#단계별-책임)) | [`task-create.md`](references/task-create.md) |
| 5 | 검사와 critic | 새 기능은 `--require-verification` 검사와 critic 의 인수 검증 계획 검토를 통과했다 | [critic 계약](../implementation/references/role-critic.md) |
| 6 | 인계 | 스펙 경로, plan 경로, 요구사항 ID 와 검사 결과를 넘겼다 | |

어느 단계에서든 새 사용자 결정이 나오면 spec, 주요 구조 결정이 비었으면 technical-design 으로 돌려보내고 멈춘다. 영향받는 결정이 해결되면 1부터 잇는다.

## 1. 입력과 설정

[기능 문서와 단계 인계](../spec/references/feature-docs.md)를 읽는다.
[레포 설정 탐색](references/monorepo.md)에 따라 검증 명령, 작업 공간, docs/tasks 경로를 읽는다.

`$SKILL_DIR` 은 plan 번들이고 `$SPEC` 은 대상 저장소 루트 기준 스펙 경로다. 아래 명령은 대상 저장소 루트에서 실행한다.

```bash
python3 "$SKILL_DIR/scripts/check_feature.py" "$SPEC"
```

종료 코드가 0 이 아니면 계획을 쓰지 않는다. 확인 줄이 없거나 결정 표가 닫히지 않은 스펙은 spec 으로 돌려보낸다.
스펙이 없는데 동작이나 설계를 정해야 하는 요청이면 spec 을 먼저 부른다.

**스펙 없는 계획**: 기능 루프를 쓰지 않는 긴 작업(정리, 이전, 리팩터링)을 세션이 끊겨도 이어받게 계획서로 남길 때만 쓴다.
범위는 사용자 요청이나 지시서가 정한다. `spec`, `requirements` 필드 없이 4단계부터 같은 규칙으로 쓴다.

기능 계획은 plan 을 쓰기 전에 확인한 스펙과 설계를 검사한다. 설계가 없으면 technical-design 으로 넘긴다. 기존 R1 계획은 기존 인계를 유지한다.

```bash
python3 "$SKILL_DIR/scripts/check_feature.py" "$SPEC" --design "$DESIGN"
```

## 2. 코드 대조

스펙·설계와 관련 코드를 읽는다. phase 에 기존 식별자, 스키마, 경로를 적기 전에 그 정의를 코드에서 읽는다.
`docs/` 와 맞는 것만으로는 모자라고 코드와도 맞아야 한다. 구현자가 어긋남을 찾으면 계획을 다시 고쳐야 한다.
재사용하는 모듈은 부수 효과(남기는 로그, 드는 비용)까지 함께 받는다. 그 파일을 열어 확인하고 범위 안이나 밖에 적는다.

## 3. PR 범위

[plan 크기](references/plan-size.md)에 맞춰 이번 PR 의 요구사항을 고른다. 가능한 한 API·데이터·테스트를 함께 완성하는 동작 단위로 자른다.
레포 설정에 「PR 변경 파일 상한」 이나 「파일 길이 상한」 이 있으면 그 기준으로 자른다. 5단계 검사가 같은 값을 읽어 넘으면 경고한다.
뒤 PR 은 목표와 선행 조건만 `deferred` 에 남기고 상세 phase 를 미리 쓰지 않는다.

## 4. task 작성

[task 작성 규칙](references/task-create.md)으로 번호를 정하고 index 와 phase 를 만든다.
[index 양식](templates/index.json)과 [phase 양식](templates/phase.md)을 먼저 읽고 실제 값으로 바꾼다.
[인수 검증 계획 양식](templates/verification-plan.md)으로 준비 조건·절차·기대값·환경·선행 조건·시점을 적는다.
작으면 한 phase 의 `## 인수 검증 계획` 절에 쓰고 verification_plan 은 그 phase 를 가리킨다.
같은 문서의 「문서 영향과 ADR」 대로, 이번 PR 이 바꾸는 전역 문서와 ADR 만 갱신한다. 기능 설계가 소유한 내용을 전역 문서에 다시 적지 않는다.

기능 계획은 기존 index 스키마에 다음 필드를 더한다. 경로는 대상 저장소 루트 기준이다.

```json
{
  "spec": "docs/features/run-cancel/spec.md",
  "design": "docs/features/run-cancel/design.md",
  "verification_plan": "verification-plan.md",
  "requirements": ["REQ1", "REQ2"],
  "phases": [
    {"number": 1, "file": "phase-01.md", "execution_profile": "standard", "requirements": ["REQ1", "REQ2"]}
  ]
}
```

verification_plan 은 index.json 의 부모 기준 상대경로다. spec/design 은 저장소 루트 기준 경로다.
이 예시는 추가 필드만 보여준다. name, status, total_phases, current_phase, pr_scope, deferred 는 기존 규칙대로 채운다.
스펙의 모든 요구사항을 한 PR 에 넣을 필요는 없다. 각 phase 는 맡은 ID 를 컨텍스트에 적고 같은 phase 안에서 테스트한다.
기능별 ID 는 `<스펙 경로>#REQ1` 로 구분한다. 전역 요구사항 번호를 만들지 않는다.

## 5. 검사와 critic

`$PLAN` 은 계획 디렉터리명이다. 새 기능의 `$TASKS_DIR` 은 `<기능 폴더>/tasks` 다. 기존 계획이나 기능 없는 작업은 설정의 tasks 경로를 쓴다.
기능 계획이면 이 검사가 스펙의 확인 줄과 요구사항 연결도 함께 본다.
아래 명령은 새 기능 계획용이다. PR 하나라도 기능 계획과 인수 검증 계획을 남긴다. 기능 없는 작업과 기존 계획 재개는 --require-verification 을 빼고 실행한다.

```bash
python3 "$SKILL_DIR/scripts/verify_task.py" "$PLAN" --tasks-dir "$TASKS_DIR" --require-verification
```

통과하면 [critic 계약](../implementation/references/role-critic.md)으로 계획을 검토한다.
[팀원 위임 계약](../implementation/references/team-spawn.md)을 따른 독립 검토자에게 스펙·설계와 plan 을 함께 준다.
기능 없는 작업과 기존 계획 재개는 --require-verification 없이 읽으며, verification_plan 필드가 있으면 기본 검사에서도 대조한다.
critic 은 개발 테스트와 인수 검증 사례를 구분하고 필수 사례가 빠지지 않았는지 확인한다.
테스트가 인수 조건을 증명하는지 확인하고, 계획 결함만 수정한다. 새 제품 결정은 spec, 구조 결정은 technical-design 으로 반환한다.
critic 은 diff 가 아니라 계획을 보므로 verify 의 코드 리뷰나 PR 자동 리뷰와 겹치지 않는다.

## 6. 인계

스펙·설계·인수 검증 계획 경로, 계획 전체 경로, 요구사항 ID 와 검사·critic 결과를 orch 에 넘긴다.
계획서만 통과한 것은 구현 완료가 아니다. 이후 implementation 가 구현하고 verify 가 인수 검증한다.

## 문서 소유권

| 문서 | 소유하는 것 |
| --- | --- |
| 기능 spec/design | 요구사항, 인수 조건, 결정, API·데이터·테스트 설계 |
| 기존 공유 계약·ADR | 기능들이 함께 지킬 규칙과 장기 결정 |
| tasks/plan | 이번 PR 의 작업 순서·변경 파일·검증 명령 |
