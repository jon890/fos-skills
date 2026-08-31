# fos-skills

여러 레포가 공유하는 공용 Claude Code 스킬의 단일 소스.

워크플로 개선은 여기 한 곳만 고치면 심링크로 연결된 전 프로젝트에 반영된다.
레포마다 다른 부분은 각 프로젝트의 오버레이 파일로 주입한다.

## 구조

```
fos-skills/
  harness-cleanup/          # 현재 모델 기준 하네스 지시 교정
    SKILL.md
    CHANGELOG.md
    references/audit-axes.md
    references/judgment.md
    scripts/*.sh, scripts/*.py
  planning/                 # 구현 전 8단계 설계 워크플로
    SKILL.md
    CHANGELOG.md
    task-create.md
    references/step-*.md
    scripts/verify-task.sh
  build-with-teams/         # task 를 팀 에이전트로 실행해 PR 까지
    SKILL.md
    CHANGELOG.md
    references/
  review-fix/               # PR 리뷰 반영
    SKILL.md
    CHANGELOG.md
  pr-review/                # 남의 PR 에 리뷰 작성·등록
    SKILL.md
    CHANGELOG.md
    references/
    scripts/gh-review-*.sh, scripts/render-comments.py
  docs-check/               # docs 6축 감사
    SKILL.md
    CHANGELOG.md
    references/six-axis.md
    scripts/static-check.sh
  content-preview/          # 외부 게시 본문 미리보기
    SKILL.md
    CHANGELOG.md
    scripts/show-preview.sh
    scripts/dooray-preview/, scripts/github-preview/
    references/work-writing-persona.md
  evaluation/               # 스킬 자체 측정
    rubric.md
    score.sh
    baseline-*.md
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
| `harness-cleanup` | 현재 모델 역량과 실측 이력으로 하네스 지시를 감사하고 승인 후 교정. 측정·검출 검증·강제 여부 확인을 스크립트로 실행 |
| `planning` | 새 기능·변경 구현 전 8단계 설계 → docs 정비 → task 생성 |
| `review-fix` | PR 봇 리뷰(🔴/🟡)를 우선순위대로 반영 → 스레드 resolve → commit·push. 검증·커밋 규칙은 레포 CLAUDE.md 참조 |
| `pr-review` | 남의 PR 에 근거와 등급을 갖춘 리뷰를 작성 → 미리보기 → 등록·검증. 호스트·등급 표기·후속 업무 등록처는 레포 오버레이 |
| `build-with-teams` | task(index.json+phase)를 팀 에이전트로 phase 단위 실행 → critic·review·docs-verifier 검증 → PR. 검증 명령·에이전트·스키마는 레포 오버레이/CLAUDE.md |
| `docs-check` | docs 6축 감사(부패·과대화·추론성·중복·자명성·가독성) → 승인 후 수정. docs 구조·docs-verifier 에이전트는 레포 오버레이/CLAUDE.md |
| `content-preview` | 외부에 나갈 본문을 등록 전 렌더링 HTML 로 보여주고 자가 점검. Dooray·GitHub 생성기와 업무 글 페르소나 포함 |

## 버전과 변경 이력

각 스킬은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 디렉터리의 `CHANGELOG.md` 로 이력을 남긴다.

**이 버전은 배포 핀이 아니다.** 소비 방식이 심링크라 모든 프로젝트가 항상 최신을 쓴다.
특정 버전에 고정할 수단이 없으므로, 버전의 목적은 무엇이 언제 왜 바뀌었는지 추적하는 것뿐이다.
이 점을 잊으면 태그와 릴리스까지 붙는 과설계로 간다.

올리는 기준은 셋이다.

| 등급 | 언제 | 예 |
|---|---|---|
| major | 워크플로 단계가 바뀌어 기존 오버레이나 task 형식과 안 맞는다 | 단계 수를 8에서 6으로 줄인다 |
| minor | 지시를 추가하거나 제거한다 | 스폰 폴백 단계화를 넣는다 |
| patch | 문구만 다듬는다 | 표현을 고치고 오타를 바로잡는다 |

규칙 두 가지를 지킨다.

- 저장소 루트에는 CHANGELOG 를 두지 않는다. 갱신 지점이 갈려 한쪽이 먼저 낡는다.
- git 태그는 만들지 않는다. 심링크 소비에서는 태그가 아무것도 고정하지 못한다.

`evaluation/` 은 스킬이 아니라 측정 도구라 버전을 붙이지 않는다.
이력은 `baseline-<날짜>.md` 파일이 대신한다.

## 스킬이 나아졌는지 재는 법

세 층으로 나눠 본다. 하나로 합치면 어느 층이 나빠졌는지 보이지 않는다.

| 층 | 무엇을 보나 | 어떻게 |
|---|---|---|
| 문서 위생 | 끊긴 참조, 표기 위반, 본문 분량 | `evaluation/score.sh` |
| 실행 결과 | REVISE·FIX·개입 횟수의 추세 | 각 레포의 `docs/retrospectives/RUNS.md` |
| 정성 판단 | 지침 정렬, 강제력, 계층 분리 | `evaluation/rubric.md` 를 독립 에이전트에 |

**체감과 가장 직결되는 것은 실행 결과의 개입 횟수**다.
스킬이 나아졌다는 것은 결국 사용자가 덜 끼어들어도 됐다는 뜻이다.

점수를 목표로 삼지 않는다 — 올리려고 문서를 다듬으면 규칙을 우회하는 방향으로 변형된다.
자세한 기준과 함정은 `evaluation/rubric.md` 를 본다.

## 주의: 전역 스킬이 프로젝트 스킬보다 우선한다

Claude Code 는 같은 이름의 스킬이 여러 위치에 겹치면 **개인 전역(`~/.claude/skills`)이 프로젝트(`<repo>/.claude/skills`)보다 우선**한다.
공식 문서 `skills.md` 의 "personal overrides project" 규칙이다.

즉 이 전역 `planning` 코어는, **자체 `planning` 스킬을 저장소 안에 따로 둔 다른 프로젝트를 내 로컬 머신에서 가린다.**

영향 범위:

- **내 로컬 머신 한정.** 다른 사람은 이 전역 스킬이 없으니 각 프로젝트의 자체 planning 을 그대로 쓴다.
- 내가 그런 프로젝트에서 `/planning` 을 부르면 그 프로젝트 전용 대신 이 개인 코어가 뜬다 (오버레이가 없어 도메인 중립으로 동작).

해결 (그 프로젝트에서 실제로 `/planning` 이 필요해질 때):

- 그 프로젝트의 자체 planning 을 다른 이름(예: `planning-<프로젝트>`)으로 바꿔 충돌을 없앤다.
- `skillOverrides: {"planning": "off"}` 는 그 이름을 통째로 숨길 뿐 프로젝트 쪽 스킬을 대신 띄워주지 않으므로 가림막 용도로 쓰지 않는다.

당장 그런 프로젝트에서 planning 을 쓰지 않으면 그대로 두고, 실제로 필요해질 때 위 방법으로 정리한다.
