---
name: build-with-teams
description: |
  planning 이 만든 기능 계획을 구현하고 개발 테스트 결과를 넘긴다.
  "task 실행해줘", "phase 실행", "agent team 으로 빌드", "build-with-teams" 요청에 쓴다.
  독립 리뷰와 인수 검증은 verify, PR·머지와 정리는 orch 가 조율한다.
metadata:
  version: "6.1.0"
---
# build-with-teams

**목표: 계획한 요구사항을 구현하고 개발 검증 증거와 함께 verify 에 넘긴다.**

## 입력과 설정

plan 의 index.json 을 먼저 읽는다. `spec` 필드가 없는 기존 계획과 task 없는 기존 리뷰 요청은
[기존 계획의 호환 절차](references/legacy-workflow.md)로 이어 간다. 새 기능은 planning 으로 돌린다.
기능 계획은 [단계 인계](../spec/references/feature-docs.md), [레포 설정 탐색](../planning/references/monorepo.md)을 읽는다.
기준 브랜치, 검증 명령과 작업 공간 규칙은 `.claude/build-with-teams-overlay.md` 또는 저장소 지침에서 얻는다.

## 절차

1. `scripts/plan_precheck.py` 로 중복 실행을 확인하고, 계획 브랜치의 분리된 작업 공간을 준비한다.
   처음 구현할 때는 기본 verify_task 검사를 쓴다. 일부 phase 가 이미 구현됐거나 verify 에서 돌아왔으면
   `--audit` 로 계획을 검사하고 기존 커밋과 `current_phase` 를 대조해 남은 phase 또는 지적받은 부분만 이어 간다.
   완료한 phase 를 처음부터 다시 실행하지 않는다. 각 phase 커밋 뒤 다음 phase 를 `current_phase` 에 기록하고,
   모든 phase 구현 뒤에는 그 값을 유지한 채 인계에 구현 완료를 적는다. 최종 completed/계획서 정리는 orch 가 맡는다.
2. 스펙과 phase 를 함께 읽는다. [팀원 위임 계약](references/team-spawn.md)에 따라 executor 에게 phase 를 맡긴다.
   [executor 계약](references/role-executor.md)과 [실행 등급](references/executor-routing.md)을 따른다.
   planning 의 critic 결과를 실행 형태의 근거로 받으며, 없으면 구현 전에 planning 에서 검토하게 한다.
3. executor 는 구현과 phase 테스트를 실행한다. 버그 수정은 증상을 재현하는 테스트가 수정 전 실패하고 수정 후 통과하는지 확인한다.
   team-lead 는 변경 파일을 대조하고 phase 별로 커밋한다. phase 는 기본 순서대로 실행한다.
4. 누적 변경에 저장소의 개발 검증 명령을 실행한다. 실패는 구현에서 해결하고, 스펙 결정이 필요한 문제는 planning/spec 으로 돌린다.
5. 남은 executor 를 종료하고 아래 인계 정보를 orch 에 보낸다. 작업 공간과 계획서는 verify 가 쓸 수 있게 남긴다.

`$SKILL_DIR` 은 build-with-teams 번들이다. cwd 는 대상 작업 공간 루트다.
`$PLANNING_SKILL_DIR` 은 형제 planning 번들이다. 기준 브랜치와 plan 브랜치는 저장소 설정값이다. `$PLAN` 은 plan 경로가 아니라 tasks 아래 디렉터리 이름이다.
재개·수정 작업에서는 아래 두 번째 명령에 `--audit` 를 붙인다.

```bash
python3 "$SKILL_DIR/scripts/plan_precheck.py" "$PLAN" --repo "$REPO" --base "$BASE_BRANCH" --branch "$BRANCH" --tasks-dir "$TASKS_DIR" --docs-dir "$DOCS_DIR" --json
python3 "$PLANNING_SKILL_DIR/scripts/verify_task.py" "$PLAN" --tasks-dir "$TASKS_DIR"
```

phase 커밋 전에는 다음 검사로 해당 phase 의 staged 파일만 대조한다.

```bash
python3 "$PLANNING_SKILL_DIR/scripts/verify_task.py" --staged "$PHASE_FILE"
```

push·원격 접속·배포가 필요한 명령은 실행 시점과 기대값을 인계한다. 필요한 검증을 없애거나 통과로 표시하지 않는다.

## 인계

```text
완료: 구현과 개발 검증 (기능 인수 완료는 아님)
스펙: <경로>
plan: <경로>, 요구사항: <ID 목록>
작업 공간: <절대경로>
기준 브랜치 / 검증 커밋: <값>
변경 파일: <목록>
개발 검증: <명령과 결과>
원격 검증과 남은 것: <선행 조건, 명령, 기대값 또는 없음>
다음: verify
```

## 완료 기준

맡은 요구사항의 구현과 필수 개발 검증이 끝났고 verify 가 같은 변경을 확인할 수 있다.
코드 리뷰·인수 검증·공통화·PR 생성·작업 공간 삭제를 이 단계에 묶지 않는다.
실패하면 이유와 돌아갈 단계를 회신한다. worker_done/MERGED 규칙은 바꾸지 않는다.
orch worker 는 이 결과를 중간 진행으로 보내고 검증·PR·머지까지 orch 의 지시를 따른다.
