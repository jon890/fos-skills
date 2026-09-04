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

**목표: planning 이 만든 `tasks/` 를 읽어 구현하고, 검토를 거쳐 PR 을 만든다.**

- 계획에 결함이 있으면 구현 전에 찾아낸다.
- 구현된 코드가 계획한 것과 같아야 한다.
- 코드가 `docs/` 에 적힌 결정과 어긋나지 않아야 한다.

team-lead 가 팀원 넷을 부른다. 각자의 판정 기준은 자기 문서가 소유한다.

| 팀원 | 시점 | 검사 대상 | 판정 | 기준 |
| --- | --- | --- | --- | --- |
| **critic** | 구현 전 한 번 | plan 의 모든 phase | `APPROVE` / `REVISE` | `references/role-critic.md` |
| **executor** | phase 마다 | 배정받은 phase 하나 | 완료 보고 | `references/role-executor.md` |
| **code-reviewer** | 모든 phase 뒤 한 번 | 누적 diff 와 `tasks/` | `PASS` / `FIX_NEEDED` | `references/role-code-reviewer.md` |
| **docs-verifier** | 모든 phase 뒤 한 번 | 누적 diff 와 `docs/` | `PASS` / `UPDATE_NEEDED` / `VIOLATION` | `references/role-docs-verifier.md` |

**team-lead 는 조율, phase 단위 커밋, 검토 결과의 분류, PR 생성을 한다.**
구현과 검토는 규모와 무관하게 팀원에게 맡긴다.

**넷에 어느 에이전트를 쓸지는 오버레이가 지정한다.**
지정이 없으면 그 하네스에 설치된 에이전트 중 역할에 맞는 것을 쓰고, 무엇을 골랐는지 실행 보고에 남긴다.
전용 에이전트가 있으면 그 정의가 위 기준 문서보다 우선한다.

## 레포 설정

레포 고유의 값은 아래 순서로 찾는다. 앞에서 찾으면 뒤를 보지 않는다.

1. `<repo-root>/.claude/build-with-teams-overlay.md`
2. `<repo-root>/CLAUDE.md`
3. 두 파일이 다 없거나 찾는 값이 그 안에 없으면 사용자에게 확인한다

| 설정 값 | 쓰는 단계 |
| --- | --- |
| 통합 검증 명령 (lint, 타입 검사, 테스트, 빌드) | 6 |
| 브랜치 이름 형식, 작업 공간을 만들고 정리하는 방법 | 1, 2, 6 |
| 네 역할에 쓸 전용 에이전트 이름 | 3, 4, 5 |
| `index.json` 필드와 phase 파일 규격의 레포 변형 | 3 |
| 반복 함정 목록 경로 (기본값 `docs/pitfalls/`) | 3, 5 |
| 커밋과 PR 컨벤션, 노하우 누적 위치 | 4, 6 |
| 의존성 설치와 환경 파일 준비 | 2 |

## 실행 절차

각 단계는 진입 시 해당 reference 를 읽고 수행한다. 통과 조건을 확인한 뒤 다음으로 간다.

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 재실행 확인 | `plan_precheck.py` 종료 코드 0, 또는 발견 사항에 대한 사용자 확정 | `scripts/plan_precheck.py` |
| 2 | 작업 공간 준비 | 작업 공간이 plan 브랜치 위에 있고, main 워킹 디렉터리와 분리됐고, 팀원에게 줄 절대경로가 있다 | 오버레이 |
| 3 | 계획 검토 | critic 이 `APPROVE` 와 phase 별 실행 형태를 함께 회신했다 | `references/role-critic.md` |
| 4 | phase 구현 | 모든 phase 가 커밋됐고 남아 있는 executor 가 없다 | `references/role-executor.md`, `references/executor-routing.md` |
| 5 | 코드 리뷰와 문서 정합성 검토 | code-reviewer 와 docs-verifier 가 둘 다 `PASS` 다 | `references/role-code-reviewer.md`, `references/role-docs-verifier.md` |
| 6 | 통합 검증과 PR | 통합 검증이 통과했고 PR 이 있고 팀원이 남지 않았다 | `references/step-finish.md` |

**팀원을 스폰하기 전에 [`references/team-spawn.md`](references/team-spawn.md)를 읽는다.**

절차 어디서든 **결정 결과가 회수 비용이 크거나, 사용자 의도에 따라 갈리거나, plan 범위를 벗어나면**
옵션과 트레이드오프를 붙여 질문한다.

### 1. 재실행 확인

plan 인자를 받으면 가장 먼저 돌린다.
`<스킬 루트>` 는 하네스가 알려준 이 스킬의 base 디렉터리다. 절대경로로 적는다.

```bash
python3 <스킬 루트>/scripts/plan_precheck.py <plan> --repo <repo-root>
```

| 종료 코드 | 대응 |
| --- | --- |
| 0 | 2단계로 간다 |
| 1 | 출력한 발견 사항을 사용자에게 보여주고, 이어서 할지 새로 시작할지 확정받는다 |
| 2 | 출력한 원인을 해소하고 다시 돌린다. `gh` 인증 실패와 `index.json` 부재가 여기 해당한다 |

브랜치 이름이 task 디렉터리 이름과 다르면 `--branch` 로 넘긴다.

### 2. 작업 공간 준비

만드는 방법은 오버레이가 소유한다. 이 스킬이 요구하는 것은 아래와 같다.

- 원격 plan 브랜치 위에서 작업한다.
- main 워킹 디렉터리와 분리한다.
- 팀원에게 줄 절대경로를 확보한다.

plan 브랜치가 원격 main 보다 뒤처졌으면 갱신할지 사용자에게 확인한다.

### 3. 계획 검토

`index.json` 과 `phase-*.md`, 그것이 가리키는 docs 를 읽는다.
critic 을 스폰하고 호출 인자(task 파일 절대경로, 반복 함정 목록 경로)를 담는다.
**plan 의 모든 phase 를 한 번에 넘긴다.**

회신에 **실행 형태가 없으면 재요청한다.**

발견 목록을 team-lead 가 아래로 나눈다.

- 계획을 고쳐야 하는 것 → `REVISE` 로 되돌린다.
- 구현하며 챙기면 되는 것 → `critic minor notes` 로 executor 스폰 프롬프트에 넘긴다.
- 이번 plan 밖의 것 → 마감 단계 보고에 합친다.

`APPROVE` 를 받으면 **plan 규모를 한 번 판정한다.**
[`references/executor-routing.md`](references/executor-routing.md)의 규모별 기본 등급 표에서 고르고,
그 값을 phase 구현 단계의 등급 출발값으로 쓴다.

### 4. phase 구현

`index.json` 의 `current_phase` 부터 마지막 phase 까지 순서대로 돈다.
**한 phase 의 작업 순서는 다음과 같다.**

1. **실행 형태를 판정한다.** 3단계에서 받은 critic 의 그 phase 판정과 team-lead 직접 점검 중
   더 엄격한 쪽을 고른다. `HIGH_RISK` 차단 조건에 걸리거나 근거가 부족하면 실행 형태를 한 단계 더 올린다.
2. **실행 등급을 정한다.** 출발값을 고르고 실행 형태의 최소 등급까지 끌어올린다. 등급을 낮추는 방향은 없다.
3. **executor 를 스폰한다.** 이름은 `executor-p{N}` 이고 **등급을 명시 지정한다.**
   호출 인자로 phase 파일 절대경로, **1항에서 정한 실행 형태**, `critic minor notes` 를 담는다.
4. **executor 가 구현하고 검증한 뒤 회신한다.**
5. **team-lead 가 그 phase 만 커밋한다.** 커밋 전 `git status` 로 staged 전체를 본다.
   무관한 변경이 섞였으면 `git reset` 후 경로를 한정해 커밋한다.
6. **커밋 후 그 phase 의 executor 를 정리한다.**

phase 가 실패하면 원인을 분석한다.
phase 자체를 고쳐야 하면 3단계로 돌아가고, 단순 에러면 그 phase 를 다시 구현한다.

### 5. 코드 리뷰와 문서 정합성 검토

**모든 phase 가 끝난 뒤에 code-reviewer 와 docs-verifier 를 함께 스폰한다.** 두 검토는 병렬로 돈다.

스폰 프롬프트에 담을 것이다.

- code-reviewer: 반복 함정 목록 경로
- docs-verifier: 오버레이가 추가한 문서 경로

**의도한 설계를 미리 알려주지 않는다.**

| 판정 | 누가 고치나 | 다음 |
| --- | --- | --- |
| `FIX_NEEDED` | 그 phase 의 executor 를 다시 띄운다 | 전체 재검사 |
| `UPDATE_NEEDED` | team-lead 가 docs 를 고친다 | 재검증 |
| `VIOLATION` | 그 phase 의 executor 를 다시 띄운다 | 재검증 |

**재스폰 등급은 그 phase 의 원래 등급을 그대로 쓴다.** 실행 형태가 올라갔으면 그 하한을 따른다.
이 단계의 수정은 **검토 반영 커밋 하나로 묶는다.** phase 커밋과 구분되게 메시지에 밝힌다.

code-reviewer 회신의 「team-lead 가 정할 것」 목록에서 무엇을 고칠지 team-lead 가 정한다.
고치지 않기로 한 것은 6단계 보고에 남긴다.

**리뷰 반영이 docs 를 건드렸으면 docs-verifier 를 다시 돌린다.** 바뀐 파일을 명시해 재요청한다.

재투입 요청에는 **어느 파일의 어느 라인이 어떻게 바뀌었는지**를 담는다.
회신이 직전 판정과 같으면 바뀐 실제 라인을 `grep` 으로 출력해 증거로 붙인다.

같은 지적이 반복되면 계획이 틀렸다는 신호다. 절차를 멈추고 사용자에게 넘긴다.

```text
PHASE_BLOCKED: <phase NN 또는 단계 이름>
반복된 지적: <무엇이 몇 번 같게 돌아왔는지>
지금까지 한 것: <커밋된 phase 와 반영한 수정>
필요한 결정: <사용자가 정해야 하는 것>
```

phase 파일의 「Blocked 조건」 에 걸려 executor 가 같은 값을 회신했을 때도 같은 형식으로 올린다.

### 6. 통합 검증과 PR

[`references/step-finish.md`](references/step-finish.md)를 읽고 수행한다.
통합 검증, 완료 마킹, PR, 팀 종료, 작업 공간 정리, 보고, 패턴 승격이 거기 있다.
