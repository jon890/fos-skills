# 4. 기다리기

**`check --wait` 는 하네스의 백그라운드 실행 기능으로 run 마다 하나만 건다.**
앞에서 돌리면 그동안 코디네이터가 막힌다.
셸의 `&` 로 띄우면 끝나도 완료 알림이 오지 않고 고아 프로세스가 남는다.
둘째 대기는 `waiter_exists` 로 바로 끝나고 거기 붙인 `--ack` 만 처리된다.
걸기 전에 이미 도는 대기가 있는지 본다.

```bash
ps -eo pid,command | grep "orchestration check" | grep -- --wait | grep -v grep
```

**대기 시간은 하네스의 명령 한도보다 짧게 준다.**
Claude Code 의 백그라운드 Bash 는 따로 정하지 않으면 30분 뒤 멈춘다.
Bash 도구의 `timeout` 을 최대인 7200000 으로 주고 `--timeout-ms` 는 그보다 작은 7000000 으로 준다.

**처리한 delivery 는 다음 대기의 `--ack` 로 넘긴다.**
묶인 run 은 ack 하기 전까지 같은 delivery 를 다시 준다.
앞 대기가 돌려준 `result.deliveryId` 를 `$DELIVERY_ID` 에 넣는다. 첫 대기처럼 넘길 delivery 가 없으면 `--ack "$DELIVERY_ID"` 를 통째로 뺀다.

keepalive 줄은 15초마다 stderr 로 나와 출력 파일에 섞인다. 그 줄을 빼고 받는다. 이때 파이프의 종료 코드는 `grep` 의 것이라, 대기 결과는 JSON 의 `timedOut` 과 `messages` 로 판단한다.
worker 가 `ready:` 나 PR 본문 경로 같은 status 메시지를 보내기로 했으면 `--types` 에 `status` 를 더한다. `--types` 는 깨어나는 조건이다.

```bash
orca orchestration check --run "$RUN_ID" --ack "$DELIVERY_ID" --wait --types "worker_done,escalation,question" --timeout-ms 7000000 --json 2>&1 | grep -v _keepalive
```

대기는 `--timeout-ms` 가 지나면 메시지 없이 `timedOut: true` 로 끝난다. 실패가 아니므로 다시 건다.

## 깨어날 때마다 정리와 보드 동기화

**대기가 끝날 때마다, 그리고 기다리는 동안 5분마다 아래 두 명령을 돌린다.** 메시지를 읽기 전에 돈다.
머지마다 직접 정리하면 잊히고, 프로세스가 worktree 를 잡아 실패한 정리는 다시 돌아보지 않는다.
두 스크립트는 상태로만 판정하므로, 건너뛴 항목은 다음 루프에서 다시 시도된다. 따로 기억하지 않는다.
5분 주기는 백그라운드 대기와 별개로 하네스의 예약 기능이나 다음 깨어남에 붙인다.

`$BASE` 는 기준 브랜치, `$SPECS_DIR` 은 지시서 폴더, `$GOAL_ID` 와 `$ITEMS_FILE` 은 목표 항목과 추적 항목 파일이다. 저장소 오버레이가 정한다.
보드가 없는 저장소는 `board-sync.py` 를 건너뛰고, 목표 항목이 없으면 `--goal` 과 `--goal-items` 를 뺀다.

```bash
python3 "$SKILL_DIR/scripts/cleanup-sweep.py" --repo "$REPO" --base "$BASE" --run "$RUN_ID" --specs-dir "$SPECS_DIR" --apply
python3 "$SKILL_DIR/scripts/board-sync.py" --repo "$REPO" --goal "$GOAL_ID" --goal-items "$ITEMS_FILE"
```

`cleanup-sweep.py` 의 판정과 건너뛰는 조건은 그 파일 머리 주석이 소유한다.
`건너뜀` 줄만 읽는다. 살아 있는 worker 나 커밋 안 된 변경 때문이면 그대로 두고, 같은 항목이 여러 루프째 남으면 그 worker 를 확인한다.

## 받은 메시지 읽기

**대기 결과는 `triage-messages.py` 로 읽는다.** 출력 파일을 눈으로 훑지 않는다.
한 delivery 에 heartbeat 가 수십 건 섞이면 그 사이의 `worker_done` 하나를 놓친다.
스크립트는 `worker_done`, `escalation`, `question` 을 먼저 따로 모으고 heartbeat 는 보낸 쪽마다 개수만 낸다.
백그라운드 출력 파일 끝에 하네스가 붙이는 종료 코드 줄과 keepalive 줄은 건너뛴다.
`$OUT` 은 백그라운드 작업의 출력 파일 경로다.

```bash
python3 "$SKILL_DIR/scripts/triage-messages.py" "$OUT"
```

**놓친 보고가 의심되면 지난 시각부터 다시 본다.** compact 나 세션 재시작 뒤, ack 를 먼저 하고 읽지 못한 경우가 여기 해당한다.
`--live` 는 `check --all` 을 부르므로 읽음 표시를 하지 않고, 도는 대기의 delivery 를 건드리지 않는다.

```bash
python3 "$SKILL_DIR/scripts/triage-messages.py" --live --run "$RUN_ID" --since 3h
```

## 대기가 바로 끝나거나 남음

백그라운드 대기가 종료 코드 144 로 끝난 것처럼 보여도 Orca CLI 프로세스가 살아 있을 수 있다.
그 프로세스가 대기 자리를 쥐고 있으면 새로 건 대기가 `waiter_exists` 로 바로 끝난다.
위 `ps` 명령으로 찾아서 종료한 뒤 다시 건다. 이 세션이 건 프로세스이므로 다른 run 의 것과 구분해서 종료한다.

Orca runtime 이 잠시 끊기면 `runtime_unavailable` 로 끝나기도 한다. `orca status` 로 살아 있는지 확인한 뒤 다시 건다.

### 이전 세션의 대기

세션을 다시 띄운 뒤 첫 대기가 `waiter_exists` 면 이것이다.
이전 세션의 백그라운드 `check --wait` 는 세션이 끝나도 부모 없는 프로세스로 남는다.
그 대기가 받은 메시지는 아무에게도 전달되지 않는다.

```bash
ps -ax -o pid,ppid,lstart,command | grep "orchestration check" | grep "$RUN_ID"
```

부모 PID 가 1 이고 시작 시각이 이 세션보다 앞선 것이 그것이다.
그 프로세스와 부모 셸을 `kill` 하고 대기를 다시 건다.
다른 run 의 대기는 다른 세션의 것이므로 건드리지 않는다.
그 대기가 이미 받아 간 메시지는 위 `--live --since` 로 다시 본다.

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

```bash
orca orchestration worker-abandon --dispatch "$DISPATCH_ID" --json
orca orchestration worker-start --task "$TASK_ID" --retry-of "$DISPATCH_ID" --worktree "id:$WORKTREE_ID" --agent claude --model claude-sonnet-5-5 --effort medium --json
```

## 기다리는 동안 worker 워크트리를 고치지 않는다

worker 가 `git add -A` 를 하면 내 변경이 그쪽 커밋에 섞인다. 문서를 쓰려면 별도 워크트리를 만든다.
이미 고쳤으면 아래 순서로 되돌린다.

1. 고친 내용을 저장소 밖으로 복사한다
2. `git checkout -- "$FILE"` 로 되돌린다
3. worker 의 브랜치를 머지한 다음 기준 브랜치에서 다시 적용한다
