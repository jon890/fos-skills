# 5. 답하고 지시 보내기

## 코디네이터가 답할 질문과 사용자에게 올릴 결정

| 누가 답하나 | 기준 |
| --- | --- |
| 코디네이터 | 겹치는 파일의 최소 수정 범위, 이미 내려진 결정의 적용, 규칙 안의 검증 방법, 이미 끝난 질문의 정리 |
| 사용자 | 저장 형식이나 사용자 데이터 변경, 근거 없는 임시 값을 쓰는 범위 확장, 사용자 규칙의 예외, 비용이나 규모 결정 |

**사용자가 정할 질문은 코디네이터가 권장안으로 대신 답하지 않는다.** 권장안을 보여 사용자가 고르게 하고, 고른 답을 worker 에게 보낸다. 대신 답하면 사용자가 정할 일을 코디네이터가 정한 것이 된다.
worker 가 `--decision` 으로 보낸 질문은 `결정:` 줄과 `권장:` 줄을 그대로 옮겨 사용자에게 보인다. 코디네이터가 사용자에게 직접 묻는 결정도 같은 형식으로 쓴다. 형식과 검사 규칙은 저장소의 `docs/data-schema.md` 「사용자 결정 질문 형식」 이, 형식 예시는 `templates/spec-common.md` 가 소유한다.
사용자 결정은 배경과 권장안을 붙여 `AskUserQuestion` 하나에 최대 4개까지 묶는다.
Codex 에서는 같은 내용을 사용 가능한 구조화 질문 도구로 묻는다.
답을 받으면 각 질문의 원래 메시지 ID 에 `send-to-worker --reply-to` 로 전달한다.
이미 끝난 질문도 처리 결과를 답해 thread 를 닫는다. ack 만 해서는 답한 것이 아니다.

답한 뒤 보드가 다음 조회에서 해당 질문을 제외하는지 확인한다. 모두 답했다면 자동 질문 수는 0 이다.
수동 `decide` 항목이 남아 있으면 별도로 정리한다. 보드는 이 항목을 질문 수에 더한다.
보드가 갱신되지 않으면 감시를 `--once` 로 실행해 조회 오류를 확인한다.
delivery 는 질문 외의 보고와 터미널 처리까지 마친 뒤 ack 한다. 질문 묶음만 임의로 ack 하지 않는다.

**worker 에게 보내는 답과 후속 지시는 `send-to-worker` 로 보낸다.** worker 터미널에 `orca terminal send` 로 직접 쓰지 않는다.
작업 중인 worker 의 입력란에 글이 섞이고, 끝난 dispatch 의 터미널에 쓴 지시는 Task 기록 없이 사라진다.
스크립트가 dispatch 상태를 보고 경로를 고른다. 상태별 경로와 종료 코드는 스크립트 머리 주석이 소유한다.
종료 코드 3 이면 표준 출력이 다음에 할 일을 말한다. 끝난 dispatch 에 `--spec` 을 주지 않았거나 터미널이 없는 경우다.
살아 있는 dispatch 인데 reply 할 메시지가 없거나 모두 이미 답한 question 이면 스크립트가 그 dispatch 에 새 메시지로 보내고 깨운다(`sent:` 줄). `orca orchestration send` 와 `nudge-worker` 를 직접 잇지 않는다.

**끝난 dispatch 의 질문에 답할 때도 `send-to-worker` 를 쓴다.** 답할 메시지를 고르고, 이미 답한 question 은 건너뛴다. 깨울 worker 가 없으니 답만 달고 0 으로 끝난다.
`send-to-worker` 는 `--from run:<run>` 을 붙여 보내고, Orca 터미널 안이라 `consumer_fenced` 로 거부되면 `--from` 없이 한 번 다시 보낸다.
질문 감시는 질문의 스레드에 worker 쪽으로 간 답이면 보낸 쪽과 상관없이 답한 것으로 센다(ADR-015).

`$DISPATCH_ID` 는 그 worker 의 dispatch, `$BODY` 는 보낼 글이다. 답할 메시지를 정해야 하면 `--reply-to "$MSG_ID"` 를 더한다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/send-to-worker.ts" --dispatch "$DISPATCH_ID" --body "$BODY"
```

`send --to dispatch:<id>` 는 worker 가 하위 run 을 만든 뒤에는 `recipient_run_mismatch`, 끝난 dispatch 에는 `dispatch_inactive` 로 거절된다.
같은 worker 의 마지막 메시지에 단 `reply` 는 전달된다.

## 입력 대기로 멈춘 worker 를 깨운다

**worker 가 status 를 보내고 입력 대기로 멈춰 있으면 `reply` 와 `send` 가 그 worker 를 깨우지 않는다.**
worker 는 메시지를 다음 턴의 `check` 에서 읽는데, 입력 대기인 worker 에게는 다음 턴이 오지 않는다.
dispatch 가 끝나지 않아 `worker-start --terminal` 도 `already has an active dispatch` 로 거절된다.
**`send-to-worker` 가 아니라 `reply` 나 `send` 를 직접 보냈으면 그 직후에 `nudge-worker` 를 부른다.** 화면 판정과 재시도는 스크립트 머리 주석이 소유한다.
`$MSG_ID` 는 방금 보낸 메시지 id 다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/nudge-worker.ts" --terminal "$TERMINAL_HANDLE" --msg-id "$MSG_ID"
```

종료 코드 4 는 입력란에 쓰다 만 글이 있거나 권한 확인 창이라 입력하지 않은 것이다. `terminal read --screen` 으로 화면을 보고, 권한 확인 창이면 4단계의 「권한 확인 창」 을 따른다.
종료 코드 1 이면 다시 확인해도 턴이 시작되지 않은 것이다. 화면을 보고 아래 「후속 지시가 전달되지 않음」 의 표로 판단한다.

**끝난(settled) worker 의 후속 지시서는 `send-to-worker --spec` 으로 보낸다.** 끝난 dispatch 에는 `reply` 가 가지 않는다. 스크립트가 남은 터미널을 한 번 이어 쓰고, `agent_unconfigured` 이면 같은 worktree 에 새 worker 를 띄운다. 그 밖의 실패는 아래 기준으로 처리한다.
worker 가 보낸 `ready: <plan> <worktree> <지시서>` 처럼 대상 dispatch 가 없으면 [`launch.md`](launch.md) 의 기존 worktree 예시로 띄운다.

### 후속 지시가 전달되지 않음

끝난 worker 의 터미널에 `worker-start --terminal` 로 후속 일을 주면, 종료 코드 1 과 `turn_start_unobserved` 로 끝나기도 한다.
지시가 실제로 입력되지 않은 경우가 있다. `terminal read` 로 화면을 보고 아래로 판단한다.

| 화면 | 판단 | 할 일 |
| --- | --- | --- |
| `Working` 이 보이거나 새 턴이 진행 중이다 | 늦게 시작한 것이다 | 그대로 두고 4단계 대기를 건다 |
| 입력란이 비어 있고 새 턴이 없다 | 지시가 전달되지 않았다 | `worker-abandon` 으로 그 dispatch 를 닫고, `worker-show` 의 `taskId` 로 `worker-start --task "$TASK_ID" --retry-of "$DISPATCH_ID" --terminal "$TERMINAL_HANDLE" --worktree "path:$WORKTREE"` 를 다시 보낸다(`--task` 로 기존 Task 를 다시 띄우는 호출이라 3단계의 예외다) |

같은 지시를 `--spec` 으로 새로 보내지 않는다. Task 가 둘 생겨 어느 쪽이 유효한 시도인지 흐려진다.

### 이어 쓸 수 없는 터미널

**`worker-start --terminal` 은 떠 있는 에이전트를 이어 쓰므로 `--agent`, `--model`, `--effort` 와 함께 쓰지 못한다.** `launch-worker` 는 이 조합을 Orca 에 보내기 전에 거부한다.

| 오류 | 뜻 | 할 일 |
| --- | --- | --- |
| `invalid_argument: --model and --effort cannot be applied when reusing an existing terminal` | `--terminal` 에 `--model`, `--effort` 를 함께 줬다 | 둘을 뺀다. 모델을 바꿔야 하면 아래 새 worker 로 간다 |
| `invalid_argument: --terminal reuses an existing agent and cannot combine with --agent` | `--terminal` 에 `--agent` 를 함께 줬다 | `--agent` 를 뺀다 |
| `agent_unconfigured: Terminal ... is not running a recognized agent` | Orca 가 그 터미널의 에이전트를 인식하지 못한다. 화면에서 Claude 가 입력을 기다리고 있어도 난다. 끝난 dispatch 의 터미널은 대개 재부팅 없이도 이 오류가 난다. Orca 가 잠깐 응답하지 않았거나 재부팅, 잠자기로 세션이 바뀐 뒤에도 난다 | 이어 쓰지 못한다. 아래 새 worker 로 간다 |

**끝난 dispatch 를 이어 쓸 때는 `--spec` 만 준다.** `send-to-worker --dispatch <끝난 dispatch> --spec <후속 지시서> --run ...` 이면 된다. `--body` 는 끝난 dispatch 로 가지 않으므로 줘도 무시한다. 살아 있는 dispatch 에 `--spec` 만 주면 보낼 글이 없어 종료 코드 2 로 거부한다.

**`worker_done` 만으로는 터미널이 사용자 보유가 되지 않는다.** 실측(2026-10-23, `worker-list --terminal-state reclaimable`)에서 `worker_done` 뒤의 터미널은 `terminalState: reclaimable`, `ownershipState: owned`, `releaseState: not_requested` 였다. 이 상태는 닫고 새로 띄울 수 있다.
`user_owned`(`retainedReason: user_takeover`)는 사용자가 그 터미널에 직접 입력했을 때, `released` 는 `worker-release` 로 넘겼을 때 생긴다. 둘 다 사용자에게 넘어간 터미널이라 `send-to-worker` 는 닫지 않고 종료 코드 1 로 끝난다.
이 세션이 띄운 worker 의 터미널이 맞는지 확인한 뒤 코디네이터가 직접 정리한다.

1. `orca orchestration worker-show --dispatch <끝난 dispatch> --json` 으로 `ownershipState` 와 `ownerDispatchId` 를 본다
2. `orca terminal read --terminal <handle>` 로 화면이 비어 있고 입력을 기다리는지 본다. 사용자가 쓰는 중이면 닫지 않는다
3. 이 세션이 띄운 것이 맞으면 `orca terminal close --terminal <handle>` 로 닫는다
4. `launch-worker --spec <후속 지시서> --worktree <워크트리>` 를 `--terminal` 없이 부른다

`send-to-worker --spec` 은 `launch-worker` 의 종료 코드 3(`agent_unconfigured`)을 받으면 원래 dispatch 의 설정으로 새 worker 를 띄운다. 설정을 읽는 법과 닫지 않는 조건은 `send-to-worker` 머리 주석이 소유한다. 새 worker 는 앞 대화를 모르므로 후속 지시서에 이어받을 상태를 적는다.

`launch-worker` 를 직접 부르면 종료 코드 3 과 안내만 낸다. 그 경우 아래 순서로 복구한다.

**새 worker 로 이어받는 순서**

충돌과 리뷰 반영에는 이 순서를 쓰지 않는다. 아래 「충돌과 리뷰 반영은 만든 worker 가 이어 받는다」 가 우선한다.

1. 앞 worker 의 작업이 push 됐는지 본다. `git -C "$WORKTREE" log --oneline origin/"$BASE"..HEAD`, `git -C "$WORKTREE" status --short`, `git ls-remote origin "$BRANCH"` 를 본다. 커밋하지 않은 변경은 워크트리에 남아 있으니 버리지 않는다
2. 그 터미널이 **이 세션이 띄운 worker 의 것일 때만** `orca terminal close --terminal "$OLD_TERMINAL_HANDLE"` 로 닫는다. 다른 세션이나 사용자의 터미널은 닫지 않는다
3. 후속 지시서에 이어받는 상태를 적는다. 끝난 커밋, 커밋 안 된 변경, 앞 worker 의 마지막 status 다. 새 worker 는 앞 대화를 모른다
4. 같은 워크트리에 `--terminal` 없이 `launch-worker --worktree "$WORKTREE" ... -- --agent ... --model ... --effort ...` 로 띄운다

worker 세션이 커밋 전에 끝나 dispatch 가 `failed`, liveness 가 `exited` 가 된 경우도 같은 순서다. 커밋하지 않은 변경이 워크트리에 남으므로 새 worker 가 이어받아 끝낸다.

## 권장안이 검사를 무력화하는지 본다

**worker 가 권장안을 `ask` 로 보내면 그 안이 검사를 무력화하는지 먼저 본다.**
worker 가 critic 을 돌리는 절차면 계획서 결함에 대한 질문이 구현 전에 온다.
critic 이 `REVISE` 로 판정했는데 worker 가 계획서를 고치지 않고 「구현에서 처리할 권장안」 을 보내면, 그 안에 검사를 피하는 방법이 있는지 본다.
금지 문자열 검사를 피하려고 문자열을 쪼개 붙이는 안은 받지 않고 검사 범위를 고치게 한다.

**사용자가 정할 것은 대신 정하지 않는다.** worker 의 `ask` 가 2단계 「기술 판단과 사용자 판단」 의 사용자 쪽이면 배경과 권장안을 붙여 사용자에게 묻고, 받은 답을 `reply` 로 보낸다.

## PR 생성과 리뷰 회신을 대신 한다

worker 의 `gh pr create` 와 GitHub 회신은 권한 분류기에 자주 막힌다.
지시서대로 worker 가 push 한 뒤 본문 파일 경로(worker 세션 임시 폴더의 파일)를 status 나 `worker_done` 으로 보내면 코디네이터가 처리한다.

- PR 은 그 본문 파일로 연다. 본문 끝의 서명 줄은 저장소 지침을 따른다.
  본문 파일이 없으면 브랜치 diff 를 읽고 직접 쓴 뒤 `gh pr edit --body-file` 로 넣는다
- 리뷰 회신은 스레드 id 와 회신 파일을 받아 `review-fix` 스킬의 `review_threads.py reply` 로 달고, 반영한 스레드만 `resolve` 한다.
  `reply` 와 `resolve` 는 스레드 id 만 받으므로 대상 저장소 밖에서 돌릴 때는 `--repo "$OWNER/$REPO"` 를 준다

## 충돌과 리뷰 반영은 만든 worker 가 이어 받는다

**기본은 worker 가 머지될 때까지 스스로 처리한다.** 공통 지시서가 준비됨 뒤에도 CI 실패, 충돌, 기준 브랜치 변경을 worker 에게 맡기고, `worker_done` 은 MERGED 뒤에 온다. 아래는 worker 가 이미 `worker_done` 으로 끝났거나 멈춘 PR 의 절차다.

**충돌과 리뷰 반영은 그 PR 을 만든 worker 가 이어 받는다.** 새 worker 를 띄우면 워크트리와 터미널이 늘어 로컬 자원을 쓴다.
그래서 worker 터미널은 `worker_done` 뒤에도 PR 이 머지되거나 닫힐 때까지 남긴다. 터미널을 닫는 때는 [`cleanup.md`](cleanup.md) 의 「정리」 가 소유한다.

충돌하거나 리뷰가 달리면 끝난 dispatch 로 후속 지시서를 보낸다.
`$DISPATCH_ID` 는 PR 을 만든 worker 의 끝난 dispatch, `$SPEC_FILE` 은 후속 지시서다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/send-to-worker.ts" --dispatch "$DISPATCH_ID" --spec "$SPEC_FILE" --run "$RUN_ID"
```

- 스크립트가 같은 워크트리에서 터미널을 바꿔 다시 띄우는 것(`agent_unconfigured`)도 이어 받기로 본다. 워크트리와 터미널 수가 늘지 않는다
- 종료 코드 3(터미널이 없다)이면 새 worker 를 띄우지 않고 사용자에게 알린다
- 리뷰 반영 지시서에는 PR 번호와 「반영하지 않을 지적은 회신 전에 ask 로 묻는다」 를 적는다. 모델은 [`agent-selection.md`](agent-selection.md) 의 모델 표에서 단순 반영 행으로 고른다
- 이 규칙이 위 「새 worker 로 이어받는 순서」 나 [`launch.md`](launch.md) 가 남은 터미널을 닫고 새 worker 로 띄우라고 한 곳과 어긋나면 충돌과 리뷰 반영에는 이 규칙이 우선한다

회신과 resolve 가 막히면 위 「PR 생성과 리뷰 회신을 대신 한다」 를 따라 코디네이터가 단다.
