# orch 구조 정리: Orca 깨움으로 바꾸기, 두 층 나누기, 큰 스크립트 쪼개기 기술 설계

스펙: [spec.md](spec.md)

## 요구사항 연결

| ID | 해결 방법 | PR |
| --- | --- | --- |
| REQ1 | `orch wait` 대기를 없앤다. worker 의 질문과 보고는 Orca 가 코디네이터를 직접 깨운다. 루프 알림도 Orca 메시지로 보내 같은 길로 깨운다(아래 「루프 알림 보내기」) | PR3 |
| REQ2 | 메일을 읽음 처리하는 유일한 곳인 `wait/wait-important.ts` 를 없앤다. `tests/check-peek.spec.ts`(신규)가 스크립트의 `check` 호출마다 `--peek` 이나 `--all` 이 붙었는지 본다 | PR3 |
| REQ3 | `lib/loop.ts` 의 알림 쓰기(`appendEvent`)를 `lib/run-notice.ts`(신규)의 `notifyRun` 으로 바꾼다. 같은 이유와 같은 HEAD 를 다시 보내지 않는 지금 규칙은 알림을 부르는 쪽에 그대로 있다(DECISION16) | PR3 |
| REQ4 | `lib/user-active.ts`, `hooks/record-user-input.ts`, `wait/user-active.ts` 와 hooks.json 의 그 항목, `lib/decisions.ts` 의 미루기, 루프의 `NO-WAIT-DEFER` 를 지운다 | PR3 |
| REQ5 | 루프에 「완료 보고 확인」 단계를 더한다. 판정은 `lib/completion.ts` 를 그대로 부른다. 의심스러운 보고는 dispatch 마다 한 번 Run 에 알린다. 띄울 때 `--no-pr` 로 기록한 dispatch 는 알리지 않는다 | PR3 |
| REQ6 | `send-to-worker` 가 깨우기(`nudge-worker`)를 부르지 않는다. 끝난 dispatch 에도 `--spec` 을 받아 `orca orchestration send` 로 후속 일을 보낸다. 다시 띄우기는 터미널이 없거나 send 가 거절될 때만 쓴다. 코디네이터 터미널 입력(결정 알림, NO-WAIT)은 PR3 에서 없앤다 | PR2, PR3 |
| REQ7 | `worker-ask` 가 `orca orchestration ask` 를 한 번 부르고 질문 id 를 낸 뒤 0 으로 끝난다. 공통 지시서 틀과 스킬 문서에서 기다림 설명을 지운다 | PR1 |
| REQ8 | 명령 표(`lib/commands.ts`)에 `retired` 칸을 더하고 진입점이 한 줄 안내와 종료 코드 2 를 낸다. 옛 스크립트 파일은 같은 안내만 내는 껍데기로 남긴다(아래 「옛 명령 안내」) | PR1, PR3 |
| REQ9 | `state/loop-events/`, `state/loop-events.jsonl`, `state/wait/` 를 쓰고 읽는 코드를 지운다. 정리 단계가 남은 파일을 휴지통으로 옮기고, 읽지 않은 루프 알림은 옮기기 전에 Run 에 한 번 보낸다 | PR3 |
| REQ10 | 결과를 정하는 코드를 `skills/orch/scripts/core/` 로 모은다. `tests/core-boundary.spec.ts` 가 import 와 금지 낱말을 본다(아래 「두 층 경계」) | PR4 |
| REQ11 | 겹치는 여섯 가지를 한 곳으로 합친다(아래 「겹치는 코드」) | PR4 |
| REQ12 | 세 스크립트를 `loop/steps/`, `queue/steps/`, `cleanup/steps/` 의 단계 파일로 나눈다. 본 파일은 단계를 차례로 부르고 결과를 모으기만 한다 | PR5, PR6, PR7 |
| REQ13 | PR4 첫 커밋이 고정 입력 출력 기록(`tests/golden/`)을 지금 코드로 만든다. PR4-PR7 은 기록 파일과 기존 테스트 기대값을 바꾸지 않는다(아래 「동작 같음 확인」) | PR4-PR7 |
| REQ14 | `wait-important` 의 끊긴 worker 찾기, worker-done 이벤트, 보드 pr 칸 채우기를 루프 단계로 옮긴다. 루프가 죽은 것은 이미 `orch status` 와 doctor 의 `LOOP-DEAD` 가 알린다. 다음 루프가 시작할 때 앞 루프가 멈춘 시간을 Run 에 알린다 | PR3 |
| REQ15 | 루프의 「대기 확인」 단계를 「미답변 질문 확인」 으로 바꾼다. 재알림 기준(600초)을 넘긴 질문 id 묶음이 바뀔 때만 Run 에 알린다 | PR3 |
| REQ16 | `handlers/decision-pending.ts` 가 터미널 입력 대신 `notifyRun` 으로 보낸다. 이벤트와 재시도 규칙(`lib/decisions.ts`)은 그대로다 | PR3 |
| REQ17 | `references/hooks.md` 예시를 `orch worker send` 로 바꾼다. doctor 가 `.orch/hooks/` 의 파일에서 `worker nudge`, `nudge-worker` 를 찾으면 `NUDGE-HANDLER <파일>` 을 낸다 | PR3 |
| REQ18 | 후속 일은 `허락:` 줄 검사를 거친 지시서로 보내고, 받은 새 dispatch 와 Task 를 `state/launch-history.jsonl` 에 남긴다 | PR2 |
| REQ19 | `references/waiting.md` 를 Orca 깨움 기준으로 다시 쓰고 「사용자 답을 먼저」 규칙을 둔다 | PR3 |

## 설계 단계 실측

스펙이 설계 단계로 넘긴 네 가지다. Orca 1.4.254 기준이다.

| 항목 | 잰 방법 | 결과 | 설계에 반영한 것 |
| --- | --- | --- | --- |
| 루프 메시지로 코디네이터가 깨는가(DECISION1) | 코디네이터가 실측용 세션에서 쟀다 | (실측 대기) | 「루프 알림 보내기」 의 보내는 꼴 |
| 자동 해제가 지난 worker 에게 send(DECISION4) | 코디네이터가 실측용 세션에서 쟀다 | (실측 대기) | 「후속 일 보내기」 의 다시 띄우기 조건 |
| 오류로 멈춘 worker 를 send 가 깨우는가(REQ17) | 코디네이터가 실측용 세션에서 쟀다 | (실측 대기) | hooks.md 예시 |
| 결정 알림 기록·움직임 기록을 Orca 기능으로 대신할 수 있는가(DECISION7) | `orca orchestration gate-create --help`, `worker-list --help`, `orca skills get orchestration --full` 과 `lib/decisions.ts`, `lib/movement.ts` 를 읽었다 | 대신할 수 없다. 아래 두 줄 | 두 파일을 그대로 둔다. 스펙이 「같은 정보를 주면 다시 묻는다」 고 했으므로 다시 묻지 않는다 |

- **결정 알림 기록(`state/decision-pending/<Run>.json`)**: 이미 알린 결정 묶음과 실패 뒤 다시 낼 시각(10분부터 두 배씩)을 적는다. Orca 결정 게이트는 Task 하나를 막는 질문과 선택지를 둘 뿐이다. 보드의 decide 항목은 Orca Task 가 아니어서 게이트로 만들 수 없고, 게이트에는 「언제 알렸는지」 와 「다시 낼 시각」 이 없다.
- **움직임 기록(`state/movement.json`)**: 워크트리 파일 수정 시각, 마지막 커밋 시각, 화면이 바뀐 시각과 이미 알린 멈춤을 적는다. Orca 의 생존 판정(`projection.liveness.verdict`)은 프로세스가 살아 있는지(live, exited, unverifiable)만 알린다. 살아 있지만 30분 동안 아무것도 바꾸지 않은 worker 는 Orca 에게 live 다.

## 책임과 경계

```text
진입 스크립트(loop/orch-loop.ts, queue/merge_queue.ts, cleanup/cleanup-sweep.ts, worker/*.ts …)
  ├─ 단계 파일(loop/steps/*.ts …, PR5-PR7)   바깥을 읽고 core 를 부르고 결과대로 쓴다
  │    └─ lib/*.ts                        바깥 호출층: orca·gh·git·파일·프로세스·환경 변수
  └─ core/*.ts (PR4)                       결과를 정하는 층: 값을 받아 값을 낸다
```

- **바깥 호출층 `lib/`**: 바깥 프로그램 호출(orca, gh, git, ps), 파일 읽기와 쓰기, 환경 변수와 시계 읽기를 맡는다. 지금 자리 그대로다. 실행 도우미(`args.ts`, `py.ts`, `output.ts`)도 여기 남는다. 판정 코드가 아니고 work-board 와 `modules/kit` 이 그 경로를 사본 대조에 쓴다.
- **결과를 정하는 층 `core/`(PR4 신규)**: 판정 함수만 둔다. 지금 바깥을 부르지 않는 판정 파일(`completion.ts`, `auto-merge.ts`, `screen.ts`, `overlap.ts`, `milestones.ts`, `stop-reports.ts`, `deploy.ts`, `finish-options.ts`, `queue-options.ts`)을 옮기고, 섞인 파일(`questions.ts`, `decisions.ts`, `movement.ts`, `loop.ts`, `conflicts.ts`, `refresh.ts` 등)은 판정 함수만 떼어 옮긴다. 어느 함수를 떼는지는 PR4 의 plan 이 코드를 읽어 정한다.
- **의존 방향**: `core/` 는 `core/` 안과 허용한 내장 모듈만 import 한다. `lib/` 와 단계 파일은 `core/` 를 부를 수 있다. 거꾸로는 안 된다.
- **바깥 importer**: work-board(`extensions/work-board/bin/worker-marks.ts`)가 `lib/movement.ts` 의 `judgeWorker` 를 가져간다. 판정을 `core/movement.ts` 로 옮겨도 `lib/movement.ts` 가 그 이름을 다시 내보낸다(export 한 줄). work-board 는 범위 밖이라 import 줄을 고치지 않는다.
- **루프 알림의 주인**: 알릴지 정하는 것(같은 이유 다시 보내지 않기, dispatch 마다 한 번)은 지금처럼 각 단계가 상태 파일(`loop.json` 의 errors·ci·stalls, `state/finish-missing.json` 등)로 한다. 보내기만 `lib/run-notice.ts` 가 맡는다.
- **worker 에게 보내기의 주인**: `send-to-worker` 하나다. 루프, 마무리, 충돌 알림은 지금처럼 이것을 부른다(`lib/tell-worker.ts`).

## 인터페이스와 데이터

### worker 질문(PR1)

`worker-ask`(`orch worker ask`)의 새 흐름이다.

1. `--decision` 형식 검사와 읽지 않은 메시지 확인(종료 코드 5, `--force`, `ORCH_ASK_SEEN`)은 지금 코드 그대로다.
2. `orca orchestration ask --from <handle> --question <본문> [--options] --timeout-ms 5000 --json --full` 을 한 번 부른다. `--wait` 는 주지 않는다. `--timeout-ms` 는 끝난 worker 의 ask 를 위한 것이다. Orca 는 끝난 worker 의 ask 를 답이 올 때까지 막아 두므로(`ask --help` 의 Notes), 짧게 끊고 질문은 남긴다.
3. 결과에 따라 아래처럼 끝낸다.

| ask 결과 | 출력(짧은 출력) | 종료 코드 |
| --- | --- | --- |
| `pending` 이나 시간 초과이고 질문 id 가 있다 | `ASKED <질문 id>` | 0 |
| 답이 바로 왔다(끝난 worker 가 5초 안에 답을 받음) | `answer: <답>` | 0 |
| 0 으로 끝났는데 답도 질문 id 도 없다 | `NO-ANSWER -` | 2 |
| 바쁨 코드 | 지금처럼 다시 부른다. 다섯 번 뒤에도 바쁘면 2 | 2 |
| 끝난 dispatch 코드(`dispatch_inactive`, `dispatch_not_found`)나 코드 없음 | Run 메일함으로 대신 보내고 `SENT-RUN <id>` | 3 |
| 그 밖의 코드 | 대신 보내지 않는다 | 2 |

- 긴 출력(`--full`)은 첫 줄이 같은 판정 줄이고 그 뒤에 ask JSON 을 잇는다. 지금 `answer:` 의 꼴과 같다.
- stderr 마지막 줄은 다음에 할 일이다. 0 이면 「턴을 끝낸다. 답이 오면 Orca 가 깨운다. 깬 뒤 `orca orchestration check` 로 읽는다」 다.
- 지우는 것: status 답 기다리기(`ORCH_ASK_POLL_MS`), `--max-wait` 의 다시 기다리기, 시간 초과 4 와 `TIMEOUT` 줄, `--resume`.
- `--timeout-ms`, `--max-wait` 는 받되 쓰지 않고 stderr 에 「없어진 옵션이라 무시했다」 한 줄을 낸다(스펙 DECISION14). 값 형식 검사도 하지 않는다. 이미 도는 worker 를 사용법 오류로 멈추지 않으려는 것이다.
- `--resume` 은 「없어졌다, Orca 가 답과 함께 깨운다, 읽을 문서: 공통 지시서의 worker-ask 규칙」 한 줄과 2 로 끝난다(DECISION6).
- 코디네이터가 status 로 답하는 길(`send-to-worker` 의 `fallback:`)은 그대로 둔다. worker 는 그 메일로도 깨고 `check` 로 본문을 읽는다. `send-to-worker` 머리 주석의 「worker-ask 가 이 status 의 본문을 답으로 읽는다」 를 이 뜻으로 고친다.

### worker 에게 보내기와 후속 일(PR2)

`send-to-worker` 의 dispatch 상태별 경로를 아래로 바꾼다.

| dispatch 상태 | 지금 | 바뀐 뒤 |
| --- | --- | --- |
| 살아 있다 | reply 나 새 메시지 뒤 `nudge-worker` 로 깨운다 | reply 나 새 메시지만 보낸다. 일하는 worker 는 턴이 끝날 때, 쉬는 worker 는 바로 Orca 가 깨운다(실측 보고서 3a) |
| 끝났고 답할 질문이 있다, `--spec` 없음 | 답만 단다 | 그대로 |
| 끝났다, `--spec` 있음 | `launch-worker -- --terminal <그 터미널>` 로 다시 띄운다 | 아래 「후속 일 보내기」 |
| 끝났는데 화면이 일하는 중, `--spec` 없음 | 터미널에 직접 넣는다 | `send --to dispatch:<id>` 로 보낸다. 끝난 dispatch 라 Orca 가 후속 Task 로 만든다. 지시서가 없어 띄우기 기록에 남지 않는다고 stderr 에 알린다 |
| 터미널이 없다 | 종료 코드 3 으로 새로 띄우라고 안내 | `--spec` 이 있으면 「후속 일 보내기」, 없으면 지금처럼 3 |

**후속 일 보내기**

1. 지시서를 `launch-worker` 와 같은 검사(`lib/spec.ts` 의 `허락:` 줄과 `worker 선택:` 줄 검사)에 통과시킨다. 실패하면 보내지 않고 2 다.
2. 본문은 `orch spec line` 이 만드는 한 줄(지시서 경로를 읽으라는 글)이다. 가드 훅(`require-spec-line.ts`)이 받는 꼴과 같다.
3. `orca orchestration send --to dispatch:<끝난 id> --subject <지시서 제목> --body <한 줄> --json --full` 을 보낸다.
4. 영수증의 `delivery` 가 `follow_up` 이면 `dispatchId`, `taskId` 로 `state/launch-history.jsonl` 과 `state/launched-workers` 에 한 줄씩 남긴다. 워크트리와 터미널은 앞 dispatch 의 것을 옮겨 적는다. 출력은 `FOLLOW-UP <앞 dispatch> <새 dispatch> <새 Task>` 와 0 이다.
5. send 가 거절되면(연결된 서버의 끝난 worker 처럼 Orca 가 받지 않음) 지금의 다시 띄우기(`launch-worker --worktree <그 워크트리>`, agent_unconfigured 처리 포함)로 내려간다. 자동 해제가 지난 worker 의 동작은 「설계 단계 실측」 의 결과를 따른다.

- 종료 코드 1(깨우지 못함)과 4(입력란에 글이 있어 깨우지 않음)는 더 나오지 않는다. 1 은 다시 띄우기 실패에만 남는다. 부르는 쪽(`lib/tell-worker.ts`, 루프, `finish-pr`)은 0, 1, 4 를 보낸 것으로 보므로 고치지 않는다.
- 짧은 출력의 `RESUMED`, `RESTARTED` 는 다시 띄우기 경로에만 남고 `FOLLOW-UP` 이 더해진다.
- `finish-pr.ts:158` 의 「send-to-worker 는 nudge-worker 를 5분까지 기다린다」 시간 한도는 줄여도 되지만 겉 동작이 아니므로 이번에 바꾸지 않는다.

### 루프 알림 보내기(PR3)

- `lib/run-notice.ts` 의 `notifyRun(run, kind, text, pr?) : { ok: true; id } | { ok: false; error }`.
  - 보내는 꼴: `orca orchestration send --to run:<Run> --type status --subject "<kind> <text 앞 80자>" --body <text> --payload '{"source":"orch-loop","kind":…,"pr":…}' --json`. `--from` 을 붙일지와 환경 변수를 뺄지는 「설계 단계 실측」 1번의 결과를 따른다.
  - Run 이 없는 루프(옛 꼴)는 받을 곳이 없어 loop.log 에만 남긴다.
- **보내기 실패**: 지금 각 단계는 알림 파일에 쓴 뒤 「알렸다」 를 상태에 적는다. 바뀐 뒤에는 `notifyRun` 이 ok 일 때만 적는다. 실패하면 다음 틱이 같은 알림을 다시 낸다. `WATCH-ERROR` 처럼 errors 로 겹침을 막는 것은 보내지 못했으면 errors 에 새 이유를 적지 않는다. 보내지 못한 이유는 loop.log 에 `NOTICE-FAIL <kind> <이유>` 로 남긴다.
- **알림 종류**: 지금 알림 파일의 kind 를 그대로 subject 첫 낱말로 쓴다(CI-FAILED, CONFLICT-ORPHAN, WORKER-STALLED, WORKER-LIMITED, FINISH-MISSING, AUTO-MERGE …). 바뀌는 것은 셋이다. `NO-WAIT` 는 `UNANSWERED` 로, 기술 질문 `REMINDER` 는 `UNANSWERED` 로 합치고, `DONE-SUSPECT`, `WORKER-LOST`, `LOOP-RESTARTED` 를 더한다. 원본 목록은 `docs/data-schema.md` 가 아니라 `orch-loop.ts` 머리 주석이다(지금과 같다).
- **완료 보고 확인 단계(REQ5, REQ14)**: Run 마다 `check --run <Run> --all --types worker_done,status --json --full` 을 읽는다. 처음 보는 worker_done 마다 `lib/completion.ts` 로 근거를 판정한다.
  - 근거가 ready: `worker-done` 이벤트(evidence ready, pr 칸은 `gh pr view` 로 채움)를 내고 보드의 pr 칸을 채운다(`lib/board.ts` 의 `linkBoardPr`). 알림은 보내지 않는다. Orca 가 그 worker_done 으로 이미 깨웠다.
  - 근거 없음: `worker-done` 이벤트(evidence suspicious)를 내고 `DONE-SUSPECT <dispatch> <이유>` 를 보낸다. dispatch 가 띄우기 기록에 `completion: "none"` 이면 알리지 않는다. 리뷰 dispatch 의 근거 규칙은 지금 그대로다.
  - `--outcome failed` 는 판정하지 않는다(지금과 같다).
  - 본 worker_done id 는 `state/done-seen/<Run>.json` 에 남긴다. 처음 띄운 루프는 지금 있는 worker_done 을 모두 본 것으로 적고 알리지 않는다. 옛 보고로 한꺼번에 깨우지 않으려는 것이다.
- **PR 없는 작업 기록**: `launch-worker` 에 `--no-pr` 를 더해 띄우기 기록(`launched-workers`, `launch-history.jsonl`)에 `completion: "none"` 을 적는다. 지금 대기의 `--completion-contract none` 을 대신한다.
- **끊긴 worker 확인 단계(REQ14)**: `wait-important` 의 판정(`worker-list` 행, `dispatch-show`, 화면이 작업 중이면 빼기, 일부러 끝낸 dispatch 빼기)을 `lib/lost-workers.ts`(신규, 판정은 PR4 에서 core 로)로 옮긴다. 기록 파일은 지금 `state/wait-important-lost.json` 을 이름과 꼴 그대로 쓴다. 이미 처리한 dispatch 가 다시 알려지지 않게 하려는 것이다. 새로 끊긴 dispatch 마다 `WORKER-LOST <dispatch> stage=<단계>` 를 보내고 `worker-lost` 이벤트를 한 번 낸다. 알린 dispatch 는 그 파일에 적어 다시 알리지 않는다. 코디네이터가 처리했다고 적는 명령(`wait ack-lost`)은 필요 없어진다.
- **미답변 질문 확인 단계(REQ15)**: 지금 「대기 확인」 자리다. `lib/questions.ts` 의 `poll` 이 낸 미답변 가운데 600초를 넘긴 질문 id 를 모아 정렬한 묶음의 hash 를 `state/unanswered/<Run>.json` 에 둔다. hash 가 바뀌었고 묶음이 비지 않았으면 `UNANSWERED <id 목록>` 을 보낸다. 사용자 결정 질문은 지금처럼 `decision-pending` 이 맡아 이 묶음에서 뺀다. `state/no-wait/` 는 지운다.
- **루프 다시 시작 알림(REQ14)**: `--foreground` 가 시작할 때 앞 `loop.json` 의 `alive_at` 이 생존 기준보다 오래됐으면 등록된 Run 마다 `LOOP-RESTARTED <앞 alive_at> 부터 멈춰 있었다` 를 한 번 보낸다.
- **결정 알림 기본 핸들러(REQ16)**: `notifyRun(run, 'DECISION-PENDING', <지금 요청 글에서 wait-important 줄을 뺀 글>)`. 실패하면 0 이 아닌 코드로 끝나 `lib/decisions.ts` 의 재시도 규칙이 그대로 돈다. `coordinator_terminal` 등록이 없어도 Run 으로 보내므로 「등록되지 않았다」 오류는 없어진다. `DECISION_PREFIX` 는 입력 기록 hook 과 함께 지운다.

### 옛 명령 안내(PR1, PR3)

- `lib/commands.ts` 의 행에 `retired?: { since: string; doc: string }` 를 더한다. 진입점(`bin/orch.ts`)은 이 행이면 스크립트를 부르지 않고 stderr 에 `RETIRED <명령>: 없어졌다. Orca 가 메시지마다 깨운다. 읽을 문서: <doc>` 한 줄을 내고 2 로 끝난다. 옛 이름(`legacy`)으로 불러도 같다.
- 스크립트 경로로 바로 부르는 옛 꼴(`node …/wait/wait-important.ts`, 옛 `NEXT_WAIT` 줄)도 막아야 한다. 옛 파일은 같은 한 줄만 내고 2 로 끝나는 껍데기로 남긴다. 껍데기는 `lib/retired.ts`(신규)의 `retiredMain(name)` 한 줄만 부른다. orca 를 부르지 않으므로 메일을 읽음 처리하지 않는다.
- 대상:

| 명령 | 껍데기로 남길 파일 | PR |
| --- | --- | --- |
| `orch worker ask --resume` | 없음(옵션만 거절) | PR1 |
| `orch wait`, `orch wait questions`, `orch wait triage`, `orch wait user-active`, `orch wait ack-lost`, 옛 이름 `wait-important`, `watch-questions`, `triage-messages` | `wait/wait-important.ts`, `wait/watch-questions.ts`, `wait/triage-messages.ts`, `wait/user-active.ts` | PR3 |
| `orch worker nudge`, 옛 이름 `nudge-worker`(`--state` 없는 꼴) | 없음. `worker/nudge-worker.ts` 는 화면 읽기(`orch worker screen`)로 남고 입력 경로만 지운다 | PR3 |

- `orch worker screen` 은 화면을 읽기만 하고 입력하지 않으므로 남긴다.
- 껍데기 파일과 `retired` 행은 언제 지울지 정하지 않는다. 지우면 옛 줄이 「파일 없음」 으로 바뀌어 안내가 사라진다.

### 두 층 경계(PR4)

`tests/core-boundary.spec.ts`(신규)가 `skills/orch/scripts/core/**/*.ts` 를 글자로 읽어 본다. 실패하면 파일과 줄을 낸다. 테스트는 `scripts/run-tests.ts` 가 모든 `*.spec.ts` 와 함께 CI 에서 돌린다.

- import 는 `core/` 안의 상대 경로와 `node:path`, `node:crypto` 만 받는다. 타입만 가져오는 `import type` 도 같은 규칙이다.
- 금지 낱말: `process.`, `Date.now(`, 인자 없는 `new Date()`, `require(`, 동적 `import(`, `globalThis`. 시각이 필요한 판정은 `now` 를 인자로 받는다.
- 결과를 정하는 코드의 테스트(`tests/core-*.spec.ts`)는 `tests/fixtures/fake-bin.ts` 를 import 하지 않고 `ORCA`, `GH`, `PATH` 를 바꾸지 않는다. 같은 spec 이 이것도 본다.

기각한 안: 파일 머리 표지(`// layer: core`)로 나누기는 표지를 빠뜨린 새 파일을 막지 못한다. ESLint 규칙은 이 저장소에 ESLint 가 없어 새 의존이 된다. 폴더는 자리만 봐도 층이 보이고 글자 검사로 충분하다.

### 겹치는 코드(PR4)

| 이름 | 지금 정의 | 한 곳 |
| --- | --- | --- |
| worker 목록 읽기 | `lib/workers.ts` 의 `workerRows`, `wait/wait-important.ts`, `doctor/migrate-orch-dir.ts` | `lib/workers.ts`. wait-important 의 것은 PR3 에서 사라진다 |
| orca JSON 읽기 | `lib/orca.ts` 의 `orcaJson`, `worker/send-to-worker.ts`, `worker/nudge-worker.ts` | `lib/orca.ts`. 던지는 꼴과 결과를 돌려주는 꼴이 섞여 있어 `orcaJsonOrThrow` 를 더한다 |
| 터미널 닫기 | `lib/idle-shells.ts`, `cleanup/cleanup-sweep.ts`, `worker/resume-worker.ts` | `lib/orca.ts` 에 `closeTerminal` 을 둔다(지금 `lib/idle-shells.ts` 의 것을 옮긴다) |
| pid 생존 확인 | `lib/docker.ts`, `lib/queue-logs.ts`(파일의 pid), `worker/resume-worker.ts` | `lib/process.ts` 의 `alive` 가 이미 있다. 셋 모두 이것을 부른다 |
| git 실행 파일 고르기 | `doctor/migrate-orch-dir.ts`, `queue/finish-pr.ts`, `cleanup/handoff-cleanup.ts` | `lib/git.ts` 에 `gitBin` 을 새로 둔다 |
| 객체 판정 | `isObject` 12곳, `obj` 7곳 | `core/json.ts` 의 `isObject`, `objectOr`. 함수 이름은 달라도 같은 일이라 `obj` 도 합친다(DECISION13 에 더함) |

합칠 때 반환 꼴이 다른 곳(빈 객체를 내는 `obj`, null 을 내는 `obj`)은 부르는 쪽에서 맞춘다. 동작이 같은지는 기존 테스트와 고정 입력 기록이 본다.

### 단계 파일(PR5-PR7)

- 꼴: 단계마다 파일 하나, `export async function <단계>(ctx: StepContext, state: StepState): Promise<StepResult>`. `StepResult` 는 그 단계가 바꿀 상태 조각과 오류 이유를 담는다. 본 파일이 결과를 차례로 합쳐 지금과 같은 결과 줄과 상태 파일을 쓴다.
- 루프(PR5): 머리 주석의 틱 단계 1-11(질문, 열린 PR, 보드, 정리, CI, 머지 알림, 멈춤, 움직임, tick, 자동 머지, 큐 기록, 충돌, 최신화, 자리 보유, PR3 이 더한 완료 보고·끊긴 worker·미답변 질문)을 `loop/steps/` 로 옮긴다. 잠금, 시작·멈춤, 생존 타이머는 `loop/lifecycle.ts` 로 뗀다. 머리 주석도 단계 파일로 나눠 옮긴다.
- 머지 큐(PR6): 차례 고르기, 최신화, CI 대기, 머지, 마무리 넘기기를 `queue/steps/` 로 옮긴다. 단계 경계는 PR6 의 plan 이 `merge_queue.ts` 를 읽어 정한다.
- 정리(PR7): 워크트리, 원격 브랜치, Docker, 상태 파일, 리뷰 기록을 `cleanup/steps/` 로 옮긴다. PR3 이 더한 옛 상태 파일 옮기기도 한 단계다.
- 진입 파일의 경로(`queue/merge_queue.ts` 등)와 `lib/commands.ts` 의 행은 바꾸지 않는다. 테스트와 핸들러가 그 경로로 부른다.

## 실패와 일관성

- **PR 사이의 섞인 상태**: PR1 이 머지되면 worker 는 바로 끝나는 ask 를 쓰지만 코디네이터는 아직 `orch wait` 로 기다린다. 대기가 question 메시지로 깨므로 질문은 놓치지 않는다. PR2 가 머지되면 깨우기 입력이 없어지지만 Orca 가 send 로 깨운다(실측 보고서 3a, 3b). PR3 이 대기를 없앤다. 어느 PR 에서 멈춰도 질문 놓침이 지금보다 늘지 않는다.
- **이미 도는 worker 와 옛 사본**: 저장소마다 `.orch/specs/spec-common.md` 사본이 있다. 사본이 갱신되기 전에 도는 worker 는 옛 규칙대로 `--max-wait` 을 넘긴다. 무시하고 한 줄만 알리므로 멈추지 않는다. 옛 규칙의 「4 면 `--resume`」 은 4 가 더 나오지 않아 닿지 않는다. 사본은 `orch spec sync-common --apply` 로 갱신하고, 그 전에는 spec-lint 의 「틀과 다르다」 경고가 알린다.
- **이미 도는 코디네이터**: PR3 머지 뒤 옛 대기가 돌고 있으면 그 프로세스는 옛 번들 코드라 계속 읽음 처리한다. 루프 시작과 doctor 가 `lib/waiters.ts` 로 남은 대기를 찾아 `WAITER-LEFT <pid>` 를 알리고 끝낼 명령을 안내한다. 자동으로 끝내지 않는다. 사용자 세션의 프로세스다.
- **루프가 보낸 알림이 쌓일 때**: Orca 메시지는 읽음 처리 전까지 남는다. 코디네이터가 오래 자리를 비워도 잃지 않는다. 겹침은 DECISION16 의 지금 규칙이 막는다.
- **Orca 가 꺼졌을 때**: 루프의 조회와 보내기가 함께 실패한다. 보내지 못한 알림은 상태에 「알렸다」 가 적히지 않아 Orca 가 돌아온 틱에 다시 간다. 지금 알림 파일이 하던 「꺼진 동안 쌓아 두기」 를 상태 재판정이 대신한다.
- **옛 상태 파일 옮기기(REQ9, DECISION12)**: 정리 단계가 `state/loop-events/<Run>.jsonl` 에서 커서 뒤의 줄을 Run 별로 한 메시지에 모아 보낸다. 보내기가 성공한 파일만 휴지통으로 옮긴다. 실패하면 남기고 다음 정리가 다시 한다. `state/wait/` 는 읽는 쪽이 없어 바로 옮긴다.
- **배포 순서**: PR 번호 순서다(스펙 DECISION9). PR4 는 PR3 뒤라야 한다. 지울 코드(wait-important)를 core 로 옮기지 않으려는 것이다. PR5-PR7 은 PR4 뒤면 서로 순서가 바뀌어도 된다. 고정 입력 기록이 겹치지 않는다.

## 검증 전략

| 대상 | 경계 | 방법 |
| --- | --- | --- |
| REQ7, REQ8(ask) | `worker-ask.ts` 프로세스 | 가짜 orca 로 결과 꼴별 출력과 종료 코드를 본다(`tests/worker-ask.spec.ts`). 인수 검증은 실제 Orca 에서 worker 하나가 묻고 턴을 끝낸 뒤 답으로 깨는 것을 본다 |
| REQ6, REQ18 | `send-to-worker.ts` 프로세스 | 가짜 orca 로 상태별 경로, `FOLLOW-UP`, 띄우기 기록을 본다. 인수 검증은 실제 Orca 에서 마친 worker 에게 후속 지시서를 보내 같은 터미널이 새 Task 로 시작하고 `orch status` 에 보이는 것을 본다 |
| REQ1, REQ3, REQ5, REQ14, REQ15 | 루프 틱(`--tick`) | 가짜 orca 가 받은 send 인자를 적어 Run 별 알림과 한 번만 가는지 본다. 인수 검증은 실제 Orca 에서 대기 없이 질문과 루프 알림으로 코디네이터가 깨는 것을 본다 |
| REQ2 | 소스 글자 | `tests/check-peek.spec.ts` |
| REQ4, REQ9 | 소스 글자와 정리 | 지운 이름이 남지 않았는지 grep, 정리의 옛 파일 옮기기는 임시 orch 루트로 |
| REQ8 | 진입점과 껍데기 | 옛 꼴마다 한 줄과 2, 가짜 orca 가 불리지 않은 것 |
| REQ10 | 소스 글자 | `tests/core-boundary.spec.ts`. 일부러 금지 import 를 넣은 임시 파일로 검사가 실패하는 것도 본다 |
| REQ11 | 소스 글자 | 여섯 이름의 정의가 한 곳인지 세는 테스트 |
| REQ12, REQ13 | 고정 입력 기록 | 아래 「동작 같음 확인」 |
| REQ16, REQ17, REQ19 | 핸들러와 문서 | 기본 핸들러가 send 를 부르는지 가짜 orca 로, doctor 의 `NUDGE-HANDLER` 는 임시 저장소로, 문서 규칙은 `docs-contract.spec.ts` 의 문장 검사로 |

### 동작 같음 확인(DECISION10)

- `tests/golden/<스크립트>/<사례>/` 에 입력(가짜 orca·gh 의 응답 표, orch 루트의 처음 상태 파일, 인자)과 기록(출력, stderr, 종료 코드, 끝난 뒤의 상태 파일)을 둔다.
- 실행기 `tests/fixtures/golden-run.ts` 는 임시 폴더에 처음 상태를 펼치고, 기존 `fake-bin.ts` 로 가짜 orca·gh 를 PATH 앞에 둔 뒤 스크립트를 부른다. 시계는 `node --import tests/fixtures/fixed-clock.ts` 로 `Date` 를 고정한다. 제품 코드에 시계 주입을 더하지 않는다.
- 비교 전에 임시 폴더 경로와 pid 만 자리표시자로 바꾼다. 시각은 고정했으므로 바꾸지 않는다.
- 사례는 루프 틱 셋(CI 실패와 충돌 PR, 미답변 질문과 멈춘 worker, 조회 실패), 머지 큐 셋(머지 가능, CI 실패 보류, 충돌), 정리 셋(머지된 워크트리, 살아 있는 worker 건너뛰기, 옛 상태 파일)을 최소로 한다. 실제 사례는 PR4 의 plan 이 기존 fixture(`merge-queue-run.ts`, `cleanup-sweep-run.ts`, `cleanup-stateful-run.ts`)를 읽어 정한다.
- 기록은 `node skills/orch/tests/fixtures/golden-run.ts --record` 로 만든다. PR4 의 첫 커밋이 PR3 머지 뒤의 main 코드로 만들고, 그 뒤 커밋과 PR5-PR7 은 `git diff --exit-code origin/main -- skills/orch/tests/golden` 으로 기록이 바뀌지 않았음을 보인다.
- 기존 테스트의 기대값은 PR4-PR7 에서 바꾸지 않는다. 테스트가 옮긴 파일 경로를 import 하는 줄은 기대값이 아니므로 고친다. 기대값을 바꿔야 하면 멈추고 묻는다.
- PR1-PR3 은 동작을 바꾸는 PR 이라 바뀐 동작의 테스트 기대값을 고친다. DECISION10 은 구조 정리 PR(REQ13)의 규칙이다.

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 두 층을 나누는 방법 | `scripts/core/` 폴더와 글자 검사 테스트 | 작성자 | 스펙 DECISION8 이 방법을 설계에 맡겼다. 기각한 안은 「두 층 경계」 에 있다 |
| DECISION2 | 실행 도우미(`args.ts`, `py.ts`, `output.ts`)의 자리 | `lib/` 에 남긴다 | 작성자 | 결과를 정하는 코드가 아니다. `modules/kit` 사본 대조가 그 경로를 읽는다 |
| DECISION3 | work-board 가 가져가는 판정 | `lib/movement.ts` 가 core 의 이름을 다시 내보낸다 | 작성자 | 스펙이 work-board 를 범위 밖에 두었다 |
| DECISION4 | 끝난 worker 의 ask | `--timeout-ms 5000` 으로 끊고 질문은 남긴다 | 작성자 | Orca 는 끝난 worker 의 ask 를 답까지 막는다(`ask --help`). 기다리지 않는다는 스펙 DECISION5 를 지킨다 |
| DECISION5 | ask 의 새 성공 출력 | `ASKED <질문 id>` 와 0 | 작성자 | 짧은 출력의 판정 낱말 꼴(대문자 낱말과 id)을 따른다 |
| DECISION6 | 옛 명령의 종료 코드 | 2 | 작성자 | 스펙 DECISION6 은 0 이 아닌 코드만 정했다. 옛 명령은 지금 쓸 수 없는 사용법이라 사용법 오류의 2 다 |
| DECISION7 | 옛 명령을 경로로 부르는 꼴 | 옛 파일을 한 줄 안내 껍데기로 남긴다 | 작성자 | 옛 `NEXT_WAIT` 줄과 저장소 핸들러가 경로로 부른다. 파일을 지우면 「모듈 없음」 오류가 나 무엇을 할지 알 수 없다 |
| DECISION8 | 루프 알림의 메시지 종류 | `status` 와 `source: orch-loop` payload | 작성자 | Orca 종류 가운데 question 은 답을 기다리고 escalation 은 Orca 의 멈춤 보고와 섞인다. 코디네이터는 subject 첫 낱말로 가른다 |
| DECISION9 | 보내지 못한 루프 알림 | 상태에 「알렸다」 를 적지 않아 다음 틱이 다시 낸다 | 작성자 | 알림 파일을 없애므로 따로 쌓아 둘 곳이 없다. 루프는 상태로 다시 판정하는 구조라 같은 알림이 다시 나온다 |
| DECISION10 | 처음 띄운 루프의 지난 worker_done | 본 것으로 적고 알리지 않는다 | 작성자 | 처음 틱에 지난 보고 수십 건으로 깨우지 않으려는 것이다. 그 보고는 그때의 대기가 이미 보였다 |
| DECISION11 | PR 없는 작업 표시 | `launch-worker --no-pr` 가 띄우기 기록에 `completion: "none"` | 작성자 | 스펙 DECISION18 「띄울 때 기록으로 가린다」 의 자리다 |
| DECISION12 | 끊긴 worker 기록 파일 | `state/wait-important-lost.json` 을 이름과 꼴 그대로 쓴다 | 작성자 | 이름을 바꾸면 이미 처리한 dispatch 가 처음 틱에 다시 알려진다 |
| DECISION13 | 결정 알림·움직임 기록(스펙 DECISION7) | 둘 다 남긴다 | 작성자 | 「설계 단계 실측」 4번. Orca 기능이 같은 정보를 주지 않아 스펙이 정한 「다시 묻기」 조건이 아니다 |
| DECISION14 | 고정 입력 기록의 시계 | `--import` 로 `Date` 를 고정한다 | 작성자 | 제품 코드에 시계 인자를 더하면 그 자체가 구조 변경이라 기록을 만들기 전에 동작을 건드린다 |
| DECISION15 | 고정 입력 기록을 만드는 때 | PR4 첫 커밋 | 작성자 | PR1-PR3 은 동작이 바뀌어 기록이 낡는다. PR4 부터 구조만 바뀐다 |
| DECISION16 | ADR | PR3 이 「코디네이터 깨우기는 Orca 메시지만 쓴다」 ADR 을 새로 쓰고 [ADR-012](../../adr/012-orch-loop-multi-run.md) 의 알림 파일 부분과 [ADR-013](../../adr/013-orch-worker-stalled.md) 의 입력 명령 부분을 대체 관계로 잇는다. PR4 가 「두 층 경계」 ADR 을 쓴다. 이 설계 PR 에서는 쓰지 않는다 | 작성자 | 되돌리면 대기·알림 파일·입력 명령을 함께 되살려야 하는 결정이다. ADR 은 결정이 코드로 들어가는 PR 에서 그 원본과 함께 쓴다 |
