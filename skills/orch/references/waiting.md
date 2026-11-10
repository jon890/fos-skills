# Orca 메시지로 기다리기

저장소마다 `orch loop start` 로 상주 루프를 등록한 뒤 턴을 끝낸다. worker 질문·보고와 루프 알림은 Orca 가 코디네이터를 깨운다. 별도 대기 프로세스는 두지 않는다.

## 메시지가 오면

사용자와 대화 중에 깨어나면 **사용자 답을 먼저 하고 깨운 메시지는 답에 덧붙이거나 다음 턴에 처리한다. 결정 질문이면 사용자에게 같이 묻는다.** 사용자 입력 시각으로 알림을 미루지 않는다.
Orca 가 check 명령을 지정한 깨움은 그 명령으로 읽는다. orch 감시 스크립트는 `check --peek` 또는 `check --all` 만 쓰고 메일을 읽음 처리하지 않는다.
`worker_done` 만으로 완료로 보지 않고 [완료 검증](verification.md)에 따라 PR 의 MERGED 와 근거를 확인한다.

## 루프 알림

루프는 등록된 Run 에 status 메시지를 보낸다. subject 첫 낱말은 알림 종류이고 payload 의 source 는 orch-loop 다. 알림 종류의 원본은 `scripts/loop/orch-loop.ts` 이다.
CI 실패, 충돌, 멈춤과 조회 실패는 기존 중복 억제 규칙을 따른다. 보내지 못하면 NOTICE-FAIL 을 기록하고 다음 틱에서 다시 시도한다. Run 없는 옛 루프는 로그에만 남긴다.
DONE-SUSPECT 는 준비 근거 없는 완료 보고, WORKER-LOST 는 끊긴 worker 를 뜻한다. 완료·끊김 이벤트와 보드 PR 연결도 루프가 맡는다. 첫 루프 틱은 지난 완료 보고를 알리지 않는다.
UNANSWERED 는 600초 넘게 남은 기술 질문 id 묶음이다. 같은 묶음은 다시 보내지 않고 질문이 추가되거나 해결되면 다시 확인한다.

## 새 사용자 결정을 놓치지 않기

사용자 결정은 decision-pending 이벤트가 맡는다. 저장소 핸들러가 있으면 그것만 부르고, 없으면 기본 핸들러가 Run 에 질문 절차를 요청한다. 같은 결정은 다시 묻지 않으며 실패 재시도는 `scripts/lib/decisions.ts` 가 소유한다.
기본 핸들러도 터미널에 글을 직접 넣지 않는다. 코디네이터는 [답하고 지시 보내기](replying.md)에 따라 사용자에게 묻고 원래 질문에 답한다.

## 상태 확인과 옛 명령

압축·계정 전환 뒤 `orch status` 와 `orch doctor --run` 으로 루프가 살아 있는지 확인한다. LOOP-DEAD 는 루프를 다시 시작하라는 뜻이다. 다시 시작한 루프는 앞서 멈춘 시간을 LOOP-RESTARTED 로 알린다.
WAITER-LEFT 는 옛 대기 프로세스가 남았다는 뜻이다. 출력의 pid 를 확인하고 안내한 kill 명령으로 직접 끝낸다. 스크립트는 자동 종료하지 않는다.
`orch wait` 와 하위 명령, 옛 NEXT_WAIT, `orch worker nudge` 는 RETIRED 한 줄과 종료 코드 2 로 끝난다. worker 메시지는 `orch worker send`, 화면 조회는 `orch worker screen <터미널>` 을 쓴다. PR 없는 작업은 띄울 때 `orch worker launch --no-pr` 로 기록한다.
