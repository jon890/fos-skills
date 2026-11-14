# Orca 메시지로 기다리기

저장소마다 `orch loop start` 로 상주 루프를 등록한 뒤 턴을 끝낸다. worker 질문·보고와 루프 알림은 Orca 가 코디네이터를 깨운다. 별도 대기 프로세스는 두지 않는다.

## 메시지가 오면

`STEP-READY auto`·`STEP-READY ask` 를 받았거나 `worker_done`·머지·배포 알림으로 깨어났을 때 그 보드 항목의 다음 단계가 `[auto]` 나 `[ask]` 면 [`replying.md` 「다음 단계 이어 가기」](replying.md#다음-단계-이어-가기)를 따른다.

제목이 `APPROVED <id>`·`REVISE <id>` 이거나 payload `source` 가 `board-approval` 인 메시지는 [`replying.md` 「보드 승인」](replying.md#보드-승인)을 따른다.

사용자와 대화 중에 깨어나면 **사용자 답을 먼저 하고 깨운 메시지는 답에 덧붙이거나 다음 턴에 처리한다. 결정 질문이면 사용자에게 같이 묻는다.** 사용자 입력 시각으로 알림을 미루지 않는다.
Orca 가 check 명령을 지정한 깨움은 그 명령으로 읽는다. orch 감시 스크립트는 `check --peek` 또는 `check --all` 만 쓰고 메일을 읽음 처리하지 않는다.
`worker_done` 만으로 완료로 보지 않고 [완료 검증](verification.md)에 따라 PR 의 MERGED 와 근거를 확인한다.

## 루프 알림

루프는 등록된 Run 에 status 메시지를 보낸다. subject 첫 낱말은 알림 종류이고 payload 의 source 는 orch-loop 다. 알림 종류의 원본은 그 알림을 내는 `scripts/loop/steps/` 의 단계 파일과 `scripts/loop/lifecycle.ts` 다.
CI 실패, 충돌, 멈춤과 조회 실패는 기존 중복 억제 규칙을 따른다. 보내지 못하면 NOTICE-FAIL 을 기록하고 다음 틱에서 다시 시도한다. Run 없는 옛 루프는 로그에만 남긴다.
DONE-SUSPECT 는 준비 근거 없는 완료 보고, WORKER-LOST 는 끊긴 worker 를 뜻한다. 완료·끊김 이벤트와 보드 PR 연결도 루프가 맡는다. 첫 루프 틱은 지난 완료 보고를 알리지 않는다.
`--no-pr`, `review` 행, 독립된 `머지하지 않는다` 지시로 띄운 dispatch 는 `completion: none` 을 기록해 준비 보고가 없어도 DONE-SUSPECT 에서 뺀다. 문장 앞 목록 기호와 번호는 허용하며, 배경 속 인용·코드 예시·「머지는 코디네이터가 한다」 는 제외 근거가 아니다. 완료 기준 절에 `준비됨` 보고를 요구하면 행과 지시의 자동 제외보다 그 요구를 우선한다. 정리 뒤에도 영구 이력의 같은 값을 쓴다.
PR 을 열지 않는 지시서의 완료 기준이 `MERGED` 를 요구하지 않고 worker_done 첫 줄이 `완료:`이면 정상 완료로 본다. PR 을 여는 일의 `완료:` 보고에는 기존처럼 준비됨 status 가 필요하다.
제외 기록이 없는 옛 리뷰 dispatch 는 지시서나 첫 status 의 `판정:` 줄로 알아보고, 앞서 보낸 결과 status 가 있어야 정상 완료로 본다. 지시서는 띄우기 기록이 지워진 뒤에도 영구 이력으로 찾는다.
DONE-SUSPECT 는 `state/done-seen/<Run>.json` 의 `suspects`(dispatch 목록), WORKER-LOST 는 `state/wait-important-lost.json` 의 `<Run>.<dispatch>` 가 보낸 기록이다. 루프를 다시 띄워도 이 파일이 남아 같은 dispatch 의 알림을 한 번만 보낸다.
UNANSWERED 는 600초 넘게 남은 기술 질문 id 묶음이다. 같은 묶음은 다시 보내지 않고 질문이 추가되거나 해결되면 다시 확인한다.
끝나거나 해제된 dispatch, 끝난 Task, `dispatch_inactive` 로 닫은 질문은 제외한다. Task 상태를 읽지 못하면 경고 한 줄을 남기고 질문을 유지한다.

### 바로 보내는 알림과 모아 보내는 알림

`STEP-READY` 는 그 틱에 바로 보낸다. 받으면 [`replying.md` 「다음 단계 이어 가기」](replying.md#다음-단계-이어-가기)를 따른다. 코디네이터가 무언가 해야 하는 알림만 그 틱에 바로 보낸다. 안내성이거나 다음 틱에 풀리는 알림은 `loop.log` 에 남기고 Run 메시지는 모아 DIGEST 하나로 보낸다. 원본은 `scripts/lib/notice-digest.ts` 이다.

| 방식 | kind |
|---|---|
| 바로 | STEP-READY, CI-FAILED, QUEUE-CONFLICT, CONFLICT-*, WORKER-LOST, UNANSWERED, WORKER-STALLED, WORKER-IDLE, DONE-SUSPECT, LOOP-DEAD 류, LOOP-UPDATED, LOOP-UPDATE-FAIL, DECISION-PENDING, HEAVY-SLOT-HELD, FINISH-MISSING, BOARD-UNMATCHED, QUEUE-DROPPED(머지 큐가 뺀 PR 번호와 이유. 같은 PR 의 같은 이유는 한 번만). 표에 없는 kind 도 바로 보낸다 |
| 모음 | WATCH-ERROR, LEGACY-NOTICE, STAGE-STALLED, LOOP-RESTARTED |

모은 알림은 `state/notice-digest/<Run>.json` 에 쌓고 `pipeline.digest_sec`(기본 1800초)마다 DIGEST 하나로 보낸다. 모을 것이 없으면 보내지 않는다. 같은 이유의 WATCH-ERROR 가 연속 세 번째 틱이면 바로 한 번 보낸다. 부모의 틱 실패(`tick`)도 같고, 본문 앞에 저장소 루트 폴더 이름을 쓰며 원인 줄을 담는다.

한 Run 에 저장소마다 루프가 등록돼 있으면 같은 알림이 루프 수만큼 오지 않게, 보내기 전에 머신 폴더의 `run-notices/<Run>/<해시>` 를 본다. 다른 저장소의 루프가 10분 안에 같은 Run, kind, 본문을 보냈으면 보내지 않는다(`lib/run-notice.ts`). 완료 보고 확인은 이 저장소가 띄우지 않은 dispatch 의 PR 조회가 실패하면 건너뛴다. 띄운 저장소의 루프가 맡는다.

## 새 사용자 결정을 놓치지 않기

사용자 결정은 decision-pending 이벤트가 맡는다. 저장소 핸들러가 있으면 그것만 부르고, 없으면 기본 핸들러가 Run 에 질문 절차를 요청한다. 같은 결정은 다시 묻지 않으며 실패 재시도는 `scripts/lib/decisions.ts` 가 소유한다.
기본 핸들러도 터미널에 글을 직접 넣지 않는다. 코디네이터는 [답하고 지시 보내기](replying.md)에 따라 사용자에게 묻고 원래 질문에 답한다.

## 상태 확인과 옛 명령

압축·계정 전환 뒤 `orch status` 와 `orch doctor --run` 으로 루프가 살아 있는지 확인한다. LOOP-DEAD 는 루프를 다시 시작하라는 뜻이다. 다시 시작한 루프는 앞서 멈춘 시간을 LOOP-RESTARTED 로 알린다.
WAITER-LEFT 는 옛 대기 프로세스가 남았다는 뜻이다. 출력의 pid 를 확인하고 안내한 kill 명령으로 직접 끝낸다. 스크립트는 자동 종료하지 않는다.
`orch wait` 와 하위 명령, 옛 NEXT_WAIT, `orch worker nudge` 는 RETIRED 한 줄과 종료 코드 2 로 끝난다. worker 메시지는 `orch worker send`, 화면 조회는 `orch worker screen <터미널>` 을 쓴다. PR 없는 작업은 띄울 때 `orch worker launch --no-pr` 로 기록한다.

## 플러그인을 갱신한 뒤

상주 루프는 틱 사이에 옛 번들을 알아채면 이 저장소의 머지 큐·마무리가 끝날 때까지 최대 60분 기다린 뒤 새 설치본으로 다시 뜬다. 틱이 설정 오류로 실패하면 바로 다시 뜬다. 성공하면 등록된 Run 마다 `LOOP-UPDATED` 를 보내고, 실패하면 `LOOP-UPDATE-FAIL` 을 보내며 옛 루프가 계속 돈다. 두 알림은 모아 보내지 않으며, 전송 실패는 로그에만 남기고 다시 보내지 않는다.
`LOOP-UPDATE-FAIL` 을 받았을 때와 이 기능 전 번들로 뜬 루프는 그 Run 의 코디네이터 세션에서 `orch loop stop` 뒤 `orch loop start` 로 다시 띄운다. `orch loop status` 의 `bundle=` 로 버전을 확인한다. start 만 부르면 옛 루프에 합류할 수 있다.
새 설치본이 망가져 `orch loop stop` 도 실행되지 않으면, orch 상태 폴더의 `state/loop.json` 에서 옛 루프 pid 를 읽고 `ps -p` 에 그 pid 를 줘서 해당 루프인지 확인한 뒤 `kill -TERM` 에 같은 pid 를 줘서 멈춘다. 설치본을 복구한 뒤 다시 시작한다.
루프 밖에서 직접 부른 스크립트의 `STALE-BUNDLE` 경고는 그대로다.
다시 시작한 루프는 옛 파일에 남은 읽지 않은 알림을 정리 단계에서 Run 메시지로 전달한다. 앞 루프에서 등록을 뺀 Run 은 재시작 알림이 거절돼도 한 번만 시도하고, 지금 등록된 Run 의 일시 실패는 다음 틱에 재시도한다.

## 못 맞춘 머지 알림

`BOARD-UNMATCHED <항목> PR #<번호>` 는 머지를 가리키는 줄이 없어 남은 단계를 끝내지 못했다는 뜻이다. 보드 동기화나 마무리가 기록한 뒤 다음 틱 안에 주 Run 으로 바로 보낸다. 배포를 기다리는 마무리는 보드에 반영한 뒤부터 센다. 같은 항목·PR 은 성공한 전송을 저장해 루프를 다시 띄워도 한 번만 알린다. 전송 실패나 주 Run 없음은 다음 틱에 다시 본다.

옛 단계 항목은 끝냈어야 할 줄에 `orch board step <항목> <번호> text "<줄 전체>" --on "<PR> merge"` 로 꼬리표를 붙인다. 그런 줄이 없으면 `orch board add-step <항목> "<PR 이 한 일>" --on "<PR> merge"` 로 더한다. 다음 동기화가 그 줄을 끝내면 기록을 지운다. `stages` 가 있는 마일스톤 항목에는 꼬리표를 붙이지 않는다. 사건 줄이 지워졌는지 확인하고 남은 단계를 직접 끝낸다.

항목이 없어지거나 끝나지 않은 단계가 없어져도 기록을 지운다. 다른 PR 의 꼬리표 완료는 이 PR 의 기록을 지우지 않는다.
