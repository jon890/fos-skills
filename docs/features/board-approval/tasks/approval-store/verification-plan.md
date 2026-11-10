# 승인 대기 명령과 저장 인수 검증 계획

이 계획은 PR1(approval-store)의 요구사항만 다룬다. 창(REQ5~REQ9)은 PR2 의 계획이 소유한다.
개발 테스트가 절차를 이미 표현하는 사례는 테스트 경로를 적고 다시 적지 않는다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ10 | 코디네이터가 묶인 Run 하나, 다른 Run 에 묶인 코디네이터 터미널 하나, Run 에 묶이지 않은 Orca 터미널 하나, Orca 밖 셸(터미널 변수 없음) 하나 | PR1 첫 실측. 네 셸에서 각각 `orca orchestration send --to run:<R> --type status --subject "PROBE <터미널 이름>" --payload '{"source":"board-approval-probe"}'` 를 `--from` 없이 보낸다. 코디네이터 터미널에서 `orca orchestration check --run <R> --all --types status --json` 과 `orca orchestration inbox --terminal run:<R> --limit 200 --full --json` 으로 네 메시지를 찾고 각 명령의 시간을 잰다. worker 판정 시간은 phase 03 작업 0 에서 worker 가 잰다 | 네 메시지 모두 보내지고 `from_handle` 이 보낸 터미널 handle 이다(Orca 밖 셸과 그 밖의 다른 값은 그대로 적는다). 두 명령 가운데 네 메시지를 모두 찾는 쪽과 그 시간을 아래 「실측 결과」 에 적는다 | 실제 Orca 코디네이터 세션 | 코디네이터 | 없음 | PR 전 |
| REQ1 | 임시 git 저장소, `ORCH_DIR`, 미리보기 파일 하나, 가짜 orca | `skills/orch/tests/board-approval.spec.ts` 의 REQ1 사례를 돌린다 | 다섯 종류 성공 줄 `APPROVAL-ADD <id> <kind> <버전>` 과 0, 필수 인자 빠짐 2 와 이름, 없는 미리보기와 빈 Run 은 1 이고 파일이 없다 | 로컬 node 테스트 | worker | 없음(보드 명령 구현의 잠금 함수가 main 에 있어야 하는 것은 phase 03 의 Blocked 조건이다) | PR 전 |
| REQ1 | 이 저장소 주 checkout, 코디네이터가 묶인 Run | 코디네이터 셸에서 `node <워크트리>/skills/orch/bin/orch.ts board approval add demo-approval --title 실측 --kind post --preview <임시 파일>` 뒤 `list` | `APPROVAL-ADD demo-approval post <n>`, `list` 한 줄. 승인 파일의 `run` 이 그 Run, `terminal` 이 코디네이터 터미널이다 | 실제 Orca 코디네이터 세션 | 코디네이터 | 없음(워크트리의 `node <워크트리>/skills/orch/bin/orch.ts` 로 부른다) | PR 전 |
| REQ2 | 임시 저장소 | `board-approval.spec.ts` 의 REQ2 사례 | 열린 대기 바꾸기에 ` replaced`, 승인된 기록을 다시 올린 뒤 `check` 가 「아직 누르지 않음」, `revise` 기록이 `list --full` 에 남는다 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ3 | 임시 저장소 | `board-approval.spec.ts` 의 REQ3 사례 | 열린 둘이면 두 줄, `cancel` 뒤 빠짐, 없는 id 의 `cancel` 1 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ4 | 저장소 소스 | `lib-commands.spec.ts` 와 `board-approval-static.spec.ts` 를 돌리고 `node skills/orch/bin/orch.ts board approval --help` 를 본다 | 도움말과 명령 표에 approve·revise 동작이 없다. 승인 상태를 쓰는 곳이 `core/approvals.ts` 밖에 없다 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ10 | 가짜 orca 가 내는 메시지와 worker 목록 | `board-approval.spec.ts` 의 REQ10 사례와 `core-approvals.spec.ts` 의 `checkVerdict` 표 | 통과 `APPROVAL-OK` 와 0, 거절 이유 아홉 가지가 각각 `APPROVAL-REJECT <id> <이유>` 와 1, 통과 뒤 둘째 `check` 는 「이미 사용함」 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ10 | 코디네이터가 묶인 Run, 위 실측의 열린 대기 | 코디네이터 셸에서 `orca orchestration send --to run:<Run> --type status --subject "APPROVED demo-approval <n>" --payload '{"source":"board-approval","id":"demo-approval","version":<n>}'` 를 보내고 `orca orchestration check --run <Run> --all --types status --json` 의 그 메시지를 본다. 같은 대기에 `check demo-approval` 을 부른다. `check demo-approval --version <n>` 도 부른다 | 메시지에 `id`, `from_handle`(또는 `from`), `subject`, `payload` 가 있고 `from_handle` 이 코디네이터 터미널이다. 두 `check` 모두 기록이 `open` 이라 「아직 누르지 않음」 이다 | 실제 Orca 코디네이터 세션 | 코디네이터 | push: 위 REQ1 실측의 열린 대기 | PR 전 |
| REQ11 | 임시 저장소 | `board-approval.spec.ts` 의 REQ11 사례 | 8일 전에 끝난 기록이 다음 쓰기 뒤 사라지고 30시간 열린 기록은 남는다 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ12 | 저장소 문서와 루프 소스 | `board-approval-docs.spec.ts` 를 돌린다 | `replying.md` 에 `STEP-READY ask` 처리와 `step-<항목>-<번호>` 규칙이 있고, `loop/` 소스에 승인 파일을 쓰는 곳이 없다 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ13 | 저장소 문서 | `board-approval-docs.spec.ts` 를 돌리고 `replying.md` 「보드 승인」 을 읽는다 | 막는 것, 막지 못하는 것(채팅 승인의 한계 포함), 「직접 고치지 않는다」 가 있다 | 로컬 node 테스트 | worker | 없음 | PR 전 |

worker 가 보낸 `APPROVED` 가 「아직 누르지 않음」 으로 거절되는 것은 기록 상태만으로 정해지므로 `core-approvals.spec.ts` 의 `checkVerdict` 사례로 증명한다. 실제 worker 를 띄워 보내게 하지 않는다.

실측이 끝나면 코디네이터는 `orch board approval cancel demo-approval` 로 남은 대기를 닫고 `APPROVAL-CANCEL demo-approval` 을 확인한다.

## PR2 로 미룬 인수 조건

| 요구사항 | 남은 인수 조건 |
| --- | --- |
| REQ2 | 같은 id 로 바꾼 직후 예전 화면의 「승인」·「고쳐 달라」 가 기록도 신호도 남기지 않고 toast 를 보인다 |
| REQ4 | 창 코드에서 승인 기록을 쓰는 곳이 사람이 누른 이벤트 처리 하나뿐이다 |
| REQ5~REQ9 | 스펙의 인수 조건 전부 |

## 실측 결과

코디네이터가 PR1 첫 실측(위 표의 첫 REQ10 행) 뒤 이 절을 채운다. phase 03 시작 전에 한다. phase 03 은 이 절이 비어 있으면 시작하지 않는다.

| 항목 | 결과 |
| --- | --- |
| `--from` 없이 보낸 메시지의 `from_handle`(네 셸) | 미측정 |
| Run 메일함 명령 선택과 시간 | 미측정 |
| approval 꼴 worker 판정 시간(phase 03 작업 0, worker) | 미측정 |
