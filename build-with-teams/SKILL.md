---
name: build-with-teams
description: |
  planning 이 만든 task 를 읽어 plan 하나를 구현까지 끝낸다.
  "/build-with-teams", "agent team 으로 빌드", "teams 로 phase 실행",
  "task 실행해줘", "phase 실행" 같은 요청이면 이 스킬을 쓴다.
  task 를 만드는 일은 `planning` 이 맡는다. 방향이 반대다.
metadata:
  version: "5.0.0"
---
# build-with-teams

**목표: planning 이 만든 `tasks/` 를 읽어 구현하고, 검토를 통과한 PR 하나로 닫는다.**

- 계획에 결함이 있으면 구현 전에 잡는다.
- 구현된 코드가 계획한 것과 같아야 한다.
- 코드가 `docs/` 에 적힌 결정과 어긋나지 않아야 한다.

team-lead 가 팀원 넷을 부른다. 각자 역할이 독립적이다.


| 팀원                | 무엇을 보나                            | 판정                                     |
| ----------------- | --------------------------------- | -------------------------------------- |
| **critic**        | 구현 전 계획. phase 순서와 누락, 실제 코드와의 일치 | `APPROVE` / `REVISE`                   |
| **executor**      | 배정받은 phase 하나. 구현하고 검증한다          | 완료 보고                                  |
| **code-reviewer** | 누적 diff 의 코드 품질과 반복 함정            | `PASS` / `FIX_NEEDED`                  |
| **docs-verifier** | 누적 diff 와 `docs/` 의 정합성           | `PASS` / `UPDATE_NEEDED` / `VIOLATION` |


**team-lead 는 스스로 검토하지 않는다.** 자기 계획과 자기 구현을 같은 맥락에서 승인하면 결함이 드러나지 않는다.
team-lead 가 하는 것은 조율, phase 단위 커밋, 검토 결과의 분류, PR 이다.
구현은 규모와 무관하게 executor 에게 위임한다.

절차 어디서든 **결정 결과가 회수 비용이 크거나, 사용자 의도에 따라 갈리거나, plan 범위를 벗어나면**
옵션과 트레이드오프를 붙여 질문한다.
긴 자동 실행에서는 완료 압력이 걸려 이 판단이 "일단 진행" 쪽으로 기운다.

## 실행 순서

### 0. 레포 오버레이를 읽는다

`<repo-root>/.claude/build-with-teams-overlay.md` 가 있으면 **먼저 읽고** 그 지시를 코어보다 우선한다.
없으면 레포 `CLAUDE.md` 를 본다. 거기에도 근거가 없으면 사용자에게 확인한다.

오버레이가 정하는 것은 일곱이다.


| 무엇                                      | 쓰이는 곳    |
| --------------------------------------- | -------- |
| 통합 검증 명령 (lint, 타입 검사, 테스트, 빌드)         | 7단계      |
| 브랜치 이름 형식, 작업 공간을 만들고 정리하는 방법 | 1단계, 2단계, 7단계 |
| executor 와 docs-verifier 로 쓸 전용 에이전트 이름 | 5단계, 6단계 |
| `index.json` 필드와 phase 파일 규격의 레포 변형     | 3단계      |
| 반복 함정 목록 경로 | 3단계, 6단계 |
| 커밋과 PR 컨벤션, 노하우 누적 위치 | 5단계, 7단계 |
| 의존성 설치와 환경 파일 준비 | 2단계 |


### 1. 사전 검증으로 재실행을 막는다

plan 인자를 받으면 가장 먼저 돌린다.

```bash
python3 scripts/plan_precheck.py <plan> --repo <repo-root>
```


| 종료 코드 | 뜻          | 다음                    |
| ----- | ---------- | --------------------- |
| 0     | 진행 가능      | 2단계로                  |
| 1     | 사용자 결정 필요  | 출력한 발견 사항을 보여주고 확정받는다 |
| 2     | 검사기가 돌지 못함 | 원인을 해소한 뒤 다시 돌린다      |


**종료 코드 0 이 아니면 사용자 확인 전에 진행하지 않는다.**

브랜치 이름이 task 디렉터리 이름과 다르면 `--branch` 로 넘긴다.
무엇을 이어서 하고 무엇을 새로 시작할지는 스크립트가 정하지 않는다. 사용자가 정한다.

### 2. 작업 공간을 잡는다

이 스킬이 요구하는 것은 셋이다. 어떻게 만들지는 사용자와 오버레이가 정한다.

- **원격 plan 브랜치 위에서 작업한다.** planning 의 docs 와 tasks 커밋이 그 위에 있어야 task 를 읽을 수 있고,
  구현 커밋이 같은 브랜치에 쌓여야 PR 하나로 닫힌다.
- **main 워킹 디렉터리와 분리한다.** executor 가 main 을 건드리면 main 이 origin 과 갈라진다.
- **팀원에게 줄 절대경로가 있어야 한다.** 상대경로는 팀원 cwd 기준으로 풀려 엉뚱한 파일을 가리킨다.

plan 브랜치가 원격 main 보다 뒤처졌으면 시작 전에 갱신할지 사용자에게 확인한다.
오래된 base 위에서 구현하면 그사이 머지된 docs 와 코드가 어긋난다.

### 3. task 를 읽고 critic 을 스폰한다

team-lead 가 `index.json` 과 `phase-*.md`, 그것이 가리키는 docs 를 읽는다.

critic 을 `critic` 이라는 이름으로 스폰한다. 팀은 세션 시작 시 자동으로 구성되므로 따로 만들지 않는다.
스폰 등급은 [`references/executor-routing.md`](references/executor-routing.md)의 규모별 기본 등급 표에서 고르고,
스폰 시점에 명시 지정한다.
스폰 프롬프트에 [`references/role-critic.md`](references/role-critic.md) 절대경로를 읽으라고 지시하고,
호출 인자(task 파일 절대경로, 반복 함정 목록 경로)만 담는다.

### 4. critic 평가를 통과시킨다

회신은 **판정 / phase 별 실행 형태 / 발견 목록** 셋으로 온다.
실행 형태가 없으면 재요청한다. 5단계 점검의 입력이다.

발견을 무엇으로 처리할지는 team-lead 가 정한다.

- 계획을 고쳐야 하는 것 → `REVISE` 로 되돌린다.
- 구현하며 챙기면 되는 것 → `critic minor notes` 로 executor 스폰 프롬프트에 넘긴다.
- 이번 plan 밖의 것 → 특이사항 4종에 합쳐 보고한다.

`APPROVE` 면 5단계로, `REVISE` 면 수정 후 재평가한다 (한도 3회).

**재평가 요청에는 변경 파일 절대경로와 어느 라인이 어떻게 바뀌었는지를 담는다.**
회신이 직전 판정과 같으면 수정된 실제 라인을 `grep` 으로 떠서 증거로 붙여 재요청한다.
code-reviewer 와 docs-verifier 재검사도 같다.

### 5. phase 를 하나씩 구현한다

`index.json` 의 미완료 phase 를 순서대로 돈다. **한 phase 마다 아래 여섯을 반복한다.**

**5-1. 실행 형태를 판정한다.**
[`references/executor-routing.md`](references/executor-routing.md)를 읽고,
critic 회신과 team-lead 직접 점검을 assessment JSON 으로 만들어 스크립트에 통과시킨다.

```bash
python3 scripts/executor_routing_gate.py <assessment.json>
```

스크립트가 차단하면 그 phase 에 착수하지 않는다.
통과하면 출력 JSON 의 `effective_shape` 를 쓴다.

**5-2. 실행 등급을 정한다.** 출발값을 하나 고르고, 그 값을 하한으로 끌어올린다.


| 순서  | 무엇                                                                    |
| --- | --------------------------------------------------------------------- |
| 출발값 | phase 의 `execution_profile`, 없으면 옛 phase 의 `model`, 그것도 없으면 규모별 기본 등급 |
| 하한  | 5-1 이 반환한 실행 형태의 최소 등급                                                |


**낮추는 방향은 없다.** 같은 등급이 없으면 더 엄격한 쪽으로만 올린다.
규모별 기본 등급 표와 실행 형태를 등급으로 옮기는 변환표는 같은 참조 문서가 소유한다.

**5-3. executor 를 스폰한다.** 이름은 `executor-p{N}` 이고, **등급을 스폰 시점에 명시 지정한다.**
생략했을 때 무엇이 적용되는지는 환경 설정이 정하므로 문서를 읽어서는 알 수 없다.
스폰 프롬프트에 [`references/role-executor.md`](references/role-executor.md) 절대경로를 읽으라고 지시하고,
「팀원 스폰 가드」 의 **cwd 격리** 와 **scope 확장 보고** 문구를 그대로 포함한다.

**5-4. executor 가 구현하고 검증한 뒤 `SendMessage` 로 보고한다.** executor 는 커밋하지 않는다.

**5-5. team-lead 가 그 phase 만 커밋한다.**
커밋 전 `git status` 로 staged 전체를 본다. executor 가 staging 해 둔 무관한 변경이 딸려올 수 있다.
섞였으면 `git reset` 후 명시적으로 add 하거나 경로를 한정해 커밋한다.

**5-6. team-lead 가 그 executor 를 `TaskStop` 으로 종료한다.** 종료를 확인한 뒤 다음 phase 로 간다.
한 executor 가 여러 phase 를 이어 받으면 앞 phase 의 판단이 뒤에 섞인다.
**종료를 빠뜨리면 phase 마다 executor 가 누적된다** (8-phase task 에서 팀원 8개 잔존 관측).

phase 가 실패하면 team-lead 가 원인을 분석한다.
phase 자체를 고쳐야 하면 4단계로 돌아가고, 단순 에러면 그 phase 를 다시 구현한다.

### 6. 누적 diff 를 두 검토자가 함께 본다

**모든 phase 가 끝난 뒤에 code-reviewer 와 docs-verifier 를 함께 스폰한다.**
phase 하나가 끝날 때마다 부르지 않는다. 검토 대상은 누적 diff 다.
두 검토는 서로의 입력이 아니라서 병렬로 돈다.
진행을 막는 결함의 원인 확인이 필요하면 조기 자문을 받을 수 있고, 그 결과가 최종 판정을 대체하지는 않는다.

**code-reviewer** 스폰 프롬프트에 [`references/role-code-reviewer.md`](references/role-code-reviewer.md) 절대경로와
반복 함정 목록 경로, 설계 맥락(의도한 raw 패턴, helper 우회 사유, 범위 밖 placeholder)을 담는다.

reviewer 보고 전체를 받아 team-lead 가 별도 패스로 셋으로 나눈다.

- 실제 결함 → 이것만 `FIX_NEEDED` 로 되돌린다.
- 의도된 설계 → 특이사항 4종에 합쳐 보고한다.
- 범위 밖 후속 → 특이사항 4종에 합쳐 보고한다.

**docs-verifier** 스폰 프롬프트에 [`references/role-docs-verifier.md`](references/role-docs-verifier.md) 절대경로를 담는다.
레포에 전용 docs-verifier 에이전트가 있으면 그 정의가 검증 항목의 단일 소스다.

판정별 다음 단계는 이렇다.


| 판정              | 다음                         | 한도  |
| --------------- | -------------------------- | --- |
| `PASS` 둘 다      | 7단계                        |     |
| `FIX_NEEDED`    | executor 재스폰 후 전체 재검사      | 2회  |
| `UPDATE_NEEDED` | docs 갱신 후 재검증              | 2회  |
| `VIOLATION`     | 코드 수정 (executor 재스폰) 후 재검증 | 2회  |


**리뷰 반영이 docs 를 건드렸으면 docs-verifier 를 다시 돌린다.** 바뀐 파일을 명시해 재요청한다.
코드만 건드렸으면 첫 판정을 그대로 쓴다. 재검증 횟수는 위 한도에 함께 계산한다.

### 7. 통합 검증, PR, 팀 종료

1. 누적 commit 을 검토한다. phase 별 commit 이 의도대로 들어갔는지, 마지막 phase commit 에 완료 마킹이 있는지 본다.
2. **통합 검증**: 오버레이나 레포 `CLAUDE.md` 의 검증 명령을 실행해 누적 후에도 통과하는지 확인한다.
3. **검증이 실패하면 책임을 가른다.** 실패 원인 파일과 이번 plan 의 변경 파일을 대조한다.
  - **plan 범위 내**: 본 plan 변경 파일에서 실패했다. executor 재스폰. 사용자 결정이 필요 없다.
  - **plan 범위 밖**: `git diff origin/main -- <파일>` 이 비어 있으면 main 자체가 깨진 것이다.
  아래 셋을 사용자에게 제시하고, 무엇을 골랐는지 PR 설명에 남긴다.
  이 PR 에 fix 를 흡수한다 / 별도 hotfix PR 을 만든 뒤 rebase 한다 / 그대로 PR 하고 설명에 의존 관계를 밝힌다.
4. **완료 마킹은 PR 브랜치 안에서만 한다.** 마지막 phase commit 에 포함하는 것이 가장 좋고, 브랜치 안 별도 commit 이 차선이다.
 **main 직접 커밋과 push 는 하지 않는다.** 진실의 출처가 둘로 갈라지고 push 충돌 위험이 있다.
5. push 후 PR 을 만들거나 갱신한다. base 는 `main`, head 는 plan 브랜치다.
 이 PR 하나에 **planning 의 docs 와 tasks 커밋, 구현 phase 커밋이 함께** 담긴다.
 제목과 본문 형식은 레포 컨벤션을 따르고, 기획 커밋과 phase 별 commit 을 구분해 나열한 뒤 「특이사항 및 후속」 절을 넣는다.
 PR diff 에 다른 plan 의 것이 섞였으면 브랜치 범위를 정리한 뒤 만든다.
6. **팀 종료**: 남아 있는 팀원 전부를 `TaskStop` 으로 종료하고 확인한다.
 대상은 `executor-p{N}`, `critic`, `code-reviewer`, `docs-verifier` 다.
7. **작업 공간 정리**: PR 생성과 원격 push 가 끝난 뒤에 한다.
  미커밋 변경과 로컬에만 있는 commit 이 없는지 먼저 확인한다. 정리 방법은 오버레이를 따른다.
8. 특이사항과 신규 노하우를 모아 보고한다. 첫 줄에 PR 번호와 리뷰 반영 명령을 적는다.
  작업 공간을 정리한 뒤라 cwd 브랜치가 `main` 이어서, 후속 스킬이 PR 을 자동으로 찾지 못한다.
  ```
   PR #<번호> 생성 완료: 리뷰 반영은 /review-fix <번호>
  ```

사용자가 PR 을 머지하면 완료 상태가 main 에 반영된다. 후속 작업은 없다.

## 팀원 스폰 가드

실제 사고를 겪고 굳어진 것이다. 상세 프롬프트 문구와 근거는
[`references/team-spawn.md`](references/team-spawn.md)가 소유한다. **팀원 스폰 전에 읽는다.**

- **이름을 붙여 스폰한다**: `critic`, `executor-p{N}`, `code-reviewer`, `docs-verifier`.
작업 공간이 둘 이상 동시에 돌면 이름에 plan 번호를 붙인다. 같은 이름을 쓰면 응답이 다른 쪽에 도착한다.
- **파일 참조는 작업 공간 절대경로로 준다**: 상대경로는 팀원 cwd 기준으로 풀려 main 의 구버전 파일을 가리킬 수 있다.
역할 계약 파일도 마찬가지다. 이 문서의 `references/...` 표기는 team-lead 가 읽을 때의 것이다.
- **회신을 `SendMessage` 로 강제한다**: 자기 화면에만 출력하면 team-lead 에 닿지 않는다.
- **지시 전 자발적 실행을 막는다**: 팀원이 먼저 실행하면 점검 시점 정합성이 깨진다.
- **idle 은 종료가 아니다**: 이름으로 `SendMessage` 하면 컨텍스트를 유지한 채 재개된다. 재스폰은 그 컨텍스트를 버린다.
- **executor cwd 격리**: main 워킹 디렉터리를 건드리면 main 이 origin 과 갈라진다. 작업 공간 경로만 쓴다.
- **executor scope 확장 보고**: task 범위 밖 수정을 자체 판단으로 넣으면 검토를 우회한다. 보고하고 승인을 받는다.
- **멈추면 작업을 다시 짠다**: 무거운 외부 상호작용에서 executor 가 멈춘다. 그 상호작용을 없애는 쪽으로 바꾼다.

## 특이사항 4종 집계

executor 가 phase 보고에 담는 4종(pre-existing, 신규 deprecation, 미검증, 범위 외 발견)은
[`references/role-executor.md`](references/role-executor.md)가 소유한다.

team-lead 는 종료 시 phase 별 특이사항을 누적해 사용자에게 보고하고, 후속이 필요하면 이슈 등록을 제안한다.

## 재사용 패턴 승격

실행이 끝나면 발견한 사건 중 아래를 모두 만족하는 것만 저장소의 반복 함정 문서로 승격한다.

- 다른 plan 이나 코드에서도 다시 일어날 수 있다.
- 원인과 회피 방법이 특정 사건을 떠나 일반화된다.
- `grep`, lint, test, build 처럼 구체적인 검출 방법이 있다.

1회성 오타, 특정 plan 의 상황 설명, 단순 실행 통계는 PR 본문과 결과 보고에만 남긴다.

누적 위치는 오버레이가 지정한다.


| 종류            | 누적 위치                    |
| ------------- | ------------------------ |
| 구현과 검토의 반복 함정 | 오버레이가 지정한 문서             |
| 프로세스 결함       | 이 SKILL.md               |
| 도메인 결정        | 레포 ADR                   |
| 코딩 규칙         | `CLAUDE.md`, `AGENTS.md` |


반복 함정 문서는 패턴 하나당 파일 하나로 둔다. 같은 패턴이면 기존 파일을 갱신한다.
오버레이가 위치와 형식을 지정하지 않으면 파일을 만들지 않고 결과 보고에만 남긴다.

작업 공간 정리 직전에 「이번 세션 누적 노하우」 를 1줄에서 3줄로 보고한다. 누적하지 않았으면 「신규 노하우 없음」 이라고 적는다.

## 재시도 한도

초과하면 `PHASE_BLOCKED` 로 사용자에게 결정을 넘긴다.


| 점검                                          | 한도  |
| ------------------------------------------- | --- |
| critic `REVISE`                             | 3회  |
| code-reviewer `FIX_NEEDED`                  | 2회  |
| docs-verifier `UPDATE_NEEDED` 와 `VIOLATION` | 2회  |


