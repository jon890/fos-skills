---
name: build-with-teams
description: 팀 기반 구현 자동화 공용 코어 skill. planning 이 만든 task(index.json + phase 파일)를 읽어 phase 단위로 팀을 실행한다. 계획(team-lead) → 평가(critic) → 실행(executor) → 검토(code-reviewer) → 정합성 검증(docs-verifier) 파이프라인으로 phase 를 순차 처리하고 phase 단위 atomic commit + PR 까지 완료한다. "/build-with-teams", "build-with-teams", "agent team 으로 빌드", "teams 로 phase 실행", "critic 평가", "docs-verifier 검증", "task 실행해줘", "phase 실행" 같은 요청 시 반드시 이 스킬 사용. 레포별 특화(빌드/검증 명령·브랜치 규칙·에이전트 이름·스키마 세부·커밋 컨벤션)는 레포 오버레이·CLAUDE.md 로 주입된다.
---

# build-with-teams

planning 이 만든 task(`index.json` + `phase-*.md`)를 팀 기반 파이프라인으로 실행하는 시스템.
team-lead 가 팀원(critic·executor·code-reviewer·docs-verifier)을 조율해 phase 를 순차 실행하고, phase 단위로 atomic commit 을 쌓아 PR 까지 만든다.

## 레포 오버레이 로딩 (첫 단계)

작업 시작 시, 현재 레포에 오버레이 파일이 있으면 **먼저 읽고** 그 지시를 코어보다 우선한다.

- 경로: `<repo-root>/.claude/build-with-teams-overlay.md`
- 오버레이가 정의하는 것:
    - **통합 검증 명령** — lint/타입검사/테스트/빌드 명령 (레포 CLAUDE.md 에 있으면 그쪽 참조).
    - **브랜치 규칙** — 작업 브랜치 이름 형식, planning 이 브랜치를 미리 만드는지 여부, worktree 루트 경로.
    - **에이전트 이름** — executor·docs-verifier 로 쓸 전용 에이전트 (레포마다 다름).
    - **task 스키마 세부** — `index.json` 필드·phase 파일 규격 (planning 의 task-create 규격 + 레포 변형).
    - **common-pitfalls 경로** — critic·code-reviewer 가 사전 해소 점검할 패턴 파일 위치.
    - **커밋·PR 컨벤션** — 커밋 메시지 형식, PR 제목 형식, 노하우 누적 위치.
    - **환경 setup** — worktree 생성 후 의존성 설치·환경 파일 준비 절차.
- 오버레이가 **없으면** 레포 `CLAUDE.md` 참조로 동작한다. CLAUDE.md 에도 근거가 없으면 사용자에게 확인한다.

오버레이는 코어를 *덮어쓰는* 게 아니라 *채운다*.

## 핵심 원칙

1. **docs-first**: docs 반영 + 커밋 → task 생성 → 실행. 순서 위반 금지.
2. **가시적 협업**: 백그라운드 스크립트 대신 에이전트 팀이 각 단계를 명시적으로 수행한다.
3. **평가 통과 조건**: critic 승인 없이 실행 불가. REVISE 면 계획 수정 후 재평가한다.
4. **docs 정합성**: 실행 완료 후 docs-verifier 가 코드와 문서 일치를 검증한다.
5. **재시도 한도**: 무한 루프를 막는다 (아래 "재시도 한도" 참조).
6. **단독 결정 금지**: 분기점에서 자의적으로 결정하지 말고 구조화 질문 도구(Claude Code 는 `AskUserQuestion`)로 사용자에게 옵션을 제시한다.

## 사전 검증 (재실행 방지)

plan 인자를 받으면 **가장 먼저** 재실행 사고를 막는 3중 검증을 수행한다. 하나라도 걸리면 사용자에게 알리고 실행을 차단한다 — 사용자 확인 전에는 진행하지 않는다.

1. **task 존재 + 완료 상태** — 대상 task 디렉터리(`index.json`)가 있는지, 있으면 완료 상태 필드를 본다.
   - 부재 → planning 을 먼저 호출할지 사용자에게 확인.
   - 완료 상태 → 아래 4번(정합 검증)으로.
2. **원격 작업 브랜치 존재** — 해당 plan 의 작업 브랜치가 원격에 있는지 확인한다. 있으면 이미 작업 중이거나 PR 미머지 상태일 수 있으니 차단 후 사용자 결정.
3. **오픈 PR 존재** — 해당 plan 제목·브랜치를 포함한 오픈 PR 이 있는지 확인한다. 있으면 완료 후 머지 대기일 수 있으니 차단 후 사용자 결정.
4. **완료 상태 ↔ 머지 정합 (역방향)** — 완료로 표기됐는데 실제 머지 커밋이 원격 main 에 없으면 마킹 사고. 사용자에게 알리고 상태를 되돌릴지 결정.

> **왜 3중인가** — PR 머지 전 단계에서 main 의 `index.json` 은 여전히 미완료 상태이므로 1번만 보면 재실행 사고를 놓친다. 2·3번이 그 창을 덮는다.

**세부는 레포마다 다르다** — 아래는 **오버레이·CLAUDE.md 를 따른다**:

- 브랜치 이름 형식
- task 디렉터리 매칭(정확 일치 / 슬러그 suffix / fuzzy)
- planning 이 브랜치를 미리 만드는지 여부
- 이어서 작업(옵션 A) vs 새로 시작(옵션 B) 분기 정책
구체 검증 명령(`git ls-remote`, `gh pr list`, `jq .status` 등)은 레포 브랜치 규칙에 맞춰 조립한다.

## 실행 모드 선택 게이트 (사전 검증 통과 직후)

team-lead 가 task 를 읽고 규모를 판정한 직후, 첫 작업(worktree 생성 등) 전에 구조화 질문 도구로 팀원 spawn 모드를 묻는다 — 자의적으로 판단하지 않는다.

| 옵션 | 설명 | 권장 상황 |
|---|---|---|
| **A. 정식 팀 흐름** | critic + executor + code-reviewer + docs-verifier 모두 spawn | 대 규모 (4개 이상 phase / 아키텍처 / 스키마 대규모 / 신규 도메인) |
| **B. 사후 검수만** | team-lead 직접 처리 후 완료 시 code-reviewer + docs-verifier 만 spawn | 중 규모 (2-3 phase / 기존 기능 확장) |
| **C. team-lead 직접 처리** | spawn 없음, 모든 단계 team-lead 가 수행 | 소 규모 (1 phase / 버그 / 미세 조정) + 사용자 명시 효율 우선 |

기본 권장은 규모 기반(소 → C, 중 → B, 대 → A). "이전 세션이 그랬으니까" 같은 자의적 판단은 하지 않고 **매 호출마다 새로 질문**한다 (사용자가 "앞으로도 X 로" 라고 명시했으면 그 결정을 따른다).

> **왜 이 게이트가 필요한가** — 자의적으로 모드 C 를 골라 모든 게이트를 skip 하면 사후 검수로 보강하는 비용이 크다. 시작 시점 1번 질문이 훨씬 싸다.

## 분기점 단독 결정 금지 (일반 가드)

위 모드 게이트 외에도 작업 도중 **2개 이상 옵션 사이에서 결정해야 하는 상황**이면 자의적으로 진행하지 말고 즉시 옵션 + 트레이드오프를 질문한다.

- spec 충실도 (정확히 따를지 vs 일부 보류)
- scope 변경 (executor 가 task 외 변경 발견)
- 통합 검증 실패 분류 (plan 내 / plan 외)
- critic REVISE 한도 초과 후 다음 행동
- docs-verifier UPDATE_NEEDED 처리 시점 (PR 안 / 별도 PR / 머지 후)

**판정 기준**: 결정 결과가 (a) 회수 비용이 크거나 (b) 사용자 의도·스타일에 따라 갈리거나 (c) plan scope 를 벗어나면 즉시 질문한다.

**예외** — 질문 없이 진행해도 되는 분기:
- 이번 세션에서 사용자가 이미 명시적으로 결정한 동일 분기의 재발.
- 본 skill·오버레이에 이미 명시된 가드 (executor cwd 격리 등).
- 자명한 사실 확인 (파일 존재 / git status 등).

## 팀 구성 (역할 — 에이전트 이름은 오버레이가 지정)

| 역할 | 에이전트 | 책임 |
|---|---|---|
| **team-lead** | main session | 계획 수립, task 검토, 팀 조율, phase 단위 atomic commit, 최종 push/PR |
| **critic** | `oh-my-claudecode:critic` | 계획 평가 (APPROVE/REVISE), 실제 코드 대조 |
| **executor** | 레포의 executor 에이전트 | phase 순차 실행, 코드 수정 (커밋 제외), `bypassPermissions` |
| **code-reviewer** | `oh-my-claudecode:code-reviewer` | 코드 품질 검사 (PASS/FIX_NEEDED), 금지 패턴 탐지 |
| **docs-verifier** | 레포의 docs-verifier 에이전트 | 코드와 docs 정합성 검증 (PASS/UPDATE_NEEDED/VIOLATION) |

executor·docs-verifier 로 쓸 **구체 에이전트 이름은 오버레이·CLAUDE.md 가 단일 소스**다. 레포마다 다르므로 코어는 지정하지 않는다.
전용 에이전트가 도메인 지식을 보유하므로, spawn 프롬프트에는 호출 인자(task 파일 절대경로·직전 phase 학습·critic minor notes)만 담고 도메인 규칙을 반복하지 않는다.

### 팀원 스폰 가드 (요약)

팀원(critic·executor·code-reviewer·docs-verifier)을 스폰·통신할 때 실측 사고로 굳어진 가드가 있다. 각 가드를 무시하면 사후 검수 비용이 재스폰·재검증보다 훨씬 크므로, 아래 요약만 보지 말고 스폰 전 상세를 반드시 읽는다.

- **정식 팀원 스폰**: `team_name`+`name` 지정해 스폰한다. 일회성 호출은 팀 컨텍스트 밖이라 이후 `SendMessage` 협업이 끊긴다.
- **worktree 절대경로**: 팀원에게 주는 파일 참조는 상대경로가 아니라 worktree 절대경로로 준다. 상대경로는 main 의 구버전 파일을 가리킬 수 있다.
- **SendMessage 회신 강제**: 자기 화면 출력만 하고 종료하면 team-lead 에 결과가 안 닿는다. 스폰 프롬프트에 회신 의무를 명시한다.
- **자발적 실행 방지**: team-lead 지시 전 팀원이 먼저 실행·검증을 시작하면 게이트 시점 정합성이 깨진다.
- **self-shutdown 대응**: code-reviewer·docs-verifier 는 idle 알림 직후 자체 종료하는 경향이 있다 — idle 대기 대신 필요 시점에 재스폰한다.
- **executor cwd 격리**: executor 가 main 워킹 디렉터리를 직접 건드리면 main 이 origin 과 갈라진다 — worktree 경로만 쓰게 한다.
- **executor scope 확장 보고**: task 범위 외 수정을 자체 판단으로 추가하면 critic·code-reviewer 게이트를 우회한다 — 발견 시 보고만 하고 team-lead 승인 후 반영한다.

상세 프롬프트 문구·근거·판정 시간 규칙은 [`references/team-spawn.md`](references/team-spawn.md) 참조 — **팀원 스폰 전 반드시 읽는다**.

### 특이사항 4종 집계 (필수)

각 executor 는 phase 보고에 아래 4종을 함께 적는다. 없으면 "없음" 으로 명시한다 — 침묵으로 갈음하면 사용자가 후속 필요 여부를 판단할 수 없다.

- **pre-existing** — 이번 변경과 무관하게 원래 있던 문제.
- **신규 deprecation** — 이번 변경이 유발한 경고·예정 폐기.
- **미검증** — 로컬에서 확인 불가해 운영·검증 단계로 넘긴 영역.
- **범위 외 발견** — plan 범위 밖이지만 후속이 필요한 발견.

team-lead 는 종료 시 phase 별 특이사항을 누적해 사용자에게 명시 보고하고, 후속이 필요하면 이슈 등록을 제안한다.

## 모델 라우팅 (규모 기반)

task 를 읽고 규모를 판정해 팀원 모델을 조정한다.

| 규모 | 조건 | team-lead | critic | executor | code-reviewer | docs-verifier |
|---|---|:---:|:---:|:---:|:---:|:---:|
| **소** | 1 phase, 버그·미세 조정 | sonnet | sonnet | sonnet | sonnet | sonnet |
| **중** | 2-3 phase, 기능 확장·리팩토링 | sonnet | opus | sonnet | sonnet | sonnet |
| **대** | 4개 이상 phase, 아키텍처·신규 도메인 | opus | opus | sonnet | sonnet | opus |

executor·code-reviewer 는 모든 규모에서 sonnet 고정. 사용자가 모델을 명시하면 라우팅보다 우선한다.

phase 파일이 모델을 명시할 수 있다: 기계적 작업(git·빌드 검증·파일 삭제)은 `haiku`, 구현 대부분은 `sonnet`, 복잡 알고리즘은 `opus`.

## 재시도 한도

무한 루프를 막기 위해 각 게이트에 한도를 둔다. 초과 시 `PHASE_BLOCKED` 로 사용자(team-lead)에게 결정을 위임한다.

| 게이트 | 한도 | 초과 시 |
|---|---|---|
| **critic REVISE** | 3회 | `PHASE_BLOCKED: critic REVISE 한도 초과 — team-lead 결정 필요` |
| **code-reviewer FIX_NEEDED** | 2회 | `PHASE_BLOCKED: code-reviewer FIX 한도 초과 — 수동 검토 필요` |
| **docs-verifier UPDATE/VIOLATION** | 2회 | `PHASE_BLOCKED: docs-verifier 한도 초과 — 정합성 수동 점검` |

team-lead 는 한도 카운터를 상태 저장소(`.omc/state/`)에 기록해 재실행 시에도 유지한다.

## 실행 절차

### 1. 팀 생성

critic·docs-verifier 를 `run_in_background: true` 로 스폰해 대기시킨다 (self-shutdown 패턴이 있으면 검사 시점에 새로 스폰하는 게 안전).
스폰 직후 "정식 팀원 스폰 규칙" 의 등록 검증을 통과해야 다음 단계로 넘어간다.

### 2. task 파악

team-lead 가 task(`index.json` + `phase-*.md`)와 관련 docs·`CLAUDE.md`·오버레이를 읽는다.
planning 이 이미 task 를 만들었으면 검토 + 필요 시 같은 브랜치에 보강 commit 만 한다 (별도 PR 금지). 이 skill 이 직접 task 를 만들어야 하면 아래 3-4 를 수행한다.

### 3. docs 최신화 + 커밋 (해당 시)

논의 결과를 task 생성 전에 docs 에 반영하고 단독 커밋한다.

### 4. task 파일 검증·생성

`index.json` + `phase-*.md` 규격은 **planning 의 task-create 규격 + 레포 오버레이**를 따른다. phase 프롬프트 공통 규칙:

- 원자적 단일 책임, 작업 항목 5개 이하.
- 자기완결적 (이전 대화 없이 독립 실행 가능).
- 성공 기준에 모든 작업 검증 포함 (grep/test/diff/build — "눈으로 확인" 금지).
- 모든 Bash 블록 앞에 `# cwd: ...` 주석.
- 마지막 phase 에 task 완료 처리(상태를 완료로 마킹) 단계 포함 → main 별도 커밋 회피.

**task 재분할 시 index.json 동시 갱신 강제**: phase 파일을 추가·제거·재작성하면 `index.json` 의 phase 개수·배열·설명을 **같은 commit 으로** 갱신한다. phase 파일만 추가하고 index.json 을 안 고치면 파이프라인이 새 phase 를 인식 못 해 핵심이 누락된다. commit 직전 phase 파일 수와 index.json 값이 일치하는지 sanity check.

### 5. critic 평가 (게이트)

team-lead → critic 에게 계획 전송. critic 평가 관점:

1. phase 순서·의존성이 올바른가?
2. 누락된 작업이 있는가?
3. 각 phase 의 리스크는?
4. phase 크기가 5개 이하인가?
5. 성공 기준이 충분한가?
6. **실제 코드와 일치하는가?** (파일 존재·함수명·줄 수 검증)
7. **오버레이가 지정한 common-pitfalls 의 관련 패턴이 사전 해소됐는가?**

판정: **APPROVE** → 6단계. **REVISE** → 수정 후 재평가 (한도 3회).

**critic v2 재평가 시 강제 재읽기 (필수)**: critic 이 REVISE 후 v2 변경을 받고도 v1 평가를 반복 송신하는 사고가 있다. 원인은 worktree 의 새 파일을 다시 Read 하지 않은 것. 재평가 메시지에 다음 3가지를 반드시 포함:

1. "Read tool 로 다음 파일을 다시 읽고 재평가" + 변경 파일 절대경로.
2. 확인 포인트 체크리스트 (어느 라인이 어떻게 바뀌었는지).
3. "직전 메시지는 첫 평가 사본일 수 있음 — 실제 파일 상태 기준으로 판정 부탁".

회신이 v1 과 동일하면 team-lead 가 수정된 실제 라인을 `grep`/`awk` 로 떠서 증거로 붙여 재요청한다. 이 패턴은 **code-reviewer·docs-verifier 재검사에도 동일 적용**한다.

### 6. executor 실행

critic APPROVE 후 executor 를 `run_in_background: true`, `mode: "bypassPermissions"` 로 스폰한다 (critic 승인 + docs-verifier 검증의 이중 안전망).

- **phase 단위 spawn → shutdown 사이클 (4+ phase 필수)**: 한 phase 완료·커밋 후 그 executor 를 **반드시 종료한 뒤** 다음 phase 를 새 이름(`executor-p{N}`)으로 스폰한다. 컨텍스트 격리 + 이름 충돌·auto-deliver 누락 회피.
    - 종료 방법: `SendMessage({to, message:{type:"shutdown_request"}})` 또는 `TaskStop`. 종료를 확인한 뒤 다음 executor 를 스폰한다.
    - **종료를 빠뜨리면 phase 마다 executor 가 누적된다** (8-phase task 에서 팀원 8개 잔존 관측). 다음 스폰 직전에 이전 executor 종료를 매 phase 강제한다.
    - 3 phase 이하는 executor 를 한 번만 스폰해 재사용한다 (다음 phase 는 새로 스폰하지 않고 `SendMessage` 로 지시).
- executor 규칙: phase 를 순서대로 실행, phase 완료 후 성공 기준 검증, **커밋은 team-lead 가** (executor 는 하지 않음), 완료·실패를 SendMessage 로 보고. 코드 주석 규칙은 레포 `CLAUDE.md` 를 따른다.
- 위 "executor cwd 격리" + "scope 확장 보고" 가드 문구를 스폰 프롬프트에 그대로 포함한다.

**phase 단위 atomic commit**: 한 phase 완료·검증 후 team-lead 가 그 phase 만 commit 한다. commit 전 `git status` 로 staged 전체를 점검해 관심사가 섞이지 않게 한다 (executor 가 staging 한 무관 변경이 딸려올 수 있음 — 섞였으면 `git reset` 후 명시적 add 또는 경로 한정 commit).

### 7. 코드 품질 검사 (code-reviewer)

executor 완료 후 team-lead 가 code-reviewer 를 새로 스폰해 SendMessage 로 검사를 지시한다 (team-lead 직접 수행 금지 — 건너뛰기 방지).

- **검사 범위**: executor 가 변경한 파일만 (`git diff --name-only` 기준).
- **검사 항목은 인라인하지 않는다** — 오버레이가 지정한 common-pitfalls 를 라우터로 골라 grep 점검하도록 지시한다.
- **비자명 설계 결정 첨부**: plan 의 의도된 raw 패턴·helper 우회 사유·scope 외 placeholder 를 1-2줄 요약해 첨부한다. 없으면 reviewer 가 정상 설계를 false positive 로 올린다.

판정: **PASS** → 8단계. **FIX_NEEDED** → executor 재투입 후 재검사 (한도 2회).

### 8. docs-verifier 검증

executor 완료 후 team-lead → docs-verifier 에게 검증 요청 (self-shutdown 시 재스폰 + 즉시 지시). 검증 관점:

1. 설계 결정(ADR 등) 위반 여부.
2. 레이어·코딩 규칙 준수 (레포 `CLAUDE.md` 참조).
3. docs 업데이트 필요 여부, 의사결정 의도 보존 여부.
4. **문서 부패 검증**: 코드에서 제거·변경된 기능이 docs 에 dead reference 로 남아 있는지 (`grep -rn` 로 검출).

docs-verifier 전용 에이전트가 도메인 검증 항목 전체를 보유하면 SKILL 은 위임만 하고 항목을 반복하지 않는다.

판정: **PASS** → 9단계. **UPDATE_NEEDED** → docs 업데이트 후 재검증 (한도 2회). **VIOLATION** → 코드 수정 지시 (executor 재투입, 한도 2회).

### 9. 완료 + PR 생성 + 팀 종료

1. team-lead 가 누적 commit 을 검토한다 — phase 별 commit 이 의도대로 들어갔는지, 마지막 phase commit 에 완료 마킹이 포함됐는지 확인.
2. **통합 검증** — 레포 CLAUDE.md·오버레이의 검증 명령을 실행해 모든 phase 누적 후에도 통과하는지 확인한다.
3. **검증 실패 시 분기 (필수)** — 실패 원인 파일과 변경 파일을 매칭해 책임을 분류한다. 자의적으로 plan PR 에 외부 잔존 깨짐 fix 를 흡수하지 않는다.
   - **plan 범위 내**: 본 plan 변경 파일에서 실패 → executor 재투입(또는 team-lead 직접 fix). 사용자 결정 불필요.
   - **plan 범위 외**: 실패 원인이 변경 외 파일(`git diff origin/main -- <파일>` 이 비어있음 = main 자체 깨짐) → 사용자에게 옵션 제시 (A: PR 에 fix 흡수 / B: 별도 hotfix PR 후 rebase / C: 그대로 PR + description 에 의존 명시). 결정 이력은 PR description 에 명시.
4. **완료 마킹은 PR 브랜치 안에서만** — 마지막 phase commit 에 포함(이상), 또는 브랜치 안 별도 commit(차선). **main 직접 커밋/푸시 금지** (이중 진실원·push 충돌 위험. 재실행 방지는 사전 검증이 담당).
5. push 후 PR 생성·갱신 (오픈 PR 없으면 신규, 있으면 갱신). PR 제목·body 형식은 레포 커밋 컨벤션을 따르고, phase 별 commit 목록 + "특이사항 및 후속" 섹션을 포함한다.
6. **팀 종료 (모든 잔존 팀원)** — 남아 있는 팀원 전부(`executor`·`executor-p{N}`·`critic`·`code-reviewer`·`docs-verifier`)에 각각 `shutdown_request`(또는 `TaskStop`)를 보내 종료를 확인한다. phase 단위 사이클에서 미종료된 executor 가 있으면 여기서 일괄 정리한다. 이어서 worktree 정리 + 특이사항 집계 보고.
7. 사용자가 PR 을 머지하면 완료 상태가 main 에 자동 반영된다. main 후속 작업 0개.

## worktree 기반 격리 실행

작업 간 충돌을 막기 위해 git worktree 를 쓴다. worktree 는 프로젝트 내부 `.claude/worktrees/` 하위에 만든다 (부모 디렉터리 오염 방지). `.gitignore` 에 `.claude/worktrees/` 가 등록돼 있어야 한다.

- **경로 철자 엄수**: worktree 루트는 정확히 `.claude/worktrees/` 다. 자동완성 오타(`.claire-worktrees` 등) 로 유사 철자 디렉터리를 만들면 후속 검증이 깨진다. worktree 생성 전후로 `.claude` 외 `.cla*` 디렉터리를 탐지해 명백한 오타는 즉시 제거한다.
- **cwd 추적**: task 파일 수정·commit·검증 시 자신의 shell cwd 가 main repo 인지 worktree 인지 매번 확인한다 (`pwd`). 같은 상대경로가 cwd 에 따라 다른 파일을 가리켜 main repo 의 task 를 실수로 건드릴 수 있다. commit 전 main repo + worktree 양쪽 `git status` 동시 점검 권장.
- **base 신선도**: worktree 는 원격 main 기반으로 분기한다. 로컬 main 이 원격보다 앞서 있으면 미푸시 커밋 누락 위험을 안내한다.
- **환경 setup**: worktree 생성 후 의존성 설치·환경 파일 준비(예: gitignore 된 env 파일 공유)는 레포마다 다르므로 **오버레이·CLAUDE.md 절차**를 따른다.
- **정리**: 사이클 종료 시 `git worktree remove` 로 제거한다. 브랜치 삭제·원복은 사용자 판단 (PR 머지 후 안전).

## 실패 복구

executor 가 phase 실패를 보고하면: team-lead 가 원인 분석 → phase 수정 필요 시 critic 재평가(5단계) → 단순 에러면 executor 재실행 지시.

## 실행 흐름 요약

```
[사전 검증 3중 — task 상태 + 원격 브랜치 + 오픈 PR (+ 완료↔머지 정합)]
    → [실행 모드 선택 게이트 — A 정식 / B 사후검수 / C 직접]
    → [메인 워킹 트리 사전 점검 + 오타 worktree 정리]
    → [worktree 생성 (원격 main 기반) + 레포 환경 setup]
    → [task 파악 / (필요 시) docs 최신화 + task 생성·검증]
    → [critic 평가] ←─ REVISE 면 수정 후 재평가 (한도 3회)
    → [executor 실행 — phase 단위 spawn·commit] ←─ 실패 시 원인 분석 후 재실행
    → [code-reviewer 검사] ←─ FIX_NEEDED 면 재투입 (한도 2회)
    → [docs-verifier 검증] ←─ VIOLATION/UPDATE_NEEDED 면 재투입 (한도 2회)
    → [통합 검증 — 실패 시 plan 범위 내/외 분기]
    → [team-lead 일괄 push (완료 마킹은 PR 브랜치 안)]
    → [PR 생성·갱신]
    → [팀 shutdown + worktree 정리 + 특이사항 집계 보고]
    → (사용자 PR 머지 → 완료 상태 자동 main 반영, 후속 0개)
```

## 노하우 누적 (세션마다 보강)

매 실행 후 발견한 결함·노하우 중 **재발 방지 가치 있는 것**을 1-2줄 누적한다. 새 문서는 신설하지 않는다 — 에이전트가 자연스럽게 찾아갈 기존 위치만 쓴다.

누적 가치 판단: (a) 재발 가능한 패턴·프로세스 결함, (b) 1-2단어로 추상화 가능, (c) grep/test/build 로 재발 시 검출 가능, (d) 팀원의 일반 행동에 영향. 1회성 오타·특정 plan 한정 메모는 누적 금지.

**누적 위치는 레포마다 다르다** — critic 반복 지적은 오버레이가 지정한 common-pitfalls, 프로세스 결함은 이 SKILL.md 해당 섹션, 도메인 결정은 레포 ADR, 코딩 규칙은 `CLAUDE.md`·`AGENTS.md`. 구체 경로·형식은 **오버레이·CLAUDE.md 참조**.

PR 생성 후 worktree 정리 직전, 사용자에게 "이번 세션 누적 노하우" 를 1-3줄 보고한다. 누적 안 했으면 "신규 노하우 없음" 으로 명시한다.

## 의도적으로 안 하는 것

- **레포 특화를 코어에 하드코딩**: 빌드/검증 명령, 브랜치 규칙, 에이전트 이름, task 스키마 세부, 커밋 컨벤션, common-pitfalls 경로는 오버레이·CLAUDE.md 로만.
- **planning 역할 침범**: task 설계 워크플로는 planning 이 담당한다. 이 skill 은 이미 만들어진 task 를 실행한다 (task 부재 시 planning 안내 또는 최소 생성만).
- **검증 우회**: 통합 검증을 건너뛰거나 우회 플래그로 통과시키지 않는다.
- **main 직접 오염**: 완료 마킹·결과물은 PR 브랜치에만. main 직접 커밋 금지.
