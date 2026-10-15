# 세션, 브랜치, 워크트리 정리

`survey_sessions.py` 와 `survey_git.py` 의 결과를 실행할 때 읽는다.
실행할 목록은 `survey_git.py --json` 으로 만든다. 항목마다 `repo`, 브랜치 이름, 끝 커밋 전체 해시 `tip`, 분류 `class` 가 있다.
텍스트 출력은 사람이 읽는 용도다. 맨 끝 `## 합계` 줄이 저장소 줄(`## 경로`)과 같은 모양이라 줄 단위로 파싱하면 저장소로 잘못 잡힌다.

`$REPO` 는 저장소 경로, `$WT` 는 워크트리 경로, `$BR` 는 브랜치 이름, `$BASE` 는 조사 JSON 의 `base`, `$SURVEY` 는 조사 JSON 을 저장한 파일, `$PIDS` 는 사용자가 지정한 PID 다.

## 에이전트 세션

**기본으로 직접 종료하지 않는다.** PID, 실행 시간, cwd 표를 보여 주고 사용자가 닫게 한다.

- 사용자가 PID 를 지정해 승인하면 `kill -TERM` 만 쓴다.
- 현재 세션과 그 조상은 절대 대상에 넣지 않는다. `survey_sessions.py` 가 "현재" 로 표시한 PID 다.
- 그 세션의 cwd 워크트리에 미커밋 변경이 있으면 종료 전에 같이 알린다.

```bash
git -C "$WT" status --short | wc -l
kill -TERM $PIDS
```

반복 helper 묶음은 부모 앱이 다시 띄우는 것이면 승인 뒤 `pkill -f` 로 종료해도 된다.
무엇이 다시 띄우는지(예: IntelliJ 의 tailwind 플러그인이 `oxide-helper.js` 를 다시 띄운다) 한 줄로 적어 사용자에게 보인다.

## 워크트리

"제거 후보" 는 머지됨, 미커밋 변경 0, 그 브랜치의 stash 0, 사용 중 아님을 모두 만족한 것이다.
`--check-prs` 로 나온 "제거 후보(PR 머지됨)" 는 머지됨 대신 머지된 PR 이 있는 것이고, 나머지 조건은 같다.
기준 브랜치와 같은 커밋에서 막 만든 워크트리도 머지됨으로 잡히므로, 경과 일수가 짧은 것은 사용자에게 한 번 더 확인한다.

Orca 관리 워크트리는 Orca 명령으로 지우고 기록을 정리한다. 그 밖은 git 으로 지운다.

```bash
orca worktree rm --worktree "path:$WT"
git -C "$REPO" worktree prune
```

```bash
git -C "$REPO" worktree remove "$WT"
```

- `--force` 는 쓰지 않는다. 미커밋 변경이 있으면 거절되는 것이 맞다.
- "기록만 남음"(prunable)은 디렉터리가 이미 없는 기록이므로 `git -C "$REPO" worktree prune` 만 돌린다.
- "PR 확인 필요"는 upstream 이 사라졌지만 머지 판정이 안 된 것이다. squash 머지일 수 있으므로 아래 브랜치 절차로 PR 상태를 확인한 뒤에만 제거한다.
- 워크트리에 체크아웃된 브랜치는 브랜치 후보에서 빠진다. 워크트리를 지운 뒤 `survey_git.py` 를 다시 돌려야 그 브랜치가 후보로 올라온다.

## 브랜치

실행은 `scripts/delete_branches.py` 가 한다. 입력은 `survey_git.py --json` 을 저장한 파일이다.
기본은 dry-run 이라 아무것도 바꾸지 않고, 브랜치마다 무엇을 할지(삭제 예정, 유지와 이유, 건드리지 않음)만 보인다. 사용자 승인 뒤에 `--apply` 를 붙여 돈다.
`--only` 로 지울 분류를 고른다. `merged`(삭제 후보 `-d`, 기본)와 `pr-merged`(PR 머지됨 `-D`)가 있고, 승인받은 묶음에 맞춰 고른다.
브랜치마다 결과를 내고 실패가 하나라도 있으면 종료 코드가 1 이다. 원격 브랜치는 이 스킬에서 지우지 않는다.

```bash
python3 "$SKILL_DIR/scripts/survey_git.py" --json > "$SURVEY"
python3 "$SKILL_DIR/scripts/delete_branches.py" "$SURVEY" --only merged
python3 "$SKILL_DIR/scripts/delete_branches.py" "$SURVEY" --only merged --apply
```

`survey_git.py` 의 `KEEP_BRANCHES` 에 든 이름은 기준 브랜치가 아니어도 후보에서 빠진다. 기본 브랜치나 배포 브랜치로 쓰는 이름이다.

### 지우는 기준

스크립트는 아래 판단대로 동작한다. 기준을 바꿀 때나 스크립트가 유지한 이유를 읽을 때 본다.

**삭제 후보(`-d`)는 `git branch -d` 로 지운다.** 실측으로 후보 둘이 `not fully merged` 로 거절된 적이 있다.
`survey_git.py` 는 원격 기준 브랜치(JSON 의 `base`)와 비교하고, `git branch -d` 는 upstream 이 사라진 브랜치를 로컬 HEAD 와 비교하기 때문이다.
로컬 main 이 뒤처졌거나 detached HEAD 이면 `origin/<기준>` 에는 포함된 브랜치도 거절된다.
거절되면 아래 두 조건을 모두 확인하고, 둘 다 맞을 때만 `-D` 로 지운다. 하나라도 다르면 유지한다.

1. `git rev-parse "$BR"` 가 조사 JSON 의 `tip` 과 같다
2. `git merge-base --is-ancestor "$BR" "$BASE"` 가 종료 코드 0 이다

사용자 체크아웃(로컬 main pull 등)은 이 때문에 바꾸지 않는다.

**PR 머지됨(`-D`)은 squash 머지처럼 `--is-ancestor` 로 보이지 않는 머지다.**
`--check-prs` 가 머지된 PR 의 `headRefOid` 와 로컬 브랜치 끝 커밋을 대조해 낸 분류다.
조사와 실행 사이에 커밋이 생길 수 있으므로, 실행 직전 `git rev-parse` 값이 조사 JSON 의 `tip` 과 같을 때만 `-D` 를 쓴다. 다르면 지우지 않는다.

**스크립트가 건드리지 않는 것.**

- `PR 확인 필요(-D)`: 머지된 PR 은 있으나 커밋이 다르거나 upstream 만 사라진 브랜치다. 같은 이름을 다시 써서 PR 이후 커밋을 쌓았을 수 있다. 직접 PR 상태를 확인한 뒤 판단한다.
- `gh 확인 실패`(JSON 의 `pr_state` 가 `error`): 분류가 "유지" 여도 지우지 않는다. `--gh-timeout` 을 늘려 다시 조사하거나, 보고에 확인하지 못했다고 적는다.

직접 확인할 때 `gh` 는 cwd 저장소를 조회하므로 저장소로 옮겨서 부른다. 출력의 `headRefOid` 가 `git rev-parse` 값과 같은 PR 이 있어야 한다.

```bash
(cd "$REPO" && gh pr list --head "$BR" --state merged --json number,state,headRefOid)
git -C "$REPO" rev-parse "$BR"
```
