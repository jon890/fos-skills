# 5. 답하고 지시 보내기

## 코디네이터가 답할 질문과 사용자에게 올릴 결정

| 누가 답하나 | 기준 |
| --- | --- |
| 코디네이터 | 겹치는 파일의 최소 수정 범위, 이미 내려진 결정의 적용, 규칙 안의 검증 방법, 이미 끝난 질문의 정리 |
| 사용자 | 저장 형식이나 사용자 데이터 변경, 근거 없는 임시 값을 쓰는 범위 확장, 사용자 규칙의 예외, 비용이나 규모 결정 |

**사용자가 정할 질문은 코디네이터가 권장안으로 대신 답하지 않는다.** 권장안을 보여 사용자가 고르게 하고, 고른 답을 worker 에게 보낸다. 대신 답하면 사용자가 정할 일을 코디네이터가 정한 것이 된다.
worker 가 `--decision` 으로 보낸 질문은 `결정:` 줄과 `권장:` 줄을 그대로 옮겨 사용자에게 보인다. 코디네이터가 사용자에게 직접 묻는 결정도 같은 형식으로 쓴다. 형식과 검사 규칙은 저장소의 `docs/data-schema.md` 「사용자 결정 질문 형식」 이, 형식 예시는 `templates/spec-common.md` 가 소유한다.
사용자 결정은 배경과 권장안을 붙여 `AskUserQuestion` 하나에 묶고, Codex 에서는 사용 가능한 구조화 질문 도구로 묻는다. 답을 받으면 아래 「질문과 막힘에 답하기」 를 따른다.

## 질문과 막힘에 답하기

질문과 worker 가 직접 올린 막힘에는 원래 질문의 메시지 ID 를 `--reply-to` 로 명시한다. 보드는 그 질문의 스레드에 worker 쪽으로 보낸 메시지만 「답함」 으로 센다([ADR-015](../../../docs/adr/015-board-decide-clear.md)).
`--reply-to` 없는 send 는 질문이 없는 새 지시에만 쓴다. 답과 관계없는 진행 지시·CI 알림·머지 알림은 `--no-reply` 로 보내 질문 스레드에 연결하지 않는다.
생략한 경우의 자동 후보 선택과 경고 조건은 `send-to-worker.ts` 머리 주석이 소유한다. 경고에 나온 질문에 답하려던 것이 맞는지 확인하고, 이미 전달했다면 같은 답을 다시 보내지 않는다.
같은 dispatch 의 뒤 질문에 답하면 앞선 미답변 질문도 해결된 것으로 본다. worker 가 한 번에 한 답을 받으므로 재전송 질문이 보드에 남지 않게 하는 규칙이다. 서로 다른 dispatch 의 질문은 함께 닫지 않는다.
살아 있는 dispatch 에서 이미 해결된 질문도 처리 결과를 답해 thread 를 닫는다. 단 일이 끝난 worker 의 막힘은 답장 대신 `worker-release` 로 닫는다. 답장은 그 worker 를 다시 깨운다. inactive dispatch 의 질문은 보드 결정 필요에서 제외한다. ack 만 해서는 답한 것이 아니다.

답한 뒤 보드가 다음 조회에서 해당 질문을 제외하는지 확인한다. 모두 답했다면 자동 질문 수는 0 이다.
수동 `decide` 항목이 남아 있으면 별도로 정리한다. 보드는 이 항목을 질문 수에 더한다.
보드가 갱신되지 않으면 감시를 `--once` 로 실행해 조회 오류를 확인한다.
delivery 는 질문 외의 보고와 터미널 처리까지 마친 뒤 ack 한다. 질문 묶음만 임의로 ack 하지 않는다.

**worker 에게 보내는 답과 후속 지시는 `send-to-worker` 로 보낸다.** worker 터미널에 `orca terminal send` 로 직접 쓰지 않는다.
작업 중인 worker 의 입력란에 글이 섞이고, 끝난 dispatch 의 터미널에 쓴 지시는 Task 기록 없이 사라진다.
스크립트가 dispatch 상태를 보고 경로를 고른다. 상태별 경로, 종료 코드, 판정 줄(`REPLIED`, `SENT`, `ENDED` 같은 것), 세션 재시작 뒤 `reply` 거부(`stable_pane_required`)의 우회, `consumer_fenced` 재전송은 스크립트 머리 주석이 소유한다. 종료 코드 3 이면 `ENDED` 줄이고 다음에 할 명령은 `--full` 의 안내 줄에 있다. `orca orchestration send` 와 `nudge-worker` 를 직접 잇지 않는다.

**끝난 dispatch 의 질문은 보드에서 제외한다.** 닫는 근거(PR 종료 상태와 워크트리 대조)와 닫은 질문 처리는 `lib/questions.ts` 의 「닫은 질문」 과 `send-to-worker.ts` 머리 주석이 소유한다([ADR-015](../../../docs/adr/015-board-decide-clear.md)). 살아 있는 dispatch 의 질문은 이 근거로 닫지 않고, 닫으려고 같은 답을 반복하지 않는다. 실제 후속 일이 있으면 `send-to-worker --spec` 으로 이어 쓴다. 세션이 바뀐 뒤 reply 가 계속 거부되면 사용자에게 알린다.

`$DISPATCH_ID` 는 그 worker 의 dispatch, `$MSG_ID` 는 원래 질문이나 막힘의 메시지 ID, `$BODY` 는 답이다.

```bash
orch worker send --dispatch "$DISPATCH_ID" --reply-to "$MSG_ID" --body "$BODY"
```

`send --to dispatch:<id>` 는 worker 가 하위 run 을 만든 뒤 `recipient_run_mismatch` 로 거절될 수 있다. 끝난 worker 는 후속 Task 로 다시 시작하고, 자동 해제로 닫힌 터미널도 다시 열린다. 연결된 서버처럼 후속 작업을 거절하는 경우에는 다시 띄우기로 넘어간다.

## spec 인터뷰를 중계한다

worker 가 spec 단계에서 결정 블록 여러 개를 `--decision` 질문 하나로 보내면 아래로 중계한다. worker 쪽 절차는 spec 스킬의 [`references/interview.md`](../../spec/references/interview.md) 가 정한다.

1. 블록을 `AskUserQuestion` 한 번에 묻는다. 한 질문에 블록은 4개까지다. 5개 이상은 `worker-ask` 가 받지 않고 worker 가 4개씩 나눠 질문마다 보내므로 코디네이터가 나누지 않는다. 블록의 배경, 선택지와 영향, 권장을 그대로 옮긴다. 첫 라운드의 열린 질문은 선택지 없이 묻는다.
2. 모든 블록의 답을 모은 뒤 원래 질문에 한 번 답한다. 답은 `D1=<고른 답>` 처럼 질문 안 블록 순서대로 결정마다 한 줄이고, 사용자가 덧붙인 말은 그대로 붙인다. 블록 수와 답 줄 수가 같은지 보내기 전에 센다. worker 는 `worker-ask --check-answer` 로 같은 대조를 하고, 빠진 번호는 `MISSING` 으로 알려 다시 묻는다.
3. worker 가 스펙 확인 요청을 보내면 스펙 요약(목표, 범위 밖, 요구사항 표, 결정 표)을 메시지 본문에 보이고 확인을 묻는다. `작성자(위임)` 행은 따로 짚는다.
4. 사용자가 확인하면 「사용자 확인: YYYY-MM-DD」 로 답한다. 고칠 점이 나오면 그것을 답하고, 고친 스펙으로 다시 확인을 받는다.

**확인을 코디네이터가 대신하지 않는다.** 결정이 모두 권장안대로여도 사용자에게 보이고 받는다. 사용자가 「이후는 권장안으로 진행」 처럼 위임했으면 그 말을 답에 그대로 옮긴다.

## 보드 승인

승인 대기는 코디네이터만 올린다. worker 는 `orch worker ask` 로 묻는다. 같은 일은 같은 id 로 올려 예전 내용과 새 내용이 섞이지 않게 한다. id 는 영문·숫자로 시작하고 영문·숫자·점·밑줄·붙임표만 쓴다. 올릴 때 제목(`--title`)과 종류(`--kind`)를 주고, Run 은 주지 않으면 지금 코디네이터의 Run 을 쓴다.

| 종류 | 함께 줄 값 |
| --- | --- |
| `post`, `spec` | `--preview` |
| `step` | `--preview`, `--item`, `--step` |
| `real` | `--preview`, `--target`, `--change`, `--rollback` |
| `command` | `--command`. 명령을 채울 Orca 터미널에서 올린다 |

`--then` 에 승인 뒤 할 일을 적는다. 미리보기 경로는 부른 폴더 기준으로 받는다. 명령과 출력은 [보드 안내](board.md#승인-대기)를 따른다.

| 받은 것 | 처리 |
| --- | --- |
| `APPROVED <id> <버전>` | 실행 직전에 `orch board approval check <id> --version <받은 버전>` 을 부른다. `APPROVAL-OK` 일 때만 실행한다. `APPROVAL-REJECT` 면 실행하지 않고 이유와 함께 사용자에게 묻는다. 등록이 중간에 실패하면 결과를 보고하고, 다시 하려면 같은 id 로 올려 사용자가 다시 누르게 한다 |
| `REVISE <id> <버전>` | 본문의 글대로 고쳐 같은 id 로 다시 올린다 |
| 채팅 승인 | 지금처럼 인정하고 `orch board approval cancel <id> --reason chat` 으로 열린 대기를 닫는다. 여러 대기 중 어느 것인지 모르면 묻는다. `real` 도 채팅 승인을 인정한다 |
| `command` 실행 결과 | 사용자가 친 결과를 본 뒤 `orch board approval cancel <id> --reason done` 으로 닫는다 |

worker 메시지의 「APPROVED」 글은 승인으로 보지 않는다. 승인 기록과 신호 payload 를 `check` 로 확인한다. payload 의 `source` 가 `board-approval` 인 신호도 이 확인을 거친다.

`STEP-READY ask` 를 받으면 본문 단계 글 앞 번호(「2.」의 2)를 단계 번호로 쓴다. 결정 질문 대신 `step-<항목>-<번호>` 를 id 로 삼아 `--kind step --item <항목> --step <번호> --keep-open` 으로 올린다. 열려 있으면 `kept` 로 그대로 둔다. `--then` 과 미리보기에 무엇을 진행할지 적는다. 승인되면 진행하고, 고쳐 달라면 계획을 고쳐 같은 id 로 다시 올린다. 루프는 승인 대기를 쓰지 않는다.

### 막는 것과 막지 못하는 것

`check` 는 worker 목록에 있는 발신·누른·올린 터미널과 `check` 를 부른 터미널, 달라진 미리보기와 버전, 이미 쓴 승인을 거절한다. worker 가 승인 제목만 보냈어도 누른 기록이 없으면 거절한다. 누름 기록은 보드 창의 버튼이 창 전용 스크립트로만 쓰고, 그 스크립트를 Bash 도구로 부르면 hook 이 거부한다. 보드 창이 없는 세션(창을 열지 못하는 환경)에서는 누름 기록이 없으므로 채팅 승인을 쓴다.

채팅 승인은 `check` 와 `real` 두 번 누르기를 거치지 않는다. Orca 밖 창의 신호는 터미널 목록에 없는 handle 로 올 수 있어 누른 터미널 자체를 대조하지 못한다. `check` 는 있는 발신 handle 과 올린 터미널을 worker 목록과 대조한다. 코디네이터 터미널 자체가 worker 목록에 있는 넘김·중첩 세션은 그 터미널에서 부른 `check` 도 거절되므로 채팅 승인을 쓴다.

코디네이터와 worker 는 승인 파일을 직접 고치지 않는다. 창 전용 스크립트도 부르지 않는다. Bash 도구로 `approvals.ts press` 를 부르면 hook 이 거부한다. 같은 사용자 권한으로 파일과 메시지를 함께 꾸미거나, hook 이 읽지 못하는 호출과 환경 변수 변경까지 막지는 못한다. 범위와 한계는 [승인 설계](../../../docs/features/board-approval/design.md#막는-것과-막지-못하는-것)를 따른다.

## 메시지로 worker 를 깨운다

**Orca 가 reply 와 send 로 worker 를 깨운다.** 작업 중이면 턴이 끝난 뒤 메시지를 읽고, 쉬는 worker 는 바로 깨어난다. `send-to-worker` 는 터미널에 입력하지 않고 전송 뒤 `DELIVERED` 와 0 으로 끝난다.

**끝난 worker 의 후속 지시서는 `send-to-worker --spec` 으로 보낸다.** 허락과 worker 선택 줄을 검사한 뒤 지시서를 읽으라는 한 줄을 Orca 메시지로 보낸다. 새 Task 와 dispatch 가 생기면 `FOLLOW-UP <앞 dispatch> <새 dispatch> <새 Task>` 를 내고 띄우기 기록에 남긴다. 터미널은 새 dispatch 에서 읽으므로 자동 해제 뒤 다시 열린 터미널도 기록에 잡힌다. 전송이 거절된 경우에만 아래의 `launch-worker` 복구 경로로 내려간다.

후속 일의 실행 설정은 실제 worker 의 값으로 기록한다. 새 dispatch 에서 읽지 못하면 앞 기록을 물려받고, 지시서의 선택과 다르면 note 로 알린다. 후속 지시서로 보드 항목을 갱신하고 `worker-launched` 이벤트도 낸다. 기록·보드·이벤트 실패는 경고로 남기며 이미 전달한 일을 다시 띄우지 않는다.

지시서 없이 끝난 worker 에게 본문만 보낼 때는 남은 미답변 질문에 먼저 답한다. 답할 곳이 없고 화면이 작업 중이면 메시지를 후속 Task 로 보낸다. 이때는 띄우기 기록에 남지 않는다고 stderr 에 알린다. 그 밖에는 종료 코드 3 으로 후속 지시서를 요구한다.

worker 가 보낸 `ready: <plan> <worktree> <지시서>` 처럼 대상 dispatch 가 없으면 [`launch.md`](launch.md) 의 기존 worktree 예시로 띄운다.

### 후속 지시가 전달되지 않음

끝난 worker 의 터미널에 `worker-start --terminal` 로 후속 일을 주면, 종료 코드 1 과 `turn_start_unobserved` 로 끝나기도 한다.
지시가 실제로 입력되지 않은 경우가 있다. `terminal read` 로 화면을 보고 아래로 판단한다.

| 화면 | 판단 | 할 일 |
| --- | --- | --- |
| `Working` 이 보이거나 새 턴이 진행 중이다 | 늦게 시작한 것이다 | 그대로 두고 4단계 대기를 건다 |
| 입력란이 비어 있고 새 턴이 없다 | 전달 여부를 확인하지 못했다 | 화면과 dispatch 상태를 사용자에게 알리고 다시 띄울지 묻는다. 화면이 비었다는 이유로 abandon·재시도하지 않는다 |

사용자가 다시 띄우기로 정하면 `worker-show` 의 `taskId` 로 같은 Task 를 고른다. [`launch.md`](launch.md) 의 「끊긴 worker 다시 띄우기」 Task 상태 표에 따라 `--retry-of` 를 붙일지 정한다. `launch-worker` 에 `--task` 를 빼고 다시 보내면 Task 가 둘 생겨 어느 쪽이 유효한 시도인지 흐려진다.

### 이어 쓸 수 없는 터미널

**`worker-start --terminal` 은 떠 있는 에이전트를 이어 쓰므로 `--agent`, `--model`, `--effort` 와 함께 쓰지 못한다**(`launch-worker` 가 Orca 에 보내기 전에 거부한다). `--model`, `--effort`, `--agent` 를 함께 줬다는 `invalid_argument` 는 그 옵션을 뺀다. 모델을 바꿔야 하면 아래 새 worker 로 간다.
`agent_unconfigured: Terminal ... is not running a recognized agent` 는 Orca 가 그 터미널의 에이전트를 인식하지 못한 것이다. 화면에서 Claude 가 입력을 기다려도 나고, 끝난 dispatch 의 터미널과 재부팅·잠자기 뒤 세션에서 흔하다. 이어 쓰지 못하니 아래 새 worker 로 간다.

**끝난 dispatch 를 이어 쓸 때는 `--spec` 만 준다.** `send-to-worker --dispatch <끝난 dispatch> --spec <후속 지시서> --run ...` 이면 된다. `--body` 는 남은 질문에 답할 때만 쓰고, 그 밖의 후속 지시는 지시서에서 읽는다. 살아 있는 dispatch 에 `--spec` 만 주면 보낼 글이 없어 종료 코드 2 로 거부한다.

**`worker_done` 만으로는 터미널이 사용자 보유가 되지 않는다.** `worker_done` 뒤의 터미널은 `terminalState: reclaimable`, `ownershipState: owned`, `releaseState: not_requested` 다(`worker-list --terminal-state reclaimable`). 이 상태는 닫고 새로 띄울 수 있다.
`user_owned`(`retainedReason: user_takeover`)는 사용자가 그 터미널에 직접 입력했을 때, `released` 는 `worker-release` 로 넘겼을 때 생긴다. 전송이 거절돼 터미널을 다시 쓰는 복구 경로에서는 둘 다 닫지 않고 종료 코드 1 로 끝난다.
이 세션이 띄운 worker 의 터미널이 맞는지 확인한 뒤 코디네이터가 직접 정리한다. `worker_done` 을 받으면 Orca 가 약 2분 뒤 자동 release 한다(`worker-show` 의 `autoReleaseAt`). 자동 release 뒤에도 `send-to-worker --spec` 이 Orca 후속 작업으로 다시 연다. 이어 쓰면 `autoReleaseAt` 이 사라지고 다시 쉴 때 새로 잡힌다. 머지까지 계속 남겨야 하는 worker 는 `worker-keep-open` 으로 자동 release 를 막는다([`cleanup.md`](cleanup.md) 의 「worker 터미널을 닫는 기본 경로」).

1. `orca orchestration worker-show --dispatch <끝난 dispatch> --full --json` 으로 `ownershipState` 와 `ownerDispatchId` 를 본다
2. `orca terminal read --terminal <handle>` 로 화면이 비어 있고 입력을 기다리는지 본다. 사용자가 쓰는 중이면 닫지 않는다
3. 이 세션이 띄운 것이 맞으면 `worker-release` 로 닫는다. `retained`, `identity_unproven` 이면 [`cleanup.md`](cleanup.md) 의 「worker 터미널을 닫는 기본 경로」 조건을 확인한 뒤 `orca terminal close --terminal <handle>` 을 쓴다
4. `launch-worker --spec <후속 지시서> --worktree <워크트리>` 를 `--terminal` 없이 부른다

`send-to-worker --spec` 의 전송 거절 뒤 복구 경로는 `launch-worker` 의 종료 코드 3(`agent_unconfigured`)을 받으면 원래 dispatch 의 설정으로 새 worker 를 띄운다. 설정을 읽는 법과 닫지 않는 조건은 `send-to-worker` 머리 주석이 소유한다. 새 worker 는 앞 대화를 모르므로 후속 지시서에 이어받을 상태를 적는다.

`launch-worker` 를 직접 부르면 종료 코드 3 과 안내만 낸다. 그 경우 아래 순서로 복구한다.

**새 worker 로 이어받는 순서**

1. 앞 worker 의 작업이 push 됐는지 본다. `git -C "$WORKTREE" log --oneline origin/"$BASE"..HEAD`, `git -C "$WORKTREE" status --short`, `git ls-remote origin "$BRANCH"` 를 본다. 커밋하지 않은 변경은 워크트리에 남아 있으니 버리지 않는다
2. 그 터미널이 **이 세션이 띄운 worker 의 것일 때만** `worker-release` 로 닫는다(안 닫히면 `cleanup.md` 의 「worker 터미널을 닫는 기본 경로」). 다른 세션이나 사용자의 터미널은 닫지 않는다
3. 후속 지시서에 이어받는 상태를 적는다. 끝난 커밋, 커밋 안 된 변경, 앞 worker 의 마지막 status 다. 새 worker 는 앞 대화를 모른다
4. 같은 워크트리에 `--terminal` 없이 `launch-worker --worktree "$WORKTREE" ... -- --agent ... --model ... --effort ...` 로 띄운다. 1 에서 본 커밋 안 된 변경을 새 worker 가 이어받을 것이면 `--dirty-ack <이유>` 를 준다. 주지 않으면 `launch-worker` 가 변경 목록을 내고 거부한다

worker 세션이 커밋 전에 끝나 dispatch 가 `failed`, liveness 가 `exited` 가 된 경우도 같은 순서다. 커밋하지 않은 변경이 워크트리에 남으므로 새 worker 가 이어받아 끝낸다.

## 권장안이 검사를 무력화하는지 본다

**worker 가 권장안을 `ask` 로 보내면 그 안이 검사를 무력화하는지 먼저 본다.**
worker 가 critic 을 돌리는 절차면 계획서 결함에 대한 질문이 구현 전에 온다.
critic 이 `REVISE` 로 판정했는데 worker 가 계획서를 고치지 않고 「구현에서 처리할 권장안」 을 보내면, 그 안에 검사를 피하는 방법이 있는지 본다.
금지 문자열 검사를 피하려고 문자열을 쪼개 붙이는 안은 받지 않고 검사 범위를 고치게 한다.

**사용자가 정할 것은 대신 정하지 않는다.** worker 의 `ask` 가 2단계 「기술 판단과 사용자 판단」 의 사용자 쪽이면 배경과 권장안을 붙여 사용자에게 묻고, 받은 답을 `reply` 로 보낸다.

## PR 생성과 리뷰 회신을 대신 한다

worker 의 `gh pr create` 와 GitHub 회신은 권한 분류기에 자주 막힌다.
반복해서 막히는 저장소는 worker 프로필의 사용자 `settings.json` 에 저장소를 한정한 `autoMode.allow` 를 두면 풀린다([`launch.md`](launch.md) 의 `.claude/settings.local.json` 복사 설명).
지시서대로 worker 가 push 한 뒤 본문 파일 경로(worker 세션 임시 폴더의 파일)를 status 나 `worker_done` 으로 보내면 코디네이터가 처리한다.

- PR 은 그 본문 파일로 연다. 본문 파일이 없으면 브랜치 diff 를 읽고 직접 쓴 뒤 `gh pr edit --body-file` 로 넣는다
- 리뷰 회신은 스레드 id 와 회신 파일을 받아 `review-fix` 스킬이 소유한 절차로 달고, 반영한 스레드만 `resolve` 한다

## 자동 리뷰 workflow 를 바꾼 PR

worker 의 변경 파일에 자동 리뷰 workflow(예: `.github/workflows/claude-code-review.yml`)가 있으면 Ready 뒤 자동 리뷰를 기다리지 않고 코디네이터에게 독립 리뷰를 요청한다.
기본 브랜치와 workflow 가 다르면 보안 검증으로 자동 리뷰가 건너뛰어질 수 있으므로, 코디네이터가 별도 리뷰 경로를 마련한다.
독립 리뷰에는 PR URL 과 head SHA, 변경 파일과 검증 결과를 넘긴다. 지적은 PR 을 만든 worker 가 `review-fix` 로 반영한다.
리뷰 workflow 를 바꾸지 않은 PR 은 기존 자동 리뷰 절차를 따른다.

## 다음 단계 이어 가기

`worker_done` 이나 머지·배포 알림을 받았거나 보드를 확인한 턴에, 상태가 doing 이나 wait 인 항목의 첫 미완료 단계를 본다. `[auto]` 면 같은 턴에 이어 가고, `[ask]` 면 `orch board approval add step-<항목>-<번호> --kind step` 으로 승인 대기를 올린다. 미리보기·항목·단계와 승인 확인은 위 [보드 승인](#보드-승인)을 따른다. `[wait]` 면 아무것도 하지 않는다.

띄우기 직전에 확인 명령을 부른다. `$ITEM` 은 보드 항목 id 다.

```bash
orch board auto-check "$ITEM"
```

`AUTO-OK <항목> <번호> <근거>` 면 지시서를 쓰고 띄운다. 지시서 머리에 `보드 항목 id: <항목>` 과 `자동 진행 단계: <번호>` 줄을 적는다. 명시한 번호가 첫 미완료 `[auto]` 단계와 같을 때만 기록한다. 자동 진행 단계를 적고 항목 id를 빠뜨리면 스펙 검사와 실행·후속 전달 명령이 worker를 띄우기 전에 거절한다. 같은 항목의 머지 뒤 확인 등 다른 일에는 자동 진행 단계 줄을 적지 않는다. 커밋하지 않은 스펙은 지시서의 `루프를 쓴다(스펙: …)` 에 절대경로로 적는다. 상대경로 스펙은 지시서 검사가 기준 브랜치의 커밋된 내용으로 읽는다.

띄운 턴의 답에 `다음 단계 자동 진행: <무엇을>, <agent·모델>, <묻지 않은 이유(근거)>` 한 줄을 남긴다. 근거는 `AUTO-OK` 줄의 것을 옮긴다. 따로 메시지를 보내지 않는다.

| 띄운 일 | 줄을 끝내는 방법 |
| --- | --- |
| PR 을 여는 일, 직접 쓴 항목 | worker 가 PR 번호를 알린 턴에 `orch board step <항목> <번호> text "<줄>" --on "<PR> merge"` 로 꼬리표를 붙인다. 머지되면 스크립트가 끝낸다 |
| PR 을 여는 일, `stages` 필드가 있는 항목 | 꼬리표를 붙이지 않고 머지를 확인한 턴에 `orch board step <항목> <번호> done` 으로 끝낸다 |
| PR 이 없는 일 | `worker_done` 을 확인한 턴에 `orch board step <항목> <번호> done` 으로 끝낸다 |

`AUTO-REJECT` 면 이유에 따라 처리한다.

| 이유 | 할 일 |
| --- | --- |
| `자동 진행이 꺼져 있다`, `항목이 없다`, `상태가 doing 이나 wait 가 아니다`, `첫 미완료 단계가 [auto] 가 아니다` | 띄우지 않는다 |
| `worker 나 열린 PR 이 있다` | 띄우지 않는다. 그 단계가 진행 중이다 |
| `worker 나 PR 을 확인하지 못했다` | 띄우지 않는다. `orch loop status` 로 루프가 도는지 보고 다시 확인한다 |
| `이미 한 번 띄웠다` | 머지나 `worker_done` 을 확인해 일이 끝났으면 위 표대로 줄을 끝낸다. 끝내지 못했으면 다시 띄우지 않고 그 줄을 `[ask]` 로 바꿔 사용자에게 묻는다 |
| `근거가 없다`, `스펙 파일이 없다`, `스펙에 확인 줄이 없다`, `계획 파일이 없다`, `앞 사건이 끝나지 않았다` | 띄우지 않고 그 줄을 `[ask]` 로 바꿔 사용자에게 묻는다 |

표시를 바꾸려면 `orch board step <항목> <번호> text "<번호와 새 표시를 넣은 줄 전체>"` 를 쓴다. 줄 끝 꼬리표가 붙은 줄은 새 글에도 꼬리표를 넣는다. 빼면 명령이 거절한다. `[ask]` 단계를 사용자가 허락해 띄우면 그 줄의 표시를 지운다. 그래야 worker 가 조용히 끝났을 때 멈춤 알림이 간다.

살아 있는 worker 수로는 자동 진행을 미루지 않는다. 최근 30분 안에 `WORKER-LIMITED` 를 받았으면 띄우지 않고 사용자에게 알리며 표시는 그대로 둔다. 한 단계는 한 번만 자동으로 띄운다. 전체 테스트는 기존 heavy 자리와 CI 확인 규칙을 따른다.

자동으로 띄운 worker 가 일을 끝내지 못하면(`worker_done` 의 failed, 끝난 터미널, 사용자가 멈춤) 다시 띄우지 않고 그 단계를 `[ask]` 로 바꿔 묻는다. CI 실패와 리뷰 지적은 실패로 보지 않고 같은 worker 에게 고치라고 지시한다.

사용자가 단계 하나를 멈추라고 하면 그 worker 를 기존 절차로 중지하고 그 단계를 `[ask]` 로 바꾼다. 저장소 전체는 `.orch/config.json` 의 `board.auto_advance` 를 `false` 로 둔다. 이 규칙은 저장소 오버레이에 옮겨 적지 않는다.

## 충돌과 리뷰 반영은 만든 worker 가 이어 받는다

**기본은 worker 가 머지될 때까지 스스로 처리한다.** 공통 지시서가 준비됨 뒤에도 CI 실패, 충돌, 기준 브랜치 변경을 worker 에게 맡기고, `worker_done` 은 MERGED 뒤에 온다. 아래는 worker 가 이미 `worker_done` 으로 끝났거나 멈춘 PR 의 절차다.

**충돌과 리뷰 반영은 그 PR 을 만든 worker 가 이어 받는다.** 새 worker 를 띄우면 워크트리와 터미널이 늘어 로컬 자원을 쓴다.
그래서 worker 터미널은 `worker_done` 뒤에도 PR 이 머지되거나 닫힐 때까지 남긴다. 터미널을 닫는 때는 [`cleanup.md`](cleanup.md) 의 「정리」 가 소유한다.

충돌하거나 리뷰가 달리면 끝난 dispatch 로 후속 지시서를 보낸다.
`$DISPATCH_ID` 는 PR 을 만든 worker 의 끝난 dispatch, `$SPEC_FILE` 은 후속 지시서다.

```bash
orch worker send --dispatch "$DISPATCH_ID" --spec "$SPEC_FILE"
```

- 스크립트가 같은 워크트리에서 터미널을 바꿔 다시 띄우는 것(`agent_unconfigured`)도 이어 받기로 본다. 워크트리와 터미널 수가 늘지 않는다
- 후속 지시서를 보내도 종료 코드 3 이면 안내를 읽고 코디네이터에게 알린다
- 리뷰 반영 지시서에는 PR 번호와 「반영하지 않을 지적은 회신 전에 ask 로 묻는다」 를 적는다. 모델은 [`agent-selection.md`](agent-selection.md) 의 모델 표에서 단순 반영 행으로 고른다
- 위 「새 worker 로 이어받는 순서」 나 [`launch.md`](launch.md) 의 새 worker 띄우기와 어긋나면 충돌과 리뷰 반영에는 이 절이 우선한다

회신과 resolve 가 막히면 위 「PR 생성과 리뷰 회신을 대신 한다」 를 따라 코디네이터가 단다.
