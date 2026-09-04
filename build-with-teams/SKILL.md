---
name: build-with-teams
description: 팀 기반 구현 자동화 공용 코어 skill. planning 이 만든 task(index.json, phase 파일)를 읽고 plan 1개를 단일 브랜치·단일 PR로 완료한다. 계획(team-lead) → 평가(critic) → 실행(executor) → 검토(code-reviewer) → 정합성 검증(docs-verifier) 파이프라인으로 phase 를 순차 처리하고 phase 단위 atomic commit 과 PR 까지 완료한다. "/build-with-teams", "build-with-teams", "agent team 으로 빌드", "teams 로 phase 실행", "critic 평가", "docs-verifier 검증", "task 실행해줘", "phase 실행" 같은 요청 시 반드시 이 스킬 사용. 레포별 특화(빌드/검증 명령·브랜치 규칙·에이전트 이름·스키마 세부·커밋 컨벤션)는 레포 오버레이·CLAUDE.md 로 주입된다.
metadata:
  version: "4.4.0"
---
# build-with-teams

**이 문서의 `scripts/`, `references/`, `assets/` 는 이 스킬 번들 기준 상대경로다.**
하네스가 알려주는 스킬 base 디렉터리에 붙여 쓴다. 설치 위치를 가정하지 않는다.

planning 이 만든 task(`index.json`, `phase-*.md`)를 팀 기반 파이프라인으로 실행하는 시스템.
team-lead 가 팀원(critic·executor·code-reviewer·docs-verifier)을 조율해 phase 를 순차 실행한다.
phase 단위로 atomic commit 을 쌓아 PR 까지 만든다.

## 레포 오버레이 로딩 (첫 단계)

작업 시작 시, 현재 레포에 오버레이 파일이 있으면 **먼저 읽고** 그 지시를 코어보다 우선한다.

- 경로: `<repo-root>/.claude/build-with-teams-overlay.md`
- 오버레이가 정의하는 것:
  - **통합 검증 명령**: lint/타입검사/테스트/빌드 명령 (레포 CLAUDE.md 에 있으면 그쪽 참조).
  - **브랜치 규칙**: 작업 브랜치 이름 형식, planning 이 브랜치를 미리 만드는지 여부, worktree 루트 경로.
  - **에이전트 이름**: executor·docs-verifier 로 쓸 전용 에이전트 (레포마다 다름).
  - **task 스키마 세부**: `index.json` 필드·phase 파일 규격 (planning 의 task-create 규격과 레포 변형).
  - **반복 함정 목록 경로**: critic·code-reviewer 가 사전 해소를 점검할 패턴 파일 위치.
  - **커밋·PR 컨벤션**: 커밋 메시지 형식, PR 제목 형식, 노하우 누적 위치.
  - **환경 setup**: worktree 생성 후 의존성 설치·환경 파일 준비 절차.
- 오버레이가 **없으면** 레포 `CLAUDE.md` 참조로 동작한다. CLAUDE.md 에도 근거가 없으면 사용자에게 확인한다.

## 사전 검증 (재실행 방지)

plan 인자를 받으면 **가장 먼저** 재실행 사고를 막는 3중 검증을 수행한다. 하나라도 걸리면 사용자에게 알리고 실행을 차단한다: 사용자 확인 전에는 진행하지 않는다.

1. **plan 브랜치와 task 존재**: 원격 `plan{N}-<slug>` 브랜치가 있는지, 그 브랜치에 task 디렉터리(`index.json`)가 있는지 본다. 있으면 완료 상태 필드를 확인한다.
  - **브랜치 부재** → planning 을 먼저 호출할지 사용자에게 확인.
  - **브랜치는 있는데 task 부재** → planning 이 중단됐거나 push 가 안 된 상태다. planning 재호출이 아니라 **그 브랜치의 상태를 사용자에게 보여주고 결정**을 받는다.
  - 완료 상태 → 아래 4번(정합 검증)으로.
2. **plan 브랜치의 구현 커밋 존재**: 브랜치에 기획 커밋 외에 **phase 구현 커밋이 이미 쌓여 있는지** 본다.
  planning 이 브랜치를 만들어 push 하므로 **브랜치 존재 자체는 재실행 신호가 아니다.** 2·3번이 그 창을 덮는다.
3. **오픈 PR 존재**: 해당 plan 제목·브랜치를 포함한 오픈 PR 이 있는지 확인한다. 있으면 완료 후 머지 대기일 수 있으니 차단 후 사용자 결정.
4. **완료 상태 ↔ 머지 정합**(역방향): 완료로 표기됐는데 실제 머지 커밋이 원격 main 에 없으면 마킹 사고. 사용자에게 알리고 상태를 되돌릴지 결정.

아래는 오버레이가 지정한다.

- 브랜치 이름 형식
- task 디렉터리 매칭(정확 일치 / 슬러그 suffix / fuzzy)
- 이어서 작업(옵션 A) vs 새로 시작(옵션 B) 분기 정책

구체 검증 명령(`git ls-remote`, `gh pr list`, `jq .status` 등)은 레포 브랜치 규칙에 맞춰 조립한다.

## 실행 모드 (사전 검증 통과 직후)

team-lead 가 task 규모를 보고 구현을 위임할지 스스로 정한다. 사용자가 모드를 명시했으면 그것을 따른다.


| 모드                  | 구현                              | 규모                          |
| ------------------- | ------------------------------- | --------------------------- |
| **A. 정식 팀 흐름**      | executor 를 spawn 해 phase 를 위임한다 | 대 (아키텍처 / 스키마 대규모 / 신규 도메인) |
| **B. team-lead 구현** | executor 없이 team-lead 가 직접 구현한다 | 소·중 (버그 / 기존 기능 확장)         |


**구현자**: 이 문서에서 구현 주체를 가리키는 말이다. 모드 A 는 executor, 모드 B 는 team-lead 다.
구현자를 주어로 쓴 지시는 두 모드에 적용되고, `executor` 를 주어로 쓴 것은 모드 A 전용이다.

**모드가 가르는 것은 구현 위임 여부뿐이다.**
critic·code-reviewer·docs-verifier 스폰은 두 모드 모두에서 필수다.
계획 평가와 사후 검토를 규모로 깎지 않는다: 같은 세션이 자기 계획과 자기 구현을 그대로 승인하면 결함이 드러나지 않는다.
프론티어 모델도 여기서는 자기 맥락에 갇힌다.
스폰이 환경 제약으로 실패하면 그 사실과 대체 검증 근거를 실행 보고에 남긴다.

## 팀 구성 (역할: 에이전트 이름은 오버레이가 지정)


| 역할                | 에이전트                             | 책임                                                                                             |
| ----------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| **team-lead**     | main session                     | 계획 수립, task 검토, 팀 조율, phase 단위 atomic commit, 최종 push/PR                                       |
| **critic**        | `oh-my-claudecode:critic`        | 계획 평가 (APPROVE/REVISE), 실제 코드 대조                                                               |
| **executor**      | 레포의 executor 에이전트                | phase 순차 실행, 코드 수정 (커밋 제외), `bypassPermissions`. **모드 A 에서만 스폰**: 모드 B 는 team-lead 가 구현자를 겸한다 |
| **code-reviewer** | `oh-my-claudecode:code-reviewer` | 코드 품질 검사 (PASS/FIX_NEEDED), 금지 패턴 탐지                                                           |
| **docs-verifier** | 레포의 docs-verifier 에이전트           | 코드와 docs 정합성 검증 (PASS/UPDATE_NEEDED/VIOLATION)                                                 |


executor·docs-verifier 이름은 오버레이가 지정한다.
전용 에이전트가 도메인 지식을 보유하므로, spawn 프롬프트에는 호출 인자(task 파일 절대경로·직전 phase 학습·critic minor notes)만 담고 도메인 규칙을 반복하지 않는다.

### 팀원 스폰 가드 (요약)

팀원(critic·executor·code-reviewer·docs-verifier)을 스폰·통신할 때 실제 사고를 겪고 굳어진 가드가 있다.
모드 B 도 critic·code-reviewer·docs-verifier 를 스폰하므로 대부분 그대로 발동한다.
**구현자** 로 시작하는 둘은 모드 B 에서 team-lead 자신에게 적용된다.

- **`name` 지정 스폰이 1순위**: 이름 없는 subagent 는 환경 제약으로 실패했을 때만 쓰는 폴백이고, 내려갔으면 실행 보고에 남긴다.
- **worktree 절대경로**: 팀원에게 주는 파일 참조는 상대경로가 아니라 worktree 절대경로로 준다. 상대경로는 main 의 구버전 파일을 가리킬 수 있다.
- **SendMessage 회신 강제**: 자기 화면 출력만 하고 종료하면 team-lead 에 결과가 안 닿는다. 스폰 프롬프트에 회신 의무를 명시한다.
- **자발적 실행 방지**: team-lead 지시 전 팀원이 먼저 실행·검증을 시작하면 점검 시점 정합성이 깨진다.
- **팀원 재개**: idle 은 종료가 아니다. 이름으로 `SendMessage` 하면 컨텍스트를 유지한 채 재개된다: 재스폰하지 않는다.
- **구현자 cwd 격리**: main 워킹 디렉터리를 직접 건드리면 main 이 origin 과 갈라진다: worktree 경로만 쓴다. 모드 B 에서 위험이 더 크다.
- **구현자 scope 확장 보고**: task 범위 외 수정을 자체 판단으로 추가하면 검토를 우회한다. 모드 B 는 자기 승인이 되므로 사용자에게 확인한다.
- **watchdog stall 복구**: 무거운 외부 상호작용에서 멈추면 그 상호작용을 없애는 쪽으로 작업을 다시 짠다.
  워치독은 모드 A 에만 있지만 회피 원칙은 모드 B 에서도 같다.
- **역할 계약 파일은 절대경로로 준다**: 팀원에게 역할 계약을 읽히려면
  하네스가 알려준 이 스킬 base 디렉터리에 `references/<역할>.md` 를 붙여 절대경로로 지시한다.
  아래 본문의 상대경로 표기는 team-lead 가 읽을 때의 것이고, 그대로 넘기면
  팀원 cwd(worktree·main repo) 기준으로 풀려 없는 파일이 된다.

상세 프롬프트 문구와 근거는 [`references/team-spawn.md`](references/team-spawn.md) 참조: **팀원 스폰 전 반드시 읽는다**.

## worktree 기반 격리 실행

worktree 위치는 저장소별 설정을 따른다.

1. 오버레이가 worktree root를 지정하면 그 값을 쓴다.
2. Orca CLI를 사용할 수 있고 등록된 repo의 `worktreeBasePath`가 있으면
   `orca repo show --repo path:<repo-root> --json`으로 읽어 그 값을 쓴다.
   상대경로는 repo root 기준으로 해석한다.
3. 둘 다 없으면 `<repo-root>/worktrees`를 기본값으로 쓴다.

target은 `<resolved-worktree-base>/<repo-name>/<plan-branch>`로 만들고,
resolved worktree base가 저장소 안이면 그 경로가 `.gitignore`에 있어야 한다.
`.claude/worktrees`나 임의의 `/tmp` 경로를 폴백으로 만들지 않는다.

- **base**: worktree 는 **원격 `plan{N}-<slug>` 브랜치 기반**으로 분기한다.
  - planning 의 docs·tasks 커밋이 그 위에 있어야 task 를 읽을 수 있다.
  - 구현 커밋이 같은 브랜치에 쌓여 PR 1개로 닫힌다.
- **base 신선도**: plan 브랜치가 원격 main 보다 뒤처졌으면 worktree 분기 전에 갱신한다.
  - 방법: `git rebase origin/main` 후 `git push --force-with-lease`.
  - 오래된 base 위에서 구현하면 그사이 머지된 docs 와 코드가 어긋난다.
  - PR 이 아직 없는 시점이라 rebase 로 잃을 것이 없다.
- **환경 setup**: worktree 생성 후 의존성 설치·환경 파일 준비는 오버레이 절차를 따른다.

정리 시점·위치와 브랜치 보존은 7단계 7항이 소유한다.

## 실행 절차

절차 어디서든 **결정 결과가 (a) 회수 비용이 크거나 (b) 사용자 의도·스타일에 따라 갈리거나
(c) plan scope 를 벗어나면** 옵션과 트레이드오프를 붙여 질문한다.
긴 자동 실행에서는 완료 압력이 걸려 이 판단이 "일단 진행" 쪽으로 기운다.

```
[사전 검증 3중: plan 브랜치·task + 구현 커밋 유무 + 오픈 PR (+ 완료↔머지 정합)]
    → [실행 모드 결정: A executor 위임 / B team-lead 구현]
    → [메인 워킹 트리 사전 점검]
    → [worktree 생성 (원격 plan{N} 브랜치 기반) + 레포 환경 setup]
    → [task 파악: plan 하나 선택, index.json 정합 확인]
    → [critic 평가] ←─ REVISE 면 수정 후 재평가 (한도 3회)
    → [phase 별 실행 형태 점검: BOUNDED / JUDGMENT_REQUIRED / HIGH_RISK]
    → [모든 phase 구현: 검증·atomic commit] ←─ 실패 시 원인 분석 후 해당 phase 재실행
    → [누적 diff 검토: code-reviewer 와 docs-verifier 를 병렬 스폰]
        ├─ code-reviewer: 전부 보고 후 team-lead 필터 ←─ FIX_NEEDED 면 재투입 후 전체 재검사 (한도 2회)
        └─ docs-verifier: 정합성 판정 ←─ VIOLATION/UPDATE_NEEDED 면 재투입 후 재검증 (한도 2회)
    → [리뷰 반영이 docs 를 바꿨으면 docs-verifier 재검증]
    → [통합 검증: 실패 시 plan 범위 내/외 분기]
    → [team-lead 일괄 push (완료 마킹은 PR 브랜치 안)]
    → [PR 생성·갱신]
    → [팀 shutdown + worktree 정리 + 특이사항 집계 보고]
    → (사용자 PR 머지 → 완료 상태 자동 main 반영, 후속 0개)
```

### 1. critic 스폰

**이 단계가 하는 일은 critic 을 `name` 지정으로 스폰하는 것 하나다.**
팀은 세션 시작 시 자동으로 구성되므로 따로 만들지 않는다.

critic 은 idle 로 대기하다 3단계에서 이름으로 부른다.
code-reviewer·docs-verifier 는 검토 시점(5·6단계)에 **둘을 함께** 스폰한다.

### 2. task 파악

team-lead 가 task(`index.json`, `phase-*.md`)와 관련 docs·`CLAUDE.md`·오버레이를 읽는다.

### 3. critic 평가 (통과 조건)

team-lead → critic 에게 계획 전송.
스폰 프롬프트에 [`references/role-critic.md`](references/role-critic.md)를 읽으라고 지시하고
호출 인자(task 파일 절대경로, 반복 함정 목록 경로)만 담는다.

회신은 **판정 / phase 별 실행 형태 / 발견 목록** 셋으로 나뉘어 온다.
셋 중 실행 형태가 없으면 재요청한다: 4단계 점검의 입력이다.

발견을 무엇으로 처리할지는 team-lead 가 정한다.

- 계획을 고쳐야 하는 것 → REVISE 로 되돌린다.
- 구현하며 챙기면 되는 것 → `critic minor notes` 로 구현자에게 넘긴다 (모드 A 는 스폰 프롬프트에, 모드 B 는 phase 착수 메모에).
- 이번 plan 밖의 것 → 특이사항 4종에 합쳐 보고한다.

판정: **APPROVE** → 4단계. **REVISE** → 수정 후 재평가 (한도 3회).

**재평가 요청에는 변경 파일 절대경로와 어느 라인이 어떻게 바뀌었는지를 담는다.** 회신이 직전 판정과 같으면
수정된 실제 라인을 `grep` 으로 떠서 증거로 붙여 재요청한다.
code-reviewer·docs-verifier 재검사도 같다.

### 4. 구현

critic APPROVE 후 구현에 들어간다. 모드 A 는 executor 를 `run_in_background: true`, `mode: "bypassPermissions"` 로 스폰하고, 모드 B 는 team-lead 가 직접 구현한다.
아래 실행 형태 점검과 phase 단위 커밋·검증 규칙은 두 모드에 같이 적용한다: 구현 주체만 다르고 통과 조건은 같다.

각 phase 착수 직전에 [`references/executor-routing.md`](references/executor-routing.md)의 적합성 점검을 실행한다.
team-lead는 critic 회신과 직접 점검 결과를 assessment JSON으로 만들고 `scripts/executor_routing_gate.py`를 통과시킨다.
스크립트가 차단하면 그 phase 에 착수하지 않는다.

판정을 무엇으로 집행할지는 모드마다 다르다.

- **모드 A**: 반환된 실행 형태보다 낮은 role 로 executor 를 스폰하지 않는다.
  같은 수준의 role 이 없으면 더 엄격한 쪽으로만 올린다: 내려서 스폰하지 않는다.
- **모드 B**: team-lead 가 직접 구현해도 되는지를 가른다.
  전환 조건과 절차, 실행 형태를 등급으로 옮기는 변환표는
  [`references/executor-routing.md`](references/executor-routing.md)가 소유한다.

실행 보고에 남길 항목과 실행 중 승격 처리는 같은 참조 문서를 따른다.

이 단계는 `index.json`의 **모든 미완료 phase를 순서대로 구현·검증·atomic commit할 때까지 반복**한다.
개별 phase 완료는 commit 경계이지 code-reviewer·docs-verifier 호출 경계가 아니다.
code-reviewer와 docs-verifier는 모든 phase 구현이 끝난 누적 diff를 검증한다.
단 진행을 막는 결함의 원인 확인이 필요하면 조기 자문을 받을 수 있고, 그 결과가 최종 판정을 대체하지는 않는다.

구현 계약은 [`references/role-executor.md`](references/role-executor.md)가 소유한다.
모드 A 는 스폰 프롬프트에서 그 파일을 읽게 하고, 모드 B 는 team-lead 가 직접 따른다.

**모드 A 전용**: 스폰이 있을 때만 발동한다.

- **phase 단위 spawn → shutdown 사이클** (4개 이상 phase 에서 필수)
  - 3 phase 이하는 executor 를 한 번만 스폰해 재사용한다 (다음 phase 는 `SendMessage` 로 지시).
  모드 B 에서 전환된 phase 처럼 모드 A 가 소규모로 켜지는 경우가 여기 해당한다.
  - 한 phase 완료·커밋 후 그 executor 를 **반드시 종료한 뒤** 다음 phase 를 새 이름(`executor-p{N}`)으로 스폰한다.
  - 이유: 컨텍스트를 분리하고, 이름 충돌과 auto-deliver 누락을 피한다.
  - 종료 방법: `SendMessage({to, message:{type:"shutdown_request"}})` 또는 `TaskStop`. 종료를 확인한 뒤 다음 executor 를 스폰한다.
  - **종료를 빠뜨리면 phase 마다 executor 가 누적된다** (8-phase task 에서 팀원 8개 잔존 관측). 다음 스폰 직전에 이전 executor 종료를 매 phase 강제한다.
- **커밋은 team-lead 가 한다**: executor 는 커밋하지 않고 완료·실패를 `SendMessage` 로 보고한다.
- "팀원 스폰 가드" 의 **구현자 cwd 격리** 와 **구현자 scope 확장 보고** 문구를 스폰 프롬프트에 그대로 포함한다.

**phase 단위 atomic commit**: 한 phase 완료·검증 후 team-lead 가 그 phase 만 commit 한다.

- commit 전 `git status` 로 staged 전체를 점검해 관심사가 섞이지 않게 한다.
- 모드 A 에서 executor 가 staging 해 둔 무관한 변경이 딸려올 수 있다. 섞였으면 `git reset` 후 명시적으로 add 하거나 경로를 한정해 commit 한다.

**phase 실패 시**

phase 가 실패하면 team-lead 가 원인을 분석한다.
phase 자체를 고쳐야 하면 critic 재평가(3단계)로 돌아가고, 단순 에러면 그 phase 를 다시 구현한다.
모드 A 는 executor 보고로 실패를 받고 재실행을 지시한다. 모드 B 는 team-lead 가 검증 실패를 직접 확인한다.

### 5. 코드 품질 검사 (code-reviewer)

모든 phase 의 구현·검증·atomic commit 이 끝난 뒤, team-lead 가 code-reviewer 를 새로 스폰해 누적 구현 전체 검사를 지시한다.
6단계 docs-verifier 도 같은 시점에 함께 스폰한다: 두 검토는 병렬로 돈다.
team-lead 가 직접 검사하지 않는다: 건너뛰기를 막기 위해서다.

스폰 프롬프트에 [`references/role-code-reviewer.md`](references/role-code-reviewer.md)를 읽으라고 지시하고
반복 함정 목록 경로와 설계 맥락(의도한 raw 패턴, helper 우회 사유, 범위 밖 placeholder)을 담는다.

**필터는 team-lead 의 별도 패스**: reviewer 보고 전체를 받아 셋으로 분류한다.

- (a) 실제 결함: 이것만 `FIX_NEEDED` 로 되돌린다.
- (b) 의도된 설계
- (c) 범위 밖 후속

(b)·(c) 는 특이사항 4종에 합쳐 보고한다.

판정: **PASS** → 7단계. **FIX_NEEDED** → 구현자 재투입 후 재검사 (한도 2회. 모드 A 는 executor 재스폰, 모드 B 는 team-lead 직접 수정).
리뷰 반영이 docs 를 바꿨으면 6단계의 docs-verifier 재검증도 함께 건다.

### 6. docs-verifier 검증

모든 phase 구현이 끝난 뒤 docs-verifier 를 스폰해 정합성을 판정한다.
**5단계 code-reviewer 와 병렬로 돌린다**: 두 검토는 서로의 입력이 아니라서 순서에 의존하지 않는다.

병렬 실행의 유일한 대가는 재검증이다. code-reviewer 지적이 docs 를 바꾸면 docs-verifier 판정이 낡으므로 한 번 더 돌린다.
그래서 team-lead 는 code-reviewer 판정을 받은 시점에 재검증 필요 여부를 가른다.

- 리뷰 반영이 docs 를 건드렸으면 → docs-verifier 재검증. 바뀐 파일을 명시해 재요청한다.
- 코드만 건드렸으면 → 첫 판정을 그대로 쓴다.
- 재검증 횟수는 아래 한도에 함께 계산한다.

스폰 프롬프트에 [`references/role-docs-verifier.md`](references/role-docs-verifier.md)를 읽으라고 지시한다.
레포에 전용 docs-verifier 에이전트가 있으면 그 정의가 검증 항목의 단일 소스다.

판정: **PASS** → 7단계. **UPDATE_NEEDED** → docs 업데이트 후 재검증 (한도 2회). **VIOLATION** → 코드 수정 (구현자 재투입, 한도 2회).

### 7. 완료, PR 생성, 팀 종료

1. team-lead 가 누적 commit 을 검토한다: phase 별 commit 이 의도대로 들어갔는지, 마지막 phase commit 에 완료 마킹이 포함됐는지 확인.
2. **통합 검증**: 레포 CLAUDE.md·오버레이의 검증 명령을 실행해 모든 phase 누적 후에도 통과하는지 확인한다.
3. **검증 실패 시 분기**(필수): 실패 원인 파일과 변경 파일을 매칭해 책임을 분류한다. 자의적으로 plan PR 에 외부 잔존 깨짐 fix 를 흡수하지 않는다.
  - **plan 범위 내**: 본 plan 변경 파일에서 실패 → 구현자 재투입. 사용자 결정 불필요.
  - **plan 범위 밖**: 실패 원인이 변경하지 않은 파일에 있다 (`git diff origin/main -- <파일>` 이 비어 있으면 main 자체가 깨진 것).
  사용자에게 세 가지를 제시하고, 무엇을 골랐는지 PR 설명에 남긴다.
    - A: 이 PR 에 fix 를 흡수한다.
    - B: 별도 hotfix PR 을 만든 뒤 rebase 한다.
    - C: 그대로 PR 하고 설명에 의존 관계를 밝힌다.
4. **완료 마킹은 PR 브랜치 안에서만**: 마지막 phase commit 에 포함하는 것이 가장 좋고, 브랜치 안 별도 commit 이 차선이다.
 **main 직접 커밋·푸시는 금지**한다. 진실의 출처가 둘로 갈라지고 push 충돌 위험이 있다.
 재실행 방지는 사전 검증이 담당하므로 main 을 건드릴 이유가 없다.
5. push 후 PR 생성·갱신 (오픈 PR 없으면 신규, 있으면 갱신). base 는 `main`, head 는 `plan{N}-<slug>` 다.
 이 PR 하나에 **planning 의 docs·tasks 커밋과 구현 phase 커밋이 함께** 담긴다: 기획부터 구현까지가 하나의 완결된 변경으로 남는다.
 PR 제목·body 형식은 레포 커밋 컨벤션을 따르고, 기획 커밋과 phase 별 commit 을 구분해 나열한 뒤 "특이사항 및 후속" 섹션을 포함한다.
 PR diff 에 다른 plan 의 task 나 구현이 섞였으면 브랜치 범위를 정리한 뒤 생성한다.
6. **팀 종료**: 남아 있는 팀원 전부에 `shutdown_request`(또는 `TaskStop`)를 보내고 종료를 확인한다.
 대상은 `executor`·`executor-p{N}`·`critic`·`code-reviewer`·`docs-verifier` 다.
 phase 단위 사이클에서 종료되지 않은 executor 가 있으면 여기서 일괄 정리한다.
7. **worktree 정리**: PR 생성·갱신과 원격 push 가 끝난 뒤에 한다.
  - worktree 가 깨끗하고 로컬에만 있는 commit 이 없는지 확인한다.
  - 제거 대상 worktree 내부를 cwd 로 둔 채 실행하지 않는다. 기본 checkout 이나 다른 안전한 cwd 로 옮긴 뒤 `git worktree remove <절대경로>` 를 실행한다.
  - `git worktree list` 로 제거를 확인한다. 잠긴 worktree 나 미커밋 변경이 있으면 remove 가 실패하는데, 확인하지 않으면 그 실패가 묻힌다.
8. 특이사항과 신규 노하우를 모아 사용자에게 보고한다.
 보고 첫 줄에 **PR 번호와 리뷰 반영 명령**을 적는다.
 worktree 를 정리한 뒤라 cwd 브랜치가 `main` 이어서, 후속 스킬이 PR 을 자동으로 찾지 못하기 때문이다.
  ```
   PR #<번호> 생성 완료: 리뷰 반영은 /review-fix <번호>
  ```
9. 사용자가 PR 을 머지하면 완료 상태가 main 에 자동 반영된다.

## 특이사항 4종 집계 (필수)

구현자가 phase 보고에 담는 4종(pre-existing·신규 deprecation·미검증·범위 외 발견)은
[`references/role-executor.md`](references/role-executor.md)가 소유한다.
모드 B 는 team-lead 가 phase 커밋 시점에 스스로 기록한다.

team-lead 는 종료 시 phase 별 특이사항을 누적해 사용자에게 명시 보고하고, 후속이 필요하면 이슈 등록을 제안한다.

## 재사용 패턴 승격

실행이 끝나면 발견한 사건 중 다음 조건을 모두 만족하는 것만 저장소의 반복 함정 문서로 승격한다.

- 다른 plan이나 코드에서도 다시 일어날 수 있다.
- 원인과 회피 방법이 특정 사건을 떠나 일반화된다.
- `grep`·lint·test·build처럼 구체적인 검출 방법이 있다.

1회성 오타, 특정 plan의 상황 설명, 단순 실행 통계와 원시 사건 기록은 문서로 누적하지 않는다.
이번 실행의 PR 본문과 결과 보고에만 남긴다.

누적 위치는 오버레이가 지정한다.


| 종류           | 누적 위치                   |
| ------------ | ----------------------- |
| 구현·검토 반복 함정 | 오버레이가 지정한 `docs/pitfalls/` 계열 문서 |
| 프로세스 결함      | 이 SKILL.md 의 해당 섹션      |
| 도메인 결정       | 레포 ADR                  |
| 코딩 규칙        | `CLAUDE.md`·`AGENTS.md` |

반복 함정 문서는 패턴 하나당 파일 하나로 둔다.
같은 패턴이면 기존 파일을 갱신하고, 별개 패턴일 때만 새 파일을 만든다.
오버레이가 누적 위치와 형식을 지정하지 않으면 파일을 만들지 않고 결과 보고에만 남긴다.

PR 생성 후 worktree 정리 직전, 사용자에게 "이번 세션 누적 노하우" 를 1-3줄 보고한다. 누적 안 했으면 "신규 노하우 없음" 으로 명시한다.

## 재시도 한도

무한 루프를 막기 위해 각 점검에 한도를 둔다. 초과 시 `PHASE_BLOCKED` 로 사용자(team-lead)에게 결정을 위임한다.


| 점검                                 | 한도  | 초과 시                                                   |
| ---------------------------------- | --- | ------------------------------------------------------ |
| **critic REVISE**                  | 3회  | `PHASE_BLOCKED: critic REVISE 한도 초과: team-lead 결정 필요` |
| **code-reviewer FIX_NEEDED**       | 2회  | `PHASE_BLOCKED: code-reviewer FIX 한도 초과: 수동 검토 필요`    |
| **docs-verifier UPDATE/VIOLATION** | 2회  | `PHASE_BLOCKED: docs-verifier 한도 초과: 정합성 수동 점검`       |


team-lead 는 한도 카운터를 상태 저장소(`.omc/state/`)에 기록해 재실행 시에도 유지한다.

## 실행 등급 라우팅 (공급자 중립)

팀원을 어느 등급(`fast`·`standard`·`deep`)으로 돌릴지는
[`references/executor-routing.md`](references/executor-routing.md)가 소유한다.
규모별 기본 등급 표, 실행 형태 점검, 출발값과 하한을 고르는 순서, surface별 상속 함정이 거기 있다.

critic 평가 전과 phase 착수 직전에 그 문서를 반드시 읽는다.
모드 B 에서 team-lead 가 감당할 수 없는 phase 를 만났을 때의 전환 절차도 같은 문서에 있다.
