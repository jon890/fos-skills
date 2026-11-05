# 레포 설정 탐색과 하위 프로젝트

`plan`, `implementation`, `docs-audit`, `review-fix` 가 레포 설정을 찾는 방법이다.
이 스킬들은 시작할 때 이 문서를 따라 오버레이를 찾고, 자기 스킬 이름만 바꿔 읽는다.

## 명령으로 판정한다

아래 절의 판정과 탐색 순서를 `scripts/overlay_paths.py` 가 그대로 실행한다.
`$PLAN_SKILL_DIR` 은 plan 번들 경로이고, `$SKILL` 은 부르는 스킬 이름이다.
변경 경로를 알면 인자로 넘기고, plan 이름을 알면 `--plan` 으로 넘긴다.

```bash
# cwd: 대상 저장소 루트
git diff --name-only origin/main...HEAD | python3 "$PLAN_SKILL_DIR/scripts/overlay_paths.py" --skill "$SKILL" -
```

| 종료 코드 | 뜻 |
| --- | --- |
| 0 | `targets` 가 대상 하위 프로젝트다. 단일 저장소면 비어 있다. `search` 순서대로 읽는다 |
| 1 | 모노레포인데 대상을 정하지 못했다. 사용자에게 묻고 `--sub` 로 다시 돌린다 |
| 2 | 실행하지 못했다. 저장소 밖이거나 `--sub` 에 오버레이가 없다 |

새 이름 `plan` 은 `planning-overlay.md`, `implementation` 은 `build-with-teams-overlay.md` 를 읽기 호환으로 받는다.
하위 프로젝트의 새 이름, 옛 이름, 루트의 새 이름, 옛 이름 순으로 값을 찾는다. 새 이름의 값이 우선이며 사본을 만들지 않는다.

`docs-audit` 는 같은 위치에 새 이름 오버레이가 없을 때만 `docs-check-overlay.md` 를 읽고 stderr 에 경고한다. 이 호환은 docs-audit 의 다음 major(5.0.0)에서 제거한다.

`docs-consolidate` 도 이 탐색기를 사용한다. 같은 위치에 자기 오버레이가 있으면 그것을 읽고, 없으면 docs-audit 의 폴백과 경고를 따른다.

## 단일 저장소

저장소 루트 하나가 프로젝트 하나인 경우다. 아래 순서로 찾는다.

1. `<repo-root>/.claude/<skill>-overlay.md`
2. 그 저장소의 하네스 지침 파일. `AGENTS.md` 와 `CLAUDE.md` 를 본다
3. 어디에도 없으면 사용자에게 확인한다

하위 프로젝트 오버레이가 하나도 없으면 이 순서만 쓴다.

## 모노레포인지 판정한다

**루트 바로 아래 디렉터리에 오버레이가 하나라도 있으면 모노레포로 본다.**
오버레이가 없으면 단일 저장소다.
오버레이를 가진 디렉터리가 하위 프로젝트다. `frontend/.claude/plan-overlay.md` 가 있으면 `frontend` 가 하위 프로젝트다.

## 작업 대상 하위 프로젝트를 정한다

앞에서 정해지면 뒤를 보지 않는다.

| 순서 | 근거 | 예 |
| --- | --- | --- |
| 1 | 사용자가 지정했다 | "frontend 쪽 계획", `/implementation fe-plan027` 의 접두사 |
| 2 | plan 이름의 접두사가 어느 하위 프로젝트 오버레이의 plan 접두사와 같다 | `fe-plan027-...` 이고 `frontend` 오버레이의 접두사가 `fe-` |
| 3 | 변경 경로가 한 하위 프로젝트 안에만 있다 | PR diff 가 모두 `backend/` 아래다 |
| 4 | cwd 가 한 하위 프로젝트 안이다 | `cd frontend` 한 뒤 호출했다 |
| 5 | 위에서 정해지지 않았다 | 사용자에게 묻는다 |

**변경이 두 하위 프로젝트에 걸치면 하나로 정하지 않는다.**
검증 명령과 규칙을 넣을 위치처럼 경로에 딸린 값은 그 경로의 하위 프로젝트 오버레이에서 각각 읽고 둘 다 실행한다.
plan 접두사처럼 하나만 골라야 하는 값은 사용자에게 묻는다.
`plan` 은 기본으로 하위 프로젝트마다 plan 을 나눈다. 한 PR 에서 두 쪽이 함께 바뀌어야 하면 사용자에게 확인한다.

## 모노레포의 탐색 순서

`$SUB` 는 위에서 정한 하위 프로젝트 디렉터리다.

1. `<repo-root>/$SUB/.claude/<skill>-overlay.md`
2. `<repo-root>/.claude/<skill>-overlay.md`
3. 하네스 지침 파일. `$SUB/AGENTS.md`, `$SUB/CLAUDE.md`, 루트의 `AGENTS.md`, `CLAUDE.md` 순서로 본다
4. 어디에도 없으면 사용자에게 확인한다

**값 하나마다 이 순서로 찾는다.** 하위 프로젝트 오버레이에 검증 명령만 있고 브랜치 규칙이 없으면,
브랜치 규칙은 루트 오버레이나 하네스 지침에서 읽는다.
같은 값이 두 곳에 있으면 앞의 것을 쓴다.

## 오버레이가 지정하는 경로 값

아래 값은 스크립트 인자로 넘어가므로 오버레이에 이 이름으로 적는다.
경로는 저장소 루트 기준이다. 적지 않으면 기본값을 쓴다.

| 값 | 기본값 | 예 | 받는 스크립트 인자 |
| --- | --- | --- | --- |
| docs 경로 | `docs/` | `frontend/docs/` | `plan_precheck.py --docs-dir` |
| tasks 경로 | 새 기능은 `<기능 폴더>/tasks/`, 기존·기능 없는 작업은 `tasks/` | `tasks/` | `plan_number.sh --tasks-dir`, `verify_task.py --tasks-dir`, `plan_precheck.py --tasks-dir` |
| plan 접두사 | 없음 | `fe-` | `plan_number.sh --prefix` |
| plan 이름 형식 | `{접두사}plan{N}-` | `area-(\d{3})-` | `plan_number.sh --name-regex` (접두사 대신 준다) |
| ADR 폴더 | `docs/adr` | `` `docs/adr` `modules/*/docs/adr` `` | `adr-docs.ts --adr-dir` (인라인 코드 하나마다 하나) |
| ADR 색인 생성 | 하지 않는다(번호 집합만 맞춘다) | 한다 | `adr-docs.ts --index generated` |
| ADR 대체 배치 | `superseded/` 폴더 | 폴더 없음(색인으로 구분) | `adr-docs.ts --flat` |

오버레이에는 아래처럼 적는다.

```markdown
## 저장소 배치

| 값 | 값 |
| --- | --- |
| docs 경로 | `frontend/docs/` |
| tasks 경로 | 새 기능은 `<기능 폴더>/tasks/`, 기존·기능 없는 작업은 `tasks/` |
| plan 접두사 | `fe-` |
```

새 기능은 `<기능 폴더>/tasks/<작업 이름>` 을 쓴다. 아래 번호 규칙은 기존 계획과 기능 없는 작업에만 적용한다.

기존 plan 디렉터리 이름은 `{접두사}plan{N}-{slug}` 이다. 접두사가 `fe-` 면 `tasks/fe-plan027-login/` 이 된다.
번호는 접두사마다 따로 센다. `fe-plan027` 과 `be-plan027` 은 다른 계획이다.

phase 파일의 경로는 하위 프로젝트 안의 파일도 저장소 루트 기준으로 적는다.
`src/app.ts` 가 아니라 `frontend/src/app.ts` 다. 커밋 전 대조가 `git diff --cached` 의 루트 기준 경로와 맞추기 때문이다.

### ADR 문서 검사

spec, technical-design, review-fix, docs-audit 는 `$PLAN_SKILL_DIR/scripts/adr-docs.ts` 를 같은 인자로 부른다.
판정, 출력 줄, 종료 코드는 그 파일 머리 주석이 소유한다.

- ADR 세 값은 **루트** `.claude/plan-overlay.md` 에서만 읽는다. 검사기가 저장소 전체를 보므로 하위 프로젝트 오버레이에 나눠 적지 않는다.
- `$ADR_DIRS` 는 「ADR 폴더」 의 인라인 코드마다 `--adr-dir <값>` 이다. 값이 없으면 비운다(기본 `docs/adr`).
- `$ADR_ARGS` 는 `$ADR_DIRS` 에 「ADR 색인 생성」 이 「한다」 면 `--index generated`, 「ADR 대체 배치」 가 「폴더 없음」 이면 `--flat` 을 더한 것이다.
- `$BASE` 는 orch 지시서의 base 브랜치(`origin/<base>`)다. review-fix 는 그 PR 의 base 브랜치다. 둘 다 없으면 `git symbolic-ref --short refs/remotes/origin/HEAD` 다.
- `$ADR_DIRS`, `$ADR_ARGS` 는 인자 목록을 가리키는 표기다. 문자열 변수 하나에 담아 펼치지 않고 인자를 하나씩 적는다. zsh 는 변수를 낱말로 나누지 않아 인자 하나로 넘어간다. `*` 가 든 값은 셸이 먼저 풀지 않게 따옴표로 감싼다(`--adr-dir 'modules/*/docs/adr'`).

```bash
# cwd: 대상 저장소 루트
node "$PLAN_SKILL_DIR/scripts/adr-docs.ts" write-index $ADR_DIRS          # 색인 생성을 켠 저장소에서 ADR 을 바꿨을 때
node "$PLAN_SKILL_DIR/scripts/adr-docs.ts" check --changed-since "$BASE" $ADR_ARGS
```

`PR 밖 위반:` 의 뜻과 귀속 규칙은 검사기 머리 주석이 소유한다. 부르는 스킬은 그 아래 줄을 고치지 않는다.
링크 없는 ADR 식별자(`ADR_UNLINKED`)는 후보 경로를 보고 작성자가 링크를 건다. 검사기는 본문을 고치지 않는다.
색인 생성을 켠 저장소는 `INDEX.md` 를 직접 고치지 않고 `write-index` 를 다시 돌린다.

## 스크립트가 직접 읽는 값

아래 값은 인자로 넘기지 않는다. 스크립트가 위 탐색 순서로 오버레이를 찾아 행 이름으로 읽는다.
값을 오버레이에 두면 단계마다 인자를 챙기지 않아도 저장소 검사가 그 단계에서 돈다.
표가 어느 절에 있든 첫 칸이 아래 이름인 행을 읽는다. 적지 않으면 그 검사를 하지 않거나 기본값을 쓴다.

| 값 | 둘 오버레이 | 형식 | 예 | 읽는 스크립트 |
| --- | --- | --- | --- | --- |
| PR 변경 파일 상한 | plan | 정수, 또는 `<JSON 파일>#<키.키>` | `` `.github/pr-size.json#grades.B.files` `` | `verify_task.py`. 기본 기준 40개 대신 쓴다 |
| 파일 길이 상한 | plan | 정수, 또는 `<JSON 파일>#<키.키>` | `` `600` `` | `verify_task.py` |
| 파일 길이 대상 | plan | 인라인 코드로 적은 glob 목록. `/` 없는 패턴은 파일 이름에 맞춘다 | `` `*.java` `` | `verify_task.py`. 없으면 코드 파일 전부다 |
| PR 크기 예외 | plan | 저장소의 크기 예외 규칙을 가리키는 링크나 한 문장 | `` [크기 예외](../docs/contributing/pull-request.md#pr-크기) `` | critic 이 읽는다([critic 계약](../../implementation/references/role-critic.md) 7) |
| 문서 검사 명령 | spec 또는 technical-design | 인라인 코드 하나가 명령 하나다. 저장소 루트에서 실행한다 | `` `scripts/verify.sh docs` `` | `run_doc_checks.py`. technical-design 은 자기 오버레이에 없으면 spec 오버레이를 읽는다 |

크기 기준은 원본 설정 파일이 따로 있으면 `<JSON 파일>#<키>` 로 가리킨다. 숫자를 오버레이에 옮겨 적으면 원본만 바뀌었을 때 두 값이 어긋난다.
「PR 변경 파일 상한」 이 있으면 저장소의 크기 측정처럼 계획 폴더만 빼고 변경 파일을 모두 센다.
「파일 길이 상한」 은 `수정` 행의 파일이 상한의 95% 이상이면 경고한다. 구현이 줄을 더하면 저장소 검사가 실패하므로, 새 파일로 나눌지 계획에서 정하게 한다.

```markdown
## 저장소 검사

| 값 | 값 |
| --- | --- |
| PR 변경 파일 상한 | `.github/pr-size.json#grades.B.files` |
| 파일 길이 상한 | `600` |
| 파일 길이 대상 | `*.java` |
| 문서 검사 명령 | `scripts/verify.sh docs` |
```
