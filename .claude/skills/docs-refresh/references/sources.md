# 문서마다 맞춰야 할 원본

설명 문서의 각 자리가 어느 원본을 따라야 하는지 적은 표다.
문서가 원본과 다르면 원본이 맞고 문서를 고친다. 원본이 틀렸다고 보이면 문서 PR 에서 고치지 않고 PR 본문에 적는다.

「대조」 칸의 뜻은 이렇다.

- **자동**: `scripts/check-drift.ts` 가 대조하고 `DOCS-DRIFT` 줄을 낸다. 괄호 안은 그 파일의 검사 함수다.
- **의미**: 스크립트가 못 본다. 2단계 docs-audit 의 의미 검사에서 원본을 읽고 대조한다.

개수는 적지 않는다. 목록은 원본에서 읽는다.

## 루트 README

| 자리 | 원본 | 대조 |
| --- | --- | --- |
| 절 이름과 순서 | 사용자가 정한 뼈대([`readability.md`](readability.md)) | 자동(`checkReadmeOutline`) |
| 「스킬 목록」 표의 행 | `.claude-plugin/plugin.json` 의 `skills` | 자동(`checkSkillList`) |
| 「스킬 목록」 표의 「언제 쓰나」 | 각 스킬 `SKILL.md` 의 목표 줄과 `description` | 의미 |
| 「설치와 갱신」 의 명령 | `.claude-plugin/marketplace.json`, `docs/flow.md` 「설치」 | 의미 |
| 「기여」 의 명령 | `docs/contributing.md` 「준비」, 「테스트」, 「PR」 | 의미 |
| 문서 안의 `orch <묶음> <동작>` | `skills/orch/scripts/lib/commands.ts` 의 명령 표 | 자동(`checkOrchCommands`) |

## docs/contributing.md

| 자리 | 원본 | 대조 |
| --- | --- | --- |
| 「저장소 구조」 표의 경로 | 저장소의 실제 폴더 | 자동(`checkPaths`) |
| 「공용 도구」 의 `scripts/` 표 | 각 `scripts/*.ts` 의 머리 주석 | 경로는 자동(`checkPaths`), 설명은 의미 |
| 「테스트」 의 명령과 옵션 | `scripts/run-tests.ts` 머리 주석, `.github/workflows/` 의 CI 정의(Claude Code CLI 버전, Node 버전) | 의미 |
| 「버전과 변경 이력」 | `scripts/skill_changes.ts`, `scripts/bump-plugin-version.ts`, `.github/workflows/plugin-version.yml` | 의미 |

## docs/

| 문서와 자리 | 원본 | 대조 |
| --- | --- | --- |
| `docs/flow.md` 「이벤트 목록」 의 이벤트와 「거부」 칸 | `skills/orch/scripts/lib/events.ts` 의 `EVENTS` | 자동(`checkEvents`) |
| `docs/flow.md` 「이벤트 목록」 의 「내는 명령」 칸 | `skills/orch/references/hooks.md` 「이벤트 고르기」 표, 각 명령의 `fire(` 호출 | 의미 |
| `docs/flow.md` 「설치」, 「갱신」 | `scripts/test-plugin-install.ts`, `.claude-plugin/marketplace.json` | 의미 |
| `docs/code-architecture.md` 「디렉터리 배치」, 「모듈 책임」 의 경로 | 저장소의 실제 폴더와 파일 | 자동(`checkPaths`) |
| `docs/code-architecture.md` 「매니페스트」 의 JSON | `.claude-plugin/marketplace.json` | 의미 |
| `docs/data-schema.md` 「config.json 에 더하는 절」 의 절과 키 | `skills/orch/scripts/core/config.ts` 의 `SECTIONS` 와 절별 `*_KEYS`(queue 는 `QUEUE_LOOP_KEYS`) | 자동(`checkConfig`) |
| 같은 표의 타입과 기본값 | `skills/orch/scripts/core/config-schema.ts` 의 `KEYS` | 의미 |
| `docs/data-schema.md` 「공통 필드와 이벤트별 필드」 | `skills/orch/scripts/lib/events.ts` 머리 주석 | 의미 |
| `docs/data-schema.md` 「orch 루트에 더하는 파일」 | `skills/orch/scripts/lib/paths.ts` 의 `NAMES` 와 파일을 쓰는 코드 | 경로는 자동(`checkPaths`), 내용은 의미 |

## 스킬과 보드 README

| 문서와 자리 | 원본 | 대조 |
| --- | --- | --- |
| `skills/<이름>/README.md` 의 사용 예시와 「받는 것」 | 그 스킬의 `SKILL.md` 단계와 출력 | 의미 |
| `skills/<이름>/README.md` 전체 | 그 스킬의 `CHANGELOG.md` 가운데 README 를 마지막으로 고친 뒤 생긴 절 | 의미. 범위는 오버레이의 「README 뒤에 바뀐 스킬」 명령으로 고른다 |
| `skills/<이름>/README.md` 의 형식 | `docs/contributing.md` 「스킬 README」 | `scripts/check-skill-docs.ts` 가 본다. 이 스킬에서 다시 보지 않는다 |
| `skills/<이름>/README.md` 의 경로 | 그 스킬 폴더의 실제 파일 | 자동(`checkPaths`) |
| `extensions/work-board/README.md` 「단축키」 표와 본문의 한 글자 키 | `extensions/work-board/hooks/register.js` 의 `Button` `hotkey` | 자동(`checkBoardHotkeys`) |
| `extensions/work-board/README.md` 「화면」 표 | `register.js` 의 상자 렌더링 | 의미 |
| `extensions/work-board/README.md` 의 스크린샷 | 지금 보드 화면 | 의미. 화면이 바뀌었으면 다시 찍고 날짜를 고친다 |

## 자동 검사의 예외

`checkPaths` 는 아래를 경로 대조에서 뺀다. 이유는 `check-drift.ts` 의 주석에 있다.

- 플레이스홀더가 든 경로(`<이름>`, `*`, `$VAR`)
- `.claude/`, `.orch/` 로 시작하는 경로. 다른 저장소나 각자의 PC 에 있는 자리를 가리킨다
- 팀 저장소 배치를 가리키는 `tools/browser-driver`
- 코드 펜스 안의 경로

예외가 아닌데 잘못 걸리면 문서를 고치지 않고 `check-drift.ts` 의 규칙을 고친다. 고친 규칙에는 테스트를 더한다.
