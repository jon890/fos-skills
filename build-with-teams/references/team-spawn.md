# 팀원 스폰 가드 상세

`SKILL.md` "팀 구성" 절의 포인터로 도달한 참조 문서. 팀원(executor·critic·code-reviewer·docs-verifier)을 스폰·통신할 때 실측 사고를 근거로 굳어진 가드 7종의 상세 프롬프트·근거를 담는다. **팀원 스폰 전 반드시 읽는다.**

## 목차

1. [정식 팀원 스폰 규칙](#1-정식-팀원-스폰-규칙) — `team_name`+`name` 없이 스폰하면 SendMessage 협업이 끊긴다
2. [팀원 프롬프트·메시지는 worktree 절대경로](#2-팀원-프롬프트메시지는-worktree-절대경로) — 상대경로는 main 의 구버전 파일을 가리킬 수 있다
3. [팀원 SendMessage 회신 강제](#3-팀원-sendmessage-회신-강제) — 자기 화면 출력만 하고 종료하면 team-lead 에 안 닿는다
4. [팀원 자발적 실행 방지](#4-팀원-자발적-실행-방지) — 지시 전 선행 실행은 게이트 시점 정합성을 깬다
5. [팀원 self-shutdown 대응](#5-팀원-self-shutdown-대응) — idle 알림 직후 자체 종료하는 경향에 대한 우회
6. [executor cwd 격리](#6-executor-cwd-격리) — main repo 오염 방지
7. [executor scope 확장 보고 의무](#7-executor-scope-확장-보고-의무) — 범위 외 수정 자체 판단 금지

---

## 1. 정식 팀원 스폰 규칙

팀원은 **팀의 정식 멤버로 스폰**한다 (`team_name` + `name` 지정). 일회성 `Agent` 호출(team_name 없이)로 대체하지 않는다.

- **왜**: 일회성 호출은 팀 컨텍스트 밖에서 동작해 `SendMessage` 반복 협업이 불가하다. 정식 팀원은 idle 로 대기하며 REVISE 재평가·executor 재실행·재검증 사이클을 자연스럽게 처리한다.
- `name` 은 `critic`/`executor`/`code-reviewer`/`docs-verifier` 로 통일한다.
- `run_in_background: true` 로 idle 대기.
- 이후 통신은 **모두 `SendMessage({to: "<name>", ...})` 로만** 진행.

**스폰 직후 검증**: `name` 을 빠뜨려도 호출은 조용히 성공하고 응답이 정식 멤버와 거의 같아 보인다. 일회성으로 처리되면 sub-agent 가 응답 직후 종료해 SendMessage 가 빈 mailbox 로 향한다. 응답 형식(멤버는 `agent_id`·`name`·`team_name` 노출)으로 1차 식별하고, 팀 config 로 실제 등록을 확인한다. 누락이면 `name` 을 넣어 재스폰한다.

> 팀 런타임 형태(TeamCreate 명령 유무, config 경로, 이름 충돌 시 suffix 처리)는 harness 마다 다르다. harness 세부는 오버레이 또는 harness 문서를 따른다.

## 2. 팀원 프롬프트·메시지는 worktree 절대경로

sub-agent 는 main 워킹 디렉터리에서 실행될 수 있다. 상대경로나 `tasks/{plan}/...` 형태로 지시하면 worktree 브랜치에 커밋된 최신 파일이 아니라 main 의 구버전·미존재 파일을 읽어 오판한다.

- 파일 참조는 반드시 worktree 절대경로(`/Users/.../.claude/worktrees/{plan}/tasks/{plan}/phase-XX.md`).
- 팀원이 구버전을 본다고 의심되면 `grep` 한 실제 내용을 메시지에 붙이고 절대경로를 재확인시킨다.

## 3. 팀원 SendMessage 회신 강제

sub-agent 가 결론을 자기 화면에만 출력하고 종료하면 team-lead 까지 라우팅되지 않는다. idle 알림만 도착해 team-lead 가 다음 단계로 못 간다.

스폰 프롬프트 + 작업 지시 메시지 양쪽에 다음을 포함:

```
회신은 반드시 SendMessage tool 호출로 team-lead 에게 전송할 것.
자기 화면에 텍스트만 출력하고 종료하면 main session 까지 라우팅 안 됨.
판정/결론 + 핵심 사유 1-2 문단을 SendMessage 의 message 필드로 보낼 것.
```

team-lead 는 idle 알림만 2회 이상 연속 수신하고 결과 메시지가 없으면 통신 누락으로 보고 즉시 재요청한다.

## 4. 팀원 자발적 실행 방지

정식 팀원이 team-lead 의 지시 전에 자발적으로 실행·검증을 시작하면 게이트 시점 정합성이 깨진다. 스폰 프롬프트에 다음을 포함:

```
대기 상태. team-lead 의 SendMessage 지시 전에 절대 자발적으로 작업/검증을 시작하지 말 것.
team-lead 가 명시적으로 "시작" 지시할 때까지 idle 유지. 자발적 실행 = 시점 오해로 잘못된 판정 위험.
```

team-lead 는 critic 평가가 끝나기 전에 워크트리 상태(`git log`, `git status`)를 점검해 자발적 실행을 조기 감지한다.

## 5. 팀원 self-shutdown 대응

code-reviewer·docs-verifier 는 `run_in_background: true` + idle 프롬프트로 스폰해도 **idle 알림 직후 자체 종료하는 경향**이 관측된다.

- **우회**: 검사 대상 결과물이 준비된 시점에 즉시 새로 spawn (idle 대기 의존 금지). team-lead 는 팀원이 죽었다는 알림을 받으면 침묵 말고 **재spawn + 즉시 지시 메시지** 묶음으로 처리한다.
- **판정 시간 규칙**: SendMessage 후 일정 시간(약 90초) 안에 verdict 회신이 없고 idle 알림만 2회 이상 오면 self-shutdown 을 의심한다. 강제 재요청 1회 → 무응답이면 재spawn + 동일 지시 → 3회 누적 실패 시 사용자에게 에스컬레이션.

## 6. executor cwd 격리

executor 가 main 워킹 디렉터리에서 실행돼 main 브랜치에 직접 변경을 가하는 사고가 관측된다. main 이 origin 과 갈라지거나 다른 plan 의 미푸시 작업과 충돌한다 — 이 사고를 막는 것이 이 가드의 목적이다.

executor 스폰 프롬프트에 다음 가드를 그대로 포함한다:

```
모든 파일 경로 / cd / git 명령은 worktree 절대경로 (/Users/.../.claude/worktrees/{plan}/) 기준으로만 수행.
main repo 루트 직접 cd / 직접 편집 절대 금지. 의심되면 `pwd` 로 확인 후 진행.
```

team-lead 는 executor 작업 중 main repo working tree 가 clean 한지 주기 점검하고, dirty 발견 시 즉시 중단 후 분류한다.

## 7. executor scope 확장 보고 의무

executor 가 task 범위 외 수정(pre-existing 에러 픽스, 발견한 bug, 규칙 위반 자체 변경)을 자체 판단으로 추가하면 critic·code-reviewer 게이트를 우회하게 된다. 스폰 프롬프트에 다음을 그대로 포함한다:

```
task 범위 외 코드 수정(pre-existing 에러, 발견한 bug, 규칙 위반 자체 변경)은 자체 판단 금지.
필요 시 SendMessage 로 보고: "task 범위 외 X 발견, Y 필요. 본 phase 포함 / 별도 plan 분리 결정 부탁".
team-lead 의 명시적 승인 후에만 추가.
lint/타입 검사 무시 주석(disable/ignore 류) 자체 추가 금지 — 규칙 위반은 정책 변경이라 사용자 결정 영역.
verification 보고는 검증 명령 전체 결과를 보고할 것. "프로덕션 코드만" 같은 한정 표현 금지 (테스트 파일 에러 누락 위험).
```

team-lead 는 보고 시 critic 사후 평가로 ACCEPT/REJECT 를 가르고, ACCEPT 면 commit 메시지에 범위 확장을 명시한다.
