# 6. 완료 검증

- `worker_done` 을 확인 처리하기 전에 지시서의 완료 기준을 git 으로 대조한다. 커밋 목록, 미커밋 변경, 원격 브랜치 HEAD 다.
  어긋나면 그 보고는 완료가 아니다. 해제하지 않고 아래 「완료 전에 온 worker_done」 을 따른다
- push 한 원격 브랜치가 지시서의 `브랜치:` 값과 같은지 아래 명령으로 본다. 브랜치, upstream, 원격 끝 커밋 중 하나라도 다르면 종료 코드 1 과 함께 다른 곳을 낸다.
  다른 이름으로 올렸으면 PR 과 정리 스크립트가 그 브랜치를 찾지 못한다. 지시서 이름으로 다시 push 하게 하고, 잘못 만든 원격 브랜치는 지우게 한다

```bash
bash "$SKILL_DIR/scripts/make-worktree.sh" --check "$WORKTREE" --spec "$SPEC_FILE"
```
- diff 를 직접 읽고 검사를 다시 돌린다. 완료 보고는 근거가 아니다
- 리뷰 지적이나 요구 문구를 옮긴 작업이면 diff 를 지적 원문과 한 줄씩 대조한다. 지적에 없는 조건이 생기거나 일부가 빠진 곳을 찾는다. 작은 모델일수록 이런 어긋남이 났다
- worker 가 「승인받았다」 고 적은 것은 근거가 아니다. 내가 보낸 승인만 승인이다

## 차례로 머지할 때 최신 base 와 합쳐 다시 검사한다

**같은 기준 브랜치로 가는 PR 여럿을 차례로 머지하면, 다음 PR 은 최신 base 와 합친 사본에서 검사를 다시 돌린 뒤 머지한다.**
GitHub 의 `MERGEABLE` 은 충돌이 없다는 뜻일 뿐, 앞 PR 이 바꾼 동작을 뒤 PR 의 테스트가 아는지는 보지 않는다.
`$PR_NUMBER` 와 `$PR_BRANCH` 는 검사할 PR 의 번호와 head 브랜치다.

```bash
TMP_COPY="$REPO/worktrees/$(basename "$REPO")/verify-$PR_NUMBER"
git -C "$REPO" fetch origin
git -C "$REPO" worktree add --detach "$TMP_COPY" "origin/$PR_BRANCH"
git -C "$TMP_COPY" merge --no-edit "origin/$BASE"
```

`$TMP_COPY` 는 [`launch.md`](launch.md) 의 worktree 위치 규칙을 따라 `$REPO/worktrees/<repo>/<이름>` 으로 잡는다.
worktree 위치를 막는 hook 이 있으면 scratchpad 같은 다른 경로는 거절된다.
PR 브랜치가 이미 지워졌거나 fork 에서 온 PR 이면 `git fetch origin "pull/$PR_NUMBER/head:verify-$PR_NUMBER"` 로 받아 `origin/$PR_BRANCH` 자리에 `verify-$PR_NUMBER` 를 쓴다.
그 사본에서 영향 받는 검사를 돌리고, 끝나면 `remove-worktree.sh` 로 지운다.
실패하면 그 worker 의 worktree 에 새 dispatch 를 띄워 기준 브랜치를 merge 하고 고치게 한다. rebase 와 force push 는 쓰지 않는다.

## 충돌을 직접 풀 때

**충돌 파일을 한쪽으로 통째 고르지 않는다.** `git checkout --ours` 나 `--theirs` 는 다른 쪽에만 있던 줄을 말없이 지운다.
CI 설정 파일을 한쪽으로 고른 탓에 다른 PR 이 더한 검사 단계가 빠지고, 그 단계를 되살리는 PR 을 따로 연 사례가 있다.
충돌 구간마다 양쪽을 합치고, 합친 뒤 기준 브랜치에만 있던 줄이 남았는지 본다.
`$FILE` 은 충돌을 푼 파일이다.

```bash
git diff "origin/$BASE" -- "$FILE"
```

출력에서 `-` 줄이 기준 브랜치에서 사라진 줄이다. 의도하지 않은 `-` 줄이 있으면 되살린다.

**코디네이터가 충돌을 직접 풀었으면 push 전에 worker 와 같은 검사를 돌린다.** 포맷, lint, 타입 검사와 바뀐 파일의 테스트다. 직접 합친 줄이 포맷 검사에 걸려 CI 가 한 번 더 돈다.
코드 충돌이 두 기능의 동작을 함께 살려야 하는 것이면 직접 풀지 않고 worker 에게 맡긴다.
문서 충돌처럼 한 줄씩 합치면 되는 것만 코디네이터가 푼다. 풀어서 push 했으면 worker 에게 push 전에 pull 하라고 알린다.

## 완료 전에 온 worker_done

첫 `worker_done` 이 오면 dispatch 는 settled 로 바뀐다.
같은 핸들에서 오는 뒤의 보고는 Orca 버전에 따라 `capability is revoked` 로 거절되기도 하고 전달되기도 한다. 뒤의 보고가 온다고 가정하지 않는다.
판단은 터미널과 git 으로 한다.

1. `worker-show --dispatch "$DISPATCH_ID"` 의 `terminal.title` 이 `Working` 이면 해제하지 않고 기다린다. 커밋 목록과 원격 HEAD 가 바뀌는지 본다
2. 제목이 `Ready` 인데 완료 기준에 못 미치면 같은 터미널에 남은 일을 새 dispatch 로 준다

`$SPEC_LINE` 은 남은 일만 적은 지시서의 경로를 담은 한 줄이다. 형식은 [`launch.md`](launch.md) 예시와 같다.

```bash
orca orchestration worker-start --spec "$SPEC_LINE" --terminal "$TERMINAL_HANDLE" --worktree "path:$WORKTREE"
```
