# 4. 기다리기

## 질문 감시와 압축 뒤 복구

**`watch-questions` 를 Monitor 의 이벤트 소스로 Run 마다 하나씩 띄운다.**
Monitor 의 `command` 에 아래 명령을 넣는다. `$SKILL_DIR` 과 `$REPO` 는 절대경로로, `$RUN_ID` 는 현재 Run 으로 바꾼다.
Monitor 가 없는 하네스에서는 같은 명령을 하네스의 백그라운드 실행 기능으로 띄우고 출력 알림을 받는다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/watch-questions.ts" --run "$RUN_ID" --repo "$REPO"
```

새 question/escalation 은 `QUESTION`, 답이 없는 채로 다시 알릴 시간이 되면 `REMINDER` 한 줄을 낸다.
기본 재알림은 10분이며 `--remind-after 300` 처럼 초 단위로 바꾼다. 조회 간격은 `--interval` 로 바꾼다.
알린 시각은 `orch_paths.ts` 가 정한 `state/questions-seen.json` 에 Run 별로 남는다.
다시 띄워도 재알림 시간이 되기 전에는 같은 질문을 알리지 않는다.
질문을 찾는 범위와 조회 한도는 `lib/questions.ts`, 알림 형식은 `watch-questions` 머리 주석이 소유한다.
조회 실패(답변 기록 한도 도달 포함)는 stdout 의 `WATCH-ERROR` 줄로 알리고 다음 조회에서 다시 시도한다. 같은 이유는 이유가 바뀌거나 조회가 한 번 성공할 때까지 다시 내지 않는다.
`WATCH-ERROR` 를 받았는데 다음 조회도 같은 이유로 실패하면 아래 doctor 명령으로 질문 상태를 본다. `SKIP-QUESTIONS` 에 같은 이유가 나오면 질문을 조회하지 못하는 상태이므로 그 이유(Orca 가 꺼짐, Run id 가 틀림)부터 고친다.
조회 범위 안내는 stderr 로만 나온다. stderr 와 보드에 조회 범위가 표시되면 그 밖의 미답변은 빠질 수 있다.

**압축이나 세션 재시작 뒤 첫 작업은 감시 복구다.** Monitor 목록과 아래 프로세스 목록에서 현재 Run 의 질문 감시와 완료 대기를 확인한다.
꺼진 질문 감시는 위 명령으로 다시 띄우고, 완료 대기는 이 문서의 「이전 세션의 대기」 절차로 복구한다.
이미 켜진 감시는 두 번째로 띄우지 않는다.

```bash
ps -eo pid,command | grep -E "watch-questions|wait-important|orchestration check" | grep "$RUN_ID"
python3 "$SKILL_DIR/scripts/orch-doctor.py" --run "$RUN_ID"
```

doctor 의 `UNANSWERED` 는 10분 이상 답이 없는 질문이다. `SKIP-QUESTIONS` 는 조회하지 못했다는 뜻이므로 질문이 없다는 근거로 쓰지 않는다.
`--run` 을 주면 저장소의 `session-resume` 핸들러에 살아 있는 대기 pid 와 미답변 질문 id 를 넘긴다([`hooks.md`](hooks.md)).
알림을 받으면 [`replying.md`](replying.md) 의 분류 기준으로 처리한다. 감시는 delivery 를 소비하거나 ack 하지 않으므로 아래 완료 대기와 함께 쓴다.

**대기는 `wait-important` 를 하네스의 백그라운드 실행 기능으로 run 마다 하나만 건다.**
앞에서 돌리면 그동안 코디네이터가 막힌다.
셸의 `&` 나 `nohup` 으로 띄우면 끝나도 완료 알림이 오지 않고 고아 프로세스가 남는다. 이 플러그인의 PreToolUse 훅(`hooks/block-background-wait.ts`)이 그런 Bash 호출을 거부한다. 이 스크립트와 `check --wait` 둘 다 막는다.
스크립트 안의 `check --wait` 가 대기 자리를 쥐므로 둘째 대기는 `waiter_exists` 로 바로 끝난다.
걸기 전에 이미 도는 대기가 있는지 본다.

```bash
ps -eo pid,command | grep -E "orchestration check|wait-important" | grep -v grep
```

**`check --wait` 를 직접 걸지 않는다.** heartbeat 만 든 묶음을 받을 때마다 읽을 것 없이 ack 하고 다시 거는 데 턴을 쓴다. 스크립트가 그 묶음은 ack 하고 계속 기다린다.

**처리한 delivery 는 다음 대기의 `--ack` 로 넘긴다.**
묶인 run 은 ack 하기 전까지 같은 delivery 를 다시 준다.
출력의 마지막 줄 `LAST_DELIVERY <id>` 의 id 를 `$DELIVERY_ID` 에 넣는다. 첫 대기처럼 넘길 delivery 가 없거나 id 가 `-` 면 `--ack "$DELIVERY_ID"` 를 통째로 뺀다.

**대기 시간은 하네스의 명령 한도보다 짧게 준다.**
Claude Code 의 백그라운드 Bash 는 따로 정하지 않으면 30분 뒤 멈춘다.
Bash 도구의 `timeout` 을 최대인 7200000 으로 주고, 스크립트의 `--timeout-ms` 는 기본값 7000000 을 쓴다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/wait-important.ts" --run "$RUN_ID" --ack "$DELIVERY_ID"
```

종료 코드와 `TIMEOUT` 줄은 스크립트 머리 주석이 소유한다. 아래는 코디네이터가 할 일이다.

- 종료 코드 6(`의심스러운 worker_done`)은 자동 ack 하지 않는다. [`verification.md`](verification.md) 의 「완료 전에 온 worker_done」 을 먼저 따른다
- PR 이 없는 읽기 전용 작업은 대기와 분류 양쪽에 `--completion-contract none` 을 준다
- `TIMEOUT LAST_DELIVERY <id>` 는 실패가 아니다. 그 id 로 다시 건다
- orca 오류로 끝나면 아래 「대기가 바로 끝나거나 남음」 을 따른다
- 종료 코드 4(`waiter_exists`)는 다시 걸어도 같은 오류만 받는다. stderr 로 보여 준 남은 대기를 정리한 뒤 건다. 고아 대기만 남았으면 `--kill-stale` 을 더해 다시 건다
- 종료 코드 5(`WORKER_LOST`)는 처리하지 않은 끊긴 worker 다. 받은 그 자리에서 [`launch.md`](launch.md) 의 「끊긴 worker 다시 띄우기」 를 따른다. 같은 dispatch 는 다음 대기에서 다시 깨우지 않고 stderr 에 `아직 처리되지 않았다` 한 줄로 남기므로, 다시 대기를 걸기 전에 처리한다

**복구하거나 더 처리할 일이 없다고 확인한 dispatch 는 `--ack-lost` 로 기록한다.**
`--ack-lost` 는 기록만 쓴 뒤 종료 코드 0 으로 끝나므로 대기는 따로 건다. `--ignore-lost` 와의 차이와 실패 처리는 스크립트 머리 주석이 소유한다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/wait-important.ts" --run "$RUN_ID" --ack-lost "$DISPATCH_ID"
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/wait-important.ts" --run "$RUN_ID" --ack "$DELIVERY_ID" --kill-stale
```

## 깨어날 때마다 정리와 보드 동기화

**대기가 끝날 때마다, 그리고 기다리는 동안 5분마다 아래 두 명령을 돌린다.** 메시지를 읽기 전에 돈다.
**사용자가 정리하라고 말하지 않아도 돈다.** 끝난 워크트리, 세션(터미널과 Dispatch), 브랜치를 코디네이터가 직접 지우지 않고 이 루프가 지운다.
머지마다 직접 정리하면 잊히고, 프로세스가 worktree 를 잡아 실패한 정리는 다시 돌아보지 않는다.
두 스크립트는 상태로만 판정하므로, 건너뛴 항목은 다음 루프에서 다시 시도된다. 따로 기억하지 않는다.
5분 주기는 백그라운드 대기와 별개로 하네스의 예약 기능이나 다음 깨어남에 붙인다.

`$BASE` 는 기준 브랜치, `$SPECS_DIR` 은 지시서 폴더, `$GOAL_ID` 는 목표 항목 id 다. 저장소 오버레이가 정한다.
보드가 없는 저장소는 `board-sync.ts` 를 건너뛰고, 목표 항목이 없으면 `--goal` 을 뺀다. `--goal-items` 는 하위 호환 옵션이라 예시에 쓰지 않는다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/cleanup-sweep.ts" --repo "$REPO" --base "$BASE" --run "$RUN_ID" --specs-dir "$SPECS_DIR" --kill-holders --apply
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/board-sync.ts" --repo "$REPO" --goal "$GOAL_ID"
```

머지 큐를 걸어 둔 동안에는 `finish-*.out` 의 마지막 줄도 본다. `FINISH-FAIL` 이면 출력의 이유를 사용자에게 알린다. 읽는 법은 [`cleanup.md`](cleanup.md) 의 「머지 뒤 마무리」 가 소유한다.

**worker 를 띄운 저장소가 둘 이상이면 `--repo` 를 저장소마다 준다.** 한 번의 실행이 저장소를 차례로 돌고, 하나를 읽지 못해도 나머지는 돈다.
`--base` 를 주지 않으면 저장소마다 `origin/HEAD` 가 가리키는 브랜치를 쓴다. 기준 브랜치가 저장소마다 다르면 `--base` 를 빼는 편이 맞다.
`--specs-dir` 에 상대경로를 주면 저장소마다 그 저장소 기준으로 읽는다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/cleanup-sweep.ts" --repo "$REPO" --repo "$OTHER_REPO" --run "$RUN_ID" --specs-dir .orch/specs --kill-holders --apply
```

`cleanup-sweep.ts` 가 다루는 경우와 건너뛰는 조건은 그 파일 머리 주석이 소유한다. 스크립트가 다루는 경우를 코디네이터가 직접 지우지 않는다.
`건너뜀` 줄만 읽는다. 살아 있는 worker 나 커밋 안 된 변경 때문이면 그대로 두고, 같은 항목이 여러 루프째 남으면 그 worker 를 확인한다.

## 받은 메시지 읽기

**대기 결과는 `triage-messages` 로 읽는다.** 출력 파일을 눈으로 훑지 않는다.
한 delivery 에 heartbeat 가 수십 건 섞이면 그 사이의 `worker_done` 하나를 놓친다. 출력 순서와 입력 형식은 스크립트 머리 주석이 소유한다.
`$OUT` 은 백그라운드 작업의 출력 파일 경로다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/triage-messages.ts" "$OUT"
```

**놓친 보고가 의심되면 지난 시각부터 다시 본다.** compact 나 세션 재시작 뒤, ack 를 먼저 하고 읽지 못한 경우가 여기 해당한다.
`--live` 는 읽음 표시를 하지 않으므로 도는 대기의 delivery 를 건드리지 않는다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/triage-messages.ts" --live --run "$RUN_ID" --since 3h
```

## 대기가 바로 끝나거나 남음

백그라운드 대기가 종료 코드 144 로 끝난 것처럼 보여도 Orca CLI 프로세스가 살아 있을 수 있다.
그 프로세스가 대기 자리를 쥐고 있으면 새로 건 대기가 `waiter_exists` 로 바로 끝난다.
위 `ps` 명령으로 찾아서 종료한 뒤 다시 건다. 이 세션이 건 프로세스이므로 다른 run 의 것과 구분해서 종료한다.

Orca runtime 이 잠시 끊기면 `runtime_unavailable` 로 끝나기도 한다. `orca status` 로 살아 있는지 확인한 뒤 다시 건다.

### 이전 세션의 대기

세션을 다시 띄운 뒤 첫 대기가 `waiter_exists` 면 이것이다.
이전 세션의 백그라운드 대기(`wait-important` 와 그 안의 `check --wait`)는 세션이 끝나도 부모 없는 프로세스로 남는다.
그 대기가 받은 메시지는 아무에게도 전달되지 않는다.

```bash
ps -ax -o pid,ppid,lstart,command | grep -E "orchestration check|wait-important" | grep "$RUN_ID"
```

고아 대기의 판정과 `--kill-stale` 이 종료하는 범위는 `wait-important` 머리 주석이 소유한다. 다른 run 의 대기는 다른 세션의 것이므로 직접 건드리지 않는다.
종료 뒤에는 대기를 다시 건다. 그 대기가 이미 받아 간 메시지는 위 `--live --since` 로 다시 본다.

## heartbeat 만 올 때

`You have N orchestration message` 알림은 대개 heartbeat 다.
살아 있는 대기는 그대로 두고, 그 대기가 heartbeat 만 든 delivery 를 돌려주면 다음 대기의 `--ack` 로 넘긴다.
heartbeat 는 worker 가 멈춰 있어도 오므로, 진행은 커밋과 화면으로 판단한다.
heartbeat 는 오는데 커밋과 화면이 몇 분째 그대로면 `terminal read --screen` 으로 화면을 보고 아래를 따른다.

- 하위 에이전트나 worker 가 `Do you want to proceed?` 에서 기다린다: 아래 「권한 확인 창」
- codex 화면에 `Usage limit reached` 가 떠 있다: 아래 「사용량 한도로 멈춤」

heartbeat 의 `payload.phase` 는 worker 가 스스로 적는 값이다.
`waiting` 은 worker 가 백그라운드로 돌린 검사가 끝나기를 기다린다는 뜻으로도 쓰인다.
이때 worker 의 턴은 끝나 화면이 입력 대기로 보이고 커밋도 늘지 않아 멈춘 것과 구분되지 않는다.
`worker-read --dispatch "$DISPATCH_ID"` 의 마지막 메시지와, 검사 프로세스가 `ps` 에 살아 있는지로 판단한다.

### 권한 확인 창

`terminal read --screen` 으로 화면을 보고 명령이 무엇을 하는지 읽는다.
**코디네이터가 worker 의 확인 창을 대신 승인하지 않는다.** 명령과 영향을 사용자에게 알리고, 사용자가 그 터미널에서 직접 고르게 한다.
코디네이터가 누르면 사용자가 보지 못한 쓰기가 사용자 승인으로 처리된다.
하위 에이전트가 `;` 로 이은 긴 셸을 쓰면 `Parse error` 로 자동 승인되지 않고 이 창에서 기다린다. 같은 일이 반복되면 지시서에 명령을 나눠 쓰라고 적는다.

### 사용량 한도로 멈춤

heartbeat 와 liveness 는 `live` 로 남아 대기만으로는 알 수 없다. `terminal read --screen` 으로 화면을 본다.
한도 안내가 떠 있으면 그 worker 는 더 진행하지 않는다는 근거다.

`worker-stop` 은 터미널이 `user_owned` 이면 `stop_unknown` 으로 끝나고, 이 상태의 Task 에 `--retry-of` 를 주면 `task_not_startable` 로 거절된다.
`worker-abandon` 으로 dispatch 를 닫은 뒤 다른 제공자로 다시 띄운다. 워크트리는 그대로 이어 쓴다.
`$AGENT`, `$MODEL`, `$EFFORT` 는 1단계에서 다시 고른 값이다. `--task` 로 기존 Task 를 다시 띄우는 호출이라 `launch-worker` 를 쓰지 않는 3단계의 예외다.

```bash
orca orchestration worker-abandon --dispatch "$DISPATCH_ID" --json
orca orchestration worker-start --task "$TASK_ID" --retry-of "$DISPATCH_ID" --worktree "id:$WORKTREE_ID" --agent "$AGENT" --model "$MODEL" --effort "$EFFORT" --json
```

## 기다리는 동안 worker 워크트리를 고치지 않는다

worker 가 `git add -A` 를 하면 내 변경이 그쪽 커밋에 섞인다. 문서를 쓰려면 별도 워크트리를 만든다.
이미 고쳤으면 아래 순서로 되돌린다.

1. 고친 내용을 저장소 밖으로 복사한다
2. `git checkout -- "$FILE"` 로 되돌린다
3. worker 의 브랜치를 머지한 다음 기준 브랜치에서 다시 적용한다
