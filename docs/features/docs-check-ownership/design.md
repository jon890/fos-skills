# ADR 링크·색인·번호 검사를 fos-skills 가 소유한다: 기술 설계

스펙: [spec.md](spec.md). PR 단위는 스펙 DECISION8(fos-skills PR 하나, 그 뒤 ai-analysis PR 하나)이다.

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | plan 번들에 TypeScript 검사기 `skills/plan/scripts/adr-docs.ts` 를 둔다. 「검사 항목」 절의 다섯 검사를 하고 `경로:줄: 코드 내용` 줄과 종료 코드 0/1/2 를 낸다. `adr-docs.spec.ts` 가 임시 저장소 표본으로 검사마다 위반과 통과를 본다. ai-analysis 와 같은 결과인지는 이전 PR 이 두 검사기를 같은 커밋에 돌려 대조한다(스펙 DECISION16) |
| REQ2 | 「설정」 절. ADR 폴더(`--adr-dir` glob 여러 개)와 대체 배치(`--flat`)를 인자로 받고, 식별자 형식은 파일 이름에서 읽는다. 표본은 모듈 폴더 여럿, `ADR-M01`, `ADR-20261007` 세 꼴이다 |
| REQ3 | `write-index` 동작이 「색인 형식」 절의 두 표를 만든다. 대체 관계는 `대체된 부분`·`대체` 항목 안의 ADR 링크를 링크 글에 식별자가 들어 있기만 하면 받는다(스펙 DECISION10). `--index ids` 면 번호 집합만 맞춘다 |
| REQ4 | 「스킬 연결」 절. 네 스킬 문서가 같은 명령을 부르고, `check_adr_layout.py` 를 지우며 `static_check.py` 에서 링크·색인 검사를 뺀다 |
| REQ5 | 「옛 호출 자리」 절의 목록을 같은 PR 에서 바꾸고, 다른 저장소는 구현 PR 이 다시 검색해 목록을 남긴다. plan 은 major 로 직접 올리고 CHANGELOG 에 `호환성:` 항목을 둔다. docs-audit 는 minor 조각이다(DECISION6) |
| REQ6 | 두 번째 PR(ai-analysis). 「ai-analysis 이전」 절대로 오버레이 값을 적고 `check-docs.py` 에서 일반 검사를 지운 뒤 `write-index` 로 색인 7개를 다시 만든다 |
| REQ7 | 「fos-skills 첫 적용」 절. 첫 PR 이 이 저장소 plan 오버레이를 새로 만들어 「ADR 색인 생성」 을 켜고, 대체된 ADR 둘을 `superseded/` 로 옮기고, 저장소 전체 위반을 고친 뒤 `docs/adr/INDEX.md` 를 `write-index` 로 다시 만든다 |

## 책임과 경계

### 검사기 하나의 자리

- 원본은 plan 번들의 `scripts/adr-docs.ts` 한 파일이다. plan 이 이미 `check_adr_layout.py`, `run_doc_checks.py` 를 갖고, spec·technical-design·docs-audit 가 `$PLAN_SKILL_DIR` 로 plan 번들을 부른다(`skills/spec/SKILL.md` 4단계, `skills/docs-audit/SKILL.md` 1단계). review-fix 도 같은 방식으로 부른다.
- 스킬은 자기 폴더 밖을 import 하지 않는다([node-runtime 설계 「스킬은 자기 폴더 안만 import 한다」](../node-runtime/design.md#스킬은-자기-폴더-안만-import-한다)). 다른 스킬은 이 검사기를 자식 프로세스로 부른다. 검사기는 Node 내장 모듈만 import 한다.
- 오버레이는 읽지 않는다. 값은 인자로 받고, 부르는 스킬이 오버레이에서 읽어 넘긴다. 「ADR 폴더」 의 원본은 **루트** plan 오버레이 한 곳이다. 검사기가 저장소 전체를 보므로 하위 프로젝트 오버레이에 나눠 적지 않는다(DECISION8). docs-audit 1단계의 ADR 디렉터리도 이 값을 읽는다. 「오버레이가 지정하는 경로 값」 표([monorepo.md](../../../skills/plan/references/monorepo.md#오버레이가-지정하는-경로-값))가 이미 `ADR 대체 배치` 를 `--flat` 인자로 넘기는 방식이다. 오버레이 탐색(`overlay_paths.py`)을 TypeScript 로 옮기는 일은 node-runtime 영역 7 이 맡는다.

### 검사 항목

| 코드 | 판정 | 출처 |
| --- | --- | --- |
| `BROKEN_LINK` | 상대 링크의 대상 파일이 없다 | 세 검사기의 공통 부분 |
| `BROKEN_ANCHOR` | `#앵커` 가 대상 Markdown 의 제목에 없다. 같은 파일 앵커도 본다 | `check-docs.py`, `static_check.py` |
| `ADR_UNLINKED` | 링크 글 밖에 ADR 식별자를 적었다. 후보 경로를 함께 낸다(스펙 DECISION13, DECISION19) | `check-docs.py` |
| `INDEX_STALE` | 생성 모드에서 `INDEX.md` 가 `write-index` 결과와 다르다 | `check-docs.py` |
| `INDEX_DESYNC` | 번호 집합 모드에서 파일 이름의 식별자 집합과 색인 등재 집합이 다르다(스펙 DECISION22) | `static_check.py` |
| `ADR_DUPLICATE` | 한 ADR 폴더 안에서 같은 식별자가 두 파일에 있다. 날짜 꼴은 날짜와 슬러그가 식별자라 같은 날 ADR 은 겹치지 않는다 | `check-docs.py` |
| `ADR_PLACEMENT` | `superseded` 인 ADR 이 `superseded/` 밖에 있거나, `superseded/` 안 ADR 이 `superseded` 가 아니다. `--flat` 이면 하지 않는다(스펙 DECISION21) | `check_adr_layout.py` |

- 검사 대상 문서는 git 이 추적하거나 무시하지 않는 저장소의 모든 Markdown 이다(스펙 DECISION18). `git ls-files -co --exclude-standard -z` 로 읽는다. 지금 두 Python 검사기와 같다.
- 코드 블록(``` 와 ~~~, 여는 펜스보다 짧지 않은 같은 문자로 닫는다)과 코드 스팬 안은 보지 않는다. `check_adr_layout.py` 의 `prose` 와 같다.
- 링크는 인라인 링크와 참조 정의(`[이름]: 경로`)를 모두 본다. URL 스킴, `/` 로 시작하는 경로, `mailto:` 는 로컬 파일이 아니다. 경로는 `decodeURIComponent` 로 푼다. 이미지 링크(`![]()`)도 파일 존재를 본다. `static_check.py` 와 같고 `check-docs.py` 보다 넓다(대조에서 범위 확대로 분류한다).
- 앵커는 `decodeURIComponent` 와 소문자로 바꾼 뒤 제목 슬러그와 비교한다. `check-docs.py:156` 과 같다.
- `ADR_UNLINKED` 는 ADR 제목 줄(`#`~`######` 뒤 `ADR-식별자:` 나 날짜 꼴의 `ADR-식별자 / 슬러그:`)과 계획서 폴더 안 문서를 보지 않는다(스펙 DECISION12). 계획서 폴더는 경로 조각이 `tasks` 이거나 `static_check.py` 의 `PLAN_DIR` 정규식에 맞는 곳(계획서 번호 폴더, 하위 프로젝트 접두가 붙은 것 포함)이다.
- 앵커 슬러그는 GitHub 규칙이다(스펙 DECISION11). 제목에서 링크는 글만, 코드 스팬은 백틱만 지운 뒤 소문자로 바꾸고 `[^\p{L}\p{N}\p{M} _-]` 를 지운다. 공백을 `-` 로 바꾸고 같은 슬러그가 다시 나오면 `-1`, `-2` 를 붙인다. `\p{M}` 은 한글 자모 조합과 악센트를 남기려고 넣는다.

### 식별자 형식

- ADR 파일은 설정한 폴더와 그 하위 폴더에서 이름이 아래 셋 중 하나인 파일이다.
  - `^(\d{3,})-.+\.md$`: 식별자 `ADR-<숫자>`
  - `^ADR-(\d{8})-(.+)\.md$`: 날짜 꼴. 식별자 `ADR-<날짜> / <슬러그>`([adr-parallel.md](../../../skills/technical-design/references/adr-parallel.md#파일-이름과-머리)). 같은 날 ADR 은 슬러그로 갈린다
  - `^(ADR-[A-Za-z]*\d+)-.+\.md$`: 영역 글자 꼴(`ADR-M01`)
- `INDEX.md`, `README.md` 처럼 위 꼴이 아닌 파일은 ADR 이 아니다.
- 본문의 ADR 식별자는 읽은 파일 이름에서 나온 꼴만 찾는다. 저장소에 `ADR-M01` 꼴만 있으면 `ADR-\d+` 는 찾지 않는다. 날짜 꼴은 본문에서 `ADR-20261007 / slug` 와 `ADR-20261007` 을 모두 찾는다. 날짜만 적어 같은 날 ADR 이 여럿이면 후보를 모두 낸다.
- 후보 경로는 그 식별자를 가진 모든 폴더의 파일이다. 참조한 문서와 같은 폴더를 공유하는 상위가 가장 긴 후보를 앞에 둔다(스펙 DECISION19).

### 색인 형식

`write-index` 는 ADR 폴더마다 `INDEX.md` 를 쓴다(스펙 DECISION4, DECISION17).

```markdown
# ADR 목록

결정이 필요하면 이 목록을 먼저 읽고 필요한 파일만 연다. 이 파일은 plan 스킬의 `adr-docs.ts write-index` 가 만든다. 직접 고치지 않는다.

## 현행

| 번호 | 결정 | 상태 | 대체 관계 |
| --- | --- | --- | --- |
| [ADR-007](007-use-cloud.md) | 개발 배포 대상을 공공 클라우드로 통일한다 | accepted | [ADR-010](010-run-local.md) |

## 대체됨

| 번호 | 결정 | 상태 | 대체 관계 |
| --- | --- | --- | --- |
| [ADR-005](superseded/005-separate.md) | 두 개발 환경의 검증과 배포를 분리한다 | superseded | [ADR-007](007-use-cloud.md) |
```

- 제목은 첫 `#`/`##` 제목의 `ADR-식별자:`(날짜 꼴은 `ADR-식별자 / 슬러그:`) 뒤 글이다. 링크 글도 식별자 그대로다(날짜 꼴은 `ADR-20261007 / slug`). 없으면 `제목 확인 필요` 다. 상태는 `- **status**: \`값\`` 이고 없으면 `accepted` 다. ai-analysis 생성기와 같다.
- 「대체됨」 은 상태가 `superseded` 인 ADR 이다. 나머지는 「현행」 이다. 일부만 대체된 `accepted` 는 「현행」 에 남는다.
- 대체 관계는 이 ADR 을 대체한 ADR 이다. `- **대체된 부분**:` 항목(다음 `- ` 항목이나 제목 전까지) 안의 링크 가운데 링크 글에 ADR 식별자가 있고 대상이 ADR 파일인 것을 순서대로 중복 없이 적는다. 색인에 적는 글은 링크 글이 아니라 **대상 파일의 식별자**다. 링크 글과 대상이 어긋난 링크(`001-plugin-from-repo-root.md:4` 의 `[ADR-020](021-...)`)에서도 실제 파일을 가리킨다. 어긋남 자체를 위반으로 보는 검사는 이번 범위가 아니다. 없으면 `-` 다.
  `- **대체**:` 항목은 읽지 않는다. 이 저장소에서 「나를 대체한 ADR」(옛 001·002)과 「내가 대체한 ADR」(021·022) 두 뜻으로 쓰여 대체 관계가 뒤집힌다. 전체 대체도 「대체된 부분」 에 적는다는 [adr-rules.md 「대체와 이동」](../../../skills/technical-design/references/adr-rules.md#대체와-이동)과 ADR 양식을 따른다(코디네이터 확인 2026-11-06).
- 행 순서는 파일 이름 순서다. 한 절에 행이 없으면 표 대신 `없음` 한 줄을 둔다.
- 링크는 `INDEX.md` 기준 상대 경로라 `superseded/` 안 파일도 그대로 가리킨다.
- 생성을 켠 저장소는 이 형식이 색인의 원본이다. [adr-parallel.md 「INDEX.md」](../../../skills/technical-design/references/adr-parallel.md#indexmd) 의 세 열 형식과 [adr-rules.md 「구조」](../../../skills/technical-design/references/adr-rules.md#구조) 의 「끝에 새 행만 덧붙인다」 는 생성을 켜지 않은 저장소의 규칙으로 남긴다. 두 문서에 「생성을 켠 저장소는 `write-index` 를 돌리고 행을 직접 고치지 않는다」 를 더한다.

### 스킬 연결

| 스킬 | 언제 | 명령 | 쓰기 |
| --- | --- | --- | --- |
| spec | 4단계와 5단계, `run_doc_checks.py` 옆 | `check --changed-since <base>` | 하지 않는다. ADR 을 쓰지 않는다 |
| technical-design | 6단계, 그리고 ADR 을 만들거나 대체한 뒤([adr-rules.md 「대체한 뒤 검사」](../../../skills/technical-design/references/adr-rules.md#대체한-뒤-검사)) | ADR 을 바꿨으면 `write-index`, 그다음 `check --changed-since <base>` | 생성 모드면 한다 |
| review-fix | 5단계 검증 | `check --changed-since <PR base>` | ADR 을 고친 지적이 있으면 `write-index` 를 그 커밋에 넣는다 |
| docs-audit | 2단계 정적 검사, 5단계 재검증 | `check --scope <감사 범위>` | 승인된 수정이 ADR 을 바꿨으면 한다 |

- `--changed-since <ref>` 는 `git diff --name-only <ref>...HEAD` 와 작업 트리 변경(미추적 포함)을 「바뀐 파일」 로 본다. 위반을 바뀐 파일과 그 밖으로 나눠 그 밖은 `PR 밖 위반:` 머리 아래에 낸다. 종료 코드는 바뀐 파일의 위반만 센다(스펙 DECISION14).
  - 색인 위반(`INDEX_STALE`, `INDEX_DESYNC`)과 `ADR_DUPLICATE` 는 그 ADR 폴더 안 파일이 하나라도 바뀌었으면 바뀐 파일로 친다. ADR 을 더한 PR 이 색인을 고치지 않으면 걸려야 해서다.
  - 지운 파일을 가리키는 링크는 링크를 가진 문서가 바뀌지 않았어도 바뀐 파일로 친다. 이름을 바꾼 PR 이 깨뜨린 링크라서다. `git diff --name-status` 의 `D`, `R` 행으로 안다.
- spec·technical-design 도 `--changed-since` 를 쓴다. 저장소 전체의 옛 위반이 스펙 작성을 막지 않게 하고, DECISION14 와 같은 기준으로 자기가 바꾼 파일만 고친다. 기준 ref 는 orch 지시서의 base(기본 `origin/main`)다.
- docs-audit 는 `--changed-since` 없이 감사 범위 전체를 본다. `--scope` 는 결과를 그 경로 아래 문서로 좁힌다. 링크 대상은 범위 밖이어도 찾는다.
- 인자 값은 부르는 스킬이 plan 오버레이의 「오버레이가 지정하는 경로 값」 에서 읽는다. 새 값 둘을 그 표에 더한다.

| 값 | 기본값 | 예 | 받는 인자 |
| --- | --- | --- | --- |
| ADR 폴더 | `docs/adr` | `` `docs/adr` `modules/*/docs/adr` `` | `adr-docs.ts --adr-dir`(인라인 코드 하나마다 하나) |
| ADR 색인 생성 | 하지 않는다(번호 집합만 맞춘다) | 한다 | `adr-docs.ts --index generated` |

### 옛 호출 자리

같은 PR 에서 아래를 새 검사기로 바꾼다. 구현 PR 은 `git grep -n "check_adr_layout\|static_check\|ADR_DIR"` 를 다시 돌려 목록을 맞춘다.

| 자리 | 바꿀 것 |
| --- | --- |
| `skills/technical-design/references/adr-rules.md` 「대체한 뒤 검사」 | `check_adr_layout.py` 두 명령을 `write-index`(생성 저장소)와 `check --changed-since` 로 |
| `skills/plan/references/monorepo.md` 「오버레이가 지정하는 경로 값」 | `ADR 대체 배치` 행의 인자를 `adr-docs.ts --flat` 으로, 새 행 둘(「ADR 폴더」, 「ADR 색인 생성」) |
| `skills/docs-audit/SKILL.md` 1·2·5단계와 단계 표 | ADR 디렉터리를 plan 오버레이 「ADR 폴더」 에서 읽고, 2단계 통과 조건에 `adr-docs.ts check` 결과를 더한다. 「ADR 디렉터리가 여러 개면 각각 실행」 문장을 `--adr-dir` 여러 개로 |
| `skills/docs-audit/SKILL.md` 3단계 「구조 무결성」 | 깨진 링크와 ADR 번호·INDEX 의 판정 출처를 `adr-docs.ts` 로 |
| `skills/review-fix/SKILL.md` 5단계, `references/finish.md` 결과 보고 양식 | 검사 명령과 「PR 밖 위반」 자리 |
| `skills/spec/SKILL.md` 4·5단계, `skills/technical-design/SKILL.md` 6단계 | `run_doc_checks.py` 옆에 검사 명령 |
| `docs/features/node-runtime/tasks/repo-base/phase-02.md:76` | `check_adr_layout.py docs/adr --flat` 검증 줄을 `adr-docs.ts check` 로 |
| `docs/features/node-runtime/spec.md` 「선행 조건과 순서」 | 영역 3·7 의 옮길 목록에서 지운 검사기를 뺀다는 한 줄(스펙 DECISION7) |
| `docs/code-architecture.md` | plan 번들 `scripts/` 의 `.ts` 가 생긴 것과 `tsconfig.json` 범위 |
| `tsconfig.json` `include` | `skills/plan/scripts/**/*.ts` 를 더한다(node-runtime 설계의 「처음 `.ts` 를 들이는 PR 이 더한다」) |

### 기존 두 검사기

- `skills/plan/scripts/check_adr_layout.py` 와 그 테스트를 지운다(스펙 DECISION1). `ADR_PLACEMENT` 와 ADR 링크 검사가 새 검사기로 간다.
- `static_check.py` 에서 `check_index`, `check_links`(와 `slug`, `anchors_of`, `links_of`, `is_local`)를 지운다. 표 열 수, 제목 단계, 코드 펜스, `PLAN_REF`, `LISTED_ITEMS` 는 남는다.
  - 첫 인자 `ADR_DIR` 은 받기만 하고 쓰지 않는다. stderr 에 「ADR 검사는 plan 의 adr-docs.ts 가 맡는다」 를 한 줄 낸다. fos-blog 오버레이(`.claude/docs-audit-overlay.md:24`)처럼 두 인자로 부르는 곳이 깨지지 않게 한다. 인자를 없애는 일은 docs-audit 의 다음 major 로 미룬다.
- `run_static_check.py` 는 그대로다. docs-audit SKILL.md 2단계가 그 뒤에 `adr-docs.ts check` 를 한 번 더 부른다. 표 하나로 합치려면 Python 실행기가 plan 번들 경로를 알아야 해서 나누어 둔다.

### fos-skills 첫 적용

- `.claude/plan-overlay.md` 가 없어 새로 만든다. 값은 「ADR 색인 생성: 한다」 하나다. 「ADR 폴더」 와 「ADR 대체 배치」 는 기본값(`docs/adr`, `superseded/` 폴더)이다.
- `superseded` 인 [ADR-001](../../adr/superseded/001-plugin-from-repo-root.md), [ADR-002](../../adr/superseded/002-plugin-version-is-commit-sha.md) 가 `docs/adr` 바로 아래에 있다. 이 저장소 규칙(adr-rules 「대체와 이동」, 사용자 결정 2026-10-24)대로 `docs/adr/superseded/` 로 옮기고 가리키는 상대 링크(7곳, `git grep`)를 고친다.
- 저장소 전체를 검사해 나온 위반(계획서 밖 링크 없는 `ADR-NNN` 30여 곳 등)을 같은 PR 의 별도 커밋에서 고친다. 이 저장소가 첫 사용처라 전체가 0 이어야 생성과 검사를 함께 검증한다(스펙 DECISION15).
- 그다음 `write-index` 로 `docs/adr/INDEX.md` 를 두 표로 다시 만든다.

### ai-analysis 이전

두 번째 PR 은 orch worker 가 ai-analysis 에서 한다.

- 루트 plan 오버레이에 「ADR 폴더」(`docs/adr`, `modules/*/docs/adr`)와 「ADR 색인 생성: 한다」 를 적는다. 「ADR 대체 배치」 는 이미 「폴더 없음」 이다.
- `scripts/check/check-docs.py` 에서 `adr_directories`, `adr_files`, `index_content`, `heading_anchors`, `check` 의 링크·번호 부분과 `--write-index`, `--only index` 를 지운다. 저장소 고유 검사(`check_top_level_docs`, `data_schema_history_warnings`, `code_architecture_*`)는 남긴다.
- `scripts/tests/test_check_docs.py` 에서 지운 함수의 테스트를 지운다.
- 색인을 만드는 명령을 안내하는 곳(`AGENTS.md:41`, `docs/contributing/pull-request.md:52`, `scripts/verify/docs.sh` 머리 주석)을 「technical-design·review-fix 스킬이 `adr-docs.ts write-index` 로 만든다」 로 고친다. 사람이 직접 돌릴 때의 명령은 설치된 plan 번들 경로로 적는다.
- 새 검사기로 색인 7개를 다시 만들고, 전체 검사 결과를 옛 검사기와 대조해 PR 본문에 붙인다(REQ1).

## 인터페이스와 데이터

```text
node "$PLAN_SKILL_DIR/scripts/adr-docs.ts" check [--adr-dir GLOB]... [--flat] [--index generated|ids] [--changed-since REF] [--scope PATH]
node "$PLAN_SKILL_DIR/scripts/adr-docs.ts" write-index [--adr-dir GLOB]...
```

- cwd 는 대상 저장소 루트다. git 저장소 밖이면 종료 코드 2 다.
- `--adr-dir` 는 저장소 루트 기준 glob 이다(`*` 한 층만). 주지 않으면 `docs/adr` 다. 맞는 폴더가 없으면 ADR 검사는 건너뛰고 링크 검사만 한다. 그 사실을 stderr 에 한 줄 낸다.
- 출력: 위반마다 stdout 에 `경로:줄: 코드 내용` 한 줄. 경로는 저장소 루트 기준이다. 줄 번호를 모르는 위반(색인, 중복)은 `:1` 이다. `ADR_UNLINKED` 는 `→ 후보: a.md, b.md` 를 붙인다. 후보가 없으면 `→ 후보 없음` 이다.
- 마지막에 stderr 로 `검사한 Markdown: N개, ADR 폴더: M개` 를 낸다.
- 종료 코드: 0 위반 없음, 1 위반 있음, 2 실행하지 못함(인자 오류, git 밖, 읽기 실패). `write-index` 는 쓰면 0, 실패하면 2 다.
- 저장하는 데이터는 `INDEX.md` 뿐이다. 다른 파일은 고치지 않는다(스펙 DECISION2).

## 실패와 일관성

- `write-index` 는 내용이 같으면 파일을 다시 쓰지 않는다. 같은 입력이면 같은 바이트를 낸다(줄 끝 `\n`, 마지막 줄 바꿈 하나).
- 두 PR 이 같은 ADR 폴더에 ADR 을 더하면 색인이 충돌한다. 충돌 뒤 `write-index` 를 다시 돌리면 풀린다. 생성 색인은 직접 합치지 않는다.
- 호환과 배포 순서:
  1. orch PR3 머지 뒤 fos-skills PR 을 연다(스펙 DECISION7). node-runtime 저장소 기반 PR(`repo-base`)이 먼저 머지됐으면 그 허용 목록(`scripts/runtime-policy.json` 의 `pending`)에서 지운 `check_adr_layout.py` 와 테스트를 뺀다.
  2. fos-skills PR 머지와 플러그인 갱신 뒤 ai-analysis PR 을 연다. 그 전에는 ai-analysis 가 옛 `check-docs.py` 로 돈다.
  3. 팀 저장소는 node-runtime 의 팀 PR 이 함께 반영한다. 그 전 급한 내보내기는 `team-export` 브랜치(node-runtime DECISION10)를 쓰며, 이 기능의 변경은 싣지 않는다. 팀 사본은 Python 검사기에 머문다.

## 검증 전략

| REQ | 경계 | 방법 |
| --- | --- | --- |
| REQ1 | 명령 경계 | `skills/plan/tests/adr-docs.spec.ts`(`node:test`)가 임시 git 저장소에 표본을 만들고 명령을 실행해 stdout 줄과 종료 코드를 본다. 검사 코드마다 위반 하나와 통과 하나, 코드 블록·코드 스팬·계획서 폴더 예외, 한글 제목 앵커와 중복 제목 `-1` 을 넣는다 |
| REQ1 | ai-analysis 대조 | 첫 PR 의 verify 가 ai-analysis 를 읽기만 해 한 번 대조하고, 두 번째 PR 이 이전 뒤 다시 한다. 같은 ai-analysis 커밋에서 옛 `check-docs.py` 의 링크·앵커·번호 참조·중복 위반 목록과 새 검사기의 목록을 비교해 PR 본문에 붙인다. 새 검사기가 더 잡는 줄은 범위가 넓어진 것인지(스펙 DECISION18) 분류한다 |
| REQ2 | 명령 경계 | 같은 테스트에 `modules/*/docs/adr` 두 폴더(같은 번호 겹침), `ADR-M01`, `ADR-20261007` 표본을 둔다 |
| REQ3 | 명령 경계 | `write-index` 뒤 `check` 가 0, 직접 고친 색인이면 `INDEX_STALE`, 접두 링크 글의 대체 관계, 「대체됨」 분류, 빈 절의 `없음` 을 본다 |
| REQ4 | 문서 계약 | 기존 계약 테스트(`skills/plan/tests/test_technical_design_contract.py` 등)의 꼴로 네 스킬 문서가 `adr-docs.ts` 를 부르는지, `check_adr_layout` 을 부르는 문서가 없는지 본다. `git grep check_adr_layout` 이 변경 이력 밖에서 비어야 한다 |
| REQ5 | 문서 | 이 저장소의 호출(`git grep`)과 다른 저장소 검색 결과를 PR 본문에 남긴다. plan 의 CHANGELOG 호환성 항목 |
| REQ6 | ai-analysis | `scripts/verify.sh docs` 통과, `check-docs.py` 에 일반 검사 함수가 없음(`grep`) |
| REQ7 | 이 저장소 | `node skills/plan/scripts/adr-docs.ts check --index generated` 가 0 |

CI 는 지금 `node --test` 를 폴더 목록으로 돈다(`.github/workflows/ci.yml:42`). 새 테스트가 돌도록 `skills/plan/tests/*.spec.ts` 를 더한다. testkit 실행기가 먼저 머지됐으면 그 실행기의 대상에 더한다.

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 검사기 자리 | `skills/plan/scripts/adr-docs.ts` | 작성자 | 부르는 네 스킬이 이미 plan 번들 경로를 쓴다. technical-design 은 문서만 있고 scripts 가 없다 |
| DECISION2 | 오버레이를 읽는 쪽 | 부르는 스킬이 읽어 인자로 넘긴다 | 작성자 | `ADR 대체 배치` → `--flat` 의 기존 방식. TypeScript 로 오버레이 탐색을 다시 만들면 Python `overlay_paths.py` 와 두 벌이 되고, node-runtime 영역 7 이 옮긴다 |
| DECISION3 | spec·technical-design 의 검사 범위 | `--changed-since <base>`. 바뀐 파일의 위반만 막는다 | 작성자 | 스펙 DECISION14 와 같은 기준이다. 저장소의 옛 위반이 스펙 작성을 막지 않는다 |
| DECISION4 | 지운 파일을 가리키는 링크의 귀속 | 바뀐 파일로 친다 | 작성자 | 스펙 DECISION14 의 배경(이름 바뀐 ADR 의 깨진 링크를 놓치지 않는다) |
| DECISION5 | `static_check.py` 의 `ADR_DIR` 인자 | 받기만 하고 stderr 에 안내한다. 없애는 것은 docs-audit 다음 major | 작성자 | fos-blog 오버레이가 두 인자로 부른다. 출력 줄이 줄어드는 것은 스펙 DECISION1 이 정했다 |
| DECISION6 | 버전 | plan 은 major. PR 이 `metadata.version` 과 CHANGELOG 를 직접 올리고 `호환성:` 항목에 지운 `check_adr_layout.py` 와 새 명령을 적는다. docs-audit, spec, technical-design, review-fix 는 minor 조각 | 작성자 | README 「버전과 변경 이력」 396·401줄. docs-audit 는 부르는 꼴(인자 둘, 종료 코드)이 그대로이고, 빠진 검사는 같은 2단계의 새 명령이 맡아 기존 사용법이 깨지지 않는다. docs-audit major 는 옛 이름 호환 제거(5.0.0)와 묶여 있어 따로 올리지 않는다 |
| DECISION7 | 앵커 슬러그의 문자 집합 | `\p{L}\p{N}\p{M}`, 공백, `_`, `-` | 작성자 | 스펙 DECISION11. JS `\w` 는 한글을 잡지 않는다 |
| DECISION8 | 「ADR 폴더」 의 원본 | 루트 plan 오버레이 한 곳. docs-audit 도 이 값을 읽는다 | 작성자 | 검사기가 저장소 전체를 보므로 하위 프로젝트 값을 합치면 일부만 넘어간다. docs-audit 오버레이의 옛 ADR 디렉터리 줄은 쓰이지 않게 되고, 다른 저장소의 그 줄은 구현 PR 의 검색 목록에 남긴다 |
| DECISION9 | 테스트 의존 | `adr-docs.spec.ts` 는 Node 내장 모듈만 쓰고 testkit 을 import 하지 않는다 | 작성자 | plan 은 팀으로 내보내는 스킬이다([node-runtime 설계 「공통 testkit」](../node-runtime/design.md#공통-testkit)) |
| DECISION10 | 생성 색인과 adr-parallel 형식 | 생성을 켠 저장소는 생성 형식이 원본이고, adr-parallel 의 세 열 형식은 생성을 켜지 않은 저장소에 남긴다 | 작성자 | 스펙 DECISION4 가 열 넷을 정했다. 생성 저장소에서 「한 줄만 더한다」 는 `write-index` 가 대신한다 |
| DECISION11 | fos-skills 의 대체된 ADR 둘 | `docs/adr/superseded/` 로 옮긴다 | 작성자 | 이 저장소 규칙(adr-rules 「대체와 이동」, 사용자 결정 2026-10-24)이 이미 정했다. 「폴더 없음」 으로 바꾸면 그 결정을 뒤집는다 |
| DECISION12 | 결정 기록 | fos-skills 에 새 ADR 하나(engineering-process): 문서 링크·ADR 검사는 plan 번들 검사기 하나가 소유하고 작성 단계에서 돈다. CI 사본을 두지 않는다 | 작성자 | 독립 검토 지적. [ADR-024](../../adr/024-decision-record-classification.md) 는 이 저장소 ADR 이 절차 결정을 담는다고 정했고, 기각한 대안(CI 사본, 저장소 스크립트 유지)이 있다(adr-rules 「남길 조건」) |

## 결정 기록 연결

| 결정 | 종류 | ADR 또는 필요 없음의 이유 | 현재 규칙의 원본 |
| --- | --- | --- | --- |
| 문서 링크·ADR 검사의 소유와 실행 시점(스펙 DECISION1, DECISION5) | engineering-process | 새 ADR(DECISION12). 첫 PR 이 [ADR-026](../../adr/026-docs-checks-at-authoring-time.md) 으로 썼다 | 각 스킬 SKILL.md 의 검사 단계, `adr-docs.ts` 머리 주석 |
