# fos-skills

여러 레포가 공유하는 공용 Claude Code 스킬의 단일 소스.

워크플로 개선은 여기 한 곳만 고치면 심링크로 연결된 전 프로젝트에 반영된다.
레포마다 다른 부분은 각 프로젝트의 오버레이 파일로 주입한다.

## 구조

```
fos-skills/
  planning/                 # 구현 전 8단계 설계 워크플로 (공용 코어)
    SKILL.md
    task-create.md
    scripts/verify-task.sh
```

## 설치 (글로벌 심링크)

각 코어 스킬을 글로벌 스킬 디렉터리에 심링크한다. 그러면 모든 프로젝트에서 사용 가능하다.

```bash
ln -sfn ~/personal/fos-skills/planning ~/.claude/skills/planning
```

## 코어 vs 오버레이

- **코어** (이 레포): 도메인 중립 워크플로 — 단계 뼈대, 핵심 원칙, 검증기.
- **오버레이** (각 프로젝트의 `.claude/planning-overlay.md`): 레포 특화 — 도메인 단계 변형, docs 컨벤션, 검증 경로, 실행 핸드오프 명령.

코어 SKILL 이 시작 시 현재 레포의 오버레이를 읽어 채운다. 오버레이가 없으면 코어 기본값으로 동작한다.

## 스킬 목록

| 스킬 | 역할 |
|---|---|
| `planning` | 새 기능·변경 구현 전 8단계 설계 → docs 정비 → task 생성 |
| `review-fix` | PR 봇 리뷰(🔴/🟡)를 우선순위대로 반영 → 스레드 resolve → commit·push. 검증·커밋 규칙은 레포 CLAUDE.md 참조 |
| `build-with-teams` | task(index.json+phase)를 팀 에이전트로 phase 단위 실행 → critic·review·docs-verifier 게이트 → PR. 검증 명령·에이전트·스키마는 레포 오버레이/CLAUDE.md |
| `docs-check` | docs 6축 감사(부패·과대화·추론성·중복·자명성·가독성) → 승인 후 수정. docs 구조·docs-verifier 에이전트는 레포 오버레이/CLAUDE.md |

## 주의: 전역 스킬이 프로젝트 스킬보다 우선한다

Claude Code 는 같은 이름의 스킬이 여러 위치에 겹치면 **개인 전역(`~/.claude/skills`)이 프로젝트(`<repo>/.claude/skills`)보다 우선**한다 (공식 문서 skills.md: "personal overrides project").

즉 이 전역 `planning` 코어는, **자체 `planning` 스킬을 저장소 안에 따로 둔 다른 프로젝트를 내 로컬 머신에서 가린다.**

영향 범위:

- **내 로컬 머신 한정.** 다른 사람은 이 전역 스킬이 없으니 각 프로젝트의 자체 planning 을 그대로 쓴다.
- 내가 그런 프로젝트에서 `/planning` 을 부르면 그 프로젝트 전용 대신 이 개인 코어가 뜬다 (오버레이가 없어 도메인 중립으로 동작).

해결 (그 프로젝트에서 실제로 `/planning` 이 필요해질 때):

- 그 프로젝트의 자체 planning 을 다른 이름(예: `planning-<프로젝트>`)으로 바꿔 충돌을 없앤다.
- `skillOverrides: {"planning": "off"}` 는 그 이름을 통째로 숨길 뿐 프로젝트 쪽 스킬을 대신 띄워주지 않으므로 가림막 용도로 쓰지 않는다.

당장 그런 프로젝트에서 planning 을 쓰지 않으면 그대로 두고, 실제로 필요해질 때 위 방법으로 정리한다.
