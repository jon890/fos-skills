// 저장소마다 하나 도는 상주 루프다. 여러 세션의 Run 을 함께 맡는다(ADR-012, 아래 「Run」). 틱마다 질문 확인, 정리(원격 브랜치 포함), 보드 동기화, CI 감시와 알림, tick 이벤트, 충돌 PR 처리를 한다.
// 코디네이터를 깨워야 하는 일은 그 Run 의 알림 파일(state/loop-events/<Run>.jsonl)에 적고, 코디네이터의 wait-important --loop-repo 가 그 파일로 깨어난다.
// 루프는 상태로만 판정한다. 루프가 없던 동안 생긴 일은 다음 틱이 다시 보므로, 죽으면 다시 띄우기만 하면 된다.
// 상태 파일의 읽기, 생존 판정, 알림 파일과 커서는 lib/loop.ts 가 소유한다. 형식은 docs/data-schema.md 「orch 루트에 더하는 파일」 이다.
//
// 사용법:
//     orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] (--start | --stop [--all] | --status | --foreground) [--once]
//     orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] --tick --tick-number N      (내부용. 부모가 띄운다)
//
//     --repo         대상 저장소. 주 checkout 으로 바꿔 쓴다
//     --run          루프에 등록하거나 뺄 Run. 없으면 config.json 의 finish.run 이다
//     --specs-dir    그 Run 의 정리에 넘길 지시서 폴더. 없으면 finish.specs_dir 이고, 둘 다 없으면 넘기지 않는다. 등록 파일에 적는다
//     --start        Run 이 있으면 먼저 등록한다(lib/loop.ts 의 registerRun). 살아 있는 루프가 없으면 자기 자신을 --foreground 로
//                    분리해(detached, stdio ignore) 띄우고, 자식이 loop.json 에 자기 pid 를 쓸 때까지 10초까지 기다린다.
//                    하네스의 백그라운드 명령이 아니라 시간 한도에 묶이지 않는다.
//                    LOOP-STARTED <pid> run=<Run id 또는 -> 와 0. 10초 안에 쓰지 않으면 자식을 끝내고 LOOP-START-FAIL <이유> 와 1.
//                    살아 있는 루프가 없을 때의 등록은 registered_at 을 지금으로 새로 쓴다(아래 「Run」).
//                    자식이 4(다른 --start 가 띄운 루프가 먼저 잠금을 쥐었다)로 끝나면 그 루프가 살아 있는지 다시 보고, 있으면 아래 합류와 같다.
//                    살아 있는 루프가 있으면 띄우지 않는다. 그 Run 이 아직 등록되지 않았으면 등록하고 LOOP-JOINED <pid> run=<Run id> 와 0.
//                    그 루프가 막 뜨는 중(loop.json 의 pid 가 아직 그 루프의 것이 아니다)이면 이미 등록된 Run 이어도 registered_at 을
//                    새로 쓴다. 뜨는 루프가 앞 루프의 alive_at 이전 등록을 지울 때 이 Run 을 지우지 않게 하려는 것이다.
//                    이미 등록됐거나 Run 이 없으면 LOOP-RUNNING <pid> run=<Run id> 와 4.
//                    Run 등록을 모르는 옛 루프(loop.json 에 runs 가 없다)면 등록하지 않고 LOOP-RUNNING 과 4 이고, Run 이 다르면
//                    `안내: …` 한 줄을 더 낸다. 그 루프를 띄운 세션이 --stop 뒤 새 orch 로 다시 띄워야 한다
//     --stop         --run 을 주면 그 Run 의 등록만 지운다. 다른 Run 이 남으면 루프를 멈추지 않고
//                    LOOP-LEFT <pid> run=<Run id> runs=<남은 Run 목록> 와 0, 등록돼 있지 않았으면 LOOP-NOT-REGISTERED run=<Run id> 와 0.
//                    옛 루프가 다른 Run 의 것이면 멈추지 않고 LOOP-NOT-REGISTERED 와 안내 줄, 0 이다.
//                    등록을 지운 Run 은 알림 파일과 커서도 지운다. 읽지 않은 줄이 있으면 남긴다(lib/loop.ts 의 「알림 파일 지우기」). --all 도 같다.
//                    --run 이 없고 finish.run 도 없으면 등록된 Run 이 하나라도 있을 때 멈추지 않고 LOOP-STOP-SHARED <pid> runs=<목록> 와 1 이다.
//                    등록이 하나여도 다른 세션의 Run 일 수 있어, 다른 세션의 루프를 끊지 않으려는 것이다. --all 을 주면 모두 지우고 멈춘다.
//                    등록을 뺀 뒤 신호를 보내기 직전에 다른 세션이 합류했으면 멈추지 않고 LOOP-LEFT <pid> run=<Run id> runs=<목록> 와 0 이다.
//                    남은 Run 이 없으면 아래처럼 루프 프로세스를 멈춘다.
//                    loop.json 의 pid 에 TERM 을 보내고 20초까지 끝나기를 기다린다. LOOP-STOPPED <pid> 와 0,
//                    루프가 없으면 LOOP-NOT-RUNNING 과 0, 20초 뒤에도 살아 있으면 LOOP-STOP-TIMEOUT <pid> 와 1.
//                    pid 가 살아 있어도 그 명령줄에 orch-loop 가 없으면 루프가 아니다. 죽은 루프의 pid 를 다른 프로세스가 다시 받았을 수 있다.
//                    ps 로 판정할 수 없으면(lib/loop.ts 의 isLoopProcess 가 null) 신호를 보내지 않고 LOOP-STOP-UNKNOWN <pid> <이유> 와 1.
//                    루프가 아닌 프로세스에 TERM 을 보내지 않으려는 것이다
//     --status       LOOP-ALIVE <pid> run=<…> last_tick=<…> alive_at=<…> 와 0, LOOP-DEAD <repo> <이유> 와 1. 판정은 lib/loop.ts 의 loopStatus
//     --foreground   지금 프로세스에서 틱을 돈다. --start 의 자식과 테스트가 쓴다. 신호를 받으면 진행 중인 틱 자식을 끝내고(아래 「틱」)
//                    128 + 신호 번호
//     --once         --foreground 와 함께 틱 한 번만 돌고 0 으로 끝난다
//     --all          --stop 과 함께, --run 없이 준다. 등록된 Run 을 모두 지우고 루프를 멈춘다
//     --tick, --tick-number N
//                    틱 하나를 돌고 끝난다. --foreground 의 부모가 틱마다 띄운다. N 은 1 부터다.
//                    stdout 마지막 줄에 {"tick_at": <ISO 8601 UTC>, "errors": {<출처>: <이유 또는 null>}, "open_prs": <번호 목록 또는 null>,
//                    "ci": {<PR 번호>: {"head": <SHA>, "state": <passed, failed, pending>}}, "stalls": {<dispatch>: <멈춤 항목>}} 을 내고 0.
//                    열린 PR 을 읽지 못한 틱은 ci 가 없고, 멈춤 확인이 예외로 끝난 틱은 stalls 가 없다. 멈춤 항목은 아래 「멈춤 확인」 이다
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts)
//
// 한 저장소에 하나: --foreground 는 시작할 때 state/loop.lock 을 wx 로 만들어 자기 pid 를 적고, 끝날 때 자기 pid 가 든 잠금만 지운다.
//     죽은 pid 의 잠금은 lib/events.ts 의 reclaim 으로 회수한다. pid 가 살아 있어도 루프 프로세스(lib/loop.ts 의 isLoopProcess)가
//     아니면 죽은 잠금으로 보고 회수한다. 죽은 루프의 pid 를 다른 프로세스가 다시 받았을 수 있다.
//     pid 가 살아 있는데 ps 로 판정할 수 없으면(isLoopProcess 가 null) 루프가 쥔 것으로 보고 회수하지 않는다. 잘못 회수하면 루프가 둘이 된다.
//     살아 있는 루프가 쥐고 있으면 LOOP-RUNNING 과 4 다.
//     --start 는 loopStatus 와 이 잠금을 함께 본다.
//
// Run(ADR-012): 루프는 lib/loop.ts 의 「Run 등록」 이 정한 Run 들을 맡는다. 앞이 주 Run 이다.
//     부모는 틱마다 등록을 읽어 loop.json 의 runs(목록)와 run(주 Run)에 적는다. 등록된 Run 이 있던 루프는 마지막 Run 이 빠지면
//     다음 틱 전에 LOOP-EMPTY 줄을 내고 0 으로 끝난다. 처음부터 등록이 없던 루프(Run 없이 띄웠다)는 --stop 까지 돈다.
//     --foreground 는 시작할 때 다른 Run 의 등록 가운데 registered_at 이 앞 loop.json 의 alive_at(앞 루프가 마지막으로 살아 있던 때)
//     이전인 것을 지우고 --run(또는 finish.run)을 등록한다. 루프가 죽은 뒤 끝난 세션의 Run 을 계속 맡지 않게 하려는 것이다.
//     그 뒤의 등록은 남긴다. 살아 있는 루프 없이 --start 한 세션은 등록의 registered_at 을 새로 쓰므로, 루프가 죽어 여러 세션이 함께
//     --start 해도 서로의 등록을 지우지 않는다. 앞 loop.json 이 없으면(alive_at 을 읽지 못하면) 지우지 않는다.
//     지운 Run 의 세션이 살아 있으면 wait-important 가 미등록 LOOP-DEAD 로 깨워 다시 등록하게 한다.
//     --stop 도 --run 이 없으면 finish.run 을 쓴다.
//     틱 자식은 등록을 다시 읽는다. 등록이 없으면 --run(또는 finish.run) 하나를, 그것도 없으면 Run 없는 한 칸을 맡는다.
//     알림의 Run: Run 에 묶인 일(질문, 그 Run 의 정리, 그 Run 의 tick 핸들러)의 알림은 그 Run 의 파일에 쓴다.
//     PR 에 붙는 알림(CI-FAILED, CONFLICT-ORPHAN)은 그 PR 워크트리의 worker 를 띄운 Run(아래 「worker 찾기」)에, 주인을 모르면 주 Run 에 쓴다.
//     공유 일(열린 PR 조회, 보드, CI 규칙, 충돌 처리)의 WATCH-ERROR, 보드 결정의 REMINDER, 부모의 WATCH-ERROR tick 은 주 Run 에 쓴다.
//     Run 없는 한 칸이면 옛 파일(state/loop-events.jsonl)에 쓴다.
//     worker 찾기: 맡은 Run 마다 worker-list --run 을 읽어(한 틱에 Run 마다 한 번) 그 워크트리의 worker 를 찾는다. 살아 있는 dispatch 가
//     있는 Run 을 먼저 고르고, 없으면 처음 찾은 Run 이다. 살아 있는 dispatch 를 못 찾았고 읽지 못한 Run 이 있으면 읽지 못한 것으로 본다.
//     ci-passed 와 ci-failed 핸들러의 run 도 그 Run 이다(모르면 주 Run).
//
// 틱: 부모는 틱 자식 하나가 끝나면 pipeline.tick_sec 을 기다린 뒤 다음 틱 자식을 띄운다. 겹치지 않는다.
//     틱을 자식 프로세스로 떼어 낸 것은 lib 의 조회(질문 조회, gh)가 동기라, 같은 프로세스에서 돌면 그동안 생존 타이머가 돌지 못해서다.
//     틱 자식은 자기 프로세스 그룹으로 띄운다(lib/proc.ts runAsync 의 group). 부모가 신호를 받으면 그 그룹 전체에 TERM 을 보내고,
//     TICK_STOP_GRACE_MS 뒤에도 그룹이 남아 있으면 KILL 을 보낸다. 이 유예는 틱 자식이 자기 자식을 끝내는 유예(lib/proc.ts 의
//     STOP_GRACE_MS)보다 길다. 같으면 틱 자식이 손자(정리 명령 같은 것)에 KILL 을 보내기 전에 부모의 KILL 이 틱 자식에 닿아 손자가 남는다.
//     부모가 KILL 로 죽으면 신호를 전하지 못한다. 그래서 틱 자식은 PARENT_POLL_MS(2초)마다 시작할 때의 부모 pid 를 보고, process.ppid 가
//     바뀌었거나 그 pid 가 죽었으면 SIGHUP 을 받은 것처럼 자기 자식을 끝내고 129 로 끝난다. 동기 조회(질문 조회, gh) 중에는 그 조회가
//     끝난 뒤에 본다. 부모가 없으면 stdout 을 읽는 쪽도 없으므로 그 뒤의 쓰기 오류(EPIPE)는 버린다.
//     틱 자식이 하는 일(순서대로, 하나가 실패해도 다음을 한다):
//     1. 질문 확인. Run 마다, Run id 가 있을 때만. lib/questions.ts 의 poll(재알림 600초, watch-questions 의 기본과 같다)을 부르고
//        알릴 줄마다 QUESTION 이나 REMINDER 줄을 로그에 쓰고 worker-question 을 낸다. REMINDER 는 알림 파일에도 쓴다.
//        새 질문(QUESTION)은 알림 파일에 쓰지 않는다. 코디네이터의 wait-important 가 question 메시지로 이미 깨어난다
//     2. 열린 PR 조회. gh pr list 한 번으로 읽어 보드, CI, tick, 충돌 처리가 함께 쓴다. 내 PR 은 lib/gh.ts 의 ownAuthors 와 isOwnPr 로 가린다
//     3. 보드 동기화(워크트리 정리 전). 보드 파일(lib/paths.ts 의 boardPath)이 없으면 건너뛴다. 있으면 열린 PR 목록과 --repo 를 board-sync 에 준다.
//        decide 제목·줄의 내용 해시가 달라지면 REMINDER 를 기록한다(lib/board.ts)
//     4. 정리. Run 마다 cleanup-sweep --repo <repo> --kill-holders [--remote-branches] --apply [--run <run>] [--specs-dir <그 Run 의 dir>].
//        --remote-branches 는 저장소 공유 일이라 주 Run 의 차례에서만 준다
//     5. CI 감시. 아래 「CI 감시」
//     6. 멈춤 확인. 아래 「멈춤 확인」
//     7. tick 이벤트. Run 마다 공통 필드 run 을 그 Run 으로 낸다. 입력은 tick(틱 번호), open_prs(내 열린 PR 번호 목록. 읽지 못하면 null),
//        primary(주 Run 이면 true)다(lib/events.ts 머리 주석의 「이벤트별 필드」).
//     8. 충돌 처리. 아래 「충돌 처리」. 끝난 dispatch 에 이어 쓰면 65분까지 걸려 마지막에 둔다. 밀리는 것은 다음 틱뿐이다
//     틱 자식은 loop.json 을 읽기만 한다(이전 errors, ci, stalls 를 보려고). 부모가 결과 줄을 합쳐 last_tick(결과의 tick_at), ticks, errors,
//     ci 와 stalls(결과에 있을 때만 통째로 바꾼다)를 쓴다.
//     결과 줄 앞의 출력과 stderr 는 부모가 로그로 옮긴다. 결과 줄을 읽었으면 종료 코드와 상관없이 합친다. 버리면 그 틱이 이미 알린
//     CI 상태가 loop.json 에 남지 않아 다음 틱이 같은 실패를 다시 알린다. 틱 자식이 0 이 아니면 errors.tick 에 `종료 코드 <n>` 을 둔다.
//     결과 줄 없이 끝나면 last_tick 은 그대로 두고 errors.tick 에 `종료 코드 <n>`(0 이 아닐 때)이나 `결과 줄 없음` 을 둔다.
//
// CI 감시: 내 열린 PR 가운데 draft 가 아닌 것마다 필수 체크 상태를 정한다. 다른 사람의 PR 과 draft 는 보지 않는다.
//     필수 체크 이름은 lib/gh.ts 의 requiredNames(queue.required, 없으면 base 의 저장소 규칙. 같은 base 의 규칙은 틱마다 한 번 읽는다),
//     상태는 ciState(queue.skipped_is_missing 을 따른다)다. 머지 큐의 기본 판정(--allow-fail 없음)과 같다. 필수가 아닌 체크의 실패도
//     failed 이고, passed 는 실패가 없고 필수 체크가 모두 나타났고 롤업의 체크가 모두 끝난 때다. 필수 체크 목록이 비면 나타난 체크 전부로
//     판정한다. 루프는 --allow-fail 을 모른다. 머지 큐에 --allow-fail 을 주는 저장소에서는 루프가 실패로 알린 PR 도 큐는 머지할 수 있다.
//     loop.json 의 ci[<PR>] 와 HEAD 와 상태가 같으면 넘어간다. 다르면 새 값을 결과의 ci 에 담고, passed 로 바뀌었으면 ci-passed 를,
//     failed 로 바뀌었으면 그 PR 의 worker 에게 보내고 알림 파일에 CI-FAILED 를 쓴 뒤 ci-failed 를 낸다(입력은 lib/events.ts 머리 주석의
//     「이벤트별 필드」). 같은 HEAD 에서 다시 돌린 체크가 통과로 바뀌면 ci-passed 를 낸다. 새 HEAD 는 새로 판정한다.
//     처음 본 PR(이전 값이 없는 PR)은 지금 상태를 한 번 알린다. 루프를 처음 띄운 때 이미 실패해 있던 PR 도 알리려는 의도다.
//     결과의 ci 는 이번 틱에 본 내 열린 PR 의 값이라 닫힌 PR 의 항목은 빠진다. draft 와 규칙을 읽지 못한 base 의 PR 처럼 이번 틱에
//     판정하지 않은 PR 은 이전 값을 그대로 옮긴다. 지우면 다음 틱에 같은 HEAD 의 실패를 다시 알린다.
//     규칙을 읽지 못한 base 는 errors.ci 로 `WATCH-ERROR ci: …` 를 쓴다(아래 「오류 줄 억제」).
//     worker 에게 보내기: 맡은 Run 에 Run id 가 있고, 그 PR 브랜치의 워크트리(lib/workers.ts 의 worktreePaths)에 살아 있는 dispatch
//     (위 「worker 찾기」, LIVE_DISPATCH)가 있을 때만 send-to-worker --dispatch <id> --body <본문> --run <그 worker 의 Run> 으로 보낸다. 끝난 dispatch 에 후속 지시서로
//     이어 쓰지 않는다. 그때는 CI-FAILED 로 코디네이터가 판단한다. CI-FAILED 의 text 는 `<실패한 체크 이름>: <worker 결과>` 이고 worker 결과는
//     `보냈다 <dispatch>`, `깨우지 못했다(종료 코드 4)`, `보내지 못했다(종료 코드 <n>)`, `살아 있는 dispatch 없음`, `Run id 없음`,
//     `worker 목록을 읽지 못했다` 가운데 하나다.
//
// 멈춤 확인: 맡은 Run 마다 그 Run 의 worker-list(위 「worker 찾기」 와 같은 조회)에서 살아 있는 dispatch(LIVE_DISPATCH)의 터미널 화면을
//     `orca terminal read --screen` 으로 읽고 lib/screen.ts 의 readScreen 으로 판정한다. 등록되지 않은 Run 의 worker 화면은 읽지 않는다.
//     입력하지 않는다. 다시 시도시키는 일과 그 횟수 상한은 저장소의 worker-stalled 핸들러가 정한다(references/hooks.md, ADR-013).
//     멈춤은 error(모델 오류로 멈춘 화면)와 idle(입력란이 빈 화면)이다. pipeline.stall_ticks 가 상태마다 기준 틱 수를 정하고, 0 이면 보지 않는다.
//     interrupted(사람이 Esc 로 끊은 화면)는 멈춤이 아니다. 사람이 일부러 멈춘 작업을 핸들러가 다시 돌리지 않게 한다.
//     기본은 error 2, idle 0 이다. idle 은 백그라운드 에이전트를 기다리는 정상 화면과 구분되지 않아 기본으로 끈다.
//     idle 을 켜도 그 dispatch(또는 그 터미널)가 보낸 미답변 질문(1 의 poll 이 본 question, escalation)이 있으면 세지 않는다.
//     그 Run 의 질문을 읽지 못한 틱은 질문을 기다리는지 모르므로 idle 항목을 세지도 지우지도 않는다.
//     멈춤 항목(loop.json 의 stalls[<dispatch>]): run, terminal, state, hash(lib/screen.ts 의 stallHash), since(그 상태를 처음 본 틱의
//     ISO 8601 UTC 시각), ticks(같은 상태와 같은 hash 를 본 틱 수. 핸들러가 처리한 뒤로 다시 센다), fired(코디네이터에게 알렸는지).
//     입력란 아래 상태 줄(경과 시간, 컨텍스트 사용량)은 hash 에 들지 않아 그 줄만 바뀐 화면은 같은 멈춤이다.
//     상태나 터미널이 바뀌면 새 항목이다. 같은 상태에서 hash 만 바뀌면 since 는 두고 ticks 1, fired false 로 다시 센다.
//     코디네이터가 이어 가게 한 worker 가 같은 오류로 다시 끝나면 화면에 오류 줄이 늘어 hash 가 바뀌므로 다시 알린다.
//     ticks 가 기준에 닿은 틱에 worker-stalled 를 그 Run 으로 낸다.
//     핸들러가 0 으로 끝나면(pass) 알림 파일에 쓰지 않고 ticks 를 0 으로 되돌린다. 다시 시도시킨 worker 의 화면이 그대로면 hash 가 같다.
//     그래서 같은 화면이 기준 틱 수만큼 더 이어지면 핸들러를 다시 부른다. 횟수 상한은 핸들러가 since 로 센다.
//     핸들러가 없거나 0 이 아니면(10 은 넘김이다) 그 Run 의 알림 파일에 WORKER-STALLED 를 쓰고 fired 를 true 로 둔다. 같은 hash 가 이어지는 동안 다시 내지 않는다.
//     text 는 `<dispatch> <state> <ticks>틱 <terminal>` 이다.
//     작업 중으로 바뀌었거나, 멈춤이 아니거나, dispatch 가 끝났거나, 등록에서 빠진 Run 의 항목은 결과에서 빠진다.
//     worker-list 를 읽지 못한 Run 의 항목과 화면을 읽지 못한 dispatch 의 항목은 그대로 옮기고, 그 Run 의 errors 의 stalls@<Run> 에 이유를 둔다.
//     같은 틱에 그 Run 의 질문 확인도 실패했으면 stalls@<Run> 은 로그에만 쓰고 비워 둔다. Orca 가 꺼진 틱에 같은 원인으로 두 번 깨우지 않는다.
//     멈춤 확인 전체가 예외로 끝나면 주 Run 의 stalls 키에 이유를 둔다.
//
// 충돌 처리: 내 열린 PR 의 base 충돌을 그 PR 을 만든 기존 worker 에게 풀게 한다. notify-conflicts 와 같은 함수, 같은 기록
//     (state/notify-conflicts.json), 같은 send-to-worker 종료 코드 분류(notify-conflicts.ts 머리 주석의 표)를 쓴다(lib/conflicts.ts).
//     그래서 머지 큐 뒤의 notify-conflicts 와 틱이 차례로 실행될 때 같은 (PR, base SHA) 를 두 번 보내지 않는다. 둘이 겹쳐 돌면
//     둘 다 기록을 읽은 뒤 보내므로 두 번 보낼 수 있다(기록 파일에 잠금이 없다). 새 worker 는 띄우지 않는다.
//     내 열린 PR 이 없으면 git fetch 없이 끝낸다. 열린 PR 을 읽지 못한 틱은 건너뛴다.
//     1. lib/conflicts.ts 의 findConflicts(base 는 origin/HEAD 가 가리키는 브랜치, 없으면 main). 실패하면 `WATCH-ERROR conflicts: …`
//     2. 내 PR 만 남긴다. 작성자를 정하지 못하면 `WATCH-ERROR conflicts: …` 를 쓰고 그 틱의 충돌 처리를 끝낸다
//     3. 기록에 있는 (PR, base SHA) 는 넘어간다. 아니면 브랜치의 워크트리와 worker 행(lib/workers.ts)을 찾아 resolveConflict 와
//        concludeConflict 를 부른다. 워크트리나 dispatch 가 없으면 orphan 이다. worker-list 를 읽지 못하면 그 PR 은 기록하지 않고
//        `WATCH-ERROR conflicts: worker 목록을 읽지 못했다: …` 를 쓴다
//     4. orphan 이면 알림 파일에 CONFLICT-ORPHAN(pr 은 PR 번호, text 는 이유)을 쓴다
//     5. send-to-worker 가 2(사용법 오류)로 끝나면 그 틱의 충돌 처리를 멈추고 `WATCH-ERROR conflicts: send-to-worker 사용법 오류` 를 쓴다.
//        notify-conflicts 는 2 로 끝나지만 루프는 끝내지 않는다. 끝내면 질문 확인도 멈춘다
//     resolveConflict 의 줄(`<dispatch> 에 알렸다` 따위)은 로그에 쓴다. send-to-worker 를 틱 자식 안에서 기다리는 동안에도
//     부모의 생존 타이머가 alive_at 을 쓴다.
//
// 생존 타이머: 부모가 틱과 따로 ORCH_LOOP_ALIVE_SEC(양수 초, 기본 30)마다 loop.json 의 alive_at 을 쓴다. 시작할 때도 한 번 쓴다.
//     그래서 긴 틱(정리의 대기, 끝난 dispatch 이어 쓰기)도 죽은 것으로 보이지 않는다.
//
// loop.json: pid, run(주 Run), runs(등록된 Run 목록), repo, tick_sec, started_at, alive_at, last_tick, ticks, errors, ci, stalls. 시각은 ISO 8601 UTC 다. 부모만 쓴다.
//     시작할 때 앞 loop.json 의 errors, ci, stalls 를 이어받는다. 다시 띄운 루프가 같은 실패를 다시 알리지 않게 한다.
//
// 오류 줄 억제: errors 는 출처마다 마지막 오류 이유다. Run 마다 도는 출처(questions, cleanup, hook, stalls)는 `<출처>@<Run>` 키다
//     (Run 없는 한 칸이면 출처 이름 그대로). 주 Run 이 바뀌어도 다른 Run 의 이전 값과 비교하지 않게 하려는 것이다.
//     공유 출처(SHARED_SOURCES: prs, board, ci, conflicts, tick)는 `<출처>@<주 Run>` 키다. 알림이 주 Run 에 가므로, 주 Run 이 바뀌면
//     진행 중인 실패가 새 주 Run 에 한 번 가야 한다. 출처 이름만 키로 두면 앞 주 Run 이 받은 값에 막혀 새 주 Run 에 오지 않는다.
//     부모는 등록에서 빠진 Run 의 키, 주 Run 이 아닌 Run 의 공유 키, 주 Run 이 있을 때의 `@` 없는 공유 키(Run 없던 루프나 옛 루프가
//     남긴 값)를 지운다. 다시 등록된 Run 의 첫 실패가 지난 값에 막히지 않게 한다. 출처는 questions(질문 조회), cleanup(정리 명령이 0 이 아닌 종료),
//     board(보드 동기화가 0 이 아닌 종료), prs(열린 PR 조회), ci(필수 체크 규칙 조회), hook(tick 핸들러), stalls(멈춤 확인의 worker 목록과 화면 읽기), conflicts(충돌 처리),
//     tick(틱 자식이 0 이 아니거나 결과 줄 없이 끝남)이다.
//     tick 만 부모가 판정한다. 출처의 이유가 이전과 다를 때만 알림 파일에 쓴다. hook 은 `HOOK-FAIL tick <종료 코드, timeout, lock>`,
//     나머지는 `WATCH-ERROR <출처>: <이유>` 다. 알림 파일의 text 는 이 줄에서 kind 를 뺀 나머지(`tick 1`, `questions: offline`)다.
//     REMINDER 의 text 도 줄에서 `REMINDER ` 를 뺀 나머지다. 한 번 성공하면 이유를 지우고, 다시 실패하면 다시 쓴다. loop.log 에는 실패할 때마다 쓴다.
//     하네스는 백그라운드 명령의 stderr 를 알리지 않으므로 실패도 알림 파일로 보낸다. 틱마다 같은 실패로 코디네이터를 깨우지 않으려고 억제한다.
//     알림 파일의 HOOK-FAIL 은 tick 핸들러의 것만이다. worker-question 핸들러의 실패는 loop.log 의 HOOK-FAIL 줄로만 남는다.
//
// 로그: 모든 줄을 state/loop.log 에 붙이고 stdout 에도 쓴다. 붙이기 전에 1MB 를 넘으면 loop.log.1 로 돌린다.
//     --start 의 자식은 stdio 를 버린다. 파일 서술자를 자식에 넘기지 않는 것은 돌린 뒤에도 자식이 loop.log.1 에 쓰게 되기 때문이다.
//     틱 자식은 stdout 에만 쓴다. 부모가 그 줄을 loop.log 로 옮기므로 두 번 쓰이지 않는다.
//     잡지 않은 예외와 거부된 promise 는 스택을 로그에 남기고 1 로 끝난다.
//
// 설정: pipeline.tick_sec(양수, 기본 300), pipeline.stall_ticks({"error": 0 이상의 정수, "idle": 0 이상의 정수}. 위 「멈춤 확인」), finish.run, finish.specs_dir, queue.required, queue.skipped_is_missing(true 나 false).
//     finish 절은 lib/finish-options.ts 의 FINISH_KEYS 로, queue 절은 lib/config.ts 의 QUEUE_KEYS 로 읽는다.
//     pipeline.enabled 는 읽지 않는다. 이 루프가 하는 일은 모두 그 값과 무관하게 돈다.
//
// 환경 변수: ORCA(orca 실행 파일), GH(gh 실행 파일), CLEANUP_SWEEP(정리 명령. 기본은 이 폴더의 cleanup-sweep.ts),
//     BOARD_SYNC(보드 동기화 명령. 기본은 이 폴더의 board-sync.ts), SEND_TO_WORKER(worker 에게 보내는 명령. CI 감시와 충돌 처리가
//     쓴다. 기본은 이 폴더의 send-to-worker.ts), ORCH_LOOP_ALIVE_SEC(생존 타이머 간격)
//
// 종료 코드:
//     0  성공. --start 가 띄웠다, --stop 이 멈췄거나 루프가 없다, --status 가 살아 있다, --once 와 --tick 이 끝났다
//     1  --start 실패, --stop 시간 초과나 루프 프로세스인지 판정하지 못함, --status 가 죽었다, 잡지 않은 예외
//     2  사용법 오류와 설정 오류(ConfigError, ORCH_LOOP_ALIVE_SEC 가 양수가 아님)
//     4  살아 있는 루프가 있다(LOOP-RUNNING)
//     128 + 신호 번호  --foreground 나 --tick 이 신호를 받았다. --tick 의 부모가 사라지면 129(SIGHUP)

import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { context as questionContext } from './lib/completion.ts'
import { ConfigError, loadConfig, PIPELINE_KEYS, QUEUE_KEYS, section } from './lib/config.ts'
import { concludeConflict, findConflicts, loadNotified, notifiedFile, notifiedKey, resolveConflict, SEND_MS } from './lib/conflicts.ts'
import type { OpenPr, WorkerFound } from './lib/conflicts.ts'
import { fire, reclaim } from './lib/events.ts'
import { FINISH_KEYS } from './lib/finish-options.ts'
import { isFile } from './lib/fs.ts'
import { apiTarget, ciState, failedCheck, ghJson, isOwnPr, ownAuthors, requiredNames } from './lib/gh.ts'
import type { CiCheck, Names } from './lib/gh.ts'
import { defaultBase, mainCheckout } from './lib/git.ts'
import { appendEvent, DEFAULT_ALIVE_SEC, dropReadEvents, isLoopProcess, isRegistered, lockFile, loopStatus, readLoop, registeredRuns, registerRun, unregisterRun, writeLoop } from './lib/loop.ts'
import type { LoopState } from './lib/loop.ts'
import { orcaJson } from './lib/orca.ts'
import { remindDecisions } from './lib/board.ts'
import { boardPath, makeParent, pathOf } from './lib/paths.ts'
import { NO_LIMIT_MS, runAsync, scriptCommand, signalCode, STOP_GRACE_MS, stopChildren, stopping } from './lib/proc.ts'
import type { RunResult } from './lib/proc.ts'
import { alive } from './lib/process.ts'
import { notifyQuestion, poll } from './lib/questions.ts'
import { readScreen, screenLines, screenTail, stallHash } from './lib/screen.ts'
import { LIVE_DISPATCH, workerFor, workerRows, worktreePaths } from './lib/workers.ts'

const USAGE = [
  '사용법: orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] (--start | --stop [--all] | --status | --foreground) [--once]',
  '        orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] --tick --tick-number N',
].join('\n')
const SELF = fileURLToPath(import.meta.url)
const HERE = dirname(SELF)
const DEFAULT_TICK_SEC = 300
const REMIND_AFTER_SEC = 600
const START_WAIT_MS = 10_000
const STOP_WAIT_MS = 20_000
const POLL_MS = 100
const LOG_LIMIT = 1_048_576
// finish-pr 이 정리 명령에 주는 시간 제한과 같다
const SWEEP_TIMEOUT_MS = 600_000
// wx 로 만든 직후 pid 를 쓰기 전의 빈 잠금을 깨진 잠금으로 회수하지 않게, 이 시간 안의 빈 파일은 쥔 것으로 본다(lib/events.ts 와 같다)
const EMPTY_LOCK_GRACE_MS = 2_000
// 부모가 틱 자식 그룹에 TERM 을 보낸 뒤 KILL 까지 기다리는 시간. 틱 자식의 STOP_GRACE_MS 보다 길다(머리 주석의 「틱」)
const TICK_STOP_GRACE_MS = STOP_GRACE_MS + 3_000
// 틱 자식이 부모가 살아 있는지 보는 간격(머리 주석의 「틱」)
const PARENT_POLL_MS = 2_000
const MODES = ['start', 'stop', 'status', 'foreground', 'tick'] as const
// 저장소 공유 일의 오류 출처. 알림이 주 Run 에 가므로 키에 주 Run 을 붙인다(머리 주석의 「오류 줄 억제」)
const SHARED_SOURCES: ReadonlySet<string> = new Set(['prs', 'board', 'ci', 'conflicts', 'tick'])
// pipeline.stall_ticks 의 기본값(머리 주석의 「멈춤 확인」). idle 은 백그라운드 에이전트를 기다리는 정상 화면과 구분되지 않아 끈다
const DEFAULT_STALL_TICKS: Readonly<Record<StallState, number>> = Object.freeze({ error: 2, idle: 0 })

type Mode = (typeof MODES)[number]
type Context = { repo: string; run: string | null; specsDir: string | null; tickSec: number; skippedIsMissing: boolean; stallTicks: Record<StallState, number> }
type CiEntry = { head: string; state: 'passed' | 'failed' | 'pending' }
type TickResult = {
  tick_at: string
  errors: Record<string, string | null>
  open_prs: number[] | null
  ci?: Record<string, CiEntry>
  stalls?: Record<string, Stall>
}
type StallState = 'error' | 'idle'
type Stall = { run: string; terminal: string; state: StallState; hash: string; since: string; ticks: number; fired: boolean }

class Usage extends Error {}

// 로그 ------------------------------------------------------------------

// 틱 자식은 stdout 에만 쓴다(머리 주석의 「로그」)
let logFile: string | null = null

function log(line: string): void {
  if (logFile) {
    try {
      try {
        if (statSync(logFile).size > LOG_LIMIT) renameSync(logFile, `${logFile}.1`)
      } catch {
        // 아직 없다
      }
      appendFileSync(logFile, `${line}\n`)
    } catch (e) {
      process.stderr.write(`orch-loop: ${logFile} 에 쓰지 못했다: ${(e as Error).message}\n`)
    }
  }
  process.stdout.write(`${line}\n`)
}

function oneLine(value: unknown): string {
  return String((value as Error)?.message ?? value).replace(/\r?\n|\r/g, ' ')
}

function iso(): string {
  return new Date().toISOString()
}

// 설정 ------------------------------------------------------------------

function optionalString(value: unknown, key: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new ConfigError(`설정 파일의 ${key} 는 문자열이어야 한다`)
  return value
}

function stallTicks(value: unknown): Record<StallState, number> {
  if (value === undefined) return { ...DEFAULT_STALL_TICKS }
  const shape = '설정 파일의 pipeline.stall_ticks 는 {"error": 틱 수, "idle": 틱 수} 객체여야 한다'
  if (!isObject(value)) throw new ConfigError(shape)
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(DEFAULT_STALL_TICKS, key))
  if (unknown.length > 0) throw new ConfigError(`${shape}. 모르는 키: ${unknown.sort().join(', ')}`)
  const ticks = { ...DEFAULT_STALL_TICKS }
  for (const key of Object.keys(DEFAULT_STALL_TICKS) as StallState[]) {
    const n = value[key]
    if (n === undefined) continue
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new ConfigError(`설정 파일의 pipeline.stall_ticks.${key} 는 0 이상의 정수여야 한다: ${JSON.stringify(n)}`)
    ticks[key] = n
  }
  return ticks
}

function context(repo: string, run: string | undefined, specsDir: string | undefined): Context {
  const config = loadConfig(repo)
  const pipeline = section<{ tick_sec?: unknown; stall_ticks?: unknown }>(config, 'pipeline', PIPELINE_KEYS)
  const finish = section<{ run?: unknown; specs_dir?: unknown }>(config, 'finish', FINISH_KEYS)
  const queue = section<{ skipped_is_missing?: unknown }>(config, 'queue', QUEUE_KEYS)
  const skipped = queue.skipped_is_missing ?? false
  if (typeof skipped !== 'boolean') throw new ConfigError('설정 파일의 queue.skipped_is_missing 은 true 나 false 여야 한다')
  const tickSec = pipeline.tick_sec ?? DEFAULT_TICK_SEC
  if (typeof tickSec !== 'number' || !Number.isFinite(tickSec) || tickSec <= 0) {
    throw new ConfigError(`설정 파일의 pipeline.tick_sec 은 양수여야 한다: ${JSON.stringify(tickSec)}`)
  }
  return {
    repo,
    run: run || optionalString(finish.run, 'finish.run'),
    specsDir: specsDir || optionalString(finish.specs_dir, 'finish.specs_dir'),
    tickSec,
    skippedIsMissing: skipped,
    stallTicks: stallTicks(pipeline.stall_ticks),
  }
}

function aliveSec(): number {
  const raw = process.env.ORCH_LOOP_ALIVE_SEC
  if (raw === undefined || raw === '') return DEFAULT_ALIVE_SEC
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Usage(`ORCH_LOOP_ALIVE_SEC 는 양수 초여야 한다: ${raw}`)
  return value
}

function passArgs(ctx: Context): string[] {
  return ['--repo', ctx.repo, ...(ctx.run ? ['--run', ctx.run] : []), ...(ctx.specsDir ? ['--specs-dir', ctx.specsDir] : [])]
}

// 잠금 ------------------------------------------------------------------

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

function createLock(lock: string): boolean {
  let fd: number
  try {
    fd = openSync(lock, 'wx')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
  try {
    writeSync(fd, String(process.pid))
  } finally {
    closeSync(fd)
  }
  return true
}

// 잠금에 적힌 pid. 없거나 정수가 아니면 NaN
function lockPid(lock: string): number {
  const text = (readText(lock) ?? '').trim()
  return /^\d+$/.test(text) ? Number(text) : Number.NaN
}

// 잠금을 쥔 살아 있는 루프의 pid. 없거나, 죽었거나, 루프 프로세스가 아니면 null. 판정할 수 없으면 루프로 본다(머리 주석의 「한 저장소에 하나」)
function lockHolder(lock: string): number | null {
  const pid = lockPid(lock)
  return isLoopProcess(pid) !== false ? pid : null
}

function freshEmpty(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs < EMPTY_LOCK_GRACE_MS
  } catch {
    return false
  }
}

// 잠금을 얻으면 null, 살아 있는 다른 루프가 쥐고 있으면 그 pid 다.
async function takeLock(lock: string, repo: string): Promise<number | null> {
  makeParent(lock, repo)
  const deadline = Date.now() + START_WAIT_MS
  while (Date.now() < deadline) {
    if (createLock(lock)) return null
    const seen = readText(lock)
    if (seen === null) continue
    const text = seen.trim()
    // 루프 프로세스가 아닌 pid 는 죽은 잠금이다. 아래 reclaim 으로 회수한다. 판정할 수 없으면(null) 회수하지 않는다
    if (/^\d+$/.test(text) && isLoopProcess(Number(text)) !== false) return Number(text)
    if (text === '' && freshEmpty(lock)) {
      await sleep(POLL_MS)
      continue
    }
    if (reclaim(lock, seen) === 'wait') await sleep(POLL_MS)
  }
  throw new Error(`${lock} 를 ${START_WAIT_MS / 1000}초 안에 얻지 못했다`)
}

function releaseLock(lock: string): void {
  try {
    if ((readText(lock) ?? '').trim() === String(process.pid)) unlinkSync(lock)
  } catch {
    // 이미 없거나 다른 루프가 쥐었다. 남의 잠금은 지우지 않는다
  }
}

// --start, --stop, --status ------------------------------------------------

function runOf(state: LoopState | null, pid: number): string {
  return state && Number(state.pid) === pid && state.run ? state.run : '-'
}

function running(repo: string): { pid: number; run: string } | null {
  const status = loopStatus(repo, Date.now())
  if (status.alive) return { pid: Number(status.state.pid), run: status.state.run || '-' }
  const holder = lockHolder(lockFile(repo))
  return holder === null ? null : { pid: holder, run: runOf(readLoop(repo), holder) }
}

// 옛 루프는 loop.json 에 runs 가 없다. Run 등록을 모른다(ADR-012)
function legacyLoop(state: LoopState | null, pid?: number): boolean {
  return state !== null && !Array.isArray(state.runs) && (pid === undefined || Number(state.pid) === pid)
}

const LEGACY_HINT = '안내: 이 루프는 Run 등록을 모르는 옛 orch 로 띄운 루프다. 그 루프를 띄운 세션이 --stop 한 뒤 새 orch 로 --start 하면 여러 Run 을 함께 맡는다'

// 살아 있는 루프에 이 Run 을 더한다. 이미 맡고 있거나 Run 이 없으면 전처럼 LOOP-RUNNING 이다(머리 주석의 --start).
// raced 는 띄운 자식이 다른 --start 의 루프에 잠금을 져 4 로 끝난 경우다. 이 Run 은 띄우기 전에 등록했으므로 합류로 본다.
// loop.json 의 pid 가 찾은 pid 와 다르면 루프가 막 뜨는 중이다. 그 루프는 시작할 때 앞 루프의 alive_at 이전 등록을 지우므로,
// 이미 등록된 Run 이어도 registered_at 을 새로 써서 지워지지 않게 한다(머리 주석의 「Run」)
function joinLoop(ctx: Context, found: { pid: number; run: string }, raced: boolean): number {
  const state = readLoop(ctx.repo)
  const starting = state === null || Number(state.pid) !== found.pid
  if (ctx.run && legacyLoop(state, found.pid)) {
    // 옛 루프는 등록을 읽지 않는다. 띄우기 전에 쓴 등록을 남기지 않는다
    if (raced) unregisterRun(ctx.repo, ctx.run)
    log(`LOOP-RUNNING ${found.pid} run=${found.run}`)
    if (found.run !== ctx.run) log(LEGACY_HINT)
    return 4
  }
  if (ctx.run && (raced || !isRegistered(ctx.repo, ctx.run))) {
    registerRun(ctx.repo, ctx.run, ctx.specsDir, starting)
    log(`LOOP-JOINED ${found.pid} run=${ctx.run}`)
    return 0
  }
  if (ctx.run && starting) registerRun(ctx.repo, ctx.run, ctx.specsDir, true)
  log(`LOOP-RUNNING ${found.pid} run=${ctx.run && isRegistered(ctx.repo, ctx.run) ? ctx.run : found.run}`)
  return 4
}

async function start(ctx: Context): Promise<number> {
  const found = running(ctx.repo)
  if (found) return joinLoop(ctx, found, false)
  // registered_at 을 새로 쓴다. 새로 뜬 루프는 앞 루프의 alive_at 뒤에 쓴 등록을 살아 있는 세션의 것으로 보고 남긴다(머리 주석의 「Run」)
  if (ctx.run) registerRun(ctx.repo, ctx.run, ctx.specsDir, true)
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SELF, ...passArgs(ctx), '--foreground'], {
    cwd: ctx.repo,
    detached: true,
    stdio: 'ignore',
  })
  let exited: number | null = null
  let failed: string | null = null
  child.on('exit', (code, signal) => {
    exited = code ?? signalCode(signal ?? 'SIGTERM')
  })
  child.on('error', (e) => {
    failed = e.message
  })
  child.unref()
  const pid = child.pid
  const deadline = Date.now() + START_WAIT_MS
  while (Date.now() < deadline) {
    if (failed !== null) {
      log(`LOOP-START-FAIL 루프를 띄우지 못했다: ${failed}`)
      return 1
    }
    const state = readLoop(ctx.repo)
    if (pid !== undefined && state && Number(state.pid) === pid) {
      log(`LOOP-STARTED ${pid} run=${state.run || '-'}`)
      return 0
    }
    if (exited === 4) {
      // 동시에 --start 한 다른 세션의 루프가 먼저 잠금을 쥐었다. 그 루프에 합류한다
      const other = running(ctx.repo)
      if (other) return joinLoop(ctx, other, true)
    }
    if (exited !== null) {
      log(`LOOP-START-FAIL 루프가 loop.json 을 쓰기 전에 종료 코드 ${exited} 로 끝났다`)
      return 1
    }
    await sleep(POLL_MS)
  }
  // 늦게라도 살아나 따로 도는 루프를 남기지 않는다. 실패로 알린 루프가 돌면 코디네이터가 모르는 루프가 된다
  if (pid !== undefined) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 이미 끝났다
    }
  }
  log(`LOOP-START-FAIL ${START_WAIT_MS / 1000}초 안에 loop.json 에 pid ${pid ?? '-'} 를 쓰지 않아 끝냈다`)
  return 1
}

// 머리 주석의 --stop. run 을 주면 그 Run 만 빼고, 남은 Run 이 없을 때만 루프를 멈춘다
async function stop(repo: string, run: string | null, all: boolean): Promise<number> {
  const state = readLoop(repo)
  if (run !== null) {
    if (legacyLoop(state) && state?.run && state.run !== run && isLoopProcess(Number(state.pid)) !== false) {
      // 옛 루프는 다른 Run 의 것이다. 그 세션의 루프를 끊지 않는다
      log(`LOOP-NOT-REGISTERED run=${run}`)
      log(LEGACY_HINT)
      return 0
    }
    const removed = unregisterRun(repo, run)
    if (removed) dropEvents(repo, run)
    const left = registeredRuns(repo)
    // 등록돼 있지 않던 Run 은 루프를 멈추지 않는다. Run 없이 띄운 루프는 --run 없는 --stop 으로 멈춘다
    if (!removed && !legacyLoop(state)) {
      log(`LOOP-NOT-REGISTERED run=${run}`)
      return 0
    }
    if (left.length > 0) {
      log(`LOOP-LEFT ${state?.pid ?? '-'} run=${run} runs=${left.map((e) => e.run).join(',')}`)
      return 0
    }
    return stopProcess(repo, run)
  } else if (!all) {
    const runs = registeredRuns(repo)
    // 등록이 하나뿐이어도 다른 세션의 Run 일 수 있다. --run 없이는 멈추지 않는다
    if (runs.length > 0 && isLoopProcess(Number(state?.pid)) !== false) {
      log(`LOOP-STOP-SHARED ${state?.pid ?? '-'} runs=${runs.map((e) => e.run).join(',')}`)
      log('Run 이 등록된 루프는 --run 없이 멈추지 않는다. 자기 Run 만 빼려면 --stop --run, 모두 멈추려면 --stop --all 이다')
      return 1
    }
  }
  for (const entry of registeredRuns(repo)) {
    if (unregisterRun(repo, entry.run)) dropEvents(repo, entry.run)
  }
  return stopProcess(repo, null)
}

// 뺀 Run 의 알림 파일과 커서를 지운다. 읽지 않은 줄이 있으면 남긴다(lib/loop.ts 의 「알림 파일 지우기」). 지우지 못해도 --stop 은 이어 간다
function dropEvents(repo: string, run: string): void {
  try {
    dropReadEvents(repo, run)
  } catch (e) {
    log(`orch-loop: Run ${run} 의 알림 파일을 지우지 못했다: ${oneLine(e)}`)
  }
}

// left 는 방금 등록을 뺀 Run 이다. 있으면 신호를 보내기 직전에 등록을 다시 본다. 마지막 Run 을 뺀 사이 다른 세션이 합류했으면 멈추지 않는다
async function stopProcess(repo: string, left: string | null): Promise<number> {
  const joined = left !== null ? registeredRuns(repo) : []
  if (joined.length > 0) {
    log(`LOOP-LEFT ${readLoop(repo)?.pid ?? '-'} run=${left} runs=${joined.map((e) => e.run).join(',')}`)
    return 0
  }
  const candidates = [Number(readLoop(repo)?.pid), lockPid(lockFile(repo))]
  const verdicts = candidates.map((p) => ({ pid: p, loop: isLoopProcess(p) }))
  const pid = verdicts.find((v) => v.loop === true)?.pid
  if (pid === undefined) {
    // 루프가 아닌 프로세스에 TERM 을 보내지 않는다(머리 주석의 --stop)
    const unknown = verdicts.find((v) => v.loop === null)
    if (unknown) {
      log(`LOOP-STOP-UNKNOWN ${unknown.pid} ps 로 루프 프로세스인지 판정하지 못해 신호를 보내지 않았다`)
      return 1
    }
    log('LOOP-NOT-RUNNING')
    return 0
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
  }
  const deadline = Date.now() + STOP_WAIT_MS
  while (alive(pid)) {
    if (Date.now() >= deadline) {
      log(`LOOP-STOP-TIMEOUT ${pid}`)
      return 1
    }
    await sleep(POLL_MS)
  }
  log(`LOOP-STOPPED ${pid}`)
  return 0
}

function status(repo: string): number {
  const found = loopStatus(repo, Date.now())
  if (!found.alive) {
    log(`LOOP-DEAD ${repo} ${found.reason}`)
    return 1
  }
  const { state } = found
  log(`LOOP-ALIVE ${state.pid} run=${state.run || '-'} last_tick=${state.last_tick || '-'} alive_at=${state.alive_at}`)
  return 0
}

// --foreground ------------------------------------------------------------

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== '')
}

// 틱 자식의 출력에서 결과 줄을 꺼내고 나머지를 로그로 옮긴다
function tickResult(done: RunResult): { result: TickResult | null; reason: string | null } {
  const out = lines(done.stdout)
  let result: TickResult | null = null
  const last = out.at(-1)
  if (last !== undefined) {
    try {
      const parsed = JSON.parse(last) as TickResult
      if (parsed && typeof parsed === 'object' && typeof parsed.tick_at === 'string') {
        result = parsed
        out.pop()
      }
    } catch {
      // 결과 줄이 아니다
    }
  }
  for (const line of [...out, ...lines(done.stderr)]) log(line)
  // 결과 줄이 있으면 종료 코드와 상관없이 낸다(머리 주석의 「틱」)
  if (done.code !== 0) return { result, reason: `종료 코드 ${done.code}` }
  if (!result) return { result: null, reason: '결과 줄 없음' }
  return { result, reason: null }
}

async function foreground(ctx: Context, once: boolean, interval: number): Promise<number> {
  const lock = lockFile(ctx.repo)
  const holder = await takeLock(lock, ctx.repo)
  if (holder !== null) {
    log(`LOOP-RUNNING ${holder} run=${runOf(readLoop(ctx.repo), holder)}`)
    return 4
  }
  process.on('exit', () => releaseLock(lock))
  // 새로 뜬 루프는 앞 루프가 마지막으로 살아 있던 때(alive_at)까지의 등록을 지운다. 끝난 세션의 Run 을 계속 맡지 않게 한다.
  // 그 뒤의 등록은 살아 있는 세션이 동시에 --start 한 것이라 남긴다. 앞 loop.json 이 없으면 지우지 않는다(머리 주석의 「Run」)
  const before = readLoop(ctx.repo)
  const cutoff = typeof before?.alive_at === 'string' ? Date.parse(before.alive_at) : Number.NaN
  for (const entry of registeredRuns(ctx.repo)) {
    if (entry.run === ctx.run || !Number.isFinite(cutoff)) continue
    const at = Date.parse(entry.registered_at)
    if (Number.isFinite(at) && at > cutoff) continue
    unregisterRun(ctx.repo, entry.run)
    log(`앞 루프의 Run ${entry.run} 등록을 지웠다. 그 세션이 살아 있으면 대기가 미등록으로 깨어나 다시 등록한다`)
  }
  if (ctx.run) registerRun(ctx.repo, ctx.run, ctx.specsDir)
  let runs = registeredRuns(ctx.repo).map((entry) => entry.run)
  // 등록된 Run 이 있던 루프는 마지막 Run 이 빠지면 끝난다. 처음부터 Run 이 없던 루프는 --stop 까지 돈다(머리 주석의 「Run」)
  let hadRuns = runs.length > 0
  const previous = readLoop(ctx.repo)
  const errors = previous && typeof previous.errors === 'object' && previous.errors !== null && !Array.isArray(previous.errors) ? previous.errors : {}
  const ci = ciEntries(previous?.ci)
  const stalls = stallEntries(previous?.stalls)
  const now = iso()
  const state: LoopState = {
    pid: process.pid,
    run: runs[0] ?? ctx.run,
    runs,
    repo: ctx.repo,
    tick_sec: ctx.tickSec,
    started_at: now,
    alive_at: now,
    last_tick: null,
    ticks: 0,
    errors: { ...errors },
    ci,
    stalls,
  }
  writeLoop(ctx.repo, state)
  if (runs.length === 0 && !ctx.run) log('경고: Run id 가 없어 질문 확인을 건너뛴다. --run 이나 finish.run 으로 준다')
  const timer = setInterval(() => {
    state.alive_at = iso()
    try {
      writeLoop(ctx.repo, state)
    } catch (e) {
      log(`orch-loop: loop.json 에 alive_at 을 쓰지 못했다: ${oneLine(e)}`)
    }
  }, interval * 1000)
  try {
    for (let n = 1; ; n++) {
      runs = registeredRuns(ctx.repo).map((entry) => entry.run)
      if (hadRuns && runs.length === 0) {
        log('LOOP-EMPTY 등록된 Run 이 없어 루프를 끝낸다')
        return 0
      }
      hadRuns ||= runs.length > 0
      state.runs = runs
      state.run = runs[0] ?? ctx.run
      log(`tick ${n} ${iso()}`)
      const done = await runAsync(scriptCommand(SELF, [...passArgs(ctx), '--tick', '--tick-number', String(n)]), {
        cwd: ctx.repo,
        timeoutMs: NO_LIMIT_MS,
        group: true,
      })
      // 신호로 끝내는 중이면 끊긴 틱을 실패로 알리지 않는다
      const signal = stopping()
      if (signal) return signalCode(signal)
      const { result, reason } = tickResult(done)
      if (result) {
        state.last_tick = result.tick_at
        for (const [source, value] of Object.entries(result.errors ?? {})) state.errors[source] = value ?? null
        // 열린 PR 을 읽지 못한 틱은 ci 가 없다. 그때는 이전 값을 둔다
        if (isObject(result.ci)) state.ci = ciEntries(result.ci)
        // 멈춤 확인이 실패한 틱은 stalls 가 없다. 그때도 이전 값을 둔다
        if (isObject(result.stalls)) state.stalls = stallEntries(result.stalls)
      }
      state.ticks = n
      const tickKey = state.run ? `tick@${state.run}` : 'tick'
      if (reason !== null) {
        log(`WATCH-ERROR tick: ${reason}`)
        if (state.errors[tickKey] !== reason) {
          try {
            appendEvent(ctx.repo, 'WATCH-ERROR', null, `tick: ${reason}`, state.run)
          } catch (e) {
            log(`orch-loop: 알림 파일에 쓰지 못했다: ${oneLine(e)}`)
          }
        }
      }
      state.errors[tickKey] = reason
      dropStaleErrors(state.errors, runs, state.run)
      state.alive_at = iso()
      writeLoop(ctx.repo, state)
      if (once) return 0
      await sleep(ctx.tickSec * 1000)
    }
  } finally {
    clearInterval(timer)
  }
}

// 지난 오류 키를 지운다(머리 주석의 「오류 줄 억제」). runs 는 등록된 Run, primary 는 주 Run 이다
function dropStaleErrors(errors: Record<string, string | null>, runs: string[], primary: string | null): void {
  for (const key of Object.keys(errors)) {
    const at = key.indexOf('@')
    const source = at > 0 ? key.slice(0, at) : key
    const run = at > 0 ? key.slice(at + 1) : null
    if (run !== null && !runs.includes(run)) delete errors[key]
    else if (SHARED_SOURCES.has(source) && primary && run !== primary) delete errors[key]
  }
}

// --tick ------------------------------------------------------------------

// 내 열린 PR 의 행. CI 감시가 쓰는 필드를 함께 읽는다
type OwnPr = {
  number: number
  title: string | null
  branch: string
  head: string
  author: string
  draft: boolean
  base: string
  url: string
  host: string
  slug: string
  rollup: unknown
}
type Prs = { ok: true; mine: OwnPr[] } | { ok: false; error: string }
const PR_FIELDS = 'number,author,url,title,headRefName,headRefOid,isDraft,baseRefName,statusCheckRollup'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function openPrs(repo: string): Prs {
  const got = ghJson<unknown>(['pr', 'list', '--state', 'open', '--limit', '200', '--json', PR_FIELDS], { cwd: repo })
  if (!got.ok) return got
  if (!Array.isArray(got.data)) return { ok: false, error: 'gh pr list 의 출력이 목록이 아니다' }
  const authors = new Map<string, string[]>()
  const mine: OwnPr[] = []
  for (const pr of got.data) {
    if (!isObject(pr) || !Number.isInteger(pr.number)) return { ok: false, error: 'gh pr list 의 행을 읽지 못했다' }
    const url = typeof pr.url === 'string' ? pr.url : ''
    const target = apiTarget(url)
    const host = target?.host
    if (!target || !host) return { ok: false, error: `PR #${pr.number} 의 URL 을 읽지 못했다` }
    if (!authors.has(host)) {
      const own = ownAuthors(repo, host)
      if (!own) return { ok: false, error: `내 PR 의 작성자를 정하지 못했다(${host} 의 gh api user 실패). config.json 의 pipeline.authors 로 준다` }
      authors.set(host, own)
    }
    const login = isObject(pr.author) && typeof pr.author.login === 'string' ? pr.author.login : ''
    if (!login || !isOwnPr({ author: { login } }, authors.get(host) ?? [])) continue
    const text = (value: unknown) => (typeof value === 'string' ? value : '')
    mine.push({
      number: pr.number as number,
      title: typeof pr.title === 'string' ? pr.title : null,
      branch: text(pr.headRefName),
      head: text(pr.headRefOid),
      author: login,
      draft: pr.isDraft === true,
      base: text(pr.baseRefName),
      url,
      host,
      slug: target.slug,
      rollup: pr.statusCheckRollup,
    })
  }
  return { ok: true, mine }
}

// loop.json 의 ci 에서 형식이 맞는 항목만 남긴다
function ciEntries(value: unknown): Record<string, CiEntry> {
  const entries: Record<string, CiEntry> = {}
  if (!isObject(value)) return entries
  for (const [number, entry] of Object.entries(value)) {
    if (isObject(entry) && typeof entry.head === 'string' && (entry.state === 'passed' || entry.state === 'failed' || entry.state === 'pending')) {
      entries[number] = { head: entry.head, state: entry.state }
    }
  }
  return entries
}

function prInput(pr: OwnPr): Record<string, unknown> {
  return { number: pr.number, title: pr.title, branch: pr.branch || null, head: pr.head || null, author: pr.author, draft: pr.draft, url: pr.url }
}

// 이번 틱이 맡는 Run. 앞이 주 Run 이다. 등록된 Run 이 없으면 --run(또는 finish.run) 하나이거나, 그것도 없으면 Run 없는 한 칸이다
type TickRun = { run: string | null; specsDir: string | null }

function tickRuns(ctx: Context): TickRun[] {
  const entries = registeredRuns(ctx.repo)
  if (entries.length === 0) return [{ run: ctx.run, specsDir: ctx.specsDir }]
  return entries.map((entry) => ({ run: entry.run, specsDir: entry.specs_dir }))
}

// 틱 안에서 한 번만 읽는 워크트리 목록과 Run 마다의 worker 행. runs 는 이번 틱이 맡는 Run 이다
type Lookup = { runs: TickRun[]; paths?: Map<string, string>; rows: Map<string, ReturnType<typeof workerRows>> }
type Owner = { run: string | null; row: Record<string, unknown> }

// 그 워크트리의 worker 와 그 worker 를 띄운 Run. 맡은 Run 을 차례로 보고, 살아 있는 dispatch 가 있는 Run 을 먼저 고른다.
// worker 가 없으면 found 가 null 이다. 살아 있는 dispatch 를 찾지 못했고 읽지 못한 Run 이 있으면 ok 가 false 다
function ownerOf(path: string, lookup: Lookup): { ok: true; found: Owner | null } | { ok: false; error: string } {
  let error: string | null = null
  let ended: Owner | null = null
  for (const { run } of lookup.runs) {
    const rows = rowsOf(run ?? '', lookup)
    if (!rows.ok) {
      error ??= rows.error
      continue
    }
    const row = workerFor(rows.rows, path)
    if (!row) continue
    if (LIVE_DISPATCH.has(String(row.dispatchStatus))) return { ok: true, found: { run, row } }
    ended ??= { run, row }
  }
  // 읽지 못한 Run 에 살아 있는 worker 가 있을 수 있다. 끝난 worker 를 고르지 않고 읽지 못한 것으로 본다
  if (error !== null) return { ok: false, error }
  return { ok: true, found: ended }
}

// 체크가 실패한 PR 의 살아 있는 dispatch 에 보낸다. text 는 CI-FAILED 의 text 에 붙일 말, run 은 그 worker 를 띄운 Run 이다
// (모르면 null. 알림은 주 Run 에 간다. 머리 주석의 「CI 감시」)
async function tellWorker(ctx: Context, pr: OwnPr, failed: CiCheck[], lookup: Lookup): Promise<{ text: string; run: string | null }> {
  if (!lookup.runs.some((entry) => entry.run)) return { text: 'Run id 없음', run: null }
  lookup.paths ??= worktreePaths(ctx.repo)
  const path = lookup.paths.get(pr.branch)
  if (!path) return { text: '살아 있는 dispatch 없음', run: null }
  const owner = ownerOf(path, lookup)
  if (!owner.ok) {
    log(`orch-loop: worker 목록을 읽지 못했다: ${oneLine(owner.error)}`)
    return { text: 'worker 목록을 읽지 못했다', run: null }
  }
  const found = owner.found
  if (!found || !found.run || !LIVE_DISPATCH.has(String(found.row.dispatchStatus))) return { text: '살아 있는 dispatch 없음', run: found?.run ?? null }
  const dispatch = String(found.row.dispatchId)
  const shown = failed.map((check) => (check.url ? `${check.name} ${check.url}` : check.name)).join(', ')
  const body = `PR #${pr.number} 의 체크가 실패했다: ${shown}. 실패를 고치고 검사를 다시 돌린 뒤 push 한다. 끝나면 status 로 알린다.`
  const send = process.env.SEND_TO_WORKER || join(HERE, 'send-to-worker.ts')
  const sent = await runAsync(scriptCommand(send, ['--dispatch', dispatch, '--body', body, '--run', found.run]), { cwd: ctx.repo, timeoutMs: SEND_MS })
  relay(sent)
  if (sent.code === 0) return { text: `보냈다 ${dispatch}`, run: found.run }
  if (sent.code === 4) return { text: '깨우지 못했다(종료 코드 4)', run: found.run }
  return { text: `보내지 못했다(종료 코드 ${sent.code})`, run: found.run }
}

async function fireCi(event: 'ci-passed' | 'ci-failed', ctx: Context, pr: OwnPr, checks: CiCheck[], required: string[], run: string | null): Promise<void> {
  try {
    // 핸들러의 실패는 fire 가 낸 HOOK-FAIL 줄로만 남는다. 알림 파일의 HOOK-FAIL 은 tick 핸들러의 것만이다
    await fire(event, { pr: prInput(pr), checks, required }, { repo: ctx.repo, base: pr.base, run })
  } catch (e) {
    log(`orch-loop: ${event} 를 내지 못했다: ${oneLine(e)}`)
  }
}

function primaryRun(lookup: Lookup): string | null {
  return lookup.runs[0]?.run ?? null
}

// 그 PR 워크트리의 worker 를 띄운 Run. 모르거나 읽지 못하면 주 Run 이다
function runOfPr(ctx: Context, pr: OwnPr, lookup: Lookup): string | null {
  lookup.paths ??= worktreePaths(ctx.repo)
  const path = lookup.paths.get(pr.branch)
  const owner = path ? ownerOf(path, lookup) : null
  return (owner?.ok && owner.found?.run) || primaryRun(lookup)
}

// CI 감시(머리 주석의 「CI 감시」). ci 는 결과 줄에 담을 값, error 는 errors.ci 에 둘 이유다
async function watchCi(ctx: Context, mine: OwnPr[], previous: Record<string, CiEntry>, lookup: Lookup): Promise<{ ci: Record<string, CiEntry>; error: string | null }> {
  const ci: Record<string, CiEntry> = {}
  const rules = new Map<string, Names>()
  const errors: string[] = []
  for (const pr of mine) {
    const key = String(pr.number)
    const before = previous[key]
    if (pr.draft) {
      if (before) ci[key] = before
      continue
    }
    const where = `${pr.host} ${pr.slug} ${pr.base}`
    let names = rules.get(where)
    if (!names) {
      try {
        names = requiredNames(ctx.repo, pr.host, pr.slug, pr.base)
      } catch (e) {
        names = { ok: false, error: oneLine(e) }
      }
      rules.set(where, names)
      if (!names.ok) errors.push(`${pr.base} 의 필수 체크 규칙을 읽지 못했다: ${oneLine(names.error)}`)
    }
    if (!names.ok) {
      if (before) ci[key] = before
      continue
    }
    const judged = ciState(pr.rollup, names.names, ctx.skippedIsMissing)
    const entry: CiEntry = { head: pr.head, state: judged.state }
    ci[key] = entry
    if (before && before.head === entry.head && before.state === entry.state) continue
    if (entry.state === 'passed') {
      log(`CI-PASSED #${pr.number} ${pr.head.slice(0, 8)}`)
      await fireCi('ci-passed', ctx, pr, judged.checks, names.names, runOfPr(ctx, pr, lookup))
    } else if (entry.state === 'failed') {
      const failed = judged.checks.filter(failedCheck)
      let told: { text: string; run: string | null }
      try {
        told = await tellWorker(ctx, pr, failed, lookup)
      } catch (e) {
        told = { text: `보내지 못했다(${oneLine(e)})`, run: null }
      }
      const text = `${failed.map((check) => check.name).join(', ')}: ${told.text}`
      const run = told.run ?? primaryRun(lookup)
      log(`CI-FAILED #${pr.number} ${text}`)
      try {
        appendEvent(ctx.repo, 'CI-FAILED', pr.number, text, run)
      } catch (e) {
        log(`orch-loop: 알림 파일에 쓰지 못했다: ${oneLine(e)}`)
      }
      await fireCi('ci-failed', ctx, pr, judged.checks, names.names, run)
    }
  }
  return { ci, error: errors.length > 0 ? errors.join('; ') : null }
}

// 멈춤 확인 ------------------------------------------------------------------

// 미답변 질문을 보낸 worker 의 dispatch 와 터미널. null 은 그 Run 의 질문을 읽지 못한 것이다
type Waiting = { dispatches: Set<string>; terminals: Set<string> } | null

function askers(pending: Record<string, unknown>[]): Waiting {
  const dispatches = new Set<string>()
  const terminals = new Set<string>()
  for (const message of pending) {
    const dispatch = questionContext(message)[1]
    if (dispatch) dispatches.add(String(dispatch))
    if (message.from_handle) terminals.add(String(message.from_handle))
  }
  return { dispatches, terminals }
}

// loop.json 의 stalls 에서 형식이 맞는 항목만 남긴다
function stallEntries(value: unknown): Record<string, Stall> {
  const entries: Record<string, Stall> = {}
  if (!isObject(value)) return entries
  for (const [dispatch, e] of Object.entries(value)) {
    if (!isObject(e) || (e.state !== 'error' && e.state !== 'idle')) continue
    if (typeof e.run !== 'string' || typeof e.terminal !== 'string' || typeof e.hash !== 'string' || typeof e.since !== 'string') continue
    if (typeof e.ticks !== 'number' || !Number.isInteger(e.ticks) || e.ticks < 0 || typeof e.fired !== 'boolean') continue
    entries[dispatch] = { run: e.run, terminal: e.terminal, state: e.state, hash: e.hash, since: e.since, ticks: e.ticks, fired: e.fired }
  }
  return entries
}

function rowsOf(run: string, lookup: Lookup): ReturnType<typeof workerRows> {
  let rows = lookup.rows.get(run)
  if (!rows) {
    rows = workerRows(run)
    lookup.rows.set(run, rows)
  }
  return rows
}

// 머리 주석의 「멈춤 확인」. stalls 는 결과 줄에 담을 값, errors 는 Run 마다 errors 의 stalls@<Run> 에 둘 이유다
async function watchStalls(
  ctx: Context,
  lookup: Lookup,
  previous: Record<string, Stall>,
  waiting: Map<string, Waiting>,
  base: string,
): Promise<{ stalls: Record<string, Stall>; errors: Map<string, string | null> }> {
  const stalls: Record<string, Stall> = {}
  const errors = new Map<string, string | null>()
  const keep = (dispatch: string) => {
    if (previous[dispatch]) stalls[dispatch] = previous[dispatch]
  }
  for (const { run } of lookup.runs) {
    if (!run) continue
    const rows = rowsOf(run, lookup)
    if (!rows.ok) {
      // 읽지 못한 Run 의 멈춤은 그대로 둔다. 다음 틱이 이어서 센다
      for (const [dispatch, entry] of Object.entries(previous)) if (entry.run === run) keep(dispatch)
      errors.set(run, `worker 목록을 읽지 못했다: ${oneLine(rows.error)}`)
      continue
    }
    const failed: string[] = []
    for (const row of rows.rows) {
      const dispatch = String(row.dispatchId ?? '')
      const terminal = String(row.agentTerminalHandle ?? '')
      if (!dispatch || !terminal || !LIVE_DISPATCH.has(String(row.dispatchStatus))) continue
      const read = orcaJson<Record<string, unknown>>(['terminal', 'read', '--terminal', terminal, '--screen'])
      if (!read.ok || !isObject(read.data)) {
        keep(dispatch)
        failed.push(`${terminal} 화면을 읽지 못했다: ${oneLine(read.ok ? '결과가 객체가 아니다' : read.error)}`)
        continue
      }
      const lines = screenLines(read.data)
      const screen = readScreen(lines)
      if (screen.state !== 'error' && screen.state !== 'idle') continue
      const state: StallState = screen.state
      const limit = ctx.stallTicks[state]
      if (limit === 0) continue
      if (state === 'idle') {
        const asked = waiting.get(run) ?? null
        // 질문을 읽지 못했으면 질문을 기다리는지 모른다. 세지도 지우지도 않는다
        if (asked === null) {
          keep(dispatch)
          continue
        }
        if (asked.dispatches.has(dispatch) || asked.terminals.has(terminal)) continue
      }
      const hash = stallHash(screen)
      const before = previous[dispatch]
      const continued = before && before.state === state && before.terminal === terminal
      // 화면만 바뀐 멈춤(다시 시도한 worker 가 같은 오류로 끝남)은 since 를 두고 새 멈춤으로 센다. 핸들러가 since 로 횟수를 센다
      const entry: Stall = !continued
        ? { run, terminal, state, hash, since: iso(), ticks: 1, fired: false }
        : before.hash === hash
          ? { ...before, run, ticks: before.ticks + 1 }
          : { ...before, run, hash, ticks: 1, fired: false }
      stalls[dispatch] = entry
      if (entry.ticks < limit || entry.fired) continue
      if (await notifyStall(ctx, run, row, entry, screenTail(lines), base)) {
        // 핸들러가 처리했다. 다시 시도한 뒤에도 화면이 그대로면 해시가 같으므로, 처음부터 다시 세 핸들러를 다시 부른다
        entry.ticks = 0
      } else {
        entry.fired = true
      }
    }
    errors.set(run, failed.length > 0 ? failed.join('; ') : null)
  }
  return { stalls, errors }
}

// worker-stalled 를 내고, 핸들러가 0 으로 끝나지 않았으면 그 Run 의 알림 파일에 WORKER-STALLED 를 쓴다(머리 주석의 「멈춤 확인」).
// 핸들러가 0 으로 끝났으면 true 다
async function notifyStall(ctx: Context, run: string, row: Record<string, unknown>, entry: Stall, lines: string[], base: string): Promise<boolean> {
  const dispatch = String(row.dispatchId)
  const resource = isObject(row.resource) ? row.resource : {}
  const id = String(resource.worktreeId ?? '')
  const worktree = id.includes('::') ? id.slice(id.indexOf('::') + 2) : null
  const text = `${dispatch} ${entry.state} ${entry.ticks}틱 ${entry.terminal}`
  log(`WORKER-STALLED ${text}`)
  let handled = false
  try {
    const fired = await fire(
      'worker-stalled',
      {
        worker: { task: row.taskId ?? null, dispatch, terminal: entry.terminal, worktree, spec: null },
        state: entry.state,
        since: entry.since,
        ticks: entry.ticks,
        lines,
      },
      { repo: ctx.repo, base, run },
    )
    handled = fired.result === 'pass'
  } catch (e) {
    log(`orch-loop: worker-stalled 를 내지 못했다: ${oneLine(e)}`)
  }
  if (handled) return true
  try {
    appendEvent(ctx.repo, 'WORKER-STALLED', null, text, run)
  } catch (e) {
    log(`orch-loop: 알림 파일에 쓰지 못했다: ${oneLine(e)}`)
  }
  return false
}

// 충돌 처리(머리 주석의 「충돌 처리」). 결과는 errors.conflicts 에 둘 이유다
async function handleConflicts(ctx: Context, lookup: Lookup): Promise<string | null> {
  const base = defaultBase(ctx.repo) ?? 'main'
  const found = findConflicts(ctx.repo, base)
  if (!found.ok) return oneLine(found.error)
  const { baseSha } = found
  const authors = new Map<string, string[]>()
  const mine: { pr: OpenPr; files: string[] }[] = []
  for (const item of found.found) {
    const host = apiTarget(item.pr.url)?.host
    if (!host) return `#${item.pr.number} 의 PR URL 을 읽지 못했다: ${JSON.stringify(item.pr.url ?? null)}`
    if (!authors.has(host)) {
      const own = ownAuthors(ctx.repo, host)
      if (!own) return `내 PR 의 작성자를 정하지 못했다(${host} 의 gh api user 실패). config.json 의 pipeline.authors 로 준다`
      authors.set(host, own)
    }
    if (isOwnPr({ author: { login: item.pr.author?.login ?? '' } }, authors.get(host) ?? [])) mine.push(item)
  }
  const statePath = notifiedFile(ctx.repo)
  const state = loadNotified(statePath)
  const primary = primaryRun(lookup)
  const errors = new Set<string>()
  for (const { pr, files } of mine) {
    if (Object.hasOwn(state, notifiedKey(pr.number, baseSha))) continue
    log(`#${pr.number} CONFLICTING ${pr.headRefName}: ${files.join(' ')}`)
    lookup.paths ??= worktreePaths(ctx.repo)
    const path = lookup.paths.get(pr.headRefName)
    let target: WorkerFound
    // 그 worker 를 띄운 Run. 모르면 주 Run 이다(ADR-012)
    let run = primary
    if (!path) {
      target = { orphan: '워크트리 없음. 새 worker 는 띄우지 않는다' }
    } else {
      const owner = ownerOf(path, lookup)
      if (!owner.ok) {
        // 알리지도 기록하지도 않는다. 다음 틱이 다시 본다
        errors.add(`worker 목록을 읽지 못했다: ${oneLine(owner.error)}`)
        continue
      }
      if (owner.found) run = owner.found.run ?? primary
      target = owner.found ? { path, row: owner.found.row } : { orphan: '그 워크트리의 dispatch 없음. 새 worker 는 띄우지 않는다' }
    }
    const fireCtx = { repo: ctx.repo, base, run }
    const outcome = await resolveConflict({ repo: ctx.repo, base, baseSha, pr, files, found: target, run, dryRun: false, out: log })
    if (outcome.kind === 'usage') {
      errors.add('send-to-worker 사용법 오류')
      break
    }
    if (outcome.kind !== 'record') continue
    await concludeConflict(statePath, ctx.repo, fireCtx, pr, files, baseSha, outcome)
    if (outcome.action === 'orphan') {
      try {
        appendEvent(ctx.repo, 'CONFLICT-ORPHAN', pr.number, outcome.reason ?? '', run)
      } catch (e) {
        log(`orch-loop: 알림 파일에 쓰지 못했다: ${oneLine(e)}`)
      }
    }
  }
  return errors.size > 0 ? [...errors].join('; ') : null
}

function relay(done: RunResult): void {
  for (const line of [...lines(done.stdout), ...lines(done.stderr)]) log(line)
}

async function tick(ctx: Context, n: number): Promise<number> {
  const loaded = readLoop(ctx.repo)
  const before = loaded?.errors
  const previous = isObject(before) ? before : {}
  const errors: Record<string, string | null> = {}
  const runs = tickRuns(ctx)
  const primary = runs[0].run
  // errors 키는 `<출처>@<Run>` 이다. 공유 출처는 주 Run 이 Run 이다. Run 없는 한 칸이면 출처 이름 그대로다(머리 주석의 「오류 줄 억제」)
  const keyOf = (source: string, run: string | null) => (run ? `${source}@${run}` : source)
  // 출처의 실패를 기록한다. 이유가 이전과 다를 때만 그 Run 의 알림 파일에 쓴다(머리 주석의 「오류 줄 억제」).
  // 로그 줄은 `<kind> <text>` 이고 알림 파일의 text 는 kind 를 뺀 나머지다. logged 면 그 줄은 이미 stdout 에 나갔다(fire 의 HOOK-FAIL 줄)
  const report = (source: string, reason: string | null, opts: { run?: string | null; kind?: string; text?: string; logged?: boolean } = {}) => {
    const run = opts.run === undefined ? primary : opts.run
    const key = keyOf(source, run)
    const kind = opts.kind ?? 'WATCH-ERROR'
    const text = opts.text ?? `${source}: ${reason}`
    errors[key] = reason
    if (reason === null) return
    if (!opts.logged) log(`${kind} ${text}`)
    if (previous[key] === reason) return
    try {
      appendEvent(ctx.repo, kind, null, text, run)
    } catch (e) {
      log(`orch-loop: 알림 파일에 쓰지 못했다: ${oneLine(e)}`)
    }
  }

  // 1. 질문 확인. Run 마다. 미답변 질문을 보낸 worker 는 멈춤 확인이 idle 로 보지 않는다
  const waiting = new Map<string, Waiting>()
  for (const { run } of runs) {
    if (!run) {
      report('questions', null, { run })
      continue
    }
    let notices: ReturnType<typeof poll>['notices'] = []
    try {
      const polled = poll(run, join(pathOf('state', ctx.repo), 'questions-seen.json'), Date.now() / 1000, REMIND_AFTER_SEC, ctx.repo)
      notices = polled.notices
      waiting.set(run, askers(polled.pending))
      report('questions', null, { run })
    } catch (e) {
      waiting.set(run, null)
      report('questions', oneLine(e), { run })
    }
    for (const notice of notices) {
      log(notice.line)
      if (notice.reminder) {
        try {
          appendEvent(ctx.repo, 'REMINDER', null, notice.line.replace(/^REMINDER /, ''), run)
        } catch (e) {
          log(`orch-loop: 알림 파일에 쓰지 못했다: ${oneLine(e)}`)
        }
      }
      await notifyQuestion(notice, ctx.repo, run, 'orch-loop')
    }
  }

  // 2. 열린 PR 은 한 번만 읽어 보드, CI 감시와 tick 이벤트가 함께 쓴다
  let prs: Prs
  try {
    prs = openPrs(ctx.repo)
  } catch (e) {
    prs = { ok: false, error: oneLine(e) }
  }
  report('prs', prs.ok ? null : oneLine(prs.error))
  const openPrNumbers = prs.ok ? prs.mine.map((pr) => pr.number) : null

  // 3. 보드 동기화. 저장소 공유 일이라 한 번이고 알림은 주 Run 에 간다
  try {
    if (isFile(boardPath(ctx.repo))) {
      const sync = process.env.BOARD_SYNC || join(HERE, 'board-sync.ts')
      const args = ['--repo', ctx.repo]
      if (prs.ok) args.push('--open-prs', JSON.stringify(prs.mine.map((pr) => ({ number: pr.number, headRefName: pr.branch }))))
      const done = await runAsync(scriptCommand(sync, args), { cwd: ctx.repo, timeoutMs: SWEEP_TIMEOUT_MS })
      relay(done)
      report('board', done.code === 0 ? null : `종료 코드 ${done.code}`)
      remindDecisions(ctx.repo, (text) => {
        appendEvent(ctx.repo, 'REMINDER', null, text, primary)
        log(`REMINDER ${text}`)
      })
    } else {
      report('board', null)
    }
  } catch (e) {
    report('board', oneLine(e))
  }

  // 4. 정리. Run 마다 그 Run 범위로 돈다. 원격 브랜치 정리는 저장소 공유 일이라 주 Run 의 차례에서만 한다
  for (const [i, { run, specsDir }] of runs.entries()) {
    try {
      const sweep = process.env.CLEANUP_SWEEP || join(HERE, 'cleanup-sweep.ts')
      const args = ['--repo', ctx.repo, '--kill-holders', ...(i === 0 ? ['--remote-branches'] : []), '--apply']
      if (run) args.push('--run', run)
      if (specsDir) args.push('--specs-dir', specsDir)
      const done = await runAsync(scriptCommand(sweep, args), { cwd: ctx.repo, timeoutMs: SWEEP_TIMEOUT_MS })
      relay(done)
      report('cleanup', done.code === 0 ? null : `종료 코드 ${done.code}`, { run })
    } catch (e) {
      report('cleanup', oneLine(e), { run })
    }
  }

  // 5. CI 감시. 열린 PR 을 읽지 못한 틱은 결과에 ci 를 넣지 않아 부모가 이전 값을 둔다
  let ci: Record<string, CiEntry> | undefined
  // CI 감시와 충돌 처리가 함께 쓴다
  const lookup: Lookup = { runs, rows: new Map() }
  if (prs.ok) {
    try {
      const watched = await watchCi(ctx, prs.mine, ciEntries(loaded?.ci), lookup)
      ci = watched.ci
      report('ci', watched.error)
    } catch (e) {
      report('ci', oneLine(e))
    }
  }

  // 6. 멈춤 확인. Run 마다 그 Run 의 살아 있는 dispatch 화면만 본다. 실패하면 결과에 stalls 를 넣지 않아 부모가 이전 값을 둔다
  const base = defaultBase(ctx.repo) ?? ''
  let stalls: Record<string, Stall> | undefined
  try {
    const watched = await watchStalls(ctx, lookup, stallEntries(loaded?.stalls), waiting, base)
    stalls = watched.stalls
    for (const [run, reason] of watched.errors) {
      // 같은 틱에 그 Run 의 질문 확인도 실패했으면(Orca 꺼짐) 그 알림 하나로 둔다. 질문 확인이 살아난 뒤에도 실패하면 그때 알린다
      if (reason !== null && waiting.get(run) === null) {
        log(`WATCH-ERROR stalls: ${reason}`)
        report('stalls', null, { run })
      } else {
        report('stalls', reason, { run })
      }
    }
    // Run 없는 루프는 위에서 키를 쓰지 않는다. 아래 catch 가 남긴 이유를 지운다
    if (!primary) report('stalls', null)
  } catch (e) {
    // 조용히 멈춤 확인을 잃지 않게 주 Run 에 알린다
    report('stalls', `멈춤 확인을 하지 못했다: ${oneLine(e)}`)
  }

  // 7. tick 이벤트. Run 마다 그 Run 을 공통 필드 run 으로 낸다
  for (const [i, { run }] of runs.entries()) {
    try {
      const fired = await fire('tick', { tick: n, open_prs: openPrNumbers, primary: i === 0 }, { repo: ctx.repo, base, run })
      if (fired.result === 'fail' || fired.result === 'timeout') {
        const reason = fired.result === 'timeout' ? 'timeout' : String(fired.code ?? 'lock')
        report('hook', reason, { run, kind: 'HOOK-FAIL', text: `tick ${reason}`, logged: true })
      } else {
        report('hook', null, { run })
      }
    } catch (e) {
      report('hook', oneLine(e), { run })
    }
  }

  // 8. 충돌 처리. 내 열린 PR 이 없으면 git fetch 없이 끝낸다. 열린 PR 을 읽지 못한 틱은 건너뛰고 errors.conflicts 를 그대로 둔다
  if (prs.ok) {
    try {
      report('conflicts', prs.mine.length > 0 ? await handleConflicts(ctx, lookup) : null)
    } catch (e) {
      report('conflicts', oneLine(e))
    }
  }

  const result: TickResult = { tick_at: iso(), errors, open_prs: openPrNumbers, ...(ci ? { ci } : {}), ...(stalls ? { stalls } : {}) }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return 0
}

// 본체 ------------------------------------------------------------------

let exiting = false
// 신호를 받았을 때 자식에 TERM 뒤 KILL 까지 주는 유예. --foreground 의 부모만 늘린다(머리 주석의 「틱」)
let stopGraceMs = STOP_GRACE_MS
function onSignal(signal: NodeJS.Signals): void {
  if (exiting) return
  exiting = true
  // 진행 중인 자식(틱 자식 그룹, 정리 명령, 핸들러 그룹)을 끊은 뒤에 끝낸다. 그냥 끝내면 자식이 남는다
  void stopChildren(signal, stopGraceMs).finally(() => process.exit(signalCode(signal)))
}

// 틱 자식이 부모(--foreground)가 사라졌는지 본다(머리 주석의 「틱」)
function watchParent(): void {
  const parent = process.ppid
  setInterval(() => {
    if (process.ppid === parent && alive(parent)) return
    // stdout 을 읽던 부모가 없다. 쓰기 오류가 잡지 않은 예외가 되어 끝내기를 방해하지 않게 버린다
    process.stdout.on('error', () => {})
    process.stderr.on('error', () => {})
    onSignal('SIGHUP')
  }, PARENT_POLL_MS).unref()
}

function fatal(e: unknown): void {
  log(`orch-loop: ${(e as Error)?.stack ?? String(e)}`)
  if (exiting) return
  exiting = true
  void stopChildren('SIGTERM', stopGraceMs).finally(() => process.exit(1))
}

async function main(argv: string[]): Promise<number> {
  let values
  let mode: Mode
  let tickNumber = 0
  let interval = DEFAULT_ALIVE_SEC
  try {
    const options = {
      repo: { type: 'string' },
      run: { type: 'string' },
      'specs-dir': { type: 'string' },
      start: { type: 'boolean', default: false },
      stop: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      foreground: { type: 'boolean', default: false },
      once: { type: 'boolean', default: false },
      tick: { type: 'boolean', default: false },
      'tick-number': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } as const
    values = parseArgs({ args: expandArgs(argv, options), options }).values
    if (values.help) {
      process.stdout.write(`${USAGE}\n`)
      return 0
    }
    const chosen = MODES.filter((name) => values[name])
    if (chosen.length !== 1) throw new Usage('--start, --stop, --status, --foreground, --tick 가운데 하나만 준다')
    mode = chosen[0]
    if (!values.repo) throw new Usage('--repo 가 필요하다')
    if (values.once && mode !== 'foreground') throw new Usage('--once 는 --foreground 와 함께 준다')
    if (values.all && (mode !== 'stop' || values.run)) throw new Usage('--all 은 --run 없이 --stop 과 함께 준다')
    if ((mode === 'tick') !== (values['tick-number'] !== undefined)) throw new Usage('--tick 과 --tick-number 는 함께 준다')
    if (mode === 'tick') {
      const raw = values['tick-number'] as string
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Usage(`--tick-number 는 1 이상의 정수다: ${raw}`)
      tickNumber = Number(raw)
    }
    if (mode === 'foreground') interval = aliveSec()
  } catch (e) {
    process.stderr.write(`${USAGE}\norch-loop: ${(e as Error).message}\n`)
    return 2
  }
  const repo = mainCheckout(resolve(values.repo as string))
  if (mode === 'stop') {
    let run = (values.run as string | undefined) || null
    if (!run && !values.all) {
      try {
        run = context(repo, undefined, undefined).run
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e
        process.stderr.write(`orch-loop: ${e.message}\n`)
        return 2
      }
    }
    return stop(repo, run, values.all as boolean)
  }
  if (mode === 'status') return status(repo)

  let ctx: Context
  try {
    ctx = context(repo, values.run, values['specs-dir'])
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    process.stderr.write(`orch-loop: ${e.message}\n`)
    return 2
  }
  if (mode === 'start') return start(ctx)
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  process.on('SIGHUP', onSignal)
  process.on('uncaughtException', fatal)
  process.on('unhandledRejection', fatal)
  if (mode === 'tick') {
    watchParent()
    return tick(ctx, tickNumber)
  }
  stopGraceMs = TICK_STOP_GRACE_MS
  logFile = join(pathOf('state', repo), 'loop.log')
  makeParent(logFile, repo)
  return foreground(ctx, values.once as boolean, interval)
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    log(`orch-loop: ${(e as Error)?.stack ?? String(e)}`)
    process.exitCode = 1
  },
)
