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

**새 워크트리와 원격 브랜치 이어 받기(`--resume-remote`)는 `launch-worker.py` 가 만든다. `make-worktree.py` 를 직접 부르는 것은 6단계의 `--check` 뿐이다.**
Orca 의 `--worktree new-top-level` 은 브랜치 이름을 `<git 사용자>/<워크트리 이름>` 으로 정해 지시서의 `브랜치:` 줄과 어긋난다.
어긋나면 worker 마다 이름을 바꾸거나 다른 원격 브랜치에 push 하고, 정리 스크립트는 이름을 추측해야 한다.
`launch-worker.py` 는 `make-worktree.py` 로 지시서의 `브랜치:` 줄(형식은 [`spec-writing.md`](spec-writing.md))을 읽어 `origin/$BASE` 위에 그 이름으로 만들고,
아래 「띄운 직후 확인」 의 exclude 와 로컬 설정 복사도 같이 한다.

**`--spec` 의 첫 지시 줄은 `spec-line.py` 가 지시서의 경로와 `허락:` 줄(형식은 [`spec-writing.md`](spec-writing.md))로 만든다.**

**worker 는 `launch-worker.py` 로 띄운다.** 첫 지시 줄 만들기(`spec-line.py --require-permission`), 워크트리 만들기, `worker-start`, 띄운 직후 단계 확인을 한 명령으로 돈다.
`worker-start` 를 직접 부르면 그 가운데 하나가 빠진다. `launch-worker.py` 는 `--spec` 이 필수라 늘 Task 를 새로 만들므로, `--task` 로 기존 Task 를 다시 띄우는 호출(`--retry-of` 유무와 관계없이)만 예외로 `worker-start` 를 직접 부른다.
옵션과 종료 코드는 스크립트 머리 주석이 소유한다.
`$SPEC_FILE` 은 2단계의 지시서 경로, `$NAME` 은 새 worktree 이름이다. `$AGENT`, `$MODEL`, `$EFFORT` 는 1단계에서 고른 값이다. `--` 뒤는 `worker-start` 에 그대로 간다.

```bash
python3 "$SKILL_DIR/scripts/launch-worker.py" --spec "$SPEC_FILE" --repo "$REPO" --name "$NAME" --base "$BASE" --run "$RUN_ID" \
  -- --agent "$AGENT" --model "$MODEL" --effort "$EFFORT"
```

`make-worktree.py` 가 거부하면 같은 이름의 로컬이나 원격 브랜치, 또는 경로가 이미 있는 것이다.
새 일이면 지시서의 브랜치 이름을 바꾼다. 예전에 머지된 PR 과 같은 이름을 다시 쓰면 그 PR 의 기록과 섞인다.
이어서 하는 일이면 이미 있는 worktree 에 띄운다.

이미 있는 worktree 에 띄울 때는 `--worktree` 에 그 경로를 준다. 맨 경로와 `path:` 를 붙인 경로를 모두 받는다. 5단계의 후속 일과 worker 가 보낸 `ready:` 가 여기 해당한다.
### 원격 PR 브랜치를 이어 받을 때

지시서의 `브랜치:` 가 이미 origin 에 있으면 `--resume-remote` 를 더한다.
새 워크트리를 그 원격 브랜치의 최신 커밋에서 만들고 upstream 을 연결한다.
이 옵션을 빼면 기존처럼 원격 브랜치가 있는 작업을 거부한다.
로컬 브랜치나 경로가 있으면 덮어쓰지 않으며 기존 워크트리는 `--worktree` 로 이어 쓴다.

```bash
python3 "$SKILL_DIR/scripts/launch-worker.py" --spec "$SPEC_FILE" --repo "$REPO" --name "$NAME" --resume-remote --run "$RUN_ID" \
  -- --agent "$AGENT" --model "$MODEL" --effort "$EFFORT"
```

**`--repo`, `--name` 으로 워크트리를 만든 뒤 띄우지 못하면 같은 `--name` 으로 다시 부르지 않는다.** `make-worktree.py` 가 「경로가 이미 있다」 로 거부한다.
스크립트가 stderr 끝에 낸 `--worktree <만든 경로>` 명령으로 이어 띄운다. 실패한 띄우기가 그 워크트리에 터미널을 남겼으면 그 목록도 함께 낸다. 이 세션이 띄운 것인지 보고 닫은 뒤 부른다.
**그 워크트리에 터미널이 남아 있으면 스크립트가 목록을 보여 주고 거부한다.** 같은 워크트리에 이어 띄우면 앞 세션이 닫히지 않고 쌓여, 한 워크트리에 세션이 셋 쌓인 일이 있었다.
목록의 터미널이 끝난 것인지 보고 `orca terminal close` 로 닫은 뒤 다시 부른다.
끝난 dispatch 의 터미널을 이어 쓰는 일은 `send-to-worker.py --dispatch <끝난 dispatch> --spec <후속 지시서>` 가 한다.
터미널이 남았으면 그 터미널을 이어 쓴다. 에이전트를 다시 띄우지 못하면 스크립트가 그 터미널을 닫고 같은 워크트리에 새 worker 를 띄운다. 터미널도 없으면 종료 코드 3 이다. 판정은 `send-to-worker.py` 머리 주석이 소유한다.
**충돌과 리뷰 반영에는 닫고 새로 띄우지 않고 [`replying.md`](replying.md) 의 「충돌과 리뷰 반영은 만든 worker 가 이어 받는다」 를 따른다.**
떠 있는 에이전트를 이어 쓸 때만 `--` 뒤에 `--terminal` 로 준다. `--terminal` 은 `--agent`, `--model`, `--effort` 와 함께 쓰지 못한다(스크립트가 거부한다). `agent_unconfigured` 로 이어 쓰지 못하면 스크립트가 종료 코드 3 으로 끝나며, [`replying.md`](replying.md) 의 「이어 쓸 수 없는 터미널」 을 따른다.

```bash
python3 "$SKILL_DIR/scripts/launch-worker.py" --spec "$SPEC_FILE" --worktree "$WORKTREE" --run "$RUN_ID" \
  -- --agent "$AGENT" --model "$MODEL" --effort "$EFFORT"
```

**`orca worktree list` 에 그 경로가 보일 때까지 스크립트가 기다린다.** Orca 가 새 워크트리를 늦게 알아봐 바로 부르면 `worker-start` 가 `selector_not_found` 로 실패한다.
기본 30초를 2초 간격으로 보고, 넘기면 종료 코드 1 로 멈춘다. 그 뒤에도 `worker-start` 가 `selector_not_found` 로 끝나면 한 번만 다시 부른다. 다른 오류는 다시 부르지 않는다.

**띄운 뒤 `worktree_creating` 에서 넘어가지 않으면 스크립트가 abandon 하고 같은 Task 를 `--retry-of` 로 한 번 다시 띄운다.** 기본으로 90초를 본다(`--watch`).
다시 띄워도 멈추면 종료 코드 1 이다. 그때는 아래 「첫 화면에서 멈춤」 처럼 `worker-show` 의 `lastFailure` 를 본다.
`worker-start` 자체가 0 이 아닌 코드로 끝나면 스크립트는 다시 띄우지 않는다.

## 띄운 직후 확인

- `worker-start` 응답의 `launch.effective` 가 1단계에서 고른 모델, effort 와 같다
- `git -C "$REPO" status --short` 에 `worktrees/` 가 없다

`make-worktree.py` 는 Orca 가 직접 만드는 경로와 같은 `<repo>/worktrees/<repo>/<name>` 에 워크트리를 만든다.
2026-10-23 dooray-cli 에서 `orca worktree create` 가 만든 경로로 확인했다. Orca 전역 설정은 `workspaceDir: "worktrees"`, `nestWorkspaces: true` 이고, 저장소별 `worktreeBasePath` 로 덮어쓸 수 있다.
그래서 경로 계산은 바꾸지 않는다. 경로가 맞아도 `git worktree add` 로 만든 워크트리는 Orca 에게 외부 워크트리라서, 저장소의 `externalWorktreeVisibility` 가 `hide` 면 Orca 가 숨기고 `launch-worker.py` 가 30초 대기 끝에 멈춘다.
`make-worktree.py` 는 만들기 전에 `orca repo show` 로 그 값을 읽고 `hide` 면 만들지 않고 종료 코드 1 로 멈춘다. `show`, `inherit`, 읽지 못한 경우는 그대로 진행한다.
`hide` 일 때 사용자가 고를 조치는 둘이다. 스크립트는 Orca 설정을 바꾸지 않는다.

- Orca 화면에서 그 워크트리를 등록한다
- `orca repo set --repo path:<repo> --external-worktree-visibility show`

`launch-worker.py` 가 「Orca 가 워크트리를 알아보지 못했다」 로 멈출 때도 만든 경로, 그 저장소의 `externalWorktreeVisibility`, 위 조치를 stderr 에 낸다. 조치한 뒤에는 `--worktree` 로 이어 띄운다.

만든 경로가 ignore 되지 않으면 기준 브랜치에서 `git add -A` 를 할 때 워크트리가 커밋될 수 있어, 스크립트가 로컬 전용인 `.git/info/exclude` 에 `/worktrees/` 를 더한다.
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
codex 의 hook 신뢰 확인이 fos-skills 의 orch hook 때문이면 Codex 설치본이 `.codex-plugin` 매니페스트가 없는 옛 버전이다. `codex plugin marketplace upgrade fos-skills` 로 갱신한다. 근거는 저장소의 `docs/adr/007-codex-manifest-without-hooks.md` 가 소유한다.

터미널과 워크트리는 이미 만들어져 있으므로 새로 띄우지 않고 이어 붙인다.

1. `terminal read` 로 화면을 본다. 신뢰나 업데이트를 대신 승인하지 않는다.
   건너뛰는 선택지를 고르고 사용자에게 알린다.
   codex 의 `agent-trust-workspace` 는 선택지가 신뢰와 종료 둘뿐이고, 고른 값이 저장소 루트 단위로 저장된다.
   건너뛸 수 없으므로 사용자에게 묻는다. 승인을 받으면 `terminal send --terminal "$TERMINAL_HANDLE" --enter` 로 첫 선택지를 고른다.
   본문 없이 `--enter` 만 보내고, `worker-show` 가 첫 화면 대기(`agent-trust-workspace` 같은)를 보일 때만 `block-worker-terminal-send.py` 가 통과시킨다.
   거절하면 그 터미널을 `worker-release` 로 닫고 claude worker 로 다시 띄운다
2. `terminal wait --for tui-idle` 로 입력 대기 상태를 확인한다
3. `worker-start --task "$TASK_ID" --retry-of "$DISPATCH_ID" --terminal "$TERMINAL_HANDLE" --worktree "id:$WORKTREE_ID"` 로 붙인다(`--task` 로 기존 Task 를 다시 띄우는 호출이라 3단계의 예외다).
   기존 worktree 에 띄웠던 worker 는 `worker-start` 응답에 worktree id 가 없다. `--worktree "path:$WORKTREE"` 로 준다.
   `--model` 은 줄 수 없지만 처음 띄울 때 준 모델이 그 터미널에 남아 있다

## 시작 직후 실패

worker 가 `stage.detail: agent_readiness`, `outcome: failed` 로 아무 출력 없이 끝나면, codex 는 먼저 위 「codex 준비 판정」 의 설정을 본다.
설정이 있는데도 실패하면 그 모델이 이 환경에서 뜨지 않는 것이므로 같은 Task 를 다른 모델로 다시 띄운다. `--retry-of` 는 `--spec` 이 아니라 `--task` 와 함께 쓰고, Task 가 `failed` 나 `blocked` 일 때만 받아들여진다. 터미널이 끊겨 `abandoned` 가 된 경우는 아래 「끊긴 worker 다시 띄우기」 의 표를 따른다.
`$WORKTREE` 는 처음 띄운 워크트리 경로다. `$AGENT`, `$MODEL`, `$EFFORT` 는 1단계에서 다시 고른 값이다.
이 `worker-start` 는 `--task` 로 기존 Task 를 다시 띄우는 호출이라 `launch-worker.py` 를 쓰지 않는 예외다.

```bash
orca orchestration worker-start --task "$TASK_ID" --retry-of "$DISPATCH_ID" --agent "$AGENT" --model "$MODEL" --effort "$EFFORT" --worktree "path:$WORKTREE"
```

## 끊긴 worker 다시 띄우기

기기가 재시작되어 worker 터미널이 사라지면 `worker-show` 가 `[abandoned] stage=terminal_missing` 으로 보인다.
`wait-important.py` 는 이때 `WORKER_LOST <dispatch> stage=terminal_missing` 줄을 내고 종료 코드 5 로 끝난다.
같은 dispatch 는 다음 대기에서 다시 알리지 않으므로 이 줄을 받은 자리에서 처리한다.
다시 띄우지 않기로 했으면 task 를 `task-update --status failed --result cancelled` 로 취소해 기록을 남긴다.
`$DISPATCH_ID` 는 그 줄의 dispatch, `$TASK_ID` 는 `worker-show` 의 `dispatch.taskId`, `$WORKTREE` 는 처음 띄운 워크트리 경로다.
이 절의 `worker-start` 도 모두 `--task` 로 기존 Task 를 다시 띄우는 호출이라 `launch-worker.py` 를 쓰지 않는 예외다.
이 절은 일하던 worker 가 끊긴 경우다. 이미 `worker_done` 을 보낸 worker 의 PR 에 충돌이나 리뷰가 달렸는데 터미널이 없으면, 이 절의 새 worker 띄우기보다 [`replying.md`](replying.md) 의 「충돌과 리뷰 반영은 만든 worker 가 이어 받는다」 가 우선한다.

어느 상태에서 어느 명령을 쓰는지는 이 표가 소유한다. `--retry-of` 는 실패하거나 막힌 Task 의 가장 최근 settled dispatch 에만 받아들여진다.

| Task 상태 | dispatch 상태 | 쓰는 명령 |
| --- | --- | --- |
| `failed` 또는 `blocked` | 가장 최근 settled dispatch 가 `agent_readiness` 같은 시작 실패 | `worker-start --task "$TASK_ID" --retry-of "$DISPATCH_ID"` (위 「시작 직후 실패」) |
| `ready` | `abandoned` (`terminal_missing`) | `--retry-of` 없이 `worker-start --task "$TASK_ID" --worktree "path:$WORKTREE"` |
| `dispatched` | 살아 있는 dispatch | 다시 띄우지 않는다. 같은 worker 에 `send-to-worker.py` 로 보낸다 |

Task 상태는 `orca orchestration task-list --run "$RUN_ID" --json` 으로 본다. 상태를 모르고 `--retry-of` 를 주면 `task_not_startable`(「--retry-of must name the latest settled Dispatch of a failed or blocked Task」)로 거절된다. 거절되면 표의 둘째 줄로 간다.

1. `worker-show --dispatch "$DISPATCH_ID"` 로 dispatch 상태를 보고, `task-list` 로 Task 상태를 본다
2. 워크트리에서 `git -C "$WORKTREE" log --oneline origin/"$BASE"..HEAD` 와 `git -C "$WORKTREE" status --short` 로 끝난 커밋과 작업 트리의 변경을 확인한다. 커밋 안 된 변경은 버리지 않고 그대로 둔다
3. 지시서에 「재개」 절을 더한다. 끝난 phase 와 그 커밋, 작업 트리에 남은 변경, 다음에 할 일을 적는다. 새 worker 는 앞 대화를 모르므로 이 절만 보고 이어 가야 한다
4. 표대로 띄운다. 워크트리를 `path:` 로 주면 같은 워크트리에 이어 붙는다
5. 끊긴 dispatch 의 터미널을 닫는다. `worker-release` 가 `identity_unproven` 으로 닫지 않으므로 `orca terminal close` 를 쓴다. 이 세션이 띄운 worker 의 터미널만 닫는다

```bash
orca orchestration worker-start --task "$TASK_ID" --worktree "path:$WORKTREE" --json
orca terminal close --terminal "$OLD_TERMINAL_HANDLE"
```

`$OLD_TERMINAL_HANDLE` 은 `worker-show` 의 `worker.agentTerminalHandle` 이다. 새로 띄운 worker 의 터미널과 다른지 확인한 뒤 닫는다.
