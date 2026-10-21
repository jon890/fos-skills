# 5. 답하고 지시 보내기

**worker 에게 보내는 답과 후속 지시는 `send-to-worker.py` 로 보낸다.** worker 터미널에 `orca terminal send` 로 직접 쓰지 않는다.
작업 중인 worker 의 입력란에 글이 섞이고, 끝난 dispatch 의 터미널에 쓴 지시는 Task 기록 없이 사라진다.
스크립트가 dispatch 상태를 보고 경로를 고른다. 경로와 종료 코드는 스크립트 머리 주석이 소유한다.

| dispatch | 스크립트가 하는 일 |
| --- | --- |
| 살아 있다 | 그 worker 의 마지막 메시지에 `reply` 하고 `nudge-worker.py` 로 깨운다 |
| 끝났고 터미널이 남았다 | `--spec` 의 후속 지시서로 그 터미널에 새 Task 를 띄운다. `--spec` 이 없으면 종료 코드 3 |
| 끝났고 터미널도 없다 | 종료 코드 3. `launch-worker.sh --worktree` 로 새로 띄운다 |

`$DISPATCH_ID` 는 그 worker 의 dispatch, `$BODY` 는 보낼 글이다. 답할 메시지를 정해야 하면 `--reply-to "$MSG_ID"` 를 더한다.

```bash
python3 "$SKILL_DIR/scripts/send-to-worker.py" --dispatch "$DISPATCH_ID" --body "$BODY"
```

`send --to dispatch:<id>` 는 worker 가 하위 run 을 만든 뒤에는 `recipient_run_mismatch`, 끝난 dispatch 에는 `dispatch_inactive` 로 거절된다.
같은 worker 의 마지막 메시지에 단 `reply` 는 전달된다.

## 입력 대기로 멈춘 worker 를 깨운다

**worker 가 status 를 보내고 입력 대기로 멈춰 있으면 `reply` 와 `send` 가 그 worker 를 깨우지 않는다.**
worker 는 메시지를 다음 턴의 `check` 에서 읽는데, 입력 대기인 worker 에게는 다음 턴이 오지 않는다.
dispatch 가 끝나지 않아 `worker-start --terminal` 도 `already has an active dispatch` 로 거절된다.
**`send-to-worker.py` 가 아니라 `reply` 나 `send` 를 직접 보냈으면 그 직후에 `nudge-worker.py` 를 부른다.** 화면 마지막 줄들로 입력 대기인지 보고, 그때만 「코디네이터 메시지를 check 로 읽어라」 를 넣고 턴 시작을 확인한다.
작업 중이면 입력하지 않는다. 턴 시작이 보이지 않으면 같은 request id 로 `--retry-request` 를 한 번 더 보낸다.
`$MSG_ID` 는 방금 보낸 메시지 id 다.

```bash
python3 "$SKILL_DIR/scripts/nudge-worker.py" --terminal "$TERMINAL_HANDLE" --msg-id "$MSG_ID"
```

종료 코드 4 는 입력란에 쓰다 만 글이 있거나 권한 확인 창이라 입력하지 않은 것이다. `terminal read --screen` 으로 화면을 보고, 권한 확인 창이면 4단계의 「권한 확인 창」 을 따른다.
종료 코드 1 이면 다시 확인해도 턴이 시작되지 않은 것이다. 화면을 보고 아래 「후속 지시가 전달되지 않음」 의 표로 판단한다.

**끝난(settled) worker 에게 일을 더 주려면 같은 worktree 에 새 dispatch 를 띄운다.** 끝난 dispatch 에는 `reply` 가 가지 않는다.
후속 지시서를 써서 `send-to-worker.py --spec` 으로 주면 남은 터미널을 이어 쓴다. 터미널이 없으면 [`launch.md`](launch.md) 의 기존 worktree 예시를 쓴다.
worker 가 보낸 `ready: <plan> <worktree> <지시서>` 도 그 예시로 띄운다.

### 후속 지시가 전달되지 않음

끝난 worker 의 터미널에 `worker-start --terminal` 로 후속 일을 주면, 종료 코드 1 과 `turn_start_unobserved` 로 끝나기도 한다.
지시가 실제로 입력되지 않은 경우가 있다. `terminal read` 로 화면을 보고 아래로 판단한다.

| 화면 | 판단 | 할 일 |
| --- | --- | --- |
| `Working` 이 보이거나 새 턴이 진행 중이다 | 늦게 시작한 것이다 | 그대로 두고 4단계 대기를 건다 |
| 입력란이 비어 있고 새 턴이 없다 | 지시가 전달되지 않았다 | `worker-abandon` 으로 그 dispatch 를 닫고, `worker-show` 의 `taskId` 로 `worker-start --task "$TASK_ID" --retry-of "$DISPATCH_ID" --terminal "$TERMINAL_HANDLE" --worktree "path:$WORKTREE"` 를 다시 보낸다 |

같은 지시를 `--spec` 으로 새로 보내지 않는다. Task 가 둘 생겨 어느 쪽이 유효한 시도인지 흐려진다.

## 권장안이 검사를 무력화하는지 본다

**worker 가 권장안을 `ask` 로 보내면 그 안이 검사를 무력화하는지 먼저 본다.**
worker 가 critic 을 돌리는 절차면 계획서 결함에 대한 질문이 구현 전에 온다.
critic 이 `REVISE` 로 판정했는데 worker 가 계획서를 고치지 않고 「구현에서 처리할 권장안」 을 보내면, 그 안에 검사를 피하는 방법이 있는지 본다.
금지 문자열 검사를 피하려고 문자열을 쪼개 붙이는 안은 받지 않고 검사 범위를 고치게 한다.

**사용자가 정할 것은 대신 정하지 않는다.** worker 의 `ask` 가 2단계 「기술 판단과 사용자 판단」 의 사용자 쪽이면 배경과 권장안을 붙여 사용자에게 묻고, 받은 답을 `reply` 로 보낸다.

## PR 생성과 리뷰 회신을 대신 한다

worker 의 `gh pr create` 와 GitHub 회신은 권한 분류기에 자주 막힌다.
지시서대로 worker 가 push 한 뒤 본문 파일 경로를 status 로 보내면 코디네이터가 처리한다.

- PR 은 그 본문 파일로 연다. 본문 끝의 서명 줄은 저장소 지침을 따른다.
  본문 파일이 없으면 브랜치 diff 를 읽고 직접 쓴 뒤 `gh pr edit --body-file` 로 넣는다
- 리뷰 회신은 스레드 id 와 회신 파일을 받아 `review-fix` 스킬의 `review_threads.py reply` 로 달고, 반영한 스레드만 `resolve` 한다.
  `reply` 와 `resolve` 는 스레드 id 만 받으므로 대상 저장소 밖에서 돌릴 때는 `--repo "$OWNER/$REPO"` 를 준다

## 리뷰 반영을 맡긴다

PR 에 리뷰가 달리면 PR 을 연 worker 에게 `review-fix` 스킬로 반영하게 한다.
그 worker 가 끝났으면 같은 worktree 에 새 dispatch 를 띄우고, 지시서에 PR 번호와 「반영하지 않을 지적은 회신 전에 ask 로 묻는다」 를 적는다.
리뷰 반영은 [`agent-selection.md`](agent-selection.md) 의 모델 표에서 단순 반영 행으로 모델을 고른다.
회신과 resolve 가 막히면 위 「PR 생성과 리뷰 회신을 대신 한다」 를 따라 코디네이터가 단다.
