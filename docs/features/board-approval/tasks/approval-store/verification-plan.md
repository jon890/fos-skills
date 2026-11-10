# 승인 대기 명령과 저장 인수 검증 계획

이 계획은 PR1(approval-store)의 요구사항만 다룬다. 창(REQ5~REQ9)은 PR2 의 계획이 소유한다.
개발 테스트가 절차를 이미 표현하는 사례는 테스트 경로를 적고 다시 적지 않는다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 임시 git 저장소, `ORCH_DIR`, 미리보기 파일 하나, 가짜 orca | `skills/orch/tests/board-approval.spec.ts` 의 REQ1 사례를 돌린다 | 다섯 종류 성공 줄 `APPROVAL-ADD <id> <kind> <버전>` 과 0, 필수 인자 빠짐 2 와 이름, 없는 미리보기와 빈 Run 은 1 이고 파일이 없다 | 로컬 node 테스트 | worker | 없음(보드 명령 구현의 잠금 함수가 main 에 있어야 하는 것은 phase 03 의 Blocked 조건이다) | PR 전 |
| REQ1 | 이 저장소 주 checkout, 코디네이터가 묶인 Run | 코디네이터 셸에서 `orch board approval add demo-approval --title 실측 --kind post --preview <임시 파일>` 뒤 `list` | `APPROVAL-ADD demo-approval post <n>`, `list` 한 줄. 승인 파일의 `run` 이 그 Run, `terminal` 이 코디네이터 터미널이다 | 실제 Orca 코디네이터 세션 | 코디네이터 | push: PR 브랜치를 플러그인으로 읽은 코디네이터 세션 | PR 전 |
| REQ2 | 임시 저장소 | `board-approval.spec.ts` 의 REQ2 사례 | 열린 대기 바꾸기에 ` replaced`, 승인된 기록을 다시 올린 뒤 `check` 가 「아직 누르지 않음」, `revise` 기록이 `list --full` 에 남는다 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ3 | 임시 저장소 | `board-approval.spec.ts` 의 REQ3 사례 | 열린 둘이면 두 줄, `cancel` 뒤 빠짐, 없는 id 의 `cancel` 1 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ4 | 저장소 소스 | `lib-commands.spec.ts` 와 `board-approval-static.spec.ts` 를 돌리고 `node skills/orch/bin/orch.ts board approval --help` 를 본다 | 도움말과 명령 표에 approve·revise 동작이 없다. 승인 상태를 쓰는 곳이 `core/approvals.ts` 밖에 없다 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ10 | 가짜 orca 가 내는 메시지와 worker 목록 | `board-approval.spec.ts` 의 REQ10 사례와 `core-approvals.spec.ts` 의 `checkVerdict` 표 | 통과 `APPROVAL-OK` 와 0, 거절 이유 아홉 가지가 각각 `APPROVAL-REJECT <id> <이유>` 와 1, 통과 뒤 둘째 `check` 는 「이미 사용함」 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ10 | 코디네이터가 묶인 Run, 위 실측의 열린 대기 | 코디네이터 셸에서 `orca orchestration send --to run:<Run> --from "$ORCA_TERMINAL_HANDLE" --type status --subject "APPROVED demo-approval <n>" --payload '{"source":"board-approval","id":"demo-approval","version":<n>}'` 를 보내고 `orca orchestration check --run <Run> --all --types status --json` 의 그 메시지를 본다. 같은 대기에 `check demo-approval` 을 부른다. `lib/worker-terminal.ts` 로 released 까지 읽는 조회에 걸린 시간을 잰다 | 메시지에 `id`, `from_handle`(또는 `from`), `subject`, `payload` 가 있고 `from_handle` 이 코디네이터 터미널이다. `check` 는 기록이 `open` 이라 「아직 누르지 않음」 이다. 조회 시간을 PR 본문에 적는다 | 실제 Orca 코디네이터 세션 | 코디네이터 | push: 위 REQ1 실측의 열린 대기 | PR 전 |
| REQ10 | 같은 Run 의 worker 하나 | worker 터미널에서 같은 제목 `APPROVED demo-approval <n>` 을 Run 으로 보낸 뒤 코디네이터가 `check demo-approval` | 「아직 누르지 않음」 으로 거절한다 | 실제 Orca 코디네이터 세션 | 코디네이터 | push: 위 실측의 열린 대기 | PR 전 |
| REQ11 | 임시 저장소 | `board-approval.spec.ts` 의 REQ11 사례 | 8일 전에 끝난 기록이 다음 쓰기 뒤 사라지고 30시간 열린 기록은 남는다 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ12 | 저장소 문서와 루프 소스 | `board-approval-docs.spec.ts` 를 돌린다 | `replying.md` 에 `STEP-READY ask` 처리와 `step-<항목>-<번호>` 규칙이 있고, `loop/` 소스에 승인 파일을 쓰는 곳이 없다 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ13 | 저장소 문서 | `board-approval-docs.spec.ts` 를 돌리고 `replying.md` 「보드 승인」 을 읽는다 | 막는 것, 막지 못하는 것(채팅 승인의 한계 포함), 「직접 고치지 않는다」 가 있다 | 로컬 node 테스트 | worker | 없음 | PR 전 |

실측이 끝나면 코디네이터는 `orch board approval cancel demo-approval` 로 남은 대기를 닫고 `APPROVAL-CANCEL demo-approval` 을 확인한다.
