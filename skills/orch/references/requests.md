# 메인 코디네이터와 요청

저장소마다 메인 코디네이터 하나가 worker 띄우기, 지시, 머지, 정리, 보드 쓰기를 맡는다. 다른 세션은 그 메인에게 요청만 보낸다([ADR-035](../../../docs/adr/035-orch-main-coordinator.md)).
메인 판정과 넘겨받기는 `scripts/loop/lifecycle.ts` 와 `scripts/loop/takeover.ts`, 쓰기 제한은 `scripts/lib/main-guard.ts`, 요청 명령은 `scripts/request/orch-request.ts` 의 파일 맨 위 설명이 소유한다.

## 메인 확인

`orch status` 의 `MAIN <Run> terminal=<터미널>` 이 그 저장소의 메인이다. `MAIN-NONE` 이면 메인이 없다.
메인은 루프에 등록된 Run 가운데 코디네이터 터미널에서 에이전트가 실행 중인 첫 Run 이다. 셸만 남은 터미널은 메인이 아니다.

## 쓰기 명령이 막힐 때

`NOT-MAIN main=<Run> caller=<Run> …` 이면 대상 저장소의 메인이 아닌 Run 에서 쓰기 명령을 불렀다. 함께 나온 `orch request send --to <저장소>` 로 일을 맡긴다. `--run` 에 메인 Run 을 써도 실제 호출 Run 은 바뀌지 않는다.
조회 명령과 dry-run, Run 에 묶이지 않은 사람의 셸, `/board` 화면은 그대로 쓴다. Orca 조회가 실패해도 `ORCA_TERMINAL_HANDLE` 이 없는 사람 셸은 막지 않는다.

직접 처리해야 할 이유가 있으면 쓰기 명령에 `--not-main "<이유>"` 를 붙인다. 빈 이유는 거절한다. 이미 허용된 메인이나 Run 없는 셸의 호출은 이 옵션이 있어도 우회 기록과 알림을 만들지 않는다. 이유는 대상 저장소의 띄우기 기록 아래에 남고 메인에게 알림이 간다. 알림이나 기록이 실패하면 실제 쓰기를 하지 않는다. 우회 전용 기록은 `scripts/lib/main-guard.ts`, worker 기록의 표지와 이유는 `scripts/lib/launched.ts` 가 소유한다. 저장 필드는 [데이터 스키마](../../../docs/data-schema.md)를 따른다.

이 기능 전에 띄운 worker 와, 대상 저장소에 메인이 없을 때 띄운 worker 는 원래 Run 이 지시·머지·정리까지 맡는다. 예외는 해당 worker 에만 적용한다. 그 Run 의 `cleanup sweep --apply --run <원래 Run>` 은 해당 worker 워크트리를 치우고 저장소 전체 정리 단계는 건너뛴다. 이때 `--run` 을 생략하면 실제 호출 Run 을 쓴다.
`orch doctor` 의 `NON-MAIN-RUN` 은 메인이 아닌 등록 Run, `FOREIGN-WORKER` 는 다른 Run 이나 다른 저장소에서 띄워 아직 기록이 남은 worker 다. 나온 worktree·spec 과 원래 Run 을 확인한다.

## `orch loop start` 가 막을 때

| 줄 | 뜻과 할 일 |
| --- | --- |
| `MAIN-EXISTS <Run> terminal=<터미널>` | 다른 세션이 메인이다. 그 저장소의 일은 아래 「요청 보내기」 로 맡긴다 |
| `TAKEOVER-CONFIRM <Run> …` | `--take-over` 만 줬다. 메인 Run 이 살아 있다는 것과 넘기면 그 Run 이 루프에서 빠진다는 것을 사용자에게 묻고, 답을 `--confirmed "<사용자 답>"` 으로 준다. 코디네이터가 대신 답하지 않는다 |
| `MAIN-UNKNOWN <이유>` | Orca 조회가 실패했다. 넘겨받지 않았다. Orca 가 응답하면 다시 부른다 |
| `TAKEOVER-BUSY` | 다른 세션이 넘겨받는 중이다. 끝난 뒤 다시 부른다 |
| `TAKEOVER-FAIL stop`, `TAKEOVER-FAIL start` | 안내 줄을 따른다. `start` 면 이 Run 이 이미 메인이라 같은 명령을 다시 부른다 |

메인이 없으면 `loop start` 가 스스로 넘겨받고 `MAIN-TAKEN <Run> from=<앞 Run>` 을 낸다. 따로 할 일은 없다.
`WORKER-NOT-MOVED` 줄의 worker 는 앞 Run 에 남았다. `orch status` 와 루프 알림의 `OLD-RUN-WORKER` 줄에서 옛 Run, dispatch, 워크트리, 마지막 보고를 확인한다. 보고 전문은 `orca orchestration inbox --terminal run:<옛 Run> --full` 로 읽는다.
작업 중이면 그 worker 가 쉰 뒤 `orch loop start --take-over` 로 다시 옮긴다. `WORKER-MOVE-FAIL` 은 줄의 이어받기 파일로 `orch worker adopt` 를 쓴다.
`REQUEST-OPEN` 줄은 앞 메인이 받아 두고 끝내지 않은 요청이다. 아래 「요청 받기」 대로 이어 맡는다.

## 요청 보내기

다른 저장소나 같은 저장소의 메인에게 맡길 일은 worker 를 직접 띄우지 않고 요청한다.

```bash
orch request send --to <저장소 경로> --title "<제목>" --body-file <본문 파일>
```

`REQUEST-SENT R<n> …` 이면 보냈다. 두 저장소가 같은 보드 파일을 쓸 때는 받는 쪽 항목 하나가 생긴다. 다른 보드를 쓰면 보낸 쪽에도 기다리는 항목이 생긴다. `BOARD-FAIL` 이면 보드 쓰기가 막혔다. 요청 메시지는 이미 갔다. 답(받음, 보류, 거절, 완료, 실패)은 Orca 메시지로 온다. 받음·보류·거절 답이 30분(`pipeline.request_ack_sec`) 없으면 `REQUEST-NO-ACK` 가 한 번 온다. 다시 보낼지는 보낸 쪽이 정한다.
`REQUEST-NO-MAIN` 이면 그 저장소에 메인이 없다. 지금처럼 worker 를 직접 띄운다.

## 요청 받기

`REQUEST` 메시지를 받으면 본문을 읽고 받음, 보류, 거절 가운데 하나를 바로 보낸다. 거절과 보류는 이유를 붙인다. 이 저장소의 사용자 결정과 다른 요청이면 사용자에게 먼저 묻는다.

```bash
orch request accept R<n>
orch request hold R<n> --reason "<이유>"
orch request reject R<n> --reason "<이유>"
```

받은 일로 worker 를 띄울 때는 보드 항목을 확인하고, 메시지에 적힌 id 를 지시서의 `보드 항목 id:` 에 둔다. 새 요청은 `req-<받는 저장소 이름>-<n>` 을 쓰고, 기존 요청은 기록된 id 를 쓴다. worker 가 그 요청 항목에 붙고, 마지막 PR 의 마무리가 그 항목을 done 으로 닫고 `FINISH-DONE` 이면 orch 가 완료를 자동으로 보낸다. 다른 PR 이나 단계가 남으면 보내지 않는다(`REQUEST-OPEN` 줄).
PR 없는 일, 메인이 직접 처리한 일, 마무리가 실패한 일은 직접 끝낸다.

```bash
orch request done R<n> [--reason "<이유>"]
orch request fail R<n> --reason "<이유>"
```

요청으로 띄운 worker 의 사용자 결정 질문은 받은 메인이 자기 화면과 보드로 사용자에게 묻는다. 보낸 쪽에 넘기지 않는다.
받은 요청 목록은 `orch request list --open` 이다.
