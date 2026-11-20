---
name: docs-refresh
description: |
  fos-skills 저장소의 설명 문서(루트 README, docs/contributing.md, docs/flow.md, docs/code-architecture.md, docs/data-schema.md, 스킬 README, 보드 README)를
  지금 코드와 매니페스트에 맞추고, README 에는 처음 보는 사람이 알아야 할 핵심만 남겨 문서 PR 로 올린다.
  "README 가 너무 길다", "README 읽기 어렵다" 같은 요청에도 쓴다.
  "문서 최신화", "README 맞춰 줘", "설명 문서 갱신", "docs-refresh", "DOCS-DRIFT 고쳐 줘" 같은 요청이나
  `orch doctor` 가 `DOCS-DRIFT` 줄을 냈을 때 이 저장소에서 쓴다.
  다른 저장소의 문서 감사와 승인받고 고치는 일반 감사는 플러그인의 `docs-audit` 이 맡는다.
---
# docs-refresh

**목표: 설명 문서가 원본과 어긋난 자리를 모두 고치고 가독성 검사를 통과한 문서 PR 이 열려 있고, PR 본문에 발견마다 근거가 있다.**

- 원본이 맞고 문서를 고친다. 어느 문서가 어느 원본을 따르는지는 [`references/sources.md`](references/sources.md) 가 소유한다.
- 문서마다 담을 것은 [`references/readability.md`](references/readability.md) 가 소유한다. README 는 처음 보는 사람이 알아야 할 핵심만 담고, 상세는 `docs/` 와 스킬 README 에 둔다.
- 중간에 사용자에게 묻지 않는다. 사용자가 PR 을 리뷰하는 것이 승인이다(사용자 결정 2026-11-20).
- 문장이 낡았는지 판정하는 일반 감사는 `docs-audit` 에 맡긴다. 이 스킬은 그 절차를 다시 쓰지 않는다.

## 워크플로우 개요

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 자동 대조 | `check-drift.ts` 를 돌려 종료 코드(0 또는 1)와 `DOCS-DRIFT` 줄을 남겼다 | `references/sources.md` |
| 2 | 의미 감사 | docs-audit 의 1~3단계를 오버레이 범위로 돌았고, 발견마다 근거가 있다 | `.claude/docs-audit-overlay.md` |
| 3 | 고치기 | `check-drift.ts` 종료 코드가 0 이고 저장소 검사가 통과한다 | `references/sources.md` |
| 4 | 가독성 | 고친 문서마다 `check-readability.ts` 와 `check.ts` 가 0 이고, 담을 것 표와 분량 구간으로 본 발견을 고쳤다 | `references/readability.md` |
| 5 | 문서 PR | main 대상 PR 이 열렸고 본문에 발견과 근거가 있다 | |

doctor 알림을 아직 설치하지 않은 PC 면 아래 「doctor 알림 설치」 를 한 번 한다.

### 1. 자동 대조

```bash
# cwd: 저장소 루트
node .claude/skills/docs-refresh/scripts/check-drift.ts
```

줄마다 `DOCS-DRIFT <문서>:<줄> <무엇이 다른지>` 다. 종료 코드는 0(없음), 1(있음), 2(실행 실패)다.
2 면 stderr 의 이유를 고치고 다시 돈다. 2 인 채로 다음 단계로 가지 않는다. 대조하지 않은 것을 맞다고 보게 된다.
출력을 PR 본문에 그대로 붙일 수 있게 남긴다.

### 2. 의미 감사

docs-audit 스킬을 연다. 범위, 검증 명령, 코드 대조 grep 은 `.claude/docs-audit-overlay.md` 에 있다.
docs-audit 의 1단계(범위 판정), 2단계(정적 검사), 3단계(의미 검사)만 돈다.
4단계의 사용자 승인은 이 스킬의 5단계 PR 리뷰로 대신한다. 발견은 docs-audit 의 리포트 형식으로 모아 PR 본문에 쓴다.

의미 검사에서는 `references/sources.md` 에서 「대조」 가 「의미」 인 행을 원본과 하나씩 읽어 맞춘다.
1단계의 `DOCS-DRIFT` 줄은 다시 판정하지 않는다.

### 3. 고치기

- 문서를 원본에 맞춘다. 원본이 틀려 보이면 원본을 고치지 않고 PR 본문의 「따로 볼 것」 에 적는다. 문서 PR 이 동작을 바꾸지 않게 하려는 것이다.
- 개수(스킬 수, 명령 수)를 새로 적지 않는다. 원본을 가리킨다.
- `check-drift.ts` 가 잘못 걸었으면 문서를 고치지 않고 스크립트 규칙을 고친다. 그 규칙에 테스트를 더한다.
- 스킬 README 를 고치면 `docs/contributing.md` 「스킬 README」 의 형식을 지킨다.

```bash
# cwd: 저장소 루트
node .claude/skills/docs-refresh/scripts/check-drift.ts
node scripts/run-tests.ts scripts/tests .claude/skills/docs-refresh/tests
```

### 4. 가독성

원본과 맞춘 문서가 처음 읽는 사람에게 읽히는지 본다. 고친 Markdown 파일마다 [`references/readability.md`](references/readability.md) 의 「검사」 를 돌고, 「문서마다 담을 것」 표에 맞춰 넘치는 내용을 옮긴다.
README 의 절 뼈대는 1단계의 `check-drift.ts` 가 이미 봤다. 여기서는 문단과 표가 한 가지씩만 담는지를 본다.
내용을 옮겼으면 3단계의 명령을 다시 돈다. 옮긴 절을 가리키던 링크가 깨졌을 수 있다.

### 5. 문서 PR

`docs/` 로 시작하는 브랜치에서 문서 변경만 커밋하고 main 대상 PR 을 연다. 스크립트 규칙을 고쳤으면 그 커밋은 따로 나눈다.
본문 양식은 `ai-sdt:create-pr` 를 따르고, 아래 셋을 넣는다.

- 1단계 출력 전체와, 줄마다 고친 방법
- 2단계 발견. 발견마다 문서 `파일:줄`, 원본, 고친 내용
- 4단계에서 옮긴 절과 옮긴 곳, README 의 전후 줄 수
- 따로 볼 것. 원본이 틀려 보이는 자리와, 고치지 않고 둔 발견과 그 이유

## doctor 알림 설치

`orch doctor --run` 이 부르는 `session-resume` 핸들러로 어긋남을 한 줄로 알린다. 출력은 `[hook session-resume] DOCS-DRIFT <N>건. …` 꼴이다.
orch 루트(`.orch/`)는 git 이 무시해 핸들러를 커밋할 수 없다. PC 마다 주 checkout 에서 한 번 설치한다.

```bash
# cwd: 주 checkout 루트
node .claude/skills/docs-refresh/scripts/install-hook.ts --orch-dir "$(orch paths root)"
```

- `INSTALLED`, `UP-TO-DATE` 면 끝이다. 핸들러는 주 checkout 의 `check-drift.ts` 를 부르므로 규칙이 바뀌어도 다시 설치하지 않는다.
- `HANDLER-EXISTS` 면 다른 `session-resume` 핸들러가 있어 덮지 않았다. 그 핸들러 끝에 `hooks/session-resume.ts` 의 호출 부분을 옮겨 붙인다.
- 알림은 `--run` 을 준 doctor 에서만 난다. 스킬을 열 때의 `orch doctor` 는 이벤트를 내지 않는다(`skills/orch/references/hooks.md` 「이벤트 고르기」).
