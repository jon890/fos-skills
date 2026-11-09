# orch 구조 정리: Orca 깨움으로 바꾸기, 두 층 나누기, 큰 스크립트 쪼개기

확인: 2026-11-09

## 목표

worker 가 한 질문과 보고를 코디네이터가 놓치지 않는다. orch 는 Orca 의 기본 동작(메시지가 오면 Orca 가 코디네이터와 worker 를 직접 깨운다)을 따르고, 그와 겹치는 자체 대기와 터미널 직접 입력을 없앤다.
그 위에서 orch 스크립트를 「바깥 프로그램을 부르는 코드」 와 「값을 받아 결과를 정하는 코드」 로 나누고, 겹치는 코드를 합치며, 큰 스크립트를 단계별 파일로 쪼갠다. 그래서 결과를 정하는 코드를 가짜 orca·gh 없이 값만 넣어 테스트할 수 있다.

- 배경(사용자 2026-11-09): 가장 먼저 줄일 불편은 worker 질문을 코디네이터가 놓쳐, 사용자가 나중에 「질문 확인해 줘」 라고 다시 요청하는 일이다.
- 배경(Orca 1.4.254 `orca orchestration check --help`, `orca skills get orchestration`): 메일을 읽음 처리하는 감시 스크립트를 쓰면 Orca 가 코디네이터를 깨울 메일이 사라진다. 감시는 `--peek` 만 쓴다. worker 터미널에 직접 입력하지 말고 `send` 를 쓴다.
- 배경(코드, 2026-11-09): `orch wait`(`skills/orch/scripts/wait/wait-important.ts:600`)은 `check --ack --wait` 로 메일을 읽음 처리한다. 쉬는 worker 는 터미널 직접 입력(`worker/nudge-worker.ts`)으로 깨우고, 사용자 결정 알림도 코디네이터 터미널에 직접 입력한다(`handlers/decision-pending.ts`).
- 배경(실측 2026-11-09, `.omc/previews/orca-measure-20261109.md`): `send` 는 쉬는 worker 와 일을 마친 worker 를 모두 깨운다. 마친 worker 에게 보내면 새 Task 가 생기고 같은 터미널이 이어 일한다. 가이드 방식의 `ask`(보내고 턴을 끝냄)는 답이 오면 worker 가 한 턴만 더 돈다.
- 배경(크기, 2026-11-09): `loop/orch-loop.ts` 3021줄, `cleanup/cleanup-sweep.ts` 2072줄, `queue/merge_queue.ts` 1750줄, `wait/wait-important.ts` 1173줄, `scripts/lib/` 파일 68개. lib 파일 가운데 바깥 프로그램이나 파일을 직접 부르지 않는 것은 14개다.
- 출처: [orch-cli 스펙](../orch-cli/spec.md) DECISION9 가 이 정리를 뒤 기능으로 미뤘다.

## 범위

이번 범위:

- 코디네이터 대기를 Orca 깨움으로 바꾸기. 상주 루프의 알림을 Orca 메시지로 보내기
- 사용자와 대화 중일 때 깨우지 않던 동작을 없애기
- 의심스러운 완료 보고 표시를 상주 루프로 옮기기
- worker 깨우기와 후속 일 주기를 `send` 로 바꾸기. 코디네이터 터미널 직접 입력도 함께 없애기
- `orch worker ask` 를 가이드 방식(보내고 바로 끝남)으로 바꾸기
- 없어지는 옛 명령의 안내
- `orch wait` 이 하던 감시 일을 상주 루프로 옮기기, 「미답변 질문 남음」 알림
- 필요 없어지는 상태 파일 둘(루프 알림 파일, `orch wait` 원문) 없애기
- `skills/orch/scripts/` 전체의 두 층 나누기, 겹치는 코드 합치기
- `orch-loop.ts`, `merge_queue.ts`, `cleanup-sweep.ts` 를 단계별 파일로 쪼개기

범위 밖:

- 사용자 결정 알림 기록(`state/decision-pending/<Run>.json`)을 Orca 결정 게이트로, 움직임 기록(`state/movement.json`)을 Orca 의 worker 생존 판정으로 대신하기. 설계 단계에서 같은 정보를 주는지 재고, 준다면 그때 다시 묻는다(DECISION7)
- 머지 큐·자동 머지·번호 예약·이력 파일. Orca 에 대응하는 기능이 없다
- Orca 자체를 고치는 일, 다른 스킬(spec, plan 등)의 스크립트, work-board 의 `board.ts`

## 요구사항과 인수 조건

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| REQ1 | worker 질문과 보고가 오면 Orca 가 코디네이터를 깨운다. 코디네이터가 따로 대기를 걸어 둘 필요가 없다 | 실제 Orca 에서 `orch wait` 류 프로세스가 하나도 없는 채로 worker 가 질문하면 코디네이터 화면에 그 메시지가 들어오고, 코디네이터가 답하면 worker 가 깬다 |
| REQ2 | orch 스크립트는 코디네이터의 메일을 읽음 처리하지 않는다 | orch 스크립트에서 `orca orchestration check` 를 부르는 곳이 모두 `--peek` 이나 `--all` 을 쓰는 것을 테스트가 확인한다. `--ack` 를 쓰는 곳이 없다 |
| REQ3 | 상주 루프가 코디네이터에게 알릴 일(CI 실패, 충돌 PR, 사용자 결정 남음, 조회 실패 등)은 그 Run 에 Orca 메시지로 보낸다 | 루프 틱이 알릴 일을 만들면 `orca orchestration inbox --terminal run:<Run>` 에 그 메시지가 보이고 코디네이터가 깬다. `state/loop-events/` 에 새 파일이 생기지 않는다 |
| REQ4 | 사용자와 대화 중인지 따지지 않는다. 루프 알림을 미루지 않는다 | 사용자가 방금 입력한 터미널에도 루프 알림이 그 틱에 간다. 마지막 사용자 입력 기록 hook 과 그 판정이 없다 |
| REQ5 | 의심스러운 완료 보고(예: PR 이 MERGED 가 아닌데 온 worker_done)는 상주 루프가 찾아 그 Run 에 알린다. 코디네이터는 지금 마무리 절차의 MERGED 확인을 그대로 하고, 루프 경고는 안전망이다 | 그런 worker_done 이 온 뒤 한 틱 안에 그 dispatch 와 이유가 든 메시지가 Run 에 dispatch 마다 한 번 온다. 띄울 때 PR 없는 작업으로 기록한 dispatch 에는 오지 않는다. 판정은 지금 `lib/completion.ts` 와 같은 입력에 같은 결과다 |
| REQ6 | 쉬는 worker 를 깨우거나 마친 worker 에게 후속 일을 줄 때 `orca orchestration send` 를 쓴다. 코디네이터와 worker 터미널에 글을 직접 넣지 않는다 | orch 스크립트에 `terminal send` 로 사람 대신 입력하는 곳이 없다. 마친 worker 에게 보낸 후속 일이 새 Task 로 같은 터미널에서 시작된다. 다시 띄우기는 터미널이 없거나 `send` 가 거절될 때만 쓴다 |
| REQ7 | `orch worker ask` 는 질문을 보내고 바로 끝난다. worker 는 턴을 끝내고 Orca 가 답과 함께 깨운다 | `orch worker ask` 가 답을 기다리지 않고 질문 id 를 내고 0 으로 끝난다. `--decision` 형식 검사와 읽지 않은 메시지 확인(5)은 지금과 같다. orch 가 맞춰 주는 공통 지시서 규칙(`scripts/spec/sync-common.ts` 가 쓰는 원본)과 스킬 문서에 기다림 설명(시간 초과 재개, 최대 대기)이 없다 |
| REQ8 | 없어진 옛 명령을 부르면 한 줄 안내를 내고 실패한다 | `orch wait`, 옛 `NEXT_WAIT` 꼴, `orch worker nudge`, `orch worker ask --resume` 이 「없어졌다, Orca 가 깨운다, 읽을 문서」 를 한 줄로 내고 0 이 아닌 코드로 끝난다. 옛 대기가 메일을 읽음 처리하지 않는다 |
| REQ9 | 필요 없어진 상태 파일(루프 알림 파일, `orch wait` 원문)을 더 쓰거나 읽지 않는다 | `state/loop-events/`, `state/wait/` 를 쓰거나 읽는 코드가 없고 `docs/data-schema.md` 에서 두 항목이 빠진다. 남은 옛 파일은 정리 단계가 휴지통으로 옮긴다 |
| REQ10 | 결과를 정하는 코드는 가짜 orca·gh 실행 파일 없이 값만 넣어 테스트할 수 있다. 다시 섞이지 않게 막는 장치가 있다 | 결과를 정하는 코드의 테스트가 가짜 실행 파일을 깔지 않는다. 결과를 정하는 코드에 바깥 프로그램이나 파일 호출을 넣으면 실패하는 검사가 CI 에서 돈다 |
| REQ11 | 같은 일을 하는 코드는 한 벌만 둔다 | worker 목록 읽기, orca JSON 읽기, 터미널 닫기, pid 생존 확인, git 실행 파일 고르기, 객체 판정이 각각 한 곳에만 정의돼 있다 |
| REQ12 | `orch-loop.ts`, `merge_queue.ts`, `cleanup-sweep.ts` 는 단계별 파일로 나뉜다 | 각 스크립트의 본 파일은 단계를 차례로 부르고 결과를 모으는 일만 한다. 단계 하나를 고칠 때 그 단계 파일만 바뀐다 |
| REQ13 | 구조 정리 PR 은 겉 동작을 바꾸지 않는다 | 기존 테스트의 기대값을 바꾸지 않고 통과한다. 정리 전에 고정한 입력(가짜 orca·gh)으로 루프 틱, 머지 큐, 정리를 돌린 출력·종료 코드·상태 파일이 정리 뒤와 글자 하나 다르지 않다 |
| REQ14 | `orch wait` 이 하던 감시 일(끊긴 worker 찾기, worker-done·worker-lost 이벤트, 보드의 pr 칸 채우기)은 상주 루프가 맡는다. 루프가 죽은 것은 doctor, `orch status`, 다음 루프 시작이 알린다 | 터미널이 사라진 dispatch 가 있으면 한 틱 안에 그 Run 에 WORKER_LOST 알림이 오고 worker-lost 이벤트가 한 번 불린다. 근거가 ready 인 worker_done 뒤 한 틱 안에 보드 pr 칸이 채워지고 worker-done 이벤트가 불린다. 루프를 죽이면 `orch status` 와 doctor 가 그 사실을 보인다 |
| REQ15 | 질문이 답 없이 일정 시간 남으면 그 Run 에 「미답변 질문 남음」 알림을 한 번 보낸다 | 지금 재알림 기준 시간이 지나도 답이 없는 질문이 있으면 그 질문 id 가 든 메시지가 Run 에 한 번 온다. 같은 질문 묶음으로는 다시 오지 않고, 묶음이 바뀌면 다시 온다 |
| REQ16 | 사용자 결정 알림(decision-pending)의 이벤트와 저장소 핸들러 계약은 그대로다. 기본 핸들러만 Orca 메시지를 Run 에 보낸다 | 저장소 핸들러가 없으면 결정이 남을 때 Run 에 Orca 메시지가 오고 코디네이터 터미널에 직접 입력되지 않는다. 저장소 핸들러가 있으면 그 핸들러만 불린다. send 가 실패하면 지금 재시도 규칙대로 다시 낸다 |
| REQ17 | 멈춘 worker 를 다시 시도시키는 저장소 핸들러는 `orch worker send` 를 쓴다. doctor 가 `orch worker nudge` 를 쓰는 저장소 핸들러를 알린다 | references/hooks.md 예시가 `orch worker send` 를 쓴다. nudge 를 부르는 핸들러가 있는 저장소에서 doctor 가 그 파일을 한 줄로 알린다 |
| REQ18 | 마친 worker 에게 주는 후속 일도 지시서 파일로 쓰고 send 로 보낸 뒤 띄우기 기록에 남긴다 | 후속 일의 지시서도 `허락:` 줄 검사를 거친다. 보낸 뒤 `state/launch-history.jsonl` 에 새 dispatch 와 Task 가 남고 `orch status` 와 보드가 그 일을 보인다 |
| REQ19 | 사용자와 대화 중에 깨어난 코디네이터는 사용자 답을 먼저 한다 | references/waiting.md 에 「사용자 답을 먼저 하고 깨운 메시지는 답에 덧붙이거나 다음 턴에 처리한다. 결정 질문이면 사용자에게 같이 묻는다」 규칙이 있다 |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 코디네이터가 깨어나는 방식 | Orca 깨움만 쓴다. `orch wait` 대기를 없애고 루프 알림은 Orca 메시지로 보낸다. 루프가 보낸 메시지로 코디네이터가 실제로 깨는지 설계 단계에서 재고, 깨지 않으면 읽음 처리하지 않는 대기(`check --peek --wait`)로 내려간다 | 사용자 2026-11-09 | 2라운드 답. 질문을 놓치는 주된 길이 꺼진 대기와 대기가 먼저 읽음 처리한 메일이다 |
| DECISION2 | 대화 중일 때 깨우기 | 대화 중에도 깨운다. 대화 중 판정(`lib/user-active.ts`, 입력 기록 hook, 루프의 미루기)을 없앤다 | 사용자 2026-11-09 | 2라운드 답. Orca 깨움은 orch 가 막을 수 없어 남겨도 막는 것이 루프 알림뿐이다 |
| DECISION3 | 의심스러운 완료 보고 표시 | 상주 루프가 틱마다 찾아 Run 에 Orca 메시지로 알린다. 최대 한 틱 늦다 | 사용자 2026-11-09 | 2라운드 답. 판정 코드는 그대로 쓰고 코디네이터 절차를 늘리지 않는다 |
| DECISION4 | worker 깨우기와 후속 일 주기 | `send` 로 바꾼다. 터미널 직접 입력과 「지시서를 새로 써서 다시 띄우기」 를 없애고, 다시 띄우기는 터미널이 없거나 `send` 가 거절될 때만 남긴다. 자동 해제 시각이 지난 worker 에게 보낼 때의 동작은 설계 단계에서 잰다 | 사용자 2026-11-09 | 2라운드 답, 실측 보고서 3절 |
| DECISION5 | worker 질문 방식 | 가이드 방식. 보내고 바로 끝나며 worker 는 턴을 끝낸다. 기다리는 옵션은 두지 않는다 | 사용자 2026-11-09 | 2라운드 답, 실측 보고서 2절 |
| DECISION6 | 옛 명령을 부를 때 | 한 줄 안내와 0 이 아닌 종료 코드 | 사용자 2026-11-09 | 2라운드 답. 옛 대기가 남으면 Orca 깨움과 메일을 다툰다 |
| DECISION7 | Orca 기능으로 대신할 상태 파일 | 루프 알림 파일과 `orch wait` 원문만 없앤다. 사용자 결정 알림 기록과 움직임 기록은 설계 단계 실측 뒤 다시 묻는다 | 사용자 2026-11-09 | 2라운드 답 |
| DECISION8 | 두 층 경계 | 목표: 결과를 정하는 코드는 가짜 orca·gh 없이 값만 넣어 테스트한다. 다시 섞이지 않게 막는 장치를 함께 둔다. 나누는 방법(폴더, import 검사 등)은 설계에서 정한다 | 사용자 2026-11-09 | 2라운드 답 |
| DECISION9 | PR 나누기와 순서 | 동작 변경을 먼저: PR1 질문 방식(REQ7), PR2 `send` 로 깨우기(REQ6, 18), PR3 대기 구조·루프 알림·대화 중 판정 제거·완료 표시·상태 파일 둘·옛 명령 안내·감시 일 옮기기(REQ1~5, 8, 9, 14~17, 19), PR4 두 층 나누기와 겹치는 코드 합치기(REQ10, 11), PR5 루프 쪼개기, PR6 머지 큐 쪼개기, PR7 정리 쪼개기(REQ12). 구조 정리 PR 은 REQ13 을 지킨다 | 사용자 2026-11-09 | 2라운드 답. 지울 코드를 옮기지 않고 질문 놓침이 PR3 에서 풀린다 |
| DECISION10 | 동작 같음 확인 | 기존 테스트의 기대값을 바꾸지 않는다. 바꿔야 하면 멈추고 묻는다. 고정 입력 출력 비교를 루프, 머지 큐, 정리에 둔다 | 사용자 2026-11-09 | 2라운드 답 |
| DECISION11 | 범위 | 머지 큐와 정리까지 이번에 정리한다. Orca 가이드와 달라도 지킬 orch 고유 동작은 없다 | 사용자 2026-11-09 | 1라운드 답 |
| DECISION12 | 남은 옛 상태 파일 | 정리 단계가 `state/loop-events/`, `state/wait/` 의 남은 파일을 휴지통으로 옮긴다. 읽지 않은 루프 알림은 옮기기 전에 Run 에 Orca 메시지로 한 번 보낸다 | 사용자 2026-11-09 | 작성자가 기존 정리 관례(`cleanup-sweep.ts` 의 휴지통 옮기기)로 내고 스펙 확인 때 사용자가 확인했다 |
| DECISION13 | 겹치는 코드 목록 | REQ11 의 여섯 가지(2026-11-09 함수 이름 조사: `workerRows` 3곳, `orcaJson` 3곳, `closeTerminal` 3곳, `pidAlive` 3곳, `gitBin` 3곳, `isObject` 12곳). 설계에서 더 찾으면 더한다 | 작성자 | 코드를 읽어 정해지는 것 |
| DECISION14 | 가이드 방식 ask 에 남길 동작 | 끝난 dispatch 의 Run 메일함 대신 보내기(3, `SENT-RUN`), Orca 바쁨 재시도, 읽지 않은 메시지 확인(5), `--decision` 검사는 둔다. 이미 도는 worker 가 넘기는 `--timeout-ms`, `--max-wait` 는 받고 쓰지 않으며 stderr 에 한 줄 알린다. `--resume` 은 DECISION6 대로 실패한다 | 작성자 | 독립 검토 8. 지금 도는 worker 를 사용법 오류로 멈추지 않고, 기다리는 일만 없앤다 |
| DECISION15 | `orch wait` 의 하위 명령 | `orch wait questions`, `orch wait triage`, `orch wait user-active`, `orch wait ack-lost` 도 DECISION6 대로 한 줄 안내와 실패다 | 작성자 | 독립 검토 9. questions 는 Orca 가 질문마다 깨우므로 대안이 필요 없고, triage 는 없어지는 `state/wait/` 를 읽고, user-active 는 DECISION2 로 없어진다 |
| DECISION16 | 루프 알림의 겹침 막기 | 지금 알림 파일에 쓰던 규칙(같은 이유는 이유가 바뀔 때만, 같은 HEAD 는 한 번만)을 Orca 메시지에도 그대로 둔다 | 작성자 | 독립 검토 4. 두지 않으면 틱마다 코디네이터를 깨운다 |
| DECISION17 | `orch wait` 의 감시 일 | 상주 루프로 옮긴다. 루프가 죽은 것은 doctor, `orch status`, 다음 루프 시작이 알린다 | 사용자 2026-11-09 | 3라운드 답. 질문과 보고는 Orca 가 직접 깨우므로 루프가 죽어도 질문은 놓치지 않는다 |
| DECISION18 | 완료 보고가 루프 경고보다 먼저 올 때 | 코디네이터의 기존 마무리 절차(PR MERGED 확인)를 믿는다. 경고는 dispatch 마다 한 번, PR 없는 작업은 띄울 때 기록으로 가린다 | 사용자 2026-11-09 | 3라운드 답 |
| DECISION19 | 미답변 질문 다시 알리기 | NO-WAIT 를 「미답변 질문 남음」 알림으로 바꿔 남긴다. 같은 질문 묶음은 다시 보내지 않는다 | 사용자 2026-11-09 | 3라운드 답 |
| DECISION20 | decision-pending 핸들러 | 이벤트와 저장소 핸들러 계약은 그대로, 기본 핸들러만 Orca 메시지로 바꾼다 | 사용자 2026-11-09 | 3라운드 답 |
| DECISION21 | 멈춘 worker 다시 시도 핸들러 | `orch worker send` 로 바꾼다. 오류로 멈춘 worker 를 send 가 깨우는지 설계 단계에서 재고, 깨우지 않으면 다시 묻는다. doctor 가 nudge 를 쓰는 저장소 핸들러를 알린다 | 사용자 2026-11-09 | 3라운드 답 |
| DECISION22 | 후속 일의 기록 | 지시서 파일로 쓰고 send 로 보낸 뒤 띄우기 기록에 남긴다 | 사용자 2026-11-09 | 3라운드 답 |
| DECISION23 | 대화 중에 깨어났을 때 | 사용자 답을 먼저 하고, 깨운 메시지는 덧붙이거나 다음 턴에 처리한다 | 사용자 2026-11-09 | 3라운드 답 |

## 도메인 규칙 변경

도메인 규칙 변경 없음: orch 내부 동작과 코드 구조만 바뀐다. 여러 기능이 참조하는 `docs/domain/` 규칙이 없다.
