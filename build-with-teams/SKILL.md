---
name: build-with-teams
description: 팀 기반 구현 자동화 공용 코어 skill. planning 이 만든 task(index.json, phase 파일)를 읽고 plan 1개를 단일 브랜치·단일 PR로 완료한다. 계획(team-lead) → 평가(critic) → 실행(executor) → 검토(code-reviewer) → 정합성 검증(docs-verifier) 파이프라인으로 phase 를 순차 처리하고 phase 단위 atomic commit 과 PR 까지 완료한다. "/build-with-teams", "build-with-teams", "agent team 으로 빌드", "teams 로 phase 실행", "critic 평가", "docs-verifier 검증", "task 실행해줘", "phase 실행" 같은 요청 시 반드시 이 스킬 사용. 레포별 특화(빌드/검증 명령·브랜치 규칙·에이전트 이름·스키마 세부·커밋 컨벤션)는 레포 오버레이·CLAUDE.md 로 주입된다.
metadata:
  version: "2.2.0"
---

# build-with-teams

planning 이 만든 task(`index.json`, `phase-*.md`)를 팀 기반 파이프라인으로 실행하는 시스템.
team-lead 가 팀원(critic·executor·code-reviewer·docs-verifier)을 조율해 phase 를 순차 실행한다.
phase 단위로 atomic commit 을 쌓아 PR 까지 만든다.

## 레포 오버레이 로딩 (첫 단계)

작업 시작 시, 현재 레포에 오버레이 파일이 있으면 **먼저 읽고** 그 지시를 코어보다 우선한다.

- 경로: `<repo-root>/.claude/build-with-teams-overlay.md`
- 오버레이가 정의하는 것:
    - **통합 검증 명령** — lint/타입검사/테스트/빌드 명령 (레포 CLAUDE.md 에 있으면 그쪽 참조).
    - **브랜치 규칙** — 작업 브랜치 이름 형식, planning 이 브랜치를 미리 만드는지 여부, worktree 루트 경로.
    - **에이전트 이름** — executor·docs-verifier 로 쓸 전용 에이전트 (레포마다 다름).
    - **task 스키마 세부** — `index.json` 필드·phase 파일 규격 (planning 의 task-create 규격과 레포 변형).
    - **반복 함정 목록 경로** — critic·code-reviewer 가 사전 해소를 점검할 패턴 파일 위치.
    - **커밋·PR 컨벤션** — 커밋 메시지 형식, PR 제목 형식, 노하우 누적 위치.
    - **환경 setup** — worktree 생성 후 의존성 설치·환경 파일 준비 절차.
- 오버레이가 **없으면** 레포 `CLAUDE.md` 참조로 동작한다. CLAUDE.md 에도 근거가 없으면 사용자에게 확인한다.

## 핵심 원칙

1. **docs-first**: docs 반영과 커밋 → task 생성 → 실행. 순서 위반 금지.
2. **단독 결정 금지**: 분기점에서 자의적으로 결정하지 말고 구조화 질문 도구(Claude Code 는 `AskUserQuestion`)로 사용자에게 옵션을 제시한다.
3. **plan 1개 = PR 1개**: 한 실행은 정확히 하나의 plan만 다루고 그 plan의 단일 PR로 끝낸다. 여러 plan을 한 브랜치·PR에 합치거나 한 plan을 여러 PR로 쪼개지 않는다.

통과 조건(critic 승인·docs 정합성·재시도 한도)는 원칙으로 되풀이하지 않고 각 절차 섹션이 단일 소스다.

## 사전 검증 (재실행 방지)

plan 인자를 받으면 **가장 먼저** 재실행 사고를 막는 3중 검증을 수행한다. 하나라도 걸리면 사용자에게 알리고 실행을 차단한다 — 사용자 확인 전에는 진행하지 않는다.

1. **plan 브랜치와 task 존재** — 원격 `plan{N}-<slug>` 브랜치가 있는지, 그 브랜치에 task 디렉터리(`index.json`)가 있는지 본다. 있으면 완료 상태 필드를 확인한다.
   - **브랜치 부재** → planning 을 먼저 호출할지 사용자에게 확인.
   - **브랜치는 있는데 task 부재** → planning 이 중단됐거나 push 가 안 된 상태다. planning 재호출이 아니라 **그 브랜치의 상태를 사용자에게 보여주고 결정**을 받는다.
   - 완료 상태 → 아래 4번(정합 검증)으로.
2. **plan 브랜치의 구현 커밋 존재** — plan 브랜치는 항상 원격에 있으므로 **브랜치 존재 자체는 재실행 신호가 아니다**.
   대신 그 브랜치에 기획 커밋 외에 **phase 구현 커밋이 이미 쌓여 있는지** 본다.
   - `git log origin/plan{N}-<slug> --oneline`
   - `git diff origin/main...origin/plan{N}-<slug> --stat` — docs·tasks 외 변경이 있는지 본다.
   - 구현 커밋이 있으면 이미 실행됐거나 중단된 상태다 → 차단 후 사용자 결정(이어서 작업 / 되돌리고 새로 시작).
3. **오픈 PR 존재** — 해당 plan 제목·브랜치를 포함한 오픈 PR 이 있는지 확인한다. 있으면 완료 후 머지 대기일 수 있으니 차단 후 사용자 결정.
4. **완료 상태 ↔ 머지 정합**(역방향) — 완료로 표기됐는데 실제 머지 커밋이 원격 main 에 없으면 마킹 사고. 사용자에게 알리고 상태를 되돌릴지 결정.

> **왜 3중인가** — PR 머지 전 단계에서 main 의 `index.json` 은 여전히 미완료 상태이므로 1번만 보면 재실행 사고를 놓친다. 2·3번이 그 창을 덮는다.

**세부는 레포마다 다르다** — 아래는 **오버레이·CLAUDE.md 를 따른다**:

- 브랜치 이름 형식
- task 디렉터리 매칭(정확 일치 / 슬러그 suffix / fuzzy)
- planning 이 브랜치를 미리 만드는지 여부
- 이어서 작업(옵션 A) vs 새로 시작(옵션 B) 분기 정책
구체 검증 명령(`git ls-remote`, `gh pr list`, `jq .status` 등)은 레포 브랜치 규칙에 맞춰 조립한다.

## 실행 모드 (사전 검증 통과 직후)

team-lead 가 task 규모를 보고 구현을 위임할지 스스로 정한다. 사용자가 모드를 명시했으면 그것을 따른다.

| 모드 | 구현 | 규모 |
|---|---|---|
| **A. 정식 팀 흐름** | executor 를 spawn 해 phase 를 위임한다 | 대 (4개 이상 phase / 아키텍처 / 스키마 대규모 / 신규 도메인) |
| **B. team-lead 구현** | executor 없이 team-lead 가 직접 구현한다 | 소·중 (1-3 phase / 버그 / 기존 기능 확장) |

**구현자** — 이 문서에서 구현 주체를 가리키는 말이다. 모드 A 는 executor, 모드 B 는 team-lead 다.
구현자를 주어로 쓴 지시는 두 모드에 그대로 적용된다.
`executor` 를 주어로 쓴 지시는 스폰된 팀원에게만 해당하므로 모드 A 전용이다.

**모드가 가르는 것은 구현 위임 여부뿐이다.**
critic·code-reviewer·docs-verifier 스폰은 두 모드 모두에서 필수다.
계획 평가와 사후 검토를 규모로 깎지 않는다 — 같은 세션이 자기 계획과 자기 구현을 그대로 승인하면 결함이 드러나지 않는다.
프론티어 모델도 여기서는 자기 맥락에 갇힌다.
스폰이 환경 제약으로 실패하면 건너뛰지 말고 그 사실과 대체 검증 근거를 실행 보고에 남긴다.

## 분기점 단독 결정 금지 (일반 가드)

작업 도중 **2개 이상 옵션 사이에서 결정해야 하는 상황**이면 자의적으로 진행하지 말고 즉시 옵션과 트레이드오프를 질문한다.

- spec 충실도 (정확히 따를지 vs 일부 보류)
- scope 변경 (구현자가 task 외 변경 발견)
- 통합 검증 실패 분류 (plan 내 / plan 외)
- critic REVISE 한도 초과 후 다음 행동
- docs-verifier UPDATE_NEEDED 처리 시점 (PR 안 / 별도 PR / 머지 후)

**판정 기준**: 결정 결과가 (a) 회수 비용이 크거나 (b) 사용자 의도·스타일에 따라 갈리거나 (c) plan scope 를 벗어나면 즉시 질문한다.

**예외** — 질문 없이 진행해도 되는 분기:
- 위 실행 모드 선택. 규모로 판정 가능하고 독립 검토는 어느 모드에서도 유지되므로 회수 비용이 없다.
- 이번 세션에서 사용자가 이미 명시적으로 결정한 동일 분기의 재발.
- 본 skill·오버레이에 이미 명시된 가드 (구현자 cwd 격리 등).
- 자명한 사실 확인 (파일 존재 / git status 등).

## 팀 구성 (역할 — 에이전트 이름은 오버레이가 지정)

| 역할 | 에이전트 | 책임 |
|---|---|---|
| **team-lead** | main session | 계획 수립, task 검토, 팀 조율, phase 단위 atomic commit, 최종 push/PR |
| **critic** | `oh-my-claudecode:critic` | 계획 평가 (APPROVE/REVISE), 실제 코드 대조 |
| **executor** | 레포의 executor 에이전트 | phase 순차 실행, 코드 수정 (커밋 제외), `bypassPermissions`. **모드 A 에서만 스폰** — 모드 B 는 team-lead 가 구현자를 겸한다 |
| **code-reviewer** | `oh-my-claudecode:code-reviewer` | 코드 품질 검사 (PASS/FIX_NEEDED), 금지 패턴 탐지 |
| **docs-verifier** | 레포의 docs-verifier 에이전트 | 코드와 docs 정합성 검증 (PASS/UPDATE_NEEDED/VIOLATION) |

executor·docs-verifier 로 쓸 **구체 에이전트 이름은 오버레이·CLAUDE.md 가 단일 소스**다. 레포마다 다르므로 코어는 지정하지 않는다.
전용 에이전트가 도메인 지식을 보유하므로, spawn 프롬프트에는 호출 인자(task 파일 절대경로·직전 phase 학습·critic minor notes)만 담고 도메인 규칙을 반복하지 않는다.

### 팀원 스폰 가드 (요약)

팀원(critic·executor·code-reviewer·docs-verifier)을 스폰·통신할 때 실제 사고를 겪고 굳어진 가드가 있다.
모드 B 도 critic·code-reviewer·docs-verifier 를 스폰하므로 대부분 그대로 발동한다.
**구현자** 로 시작하는 둘은 모드 B 에서 team-lead 자신에게 적용된다.

- **정식 팀원 스폰이 1순위**: `team_name` 과 `name` 을 지정해 스폰한다. 이름 없는 subagent 는 환경 제약으로 실패했을 때만 쓰는 폴백이고, 내려갔으면 실행 보고에 남긴다.
- **worktree 절대경로**: 팀원에게 주는 파일 참조는 상대경로가 아니라 worktree 절대경로로 준다. 상대경로는 main 의 구버전 파일을 가리킬 수 있다.
- **SendMessage 회신 강제**: 자기 화면 출력만 하고 종료하면 team-lead 에 결과가 안 닿는다. 스폰 프롬프트에 회신 의무를 명시한다.
- **자발적 실행 방지**: team-lead 지시 전 팀원이 먼저 실행·검증을 시작하면 점검 시점 정합성이 깨진다.
- **self-shutdown 대응**: code-reviewer·docs-verifier 는 idle 알림 직후 자체 종료하는 경향이 있다 — idle 대기 대신 필요 시점에 재스폰한다.
- **구현자 cwd 격리**: main 워킹 디렉터리를 직접 건드리면 main 이 origin 과 갈라진다 — worktree 경로만 쓴다. 모드 B 에서 위험이 더 크다.
- **구현자 scope 확장 보고**: task 범위 외 수정을 자체 판단으로 추가하면 검토를 우회한다. 모드 B 는 자기 승인이 되므로 사용자에게 확인한다.
- **split-pane 스폰 실패**(환경): tmux 없는 터미널에서 `name` 지정 스폰이 깨진다 — 폴백을 한 단계씩만 내려간다.
- **watchdog stall 복구**: 무거운 외부 상호작용에서 멈추면 그 상호작용을 없애는 쪽으로 작업을 다시 짠다.
    워치독은 모드 A 에만 있지만 회피 원칙은 모드 B 에서도 같다.

상세 프롬프트 문구·근거·판정 시간 규칙은 [`references/team-spawn.md`](references/team-spawn.md) 참조 — **팀원 스폰 전 반드시 읽는다**.

### 특이사항 4종 집계 (필수)

구현자는 phase 보고에 아래 4종을 함께 적는다. 없으면 "없음" 으로 명시한다 — 침묵으로 갈음하면 사용자가 후속 필요 여부를 판단할 수 없다.
모드 A 는 executor 가 `SendMessage` 로 올리고, 모드 B 는 team-lead 가 phase 커밋 시점에 스스로 기록한다.

- **pre-existing** — 이번 변경과 무관하게 원래 있던 문제.
- **신규 deprecation** — 이번 변경이 유발한 경고·예정 폐기.
- **미검증** — 로컬에서 확인 불가해 운영·검증 단계로 넘긴 영역.
- **범위 외 발견** — plan 범위 밖이지만 후속이 필요한 발견.

team-lead 는 종료 시 phase 별 특이사항을 누적해 사용자에게 명시 보고하고, 후속이 필요하면 이슈 등록을 제안한다.
각 phase 종료, 검토자의 `FIX_NEEDED`, 검증 장시간 정체·복구 직후에는 재사용 가치가 있는 사건을 `docs/retrospectives/`에 회고 하나당 파일 하나로 즉시 기록한다.
종료 시점까지 미루지 않는다. 형식과 승격 규칙은 [`references/retrospective.md`](references/retrospective.md)를 따른다.

## 실행 등급 라우팅 (공급자 중립)

팀원을 어느 등급(`fast`·`standard`·`deep`)으로 돌릴지는
[`references/executor-routing.md`](references/executor-routing.md)가 소유한다.
규모별 기본 등급 표, 실행 형태 점검, 출발값과 하한을 고르는 순서, surface별 상속 함정이 거기 있다.
공용 skill과 task에는 실제 모델 ID나 공급자 제품명을 저장하지 않는다.

critic 평가 전과 phase 착수 직전에 그 문서를 반드시 읽는다.
모드 B 에서 team-lead 가 감당할 수 없는 phase 를 만났을 때의 전환 절차도 같은 문서에 있다.

## 재시도 한도

무한 루프를 막기 위해 각 점검에 한도를 둔다. 초과 시 `PHASE_BLOCKED` 로 사용자(team-lead)에게 결정을 위임한다.

| 점검 | 한도 | 초과 시 |
|---|---|---|
| **critic REVISE** | 3회 | `PHASE_BLOCKED: critic REVISE 한도 초과 — team-lead 결정 필요` |
| **code-reviewer FIX_NEEDED** | 2회 | `PHASE_BLOCKED: code-reviewer FIX 한도 초과 — 수동 검토 필요` |
| **docs-verifier UPDATE/VIOLATION** | 2회 | `PHASE_BLOCKED: docs-verifier 한도 초과 — 정합성 수동 점검` |

team-lead 는 한도 카운터를 상태 저장소(`.omc/state/`)에 기록해 재실행 시에도 유지한다.

## 실행 절차

```
[사전 검증 3중 — plan 브랜치·task + 구현 커밋 유무 + 오픈 PR (+ 완료↔머지 정합)]
    → [실행 모드 결정 — A executor 위임 / B team-lead 구현]
    → [메인 워킹 트리 사전 점검 + 오타 worktree 정리]
    → [worktree 생성 (원격 plan{N} 브랜치 기반) + 레포 환경 setup]
    → [task 파악 / (필요 시) docs 최신화 + task 생성·검증]
    → [critic 평가] ←─ REVISE 면 수정 후 재평가 (한도 3회)
    → [phase 별 실행 형태 점검 — BOUNDED / JUDGMENT_REQUIRED / HIGH_RISK]
    → [모든 phase 구현 — 검증·atomic commit] ←─ 실패 시 원인 분석 후 해당 phase 재실행
    → [누적 diff code-reviewer 검사 — 전부 보고 후 team-lead 필터] ←─ FIX_NEEDED 면 재투입 후 전체 재검사 (한도 2회)
    → [code-reviewer PASS 후 최종 HEAD docs-verifier 검증 1회] ←─ VIOLATION/UPDATE_NEEDED 면 재투입 후 재검증 (한도 2회)
    → [통합 검증 — 실패 시 plan 범위 내/외 분기]
    → [team-lead 일괄 push (완료 마킹은 PR 브랜치 안)]
    → [PR 생성·갱신]
    → [팀 shutdown + worktree 정리 + 특이사항 집계 보고]
    → (사용자 PR 머지 → 완료 상태 자동 main 반영, 후속 0개)
```

### 1. 팀 생성

critic 을 `run_in_background: true` 로 스폰한다.
code-reviewer·docs-verifier 는 미리 대기시키지 않고 7·8단계 검사 시점에 스폰한다.
오래 대기시킨 팀원은 스스로 종료하는 패턴 때문에 어차피 재스폰해야 하기 때문이다.
스폰 직후 "정식 팀원 스폰 규칙" 의 등록 검증을 통과해야 다음 단계로 넘어간다.

### 2. task 파악

team-lead 가 task(`index.json`, `phase-*.md`)와 관련 docs·`CLAUDE.md`·오버레이를 읽는다.
planning 이 이미 task 를 만들었으면 검토하고 필요 시 같은 브랜치에 보강 commit 만 한다 (별도 PR 금지). 이 skill 이 직접 task 를 만들어야 하면 아래 3-4 를 수행한다.
요청에 여러 plan이 포함되면 이번 실행 대상 plan 하나만 선택한다. 실행 순서는 planning 이 보고한 순서를 따른다.

### 3. docs 최신화와 커밋 (해당 시)

논의 결과를 task 생성 전에 docs 에 반영하고 단독 커밋한다.

### 4. task 파일 검증·생성

`index.json`, `phase-*.md` 규격은 **planning 의 task-create 규격과 레포 오버레이**를 따른다. phase 프롬프트 공통 규칙:

- 원자적 단일 책임, 작업 항목 5개 이하.
- 자기완결적 (이전 대화 없이 독립 실행 가능).
- 성공 기준에 모든 작업 검증 포함 (grep/test/diff/build — "눈으로 확인" 금지).
- 모든 Bash 블록 앞에 `# cwd: ...` 주석.
- 마지막 phase 에 task 완료 처리(상태를 완료로 마킹) 단계 포함 → main 별도 커밋 회피.

**task 재분할 시 index.json 동시 갱신 강제**: phase 파일을 추가·제거·재작성하면 `index.json` 의 phase 개수·배열·설명을 **같은 commit 으로** 갱신한다.

- phase 파일만 추가하고 `index.json` 을 안 고치면 파이프라인이 새 phase 를 인식하지 못해 그 작업이 통째로 빠진다.
- commit 직전에 phase 파일 수와 `index.json` 값이 일치하는지 확인한다.

### 5. critic 평가 (통과 조건)

team-lead → critic 에게 계획 전송. critic 평가 관점:

1. phase 순서·의존성이 올바른가?
2. 누락된 작업이 있는가?
3. 각 phase 의 리스크는?
4. phase 크기가 5개 이하인가?
5. 성공 기준이 충분한가?
6. **실제 코드와 일치하는가?** (파일 존재·함수명·줄 수 검증)
7. **오버레이가 지정한 반복 함정 목록의 관련 패턴이 사전 해소됐는가?**

**판정과 발견 목록을 분리해 회신받는다.** 둘을 한 덩어리로 받으면 APPROVE 와 앞뒤가 안 맞아 보이는 지적을 critic 이 스스로 삼킨다.

- **판정**: APPROVE 또는 REVISE 중 하나.
- **phase 별 실행 형태**: `BOUNDED`, `JUDGMENT_REQUIRED`, `HIGH_RISK` 중 하나와 근거.
- **발견 목록**: 판정과 무관하게 눈에 걸린 것을 전부 적는다. APPROVE 여도 비워 두지 않고, 없으면 "없음" 으로 명시한다.

발견을 무엇으로 처리할지는 team-lead 가 정한다.

- 계획을 고쳐야 하는 것 → REVISE 로 되돌린다.
- 구현하며 챙기면 되는 것 → `critic minor notes` 로 구현자에게 넘긴다 (모드 A 는 스폰 프롬프트에, 모드 B 는 phase 착수 메모에).
- 이번 plan 밖의 것 → 특이사항 4종에 합쳐 보고한다.

판정: **APPROVE** → 6단계. **REVISE** → 수정 후 재평가 (한도 3회).

**critic v2 재평가 시 강제 재읽기**(필수): critic 이 REVISE 후 v2 변경을 받고도 v1 평가를 그대로 다시 보내는 사고가 있다.
원인은 worktree 의 새 파일을 다시 Read 하지 않은 것이다.
재평가 메시지에 다음 3가지를 반드시 포함한다.

1. "Read tool 로 다음 파일을 다시 읽고 재평가" 지시와 변경 파일 절대경로.
2. 확인 포인트 체크리스트 (어느 라인이 어떻게 바뀌었는지).
3. "직전 메시지는 첫 평가 사본일 수 있음 — 실제 파일 상태 기준으로 판정 부탁".

회신이 v1 과 같으면 team-lead 가 수정된 실제 라인을 `grep`·`awk` 로 떠서 증거로 붙여 재요청한다.
이 패턴은 **code-reviewer·docs-verifier 재검사에도 그대로 적용**한다.

### 6. 구현

critic APPROVE 후 구현에 들어간다. 모드 A 는 executor 를 `run_in_background: true`, `mode: "bypassPermissions"` 로 스폰하고, 모드 B 는 team-lead 가 직접 구현한다.
아래 실행 형태 점검과 phase 단위 커밋·검증 규칙은 두 모드에 같이 적용한다 — 구현 주체만 다르고 통과 조건은 같다.

각 phase 착수 직전에 [`references/executor-routing.md`](references/executor-routing.md)의 적합성 점검을 실행한다.
team-lead는 critic 회신과 직접 점검 결과를 assessment JSON으로 만들고 `~/.claude/skills/build-with-teams/scripts/executor_routing_gate.py`를 통과시킨다.
스크립트가 차단하면 그 phase 에 착수하지 않는다.

판정을 무엇으로 집행할지는 모드마다 다르다.

- **모드 A** — 반환된 실행 형태보다 낮은 role 로 executor 를 스폰하지 않는다.
  같은 수준의 role 이 없으면 더 엄격한 쪽으로만 올린다 — 내려서 스폰하지 않는다.
- **모드 B** — team-lead 가 직접 구현해도 되는지를 가른다.
  전환 조건과 절차, 실행 형태를 등급으로 옮기는 변환표는
  [`references/executor-routing.md`](references/executor-routing.md)가 소유한다.

실행 보고에 남길 항목과 실행 중 승격 처리는 같은 참조 문서를 따른다.

이 단계는 `index.json`의 **모든 미완료 phase를 순서대로 구현·검증·atomic commit할 때까지 반복**한다.
개별 phase 완료는 commit 경계이지 code-reviewer·docs-verifier 호출 경계가 아니다.
code-reviewer와 docs-verifier는 모든 phase 구현이 끝난 누적 diff를 검증한다.
단, 진행을 막는 결함의 원인 확인이 필요하면 조기 자문을 받을 수 있으며 그 결과는 최종 reviewer verdict를 대체하지 않는다.

구현자 공통 규칙이다.

- phase 를 순서대로 구현하고, 완료 후 성공 기준을 검증한다.
- 코드 주석 규칙은 레포 `CLAUDE.md` 를 따른다.
- 위 "구현자 cwd 격리" 와 "구현자 scope 확장 보고" 를 지킨다.

**모드 A 전용** — 스폰이 있을 때만 발동한다.

- **phase 단위 spawn → shutdown 사이클** (4개 이상 phase 에서 필수)
    - 3 phase 이하는 executor 를 한 번만 스폰해 재사용한다 (다음 phase 는 `SendMessage` 로 지시).
      모드 B 에서 전환된 phase 처럼 모드 A 가 소규모로 켜지는 경우가 여기 해당한다.
    - 한 phase 완료·커밋 후 그 executor 를 **반드시 종료한 뒤** 다음 phase 를 새 이름(`executor-p{N}`)으로 스폰한다.
    - 이유: 컨텍스트를 분리하고, 이름 충돌과 auto-deliver 누락을 피한다.
    - 종료 방법: `SendMessage({to, message:{type:"shutdown_request"}})` 또는 `TaskStop`. 종료를 확인한 뒤 다음 executor 를 스폰한다.
    - **종료를 빠뜨리면 phase 마다 executor 가 누적된다** (8-phase task 에서 팀원 8개 잔존 관측). 다음 스폰 직전에 이전 executor 종료를 매 phase 강제한다.
- **커밋은 team-lead 가 한다** — executor 는 커밋하지 않고 완료·실패를 `SendMessage` 로 보고한다.
- 위 두 구현자 가드 문구를 스폰 프롬프트에 그대로 포함한다.

**phase 단위 atomic commit**: 한 phase 완료·검증 후 team-lead 가 그 phase 만 commit 한다.

- commit 전 `git status` 로 staged 전체를 점검해 관심사가 섞이지 않게 한다.
- 모드 A 에서 executor 가 staging 해 둔 무관한 변경이 딸려올 수 있다. 섞였으면 `git reset` 후 명시적으로 add 하거나 경로를 한정해 commit 한다.

phase commit 전 특이사항 4종에서 회고 가치가 있는 사건을 `docs/retrospectives/<NNNN>-<slug>.md`로 기록하고 `INDEX.md`를 갱신한다.
신규 회고가 없으면 파일을 만들지 않고 phase 보고에 `신규 회고 없음`을 명시한다.

### 7. 코드 품질 검사 (code-reviewer)

모든 phase 의 구현·검증·atomic commit 이 끝난 뒤, team-lead 가 code-reviewer 를 새로 스폰해 누적 구현 전체 검사를 지시한다.
team-lead 가 직접 검사하지 않는다 — 건너뛰기를 막기 위해서다.
phase마다 code-reviewer를 반복 호출하지 않는다.

- **검사 범위**: 이번 plan 이 변경한 파일만. 범위는 **3-dot** 으로 잡는다 — `git diff --name-only origin/main...HEAD`.
    - 2-dot(`origin/main..HEAD`)은 worktree 분기 후 origin/main 에 들어온 외부 커밋까지 끌어와 false positive 를 만든다.
    - 실제로 무관한 차이 50여 건이 섞여 reviewer 판정이 오염된 사례가 있다.
- **검사 항목을 본문에 나열하지 않는다** — 오버레이가 지정한 반복 함정 목록에서 관련 패턴을 골라 grep 으로 점검하도록 지시한다.
- **전부 보고 지시**: 심각도로 자체 필터링하지 말고 발견한 것을 전부 올리라고 지시한다. "중대한 것만" · "보수적으로" 같은 지시는 문자 그대로 따라 실제 결함 보고까지 줄인다.
- **설계 맥락 첨부**(판정 참고용): plan 이 의도한 raw 패턴, helper 를 우회한 사유, 범위 밖 placeholder 를 1-2줄로 요약해 붙인다.
    - reviewer 가 보고를 생략할 근거가 아니라, team-lead 가 분류할 때 쓰는 자료다.

**필터는 team-lead 의 별도 패스** — reviewer 보고 전체를 받아 셋으로 분류한다.

- (a) 실제 결함 — 이것만 `FIX_NEEDED` 로 되돌린다.
- (b) 의도된 설계
- (c) 범위 밖 후속

(b)·(c) 는 버리지 말고 특이사항 4종에 합쳐 보고한다.

판정: **PASS** → 8단계. **FIX_NEEDED** → 구현자 재투입 후 재검사 (한도 2회. 모드 A 는 executor 재스폰, 모드 B 는 team-lead 직접 수정).

`FIX_NEEDED`이면 수정에 들어가기 전에 독립 회고 파일을 만들고 `status: open`으로 둔다.
재검사 후에는 같은 파일에 해결 commit·검증 근거를 추가하고 `status`를 갱신하며, 발견 기록을 삭제하거나 성공 결과로 덮어쓰지 않는다.

### 8. docs-verifier 검증

code-reviewer PASS 와 review fix 가 끝난 뒤 docs-verifier 를 스폰해 최종 HEAD 기준으로 **한 번만** 정합성을 판정한다 (self-shutdown 시 재스폰, 즉시 지시).
phase마다 호출하거나 사전 검토·최종 검증으로 나눠 두 번 돌리지 않는다 — 같은 diff 를 두 번 읽는 비용만 늘고 유효한 판정은 최종 HEAD 것뿐이다.
docs 불일치를 더 일찍 잡아야 하면 별도 사전 pass 를 만들지 말고 7단계 code-reviewer 지시에 docs 축을 얹는다. 검증 관점:

1. 설계 결정(ADR 등) 위반 여부.
2. 레이어·코딩 규칙 준수 (레포 `CLAUDE.md` 참조).
3. docs 갱신이 필요한지, 의사결정 의도가 보존됐는지 본다.
   planning 이 관리하는 필수 문서(`prd`·`flow`·`code-architecture`·`data-schema`·`adr`)와 오버레이가 추가한 문서가 최종 코드와 맞는지 확인한다.
4. **문서 부패 검증**: 코드에서 제거·변경된 기능이 docs 에 dead reference 로 남아 있는지 (`grep -rn` 로 검출).

docs-verifier 전용 에이전트가 도메인 검증 항목 전체를 보유하면 SKILL 은 위임만 하고 항목을 반복하지 않는다.

판정: **PASS** → 9단계. **UPDATE_NEEDED** → docs 업데이트 후 재검증 (한도 2회). **VIOLATION** → 코드 수정 (구현자 재투입, 한도 2회).

### 9. 완료, PR 생성, 팀 종료

1. team-lead 가 누적 commit 을 검토한다 — phase 별 commit 이 의도대로 들어갔는지, 마지막 phase commit 에 완료 마킹이 포함됐는지 확인.
2. **통합 검증** — 레포 CLAUDE.md·오버레이의 검증 명령을 실행해 모든 phase 누적 후에도 통과하는지 확인한다.
3. **검증 실패 시 분기**(필수) — 실패 원인 파일과 변경 파일을 매칭해 책임을 분류한다. 자의적으로 plan PR 에 외부 잔존 깨짐 fix 를 흡수하지 않는다.
   - **plan 범위 내**: 본 plan 변경 파일에서 실패 → 구현자 재투입. 사용자 결정 불필요.
   - **plan 범위 밖**: 실패 원인이 변경하지 않은 파일에 있다 (`git diff origin/main -- <파일>` 이 비어 있으면 main 자체가 깨진 것).
       사용자에게 세 가지를 제시하고, 무엇을 골랐는지 PR 설명에 남긴다.
       - A: 이 PR 에 fix 를 흡수한다.
       - B: 별도 hotfix PR 을 만든 뒤 rebase 한다.
       - C: 그대로 PR 하고 설명에 의존 관계를 밝힌다.
4. **완료 마킹은 PR 브랜치 안에서만** — 마지막 phase commit 에 포함하는 것이 가장 좋고, 브랜치 안 별도 commit 이 차선이다.
   **main 직접 커밋·푸시는 금지**한다. 진실의 출처가 둘로 갈라지고 push 충돌 위험이 있다.
   재실행 방지는 사전 검증이 담당하므로 main 을 건드릴 이유가 없다.
5. push 후 PR 생성·갱신 (오픈 PR 없으면 신규, 있으면 갱신). base 는 `main`, head 는 `plan{N}-<slug>` 다.
   이 PR 하나에 **planning 의 docs·tasks 커밋과 구현 phase 커밋이 함께** 담긴다 — 기획부터 구현까지가 하나의 완결된 변경으로 남는다.
   PR 제목·body 형식은 레포 커밋 컨벤션을 따르고, 기획 커밋과 phase 별 commit 을 구분해 나열한 뒤 "특이사항 및 후속" 섹션을 포함한다.
   PR diff에 다른 plan의 task·구현이 섞였으면 생성하지 말고 브랜치 범위를 정리한다.
6. **팀 종료** — 남아 있는 팀원 전부에 `shutdown_request`(또는 `TaskStop`)를 보내고 종료를 확인한다.
   대상은 `executor`·`executor-p{N}`·`critic`·`code-reviewer`·`docs-verifier` 다.
   phase 단위 사이클에서 종료되지 않은 executor 가 있으면 여기서 일괄 정리한다.
7. **worktree 정리** — PR 생성·갱신과 원격 push 가 끝난 뒤에 한다.
   - worktree 가 깨끗하고 로컬에만 있는 commit 이 없는지 확인한다.
   - 제거 대상 worktree 내부를 cwd 로 둔 채 실행하지 않는다. 기본 checkout 이나 다른 안전한 cwd 로 옮긴 뒤 `git worktree remove <절대경로>` 를 실행한다.
   - `git worktree list` 로 제거를 확인한다. 잠긴 worktree 나 미커밋 변경이 있으면 remove 가 실패하는데, 확인하지 않으면 그 실패가 묻힌다.
   - PR 브랜치는 유지한다. 브랜치 삭제는 머지 후 사용자 요청이 있을 때만 한다.
8. **실행 기록 한 줄 추가** — `docs/retrospectives/RUNS.md` 에 이번 실행의 결과를 남긴다.
   REVISE·FIX_NEEDED·docs-verifier 판정 횟수와 사용자 개입 횟수를 적는다.
   중단된 실행도 기록한다. 형식은 [`references/run-record.md`](references/run-record.md) 를 따른다.
9. 특이사항과 신규 노하우를 모아 사용자에게 보고한다.
   보고 첫 줄에 **PR 번호와 리뷰 반영 명령**을 적는다.
   worktree 를 정리한 뒤라 cwd 브랜치가 `main` 이어서, 후속 스킬이 PR 을 자동으로 찾지 못하기 때문이다.

   ```
   PR #<번호> 생성 완료 — 리뷰 반영은 /review-fix <번호>
   ```
10. 사용자가 PR 을 머지하면 완료 상태가 main 에 자동 반영된다. main 후속 작업 0개.

## worktree 기반 격리 실행

작업 간 충돌을 막기 위해 git worktree 를 쓴다.
worktree 는 프로젝트 내부 `.claude/worktrees/` 아래에 만든다.
`.gitignore` 에 `.claude/worktrees/` 가 등록돼 있어야 한다.

- **경로 철자 엄수**: worktree 루트는 정확히 `.claude/worktrees/` 다.
    - 자동완성 오타(`.claire-worktrees` 등)로 비슷한 철자의 디렉터리가 생기면 후속 검증이 깨진다.
      실제로 `.claire-worktrees/plan011-...` 가 남아 ESLint 에러를 냈다.
    - worktree 생성 전후로 `.claude` 외의 `.cla*` 디렉터리를 찾아 명백한 오타는 즉시 제거한다.
- **cwd 추적**: task 파일 수정·commit·검증 시 자신의 shell cwd 가 main repo 인지 worktree 인지 매번 `pwd` 로 확인한다.
    - 같은 상대경로가 cwd 에 따라 다른 파일을 가리켜, main repo 의 task 를 실수로 건드릴 수 있다.
    - commit 전에 main repo 와 worktree 양쪽 `git status` 를 함께 본다.
- **base**: worktree 는 **원격 `plan{N}-<slug>` 브랜치 기반**으로 분기한다.
    - planning 의 docs·tasks 커밋이 그 위에 있어야 task 를 읽을 수 있다.
    - 구현 커밋이 같은 브랜치에 쌓여 PR 1개로 닫힌다.
- **base 신선도**: plan 브랜치가 원격 main 보다 뒤처졌으면 worktree 분기 전에 갱신한다.
    - 방법: `git rebase origin/main` 후 `git push --force-with-lease`.
    - 오래된 base 위에서 구현하면 그사이 머지된 docs 와 코드가 어긋난다.
    - PR 이 아직 없는 시점이라 rebase 로 잃을 것이 없다.
- **환경 setup**: worktree 생성 후 의존성 설치·환경 파일 준비(예: gitignore 된 env 파일 공유)는 레포마다 다르므로 **오버레이·CLAUDE.md 절차**를 따른다.

정리 시점·위치와 브랜치 보존은 9단계 7항이 소유한다.

## 실패 복구

phase 가 실패하면 team-lead 가 원인을 분석한다.
phase 자체를 고쳐야 하면 critic 재평가(5단계)로 돌아가고, 단순 에러면 그 phase 를 다시 구현한다.
모드 A 는 executor 보고로 실패를 받고 재실행을 지시한다. 모드 B 는 team-lead 가 검증 실패를 직접 확인한다.

## 노하우 누적 (세션마다 보강)

실행 중 원시 회고는 `docs/retrospectives/`에 사건별 독립 파일로 누적한다.
매 실행 후 그중 **재발 방지 가치 있는 것**만 1-2줄 규칙으로 승격한다.

누적할 가치가 있는지는 네 가지로 판단한다.

- 다시 일어날 수 있는 패턴이나 프로세스 결함인가.
- 한두 단어로 추상화할 수 있는가.
- 재발했을 때 grep·test·build 로 검출할 수 있는가.
- 팀원의 일반적인 행동에 영향을 주는가.

1회성 오타나 특정 plan 에만 해당하는 메모는 누적하지 않는다.

**누적 위치는 레포마다 다르다.** 구체 경로와 형식은 **오버레이·CLAUDE.md** 를 따른다.

| 종류 | 누적 위치 |
|---|---|
| critic 반복 지적 | 오버레이가 지정한 반복 함정 목록 |
| 프로세스 결함 | 이 SKILL.md 의 해당 섹션 |
| 도메인 결정 | 레포 ADR |
| 코딩 규칙 | `CLAUDE.md`·`AGENTS.md` |

오버레이에 별도 경로가 없으면 `docs/retrospectives/`와 그 `INDEX.md`를 회고 단일 소스로 사용한다.
`tasks/`에는 계획·phase·상태만 두고 회고를 저장하지 않는다.
회고는 승격 여부와 무관하게 보존한다.
`docs/pitfalls` 의 엄격한 축적 기준을 통과하지 못했다는 이유로 버리지 않는다.

PR 생성 후 worktree 정리 직전, 사용자에게 "이번 세션 누적 노하우" 를 1-3줄 보고한다. 누적 안 했으면 "신규 노하우 없음" 으로 명시한다.
