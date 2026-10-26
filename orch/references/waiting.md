# 4. 기다리기

## 상주 루프와 압축 뒤 복구

**저장소마다 상주 루프 `orch-loop.ts` 를 하나 띄우고, 세션은 자기 Run 을 그 루프에 등록한다.** 루프는 하네스의 백그라운드 명령이 아니라 분리된 프로세스라 시간 한도에 묶이지 않고, 세션이 끝나도 살아 있다.
같은 저장소를 쓰는 다른 세션이 이미 루프를 띄웠으면 그 루프에 자기 Run 을 더한다. 루프는 Run 마다 그 Run 범위로 질문을 확인하고 정리하며, 알림도 Run 마다 나뉜다([ADR-012](../../docs/adr/012-orch-loop-multi-run.md)).
`$SKILL_DIR` 과 `$REPO` 는 절대경로로, `$RUN_ID` 는 현재 Run 으로 바꾼다. `--run` 과 `--specs-dir` 은 `.orch/config.json` 의 `finish.run`, `finish.specs_dir` 로 대신할 수 있다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/orch-loop.ts" --repo "$REPO" --run "$RUN_ID" --specs-dir "$SPECS_DIR" --start
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/orch-loop.ts" --repo "$REPO" --status
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/orch-loop.ts" --repo "$REPO" --run "$RUN_ID" --stop
```

`--start` 는 루프를 띄우면 `LOOP-STARTED` 와 0, 살아 있는 루프에 이 Run 을 더하면 `LOOP-JOINED` 와 0 으로 끝난다.
이 Run 이 이미 등록돼 있으면 `LOOP-RUNNING <pid> run=<Run id>` 와 4 다. 할 일은 없다.
**세션의 일이 끝나면 `--stop --run` 으로 자기 Run 만 뺀다.** 다른 Run 이 남으면 루프는 그대로 돌고(`LOOP-LEFT`), 마지막 Run 이 빠지면 루프가 끝난다.
`--run` 없는 `--stop` 은 `finish.run` 도 없으면 Run 이 하나라도 등록돼 있을 때 `LOOP-STOP-SHARED` 와 1 로 멈추지 않는다. 다른 세션의 루프를 끊지 않는다. 모두 멈추라는 사용자 지시가 있을 때만 `--stop --all` 을 쓴다.
**`--stop` 이 1 로 끝나면(`LOOP-STOP-UNKNOWN`, `LOOP-STOP-TIMEOUT`) 그 pid 가 루프인지 `ps -o command= -p <pid>` 로 직접 확인한다.** 루프면 끝낸 뒤 다시 `--start` 한다. 다른 프로세스면 끝내지 않는다.

**4 와 함께 `안내:` 줄이 오면 그 루프는 Run 등록을 모르는 옛 orch 로 띄운 루프다.** 다른 세션의 루프이므로 멈추지 않는다. 그 루프를 띄운 세션이나 사용자에게 다시 띄워 달라고 알리고, 그동안은 아래 Monitor 대안을 쓴다.

루프는 `pipeline.tick_sec`(기본 300초)마다 아래를 차례로 한다. 판정과 순서는 `orch-loop.ts` 머리 주석이 소유한다.

- 등록된 Run 마다 질문 확인. 답이 없는 질문을 다시 알릴 시간이 되면 알림 파일에 `REMINDER` 를 쓴다. 새 질문은 `wait-important` 가 question 메시지로 이미 깨어나므로 알림 파일에 쓰지 않는다
- Run 마다 그 Run 범위의 정리(`cleanup-sweep --run`), 원격 브랜치 정리와 보드 동기화(`board-sync`)는 틱마다 한 번
- 내 열린 PR 의 CI 감시. 체크가 실패로 바뀌면 그 PR 의 worker 에게 알리고, 통과로 바뀌면 `ci-passed` 를 낸다. 루프는 CI 를 보고 알린다. `queue.auto_merge` 를 켠 저장소에서는 머지할 수 있는 PR 을 머지 큐에 건다(`orch-loop.ts` 머리 주석의 「자동 머지」)
- Run 마다 그 Run 이 띄운 살아 있는 worker 의 화면 확인. 모델 오류로 멈춘 화면이 기준 틱 수(`pipeline.stall_ticks`, 기본 2틱)만큼 이어지면 `worker-stalled` 를 낸다. 사람이 Esc 로 끊은 화면은 멈춤으로 보지 않는다. 루프는 입력하지 않는다. 다시 시도시키는 일은 저장소의 핸들러가 맡는다([`hooks.md`](hooks.md) 의 「멈춘 worker 다시 시도시키기」)
- Run 마다 `tick` 이벤트. 저장소 공유 일을 하는 핸들러는 입력의 `primary` 가 true 일 때만 한다
- `queue.auto_merge` 를 켠 저장소에서 머지할 수 있는 PR 을 머지 큐에 건다
- 충돌한 내 PR 을 그 PR 을 만든 worker 에게 알리기. 끝난 dispatch 에 이어 쓰는 동안(최대 65분)은 다음 틱이 밀린다

CI 판정은 머지 큐의 기본 판정과 같다. 필수 체크가 아닌 체크의 실패도 `failed` 로 본다. 루프는 `--allow-fail` 을 모르므로, 그 옵션을 주고 머지 큐를 거는 저장소에서는 루프가 실패로 알린 PR 도 큐가 머지할 수 있다.
알림은 Run 마다 `<orch 루트>/state/loop-events/<Run>.jsonl` 에 쌓이고, 아래 대기가 `--run` 과 `--loop-repo` 로 자기 Run 의 것만 읽는다. 주인을 모르는 알림(공유 일의 실패, 보드 결정)은 가장 먼저 등록한 Run 에 간다. 루프의 출력은 `state/loop.log` 에 남는다.
조회 실패는 이유가 바뀔 때만 알림 파일에 쓰므로 틱마다 코디네이터를 깨우지 않는다.

**Monitor 로 `watch-questions.ts` 를 띄우는 것은 루프를 쓸 수 없을 때의 대안이다.** `--run "$RUN_ID" --repo "$REPO"` 를 주고, 질문과 재알림을 한 줄씩 받는다. 이때는 아래 「깨어날 때마다 정리와 보드 동기화」 의 수동 명령도 돌려야 한다.

**압축이나 세션 재시작 뒤 첫 작업은 루프와 대기 복구다.** doctor 에 `--repo` 와 `--run` 을 주면 루프가 죽었을 때 `LOOP-DEAD <repo> <이유>` 줄과 다시 띄울 명령을 낸다. 꺼진 루프는 그 명령으로 다시 띄운다.
완료 대기는 이 문서의 「이전 세션의 대기」 절차로 복구한다. 이미 켜진 루프와 대기는 두 번째로 띄우지 않는다.

```bash
ps -eo pid,command | grep -E "orch-loop|wait-important|orchestration check" | grep -v grep
python3 "$SKILL_DIR/scripts/orch-doctor.py" --repo "$REPO" --run "$RUN_ID"
```

doctor 의 `UNANSWERED` 는 10분 이상 답이 없는 질문이다. `SKIP-QUESTIONS` 는 조회하지 못했다는 뜻이므로 질문이 없다는 근거로 쓰지 않는다.
`--run` 을 주면 저장소의 `session-resume` 핸들러에 루프 생존과 살아 있는 대기 pid, 미답변 질문 id 를 넘긴다([`hooks.md`](hooks.md)).
알림을 받으면 [`replying.md`](replying.md) 의 분류 기준으로 처리한다. 루프는 delivery 를 소비하거나 ack 하지 않으므로 아래 완료 대기와 함께 쓴다.

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
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/wait-important.ts" --run "$RUN_ID" --ack "$DELIVERY_ID" --loop-repo "$REPO"
```

저장소가 둘 이상이면 `--loop-repo` 를 저장소마다 준다. 루프가 없는 저장소는 주지 않는다.
종료 코드와 `TIMEOUT` 줄은 스크립트 머리 주석이 소유한다. 아래는 코디네이터가 할 일이다.

- 종료 코드 6(`의심스러운 worker_done`)은 자동 ack 하지 않는다. [`verification.md`](verification.md) 의 「완료 전에 온 worker_done」 을 먼저 따른다
- PR 이 없는 읽기 전용 작업은 대기와 분류 양쪽에 `--completion-contract none` 을 준다
- `TIMEOUT LAST_DELIVERY <id>` 는 실패가 아니다. 그 id 로 다시 건다
- orca 오류로 끝나면 아래 「대기가 바로 끝나거나 남음」 을 따른다
- 종료 코드 4(`waiter_exists`)는 다시 걸어도 같은 오류만 받는다. stderr 로 보여 준 남은 대기를 정리한 뒤 건다. 고아 대기만 남았으면 `--kill-stale` 을 더해 다시 건다
- 종료 코드 5(`WORKER_LOST`)는 처리하지 않은 끊긴 worker 다. 받은 그 자리에서 [`launch.md`](launch.md) 의 「끊긴 worker 다시 띄우기」 를 따른다. 같은 dispatch 는 다음 대기에서 다시 깨우지 않고 stderr 에 `아직 처리되지 않았다` 한 줄로 남기므로, 다시 대기를 걸기 전에 처리한다
- 종료 코드 7(상주 루프의 알림)은 `LOOP-EVENT <kind> <PR 번호 또는 -> <내용>` 줄이 하나 이상 있다. 줄마다 아래를 하고, 마지막 줄 `LAST_DELIVERY` 의 id 로 다시 건다. 줄의 내용은 알림 파일의 `text` 와 같고 `kind` 는 한 번만 나온다(예: `LOOP-EVENT WATCH-ERROR - questions: offline`)
  - `REMINDER`: 답이 없는 질문의 재알림이다. [`replying.md`](replying.md) 의 질문 처리를 따른다
  - `CI-FAILED`: 그 PR 의 체크가 실패했다. 내용 끝에 worker 에게 보냈는지가 있다. 보내지 못했거나 살아 있는 dispatch 가 없으면 그 PR 의 worker 와 CI 를 직접 확인한다
  - `CONFLICT-ORPHAN`: 충돌한 PR 을 이어 받을 worker 가 없다. 코디네이터가 충돌을 맡거나 사용자에게 알린다
  - `QUEUE-CONFLICT`: 머지 큐가 base 와 충돌한 PR 을 빼고 뒤 PR 을 이어 머지했다. 내용은 충돌 이유다. worker 에게 알리는 일은 루프의 충돌 처리가 한다. worker 가 base 를 합친 뒤 그 PR 만 다시 머지 큐에 건다
  - `AUTO-MERGE`: 루프가 PR 들을 머지 큐에 걸었다. 그 PR 을 따로 다시 걸지 않는다
  - `AUTO-MERGE-END`: 루프가 건 큐가 끝났다. 내용의 끝 줄은 머지 큐의 결과 줄(`QUEUE-DONE`, `QUEUE-HELD …`, `STOP …`)이다. `QUEUE-DONE` 이 아니면 `log=` 의 로그를 읽고 멈춘 이유를 처리한다. `끝 줄 없음` 이면 머지 큐가 시작되지 않았다(사용법 오류, 마무리를 띄우지 못함). 로그의 오류를 고친다. 같은 HEAD 는 루프가 다시 걸지 않으므로, 이유를 풀었으면 코디네이터가 직접 건다
  - `MIGRATION-CLASH`: 그 PR 의 마이그레이션 번호가 base 이하거나 다른 열린 PR 과 같다. 그 PR 의 worker 에게 번호를 다시 정하게 한다
  - `MIGRATION-BLOCKED`: 더 낮은 번호의 열린 PR 이 오래 막혀 있다. 막는 PR 의 번호를 뒤로 미룰지 정한다. 루프는 파일 이름을 바꾸지 않는다
  - `WORKER-STALLED`: 내용은 `<dispatch> <상태> <틱 수>틱 <터미널>` 이다. 그 worker 가 모델 오류(`error`)나 입력 대기(`idle`)로 멈춰 있고 `worker-stalled` 핸들러가 없거나 처리하지 못했다. `nudge-worker.ts --terminal <터미널> --state` 로 지금 화면을 확인하고, 아직 멈춰 있으면 `send-to-worker` 로 이어 가라고 보낸다. 화면이 그대로인 동안은 한 번만 온다. 이어 가게 한 worker 가 같은 오류로 다시 멈추면 화면에 오류 줄이 늘어 다시 온다
  - `WATCH-ERROR`, `HOOK-FAIL`: 루프가 무엇을 하지 못했다는 알림이다. 내용의 이유(Orca 꺼짐, 핸들러 오류)를 고친다. 같은 이유는 한 번만 오고, 한 번 성공한 뒤 다시 실패하면 다시 온다
  - `GAP`: 알림 파일이 1000 줄을 넘어 잘려 일부를 잃었다. `<orch 루트>/state/loop.log` 를 읽어 놓친 일을 찾는다
- 종료 코드 8 의 `LOOP-DEAD <repo> run <Run> 미등록` 은 루프는 살아 있는데 이 Run 이 등록되지 않았다는 뜻이다. `orch-loop.ts --start --run` 으로 등록한 뒤 다시 건다
- 종료 코드 8(`LOOP-DEAD <repo> <이유>`)은 그 저장소의 루프가 죽었다. 알림 줄이 있으면 그 줄이 먼저 오고 죽음은 다음 대기가 낸다. doctor 가 낸 명령(`orch-loop.ts --start`)으로 다시 띄운 뒤 다시 건다. 루프가 없던 동안의 일은 다음 틱이 상태로 다시 본다

**복구하거나 더 처리할 일이 없다고 확인한 dispatch 는 `--ack-lost` 로 기록한다.**
`--ack-lost` 는 기록만 쓴 뒤 종료 코드 0 으로 끝나므로 대기는 따로 건다. `--ignore-lost` 와의 차이와 실패 처리는 스크립트 머리 주석이 소유한다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/wait-important.ts" --run "$RUN_ID" --ack-lost "$DISPATCH_ID"
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/wait-important.ts" --run "$RUN_ID" --ack "$DELIVERY_ID" --kill-stale
```

## 깨어날 때마다 정리와 보드 동기화

**정리와 보드 동기화는 상주 루프의 틱이 한다.** 사용자가 정리하라고 말하지 않아도 돈다. 끝난 워크트리, 세션(터미널과 Dispatch), 브랜치를 코디네이터가 직접 지우지 않고 루프가 지운다.
머지마다 직접 정리하면 잊히고, 프로세스가 worktree 를 잡아 실패한 정리는 다시 돌아보지 않는다.
두 스크립트는 상태로만 판정하므로, 건너뛴 항목은 다음 틱에서 다시 시도된다. 따로 기억하지 않는다.

루프가 하지 않는 수동 경로는 둘이다.

- **목표 진행률은 코디네이터가 목표 항목을 고친 뒤 직접 돌린다.** 루프는 `--goal` 을 넘기지 않는다. `$GOAL_ID` 는 목표 항목 id 이고 저장소 오버레이가 정한다
- **루프가 없는 저장소는 대기가 끝날 때마다, 기다리는 동안 5분마다 아래 두 명령을 돌린다.** 5분 주기는 하네스의 예약 기능이나 다음 깨어남에 붙인다. 보드가 없는 저장소는 `board-sync.ts` 를 건너뛰고, 목표 항목이 없으면 `--goal` 을 뺀다. `--goal-items` 는 하위 호환 옵션이라 예시에 쓰지 않는다

`$BASE` 는 기준 브랜치, `$SPECS_DIR` 은 지시서 폴더다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/cleanup-sweep.ts" --repo "$REPO" --base "$BASE" --run "$RUN_ID" --specs-dir "$SPECS_DIR" --kill-holders --apply
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/board-sync.ts" --repo "$REPO" --goal "$GOAL_ID"
```

머지 큐를 걸어 둔 동안에는 `finish-*.out` 의 마지막 줄도 본다. `FINISH-FAIL` 이면 출력의 이유를 사용자에게 알린다. 읽는 법은 [`cleanup.md`](cleanup.md) 의 「머지 뒤 마무리」 가 소유한다.

**worker 를 띄운 저장소가 둘 이상이면 `--repo` 를 저장소마다 준다.** 한 번의 실행이 저장소를 차례로 돌고, 하나를 읽지 못해도 나머지는 돈다. 루프를 쓰면 저장소마다 루프를 하나씩 띄운다.
`--base` 를 주지 않으면 저장소마다 `origin/HEAD` 가 가리키는 브랜치를 쓴다. 기준 브랜치가 저장소마다 다르면 `--base` 를 빼는 편이 맞다.
`--specs-dir` 에 상대경로를 주면 저장소마다 그 저장소 기준으로 읽는다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/cleanup-sweep.ts" --repo "$REPO" --repo "$OTHER_REPO" --run "$RUN_ID" --specs-dir .orch/specs --kill-holders --apply
```

`cleanup-sweep.ts` 가 다루는 경우와 건너뛰는 조건은 그 파일 머리 주석이 소유한다. 스크립트가 다루는 경우를 코디네이터가 직접 지우지 않는다.
`건너뜀` 줄은 `<orch 루트>/state/loop.log` 에서 읽는다. 살아 있는 worker 나 커밋 안 된 변경 때문이면 그대로 두고, 같은 항목이 여러 틱째 남으면 그 worker 를 확인한다.

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
