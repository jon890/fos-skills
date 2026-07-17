---
name: planning
description: 새 기능·변경사항을 구현하기 전 8단계 설계 워크플로우를 수행하는 공용 코어 skill. 구현 가능성 → 기술 스택 → 호출/사용자 흐름 → 인터페이스 → 데이터/스키마 → 코드 구조 → docs 영향 → task 생성 순으로 모호함을 제거하고 의사결정을 기록한다. 각 단계를 ledger·게이트·announce 로 강제하고 단계 역할은 references/step-*.md 로 분리한다. "/planning", "계획 세워보자", "설계해보자", "plan 세워줘", "기획해줘", "task 파일 만들어줘", "구현 전 검토", "새 기능 설계", "리팩토링 계획", "design", "plan this" 같은 요청 시 반드시 이 스킬 사용. 레포별 특화(도메인 단계·docs 컨벤션·검증)는 레포 오버레이로 주입된다.
---

# planning

새 기능·변경을 구현하기 전, 모호함을 모두 없애고 문서를 정비한 뒤 실행(build)으로 넘기는 8단계 설계 워크플로.

이 스킬은 **여러 레포가 공유하는 단일 코어**다 (`~/personal/fos-skills/planning`, 글로벌 `~/.claude/skills/planning` symlink). 코어는 오케스트레이션·강제·공통 원칙만 담고, **각 단계의 역할·산출물은 `references/step-*.md`** 에, 레포별 특화는 오버레이에 둔다.

## 레포 오버레이 로딩 (필수 첫 단계)

`<repo-root>/.claude/planning-overlay.md` 가 있으면 **먼저 읽고** 코어보다 우선한다. 도메인 유형, 단계 3~6 변형, docs 컨벤션, 검증 경로, plan·branch 규칙, 실행 핸드오프를 채운다. 없으면 코어 기본값(도메인 중립).

## 핵심 원칙

- **모호함 제로**: 조금이라도 모호하면 사용자와 논의. 넘어가지 않는다.
- **AI 에이전트 관점**: 최종 문서는 AI 가 읽고 phase 로 구현 가능할 만큼 명확.
- **간결한 문서**: 의사결정 의도는 보존하되 코드로 확인되는 구현 상세는 뺀다.
- **선택지는 질문 도구로**: 추천안 첫 번째 + label 끝 `(추천)` + 트레이드오프. long-form 나열 금지.
- **질문 규율**: 깊은 모호함은 하나씩. 사실(파일·git·도구)은 직접 조회, 사용자에겐 결정만 묻는다.

## 모호함 능동 발굴 (모든 단계 필수)

각 단계는 산출물만 뽑고 넘어가지 않는다. **미명시·애매한 설계점을 능동적으로 캐내** 사용자와 토론해 확정한다.

- **능동 발굴** — 그 단계 reference 의 "캐낼 모호점" 을 하나씩 짚어, 명시 안 됐거나 해석이 갈리는 지점을 찾아낸다. "알아서 됐겠지" 로 지나가지 않는다.
- **추측 금지** — 명시 안 된 건 임의로 정하지 말고 **옵션 + 트레이드오프 + 추천안**으로 `AskUserQuestion`. 사용자만 답할 결정은 반드시 묻는다.
- **하나씩 토론** — 상호 의존·깊은 결정은 한 번에 하나씩. 얕은 다수 질문 금지.
- **확정 후 진행** — 그 단계에 남은 미해결 모호점이 **0** 이 되어야 게이트 통과. 하나라도 남으면 다음 단계로 못 간다.

이게 planning 의 핵심 가치다 — 구현 전에 모호함을 다 태워 없앤다.

## 단계 강제 (필수) — 뭉개기·건너뛰기 방지

과거 실패: 단계를 이름 없이 섞어 진행해 3·4단계(흐름·인터페이스)를 놓치고, 확정 전에 청사진·실행으로 앞서갔다. 아래로 강제한다.

1. **단계 ledger 생성** — planning 시작 시 `TaskCreate` 로 밟을 단계를 각각 task 로 만든다(규모에 따라 0~8 중 선택). 미완 단계가 눈에 남아 뭉개기를 막는다.
2. **단계 announce** — 매 응답 첫 줄에 `지금 N단계: <이름>` 표기. 사용자가 진행·누락을 본다.
3. **단계 진입 = reference 로드** — 각 단계 진입 시 `references/step-N-*.md` 를 읽고 **그 역할로** 수행. 코어의 한 줄 요약만 보고 진행하지 않는다.
4. **게이트** — 한 단계는 **사용자 확정**을 받아야 완료(task completed)된다. **확정 전에는 다음 단계·전체 청사진·docs 작성·task 생성·실행 금지.**
5. **합치기·건너뛰기는 규모 작을 때만, 사유 명시** — "이 변경은 작아 3·4 병합" 처럼 announce 에 밝힌다. 7단계(docs)만은 규모 무관 항상 수행.

## 동시성 안전 (여러 planning 병행 시)

여러 세션이 동시에 planning 하면 번호·문서·push 가 충돌한다. 방지:

- **branch-per-plan** — planning 을 **main 이 아니라 `plan{N}-<slug>` 브랜치**에서. docs+tasks 를 브랜치에 커밋 → PR 로 merge. 충돌은 merge 시점에 드러난다(silent 아님). (레포 branch 정책은 오버레이 우선.)
- **번호 선점** — 번호 부여 전 `git fetch` 후 `git branch -a` + `gh pr list --state open` 로 plan·ADR 번호를 원격까지 스캔 → 다음 가용 → **브랜치를 즉시 생성해 claim**. read-only 체크만 하면 두 세션이 같은 번호를 집는다.
- **공유 문서는 append 편집** — 새 ADR·phase 파일은 충돌 없음. README·data-schema 같은 공유 인덱스는 **끝에 행 추가**만(기존 행 재배열·중간 삽입 금지) → merge 깔끔.
- **ADR 번호** — 브랜치로 claim 안 되니 시작 시 원격까지 스캔, 충돌 나면 merge 때 재번호(최후).

## 실행 절차 (8단계)

각 단계는 진입 시 해당 reference 를 읽고 그 역할로 수행 → announce → 게이트(확정) → 다음.

| 단계 | 이름 | reference |
|---|---|---|
| 0 | 보정(선택) — 지식수준·압박강도 | `references/step-0-calibration.md` |
| 1 | 구현 가능성 (역할: CTO) | `references/step-1-feasibility.md` |
| 2 | 기술 스택 | `references/step-2-tech-stack.md` |
| 3 | 호출/사용자 흐름 (역할: 워크플로/UX) | `references/step-3-flow.md` |
| 4 | 인터페이스 설계 | `references/step-4-interface.md` |
| 5 | API/함수 설계 | `references/step-5-api.md` |
| 6 | 데이터/코드 구조 (역할: 데이터 모델러+CTO) | `references/step-6-data-code.md` |
| 7 | docs 영향 종합 + 기술 결정 기록 | `references/step-7-docs.md` |
| 8 | task 파일 생성 + 커밋 | `references/step-8-tasks.md` + `task-create.md` |

## 의사결정 누적 → 논의 완료 시 docs 반영

논의 중 결정은 대화 컨텍스트에 누적한다. 최종 docs 에 즉시 쓰지 않는다(중간 결정은 바뀔 수 있어 재작성·미확정 혼입). 논의가 끝나면 누적 최종 결정만 한 번에 docs 반영(7단계).

## self-review + task 검증 (생성 직후, 필수)

task 작성 직후·커밋 전: `references/step-8-tasks.md` 와 `task-create.md` 의 self-review(placeholder·모순·식별자 일관성) + `scripts/verify-task.sh plan{N}-{slug}`(5 패턴 0 줄) + 사람 판단 4 패턴. 위반은 질문 도구로 확인(임의 자동수정 금지).

## 완료 후 (필수)

1. docs 반영 확인(오버레이 지정 문서). 2. task 파일 확인. 3. verify-task + self-review. 4. **branch 확인**(오버레이 정책, 기본은 `plan{N}-slug` 브랜치). 5. commit(관심사 분리, 오버레이 규칙 우선). 6. push. 7. 사용자 보고 + 실행 명령 안내(오버레이).

**실제 phase 실행은 사용자가 실행 명령을 호출할 때 시작.** planning 은 task 생성 + push 까지.

예외: 논의만(docs·task 없음) → commit 생략 고지. force push 금지(새 커밋). main push 차단 → PR.

## plan 네이밍

- 번호 선점은 위 "동시성 안전" 참조(fetch → 원격 스캔 → 브랜치 claim).
- 서브넘버: 동일 기능 확장·동일 도메인 후속은 `plan003-2` 식으로 묶고, 독립 실행 가능하면 새 번호.

## 파일

- `SKILL.md` — 이 문서(오케스트레이터).
- `references/step-*.md` — 단계별 역할·필수 산출물·누락 체크리스트·게이트 기준.
- `task-create.md` — task/phase 작성 + 검증 명세.
- `scripts/verify-task.sh` — task 자동 검증 5 패턴.

## 의도적으로 안 하는 것

- 이 세션에서 phase 실행(생성까지만). 레포 특화를 코어에 하드코딩(오버레이로만). chat 에서 끝나는 결정(즉시 docs).
