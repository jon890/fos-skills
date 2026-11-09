# 4. 기다리기

## 상주 루프와 압축 뒤 복구

**대기가 깨어나면 메시지와 알림을 처리한 직후 다시 건다.** `orch wait` 는 stderr 의 `NEXT_WAIT` 에 방금 받은 delivery 를 `--ack` 로 넘기는 다음 명령을 낸다. 표준 출력의 마지막 줄 `LAST_DELIVERY` 계약은 유지한다.
`NEXT_WAIT` 는 `orch wait --ack <id> [기본값과 다른 인자] --loop-repo <절대경로>` 꼴이다. 코디네이터 터미널의 Run 에서 읽은 `--run` 은 빠지고, 시작 폴더와 루프 저장소가 다른 저장소면 `--lost-state <절대경로>` 가 붙는다. `orch` 가 PATH 에 없으면 앞 낱말이 진입점 절대경로다. 꼴의 원본은 `scripts/wait/wait-important.ts` 의 `nextWait` 머리 주석이다.
<!-- orch-compat -->
옛 꼴 `"$SKILL_DIR/bin/orch.ts" wait-important …` 로 기억해 둔 `NEXT_WAIT` 도 같은 대기를 걸고, 그 대기가 새 꼴 `NEXT_WAIT` 를 낸다.

- 대기 출력의 메시지 판정 줄(아래 「받은 메시지 읽기」)을 읽고 질문·보고·알림을 처리한다
- 아래 「사용자와 대화 중일 때」 로 다시 걸지 정한다
- 다시 걸면 stderr 의 `NEXT_WAIT` 명령을 하네스의 백그라운드 실행으로 건다
- 미완료 dispatch 가 있는 동안 대기가 하나 살아 있는지 확인한 뒤 턴을 끝낸다. 대화 중이라 걸지 않은 때는 예외다

오류나 `WORKER_LOST` 를 받았으면 원인을 먼저 처리하고 다음 대기를 건다. 대기를 자동으로 둘 만들거나 처리하지 않은 delivery 를 자동 ack 하지 않는다.

### 사용자와 대화 중일 때

**사용자가 대화 중이면 깨어난 대기를 처리한 뒤 다시 걸지 않는다(사용자 결정 2026-11-04).** 깨어날 때마다 처리와 재대기를 이으면 사용자의 말이 뒤로 밀린다.
대화 중은 이 코디네이터 터미널의 마지막 사용자 입력이 `ORCH_USER_ACTIVE_SEC`(기본 600초) 안인 때다. 입력 시각은 이 플러그인의 UserPromptSubmit hook 이 남긴다. 판정은 `scripts/lib/user-active.ts` 가 소유한다.
깨어난 대기를 처리한 뒤 아래 명령의 줄을 본다. `USER-ACTIVE` 면 다시 걸지 않고 사용자에게 답한다. `USER-IDLE` 이면 `NEXT_WAIT` 로 다시 건다.

```bash
orch wait user-active
```

다음 `LAST_DELIVERY` id 는 기억해 두었다가 다시 걸 때 `--ack` 로 넘긴다. 사용자의 말에 답하는 턴에는 대기를 걸지 않는다.
그동안 상주 루프는 `NO-WAIT` 알림과 `decision-pending` 전달을 미룬다. 질문과 알림은 알림 파일에 쌓인다.
사용자가 그 시간만큼 입력하지 않으면 루프가 `NO-WAIT` 를 코디네이터 터미널에 넣는다. 그때 마지막 `NEXT_WAIT` 명령으로 대기를 다시 걸면 쌓인 알림을 한 번에 받는다.
hook 을 싣지 않은 세션(Codex 코디네이터 같은)은 기록이 없어 늘 `USER-IDLE` 이다. 예전처럼 늘 다시 건다.

### 새 사용자 결정을 놓치지 않기

루프는 틱마다 `결정:` 으로 시작하는 살아 있는 worker 의 미답변 질문과 보드의 남은 `decide` 줄을 확인한다. 새 결정이면 `DECISION-PENDING` 을 그 Run 의 알림 파일에 쓰고 `decision-pending` 기본 핸들러가 현재 코디네이터에게 「정할 것 묻기」 를 요청한다. 대기가 꺼져 있어도 터미널로 요청이 들어간다. cron 은 쓰지 않는다.

같은 dispatch 의 같은 본문 재전송은 다시 깨우지 않는다. 보드의 완료된 줄과 `참고:` 줄은 제외하고, 결정이 사라졌다 다시 생기면 새로 알린다. 실패한 전달은 10분부터 두 배씩, 한 시간까지 기다렸다 다시 시도한다. 결정 묶음이 바뀌면 기다리지 않는다. 보드 결정은 주 Run 만 맡는다.
코디네이터가 사용자와 대화 중이면 전달을 미루고 대화가 끝난 뒤의 틱이 전달한다(아래 「사용자와 대화 중일 때」).
이미 사용자에게 물어 답을 기다리는 결정은 다시 묻지 않는다. 답이 오면 [`replying.md`](replying.md) 의 답장과 보드 정리를 마친다.

기본 핸들러는 `orch loop start` 할 때 등록한 코디네이터 터미널을 쓴다. 압축이나 세션 전환 뒤에는 현재 코디네이터 세션에서 `orch loop start` 를 다시 실행해 등록을 갱신한다. 등록값이 없거나 입력란에 글·권한 확인 창이 있으면 입력하지 않고 실패를 알린다. 저장소에서 전달 방법을 바꾸려면 [`hooks.md`](hooks.md) 의 `decision-pending` 핸들러를 둔다.

**저장소마다 상주 루프 `orch-loop.ts` 를 하나 띄우고, 세션은 자기 Run 을 그 루프에 등록한다.** 루프는 하네스의 백그라운드 명령이 아니라 분리된 프로세스라 시간 한도에 묶이지 않고, 세션이 끝나도 살아 있다.
같은 저장소를 쓰는 다른 세션이 이미 루프를 띄웠으면 그 루프에 자기 Run 을 더한다. 루프는 Run 마다 그 Run 범위로 질문을 확인하고 정리하며, 알림도 Run 마다 나뉜다([ADR-012](../../../docs/adr/012-orch-loop-multi-run.md)).
저장소, Run, 지시서 폴더는 작업 폴더와 코디네이터 터미널에서 읽는다(순서는 `orch-loop.ts` 머리 주석). 다른 저장소의 루프면 `--repo`, 다른 Run 이면 `--run` 을 준다.

```bash
orch loop start
orch loop status
orch loop stop
```

`orch loop start` 는 루프를 띄우면 `LOOP-STARTED` 와 0, 살아 있는 루프에 이 Run 을 더하면 `LOOP-JOINED` 와 0 으로 끝난다.
이 Run 이 이미 등록돼 있으면 `LOOP-RUNNING <pid> run=<Run id>` 와 4 다. 할 일은 없다.
**세션의 일이 끝나면 `orch loop stop` 으로 자기 Run 만 뺀다.** Run 은 코디네이터 터미널에서 읽는다. 다른 Run 이 남으면 루프는 그대로 돌고(`LOOP-LEFT`), 마지막 Run 이 빠지면 루프가 끝난다.
Run 을 읽지 못하고 `finish.run` 도 없으면 Run 이 하나라도 등록돼 있을 때 `LOOP-STOP-SHARED` 와 1 로 멈추지 않는다. 다른 세션의 루프를 끊지 않는다. 모두 멈추라는 사용자 지시가 있을 때만 `orch loop stop --all` 을 쓴다.
**`orch loop stop` 이 1 로 끝나면(`LOOP-STOP-UNKNOWN`, `LOOP-STOP-TIMEOUT`) 그 pid 가 루프인지 `ps -o command= -p <pid>` 로 직접 확인한다.** 루프면 끝낸 뒤 다시 `orch loop start` 한다. 다른 프로세스면 끝내지 않는다.

**5(`LOOP-START-FENCED <Run> <묶인 Run>`)면 띄우지도 합류하지도 않았다.** Orca 는 호출자를 그 프로세스가 나온 터미널로 정하고, 루프는 띄운 터미널의 명의를 물려받는다.
부른 터미널이 다른 Run 에 묶였거나, 도는 루프가 다른 Run 에 묶였거나 명의를 알 수 없는 옛 루프(`unknown`)라 이 Run 의 질문을 읽지 못한다는 뜻이다.
**`orch loop start` 는 그 Run 의 코디네이터 세션(그 Run 에 묶인 터미널)에서 부른다.** 다른 세션의 루프를 `orch loop stop` 한 뒤 내 터미널에서 다시 띄우지 않는다. 새 루프가 내 Run 명의를 물려받아 원래 Run 의 질문을 읽지 못한다.
도는 루프가 다른 Run 에 묶였으면 그 루프가 끝날 때까지 아래 Monitor 대안을 쓴다.

**4 와 함께 `LOOP-LEGACY <pid> run=<Run>` 줄이 오면 그 루프는 Run 등록을 모르는 옛 orch 로 띄운 루프다.** `--full` 이면 이 줄 대신 `안내:` 줄이다. 다른 세션의 루프이므로 멈추지 않는다. 그 루프를 띄운 세션이나 사용자에게 다시 띄워 달라고 알리고, 그동안은 아래 Monitor 대안을 쓴다.

루프는 `pipeline.tick_sec`(기본 300초)마다 질문 확인, Run 별 정리와 보드 동기화, 내 열린 PR 의 CI 감시와 자동 머지, worker 화면·움직임 확인, 충돌한 PR 알리기, `tick` 이벤트를 차례로 한다. 판정과 순서, 알림 조건은 `orch-loop.ts` 머리 주석이 소유하고, 코디네이터가 할 일은 아래 종료 코드 7 의 `LOOP-EVENT` 목록이 갖는다.
새 질문은 `wait-important` 가 question 메시지로 이미 깨어나므로 알림 파일에 쓰지 않는다. 사용자 결정 질문의 재알림은 루프 로그에만 남고, 새 결정과 보드의 남은 결정 줄은 `DECISION-PENDING` 이 맡는다. 루프는 입력하지 않는다. 멈춘 worker 를 다시 시도시키는 일은 저장소의 핸들러가 맡는다([`hooks.md`](hooks.md) 의 「멈춘 worker 다시 시도시키기」).

CI 판정은 머지 큐의 기본 판정과 같다. 필수 체크가 아닌 체크의 실패도 `failed` 로 본다. 루프는 `--allow-fail` 을 모르므로, 그 옵션을 주고 머지 큐를 거는 저장소에서는 루프가 실패로 알린 PR 도 큐가 머지할 수 있다.
알림은 Run 마다 `<orch 루트>/state/loop-events/<Run>.jsonl` 에 쌓이고, 아래 대기가 `--run` 과 `--loop-repo` 로 자기 Run 의 것만 읽는다. 주인을 모르는 알림(공유 일의 실패, 보드 결정)은 가장 먼저 등록한 Run 에 간다. 루프의 출력은 `state/loop.log` 에 남는다.
조회 실패는 이유가 바뀔 때만 알림 파일에 쓰므로 틱마다 코디네이터를 깨우지 않는다.

**Monitor 로 `orch wait questions` 를 띄우는 것은 루프를 쓸 수 없을 때의 대안이다.** 질문과 재알림을 한 줄씩 받는다. `--run`, `--repo` 는 주지 않으면 작업 폴더와 코디네이터 터미널에서 읽는다. 이때는 아래 「깨어날 때마다 정리와 보드 동기화」 의 수동 명령도 돌려야 한다.

**압축이나 세션 재시작 뒤 첫 작업은 루프와 대기 복구다.** doctor 에 `--run` 을 주면(저장소는 작업 폴더에서 읽는다) 루프가 죽었을 때 `LOOP-DEAD <repo> <이유>` 줄과 다시 띄울 명령을 낸다. 꺼진 루프는 그 명령으로 다시 띄운다.
완료 대기는 이 문서의 「이전 세션의 대기」 절차로 복구한다. 이미 켜진 루프와 대기는 두 번째로 띄우지 않는다.

```bash
ps -eo pid,command | grep -E "orch-loop|wait-important|orchestration check" | grep -v grep
orch doctor --run "$RUN_ID"
```

**doctor 의 `LOOP-STALE <repo> <pid> <번들 해시나 버전>` 은 지금 세션 프로필의 user 범위 설치본이 아닌 번들로 도는 루프다.** 플러그인을 갱신했거나 계정을 바꾼 뒤에 생긴다. 이미 고친 결함이 그 루프에서 계속 난다. 다음 줄의 명령은 그 루프의 Run 코디네이터 세션에서 돌린다. 내 Run 의 루프가 아니면 그 세션이나 사용자에게 알린다. 내 터미널에서 다시 띄우면 새 루프가 내 Run 명의를 물려받는다(위 `LOOP-START-FENCED`).

doctor 의 `UNANSWERED` 는 10분 이상 답이 없는 질문이다. 끝난 dispatch 는 같은 Task 의 PR 종료 근거가 있으면 루프와 doctor 모두 질문에서 제외한다. `SKIP-QUESTIONS` 는 조회하지 못했다는 뜻이므로 질문이 없다는 근거로 쓰지 않는다.
doctor 의 `WORKER-STATE <dispatch> <상태> <근거>` 는 살아 있는 dispatch 인데 터미널이 `user_owned` 로 표시된 worker 의 판정이다(`scripts/lib/worker-state.ts`).
`working` 이면 화면이 작업 중이라 Orca 의 표시만 틀린 것이고 그대로 둔다. `taken_over` 면 사용자가 넘겨받은 worker 라 지시를 보내지 않고 사용자에게 알린다.
`--run` 을 주면 저장소의 `session-resume` 핸들러에 루프 생존과 살아 있는 대기 pid, 미답변 질문 id 를 넘긴다([`hooks.md`](hooks.md)).
알림을 받으면 [`replying.md`](replying.md) 의 분류 기준으로 처리한다. 루프는 delivery 를 소비하거나 ack 하지 않으므로 아래 완료 대기와 함께 쓴다.

**`wait-important` 는 시작하면 작업 폴더를 `--loop-repo` 의 첫 저장소(없으면 시작 폴더의 주 checkout)로 옮긴다.** 머지 뒤 워크트리 정리로 셸의 작업 폴더가 지워져도 worker 조회가 실패하지 않는다. 시작할 때 이미 지워져 있어도 돈다. 그래서 대기는 지워지지 않는 저장소 폴더에서 걸고 `--loop-repo` 를 준다.

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
orch wait --ack "$DELIVERY_ID"
```

저장소가 둘 이상이면 `--loop-repo` 를 저장소마다 준다. 루프가 없는 저장소는 주지 않는다.
종료 코드와 `TIMEOUT` 줄은 스크립트 머리 주석이 소유한다. 아래는 코디네이터가 할 일이다.

- 종료 코드 6(`DONE-SUSPECT` 줄, 근거 없는 worker_done)은 자동 ack 하지 않는다. [`verification.md`](verification.md) 의 「완료 전에 온 worker_done」 을 먼저 따른다
- PR 이 없는 읽기 전용 작업은 대기와 분류 양쪽에 `--completion-contract none` 을 준다
- `TIMEOUT LAST_DELIVERY <id>` 는 실패가 아니다. 그 id 로 다시 건다
- orca 오류로 끝나면 아래 「대기가 바로 끝나거나 남음」 을 따른다
- 종료 코드 4(`waiter_exists`)는 다시 걸어도 같은 오류만 받는다. stderr 로 보여 준 남은 대기를 정리한 뒤 건다. 고아 대기만 남았으면 `--kill-stale` 을 더해 다시 건다
- 종료 코드 5(`WORKER_LOST`)는 처리하지 않은 끊긴 worker 다. 받은 그 자리에서 [`launch.md`](launch.md) 의 「끊긴 worker 다시 띄우기」 를 따른다. 같은 dispatch 는 다음 대기에서 다시 깨우지 않으므로, 다시 대기를 걸기 전에 처리한다. 화면이 작업 중이면 끊긴 것으로 보지 않는 판정과 stderr 줄은 `wait-important.ts` 머리 주석이 소유한다
- 종료 코드 7(상주 루프의 알림)은 `LOOP-EVENT <kind> <PR 번호 또는 -> <내용>` 줄이 하나 이상 있다. 줄마다 아래를 하고, 마지막 줄 `LAST_DELIVERY` 의 id 로 다시 건다. 줄의 내용은 알림 파일의 `text` 와 같고 `kind` 는 한 번만 나온다(예: `LOOP-EVENT WATCH-ERROR - questions: offline`)
  - `DECISION-PENDING`: 새 사용자 결정이다. 기본 핸들러의 요청을 받았으면 같은 결정을 중복해서 묻지 않는다. [`replying.md`](replying.md) 의 질문 처리를 따른다
  - `REMINDER`: 답이 없는 기술 질문이나 일반 escalation의 재알림이다. [`replying.md`](replying.md) 의 질문 처리를 따른다. 사용자 결정의 재알림은 이 이벤트로 오지 않는다
  - `CI-FAILED`: 그 PR 의 체크가 실패했다. 내용 끝에 worker 에게 보냈는지가 있다. `<base> 도 실패` 면 같은 워크플로의 base 최신 완료된 push 실행도 실패해 보내지 않았다. 코디네이터가 공통 원인을 별도 작업으로 처리한다. 보내지 못했거나 살아 있는 dispatch 가 없으면 그 PR 의 worker 와 CI 를 직접 확인한다. 끝이 `취소만 있음` 이면 실패한 체크가 모두 취소다. worker 에게 보내지 않았다. 일부러 취소한 CI 면 아무것도 하지 않고, 아니면 코디네이터가 CI 를 다시 돌린다
  - `CONFLICT-ORPHAN`: 충돌한 PR 을 이어 받을 worker 가 없다. 코디네이터가 충돌을 맡거나 사용자에게 알린다
  - `QUEUE-CONFLICT`: 머지 큐가 base 와 충돌한 PR 을 빼고 뒤 PR 을 이어 머지했다. 내용은 충돌 이유다. worker 에게 알리는 일은 루프의 충돌 처리가 한다. worker 가 base 를 합친 뒤 그 PR 만 다시 머지 큐에 건다
  - `AUTO-MERGE`: 루프가 PR 들을 머지 큐에 걸었다. 그 PR 을 따로 다시 걸지 않는다
  - `AUTO-MERGE-NO-REVIEW`: 판정 문구가 든 리뷰가 없어 자동 머지에 걸지 않았다. text 가 `HEAD <SHA> 에` 로 시작하면 `verdict-on-head` 조건이라 지금 HEAD 에 판정이 없고, `HEAD <SHA> 의 PR 에` 로 시작하면 괄호 안의 조건이 PR 전체에서 판정을 찾지 못했다. 리뷰 봇이 결과 없이 실패했거나 아직 돌지 않았다. 리뷰 봇을 다시 돌리거나 독립 리뷰를 받아, 그 결과를 `queue.auto_review.pass` 문구가 든 리뷰나 댓글로 남긴다(`verdict-on-head` 면 이 HEAD 에). 다음 틱이 건다. PR 본문에 `머지 보류` 줄을 넣어 막을 필요가 없다. 같은 HEAD 는 한 번만 온다
  - `AUTO-MERGE-END`: 루프가 건 큐가 끝났다. 내용의 끝 줄은 머지 큐의 결과 줄(`QUEUE-DONE`, `QUEUE-HELD …`, `STOP …`)이다. `QUEUE-DONE` 이 아니면 `log=` 의 로그를 읽고 멈춘 이유를 처리한다. `끝 줄 없음` 이면 머지 큐가 시작 전에 끝났거나(사용법 오류, 마무리를 띄우지 못함) 도중에 신호를 받아 끝났다. 로그로 어디까지 머지했는지 확인하고 오류를 고친다. 같은 HEAD 는 루프가 다시 걸지 않으므로, 이유를 풀었으면 코디네이터가 직접 건다
  - `MIGRATION-CLASH`: 그 PR 의 마이그레이션 번호가 base 이하거나 다른 열린 PR 이나 다른 브랜치의 예약과 같다. 그 PR 의 worker 에게 `orch queue reserve` 를 다시 불러 파일 이름을 바꾸게 한다. 줄 끝이 `renewed` 면 그 경로로 바꾼다
  - `MIGRATION-BLOCKED`: 더 낮은 번호가 오래 막혀 있다. 막는 쪽은 열린 PR 이거나 PR 없는 예약이다. 막는 쪽 worker 에게 `orch queue reserve --again` 으로 번호를 다시 받아 파일 이름을 바꾸게 한다. 루프는 파일 이름을 바꾸지 않는다
    막는 쪽 브랜치를 버렸으면 그 브랜치를 지운 뒤 `orch queue reserve prune --repo <저장소>` 를 부른다. 다음 틱에 막힘이 풀린다
    알림은 한 번만 오므로 기다리는 PR 은 그 뒤 알림 없이 기다린다
  - `WORKER-LIMITED`: 사용 한도로 멈춘 dispatch 와 터미널이다. 터미널 worker 면 사용자에게 계정 전환을 요청하고, 바꾼 뒤 알림의 `orch worker resume --dispatch <id>` 를 부른다. 바꿀 계정이 없거나 resume 이 실패하면, 그리고 구조화 worker 면 [`agent-selection.md`](agent-selection.md) 의 「사용 한도에 걸렸을 때」를 따른다. 같은 dispatch 는 한 번만 알리며 자동 재시도하지 않는다
  - `WORKER-STALLED`: 내용은 `<dispatch> <상태> <틱 수>틱 <터미널>` 이다. 그 worker 가 모델 오류(`error`)나 입력 대기(`idle`)로 멈춰 있고 `worker-stalled` 핸들러가 없거나 처리하지 못했다. `orch worker screen <터미널>` 로 지금 화면을 확인하고, 아직 멈춰 있으면 `send-to-worker` 로 이어 가라고 보낸다. 화면이 그대로인 동안은 한 번만 온다. 이어 가게 한 worker 가 같은 오류로 다시 멈추면 화면에 오류 줄이 늘어 다시 온다
  - `WORKER-IDLE`: 내용은 `<dispatch> <idle 또는 exited> <분>분 <워크트리> <터미널>` 이다. 그 worker 가 그 분 동안 파일, 커밋, 화면 어느 것도 바꾸지 않았거나(`idle`) 프로세스가 끝났는데 dispatch 가 열려 있다(`exited`). 미답변 질문을 보낸 worker 와 CI 를 통과해 머지를 기다리는 worker 는 오지 않는다. `idle` 이면 `orch worker screen <터미널>` 로 화면을 보고 `send-to-worker` 로 진행을 묻는다. `exited` 면 [`launch.md`](launch.md) 의 「끊긴 worker 다시 띄우기」 를 따른다. 같은 멈춤은 한 번만 오고, 그 뒤에 움직였다 다시 멈추면 다시 온다
  - `STAGE-STALLED`: 내용은 `<보드 항목 id> <worktree 또는 branch> <분>분 <끝나지 않은 첫 단계>` 이다. 보드의 `doing` 항목에 남은 단계가 있는데 그 항목의 worker 가 없이 그 분이 지났다. 평가 결과를 기다리던 단계처럼 코디네이터가 다음 worker 를 띄우거나 직접 처리할 차례다. 기다리는 것이 맞으면 그 항목을 `wait` 로 바꾼다. 같은 단계는 한 번만 온다
  - `HEAVY-SLOT-HELD`: 내용은 `pid <pid> <분>분 <명령줄>` 목록과 상한이다. 그 검사가 무거운 검사 자리를 상한보다 오래 쥐어 다른 worker 의 검사가 기다린다. 명령줄과 그 pid 의 worktree 로 어느 worker 의 검사인지 찾고, 그 worker 에게 끝났는지 묻거나 사용자에게 끊을지 묻는다. 루프는 끊지 않는다. 같은 검사가 쥐고 있는 동안은 한 번만 온다
  - `FINISH-MISSING`: 루프의 정리가 머지된 PR 의 워크트리를 치웠는데 그 PR 에 머지 뒤 마무리(`finish-pr`)가 돈 적이 없다. `gh pr merge` 로 바로 머지한 PR 이다. 내용 끝의 `finish-pr` 명령으로 마무리를 돌려 배포 확인, 업무 완료, 보드 done 을 채운다. 같은 PR 은 한 번만 온다
  - `NO-WAIT`: 살아 있는 dispatch 가 있는데 이 Run 의 `wait-important` 대기가 몇 분째 없었다. 루프가 같은 글을 코디네이터 터미널에도 넣는다. 받은 메시지를 처리한 뒤 마지막 `NEXT_WAIT` 명령으로 대기를 다시 건다. 사용자와 대화 중인 동안에는 루프가 이 알림을 미룬다
  - `WATCH-ERROR`, `HOOK-FAIL`: 루프가 무엇을 하지 못했다는 알림이다. 내용의 이유(Orca 꺼짐, 핸들러 오류)를 고친다. 같은 이유는 한 번만 오고, 한 번 성공한 뒤 다시 실패하면 다시 온다. 내용이 `auto-merge: 마이그레이션 예약 <n> 개의 형식이 틀렸다` 로 시작하면 `orch queue reserve prune --repo <저장소>` 로 그 항목을 뺀다. 내용이 `refresh: pipeline.refresh_slots 를 켰지만` 으로 시작하면 머지 큐가 최신화하지 않는 저장소라 최신화도 돌지 않는다. 오버레이가 정한 대로 `queue.require_up_to_date` 를 켜거나 `refresh_slots` 를 0 으로 둔다
  - `GAP`: 알림 파일이 1000 줄을 넘어 잘려 일부를 잃었다. `<orch 루트>/state/loop.log` 를 읽어 놓친 일을 찾는다
- 종료 코드 8 의 `LOOP-DEAD <repo> run <Run> 미등록` 은 루프는 살아 있는데 이 Run 이 등록되지 않았다는 뜻이다. `orch loop start` 로 등록한 뒤 다시 건다
- 종료 코드 8(`LOOP-DEAD <repo> <이유>`)은 그 저장소의 루프가 죽었다. 알림 줄이 있으면 그 줄이 먼저 오고 죽음은 다음 대기가 낸다. doctor 가 낸 명령(`orch loop start …`)으로 다시 띄운 뒤 다시 건다. 루프가 없던 동안의 일은 다음 틱이 상태로 다시 본다

**복구하거나 더 처리할 일이 없다고 확인한 dispatch 는 `--ack-lost` 로 기록한다.**
`--ack-lost` 는 기록만 쓴 뒤 종료 코드 0 으로 끝나므로 대기는 따로 건다. `--ignore-lost` 와의 차이와 실패 처리는 스크립트 머리 주석이 소유한다.

```bash
orch wait ack-lost "$DISPATCH_ID"
orch wait --ack "$DELIVERY_ID" --kill-stale
```

## 깨어날 때마다 정리와 보드 동기화

**정리와 보드 동기화는 상주 루프의 틱이 한다.** 사용자가 정리하라고 말하지 않아도 돈다. 끝난 워크트리, 세션(터미널과 Dispatch), 브랜치를 코디네이터가 직접 지우지 않고 루프가 지운다.
건너뛴 항목은 다음 틱이 상태로 다시 판정하므로 따로 기억하지 않는다.

루프가 하지 않는 수동 경로:

- **목표 진행률은 코디네이터가 목표 항목을 고친 뒤 직접 돌린다.** 루프는 `--goal` 을 넘기지 않는다. `$GOAL_ID` 는 목표 항목 id 이고 저장소 오버레이가 정한다
- **루프가 없는 저장소는 대기가 끝날 때마다, 기다리는 동안 5분마다 아래 명령을 돌린다.** 보드가 없는 저장소는 `board sync` 를 건너뛰고, 목표 항목이 없으면 `--goal` 을 뺀다

`$BASE` 는 기준 브랜치다.

```bash
orch cleanup sweep --base "$BASE" --kill-holders --apply
orch board sync --goal "$GOAL_ID"
```

멈춘 worker 와 멈춘 단계도 같은 주기에 `stalled-workers` 로 본다. 루프가 있는 저장소에서도 지금 상태를 직접 볼 때 쓴다.
종료 코드 3 이면 `STALLED` 와 `STAGE` 줄을 위 `WORKER-IDLE`, `STAGE-STALLED` 처럼 처리한다. 출력 형식과 종료 코드는 스크립트 머리 주석이 소유한다.

```bash
orch loop stalled --run "$RUN_ID"
```

머지 큐를 걸어 둔 동안에는 `finish-*.out` 의 마지막 줄도 본다. `FINISH-FAIL` 이면 출력의 이유를 사용자에게 알린다. 읽는 법은 [`cleanup.md`](cleanup.md) 의 「머지 뒤 마무리」 가 소유한다.

**worker 를 띄운 저장소가 둘 이상이면 `--repo` 를 저장소마다 준다.** 한 번의 실행이 저장소를 차례로 돌고, 하나를 읽지 못해도 나머지는 돈다. 루프를 쓰면 저장소마다 루프를 하나씩 띄운다.
`--base` 를 주지 않으면 저장소마다 `origin/HEAD` 가 가리키는 브랜치를 쓴다. 기준 브랜치가 저장소마다 다르면 `--base` 를 빼는 편이 맞다.
`--specs-dir` 에 상대경로를 주면 저장소마다 그 저장소 기준으로 읽는다.

```bash
orch cleanup sweep --repo "$REPO" --repo "$OTHER_REPO" --specs-dir .orch/specs --kill-holders --apply
```

`cleanup-sweep.ts` 가 다루는 경우와 건너뛰는 조건은 그 파일 머리 주석이 소유한다. 스크립트가 다루는 경우를 코디네이터가 직접 지우지 않는다.
`건너뜀` 줄은 `<orch 루트>/state/loop.log` 에서 읽는다. 살아 있는 worker 나 커밋 안 된 변경 때문이면 그대로 두고, 같은 항목이 여러 틱째 남으면 그 worker 를 확인한다.
살아 있는 worker 로 건너뛴 줄에는 `근거:` 뒤에 판정 이유가 붙는다. `user_takeover 표시지만 화면이 작업 중이다` 는 Orca 의 표시만 틀린 정상 worker 다.

## 받은 메시지 읽기

**`orch wait` 의 출력이 분류까지 한다.** 받은 메시지마다 판정 줄 하나가 우선 차례로 오고, heartbeat 는 개수만 온다. `orch wait triage` 를 따로 부르지 않는다.
한 delivery 에 heartbeat 가 수십 건 섞여도 `worker_done` 하나를 놓치지 않게 하려는 것이다. 전체 줄 꼴과 차례는 `scripts/wait/triage-messages.ts` 머리 주석의 「짧은 출력」 이 소유한다.

```text
DONE-SUSPECT <dispatch> <task> <본문 앞 120자>   근거 없는 worker_done. 종료 코드 6
DONE <dispatch> <task> <본문 앞 120자>
… 그 밖의 종류와 HEARTBEAT, QUIET-STOP 개수 줄은 `scripts/wait/triage-messages.ts` 머리 주석이 소유한다
RAW <원문 파일>
LAST_DELIVERY <id>
```

**본문 전체가 필요하면 `RAW` 줄의 파일을 읽는다.** 원문은 `<orch 루트>/state/wait/<delivery>.json` 이고 다음 대기가 그 delivery 를 ack 하면 지워진다.
`$RAW` 는 `RAW` 줄의 경로다. `--full` 을 빼면 같은 판정 줄이 나온다.

```bash
orch wait triage --full "$RAW"
```

<!-- orch-compat -->
`--full` 로 건 대기와 옛 번들의 대기는 지금처럼 한 줄 JSON 을 낸다. 그 출력 파일도 `orch wait triage --full "$OUT"` 로 읽는다.

**놓친 보고가 의심되면 지난 시각부터 다시 본다.** compact 나 세션 재시작 뒤, ack 를 먼저 하고 읽지 못한 경우가 여기 해당한다.
`--live` 는 읽음 표시를 하지 않으므로 도는 대기의 delivery 를 건드리지 않는다.

```bash
orch wait triage --live --since 3h
```

## 대기가 바로 끝나거나 남음

백그라운드 대기가 종료 코드 144 로 끝난 것처럼 보여도 Orca CLI 프로세스가 살아 있을 수 있다.
그 프로세스가 대기 자리를 쥐고 있으면 새로 건 대기가 `waiter_exists` 로 바로 끝난다.
위 `ps` 명령으로 찾아서 종료한 뒤 다시 건다. 이 세션이 건 프로세스이므로 다른 run 의 것과 구분해서 종료한다.

Orca runtime 이 잠시 끊기면 `runtime_unavailable` 로 끝나기도 한다. `orca status` 로 살아 있는지 확인한 뒤 다시 건다.

### 이전 세션의 대기

세션을 다시 띄운 뒤 첫 대기가 `waiter_exists` 면 이전 세션의 백그라운드 대기가 부모 없이 남은 것이다. 그 대기가 받은 메시지는 아무에게도 전달되지 않는다.

```bash
ps -ax -o pid,ppid,lstart,command | grep -E "orchestration check|wait-important" | grep "$RUN_ID"
```

고아 판정과 `--kill-stale` 이 종료하는 범위는 `wait-important` 머리 주석이 소유한다. 다른 run 의 대기는 다른 세션의 것이므로 직접 건드리지 않는다. 종료 뒤 대기를 다시 걸고, 그 대기가 이미 받아 간 메시지는 `orch wait triage --live --since` 로 다시 본다.

## 턴만 끝낸 멈춤 보고

worker 가 `worker_done` 없이 턴을 끝내면 Orca 가 그 worker 이름으로 escalation 을 보낸다. 제목이 `Worker stopped without reporting` 인 것(턴만 끝냄)은 **대기와 요약이 기본으로 뺀다.** 오류로 멈춤, 입력 대기, 프로세스 끝남 보고는 실제로 멈춘 worker 라 그대로 깨어난다. 턴만 끝낸 보고도 보려면 두 스크립트에 `--stop-reports` 를 준다. 가리는 규칙은 `lib/stop-reports.ts` 머리 주석이 소유한다.

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

먼저 [`agent-selection.md`](agent-selection.md) 「사용 한도에 걸렸을 때」 의 1번 차례대로 사용자에게 계정 전환을 요청하고, 바꾼 뒤 `orch worker resume --dispatch "$DISPATCH_ID"` 로 같은 세션을 잇는다([`launch.md`](launch.md) 「한도나 재부팅으로 멈춘 worker 이어 가기」).

#### resume 이 안 될 때

`RESUME-FAIL` 이 나면 먼저 출력의 `NEXT` 를 따른다. 바꿀 계정이 없거나 `NEXT` 로도 이어 가지 못하면 다른 제공자로 새로 띄운다.
resume 이 옛 dispatch 를 이미 정리했으면(출력의 `RESUME-TARGET` 이 `limited`) 아래 `worker-abandon` 을 건너뛰고, [`launch.md`](launch.md) 「끊긴 worker 다시 띄우기」 표의 Task 상태에 맞는 줄을 따른다. `RESUME-FAIL link` 뒤라면 새 worker 를 띄우지 않는다. 남은 터미널에 resume 한 에이전트가 붙어 있다.
`worker-stop` 은 터미널이 `user_owned` 이면 `stop_unknown` 으로 끝난다. `worker-abandon` 으로 dispatch 를 닫은 뒤 다른 제공자로 다시 띄운다. 워크트리는 그대로 이어 쓴다.
`$AGENT`, `$MODEL`, `$EFFORT` 는 다시 고른 값이다. 지시서의 `worker 선택:` 줄을 먼저 고치고 같은 Task 를 다시 띄운다.

```bash
orca orchestration worker-abandon --dispatch "$DISPATCH_ID" --json
orch worker launch --spec "$SPEC" --repo "$REPO" --task "$TASK_ID" --retry-of "$DISPATCH_ID" -- --agent "$AGENT" --model "$MODEL" --effort "$EFFORT"
```

## 기다리는 동안 worker 워크트리를 고치지 않는다

worker 가 `git add -A` 를 하면 내 변경이 그쪽 커밋에 섞인다. 문서를 쓰려면 별도 워크트리를 만든다.
이미 고쳤으면 아래 순서로 되돌린다.

1. 고친 내용을 저장소 밖으로 복사한다
2. `git checkout -- "$FILE"` 로 되돌린다
3. worker 의 브랜치를 머지한 다음 기준 브랜치에서 다시 적용한다
