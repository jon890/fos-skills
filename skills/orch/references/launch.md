# 3. 띄우기

여러 worker 를 동시에 두면 **지금 묶인 run 하나에** 띄운다. 묶인 run 은 `run-current` 로 본다.
새 run 을 만들면 코디네이터가 그쪽으로 옮겨 묶인다. 이전 run 의 메일도 코디네이터를 깨우지만(Orca 1.4.254 가이드) worker 는 묶인 run 에 띄운다.
`check` 나 `worker-start --run` 이 `consumer_fenced` 로 거절되면 먼저 명령에 `--run <id>` 를 붙여 본다.
그래도 거절되면 다른 터미널이 그 Run 을 쥔 것이다. `orca orchestration run-list` 로 살아 있는 다른 Run 을 보고, 있으면 `run-use` 가 그 Run 들의 메일을 끊는다는 것(Orca: 「run-use keeps only the Run it names」)을 사용자에게 알리고 물은 뒤에 `orca orchestration run-use --id "$RUN_ID"` 로 옮겨 붙는다.
상태만 볼 때는 fenced 상태에서도 `worker-list --run "$RUN_ID"` 가 동작한다.

**묶인 run 이 없으면(`run-current` 가 비었으면) 먼저 만든다.** 문법은 `orca orchestration run-create --help` 가 소유한다.
`worker-start --spec` 도 묶인 run 이 없으면 하나 만들지만, Task 그래프를 쓰거나 새 목표로 시작하려면 `run-create` 로 직접 만든다. 만들면 코디네이터가 그 run 에 묶인다.
이미 있는 run 을 이어 쓰려면 `run-use` 로 붙는다. 상주 루프는 그 run 의 코디네이터 세션에서 띄운다.

```bash
orca orchestration run-create --objective "<이번 목표 한 문장>"
orca orchestration run-use --id "$RUN_ID"
orch loop start --run "$RUN_ID"
```

**워크트리는 `origin/<기준 브랜치>` 위에 만든다.** 로컬 브랜치를 기준으로 만들면 로컬 브랜치가 뒤처져 있어도 오류 없이 만들어져, worker 가 옛 코드 위에서 계획하고 구현한다.
`make-worktree` 가 워크트리를 만들 때 스스로 `git fetch origin` 을 한다. 그래도 띄우기 전에 원격을 갱신하는 이유는 `spec-lint` 가 fetch 없이 지금 있는 `origin/<기준 브랜치>` 로 오버레이와 지시서가 가리키는 경로를 검사하기 때문이다. 로컬 기준 브랜치가 깨끗하면 fast-forward 로 맞춘다.
`$REPO` 는 대상 저장소 경로, `$BASE` 는 기준 브랜치 이름이다.

`merge --ff-only` 는 지금 체크아웃된 브랜치에 들어가므로 기준 브랜치가 체크아웃돼 있을 때만 돌린다.

```bash
git -C "$REPO" fetch origin
[ "$(git -C "$REPO" branch --show-current)" = "$BASE" ] && git -C "$REPO" merge --ff-only "origin/$BASE"
```

codex 를 띄우기 전에 아래 「codex 준비 판정」 의 설정이 있는지 본다.
claude 를 띄우면 `launch-worker` 가 아래 「claude 프로필 준비 판정」 을 먼저 본다.

**새 워크트리와 원격 브랜치 이어 받기(`--resume-remote`)는 `launch-worker` 가 만든다. `make-worktree` 를 직접 부르는 것은 6단계의 `--check` 뿐이다.**
Orca 의 `--worktree new-top-level` 은 브랜치 이름을 `<git 사용자>/<워크트리 이름>` 으로 정해 지시서의 `브랜치:` 줄과 어긋난다.
어긋나면 worker 마다 이름을 바꾸거나 다른 원격 브랜치에 push 하고, 정리 스크립트는 이름을 추측해야 한다.
`launch-worker` 는 `make-worktree` 로 지시서의 `브랜치:` 줄(형식은 [`spec-writing.md`](spec-writing.md))을 읽어 `origin/$BASE` 위에 그 이름으로 만들고,
아래 「띄운 직후 확인」 의 exclude 와 로컬 설정 복사도 같이 한다.

**`--spec` 의 첫 지시 줄은 `spec-line` 이 지시서의 경로와 `허락:` 줄(형식은 [`spec-writing.md`](spec-writing.md))로 만든다.**

**worker 는 `launch-worker` 로 띄운다.** 첫 지시 줄 만들기(`spec-line --require-permission`), 워크트리 만들기, `worker-start`, 띄운 직후 단계 확인을 한 명령으로 돈다.
`worker-start` 를 직접 부르면 그 가운데 하나가 빠진다. 기존 Task 도 `launch-worker --spec <지시서> --repo <저장소> --task <Task>` 로 다시 띄운다. failed·blocked Task 는 `--retry-of <dispatch>` 를 함께 주고 ready Task 는 생략한다.
옵션과 종료 코드는 스크립트 머리 주석이 소유한다.
**`launch-worker` 는 워크트리를 만들기 전에 `spec-lint` 로 그 지시서와 `worker 선택:` 줄(형식은 [`spec-writing.md`](spec-writing.md)), codex 의 `--model`, `--effort` 를 검사하고, 어긋나면 종료 코드 1, 4, 5 로 멈춘다.** 거부 조건과 종료 코드는 `launch-worker.ts` 머리 주석이 소유한다. 지시서를 고치는 것이 기본이다. 「할 일」 첫 줄의 `루프` 발견([`feature-loop.md`](feature-loop.md) 의 「루프를 쓸지 정한다」)도 같은 5 로 멈춘다.
먼저 띄운 지시서와 담당 경로가 겹치는 것처럼 의도한 겹침만 `--lint-ack "<이유>"` 로 넘긴다. 이유 없이 끄는 옵션은 없다. effort 가 `기본` 이면 `--effort` 를 주지 않는다.
`$SPEC_FILE` 은 2단계의 지시서 경로, `$NAME` 은 새 worktree 이름이다. `$AGENT`, `$MODEL`, `$EFFORT` 는 1단계에서 고른 값이다. `--` 뒤는 `worker-start` 에 그대로 간다.

```bash
orch worker launch --spec "$SPEC_FILE" --name "$NAME" --base "$BASE" \
  -- --agent "$AGENT" --model "$MODEL" --effort "$EFFORT"
```

지시서의 `worker 선택:` 줄이 effort 를 `기본` 으로 적었으면(예: Haiku 행) `--effort "$EFFORT"` 를 통째로 뺀다. 넣으면 `launch-worker` 가 줄과 인자가 다르다며 종료 코드 1 로 거부한다. 이 절 아래와 다른 절의 같은 꼴 블록도 같다.

`make-worktree` 가 거부하면 같은 이름의 로컬이나 원격 브랜치, 또는 경로가 이미 있는 것이다.
새 일이면 지시서의 브랜치 이름을 바꾼다. 예전에 머지된 PR 과 같은 이름을 다시 쓰면 그 PR 의 기록과 섞인다.
이어서 하는 일이면 이미 있는 worktree 에 띄운다.

이미 있는 worktree 에 띄울 때는 `--worktree` 에 그 경로를 준다. 맨 경로와 `path:` 를 붙인 경로를 모두 받는다. 5단계의 후속 일과 worker 가 보낸 `ready:` 가 여기 해당한다.
### 원격 PR 브랜치를 이어 받을 때

지시서의 `브랜치:` 가 이미 origin 에 있으면 `--resume-remote` 를 더한다.
새 워크트리를 그 원격 브랜치의 최신 커밋에서 만들고 upstream 을 연결한다.
이 옵션을 빼면 기존처럼 원격 브랜치가 있는 작업을 거부한다.
로컬 브랜치나 경로가 있으면 덮어쓰지 않으며 기존 워크트리는 `--worktree` 로 이어 쓴다.

```bash
orch worker launch --spec "$SPEC_FILE" --name "$NAME" --resume-remote \
  -- --agent "$AGENT" --model "$MODEL" --effort "$EFFORT"
```

**`--repo`, `--name` 으로 워크트리를 만든 뒤 띄우지 못하면 같은 `--name` 으로 다시 부르지 않는다.** `make-worktree` 가 「경로가 이미 있다」 로 거부한다. 스크립트가 stderr 끝에 낸 `--worktree <만든 경로>` 명령으로 이어 띄운다.
**그 워크트리에 터미널이 남아 있거나 커밋 안 된 변경이 있으면 스크립트가 `REFUSED <이유>` 로 거부한다**(목록은 `--full`). 이 세션이 띄운 터미널인지, 끝난 것인지 보고 `worker-release` 로 닫거나(조건은 [`cleanup.md`](cleanup.md) 의 「worker 터미널을 닫는 기본 경로」), 변경을 커밋하거나 정리한 뒤 다시 부른다. 끊긴 worker 의 변경을 새 worker 가 이어받는 일이면 `--dirty-ack <이유>` 를 준다.
끝난 dispatch 의 터미널을 이어 쓰는 일은 `send-to-worker --dispatch <끝난 dispatch> --spec <후속 지시서>` 가 한다. 판정은 그 스크립트 머리 주석이 소유한다.
떠 있는 에이전트를 이어 쓸 때만 `--` 뒤에 `--terminal` 로 준다. `--terminal` 은 `--agent`, `--model`, `--effort` 와 함께 쓰지 못한다(스크립트가 거부한다). `agent_unconfigured` 로 이어 쓰지 못하면 스크립트가 종료 코드 3 으로 끝나며, [`replying.md`](replying.md) 의 「이어 쓸 수 없는 터미널」 을 따른다.

```bash
orch worker launch --spec "$SPEC_FILE" --worktree "$WORKTREE" \
  -- --agent "$AGENT" --model "$MODEL" --effort "$EFFORT"
```

워크트리 대기, `worktree_creating` 에서 안 넘어갈 때의 재시도(`--watch`, 일하는 흔적을 본 뒤 abandon)는 `launch-worker.ts` 머리 주석이 소유한다. 다시 띄워도 멈추면 종료 코드 1 이니 아래 「첫 화면에서 멈춤」 처럼 `worker-show` 의 `lastFailure` 를 본다.
`worker-start` 자체가 0 이 아닌 코드로 끝나면 스크립트는 다시 띄우지 않는다. `START-FAIL <receipt>` 줄이 실패 단계와 남은 자원을 담으니 다시 불러 확인하지 않는다.

## 띄운 직후 확인

- `worker-start` 응답의 `launch.effective`(기본 출력의 `LAUNCH-EFFECTIVE` 줄)가 1단계에서 고른 모델, effort 와 같다. 기본 출력의 `LAUNCHED <dispatch> <터미널> <워크트리>` 에서 터미널을 읽는다
- `git -C "$REPO" status --short` 에 `worktrees/` 가 없다

**사용자에게 띄웠다고 보고할 때, 「할 일」 첫 줄이 `루프 없이: <이유>` 인 worker 는 그 이유를 한 줄로 함께 적는다.** 예: 「`orch-log-typo` 를 루프 없이 띄웠다. 이유: 로그 오타만 고치는 버그 수정이다.」
루프를 건너뛸지는 코디네이터가 정하고 스크립트는 이유가 타당한지 보지 않는다. 사용자가 보고에서 보고 바로잡게 하려는 것이다([`feature-loop.md`](feature-loop.md) 의 「루프를 쓸지 정한다」).

`make-worktree` 가 만드는 경로와 `externalWorktreeVisibility` 가 `hide` 일 때의 거부는 `make-worktree.ts` 머리 주석이 소유한다. `hide` 일 때 사용자가 고를 조치는 둘이다. 스크립트는 Orca 설정을 바꾸지 않는다.

- Orca 화면에서 그 워크트리를 등록한다
- `orca repo set --repo path:<repo> --external-worktree-visibility show`

조치한 뒤에는 `--worktree` 로 이어 띄운다. exclude 와 `.claude/settings.local.json` 복사도 스크립트가 한다.
이 복사는 `permissions` 의 허용 규칙에만 듣는다. Claude Code 자동 모드 분류기의 허용 기준(`autoMode.allow`)은 워크트리의 `.claude/settings.local.json` 에서 먹지 않았다(2026-10-31 실측).
worker 에게 push, PR 생성, 리뷰 회신과 resolve 를 맡기는 저장소는 worker 가 쓰는 Claude 프로필의 사용자 `settings.json` 에 그 저장소로 한정한 `autoMode.allow` 를 둔다.
저장소를 한정하지 않으면 다른 저장소의 외부 쓰기까지 허용된다. 프로필 폴더는 `link-claude-profile.ts` 가 맞추는 곳이다.

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

## claude 프로필 준비 판정

새로 쓰는 Claude 계정의 프로필에는 플러그인 링크와 `settings.json` 이 없어 그 계정으로 뜬 worker 에게 플러그인과 스킬, 지침이 보이지 않는다. `launch-worker` 는 `--agent claude` 면 이를 먼저 보고, 없으면 띄우지 않고 종료 코드 1 과 맞추는 명령 한 줄을 낸다(판정은 `launch-worker.ts` 머리 주석이 소유한다).
맞추는 명령은 `link-claude-profile` 이다. `--apply` 를 빼고 먼저 돌려 바꿀 목록을 본다.
`$PROFILE_ID` 는 거부 메시지에 나온 프로필 id 다.

```bash
orch worker link-profile "$PROFILE_ID"
```

무엇을 링크하고 복사하는지, 세션 상태와 로그인 정보를 옮기지 않는 이유, 백업 이름은 `scripts/lib/claude-profile.ts` 머리 주석이 소유한다.
목록이 맞으면 같은 명령에 `--apply` 를 붙여 돌리고, 그 계정의 Claude 세션을 다시 시작한다.

## 첫 화면에서 멈춤

원인은 `worker-show --dispatch "$DISPATCH_ID"` 의 `lastFailure` 에 나온다.
알려진 원인은 claude 의 폴더 신뢰 확인, codex 의 업데이트 안내(`agent-update-prompt`), hook 신뢰 확인(`agent-hooks-review-prompt`),
작업 폴더 신뢰 확인(`agent-trust-workspace`)이다.
codex 의 hook 신뢰 확인이 fos-skills 의 orch hook 때문이면 Codex 설치본이 `.codex-plugin` 매니페스트가 없는 옛 버전이다. `codex plugin marketplace upgrade fos-skills` 로 갱신한다. 근거는 저장소의 `docs/adr/007-codex-manifest-without-hooks.md` 가 소유한다.

터미널과 워크트리는 이미 만들어져 있으므로 새로 띄우지 않고 이어 붙인다.

1. `terminal read` 로 화면을 본다. 신뢰나 업데이트를 대신 승인하지 않는다.
   건너뛰는 선택지를 고르고 사용자에게 알린다.
   codex 의 `agent-trust-workspace` 는 선택지가 신뢰와 종료 둘뿐이고, 고른 값이 저장소 루트 단위로 저장된다.
   건너뛸 수 없으므로 사용자에게 묻는다. 승인을 받으면 `orca terminal send --terminal term_... --enter` 처럼 handle 을 글자 그대로 적어 첫 선택지를 고른다.
   본문 없이 `--enter` 만 보내고, `worker-show` 가 첫 화면 대기(`agent-trust-workspace` 같은)를 보일 때만 `block-worker-terminal-send.ts` 가 통과시킨다.
   handle 을 `"$TERMINAL_HANDLE"` 같은 변수로 주면 대상을 확인할 수 없어 이 hook 이 거부한다.
   거절하면 그 터미널을 `worker-release` 로 닫고 claude worker 로 다시 띄운다
2. `terminal wait --for tui-idle` 로 입력 대기 상태를 확인한다
3. `orch worker launch --spec "$SPEC" --repo "$REPO" --task "$TASK_ID" --retry-of "$DISPATCH_ID" -- --terminal "$TERMINAL_HANDLE"` 로 붙인다(같은 Task 를 선택 검사와 이력 기록을 거쳐 다시 띄운다).
   워크트리는 이전 dispatch 이력에서 읽는다.
   `--model` 은 줄 수 없지만 처음 띄울 때 준 모델이 그 터미널에 남아 있다

## 시작 직후 실패

worker 가 `stage.detail: agent_readiness`, `outcome: failed` 로 아무 출력 없이 끝나면, codex 는 먼저 위 「codex 준비 판정」 의 설정을 본다.
설정이 있는데도 실패하면 그 모델이 이 환경에서 뜨지 않는 것이므로 같은 Task 를 다른 모델로 다시 띄운다. `launch-worker` 의 `--spec` 은 검사할 지시서이고, `--task` 는 기존 Task 를 고른다. `--retry-of` 는 `--task` 와 함께 쓰고, Task 가 `failed` 나 `blocked` 일 때만 받아들여진다. 터미널이 끊겨 `abandoned` 가 된 경우는 아래 「끊긴 worker 다시 띄우기」 의 표를 따른다.
`$WORKTREE` 는 처음 띄운 워크트리 경로다. `$AGENT`, `$MODEL`, `$EFFORT` 는 1단계에서 다시 고른 값이다.
다른 모델을 고르면 지시서의 `worker 선택:` 줄을 먼저 고친다. `launch-worker` 가 선택 검사 뒤 이력의 워크트리에서 같은 Task 를 다시 띄운다.

```bash
orch worker launch --spec "$SPEC" --repo "$REPO" --task "$TASK_ID" --retry-of "$DISPATCH_ID" -- --agent "$AGENT" --model "$MODEL" --effort "$EFFORT"
```

## 이전 세션 이어받기

코디네이터가 바뀌거나 계정을 전환한 뒤에는 `orch worker adopt` 로 기존 터미널을 먼저 확인한다. 기본 실행은 다른 Run 의 살아 있는 dispatch 를 제외한 목록을 내며 터미널에 입력하거나 닫지 않는다.

`$TERMINAL` 은 목록에서 고른 handle 이다. 저장소는 작업 폴더에서, `--apply` 의 Run 은 코디네이터 터미널에서 읽는다.

```bash
orch worker adopt
orch worker adopt --apply "$TERMINAL"
```

목록의 `SESSION <터미널> <화면 상태> <브랜치> specs=<지시서 후보>` 줄에서 지시서 후보를 확인한다(세션의 전체 기록은 `--full`). 후보가 없거나 여럿이면 `--spec` 으로 해당 브랜치의 지시서를 고른다. 사람의 셸과 작업·권한·초안 대기 화면은 자동으로 이어 붙이지 않는다. 원래 허락 범위와 막힌 결정을 먼저 확인한다.
기본 실행은 다시 띄울 worker 도 낸다. 명령은 안내만 하고 부르지 않는다.

- `LIMITED <터미널>`: 살아 있는 dispatch 인데 화면이 사용 한도 안내에서 멈췄다(문구는 `scripts/lib/sessions.ts` 의 `LIMIT_LINE` 이 소유한다). 계정을 바꾼 뒤 이전 계정의 worker 가 이렇게 남는다. heartbeat 는 계속 와 대기로는 알 수 없다. 아래 줄의 `orch worker resume` 을 부른다(아래 「한도나 재부팅으로 멈춘 worker 이어 가기」)
- `RESTART`: Task 가 `ready` 인데 가장 최근 dispatch 가 `failed` 이고 그 터미널이 열려 있지 않다. 아래 줄의 `orch worker resume` 을 부른다

명령이 `ADOPT-MANUAL` 을 내면 CLI 에 재연결 기능이 없는 것이다. 출력된 임시 이어받기 지시서를 검토하고, 사용자가 교체를 고른 뒤 같은 워크트리에 새 worker 를 띄운다. `ADOPT-ERROR` 면 잔여 자원과 실패 단계를 확인하고 자동으로 다시 띄우지 않는다.

## 한도나 재부팅으로 멈춘 worker 이어 가기

사용 한도나 재부팅으로 멈춘 worker 는 새 worker 를 띄우기 전에 같은 세션을 이어 간다.
`orch worker resume` 은 같은 워크트리에 새 터미널을 열고 앞 세션을 `claude --resume` / `codex resume` 으로 다시 열어 같은 Task 에 잇는다.
새 worker 는 앞 대화를 그대로 이어 가므로 재개 절을 쓰지 않는다. 지시서의 `worker 선택:` 도 바꾸지 않는다.

```bash
orch worker resume --dispatch "$DISPATCH_ID"
```

- 대상은 `orch worker adopt` 의 `LIMITED`, `RESTART` 줄과, 앞 실행이 정리한 뒤 실패해 `abandoned` 로 남은 그 Task 의 마지막 dispatch 다. 터미널이 열린 `failed`, `abandoned` dispatch 와 정상 작업 중인 worker 는 거부한다.
- 한도라면 먼저 사용자에게 계정 전환을 요청하고, 바꾼 뒤 부른다. Claude 는 `projects` 를 공유하는 프로필끼리면 계정을 바꿔도 이어지고, Codex 는 같은 계정에서만 이어진다([`agent-selection.md`](agent-selection.md) 「사용 한도에 걸렸을 때」).
- 명령은 세션을 찾은 뒤에야 옛 dispatch 를 abandon 하고 옛 터미널을 닫는다. 기록을 찾지 못하면 옛 worker 를 건드리지 않고 끝난다.
- 찾기와 에이전트 준비의 시한이 기본 100초이고, 그 뒤 같은 Task 에 잇는 호출이 붙는다. 대개 2분 안에 끝나지만 넘길 수 있으니 Bash 도구의 `timeout` 을 300000 으로 주고 전경으로 부른다. 중간에 끊겨도 잠금이 같은 세션의 두 번째 실행을 막는다.
- 출력 줄과 단계별 종료 코드, `NEXT` 의 원본은 `scripts/worker/resume-worker.ts` 머리 주석이다. `RESUME-FAIL` 이 나면 같은 출력의 `NEXT` 를 따른다.
- `RESUME-FAIL link` 뒤에는 `NEXT` 의 `orch worker launch ... -- --terminal` 한 줄만 부르고 같은 명령을 다시 부르지 않는다. 남은 터미널에 이미 resume 한 에이전트가 붙어 있어, 같은 명령은 한 세션에 두 번째 프로세스를 띄우려다 잠금으로 거부된다.
- link 실패의 `NEXT` 는 선택 검사와 이력 기록을 받는 launch 명령이다. resume 내부의 연결 호출은 그대로다. 지시서 기록이 없어 `<지시서 경로>` 가 나오면 실제 경로로 채운다.
- resume 이 실패했거나 제공자를 바꿔야 하면 아래 「끊긴 worker 다시 띄우기」 로 새 worker 를 띄우고 재개 절을 쓴다.

## 끊긴 worker 다시 띄우기

같은 제공자로 이어 갈 수 있으면 먼저 위 「한도나 재부팅으로 멈춘 worker 이어 가기」 의 `orch worker resume` 을 쓴다. 이 절은 resume 이 실패했거나 제공자를 바꿀 때다.

기기가 재시작되어 worker 터미널이 사라지면 `worker-show` 가 `[abandoned] stage=terminal_missing` 으로 보인다.
`wait-important` 는 이때 `WORKER_LOST <dispatch> stage=terminal_missing` 줄을 내고 종료 코드 5 로 끝난다.
같은 dispatch 는 다음 대기에서 다시 알리지 않으므로 이 줄을 받은 자리에서 처리한다.
다시 띄우지 않기로 했으면 task 를 `task-update --status failed --result cancelled` 로 취소해 기록을 남긴다.
`$DISPATCH_ID` 는 그 줄의 dispatch, `$TASK_ID` 는 `worker-show` 의 `dispatch.taskId`, `$WORKTREE` 는 처음 띄운 워크트리 경로다.
이 절도 `launch-worker` 를 거쳐 같은 Task 를 다시 띄운다. `$SPEC` 은 지시서 경로이고, `$REPO` 는 저장소 경로다. 모델을 바꾸면 지시서의 선택 줄부터 고친다.
이 절은 일하던 worker 가 끊긴 경우다. 충돌과 리뷰 반영은 [`replying.md`](replying.md) 의 「충돌과 리뷰 반영은 만든 worker 가 이어 받는다」 가 우선한다.

어느 상태에서 어느 명령을 쓰는지는 이 표가 소유한다. `--retry-of` 는 실패하거나 막힌 Task 의 가장 최근 settled dispatch 에만 받아들여진다.

| Task 상태 | dispatch 상태 | 쓰는 명령 |
| --- | --- | --- |
| `failed` 또는 `blocked` | 가장 최근 settled dispatch 가 `agent_readiness` 같은 시작 실패 | `orch worker launch --spec "$SPEC" --repo "$REPO" --task "$TASK_ID" --retry-of "$DISPATCH_ID"` (위 「시작 직후 실패」) |
| `ready` | `abandoned` (`terminal_missing`) | `--retry-of` 없이 `orch worker launch --spec "$SPEC" --repo "$REPO" --task "$TASK_ID"` |
| `ready` | 가장 최근 dispatch 가 `failed` (재부팅으로 터미널과 루프가 함께 사라졌다) | `--retry-of` 없이 `orch worker launch --spec "$SPEC" --repo "$REPO" --task "$TASK_ID"`. `adopt-sessions` 는 이 경우 `RESTART` 줄과 `orch worker resume` 을 낸다. 이 명령은 resume 이 실패했을 때 쓴다 |
| `dispatched` | 살아 있는 dispatch | 다시 띄우지 않는다. 같은 worker 에 `send-to-worker` 로 보낸다 |

Task 상태는 `orca orchestration task-list --run "$RUN_ID" --json` 으로 본다. 상태를 모르고 `--retry-of` 를 주면 `task_not_startable`(「--retry-of must name the latest settled Dispatch of a failed or blocked Task」)로 거절된다. 거절되면 표의 둘째 줄로 간다.

1. `worker-show --dispatch "$DISPATCH_ID"` 로 dispatch 상태를 보고, `task-list` 로 Task 상태를 본다
2. 워크트리에서 `git -C "$WORKTREE" log --oneline origin/"$BASE"..HEAD` 와 `git -C "$WORKTREE" status --short` 로 끝난 커밋과 작업 트리의 변경을 확인한다. 커밋 안 된 변경은 버리지 않고 그대로 둔다
3. 지시서에 「재개」 절을 더한다. 끝난 phase 와 그 커밋, 작업 트리에 남은 변경, 다음에 할 일을 적는다. 새 worker 는 앞 대화를 모르므로 이 절만 보고 이어 가야 한다.
   앞 worker 의 회신, 사용자 결정, 조사 결과는 내용을 이 절에 옮겨 적는다. 임시 폴더(`/tmp`, `$TMPDIR`, scratchpad)의 파일은 재부팅이나 세션 종료 뒤 사라져 새 worker 가 막힌다. `spec-lint` 가 그런 경로를 `임시` 경고로 알린다
4. 표대로 띄운다. 워크트리는 이전 dispatch 이력에서 읽는다
5. 끊긴 dispatch 의 터미널을 닫는다. `worker-release` 를 먼저 부르고, `identity_unproven` 으로 닫지 않았을 때만 [`cleanup.md`](cleanup.md) 의 「worker 터미널을 닫는 기본 경로」 조건을 확인한 뒤 `orca terminal close` 를 쓴다

```bash
orch worker launch --spec "$SPEC" --repo "$REPO" --task "$TASK_ID" -- --agent "$AGENT" --model "$MODEL" --effort "$EFFORT"
orca orchestration worker-release --dispatch "$OLD_DISPATCH_ID"
```

`$OLD_DISPATCH_ID` 는 끊긴 dispatch 다. `terminal close` 로 넘어가면 `worker-show` 의 `worker.agentTerminalHandle` 이 새로 띄운 worker 의 터미널과 다른지 확인한 뒤 닫는다.
