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

**목표: planning 이 만든 `tasks/` 를 읽어 구현하고, 네 검토를 거쳐 PR 하나로 올린다.**

- 계획에 결함이 있으면 구현 전에 잡는다.
- 구현된 코드가 계획한 것과 같아야 한다.
- 코드가 `docs/` 에 적힌 결정과 어긋나지 않아야 한다.

team-lead 가 팀원 넷을 부른다. 각자의 판정 기준은 자기 문서가 소유한다.

| 팀원 | 목표 | 판정 | 기준 |
| --- | --- | --- | --- |
| **critic** | 대화를 보지 못한 사람이 phase 만 읽고 구현할 수 있는지 본다 | `APPROVE` / `REVISE` | `references/role-critic.md` |
| **executor** | 배정받은 phase 를 적힌 그대로 구현하고 테스트로 증명한다 | 완료 보고 | `references/role-executor.md` |
| **code-reviewer** | 구현이 계획과 같은지, 다음 사람이 고칠 수 있는지 본다 | `PASS` / `FIX_NEEDED` | `references/role-code-reviewer.md` |
| **docs-verifier** | 코드가 docs 의 결정을 어기지 않는지, docs 가 지금 코드를 말하는지 본다 | `PASS` / `UPDATE_NEEDED` / `VIOLATION` | `references/role-docs-verifier.md` |

**team-lead 는 조율, phase 단위 커밋, 검토 결과의 분류, PR 을 한다.**
구현과 검토는 규모와 무관하게 팀원에게 맡긴다.
자기 계획과 자기 구현을 같은 맥락에서 승인하면 결함이 드러나지 않는다.

**넷에 어느 에이전트를 쓸지는 오버레이가 지정한다.**
지정이 없으면 그 하네스에 설치된 것 중 역할에 맞는 범용 에이전트를 쓰고, 무엇을 골랐는지 실행 보고에 남긴다.
전용 에이전트가 있으면 그 정의가 위 기준 문서보다 우선한다.

## 레포 설정을 먼저 읽는다

레포 고유의 값은 아래 순서로 찾는다. 앞에서 찾으면 뒤를 보지 않는다.

1. `<repo-root>/.claude/build-with-teams-overlay.md`
2. `<repo-root>/CLAUDE.md`
3. 둘 다 없거나 그 값이 없으면 사용자에게 확인한다

| 무엇 | 쓰는 단계 |
| --- | --- |
| 통합 검증 명령 (lint, 타입 검사, 테스트, 빌드) | 6 |
| 브랜치 이름 형식, 작업 공간을 만들고 정리하는 방법 | 1, 2, 6 |
| 네 역할에 쓸 전용 에이전트 이름 | 3, 4, 5 |
| `index.json` 필드와 phase 파일 규격의 레포 변형 | 3 |
| 반복 함정 목록 경로 | 3, 5 |
| 커밋과 PR 컨벤션, 노하우 누적 위치 | 4, 6 |
| 의존성 설치와 환경 파일 준비 | 2 |

## 6단계 실행 절차

각 단계는 진입 시 해당 reference 를 읽고 수행한다. 통과 조건을 확인한 뒤 다음으로 간다.

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 재실행 방지 | `plan_precheck.py` 종료 코드 0, 또는 발견 사항에 대한 사용자 확정 | `scripts/plan_precheck.py` |
| 2 | 작업 공간 | plan 브랜치 위에 있고, main 과 분리됐고, 팀원에게 줄 절대경로가 있다 | 오버레이 |
| 3 | 계획 검토 | critic 이 `APPROVE` 와 phase 별 실행 형태를 함께 회신했다 | `references/role-critic.md` |
| 4 | phase 구현 | 모든 phase 가 커밋됐고 살아 있는 executor 가 없다 | `references/role-executor.md`, `references/executor-routing.md` |
| 5 | 누적 검토 | code-reviewer 와 docs-verifier 가 둘 다 `PASS` 다 | `references/role-code-reviewer.md`, `references/role-docs-verifier.md` |
| 6 | 마감 | 통합 검증이 통과했고 PR 이 있고 팀원이 남지 않았다 | `references/step-finish.md` |

**팀원을 스폰하기 전에 [`references/team-spawn.md`](references/team-spawn.md)를 읽는다.**
이름, 절대경로, 회신 강제, 재개가 거기 있다.

절차 어디서든 **결정 결과가 회수 비용이 크거나, 사용자 의도에 따라 갈리거나, plan 범위를 벗어나면**
옵션과 트레이드오프를 붙여 질문한다.
긴 자동 실행에서는 묻지 않고 진행하는 쪽을 고르기 쉽다.

### 1. 재실행 방지

plan 인자를 받으면 가장 먼저 돌린다.

```bash
python3 scripts/plan_precheck.py <plan> --repo <repo-root>
```

종료 코드는 0 통과, 1 사용자 결정 필요, 2 실행 불가다.
브랜치 이름이 task 디렉터리 이름과 다르면 `--branch` 로 넘긴다.

무엇을 이어서 하고 무엇을 새로 시작할지는 사용자가 정한다.

### 2. 작업 공간

만드는 방법은 오버레이가 소유한다. 이 스킬이 요구하는 것은 통과 조건 셋이다.

- **원격 plan 브랜치 위**: planning 의 docs 와 tasks 커밋이 그 위에 있어야 task 를 읽을 수 있고,
  구현 커밋이 같은 브랜치에 쌓여야 기획과 구현이 PR 하나에 담긴다.
- **main 과 분리**: executor 가 main 을 건드리면 main 이 origin 과 갈라진다.
- **절대경로 확보**: 상대경로는 팀원 cwd 기준으로 풀려 엉뚱한 파일을 가리킨다.

plan 브랜치가 원격 main 보다 뒤처졌으면 갱신할지 사용자에게 확인한다.
오래된 base 위에서 구현하면 그사이 머지된 docs 와 코드가 어긋난다.

### 3. 계획 검토

`index.json` 과 `phase-*.md`, 그것이 가리키는 docs 를 읽는다.
critic 을 스폰하고 호출 인자(task 파일 절대경로, 반복 함정 목록 경로)를 담는다.

회신 셋 중 **실행 형태가 없으면 재요청한다.** 4단계 판정의 입력이다.

발견 목록을 team-lead 가 셋으로 나눈다.

- 계획을 고쳐야 하는 것 → `REVISE` 로 되돌린다.
- 구현하며 챙기면 되는 것 → `critic minor notes` 로 executor 스폰 프롬프트에 넘긴다.
- 이번 plan 밖의 것 → 6단계 보고에 합친다.

### 4. phase 구현

`index.json` 의 미완료 phase 를 순서대로 돈다. **한 phase 마다 여섯을 반복한다.**

1. **실행 형태를 판정한다.** critic 회신과 직접 점검을 assessment JSON 으로 만들어 통과시킨다.
   차단하면 그 phase 에 착수하지 않는다.
   ```bash
   python3 scripts/executor_routing_gate.py <assessment.json>
   ```
2. **실행 등급을 정한다.** 출발값을 고르고 실행 형태의 최소 등급으로 끌어올린다. 낮추는 방향은 없다.
3. **executor 를 스폰한다.** 이름은 `executor-p{N}` 이고 **등급을 명시 지정한다.**
   생략했을 때 무엇이 적용되는지는 환경 설정이 정하므로 문서를 읽어서는 알 수 없다.
4. **executor 가 구현하고 검증한 뒤 회신한다.**
5. **team-lead 가 그 phase 만 커밋한다.** 커밋 전 `git status` 로 staged 전체를 본다.
   무관한 변경이 섞였으면 `git reset` 후 경로를 한정해 커밋한다.
6. **team-lead 가 그 executor 를 종료한다.** 확인한 뒤 다음 phase 로 간다.
   한 executor 가 여러 phase 를 이어 받으면 앞 phase 의 판단이 뒤에 섞인다.
   종료를 빠뜨리면 phase 마다 누적된다 (8-phase task 에서 팀원 8개 잔존 관측).
   에이전트가 한 번 쓰고 끝나는 하네스에서는 이 항목이 발동하지 않는다.

phase 가 실패하면 원인을 분석한다.
phase 자체를 고쳐야 하면 3단계로 돌아가고, 단순 에러면 그 phase 를 다시 구현한다.

### 5. 누적 검토

**모든 phase 가 끝난 뒤에 code-reviewer 와 docs-verifier 를 함께 스폰한다.**
검토 대상은 누적 diff 다. 두 검토는 서로의 입력이 아니라서 병렬로 돈다.

code-reviewer 스폰 프롬프트에 반복 함정 목록 경로와
설계 맥락(의도한 raw 패턴, helper 우회 사유, 범위 밖 placeholder)을 담는다.
그 맥락은 보고를 생략할 근거가 아니라 team-lead 가 분류할 때 쓰는 자료다.

code-reviewer 보고를 team-lead 가 별도 패스로 나눈다.
실제 결함만 `FIX_NEEDED` 로 되돌리고, 의도된 설계와 범위 밖 후속은 6단계 보고에 합친다.

| 판정 | 다음 |
| --- | --- |
| `FIX_NEEDED` | executor 재스폰 후 전체 재검사 |
| `UPDATE_NEEDED` | docs 갱신 후 재검증 |
| `VIOLATION` | 코드 수정 후 재검증. docs 를 고쳐 덮지 않는다 |

**리뷰 반영이 docs 를 건드렸으면 docs-verifier 를 다시 돌린다.** 바뀐 파일을 명시해 재요청한다.

재투입 요청에는 **어느 파일의 어느 라인이 어떻게 바뀌었는지**를 담는다.
회신이 직전 판정과 같으면 바뀐 실제 라인을 `grep` 으로 출력해 증거로 붙인다.
같은 지적이 반복되면 계획이 틀렸다는 신호이므로 `PHASE_BLOCKED` 로 사용자에게 넘긴다.

### 6. 마감

[`references/step-finish.md`](references/step-finish.md)를 읽고 수행한다.
통합 검증, 완료 마킹, PR, 팀 종료, 작업 공간 정리, 보고, 패턴 승격이 거기 있다.
