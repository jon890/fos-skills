# 기여

이 저장소를 고치는 사람이 읽는 문서예요. 스킬을 쓰기만 하는 사람은 루트 [README](../README.md) 로 충분해요.

## 준비

체크아웃과 worker 워크트리에서는 먼저 루트 의존을 설치해요.

```bash
npm ci --ignore-scripts
```

플러그인 설치본은 Claude Code 가 의존을 설치해요([ADR-030](adr/030-plugin-npm-dependencies.md)).

## 테스트

테스트 명령은 둘이에요. 둘 다 저장소 루트에서 돌려요.

```bash
node scripts/run-tests.ts
claude plugin test .
```

- `node scripts/run-tests.ts` 는 Node 24 이상에서 node 테스트와 tsc 타입 검사를 함께 돌아요. CI 의 `Tests` job 도 같은 명령을 불러요.
- `claude plugin test .` 는 `claude-code/testing` 을 쓰는 TypeScript 테스트를 돌려요. 로그인이나 API 키가 필요하지 않아요. 위 명령에 들지 않으니 따로 돌려요.

`run-tests.ts` 는 아래 옵션을 받아요. 사용법 전체는 파일 맨 위 설명에 있어요.

| 하려는 일 | 명령 | 알아 둘 것 |
| --- | --- | --- |
| 한 파일이나 폴더만 | `node scripts/run-tests.ts skills/machine-cleanup/tests` | tsc 는 돌지 않아요 |
| 타입만 | `node scripts/run-tests.ts --tsc-only` | 테스트는 돌지 않고, 파일 인자와 함께 줄 수 없어요 |
| 동시 수 낮추기 | `node scripts/run-tests.ts --concurrency 4` | 기본은 CPU 수 이하, 최대 8이에요. worker 여럿이 함께 검증할 때 낮춰요 |
| 오래 걸릴 때 | `--background` 로 띄우고 `--wait` 로 기다리기 | 한 번의 `--wait` 는 Bash 도구의 600초 안에 끝나요 |

CI 는 PR 과 main push 에서 돌아요. Claude Code CLI 2.1.309 를 npm 으로 설치해 `claude plugin test .` 를 돌리고, 이어서 `node scripts/run-tests.ts` 를 돌려요.

## PR

- PR 은 draft 없이 main 으로 열어요.
- CI 의 `Tests` job 이 통과해야 머지해요.
- orch 를 쓰면 이 저장소의 고유 규칙은 각자의 `.orch/overlay.md` 에 둬요. git 이 추적하지 않고, 적는 법은 [orch 오버레이 문서](../skills/orch/references/overlay.md)가 정해요.
- 루트 README, `docs/`, 스킬 README 가 지금 동작과 어긋났으면 저장소 스킬 [`docs-refresh`](../.claude/skills/docs-refresh/SKILL.md) 로 고쳐 문서 PR 을 올려요. 플러그인에 넣지 않고 이 저장소에서만 떠요.

## 고치는 동안

설치본은 main 에 push 한 뒤에만 바뀌어요.
그래서 고치는 동안에는 작업 트리를 그 세션에만 로드해요.

```bash
claude --plugin-dir "$(git rev-parse --show-toplevel)"
```

설치 기록에 user 범위 설치본이 있으면 `orch` 실행기는 `--plugin-dir` 로 로드한 작업 트리가 아니라 설치본으로 넘겨요.
작업 트리의 orch 스크립트를 돌리려면 `ORCH_SCRIPTS_DIR` 을 줘요.

```bash
ORCH_SCRIPTS_DIR="$(git rev-parse --show-toplevel)/skills/orch/scripts" orch loop status
```

로드가 맞는지 확인하는 방법은 [고치는 동안의 확인](flow.md#고치는-동안의-확인) 에 있어요.

## 저장소 구조

| 경로 | 책임 |
| --- | --- |
| `skills/<이름>/` | 설치해서 쓰는 스킬. 절차·참조·양식·스크립트·테스트를 함께 둬요 |
| `export-only-skills/<이름>/` | 팀 저장소로 내보내는 원본. 플러그인 스킬로도 등록해요 |
| `extensions/work-board/` | 작업 현황 창과 보드 명령 |
| `scripts/` | 저장소 검사·설치·내보내기·버전 관리 |
| `githooks/` | 이 저장소를 개발할 때 쓰는 Git 훅 |
| `docs/` | 개발 흐름·아키텍처·ADR |
| `.claude-plugin/`, `.codex-plugin/` | 하네스별 배포 매니페스트 |

- 스킬 전용 훅과 스크립트는 그 스킬 안에 둬요. Git 훅과 Claude 실행 훅을 같은 폴더에 모으지 않아요.
- 스킬 이름과 호출 명령은 유지돼요. 플러그인은 갱신하면 새 배치를 받고, 직접 걸었던 개인 심볼릭 링크는 새 경로로 바꿔요.
- 옛 경로의 스킬 사본이나 호환 링크는 저장소에 남기지 않아요. 팀 내보내기는 팀의 `skills/<이름>/` 구조를 유지하고 상대 참조도 맞춰요.

## 공용 도구

스킬이 아닌 공용 도구는 그 도구를 소유한 스킬 폴더 안에 둬요.

| 도구 | 하는 일 | 쓰는 스킬 |
| --- | --- | --- |
| `skills/browser/browser-driver` | 브라우저 백엔드가 달라도 같은 명령으로 조작해요. 실패를 종료 코드로 드러내요 | `browser`, `content-preview`, `presentation` |

- `browser-driver` 의 소유자는 `browser` 스킬이에요. 팀 저장소에는 `skills/browser` 아래에 스킬과 함께 들어가요.
- 스킬은 이 도구를 저장소 안에서 찾고, 없으면 개인이 걸어 둔 것으로 내려가요.
- 이 플러그인의 루트 `bin/` 에는 orch 실행기 `orch` 하나만 있어요. `browser-driver` 는 PATH 명령으로 넣지 않아요. 근거는 [ADR-004](adr/004-no-plugin-bin.md) 에 있어요.

`extensions/work-board/` 는 작업 현황 창 `/board` 를 그리는 mod 예요.
orch 스킬이 보드를 고치는 `extensions/work-board/bin/board.ts` 도 여기 있어요. 동작은 [`extensions/work-board/README.md`](../extensions/work-board/README.md) 에 있어요.

`scripts/` 에는 이 저장소를 관리하는 명령과, 어느 스킬도 소유하지 않는 검사기를 둬요.
명령은 `node scripts/<이름>.ts` 로 불러요. 옵션과 종료 코드는 각 파일 맨 위 설명에 있어요.

| 스크립트 | 하는 일 |
| --- | --- |
| `scripts/export-to-team.ts` | 공용 스킬을 팀 저장소로 내보내고 어긋남을 확인해요. 커밋을 고르는 `--source-ref` 는 파일 맨 위 설명에 있어요 |
| `scripts/install-hooks.ts` | `githooks/` 의 훅을 `.git/hooks` 에 걸어요. `pre-commit` 은 스테이징된 변경 조각 형식을, `commit-msg` 는 커밋 메시지의 금지어를 커밋 전에 막고, `post-commit` 은 팀 저장소와의 어긋남을 알려요 |
| `scripts/run-tests.ts` | node 테스트와 tsc 를 함께 돌고 결과 폴더에 요약을 남겨요. 사용법은 위 「테스트」 에 있어요 |
| `scripts/runtime-policy.ts` | 남은 Python·셸 파일과 허용한 JS 진입을 `scripts/runtime-policy.json` 과 대조해 새 파일을 막아요. 새 스크립트는 TypeScript 로 써요([ADR-025](adr/025-script-runtime-typescript.md)) |
| `scripts/test-plugin-install.ts` | 격리된 설정 폴더에서 플러그인 설치를 테스트해요 |
| `scripts/check-skill-docs.ts` | 스킬 README 와 CHANGELOG, 변경 이력 조각이 아래 「스킬 README」, 「버전과 변경 이력」 의 형식을 따르는지 검사해요 |
| `scripts/skill_changes.ts` | 변경 이력 조각의 이름·내용 규칙과 조각으로 스킬 버전과 CHANGELOG 를 올리는 코드예요. 검사기와 `bump-plugin-version.ts` 가 같이 써요 |
| `scripts/bump-skill-major.ts` | 스킬 major 를 올려요. 버전 줄을 바꾸고 이전 major 절을 `## N.x` 한 절로 접고 새 major 절 머리를 만들어요. 기본은 미리보기, `--apply` 로 써요 |
| `scripts/render-development-loop.ts` | 루트 README 의 Mermaid 원본으로 손그림 SVG 를 다시 그려요 |
| `scripts/bump-plugin-version.ts` | main 에 들어온 변경 이력 조각과 변경으로 스킬 버전, 플러그인 version, `.claude-plugin/CHANGELOG.md` 를 올려요. `plugin-version.yml` workflow 가 불러요 |

## 흐름 그림 다시 그리기

루트 README 「흐름」 의 그림은 README 안의 Mermaid 원본 한곳에서 만들어요.
[렌더링 설정](diagrams/development-loop.config.json)이 손그림 스타일과 고정 seed 를 정해요.

```bash
node scripts/render-development-loop.ts --mmdc /path/to/mmdc
```

Mermaid CLI 12.2.0 을 준비한 뒤 위 명령으로 `docs/images/development-loop.svg` 를 갱신해요.
SVG 를 함께 저장해 GitHub 에서도 같은 손그림 모양으로 볼 수 있어요.

## 스킬을 더할 때

아래를 함께 고쳐요.

- `.claude-plugin/plugin.json` 의 `skills` 배열
- `.codex-plugin/plugin.json` 의 `skills` 배열. Codex 가 읽는 매니페스트라 hook 은 넣지 않아요([ADR-007](adr/007-codex-manifest-without-hooks.md))
- 루트 README 의 스킬 목록 표
- 팀에도 내보낼 스킬이면 `scripts/export-to-team.ts` 의 `SHARED_SKILLS`

두 `skills` 배열 가운데 하나라도 빠뜨리면 `node scripts/run-tests.ts scripts/tests` 가 실패해요.

## 코어와 오버레이

- **코어**(이 저장소): 도메인과 무관한 워크플로예요. 단계 뼈대, 핵심 원칙, 검증기가 여기 있어요.
- **오버레이**(각 프로젝트의 `.claude/plan-overlay.md`, `.orch/overlay.md` 같은 파일): 저장소 고유의 단계 변형, 문서 관례, 검증 경로, 실행 명령이 여기 있어요.

코어 SKILL 이 시작할 때 현재 저장소의 오버레이를 읽어 채워요.
오버레이가 없으면 코어 기본값으로 동작해요.

## 스킬 README

스킬 README 의 독자는 이 스킬을 처음 쓰려는 사람이에요. 이 저장소를 고치는 사람이 아니에요.
처음 읽는 사람이 무엇을 덜어 주는지, 어떻게 시작하는지, 어떻게 활용하는지를 README 하나로 알 수 있어야 해요.
이 규칙은 모든 스킬과 mod(work-board 처럼 SKILL.md 가 없는 구성 요소)에 똑같이 적용해요(사용자 결정 2026-11-03).

- **본문은 「~해요」 체로 써요.** 절 제목과 표, 목록 항목은 명사구로 끝내도 돼요.
- **처음 쓰는 순서를 먼저 보여요.** 설치, 부르는 말이나 여는 명령, 첫 결과를 번호 순서로 적어요.
- **활용법은 상황별로 보여요.** 「이럴 때 이걸 누르거나 부르면 이렇게 돼요」 처럼 실제 요청과 결과를 붙여요.
- **화면이 있는 기능은 스크린샷을 둬요.** 화면이 바뀌는 PR 에서 함께 새로 찍고, 찍은 날을 그림 아래에 적어요.
- **내부 동작의 세부는 README 에 두지 않아요.** 판정 규칙, 조회 한도, 저장 형식처럼 고치는 사람이 읽을 내용은 그 스킬의 `references/` 문서로 옮기고 README 에서 링크만 걸어요.

절은 아래 순서로 둬요. 필요하면 다른 절을 더해도 돼요.

| 절 | 담는 것 |
| --- | --- |
| 첫 문단 | 이 스킬이 덜어 주는 수고. 제목 바로 밑에 절 제목 없이 둬요 |
| `## 이럴 때 쓴다` | 쓰는 상황과 스킬을 부르는 말 |
| `## 처음 써 보기` | 설치부터 첫 결과까지의 순서. 스킬을 부르는 말 한 줄이면 되는 스킬은 「사용 예시」 로 대신해요 |
| `## 사용 예시` | 활용법. 상황별 요청, 스킬이 하는 일, 받는 결과를 짧게 보여요 |
| `## 받는 것` | 끝났을 때 사용자에게 남는 것 |
| `## 준비` | 설치, 로그인, 개인 설정이 필요할 때만 둬요 |
| `## 함께 쓰는 스킬` | 이 스킬이 맡지 않는 일과 그 일을 맡는 스킬 |

**파일 목록(`## 구성`)은 두지 않아요.**
실행 절차는 `SKILL.md`, 스크립트 동작은 각 파일의 docstring 과 `--help` 가 소유해요. README 에 한 벌 더 두면 한쪽만 고쳐져요.
테스트 실행 명령은 이 문서의 「테스트」 에 둬요.

## 버전과 변경 이력

각 스킬은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 디렉터리의 `CHANGELOG.md` 로 이력을 남겨요.

**스킬 버전은 배포 핀이 아니에요.** 무엇이 언제 왜 바뀌었는지 추적하는 데만 써요.
이 점을 잊으면 태그와 릴리스까지 붙는 과설계로 가요.

### 변경 이력 조각

**PR 은 스킬 버전과 CHANGELOG 를 직접 올리지 않아요.** 무엇이 바뀌었는지만 변경 이력 조각 파일로 남기고, 새 버전 번호는 main 에 머지될 때 workflow 가 정해요.
같은 스킬을 고치는 PR 이 여럿이어도 버전 줄과 CHANGELOG 절로 충돌하지 않게 하려는 것이에요. 근거는 [ADR-023](adr/023-version-at-merge.md) 에 있어요.

- 조각은 `<스킬 폴더>/changes/<슬러그>.<등급>.md` 예요.
  - `skills/<이름>`, `export-only-skills/<이름>`, `extensions/<이름>` 이 스킬 폴더예요.
  - 슬러그는 영문 소문자, 숫자, 하이픈이에요. 두 PR 이 같은 파일을 더하면 충돌하므로 브랜치 이름처럼 PR 마다 겹치지 않게 지어요.
- 등급은 파일 이름 끝의 `.patch.md` 나 `.minor.md` 둘뿐이에요. 기준은 아래 「등급 기준」 표를 따라요.
- 내용은 CHANGELOG 항목 그대로 `- ` 줄 1~5개예요. 제목과 버전은 적지 않아요.
- main 에 머지되면 `plugin-version.yml` 이 조각마다 버전 하나를 머지 순서대로 올려요.
  - CHANGELOG 맨 위에 `## X.Y.Z (한국 시간 날짜)` 절을 만들어요.
  - `SKILL.md` 의 `metadata.version` 도 바꾸고 조각을 지워요.
- 한 PR 이 같은 스킬에서 버전·CHANGELOG 를 직접 올리면서 조각도 더하지 않아요. 버전이 두 번 올라요.
- 조각이 없는 변경은 스킬 버전이 그대로예요. 플러그인 version 만 patch 로 올라요.

### major 올리기

**major 는 조각으로 받지 않아요.** 기존 사용법이 깨지면(`호환성:` 항목) PR 이 `metadata.version` 과 CHANGELOG 를 직접 올리고 이전 major 를 `## N.x` 한 절로 줄여요.

```bash
node scripts/bump-skill-major.ts "$SKILL" --note "$NOTE"
```

`SKILL` 은 스킬 이름, `NOTE` 는 깨지는 것이에요. 위 명령이 미리보기를 보이고 `--apply` 를 주면 버전 줄과 CHANGELOG 를 함께 고쳐요.
접은 절이 한도를 넘으면 `--summary` 로 직접 요약해 줘요. 이 방식으로 올린 스킬은 workflow 가 건드리지 않아요.

### 플러그인 버전

플러그인 버전은 `.claude-plugin/plugin.json` 의 `version` 이에요. **사람이 올리지 않아요.**
main 에 머지될 때마다 `.github/workflows/plugin-version.yml` 이 등급을 정해 올리고 `.claude-plugin/CHANGELOG.md` 에 한 줄을 더해요.
`호환성:` 항목이 있으면 major, 조각이나 새 버전 절이 있으면 minor, 그 밖은 patch 예요. 이 값이 바뀌어야 설치한 쪽의 `update` 가 새 복사본을 받아요.
근거는 [ADR-019](adr/019-plugin-version-auto-bump.md) 에 있어요.

### 등급 기준

| 등급 | 언제 | 예 |
| --- | --- | --- |
| major | 워크플로 단계가 바뀌어 기존 오버레이나 task 형식과 안 맞아요 | 단계 수를 8에서 6으로 줄여요 |
| minor | 지시를 추가하거나 제거해요 | 스폰 폴백 단계화를 넣어요 |
| patch | 문구만 다듬어요 | 표현을 고치고 오타를 바로잡아요 |

### CHANGELOG 쓰는 법

**CHANGELOG 에는 스킬을 쓰는 사람이 알아야 할 변화만 적어요.**

- 버전 하나는 `## X.Y.Z (YYYY-MM-DD)` 제목 밑에 목록 항목 몇 개로 써요. 새 명령, 바뀐 동작, 고친 문제가 여기 들어가요. 조각 파일의 내용이 이 항목이 돼요.
- 기존 사용법이 깨지면 그 항목을 `호환성:` 으로 시작해요.
- 경위, 실측 수치, 내부 리팩터링, 테스트 추가는 적지 않아요. 커밋 메시지와 PR 본문이 이것을 가져요.
- major 를 올리면 이전 major 의 버전들을 `## N.x` 한 절로 줄여요.

항목 수와 줄 길이의 상한은 `scripts/check-skill-docs.ts` 가 소유하고, `node scripts/run-tests.ts scripts/tests` 가 README 형식과 함께 검사해요.

이력을 두는 자리와 태그는 아래를 따라요.

- 저장소 루트에는 CHANGELOG 를 두지 않아요. 갱신 지점이 갈려 한쪽이 먼저 낡아요. 플러그인 이력은 workflow 만 쓰는 `.claude-plugin/CHANGELOG.md` 에 둬요.
- git 태그는 만들지 않아요. 설치한 쪽이 main 의 최신 version 을 받으므로 태그가 아무것도 고정하지 못해요.

## 링크로 설치

플러그인 시스템이 없는 에이전트에서는 스킬 디렉터리를 글로벌 스킬 디렉터리에 심링크해요.

```bash
ln -sfn ~/personal/fos-skills/skills/plan ~/.claude/skills/plan
```

플러그인과 같은 이름의 링크를 함께 두면 스킬이 둘씩 떠요.
링크에서 플러그인으로 옮기는 순서는 [링크 설치에서 옮기기](flow.md#링크-설치에서-옮기기) 를 따라요.

공용 도구를 전역에서도 부르려면 함께 걸어요.

```bash
ln -sfn ~/personal/fos-skills/skills/browser/browser-driver/browser_driver.ts ~/.claude/scripts/browser-driver
```

## 단계 이름 변경

- `planning` 은 `plan`, `build-with-teams` 는 `implementation` 으로 바뀌었어요. 예전 명령 대신 새 이름으로 불러요.
- 기존 계획 경로와 R1/D1 ID 는 읽기 호환으로 유지해요. 오버레이는 `.claude/plan-overlay.md`, `.claude/implementation-overlay.md` 로 이름을 바꿔요.
- 문서 감사는 `/fos-skills:docs-audit` 로 불러요. 옛 이름 `docs-check` 의 오버레이는 읽지 않아요. 남아 있으면 `.claude/docs-audit-overlay.md` 로 이름을 바꿔요.
