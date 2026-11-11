# CHANGELOG: orch

## 7.35.0 (2026-11-11)

- 머지를 가리키는 단계가 없으면 BOARD-UNMATCHED 로 알리고 show 에도 보여요. 같은 항목과 PR 은 루프를 다시 띄워도 중복 알리지 않아요.
- 마지막 PR 이 머지돼도 그 PR 번호가 적힌 단계만 끝내고 남은 수동 단계는 보존해요. 근거 괄호의 PR 번호는 완료할 줄로 세지 않아요.

## 7.34.0 (2026-11-11)

- 보드 창에서 사람이 누른 승인과 고쳐 달라를 기록하고 올린 Run 으로 신호를 보내는 코드(`recordPress`)를 더했다. 신호를 보내지 못하면 기록을 되돌린다.
- 에이전트가 Bash 도구로 창 전용 승인 기록 스크립트(`approvals.ts press`)를 부르면 거부하는 hook(`block-approval-press.ts`)을 더했다.

## 7.33.1 (2026-11-11)

- Orca 조회가 시간 초과로 끝나도 온전한 성공 응답을 받았으면 결과를 사용한다.
- worker 목록에서 시간 초과로 실패한 페이지는 한 번만 다시 조회한다.

## 7.33.0 (2026-11-10)

- 보드 상태와 단계를 `orch board set`, `step`, `add-step`, `show` 로 고치고 확인한다. 기본 결과는 한 줄이며 `--full` 로 모든 줄을 본다.
- 코디네이터 안내가 보드 파일 직접 수정 대신 새 명령을 가리킨다.

## 7.32.0 (2026-11-10)

- 승인 대기를 올리고, 목록을 보고, 거두고, 실행 직전 확인하는 `orch board approval add`, `list`, `cancel`, `check` 를 더한다.
- 코디네이터의 승인 신호·채팅 승인·단계 진행 요청 처리 규칙을 안내한다.

## 7.31.0 (2026-11-10)

- 보드를 읽는 orch 호출자가 `finish.board` 를 함께 사용한다.
- 단계 목록을 통째로 저장할 때 줄 지문을 확인해 그 사이 바뀐 글과 완료 값을 덮어쓰지 않는다.
- 잘못된 보드 경로 설정은 한 줄 설명과 종료 코드 2 로 알린다. 루프는 WATCH-ERROR 를 남기고 다음 단계를 계속 실행한다.

## 7.30.4 (2026-11-10)

- `queue.auto_review.feature_head`(기본 true)를 더했다. false 면 기능 PR 에 `verdict-on-head` 를 덧붙이지 않고 저장소의 `require` 만 본다. 반영 push 마다 재리뷰를 받지 않으려는 저장소가 쓴다.

## 7.30.3 (2026-11-10)

- 머지 알림이 worker 에게 조건 없이 worker_done 을 시키지 않는다. 완료 기준에 머지 뒤 할 일이 남았으면 그 일을 마친 뒤에 끝내게 하고, 마무리와 루프가 같은 글을 쓴다.

## 7.30.2 (2026-11-10)

- 코디네이터가 건 머지 큐도 마이그레이션 번호 순서로 정렬하고 앞 PR 을 기다린다. 수동 묶음과 모순되면 머지하지 않는다.
- 준비 상태 검사와 머지 직전에 base 의 최고 번호를 확인하고, 낡은 번호는 새 번호를 받으라는 안내와 함께 보류한다.
- 같은 저장소의 머지 큐가 겹쳐 돌지 않도록 워크트리끼리 공유하는 잠금을 둔다.

## 7.30.1 (2026-11-10)

- 머지 전 gate 와 큐에서 설정한 리뷰 판정을 확인하고, 같은 워크플로와 이름의 체크는 최신 시작 실행을 기준으로 봅니다.

## 7.30.0 (2026-11-10)

- `orch queue gate <PR>` 를 더한다. 머지 큐가 머지 전에 보는 조건(체크, 미해결 리뷰 스레드, 충돌, 기능 완료 근거 블록과 독립 리뷰 줄)을 머지 없이 돌려 `GATE-OK` 나 `GATE-FAIL` 과 걸린 이유를 낸다. 머지 큐와 같은 판정 함수를 쓴다.
- 머지 큐가 멈출 때 첫 이유에서 끝내지 않고 걸린 이유를 모두 모아 STOP 줄과 worker 에게 보내는 이유에 함께 낸다. 체크 대기를 넘지 못한 PR 도 스레드와 근거 블록을 함께 본다.
- 기능 완료 근거 블록 검사를 겹침 판정, 합친 사본 검사, before-merge 보다 먼저 한다.
- 공통 지시서 틀에 「준비됨을 보내기 전에 `orch queue gate` 가 통과해야 한다」 를 넣고, 기능 완료 근거 틀에 스펙만 담은 PR 의 블록 꼴을 더한다.

## 7.29.3 (2026-11-10)

- 상주 루프를 틱 단계 파일과 lifecycle 로 나눠 단계 하나를 고칠 때 볼 곳을 줄였다. 출력과 종료 코드, 상태 파일은 그대로다.

## 7.29.2 (2026-11-10)

- 리뷰 worker 의 완료가 `DONE-SUSPECT` 로 다시 알려지던 것을 고친다. 결과 status 와 worker_done 이 같은 초에 오면 앞선 근거로 세지 못했다.
- 시각이 같으면 Orca 의 순번(sequence)으로 앞뒤를 가린다.
- Orca 명령마다 다른 메시지 필드 이름(`from_handle`, `from`, `to_handle`, `to`, `thread_id`)을 `core/message-fields.ts` 한 곳에서 읽는다.
- 실측한 메시지 꼴로 리뷰 완료와 답한 질문의 판정을 확인하는 회귀 테스트를 더한다.
- 기본 결정 알림 핸들러가 저장소를 알리지 않아 여러 저장소 루프의 DECISION-PENDING 중복 억제가 듣지 않던 것을 고친다.

## 7.29.1 (2026-11-10)

- 리뷰 worker 의 worker_done 을 DONE-SUSPECT 로 알리던 것을 고친다. 영구 이력의 지시서나 첫 status 의 `판정:` 줄로 리뷰 dispatch 를 알아본다.
- 루프 알림은 할 일만 바로 보내고 WATCH-ERROR, LEGACY-NOTICE, STAGE-STALLED, LOOP-RESTARTED 는 `pipeline.digest_sec`(기본 1800초)마다 DIGEST 하나로 모은다.
- 같은 WATCH-ERROR 가 연속 세 틱 넘게 이어지면 바로 보낸다. 머지 큐가 뺀 PR 은 QUEUE-DROPPED 로 바로 알린다.
- 한 Run 에 여러 저장소의 루프가 있어도 같은 알림이 한 번만 가고, 남의 저장소 dispatch 의 PR 조회 실패는 건너뛴다.
- DONE-SUSPECT 와 WORKER-LOST 의 보낸 기록 위치를 머리 주석에 적고 재시작을 지나도 한 번만 가는 회귀 테스트를 더한다.

## 7.29.0 (2026-11-10)

- 모델 선택 참고에 Claude Fable 5.2 를 더한다. 바로 후보에 넣지 않고 크고 어려운 일 다섯 건에 `high` 로 실험한다(사용자 결정 2026-11-10).
- 실험 건은 지시서 `worker 선택:` 줄에 `claude-fable-5-2` `high` 와 「Fable 실험 N/5」 를 적고, 결과를 같은 크기의 Opus·sol 실측과 비교한다.

## 7.28.3 (2026-11-10)

- 머지 큐의 준비, CI 대기, 최신화, 머지와 마무리를 단계 파일로 나눠 관련 코드를 찾기 쉽게 한다. 기존 출력과 종료 코드, 차례 기록은 유지한다.

## 7.28.2 (2026-11-10)

- 정리 명령을 단계별 파일로 나누고 실행 순서와 기존 출력, 보호 규칙을 유지했다.

## 7.28.1 (2026-11-10)

- 저장소 checkout 의 `bin/orch.ts` 가 `ORCH_SCRIPTS_DIR` 없이 설치본으로 넘어가면 stderr 에 설치본 버전과 `ORCH_SCRIPTS_DIR` 안내를 한 줄 낸다. 동작은 그대로다
- 지시서 행 id 가 모델 표에 없다는 거절에 표의 행 id 목록을 붙이고, 모델 이름을 쓴 경우 작업 종류 id 를 쓰라고 덧붙인다
- `spec-lint` 의 임시 경로 경고가 재개 절에서는 회신과 측정 결과를 본문에 옮기라는 안내를 붙인다. `launch.md` 의 재개 절 규칙을 맞춘다

## 7.28.0 (2026-11-10)

- worker 는 PR 을 연 뒤나 고쳐 push 한 뒤 CI 결과를 그 턴 안에서 전경으로 기다린다. CI 를 기다리려고 턴을 끝내지 않는다.
- 「PR 을 열었다」 와 「준비됨」 status 는 CI 를 기다린 뒤 한 번만 보낸다. 턴을 끝내면 Orca 가 「Worker stopped without reporting」 escalation 을 코디네이터에게 보내므로 기다리는 동안 턴을 끝내지 않는다.

## 7.27.1 (2026-11-10)

- 값 판정을 core 로 옮기고 외부 조회·기록과 나눈다. 기존 lib import 경로와 명령 동작은 유지한다.
- 공통 실행 도우미와 객체 검사를 합치고, 경계 검사·값 입력 테스트·고정 입력 기록으로 구조 변경 뒤 동작을 확인한다.

## 7.27.0 (2026-11-10)

- 루프 알림을 Orca Run 메시지로 보내고 자체 대기를 없앴다. 완료 보고·끊긴 worker·미답변 질문 감시를 루프로 옮겼으며, 옛 명령은 한 줄 안내와 함께 끝난다. 남은 옛 상태 파일은 읽지 않은 알림을 전송한 뒤 휴지통으로 옮긴다.

## 7.26.2 (2026-11-10)

- 계획을 마친 구현은 Claude Sonnet 5.5 를 `high` 로 기본 띄우고, Claude Opus 5.5 와 `gpt-6.1-sol` 은 `medium` 을 넘기지 않는다.
- 사용 한도에 걸렸을 때 Claude Sonnet 5.5 의 같은 등급 대응에 `gpt-6.1-terra` 를 더한다. 코딩 근거가 약해 experiment 전이라고 적는다.
- `gpt-6.1-terra` 설명을 중간급 코딩 모델로 고친다. 한국어 문서에는 쓰지 않는다.

## 7.26.1 (2026-11-10)

- 워크트리를 정리하는 동안 worker 전체 목록을 한 번만 읽고, 삭제 직전에 해당 경로와 새로 갱신된 Run 을 확인한다.
- 끝난 지 오래된 Run 은 머신 캐시를 다시 쓰되 살아 있는 터미널과 연결된 행은 새로 읽는다.
- 터미널 입력 확인 훅도 같은 캐시를 쓰고, 시간 초과 시 찾은 Run 수와 남은 Run 수를 알린다.

## 7.26.0 (2026-11-10)

- worker 에게 답과 지시를 보낼 때 터미널 입력 대신 Orca 메시지로 깨웁니다.
- 끝난 worker 의 후속 지시서는 새 Task 로 보내고 새 터미널과 dispatch 를 띄우기 기록에 남깁니다.
- 후속 전송이 거절된 경우에는 기존 다시 띄우기 경로를 씁니다.

## 7.25.5 (2026-11-10)

- worker 모델 표의 `small-fix` 행을 나눈다. 분기나 상태를 다루는 수정은 Sonnet `medium`, 분기 논리가 없는 문서·문구·설정 고침만 Haiku 를 쓴다(사용자 결정 2026-11-10).

## 7.25.4 (2026-11-10)

- `orch cleanup sweep --specs-dir` 가 워크트리가 먼저 지워진 지시서도 치운다. `브랜치:` 의 PR 이 모두 MERGED 이고 그 브랜치의 워크트리가 없으면 판정 근거 한 줄을 내고 휴지통으로 옮긴다.
- 지시서 틀과 작성 문서가 PR 본문 파일 이름에 작업(워크트리) 이름을 넣게 한다. `pr-body.md` 같은 고정 이름은 `spec-lint` 가 `본문` 경고로 알린다.
- 반영을 마친 스킬 개선 후보 가운데 `채택 #PR` 과 `기각(이유)` 은 휴지통 폴더로 옮긴다. `보류` 와 `후보` 만 `feedback/` 에 남는다(`references/feedback-review.md`). 명령 동작은 바뀌지 않는다.

## 7.25.3 (2026-11-09)

- 모델 선택에서 `gpt-6.1-sol` `medium` 을 Claude Opus 5.5 `medium` 과 같은 등급으로 본다. 구현 행의 첫 후보로 둔다.
- sol 을 막는 조건을 「사용자 결정이나 설계 판단이 남은 Task」 로 좁힌다. 실행 전 확인 질문은 sol 을 막지 않는다.
- 사용 한도 대체 표에 `gpt-6.1-sol` `medium` 행을 더한다.
- 근거는 `docs/features/orch-routing/evidence.md` 의 2026-11-09 절이다.

## 7.25.2 (2026-11-09)

- 공통 지시서 틀의 「PR 전 인수 검증」 이 실행 담당이 worker 인 행만 가리킨다.

## 7.25.1 (2026-11-09)

- 모델 사용 기록의 토큰을 worker 세션 기록에서 먼저 읽고, 못 읽으면 `tokens_source` 에 이유를 남긴다. Orca 사용량 파일은 dispatch 시작보다 새로울 때만 쓴다.

## 7.25.0 (2026-11-09)

- `orch worker ask` 는 질문을 보내고 바로 끝난다(`ASKED <질문 id>`). worker 는 턴을 끝내고 Orca 가 답과 함께 깨운다. `--resume` 은 없어졌고 `--timeout-ms`, `--max-wait` 는 받되 무시한다

## 7.24.3 (2026-11-09)

- 화면에 백그라운드 셸·모니터·Codex 백그라운드 터미널 표시가 있는 worker 를 멈춤 알림(stalled-workers, 움직임 확인, idle 멈춤 확인)에서 뺀다. 그 작업이 끝나면 하네스가 worker 를 깨우므로 멈춤이 아니다

## 7.24.2 (2026-11-09)

- 마이그레이션 예약 정리가 예약 뒤 24시간(`RESERVE_GONE_GRACE_MS`) 안의 예약은 브랜치가 없어도 남긴다. 아직 만들지 않은 브랜치로 받은 번호를 지우고 또 주지 않는다

## 7.24.1 (2026-11-09)

- 충돌 알림 기록의 키를 (PR, base SHA) 에서 (PR, PR HEAD, 충돌 파일) 로 바꾼다. worker 가 아직 push 하지 않았고 충돌 파일이 같으면 base 가 움직여도 다시 알리지 않는다
- 충돌 알림 본문, 후속 지시서, 공통 지시서 틀의 예약 절이 마이그레이션을 더한 PR 이면 합친 뒤 `orch queue reserve` 를 다시 부르라고 안내한다
- 공통 지시서 틀이 Java 마이그레이션 이름을 PascalCase 로 정하지 않고 그 폴더의 기존 이름 형식을 따르게 한다

## 7.24.0 (2026-11-09)

- `orch feedback add` 가 설명과 판단 근거를 모두 받아 정해진 양식으로 후보를 만들고, `list` 와 `set` 으로 목록과 상태를 관리해요.
- `orch feedback migrate` 로 옛 메모를 먼저 보고, `--apply` 를 주면 새 양식으로 옮겨요. 모르는 칸은 확인 필요로 남기고 원본은 휴지통에 보관해요.

## 7.23.5 (2026-11-09)

- 지침 문서의 `갈음` 을 `대신` 으로 고쳤다. korean-check 의 금지어에 `갈음` 이 올랐기 때문이며 뜻은 같다

## 7.23.4 (2026-11-09)

- worker 시작 확인 시간이 넘으면 자동 abandon·재시도 없이 `STALLED-START` 와 종료 코드 1 로 멈춤만 알린다. 터미널과 화면 상태도 남기고 기존의 일하는 흔적 검사는 유지한다.
- 충돌 알림과 상주 루프도 멈춤 판정 줄을 받으면 시작 요청을 기록해 같은 지시를 자동으로 다시 보내지 않는다.
- 다시 띄울지는 사용자에게 묻고, Task 상태에 따라 `--retry-of` 를 붙이도록 안내한다.

## 7.23.3 (2026-11-09)

- `orch status` 가 살아 있는 루프의 번들을 doctor 와 같은 기준으로 대조해 `LOOP-STALE` 도 내보낸다.

## 7.23.2 (2026-11-09)

- 끝난 dispatch 의 질문을 닫은 근거를 머신 공통 기록으로 공유한다. 같은 Run 을 보는 다른 저장소 루프도 그 질문을 처음 알리거나 재알림하지 않는다.
- 공유 기록을 쓸 수 없어도 오류만 로그에 남기고 질문 확인과 나머지 틱을 계속한다.

## 7.23.1 (2026-11-09)

- `DECISION-PENDING`, 기본 결정 요청과 `NO-WAIT` 본문에 질문 id 와 dispatch 를 붙인다. 질문이 많으면 앞 일부와 나머지 수를 내보낸다.

## 7.23.0 (2026-11-09)

- 공통 지시서의 표지 항목을 틀에 맞추는 `orch spec sync-common` 명령을 더했다. 기본은 diff 만 보이고 `--apply` 로 반영한다.
- 저장소 고유 항목, 채운 자리표시자와 `keep` 표지를 보존한다.
- 표지의 변형·중복과 코드 예시를 구분하고 저장소 하위 목록과 변경 범위 밖 줄바꿈을 보존한다. 빠진 규칙은 틀과 같은 절에 넣고 원자적으로 적용한다.

## 7.22.0 (2026-11-09)

- 리뷰 worker 지시서 틀 `templates/spec-review.md` 를 더한다. 결과 status 첫 줄 `판정:` 과 등급별 건수 표 꼴을 고정한다.
- `launch.md` 에 run 을 만들고 루프를 띄우는 명령을 더하고, `run-use` 는 다른 Run 의 메일을 끊으니 사용자에게 묻고 쓰게 한다.
- `spec-writing.md` 에 `담당:` 줄 꼴과 허락 줄의 「dispatch 머리말의 GitHub 게시 금지보다 앞선다」 문장을 더한다.
- `SKILL.md` 입력과 다른 제공자 리뷰 행, `feature-loop.md` 의 spec 필드, `feedback-review.md` 의 섞인 후보 파일 처리를 더한다.
- worker 터미널은 `worker-release` 로 먼저 닫고 조건은 `cleanup.md` 한곳이 소유한다. 자동 release 와 백그라운드 한도를 문서에 맞춘다.

## 7.21.2 (2026-11-09)

- references 열 개에서 소유 문서나 스크립트 머리 주석이 있는 중복 서술을 줄이고 소유처를 가리킨다

## 7.21.1 (2026-11-09)

- SKILL.md 와 references 다섯 개에서 스크립트 머리 주석과 소유 문서가 가진 내용을 다시 적은 줄을 참조로 줄인다.
- 동작 규칙은 바꾸지 않는다.

## 7.21.0 (2026-11-09)

- 완료 검증에서 CI 가 같은 head SHA 로 돌린 검사는 CI 결과로 대신하고, CI 밖 검사(저부하 측정, 실제 환경, CI 가 없는 저장소의 검사)만 다시 돌린다. diff 를 직접 읽는 것은 그대로다

## 7.20.5 (2026-11-09)

- 문서에 남은 옛 스크립트 호출을 `orch <묶음> <동작>` 으로 고치고, 옛 `.skills/orch/` 경로와 `githooks/` 도 지금 경로로 맞춘다
- 문서가 코드와 달리 말한 곳을 고친다: 마지막 메시지의 reply, `--sweep-arg` 함정, before-launch 예시, INVALID-CONFIG 이유, 읽는 코드가 없는 pipeline 키
- 검사기를 더한다: 산문의 옛 호출 꼴, 모델 표에서만 읽는 행 id, LOOP-EVENT kind 목록과 gh TTL 표가 코드와 같은지

## 7.20.4 (2026-11-09)

- cleanup-sweep 테스트가 띄우는 실제 삭제 자식에서 동기 명령 가짜를 재사용한다. 실제 git 저장소와 워크트리·브랜치 삭제는 자식 프로세스에서 계속 검증한다.

## 7.20.3 (2026-11-09)

- README 의 준비 항목에서 `python3` 요구를 뺀다. orch 의 실행 경로는 node 24 이상만 쓴다
- `agent-selection.md` 의 Codex 모델 목록 명령이 `python3 -c` 대신 `node -e` 로 JSON 을 읽는다

## 7.20.2 (2026-11-09)

- finish-pr의 동기 조회를 함수로 주입하고, 테스트 준비 이력과 실제 대기를 줄였다.

## 7.20.1 (2026-11-08)

- launch-worker의 비동기 실행과 wait-important의 동기 조회를 호출별로 주입할 수 있게 해 판정 테스트의 반복 기동을 줄인다. spec 명령은 함수로 불러도 CLI를 실행하지 않는다.
- launch-worker와 wait-important 테스트에서 기존 상태·출력 단언을 유지하며 동기 가짜 조회와 spec 판정 함수를 호출한다. 비동기 대기·신호·hook·shell 대체 명령과 대표 CLI 대응은 실제 프로세스로 검증한다.

## 7.20.0 (2026-11-08)

- `config.json` 에 `inbox` 절(inbox 스킬의 알림 필터)을 더하고 키를 검사한다. 새 번들을 설치한 뒤에만 저장소 `config.json` 에 `inbox` 절을 넣는다
- `orch doctor --repo` 가 옛 알림 필터 `config/notification.json` 을 찾으면 `OLD-INBOX-FILTER` 로 옮기는 법을 알린다

## 7.19.6 (2026-11-08)

- 문서의 스크립트 참조 판정을 직접 호출할 수 있게 해 저장소 문서 검사를 Orca 세션 환경과 분리한다. doctor의 CLI 판정과 출력은 유지한다.

## 7.19.5 (2026-11-07)

- 공통 가짜 평가기를 분리하고 worker 실행·진단·워크트리 정리 테스트의 준비 비용을 줄인다.

## 7.19.4 (2026-11-06)

- 정리와 충돌 알림의 출력·종료 코드를 유지하며 테스트 준비와 가짜 명령의 반복 실행 비용을 줄인다.

## 7.19.3 (2026-11-06)

- 루프 테스트의 가짜 gh·orca·ps 를 함수로 실행하고 초기 git 저장소를 testkit 템플릿에서 복사해 준비 시간을 줄인다.
- 실제 CLI 의 시작·신호·종료 테스트와 git 판정은 유지한다.
- 함수 가짜의 실행 불가 경로·종료 코드·console 출력을 실제 명령과 맞추고 지원 범위를 명시한다.

## 7.19.2 (2026-11-06)

- 기본 미해결 스레드 명령이 review-fix 의 `review_threads.ts` 를 `node` 로 부른다. 머지 큐의 `--threads-cmd` 와 상주 루프의 `THREADS_CMD` 를 직접 준 호출은 그대로 쓴다

## 7.19.1 (2026-11-06)

- 머지 큐의 명령 실행을 호출 범위별로 주입할 수 있게 하고, 테스트의 가짜 프로세스와 초기 저장소 준비를 재사용한다.

## 7.19.0 (2026-11-06)

- `orch routing report` 로 여러 저장소의 모델·effort·지침 행별 실측을 모은다.
- PR 을 연 effective 모델의 품질과 첫 dispatch 모델의 다시 띄운 PR 비율을 나누어 보여 준다.
- 손상 줄은 보고서에서 경고하고 건너뛰며 쓰기 오류에는 파일 경로와 줄 번호를 남긴다.

## 7.18.0 (2026-11-06)

- worker PR이 머지되거나 닫히면 모델 선택과 품질·시간·토큰 관측값을 PR마다 한 줄로 남긴다. 수집 실패는 얻지 못한 값만 null로 두고 정리를 이어 간다.
- 직접 재시도를 셸 제어문이나 전역 옵션으로 감싸도 막는다. 옛 지시서라도 모델·effort를 바꿔 다시 띄우면 모델 표의 행을 적어야 한다.

## 7.17.0 (2026-11-06)

- 행 id 와 Opus 높은 effort 의 근거를 lint 와 launch 가 함께 검사하며, 이미 띄운 옛 지시서는 연결 경로에서 호환한다.
- 비교 실험의 최소 배정과 동률 순서를 검사하고 같은 Task 와 터미널의 이어 쓰기는 배정 수에서 뺀다.
- 요청값과 effective 를 영구 이력에 남기고 resume 은 이전 dispatch 의 설정을 물려받는다. 손상된 줄은 경고하고 새 기록의 줄 경계를 지킨다.
- 같은 Task 의 재시도도 launch-worker 를 거친다. 이전 터미널이 열려 있으면 닫거나 명시적으로 이어 쓴다.
- 직접 재시도 hook 의 인용 처리와 ready Task 안내를 고친다. resume 내부 연결은 유지하고 link 실패의 NEXT 는 launch 명령으로 안내한다.

## 7.16.0 (2026-11-06)

- `orch worker resume --dispatch <id>` 를 더했다. 사용 한도나 재부팅으로 멈춘 worker 를 같은 워크트리에서 `claude --resume` / `codex resume` 으로 다시 띄워 같은 Task 에 잇는다.
- `orch worker adopt` 의 `LIMITED`, `RESTART` 아래 줄과 상주 루프의 `WORKER-LIMITED` 알림이 계정 전환 뒤 이 명령을 안내한다.

## 7.15.1 (2026-11-06)

- 핸들러 문법 규칙의 원본을 `docs/code-architecture.md` 「저장소 실행 규칙」 으로 가리킨다.

## 7.15.0 (2026-11-06)

- 진입 스크립트를 명령 묶음과 같은 `scripts/<묶음>/` 폴더로 옮겼다(`queue/merge_queue.ts` 꼴). `orch` 명령과 옛 꼴 이름은 그대로다.
- `orch-doctor.py` 와 `ts_shim.py` 는 `scripts/` 바로 아래에 남는다.
- `$ORCH_SCRIPTS/<이름>.ts`, 핸들러의 `join(ORCH_SCRIPTS, '<이름>.ts')` 처럼 파일 경로로 부르던 곳은 이제 파일이 없다.
- 핸들러는 `node "$ORCH_BIN" <묶음> <동작>` 으로 부른다. `orch doctor` 가 직접 경로를 `DIRECT-PATH` 와 새 꼴 한 줄로 알린다.
- 저장소 체크아웃에서 띄워 둔 상주 루프는 이 변경을 받은 뒤 다시 띄운다.

## 7.14.2 (2026-11-05)

- 미해결 리뷰 스레드와 검사 뒤 HEAD 변경으로 보류한 PR 을 정리 전에 한 번 다시 판정한다. 재판정의 CI 대기는 PR 마다 최대 5분이며, 더 짧은 `--check-timeout` 을 우선한다.
- 기능 PR 판정은 브랜치에 연결된 dispatch 지시서를 우선하고, 후속·충돌 해소 뒤에도 구현 기록이 있으면 기능 판정을 유지한다. 지시서가 다른 브랜치로 바뀌었으면 제외하며, 유효한 연결 지시서가 없으면 기존 브랜치 지시서를 모두 본다.
- 「이 지시서는 계획까지만 맡는다」나 「구현과 PR 은 코디네이터가 계획을 보고 새 지시서로 띄운다」가 있는 계획 전용 지시서는 구현 PR 판정에서 제외한다.
- 공통 지시서 비교에서 항목 머리의 목록 기호를 제외한다. 틀의 번호 참조는 항목 이름으로 바꾼다.

## 7.14.1 (2026-11-05)

- 보드에서 done 항목을 먼저 비워도 머지된 PR 이 있는 지시서는 `handoff-cleanup` 이 끝난 것으로 보고 옮긴다. 머지된 PR 이 없는 지시서(띄우기 전)는 그대로 남긴다

## 7.14.0 (2026-11-05)

- 모델 표에 행 id 를 더하고 지시서의 `worker 선택:` 줄에 `행: <id>` 를 적게 했다.
- Opus `high` 이상은 `high 근거:` 가 있을 때만 고르게 하고, 실측 근거(2026-11-05, PR 486건)와 sol 후보 조건을 지침에 적었다.
- 공통 지시서 틀에 no-reconfirm, status-not-escalation 규칙을 더했다.

## 7.13.0 (2026-11-05)

- `orch` 명령의 기본 출력이 판정 줄(대문자 낱말로 시작하는 줄)이 돼요. 설명과 진행 줄은 `--full` 로 봐요. 경로로 직접 부른 스크립트는 지금 출력 그대로예요
- `orch wait` 가 받은 메시지마다 `DONE`, `QUESTION` 같은 판정 줄을 내고 `RAW <원문 파일>`, `LAST_DELIVERY` 로 끝나요. `orch wait triage` 를 따로 부르지 않아도 돼요
- 루프, Run 마다의 worker, 보드를 한 번에 보는 `orch status` 가 생겨요
- doctor 가 대기 출력을 읽는 저장소 스크립트를 `WAIT-READER` 로 알려요
- 기능 루프의 단계 인계 표는 spec 의 `feature-docs.md` 를 가리키는 한 줄로 줄여요

## 7.12.0 (2026-11-05)

- 스크립트를 `orch <묶음> <동작>` 으로 불러요. 플러그인 루트 `bin/orch` 가 PATH 에 실리고, Codex 와 사람 셸은 `orch doctor install-cli` 로 `~/.local/bin/orch` 를 깔아요
- 새 꼴은 저장소, Run, 지시서 폴더, 대기의 루프 저장소를 주지 않으면 작업 폴더와 코디네이터 터미널에서 읽고 출처를 stderr 한 줄로 남겨요
- user 범위 설치본이 있으면 그것만 써요. 옛 꼴 `bin/orch.ts <스크립트 이름>` 도 같은 스크립트를 부르고 stderr 에 새 꼴을 안내해요
- `NEXT_WAIT` 가 `orch wait --ack <id> --loop-repo <저장소>` 꼴로 짧아져요. 핸들러 환경에 진입점 경로 `ORCH_BIN` 이 더해져요
- doctor 가 `CLI-MISSING`, `CLI-STALE`, `CLI-NOT-ON-PATH`, `WAIT-STALE`, `OLD-CALL`, `DIRECT-PATH` 를 알리고, 문서의 새 꼴을 명령 표로 확인해요

## 7.11.1 (2026-11-05)

- orch 명령이 한 번 실행되는 동안 주 checkout 과 .orch 무시 여부를 한 번만 확인해, 상주 루프의 틱과 정리가 빨라진다. 실행 중에 지운 무시 줄은 다음 명령이 다시 더한다

## 7.11.0 (2026-11-05)

- 머지 뒤 마무리가 기능 PR 도 배포 확인 전에 워크트리, 브랜치, 빈 터미널을 지워요. 후속 검증이 대기면 지시서, 업무 완료, 보드만 남겨요
- 배포 브랜치에 연달아 머지해 배포가 skipped 로만 끝나면 끝 커밋의 배포를 기다리고, 끝 커밋도 skipped 면 배포 실패로 끝내요. 근거는 `배포 판정:` 줄에 남아요
- `remove-worktree` 도 끝난 worker 의 워크트리를 쥔 자식 없는 Orca 기본 셸 터미널을 닫고 지워요. worker 기록이 없는 워크트리의 셸과 자식이 있는 셸은 남겨요
- `cleanup-sweep` 이 PR 상태를 묶음 조회로 읽고, 머지를 확인한 브랜치는 끝 커밋이 그대로인 동안 다시 묻지 않아요

## 7.10.2 (2026-11-04)

- 버전 이름 설치 캐시도 설치 기록의 커밋으로 최신 여부를 판정한다

## 7.10.1 (2026-11-04)

- 머지 큐의 겹침 판정이 이름 변경의 옛 경로도 읽는다

## 7.10.0 (2026-11-04)

- 호환성: 설치 경로가 skills/orch 로 바뀌어요. 직접 참조와 개인 링크는 새 경로로 바꾸고 플러그인을 갱신해요.

## 7.9.0 (2026-11-04)

- `pipeline.refresh_slots` 를 켜면 상주 루프가 뒤처진 PR 의 `update-branch` 를 머지 차례 전에 PR 마다 걸어 CI 를 함께 돌린다. 판정은 머지 큐와 같은 `queue` 키로 한다
- 머지 큐는 보류한 PR 만 빼고 다음 PR 로 가는 것이 기본이다(옛 동작은 `--stop-on-hold`). 뺀 이유는 `QUEUE-DROPPED` 로 남고 worker 가 고칠 보류는 그 worker 에게 간다
- 차례 PR 이 update-branch 뒤 CI 를 기다리는 동안 겹치지 않고 준비된 뒤 PR 을 먼저 머지한다. 큐가 자동 머지를 막는 틱에는 `AUTO-MERGE-HELD` 를 남긴다
- `queue.poll_min_sec`, `poll_max_sec`, `ci_expected_sec` 로 체크 확인 간격을 정한다. 체크가 이미 끝났으면 다시 보는 60초를 건너뛴다
- 기능 완료 근거의 검증 커밋 뒤에 base 를 합친 merge 커밋만 있으면 통과로 보고, 지금 HEAD 의 CI 통과로 대신한다

## 7.8.1 (2026-11-04)

- 문서 표현만 고쳤다. 동작은 바뀌지 않았다

## 7.8.0 (2026-11-04)

- 기능 PR 의 현재 커밋·인수 검증·문서 대조·독립 리뷰 근거를 머지 전에 확인하고, 후속 검증 뒤 정리해요.

## 7.7.0 (2026-11-04)

- `reserve-migration` 에 `--kind adr` 를 더했다. orch 설정 `adr.dirs` 의 폴더마다 base, 열린 PR, 남은 예약을 넘는 ADR 번호를 예약하고 `<번호>-<설명>.md` 경로를 낸다
- ADR 예약은 `state/adr-reservations.json` 에 따로 두고 자동 머지는 읽지 않는다. `--prune` 은 마이그레이션과 ADR 예약을 함께 정리한다
- 공통 지시서 틀에 ADR 번호 예약 줄(`adr`)을 더했다. `spec-lint` 는 `adr.dirs` 가 있는 저장소에서만 그 표지를 요구한다

## 7.6.0 (2026-11-04)

- 사용자와 대화 중이면(마지막 입력 10분 안) 코디네이터는 깨어난 대기를 다시 걸지 않는다. `user-active` 가 판정하고, 상주 루프는 그동안 `NO-WAIT` 와 `decision-pending` 전달을 미룬다
- `decision-pending` 전달이 실패하면 10분부터 두 배씩 기다렸다 다시 낸다. 보드 decide 항목의 `참고:` 줄은 결정으로 세지 않는다
- `send-to-worker` 가 `dispatch_inactive`, `answer_conflict` 로 거절된 질문을 닫은 질문으로 적는다. `worker-ask` 는 `runtime_busy` 면 기다렸다 다시 묻고, 끝난 dispatch 의 오류일 때만 Run 메일함으로 보낸다
- doctor 의 `LOOP-STALE` 이 지금 세션 프로필의 user 범위 설치본과 비교한다. `ORCA-SHAPE` 로 Orca 출력 형식 변경을 알린다. worker 터미널 send hook 은 살아 있는 터미널 상태만 읽고 판정을 10분 기억한다
- `board-sync` 가 단계를 모두 끝냈고 열린 PR, 워크트리, 남은 일 줄이 없는 doing 항목을 done 으로 바꾼다

## 7.5.0 (2026-11-04)

- 공통 지시서 틀에 검토 하위 에이전트를 요청하는 줄(`review-subagents`)을 더했다. Codex worker 도 하위 에이전트로 검토자를 띄운다
- `spec-lint` 가 표지 붙은 항목의 본문을 틀과 비교해 다르면 `공통` 경고를 낸다. 보드 고치기 금지 줄에 `no-board-edit` 표지를 달았다
- 마이그레이션 번호 예약 문구를 틀로 옮겼다(`migration`). orch 설정에 `migrations` 가 있을 때만 요구하고, `reserve-migration` 은 `--base` 의 `origin/` 을 뗀다
- `spec-lint` 가 지시서의 임시 폴더 경로를 `임시` 경고로 알린다. 재개 절은 회신 내용을 본문에 옮겨 적는다
- `launch-worker --worktree` 가 커밋 안 된 변경이 있으면 거부한다. 이어받을 때는 `--dirty-ack <이유>` 를 준다

## 7.4.0 (2026-11-03)

- 공부 후보를 사용자 질문이나 결정에서 일반 기술 개념이 판단을 바꿨을 때 적는다. 뜻을 물은 경우도 포함한다
- 저장소 밖에서도 통하고, 트레이드오프가 선택을 정했고, 더 볼 자료가 있고, 한두 문장으로 끝나지 않는 개념만 적는다
- 공통 지시서 틀에 「공부 후보 보고」 절을 더했다. worker 도 같은 기준으로 적고 `worker_done` 에 「공부 후보 N건」 을 싣는다
- 하루 끝 고르기를 뺐다. 후보는 계속 쌓고, 사용자가 고른 후보를 오버레이의 글 쓰기 스킬로 잇는다

## 7.3.0 (2026-11-03)

- 검증 절차·기대값·결과를 보존하고 공통 문서 변경이 겹치는 작업을 조율해요.

## 7.2.0 (2026-11-03)

- `send-to-worker` 가 `stable_pane_required` 로 거부되면 status 로 바꾸기 전에 `--run`, `--from` 없는 reply 를 한 번 보낸다
- 멈춤 확인은 구조화 worker 의 화면을 읽지 않고 worker-show 의 단계와 마지막 오류로 판정한다
- 마일스톤 항목은 마지막 PR 을 판정하지 못했거나 done 지점 뒤에 끝나지 않은 수동 단계가 남으면 done 으로 바꾸지 않는다
- 리뷰 worker 의 `worker_done` 은 결과 status(`판정:`, `완료:`, `미완료:` 줄)를 완료 근거로 센다
- `cleanup-sweep` 이 끝난 리뷰의 변경 없는 detached 워크트리와 `review/pr-N` 을 지운다. 공통 지시서 틀의 기능 루프에 technical-design 을 넣었다

## 7.1.0 (2026-11-03)

- 자동 머지의 리뷰 판정을 저장소마다 `queue.auto_review.require` 의 조건 조합으로 고른다. 조건은 `verdict-on-head`, `verdict-seen`, `last-verdict-pass`, `rereview-after-block` 이다
- `require` 를 적지 않은 저장소는 지금 HEAD 의 판정만 세는 이전 동작(`verdict-on-head`)과 같다. 미해결 스레드 0 은 조합과 상관없이 늘 본다
- 모르는 조건 이름이 있으면 상주 루프는 멈추지 않고 PR 만 걸지 않으며, `orch-doctor` 가 `INVALID-CONFIG` 로 알린다
- 큐를 걸 때 PR 마다 통과 근거(조건, 판정, 커밋이나 댓글, 시각)를 `AUTO-MERGE-BASIS` 줄로 루프 로그에 남긴다
- `AUTO-MERGE-NO-REVIEW` 는 HEAD 범위가 아닌 조건이 막았으면 `HEAD <SHA> 의 PR 에 … (<조건>)` 꼴로 알린다

## 7.0.0 (2026-11-03)

- 기술 설계 단계를 연결하고 기능별 계획 전체 경로를 인계해요.

## 6.x

- 기능 루프의 사용자 확인과 worker 지시서 진입 검사를 제공해요.

## 5.x

- `skills/orch/scripts` 의 옛 `.py` 진입점과 옛 설정 칸, 옵션을 지웠다. 명령은 `bin/orch.ts <이름>` 으로 부르고 옛 설정은 `migrate-orch-dir --hooks` 로 바꾼다
- 상주 루프가 멈춘 worker(`WORKER-IDLE`, `STAGE-STALLED`, 사용 한도), 마무리 없는 머지, 대기 없음, 오래 쥔 무거운 검사 자리, 새 사용자 결정을 알린다
- 기능 루프(spec, planning, build-with-teams, verify, docs-consolidate)와 루프를 쓸지 정하는 기준, worker 의 spec 인터뷰 중계를 더했다
- 지시서 하나의 완료 기준은 PR 하나의 MERGED 다. `spec-lint` 가 완료, 보드, 공통 지시서 표지 경고를 내고 무관한 활성 지시서끼리의 겹침은 경고만 한다
- `리뷰 PR: #N` 지시서는 `launch-worker` 가 PR head 에 리뷰 워크트리를 둔다. 정리가 리뷰 흔적, 후속 지시서, compose 컨테이너, 선언한 Docker 자원을 지운다
- `worker-ask`, `wait-important`, `send-to-worker` 가 답과 완료 근거를 더 넓게 찾고, `adopt-sessions` 가 떨어진 worker 를 붙이며, 끝난 worker 의 막힘은 `worker-release` 로 닫는다
- 공부 후보를 `study/<slug>.md` 파일로 모아 `study-candidates` 로 다루고, `orch-doctor` 가 `STUDY-OPEN`, `FEEDBACK-OPEN` 을 낸다
- gh 체크를 HEAD 별로 캐시하고 모든 `orca orchestration` 조회에 `--full` 을 붙인다. Codex worker 의 SSH 인증과 `reserve-migration --kind java` 를 더했다

## 4.x

- 상주 루프가 여러 세션의 Run 을 함께 맡고, 자동 머지(`queue.auto_merge`)와 마이그레이션 번호 검사, 예약(`reserve-migration.ts`)을 한다
- 보드 항목의 단계는 마일스톤 단계다. `[pr]`, `[merge]`, `[deploy]`, `[release]` 와 줄 끝 사건 꼬리표를 사건에 맞춰 끝낸다
- `launch-worker` 가 띄우기 전에 `spec-lint`, `worker 선택:` 줄 대조, codex 모델 검사, Claude 프로필 판정을 한다. 프로필은 `link-claude-profile.ts` 로 맞춘다
- worker 상태 판정을 `lib/worker-state.ts` 한 곳이 정하고 `cleanup-sweep`, `orch-doctor`, `wait-important` 가 함께 쓴다
- 진입점 `bin/orch.ts <이름>` 이 설치 기록의 현재 번들에서 스크립트를 찾아 실행한다. 문서의 명령 예시가 이 꼴이다
- 읽기 전용 gh 조회가 프로세스 사이에서 캐시를 공유하고 `gh-usage.ts` 가 호출 수를 낸다
- `finish-pr` 이 업무의 마지막 PR 인지 스스로 판정하고, 머지 큐가 충돌한 PR 을 빼고 뒤 PR 을 잇는다
- 지시서 하나는 PR 하나다. 에이전트 고르기에 제공자 절과 라우팅표, 사용 한도 대응표를 두었다

## 3.x

- 명령이 TypeScript 로 돌고 단계마다 이벤트를 낸다. 저장소 고유 일은 `.skills/orch/hooks/<이벤트>.ts` 가 맡고, 옛 `.py` 경로는 shim 으로 남는다
- 업무 완료는 `after-deploy` 핸들러가 한다. `migrate-orch-dir --hooks` 가 옛 셸 명령 칸을 핸들러로 바꾸며 worker 가 작업 중이어도 적용한다. 옛 폴더 옮기기는 다른 저장소의 지시서에 막히지 않는다
- 저장소마다 상주 루프 `orch-loop.ts` 가 질문 확인, 정리, 보드 동기화, 내 PR 의 CI 감시, 충돌 PR 알림을 하고 `wait-important --loop-repo` 를 깨운다
- worker 가 PR 이 머지될 때까지 맡고, 완료 검증은 `준비됨` 을 받은 때 한다. 지시서 하나는 PR 하나로 끝나는 크기로 쓴다
- `cleanup-sweep --remote-branches` 가 머지된 원격 브랜치를 지우고, 머지 큐가 머지한 브랜치를 base 로 둔 내 PR 의 base 를 옮긴다
- worker 를 띄우면 보드 항목을 만들고 루프가 PR 연결과 머지를 반영한다. 결정 필요 항목은 `DECISION-PENDING` notifier가 깨운다
- `heavy` 절로 무거운 검사를 분류하고, 시간 제한과 유예를 `ORCH_*` 환경 변수로 바꿀 수 있다
- node 24 이상이 필요하다. 그보다 낮으면 스킬을 열 때 `NODE-TOO-OLD` 로 멈춘다(`ADR-011`)

## 2.x

- orch 파일을 `.omc/` 와 `.claude/` 에서 주 checkout 의 `.orch/` 로 옮겼다(`overlay.md`, `config.json`, `specs/`). 옛 위치는 `migrate-orch-dir` 로 옮긴다
- `heavy-slot.py` 가 같은 PC 에서 여러 worker 가 돌리는 무거운 검사를 대기열과 자리 수로 제한한다
- `merge-with-finish --run` 으로 머지 뒤 정리를 그 Run 의 worker 로 한정한다. 다른 코디네이터의 터미널을 닫던 문제를 고쳤다
- `launch-worker`, `make-worktree` 의 `--resume-remote` 로 원격 PR 브랜치를 새 워크트리에서 이어 받는다
- `cleanup-sweep.py --close-own-taken-over` 로 끝난 worker 가 남긴 사용자 보유 셸을 닫는다
- `watch-questions` 가 미답변 질문을 Monitor 로 알리고 10분마다 다시 알린다
- 모든 지시서에 `허락:` 줄이 필수다. `worker-ask --decision` 이 사용자 결정 질문의 형식(`결정:`, 선택지, `권장:`)을 검사한다
- 코디네이터 터미널에서 돌린 정리가 모든 워크트리를 터미널 소유 상태 조회 실패로 건너뛰던 문제를 고쳤다

## 1.x

- 7단계 절차(에이전트 고르기부터 머지와 정리까지)와 단계별 reference, 공통 지시서 틀, 저장소 오버레이를 두었다
- 머지 큐가 필수 체크, 미해결 스레드, HEAD 를 확인해 차례로 머지하고 base 최신화, 합친 사본 검사, `--up-to-date-when overlap` 을 받는다
- `merge-with-finish` 와 `finish-pr` 가 머지 뒤 worker 정리, 배포 성공 대기, 업무 완료, 보드 done 을 함께 건다
- `cleanup-sweep.py` 가 깨어날 때마다 머지된 워크트리, 브랜치, 터미널, 지시서를 지우고 `board-sync.py` 가 보드를 맞춘다
- `launch-worker` 가 지시서의 브랜치와 `허락:` 줄대로 띄우고, `send-to-worker` 가 답을 보내고 입력 대기인 worker 를 깨운다
- `wait-important` 가 heartbeat 를 넘기고 중요한 메시지나 끊긴 worker 에서만 깨어난다. `notify-conflicts` 가 충돌한 PR 의 worker 에게 알린다
- 띄우기 전 `spec-lint`, 스킬을 열 때 `orch-doctor` 가 돌고, worker 워크트리에 `gh pr merge` 와 `pkill` 을 막는 권한 규칙이 들어간다
- PreToolUse hook 이 백그라운드 대기, `cd` 뒤 git 쓰기, worker 터미널 직접 입력, 형식이 다른 `--spec` 을 거부한다
