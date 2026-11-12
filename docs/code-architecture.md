# 코드 구조

이 저장소는 스킬을 두 가지 방식으로 제공한다.
하나는 저장소를 Claude Code 플러그인 `fos-skills` 로 설치하는 것이고, 다른 하나는 스킬 디렉터리를 `~/.claude/skills/<이름>` 에 심볼릭 링크로 거는 것이다.
이 문서는 플러그인 배포의 구조와 orch 의 코어와 핸들러 경계를 소유한다.
기능 개발은 [orch 의 기능 루프](../skills/orch/references/feature-loop.md)가 연결하고 문서 소유권은 [기능 문서 계약](../skills/spec/references/feature-docs.md)이 소유한다. 스킬 각각의 절차는 그 스킬의 `SKILL.md` 가 소유한다.

## 범위

| 구분 | 대상 |
| --- | --- |
| 플러그인에 담는다 | `.claude-plugin/plugin.json` 의 `skills` 배열에 등록한 스킬 |
| 내보내기 전용 원본으로 함께 복사한다 | `content-preview`, `korean-check`. 스킬 목록에는 등록하지 않는다 |
| 플러그인과 함께 복사되지만 스킬이 아니다 | `modules/`, `scripts/`, `githooks/`, `docs/` |
| 플러그인이 싣는 훅 | `skills/orch/hooks/hooks.json` 의 PreToolUse 훅. `plugin.json` 의 `hooks` 배열이 가리킨다([ADR-005](adr/005-plugin-hooks-under-skill.md)) |
| 플러그인이 싣는 mod | `extensions/work-board/hooks/hooks.json` 의 hooks 모듈. 작업 현황 창 `/board` 를 그린다. `hooks` 배열이 가리킨다([ADR-006](adr/006-work-board-in-plugin.md)) |
| Codex 가 싣는 것 | `.codex-plugin/plugin.json` 의 `skills` 배열뿐이다. 훅과 mod 는 Claude Code 전용이라 싣지 않는다([ADR-007](adr/007-codex-manifest-without-hooks.md)) |
| 플러그인이 설치하지 않는다 | 한국어 검사 `PostToolUse` 훅, `~/.claude/rules/` 의 규칙 파일, `~/.claude/scripts/` 의 링크 |

플러그인은 통째로 설치된다. 스킬을 골라 설치하는 방법은 두지 않는다.

## 디렉터리 배치

| 경로 | 책임 |
| --- | --- |
| `.claude-plugin/`, `.codex-plugin/` | 저장소 루트를 배포하는 하네스별 매니페스트 |
| `skills/<이름>/` | 설치 스킬과 그 스킬의 references·templates·scripts·hooks·tests |
| `export-only-skills/<이름>/` | 자동 로드하지 않는 팀 내보내기 원본 |
| `extensions/work-board/` | 보드 확장 기능과 그 전용 훅·명령·테스트 |
| `tools/` | 여러 스킬이 쓰는 공용 도구 |
| `modules/` | 여러 영역의 테스트와 코드가 함께 쓰는 공용 모듈. 스킬이 아니다. 팀 저장소로 내보내지 않는다 |
| `modules/kit/` | 옛 Python 명령과 같은 글자를 내는 실행용 helper(argparse 꼴 옵션 펼치기, `str.splitlines` 같은 Python 꼴). `scripts/` 와 `githooks/` 는 import 하고, 스킬과 도구는 복사본을 둔다(설계 [`features/node-runtime/design.md`](features/node-runtime/design.md) 「공통 꼴 모듈 kit」) |
| `modules/testkit/` | 테스트용 helper. 이 저장소의 테스트만 쓴다 |
| `scripts/` | 이 저장소의 설치·검사·내보내기·버전 관리 |
| `githooks/` | Git commit-msg 와 post-commit. 확장자 없는 node 진입이 같은 이름의 `.ts` 본체를 부른다. Claude 훅이 아님 |
| `docs/` | 이 저장소의 책임 문서와 결정 이력 |

배치의 결정은 [ADR-021](adr/021-skill-directory-layout.md)이 소유한다. 스킬별 자산은 소유 스킬과 함께 이동한다.
`skills/` 자동 탐색에 내보내기 전용 원본이 섞이지 않게 별도 루트로 둔다. 두 매니페스트의 설치 스킬 목록은 계속 일치시킨다.
`modules/` 는 test-speed 스펙([`docs/features/test-speed/spec.md`](features/test-speed/spec.md)) DECISION7 이 정했다.

## 매니페스트

`.claude-plugin/marketplace.json` 은 다음과 같다.

```json
{
  "name": "fos-skills",
  "description": "여러 저장소가 함께 쓰는 Claude Code 워크플로 스킬 모음",
  "owner": { "name": "jon890" },
  "plugins": [
    {
      "name": "fos-skills",
      "source": "./",
      "description": "계획, 구현, 리뷰 작성, 리뷰 반영, 문서 감사, 하네스 정리 스킬"
    }
  ]
}
```

등록한 스킬의 정확한 목록은 `.claude-plugin/plugin.json` 과 `.codex-plugin/plugin.json` 이 소유한다.
이 문서에 배열 사본을 두지 않는다. 두 매니페스트의 일치는 `scripts/tests/plugin-manifest.spec.ts` 가 확인한다.

`skills` 배열은 이름순으로 둔다. 스킬을 더하거나 이름을 바꾸면 이 배열을 함께 고친다.
[`../scripts/export-only-skills.json`](../scripts/export-only-skills.json) 에 명시한 내보내기 전용 원본만 배열에서 제외한다.
`version` 은 main 머지마다 workflow 가 올린다. 규칙과 근거는 [ADR-019](adr/019-plugin-version-auto-bump.md) 가 소유한다.

## 모듈 책임

| 경로 | 책임 | 읽거나 부르는 쪽 |
| --- | --- | --- |
| `.claude-plugin/marketplace.json` | 마켓플레이스 이름과 플러그인 소스 | `claude plugin marketplace add` |
| `.claude-plugin/plugin.json` | 플러그인 이름, version, 담을 스킬의 경로 | `claude plugin install`, 세션 시작 |
| `scripts/bump-plugin-version.ts` | main 트리의 변경 이력 조각을 적용해 스킬 버전을 올리고, push 범위의 스킬 CHANGELOG 와 조각으로 플러그인 version 과 `.claude-plugin/CHANGELOG.md` 를 올린다 | `.github/workflows/plugin-version.yml` |
| `scripts/skill_changes.ts` | 변경 이력 조각(`<스킬>/changes/<슬러그>.<등급>.md`)의 형식 검사, 머지 순서 정렬, 스킬 버전과 CHANGELOG 절 적용 | `scripts/check-skill-docs.ts`, `scripts/bump-plugin-version.ts` |
| `skills/orch/hooks/` | PreToolUse 훅. `hooks.json` 이 `<이름>.ts` 를 PATH 의 node 로 부른다. 무엇을 거부하는지와 판정은 각 파일 머리 주석이 소유한다 | 세션의 모든 Bash 호출 |
| `<스킬>/SKILL.md` | 그 스킬의 절차. 자기 스크립트를 `$SKILL_DIR` 로 부른다 | Claude |
| `extensions/work-board/bin/board.ts` | 보드 편집 명령과 기본 보드 위치(`defaultBoardPath`) | orch 명령의 `BOARD_BIN` 기본값, `lib/board-file.ts`, 코디네이터. 부르는 명령은 각 명령의 머리 주석이 소유한다 |
| `skills/plan/scripts/adr-docs.ts` | 문서 링크와 ADR 검사, ADR 색인 생성. 검사 항목, 옵션, 출력 줄, 종료 코드는 머리 주석이 소유한다 | spec·technical-design·review-fix·docs-audit 의 검사 단계, `skills/plan/tests/adr-docs.spec.ts` |
| `skills/plan/scripts/{verify_task,check_feature,run_doc_checks,overlay_paths,plan_number}.ts` | 계획서 검사, 스펙·설계 형식 검사, 레포 설정의 문서 검사 명령 실행, 하위 프로젝트 판정과 오버레이 탐색 순서, plan 번호 계산. 옵션, 출력 줄, 종료 코드는 각 머리 주석이 소유한다 | plan·spec·technical-design·implementation·docs-audit·docs-consolidate·review-fix 의 단계, `skills/plan/tests/` |
| `skills/browser/browser-driver/` | 브라우저 백엔드 중립 계층. 소유자는 `browser` 스킬이고 팀 저장소에는 `tools/browser-driver/` 로 실린다. 명령 목록은 `help` 가, 백엔드 규칙은 그 폴더의 `README.md` 가 소유한다 | `skills/browser/SKILL.md`, `export-only-skills/content-preview/scripts/show-preview.ts`, `skills/presentation/scripts/check-deck.ts` |
| `scripts/run-tests.ts` | 저장소의 검증 명령. 사용법과 종료 코드는 머리 주석이 소유한다 | 사람, worker, CI |
| `scripts/runtime-policy.ts` | 남은 Python·셸 파일과 허용 진입을 정책 파일과 대조한다. 출력 줄과 종료 코드는 머리 주석이 소유한다 | `scripts/tests/runtime-policy.spec.ts`, CI, worker |
| `scripts/runtime-policy.json` | TypeScript 이행 상태의 원본(남은 영역, 허용 JS 진입, 최소 Node) | `scripts/runtime-policy.ts` |
| `scripts/tests/plugin-manifest.spec.ts` | 내보내기 전용 원본을 제외한 설치·내보내기 원본 디렉터리 집합이 `skills` 배열과 같은지, `version` 이 X.Y.Z 이고 마켓플레이스와 Codex 매니페스트에는 없는지 확인한다 | 사람, 구현 검증 |
| `scripts/test-plugin-install.ts` | 격리된 `CLAUDE_CONFIG_DIR` 에 설치해 스킬 인식과 캐시 안의 경로 참조를 확인한다 | 사람, 구현 검증 |
| `scripts/export-to-team.ts` | 공용 스킬을 팀 저장소로 내보낸다. 플러그인 배포와 무관하게 그대로 동작한다. 인자는 스크립트 머리 주석이 소유한다 | 사람, `githooks/post-commit` |
| `scripts/export-lists.ts` | `export-to-team.ts` 의 내보내는 목록을 그 파일의 글에서 읽는다 | `githooks/post-commit.ts`, `scripts/tests/exported-imports.spec.ts` |

## 스킬 사이의 경로 참조

설치하면 저장소 루트가 `~/.claude/plugins/cache/fos-skills/fos-skills/<version>/` 로 복사된다.
스킬 디렉터리는 캐시 안에서도 서로 형제이고 `tools/` 도 같은 루트에 있다.

| 참조 | 플러그인 설치에서의 동작 |
| --- | --- |
| 스킬 본문의 `$SKILL_DIR` | 스킬을 로드할 때 붙는 `Base directory for this skill` 줄의 값이다. 캐시 안의 스킬 디렉터리를 가리킨다 |
| 스킬 문서의 `../export-only-skills/korean-check` 같은 형제 경로 | 캐시 안에서 그대로 풀린다 |
| `implementation`, `review-fix`, `spec`, `technical-design`, `docs-audit`, `docs-consolidate` 의 `$PLAN_SKILL_DIR` | 자기 번들의 형제 디렉터리 `plan` 이다. 값은 `$SKILL_DIR/../plan` 이다 |
| `export-only-skills/content-preview/scripts/style-check.ts` 가 `korean-check` 를 찾는 순서 | `KOREAN_CHECK` 환경 변수, 형제 디렉터리, `~/.claude/skills/korean-check` 순이다. 캐시에서는 형제 디렉터리에서 찾는다 |
| `export-only-skills/content-preview/scripts/show-preview.ts` 가 드라이버를 찾는 순서 | `BROWSER_DRIVER_PATH`, 위로 올라가며 찾은 `skills/browser/browser-driver/`(팀 사본은 `tools/browser-driver/`), `~/.claude/scripts/browser-driver` 순이다. 캐시에서는 루트의 `skills/browser/browser-driver/` 에서 찾는다 |
| `skills/browser/SKILL.md` 가 드라이버를 찾는 순서 | `BROWSER_DRIVER_PATH`, `$SKILL_DIR/browser-driver/`, `~/.claude/scripts/browser-driver`, PATH 의 `browser-driver` 순이다. 드라이버가 스킬 폴더 안에 있어 캐시에서도 같은 상대 경로다 |
| `skills/harness-cleanup/scripts/check_references.ts` 의 설치된 스킬 이름 수집 | `~/.claude/plugins` 아래에서 `SKILL.md` 를 가진 디렉터리 이름을 모은다. 스킬이 `skills/` 아래에 있지 않아도 찾는다 |

루트 `bin/` 에는 orch 실행기 `orch` 하나만 둔다. 설치 기록에서 번들을 골라 `skills/orch/bin/orch.ts` 에 넘기기만 한다. 번들 고르기의 원본은 `skills/orch/scripts/lib/install-record.ts` 이고, 실행기 머리 주석이 그 사본임을 적는다. `browser-driver` 명령은 팀 저장소의 플러그인이 PATH 에 추가한다. 근거는 [ADR-004](adr/004-no-plugin-bin.md) 가 소유한다.

`${CLAUDE_PLUGIN_ROOT}` 는 쓰지 않는다. 스킬 본문에서만 치환되고 `references/` 파일과 Bash 명령에서는 치환되지 않으며, 링크 설치에서는 값이 없기 때문이다.
`$SKILL_DIR` 은 플러그인 설치와 링크 설치에서 같은 방식으로 얻는다.

## 저장소 밖에서 이 저장소를 가리키는 경로

캐시 경로에는 version 이 들어 있어 갱신할 때마다 바뀐다.
저장소 밖의 파일이 스킬 안의 파일을 가리켜야 하면 **로컬 체크아웃 경로**를 쓴다.

| 저장소 밖의 것 | 가리키는 곳 | 플러그인으로 옮긴 뒤 |
| --- | --- | --- |
| `~/.claude/scripts/korean-style-check.py`, `check-readability.py` 링크 | 체크아웃의 `export-only-skills/korean-check/scripts/` 의 같은 이름 진입(node shebang JS). 새 `.ts` 를 불러 같은 결과를 낸다. 새로 거는 링크는 `.ts` 이름이다 | 그대로 둔다. 진입은 다음 major 에서 지운다 |
| `~/.claude/scripts/browser-driver` 링크 | 새로 거는 링크는 체크아웃의 `skills/browser/browser-driver/browser_driver.ts` 이다. 옛 `tools/browser-driver/browser_driver.py` 진입은 browser 3.0.0 에서 지웠다 | 옛 링크는 `install` 로 다시 건다 |
| `~/.claude/rules/korean-style.md` 링크 | 체크아웃의 `export-only-skills/korean-check/references/korean-style.md` | 그대로 둔다 |
| `~/.claude/settings.json` 의 `PostToolUse` 훅 | `~/.claude/scripts/` 의 링크 | 그대로 둔다 |
| 전역 지침과 `~/.claude/references/` 가 적은 `~/.claude/skills/<스킬>/` 아래 경로 | 스킬 링크 | `~/personal/fos-skills/<스킬>/` 로 고친다 |
| 다른 저장소의 오버레이와 스킬이 적은 `~/.claude/skills/<스킬>` 경로 | 스킬 링크 | 그 저장소에서 고친다. 고치기 전에는 그 스킬의 링크를 남긴다 |

링크가 체크아웃을 가리키므로 훅과 규칙은 체크아웃의 현재 내용을 읽는다.
설치된 스킬은 main 에 push 한 내용을 읽는다. push 하기 전에는 두 내용이 다를 수 있다.

## 이름과 겹침

플러그인 스킬은 `fos-skills:plan` 처럼 불린다.
`~/.claude/skills/plan` 같은 같은 이름의 링크와 함께 두면 둘 다 목록에 뜨고 어느 쪽도 다른 쪽을 가리지 않는다.
전환할 때 링크를 지우는 순서는 [flow.md](flow.md) 의 「링크 설치에서 옮기기」 가 소유한다.

팀 저장소의 플러그인은 `content-preview` 와 `korean-check` 의 사본을 넣는다.
두 스킬의 원본은 여기 있지만, 스킬로는 사본을 넣는 팀 저장소의 플러그인으로 받는다.
그 플러그인을 받을 수 없는 환경에서는 두 스킬이 목록에 뜨지 않는다.
이 플러그인은 두 원본 디렉터리를 캐시에 복사하되 `skills` 배열에서 제외하므로 함께 설치해도 중복으로 뜨지 않는다.

- 사본은 `scripts/export-to-team.ts` 가 원본과 같은 내용으로 유지한다.
- 팀 양식 스킬은 자기 플러그인 안의 사본을 상대 경로로 읽는다. 이 플러그인의 유무와 무관하다.
- 팀 플러그인은 이 플러그인에 기대지 않는다. 두 플러그인을 함께 켜는 사람은 두 저장소를 모두 쓰는 한 명이다.

## 팀 저장소 내보내기

내보내기는 `skills/<이름>` 또는 `export-only-skills/<이름>` 원본을 팀의 `skills/<이름>`에 복사한다.
`githooks/post-commit`은 두 원본 루트의 변경에서 스킬 이름을 읽는다. 옛 커밋의 루트 배치도 내보낼 수 있다. 상대 참조는 팀 배치에 맞춰 바꾼다.
팀 저장소가 `skills/<이름>` 을 플러그인 안의 본체를 가리키는 상대 링크로 바꿔도, 내보내기는 링크 너머로 읽고 쓰므로 목적지를 바꾸지 않는다.

`.claude-plugin/` 은 내보내는 대상이 아니다. 스킬 디렉터리 밖에 있어 내보내기가 읽지 않는다.

## 검증

| 명령 | 확인하는 것 |
| --- | --- |
| `node scripts/run-tests.ts` | 저장소의 모든 node 테스트와 tsc |
| `node scripts/runtime-policy.ts --pending` | 허용 목록 밖의 새 Python·셸 파일과 JS 진입이 없다. 영역마다 남은 파일 수를 낸다 |
| `node scripts/run-tests.ts scripts/tests` | 내보내기 전용 원본을 제외한 설치·내보내기 원본 디렉터리 집합이 `skills` 배열과 같다. 두 매니페스트에 `version` 이 없다. 마켓플레이스의 소스가 `./` 다. `export-to-team.spec.ts` 가 `export-to-team.ts` 의 인자 처리와 `--source-ref` 를 임시 저장소로 확인한다 |
| `node scripts/test-plugin-install.ts` | 격리된 설정 폴더에서 설치 스킬 16개가 인식되고 내보내기 전용 원본은 목록에 없다. 캐시에 원본이 남고 형제 참조와 도구 탐색이 된다 |

`claude plugin validate --strict` 는 쓰지 않는다. `version` 이 없다는 경고로 실패하기 때문이다.
설치 테스트가 `claude plugin validate . --json` 의 결과에서 오류가 없고 경고가 버전 경고 하나뿐인지를 확인한다.

## 다음 차수

플러그인이 `PostToolUse` 훅을 넣어 설치만으로 한국어 검사가 켜지게 하는 일은 이번에 하지 않는다.
플러그인 훅이 실제로 발화하는지는 세션을 띄워야 확인되는데 격리 환경에서 실측하지 못했다.
그때까지 사외 머신에서 훅을 쓰려면 저장소를 clone 하고 `export-only-skills/korean-check/README.md` 의 링크를 건다.
훅을 넣을 때는 훅 정의 파일을 git 훅이 있는 `githooks/` 와 다른 경로에 둔다. 배치는 [ADR-005](adr/005-plugin-hooks-under-skill.md) 가 정한다.

## 저장소 실행 규칙

저장소의 스크립트, 검사기, git 훅, 테스트가 따르는 규칙이다. 고른 이유는 [ADR-025](adr/025-script-runtime-typescript.md) 가 소유한다.

| 항목 | 규칙 |
| --- | --- |
| Node 버전 | 24 이상. 고른 이유는 [ADR-011](adr/011-node-24-minimum.md) 이 소유한다. 값의 원본은 `scripts/runtime-policy.json` 의 `min_node` 이고, 진입이 줄 머리에 적은 `const MIN_NODE = [a, b]` 를 저장소 검사가 그 값과 대조한다 |
| 언어 | TypeScript. Python·셸 파일을 두지 않는다. JS 는 `scripts/runtime-policy.json` 의 `entry_js` 와 `legacy` 에 적은 진입만 둔다. 옮기는 동안 남은 파일은 같은 파일의 `pending` 이 영역별로 허용한다 |
| 문법 | 타입 제거가 지우는 문법만 쓴다. `enum`, `namespace`, 생성자 매개변수 속성을 쓰지 않는다. 상대 import 에 `.ts` 를 적고, 타입만 가져오면 `import type` 이다 |
| 의존 | Node 내장 모듈만 쓴다. `package.json` 과 `node_modules` 를 두지 않는다 |
| import 범위 | 스킬과 도구는 자기 폴더와 Node 내장 모듈만 import 한다. 팀 저장소와 플러그인 캐시가 폴더 밖 배치를 보장하지 않는다 |
| 호출 꼴 | 문서는 `node "$SKILL_DIR/scripts/<이름>.ts"` 로 부른다 |
| 테스트 | `node:test` 의 `*.spec.ts` 를 `tests/` 아래 둔다. 돌리는 명령은 `node scripts/run-tests.ts` 이고 묶음 찾기는 그 머리 주석이 소유한다. `*.test.ts` 는 `claude plugin test .` 가 고르므로 쓰지 않는다 |
| 주석 | 한국어로 쓴다. 함정에는 이유 주석을 단다. 머리 주석이 사용법, 옵션, 종료 코드를 소유하고 문서는 그것을 옮겨 적지 않는다 |
| 저장소 검사 | `node scripts/runtime-policy.ts`. 허용 목록 밖의 새 Python·셸 파일과 JS 진입을 파일 이름과 함께 낸다. `scripts/tests/runtime-policy.spec.ts` 가 테스트로 돌린다 |

## orch 코어와 핸들러

이 절은 orch 개편 뒤의 구조다([ADR-009](adr/009-orch-event-handlers.md), [ADR-010](adr/010-orch-typescript.md)).
상주 루프의 자동 진행 가운데 ready 슬롯, base 합치기, 문서 PR 머지와 배포 묶기, `ci-missing` 은 아직 구현하지 않았다. 머지할 수 있는 PR 을 머지 큐에 거는 자동 머지는 `queue.auto_merge` 로 따로 켠다([ADR-016](adr/016-orch-auto-merge.md)).
이 문서의 그 부분은 설계이고, 지금 동작은 `skills/orch/SKILL.md` 와 `skills/orch/references/` 가 소유한다.
이벤트의 시점은 [flow.md](flow.md) 의 「orch 이벤트」, 핸들러 입력과 설정 키는 [data-schema.md](data-schema.md) 가 소유한다.

### 사용자 결정 (2026-10-24)

| 항목 | 결정 |
| --- | --- |
| 확장 방식 | 단계마다 이벤트를 내고, 저장소 고유 정리와 그 저장소에 필요한 일은 저장소의 핸들러가 맡는다 |
| 스크립트 언어 | 기존 Python 과 sh 스크립트 전부를 TypeScript 로 한 차례에 옮긴다. 모듈 단위의 단계적 전환은 하지 않는다 |
| 진행 순서 | 설계 문서를 먼저 합의하고 구현한다 |
| handoff 산출물 정리 | 묻지 않고 `--apply` 로 휴지통 폴더에 옮긴다. 지우지 않으므로 되살릴 수 있다 |
| 옛 `.py` 명령 경로 | orch 5.0.0 에서 doctor 의 Node 버전 검사에 필요한 `orch-doctor.py`, `ts_shim.py` 만 남기고 지웠다 |
| 핸들러 언어 | `.orch/hooks/<이벤트>.ts` 만 받는다. 다른 언어는 그 핸들러가 자식 프로세스로 부른다 |
| 충돌한 PR | 그 PR 을 만든 기존 worker 가 푼다. worker 터미널은 `worker_done` 뒤에도 그 PR 이 머지되거나 닫힐 때까지 남기고, 충돌이 나면 같은 worker 에게 후속 지시서를 보낸다. 이어 받지 못하면 새 worker 를 띄우지 않고 코디네이터에게 알린다. 새 worker 자동 띄우기 설정은 두지 않는다. 로컬 자원을 아끼기 위해서다. 머지 뒤에는 그 터미널을 바로 정리한다. 처음 답(설정으로 자동 띄우기)을 같은 날 바꿨다 |
| 사용자 결정 질문 | worker 와 코디네이터가 사용자에게 묻는 결정은 첫 줄 `결정: <무엇을 정하는지>` 와 배경, 선택지별 결과, 권장안과 이유를 갖춘다. 보드는 결정 필요 항목마다 그 첫 줄과 권장안을 보인다. 코디네이터는 사용자가 정할 질문에 대신 답하지 않고 권장안을 보여 사용자가 고르게 한다 |
| 터미널 직접 입력 금지 hook | 대상이 변수이거나 orca 조회가 실패하면 막는다. `send-to-worker` 를 안내한다 |
| 상주 루프의 자동 진행 | 코어에 두되 `pipeline.enabled` 를 켠 저장소에서만 돈다. 원격 브랜치 정리와 미답변 질문 알림은 늘 돈다 |
| 상주 루프의 자동 머지 (2026-10-27) | 머지할 수 있는 PR 은 코디네이터에게 말하지 않아도 머지된다. `pipeline.enabled` 가 아니라 `queue.auto_merge` 로 켠다. Flyway out-of-order 는 켜지 않는다 |
| 핸들러의 `orca`, `gh` | 가드 shim 으로 감싼다 |

### 배치

orch 의 값 판정은 `scripts/core/`, 외부 조회와 기록은 `scripts/lib/` 와 명령 파일이 맡는다.
core 는 core 안의 상대 모듈과 허용한 내장 모듈만 가져온다. 기존 lib 경로는 호환 재수출로 남는다.
[ADR-028](adr/028-orch-core-layer.md)이 선택 이유를, [경계 검사](../skills/orch/tests/core-boundary.spec.ts)가 허용 의존과 외부 상태 접근 금지를 소유한다.

```
skills/orch/scripts/<묶음>/<명령>.ts     명령. 폴더는 명령 표(lib/commands.ts)의 묶음과 같다. 이름과 옵션은 옛 <명령>.py 와 같고 확장자만 다르다
skills/orch/scripts/orch-doctor.py       doctor 의 Python 진입점. ts_shim.py 와 함께 scripts/ 바로 아래에 남는다. 옛 .py 진입점은 이 둘 외에는 orch 5.0.0 에서 지웠다
skills/orch/scripts/loop/orch-loop.ts    상주 루프의 진입 파일. 분리된 프로세스로 돈다. 사용법과 틱의 단계 순서는 머리 주석이 소유한다
skills/orch/scripts/loop/lifecycle.ts    루프의 시작·멈춤·잠금과, 틱 자식을 띄우고 loop.json 을 쓰는 부모
skills/orch/scripts/loop/steps/<단계>.ts 틱의 단계 하나씩. 그 단계가 하는 일과 알림은 파일 머리 주석이 소유한다
skills/orch/scripts/lib/commands.ts      명령 표. 새 꼴과 옛 이름을 스크립트 경로와 인자로 푸는 유일한 원본이다. 스크립트끼리 부르는 경로는 scriptPath 로 푼다
skills/orch/scripts/lib/proc.ts          자식 프로세스 실행과, 신호를 받은 명령이 진행 중인 자식을 끊는 일 한 벌. 함수와 반환 형태는 머리 주석이 소유한다
skills/orch/scripts/lib/orca.ts          orca 호출. 실행 파일은 ORCA, 없으면 orca 다. 한 스크립트만 쓰던 ORCA_CLI_COMMAND 는 읽지 않는다
skills/orch/scripts/lib/gh.ts            gh 호출. 내 PR 판정(작성자), update-branch 를 부를 수 있는 경우를 한 곳에서 정한다
skills/orch/scripts/lib/git.ts           git 호출. 기준 브랜치, merge-tree 충돌 판정 한 벌
skills/orch/scripts/lib/paths.ts         orch 루트와 이름별 경로. 옛 orch_paths.py 의 역할. 셸에서 부르는 명령은 orch_paths.ts
skills/orch/scripts/lib/fs.ts            파일 경로 판정 helper 한 벌
skills/orch/scripts/lib/args.ts          옵션 고유 접두 펼치기와 - 로 시작하는 값 처리. 옛 argparse 호출과 맞춘다
skills/orch/scripts/lib/py.ts            옛 Python 출력과 같은 바이트 꼴(json.dumps, None 표기, shlex.quote)
skills/orch/scripts/lib/config.ts        config.json 파일 읽기. 값 검사와 키 목록은 core/config.ts 를 호출하고 재수출한다
skills/orch/scripts/core/overlap.ts      입력 파일 목록의 단위 겹침 판정. lib/overlap.ts 는 재수출한다
skills/orch/scripts/core/queue-options.ts 머지 큐 옵션 목록과 설정 키 변환 표. lib/queue-options.ts 는 재수출한다
skills/orch/scripts/core/finish-options.ts finish-pr 옵션 목록. lib/finish-options.ts 는 재수출한다
skills/orch/scripts/lib/conflicts.ts     열린 PR 의 충돌 판정과 처리, 알린 기록 한 벌. 함수와 사용처는 머리 주석이 소유한다
skills/orch/scripts/core/auto-merge.ts   상주 루프의 자동 머지 값 판정. lib/auto-merge.ts 는 재수출한다
skills/orch/scripts/lib/refresh.ts       최신화 파일 조회와 기록. 값 판정은 core/refresh.ts 가 소유하고 재수출한다
skills/orch/scripts/lib/queue-turn.ts    머지 큐의 차례 기록 한 벌. 머지 큐가 쓰고 상주 루프가 읽는다
skills/orch/scripts/lib/reservations.ts  마이그레이션 번호와 ADR 번호 예약 한 벌. 파일, 잠금, 함수와 사용처는 머리 주석이 소유한다
skills/orch/scripts/lib/spec.ts          지시서의 브랜치 줄과 허락 줄, 살아 있는 지시서 목록, 지시서 삭제 경로 한 벌
skills/orch/scripts/core/completion.ts  worker_done 과 앞선 준비 상태 대조. lib/completion.ts 는 기존 비교기를 넘기는 호환 함수다
skills/orch/scripts/lib/questions.ts     미답변 질문 조회와 알림 한 벌. 함수와 사용처는 머리 주석이 소유한다
skills/orch/scripts/lib/loop.ts          상주 루프의 파일·프로세스 조회와 기록. 값 판정은 core/loop.ts 의 judgeLoop 가 맡는다
skills/orch/scripts/lib/workers.ts       브랜치의 워크트리와 그 worker 행 찾기 한 벌. 사용처는 머리 주석이 소유한다
skills/orch/scripts/lib/process.ts       pid 생존 확인(EPERM 은 살아 있음), 작업 디렉터리를 쥔 프로세스 찾기
skills/orch/scripts/lib/ownership.ts     터미널 소유 확인 한 벌. 모든 Run 의 worker 행을 읽어 60초 동안 다시 쓴다. 사용처는 머리 주석이 소유한다
skills/orch/scripts/lib/events.ts        이벤트 실행기. 핸들러 찾기, 잠금, 시간 제한, 기록, 가드 환경
skills/orch/scripts/lib/guard/orca       핸들러 PATH 앞에 두는 shim. 확장자가 없어 CommonJS 로 읽히므로 타입 문법 없이 guard.ts 를 import() 한다
skills/orch/scripts/lib/guard/gh
skills/orch/scripts/lib/guard/guard.ts   거부 규칙
skills/orch/hooks/<이름>.ts             PreToolUse hook. hooks.json 이 node 로 부른다
skills/orch/hooks/shell-text.ts          hook 이 함께 쓰는 셸 글자 처리 모듈. hook 이 아니다
skills/orch/tests/<이름>.spec.ts        node:test. claude plugin test 가 고르는 *.test.ts 와 겹치지 않게 이름을 둔다
skills/orch/tests/core-*.spec.ts         값 입력 검증과 경계·중복 검사. 순수 테스트는 외부 실행 환경을 바꾸지 않는다
skills/orch/tests/fixtures/              가짜 orca, gh 와 임시 저장소 helper
skills/orch/tests/golden/                고정 입력과 stdout·stderr·종료 코드·종료 뒤 상태. fixtures/golden-run.ts 가 비교한다
skills/orch/tests/loop-order/            Run 이 둘인 루프 틱의 로그 줄·결과 줄·orca 와 gh 호출 순서. fixtures/loop-order-run.ts 가 비교한다
extensions/work-board/bin/board.ts           보드 편집 명령. 기본 보드 위치 규칙 한 벌(defaultBoardPath)을 두고 lib/board-file.ts 가 import 한다
```

`skills/orch/scripts/` 의 명령은 외부 조회·기록에 `lib/`, 값 판정에 `core/` 를 import 한다. core 는 실행 모듈을 import 하지 않는다. 명령끼리는 import 하지 않고 자식 프로세스로 부른다.
보드 위치와 줄 지문은 work-board 가 소유한다. `lib/board-file.ts` 는 `defaultBoardPath` 를, `lib/board.ts` 는 `linesRev` 를 `extensions/work-board/bin/board.ts` 에서 import 한다.
work-board 에서 orch 를 import 하는 곳은 `extensions/work-board/bin/worker-marks.ts` 하나다. 보드 worker 줄의 멈춤 판정을 상주 루프와 한 벌로 두려는 것이다.
`extensions/work-board/bin/board.ts` 는 orch 를 import 하지 않는다. `lib/board-file.ts` 와 `lib/board.ts` 가 board.ts 를 import 해 고리가 생기기 때문이다.
옛 코드는 하이픈이 든 파일을 `importlib` 로 읽어 함수를 빌려 썼다. 그 함수는 `lib/` 로 옮긴다.

### 실행 규칙

저장소 전체 규칙은 「저장소 실행 규칙」 이 소유한다. 아래는 orch 만의 규칙이다.

| 항목 | 규칙 |
| --- | --- |
| Node 버전 판정 | 버전은 CommonJS 실행기 `bin/orch` 와 옛 진입점 `orch-doctor.py` 가 부르는 `ts_shim.py` 에서 본다. 두 곳의 최소 버전은 같은 값이고 `skills/orch/tests/orch-launcher.spec.ts` 가 대조한다. 낮으면 TypeScript 를 부르지 않고 `NODE-TOO-OLD` 줄을 낸다. `.ts` 안에서는 판정하지 않는다. 낮은 node 는 `.ts` 를 읽지 못해 `ERR_UNKNOWN_FILE_EXTENSION` 으로 죽어 그 판정에 닿지 못한다 |
| 실행 | `orch <묶음> <동작>`. PATH 의 실행기 `bin/orch`(또는 `~/.local/bin/orch` 사본)가 설치 기록에서 번들을 골라 그 번들의 진입점 `skills/orch/bin/orch.ts` 에 넘기고, 진입점이 명령 표 `scripts/lib/commands.ts` 로 스크립트와 인자를 풀어 `node --disable-warning=ExperimentalWarning` 으로 실행한다. 22.x 의 타입 제거 실험 경고가 hook 출력과 명령 출력에 섞이지 않게 한다. 번들 고르기의 원본은 `scripts/lib/install-record.ts`, 넘기기와 문맥 채우기는 진입점 머리 주석이 소유한다. 스크립트끼리는 진입점을 거치지 않고 파일 경로로 직접 부른다. 진입점은 자식에게 짧은 출력 신호 `ORCH_OUTPUT=short` 를 넘기고(`--full` 이면 넘기지 않는다), 스크립트는 `scripts/lib/output.ts` 로 판정 줄만 낸다. 경로로 직접 부른 스크립트는 지금 출력 그대로다 |
| 오류 출력 | 조회 실패처럼 코디네이터가 알아야 하는 것은 stdout 에 대문자 접두 줄(`WATCH-ERROR`, `HOOK-FAIL`)로 낸다. 하네스는 stderr 를 알림으로 보내지 않는다 |

### 코어와 저장소의 경계

저장소 로컬 스크립트가 대신하던 기능을 아래처럼 나눈다. 일반 기능은 코어로, 저장소 고유 값은 설정과 핸들러로 간다.

| 기능 | 코어 | 저장소 |
| --- | --- | --- |
| 상주 루프와 주기 실행 | `orch-loop.ts` 의 틱 | `tick.ts`, `pipeline.tick_sec` |
| runner 수만큼 draft 를 ready 로 | ready 슬롯 | `pipeline.ready_slots`, `before-ready.ts` |
| 머지 순서 | `state/order.json` | 없음 |
| 마이그레이션 번호 예약 | `reserve-migration.ts`, `lib/reservations.ts` | `migrations.dirs` |
| ADR 번호 예약 | `orch queue reserve --kind adr`, `lib/reservations.ts` | `adr.dirs` |
| 자동 머지 | 루프의 틱(`lib/auto-merge.ts`) | `queue.auto_merge`, `queue.auto_review`, `migrations.*`, 지시서와 보드의 `머지 보류` 줄 |
| 바로 머지 판정 | 머지 큐의 단위 겹침 판정 | `queue.*` |
| 문서 PR 바로 머지 | 루프 | `pipeline.docs_merge`, `queue.docs_glob` |
| 원격 브랜치 삭제, 쌓인 PR 의 base 옮기기 | `after-merge` 코어 동작, 틱 | 없음 |
| 배포를 간격으로 묶기 | `after-queue` 묶기 | `pipeline.after_queue_interval_sec`, `after-queue.ts` |
| CI 없음 알림 | `ci-missing` | `pipeline.ci_missing_after_sec`, `ci-missing.ts` |
| 로컬 검증 뒤 머지 | 합친 사본 만들기와 HEAD 대조 | `verify-merged.ts` |
| 충돌 판정 | `lib/git.ts` 의 merge-tree 한 벌. 사용처는 `lib/conflicts.ts` 머리 주석이 소유한다 | 없음 |
| 충돌한 PR | 기존 worker 에게 base 를 합치라는 지시. 끝난 dispatch 는 남은 터미널에 후속 지시서로 이어 쓴다. 이어 쓰지 못하면 알림 | 없음 |
| 뒤처진 draft 최신화 | 틱 | `pipeline.update_behind_drafts` |
| 뒤처진 ready PR 미리 최신화 | 틱의 최신화(`lib/refresh.ts`), 머지 큐의 차례 기록(`lib/queue-turn.ts`) | `pipeline.refresh_slots`, `pipeline.refresh_worker_paths`, `queue.*` |
| 질문 감시 | 루프의 틱과 `orch-loop.ts` | `worker-question.ts` |
| 무거운 검사 대기열 | `heavy-slot.ts` | `heavy.*` 분류 정규식과 `wait_idle` |
| 큐 옵션 | `queue` 절 | 검증 본문은 `verify-merged.ts` |
| Run id | `finish.run` 한 곳과 명령줄 `--run` | 로컬 스크립트에 박지 않는다 |

### 공통 안전 장치

| 장치 | 위치 | 판정 |
| --- | --- | --- |
| worker 터미널 직접 입력 금지 | PreToolUse hook, 가드 shim | PreToolUse hook 은 대상이 worker 터미널이면 거부한다. 대상이 변수이거나 조회가 실패해도 거부한다. 가드 shim 은 핸들러의 `orca terminal send` 를 대상과 무관하게 거부한다. 핸들러는 worker 에게 쓸 일이 없고, 보내는 일은 `send-to-worker` 가 한다 |
| 다른 사람 PR 제외 | `lib/gh.ts` | 루프, 원격 브랜치 정리, 충돌 알림, ready 전환은 `pipeline.authors` 의 PR 만 본다 |
| 머지와 base 합치기는 코어만 | 가드 shim, `lib/gh.ts` | 핸들러의 코어 전용 머지와 base 합치기 호출(CLI, REST, GraphQL)을 거부한다. 거부 목록은 `lib/guard/guard.ts` 머리 주석이 소유한다. 가드는 실수 방지 장치이고 보안 경계가 아니다. 코어는 머지 차례가 온 PR 과 뒤처진 draft 에만 base 를 합친다 |
| 무거운 검사 대기열 | `heavy-slot.ts` | 같은 PC 의 무거운 검사를 자리 수로 제한한다 |
| 지시서 삭제 | `lib/spec.ts` 한 경로 | 살아 있는 dispatch 의 지시서와, 그 목록을 읽지 못한 실행에서는 지우지 않는다 |

### orch 문서가 소유하는 것

| 문서 | 소유하는 것 | 두지 않는 것 |
| --- | --- | --- |
| `skills/orch/SKILL.md` | 단계, 통과 조건, 원칙 | 옵션 설명, 스크립트 동작 |
| `skills/orch/references/<단계>.md` | 언제 어떤 명령과 옵션을 쓰는가, 사용자에게 알릴 것, 스크립트가 다루지 않는 수동 경로 | 머리 주석의 반복, 모델 행동 관측을 이유로 단 문장 |
| `skills/orch/references/hooks.md` | 이벤트를 고르는 법과 핸들러 예시 | 입력 필드 표. `lib/events.ts` 머리 주석이 소유한다 |
| 스크립트 머리 주석 | 사용법, 옵션, 판정, 종료 코드 | 다른 스크립트의 동작 |
| `skills/orch/templates/spec-common.md` | 모든 worker 에게 같은 규칙. `{{...}}` 는 저장소마다 한 번 채우는 값만 | Run 마다 바뀌는 값, 허락. 허락은 지시서의 `허락:` 줄이 소유한다 |
| 저장소의 `.orch/overlay.md`, `config.json`, `hooks/` | 저장소 고유 값과 일 | 코어 규칙의 사본 |

한 저장소의 명령 이름, CI job 이름, 배포 스크립트는 공용 스킬에 두지 않는다. 예시가 필요하면 `example.com` 과 일반 이름으로 쓴다.
