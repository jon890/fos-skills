# 세션, 브랜치, 워크트리 정리

`survey_sessions.py` 와 `survey_git.py` 의 결과를 실행할 때 읽는다.
`$REPO` 는 저장소 경로, `$WT` 는 워크트리 경로, `$BR` 는 브랜치 이름, `$PIDS` 는 사용자가 지정한 PID 다.

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

머지된 브랜치는 `-d` 로 지운다. 머지가 안 됐다고 나오면 지우지 않는다.

```bash
git -C "$REPO" branch -d "$BR"
```

upstream 이 사라졌고 머지 판정이 안 된 브랜치는 PR 이 MERGED 인지 확인한 뒤에만 `-D` 를 쓴다.
확인할 수 없으면(gh 인증 실패, PR 없음) 유지한다.
`--check-prs` 로 "PR 머지됨(-D)" 가 나온 것은 머지된 PR 의 `headRefOid` 와 로컬 브랜치 끝 커밋을 대조한 결과다.
머지된 PR 은 있으나 커밋이 다르면 "PR 확인 필요(-D)" 로 남는다. 같은 이름을 다시 써서 PR 이후 커밋을 쌓은 브랜치다.
조사와 실행 사이에 커밋이 생길 수 있으므로, 실행 직전 `git rev-parse` 가 조사 때 값과 같은지 한 번 더 본 뒤 `-D` 를 쓴다. 다르면 지우지 않는다.
`gh` 는 cwd 저장소를 조회하므로 저장소로 옮겨서 부른다.
직접 확인할 때도 출력의 `headRefOid` 가 `git rev-parse` 값과 같은 PR 이 있어야 한다.

```bash
(cd "$REPO" && gh pr list --head "$BR" --state merged --json number,state,headRefOid)
git -C "$REPO" rev-parse "$BR"
git -C "$REPO" branch -D "$BR"
```

원격 브랜치는 이 스킬에서 지우지 않는다.
