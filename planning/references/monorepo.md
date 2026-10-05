# 레포 설정 탐색과 하위 프로젝트

`planning`, `build-with-teams`, `docs-check`, `review-fix` 가 레포 설정을 찾는 방법이다.
네 스킬은 시작할 때 이 문서를 따라 오버레이를 찾고, 자기 스킬 이름만 바꿔 읽는다.

## 명령으로 판정한다

아래 절의 판정과 탐색 순서를 `scripts/overlay_paths.py` 가 그대로 실행한다.
`$PLANNING_SKILL_DIR` 은 planning 번들 경로이고, `$SKILL` 은 부르는 스킬 이름이다.
변경 경로를 알면 인자로 넘기고, plan 이름을 알면 `--plan` 으로 넘긴다.

```bash
# cwd: 대상 저장소 루트
git diff --name-only origin/main...HEAD | python3 "$PLANNING_SKILL_DIR/scripts/overlay_paths.py" --skill "$SKILL" -
```

| 종료 코드 | 뜻 |
| --- | --- |
| 0 | `targets` 가 대상 하위 프로젝트다. 단일 저장소면 비어 있다. `search` 순서대로 읽는다 |
| 1 | 모노레포인데 대상을 정하지 못했다. 사용자에게 묻고 `--sub` 로 다시 돌린다 |
| 2 | 실행하지 못했다. 저장소 밖이거나 `--sub` 에 오버레이가 없다 |

## 단일 저장소

저장소 루트 하나가 프로젝트 하나인 경우다. 아래 순서로 찾는다.

1. `<repo-root>/.claude/<skill>-overlay.md`
2. 그 저장소의 하네스 지침 파일. `AGENTS.md` 와 `CLAUDE.md` 를 본다
3. 어디에도 없으면 사용자에게 확인한다

하위 프로젝트 오버레이가 하나도 없으면 이 순서만 쓴다. 이전 버전과 동작이 같다.

## 모노레포인지 판정한다

**루트 바로 아래 디렉터리에 오버레이가 하나라도 있으면 모노레포로 본다.**

```bash
# cwd: 저장소 루트
find . -mindepth 3 -maxdepth 3 -path './*/.claude/*-overlay.md'
```

zsh 에서 `ls */.claude/*-overlay.md` 는 맞는 파일이 없으면 셸이 `no matches found` 로 멈춘다. `find` 는 빈 출력으로 끝난다.

출력이 비었으면 단일 저장소다.
출력에 나온 디렉터리 이름이 하위 프로젝트다. `frontend/.claude/planning-overlay.md` 가 있으면 `frontend` 가 하위 프로젝트다.

## 작업 대상 하위 프로젝트를 정한다

앞에서 정해지면 뒤를 보지 않는다.

| 순서 | 근거 | 예 |
| --- | --- | --- |
| 1 | 사용자가 지정했다 | "frontend 쪽 계획", `/build-with-teams fe-plan027` 의 접두사 |
| 2 | plan 이름의 접두사가 어느 하위 프로젝트 오버레이의 plan 접두사와 같다 | `fe-plan027-...` 이고 `frontend` 오버레이의 접두사가 `fe-` |
| 3 | 변경 경로가 한 하위 프로젝트 안에만 있다 | PR diff 가 모두 `backend/` 아래다 |
| 4 | cwd 가 한 하위 프로젝트 안이다 | `cd frontend` 한 뒤 호출했다 |
| 5 | 위에서 정해지지 않았다 | 사용자에게 묻는다 |

**변경이 두 하위 프로젝트에 걸치면 하나로 정하지 않는다.**
검증 명령과 규칙을 넣을 위치처럼 경로에 딸린 값은 그 경로의 하위 프로젝트 오버레이에서 각각 읽고 둘 다 실행한다.
plan 접두사처럼 하나만 골라야 하는 값은 사용자에게 묻는다.
`planning` 은 기본으로 하위 프로젝트마다 plan 을 나눈다. 한 PR 에서 두 쪽이 함께 바뀌어야 하면 사용자에게 확인한다.

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

아래 셋은 스크립트 인자로 넘어가므로 오버레이에 이 이름으로 적는다.
경로는 저장소 루트 기준이다. 적지 않으면 기본값을 쓴다.

| 값 | 기본값 | 예 | 받는 스크립트 인자 |
| --- | --- | --- | --- |
| docs 경로 | `docs/` | `frontend/docs/` | `plan_precheck.py --docs-dir` |
| tasks 경로 | `tasks/` | `tasks/` | `plan_number.sh --tasks-dir`, `verify_task.py --tasks-dir`, `plan_precheck.py --tasks-dir` |
| plan 접두사 | 없음 | `fe-` | `plan_number.sh --prefix` |

오버레이에는 아래처럼 적는다.

```markdown
## 저장소 배치

| 값 | 값 |
| --- | --- |
| docs 경로 | `frontend/docs/` |
| tasks 경로 | `tasks/` |
| plan 접두사 | `fe-` |
```

plan 디렉터리 이름은 `{접두사}plan{N}-{slug}` 이다. 접두사가 `fe-` 면 `tasks/fe-plan027-login/` 이 된다.
번호는 접두사마다 따로 센다. `fe-plan027` 과 `be-plan027` 은 다른 계획이다.

phase 파일의 경로는 하위 프로젝트 안의 파일도 저장소 루트 기준으로 적는다.
`src/app.ts` 가 아니라 `frontend/src/app.ts` 다. 커밋 전 대조가 `git diff --cached` 의 루트 기준 경로와 맞추기 때문이다.
