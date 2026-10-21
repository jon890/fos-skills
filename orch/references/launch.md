# 3. 띄우기

여러 worker 를 동시에 두면 **지금 묶인 run 하나에** 띄운다. 묶인 run 은 `run-current` 로 본다.
새 run 을 만들면 코디네이터가 그쪽으로 옮겨 묶이고, 이전 run 의 메시지를 받지 못한다.
`check` 나 `worker-start --run` 이 `consumer_fenced` 로 거절되면 코디네이터가 다른 run 에 묶인 것이다.
`orca orchestration run-use --id "$RUN_ID"` 로 옮겨 붙은 뒤 메시지를 읽는다.
상태만 볼 때는 fenced 상태에서도 `worker-list --run "$RUN_ID"` 가 동작한다.

**워크트리는 `origin/<기준 브랜치>` 위에 만든다.** 로컬 브랜치를 기준으로 만들면 로컬 브랜치가 뒤처져 있어도 오류 없이 만들어져, worker 가 옛 코드 위에서 계획하고 구현한다.
띄우기 전에 원격을 갱신하고, 로컬 기준 브랜치가 깨끗하면 fast-forward 로 맞춘다.
`$REPO` 는 대상 저장소 경로, `$BASE` 는 기준 브랜치 이름이다.

`merge --ff-only` 는 지금 체크아웃된 브랜치에 들어가므로 기준 브랜치가 체크아웃돼 있을 때만 돌린다.

```bash
git -C "$REPO" fetch origin
[ "$(git -C "$REPO" branch --show-current)" = "$BASE" ] && git -C "$REPO" merge --ff-only "origin/$BASE"
```

codex 를 띄우기 전에 아래 「codex 준비 판정」 의 설정이 있는지 본다.

**새 worktree 는 `make-worktree.sh` 로 먼저 만들고 `--worktree path:` 로 띄운다.**
Orca 의 `--worktree new-top-level` 은 브랜치 이름을 `<git 사용자>/<워크트리 이름>` 으로 정해 지시서의 `브랜치:` 줄과 어긋난다.
어긋나면 worker 마다 이름을 바꾸거나 다른 원격 브랜치에 push 하고, 정리 스크립트는 이름을 추측해야 한다.
스크립트는 지시서의 `브랜치:` 줄(형식은 [`spec-writing.md`](spec-writing.md))을 읽어 `origin/$BASE` 위에 그 이름으로 만들고,
아래 「띄운 직후 확인」 의 exclude 와 로컬 설정 복사도 같이 한다. 표준 출력은 워크트리 경로 한 줄이다.

**`--spec` 에는 지시서 경로와 사용자가 허락한 외부 동작을 담은 한 줄만 준다.**
`spec-line.py` 가 지시서의 `허락:` 줄(형식은 [`spec-writing.md`](spec-writing.md))을 그 줄에 붙인다.
허락이 파일 안에만 있으면 Codex worker 가 그것을 사용자의 직접 요청으로 볼지 실행마다 달라, 일부는 GitHub 게시가 금지됐다며 PR 을 열지 않고 멈춘다.
PR 을 열게 하는 지시서면 `--require-permission` 을 줘서 `허락:` 줄이 빠졌을 때 띄우기 전에 멈춘다.
`$SPEC_FILE` 은 2단계의 지시서 경로, `$NAME` 은 새 worktree 이름이다.

```bash
SPEC_LINE=$(python3 "$SKILL_DIR/scripts/spec-line.py" "$SPEC_FILE" --require-permission) &&
WORKTREE=$(bash "$SKILL_DIR/scripts/make-worktree.sh" --repo "$REPO" --spec "$SPEC_FILE" --name "$NAME" --base "$BASE") &&
orca orchestration worker-start --run "$RUN_ID" --spec "$SPEC_LINE" --worktree "path:$WORKTREE" \
  --agent codex --model gpt-6.1-sol --effort low --json
```

스크립트가 종료 코드 1 로 거부하면 같은 이름의 로컬이나 원격 브랜치, 또는 경로가 이미 있는 것이다.
새 일이면 지시서의 브랜치 이름을 바꾼다. 예전에 머지된 PR 과 같은 이름을 다시 쓰면 그 PR 의 기록과 섞인다.
이어서 하는 일이면 이미 있는 worktree 에 띄운다.

이미 있는 worktree 에 띄울 때는 `--worktree path:` 만 준다. 5단계의 후속 일과 worker 가 보낸 `ready:` 가 여기 해당한다.

```bash
orca orchestration worker-start --run "$RUN_ID" --spec "$SPEC_LINE" --worktree "path:$WORKTREE" \
  --agent claude --model claude-sonnet-5-5 --effort medium --json
```

## 띄운 직후 확인

- `worker-start` 응답의 `launch.effective` 가 1단계에서 고른 모델, effort 와 같다
- `git -C "$REPO" status --short` 에 `worktrees/` 가 없다

`make-worktree.sh` 는 Orca 와 같은 `<repo>/worktrees/<repo>/<name>` 에 워크트리를 만든다.
그 경로가 ignore 되지 않으면 기준 브랜치에서 `git add -A` 를 할 때 워크트리가 커밋될 수 있어, 스크립트가 로컬 전용인 `.git/info/exclude` 에 `/worktrees/` 를 더한다.
공유되는 `.gitignore` 는 고치지 않는다.
대상 저장소의 `.claude/settings.local.json` 도 스크립트가 복사한다. 추적되지 않는 파일이라 워크트리에 따라오지 않고,
없으면 사용자가 허용해 둔 `gh pr`, 리뷰 회신 같은 명령이 worker 세션에서 다시 막힌다.

Orca 가 남기는 `.orca-worktree-trash` 는 Orca 가 관리하므로 지우지 않는다.

`worker-start` 가 0 이 아닌 코드로 끝나면 새로 띄우지 않고 아래 절에서 원인을 찾는다.

## codex 준비 판정

Orca 가 계정별로 두는 `~/Library/Application Support/orca/codex-accounts/*/home/config.toml` 에 아래 두 키를 둔다.
`check_for_update_on_startup` 은 첫 절 머리 앞의 최상위 키이고, `terminal_title` 은 `[tui]` 절의 키다.

```toml
check_for_update_on_startup = false

[tui]
terminal_title = ["app-name", "run-state", "project-name"]
```

이 설정이 없으면 codex 가 떠 있어도 터미널 제목에 `Codex` 와 `ready` 가 함께 나오지 않아 `agent_readiness` 에서 실패한다.
`check_for_update_on_startup = false` 는 codex 가 시작할 때 업데이트 안내 화면에서 멈추지 않게 한다.

## 첫 화면에서 멈춤

원인은 `worker-show --dispatch "$DISPATCH_ID"` 의 `lastFailure` 에 나온다.
알려진 원인은 claude 의 폴더 신뢰 확인, codex 의 업데이트 안내(`agent-update-prompt`), hook 신뢰 확인(`agent-hooks-review-prompt`),
작업 폴더 신뢰 확인(`agent-trust-workspace`)이다.

터미널과 워크트리는 이미 만들어져 있으므로 새로 띄우지 않고 이어 붙인다.

1. `terminal read` 로 화면을 본다. 신뢰나 업데이트를 대신 승인하지 않는다.
   건너뛰는 선택지를 고르고 사용자에게 알린다.
   codex 의 `agent-trust-workspace` 는 선택지가 신뢰와 종료 둘뿐이고, 고른 값이 저장소 루트 단위로 저장된다.
   건너뛸 수 없으므로 사용자에게 묻는다. 승인을 받으면 `terminal send --enter` 로 첫 선택지를 고른다.
   거절하면 그 터미널을 `worker-release` 로 닫고 claude worker 로 다시 띄운다
2. `terminal wait --for tui-idle` 로 입력 대기 상태를 확인한다
3. `worker-start --task "$TASK_ID" --retry-of "$DISPATCH_ID" --terminal "$TERMINAL_HANDLE" --worktree "id:$WORKTREE_ID"` 로 붙인다.
   기존 worktree 에 띄웠던 worker 는 `worker-start` 응답에 worktree id 가 없다. `--worktree "path:$WORKTREE"` 로 준다.
   `--model` 은 줄 수 없지만 처음 띄울 때 준 모델이 그 터미널에 남아 있다

## 시작 직후 실패

worker 가 `stage.detail: agent_readiness`, `outcome: failed` 로 아무 출력 없이 끝나면, codex 는 먼저 위 「codex 준비 판정」 의 설정을 본다.
설정이 있는데도 실패하면 그 모델이 이 환경에서 뜨지 않는 것이므로 같은 Task 를 다른 모델로 다시 띄운다. `--retry-of` 는 `--spec` 이 아니라 `--task` 와 함께 쓴다.
`$WORKTREE` 는 처음 띄운 워크트리 경로다.

```bash
orca orchestration worker-start --task "$TASK_ID" --retry-of "$DISPATCH_ID" --agent codex --model gpt-6.1-sol --effort low --worktree "path:$WORKTREE"
```
