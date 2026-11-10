# 보드 승인 창 인수 검증 계획

이 계획은 PR2(approval-pane)의 요구사항만 다룬다. 명령과 저장(REQ1, REQ3, REQ10~13)은 PR1 이 끝냈다.
개발 테스트가 절차를 이미 표현하는 사례는 테스트 경로를 적고 다시 적지 않는다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ2 | 임시 저장소의 승인 파일에 같은 id 의 v2(열림) | `approval-press.spec.ts` 의 「지금 버전이 아니면」 사례와 `approvals-bin.spec.ts` 의 `press` 사례를 돌린다 | v1 로 누른 `press` 는 종료 코드 1 과 「내용이 바뀌었어요」, 승인 파일이 그대로이고 가짜 orca 에 `send` 가 한 번도 불리지 않는다 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ2 | 가짜 `process.run` 이 「내용이 바뀌었어요」 로 실패 | `approvals-pane.test.ts` 의 예전 버튼 사례를 돌린다 | toast 가 「내용이 바뀌었어요. 새 미리보기를 확인하세요」 이고 상자가 그대로다 | `claude plugin test .` | worker | 없음 | PR 전 |
| REQ4 | 저장소 소스 | `board-approval-static.spec.ts` 를 돌리고 `hooks/block-approval-press.ts` 사례(`coordinator-hooks.spec.ts`)를 돌린다 | `applyPress`→`recordPress`→`bin/approvals.ts`→`register.js` 가 한 줄기이고, 창 코드의 `press` 호출이 한 곳이며, Bash 도구로 부른 `approvals.ts press` 를 hook 이 거부한다 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ5 | 가짜 `fs.read` 가 열린 대기 둘과 25시간 된 대기 하나를 줌 | `approvals-pane.test.ts` 와 `approvals-pane.spec.ts` 를 돌린다 | 상자 머리 「승인 대기  n」, 상태 줄 「승인 n」, 25시간 된 대기의 시간이 노랑, 열린 대기가 없으면 상자와 「승인 n」 이 없다 | `claude plugin test .` 와 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ5 | 실제 Claude Code 에서 `/board` 가 열린 코디네이터 창, 실제 Orca | 코디네이터가 `orch board approval add demo-pane --title 실측 --kind post --preview <파일>` 을 올린다. 사용자가 창을 본다 | 올린 뒤 5초 안에 창 상자와 상태 줄에 보이고, 「미리보기 열기」 를 누르면 그 파일이 열린다 | 실제 Orca 코디네이터 세션과 사용자 | 코디네이터 | 없음(이 브랜치 작업 트리를 `--plugin-dir` 로 실은 Claude Code 세션을 쓴다) | PR 전 |
| REQ6 | 가짜 `self` 가 worker 아님/worker | `approvals-pane.test.ts` | worker 아님이면 「승인」, 「고쳐 달라」 버튼, worker 면 버튼 없이 「코디네이터 창이나 다른 창에서 누르세요」. 「승인」 을 누르면 `press <id> <버전> approve` 가 불리고 성공이면 상자에서 빠진다 | `claude plugin test .` | worker | 없음 | PR 전 |
| REQ6 | 임시 저장소, 가짜 orca | `approval-press.spec.ts` 의 `recordPress` 사례 | 기록이 승인 상태이고 `send` 의 `--to run:<Run>`, 제목 `APPROVED <id> <버전>`, payload nonce 가 기록과 같다. `send` 실패면 기록이 `open` 으로 돌아온다 | 로컬 node 테스트 | worker | 없음 | PR 전 |
| REQ6 | 실제 Orca, 위 실측의 열린 대기, worker 가 아닌 세션에서 연 보드 | 사용자가 창에서 「승인」 을 누른다. 코디네이터가 `orca orchestration check` 로 `APPROVED demo-pane <버전>` 을 읽고 `orch board approval check demo-pane --version <버전>` 을 부른다 | `APPROVED` 가 오고 `check` 가 `APPROVAL-OK demo-pane` 이다. 실제 `from_handle` 과 `press` 의 `origin` 값을 기록한다 | 실제 Orca 코디네이터 세션과 사용자 | 코디네이터 | 없음(위 REQ5 실측에서 올린 대기를 쓴다) | PR 전 |
| REQ6 | 실제 Orca, worker 터미널에서 연 `/board` | worker 터미널의 Claude Code 에서 `/board` 를 열고 승인 대기가 있을 때 창에 승인 대기와 안내 줄만 보이고 「승인」·「고쳐 달라」 버튼이 없는지 사용자가 본다 | 승인 대기와 「코디네이터 창이나 다른 창에서 누르세요」 만 있고 버튼이 없다. 승인 기록과 신호가 생기지 않는다 | 실제 Orca worker 터미널과 사용자 | 코디네이터 | 없음(위 REQ5 실측의 열린 대기가 있어야 한다) | PR 전 |
| REQ6 | worker 셸 | 이 PR 을 맡은 worker 의 셸에서 `node extensions/work-board/bin/approvals.ts self` 를 부른다 | `{"terminal":"term_…","worker":true}` 이다 | worker 셸 | worker | 없음 | PR 전 |
| REQ7 | 가짜 `process.run` | `approvals-pane.test.ts` | 빈 글(공백만)이면 `press` 가 불리지 않고 글칸이 남는다. 「제목을 짧게」 를 적어 보내면 `--note=제목을 짧게` 로 불린다 | `claude plugin test .` | worker | 없음 | PR 전 |
| REQ7 | 실제 Orca, 위 실측의 열린 대기 | 사용자가 「고쳐 달라」 를 눌러 「제목을 짧게」 를 적어 보낸다. 코디네이터가 `check` 로 메시지를 읽는다 | `REVISE demo-pane <버전>` 제목과 글이 온다. 그 대기는 상자에서 빠진다 | 실제 Orca 코디네이터 세션과 사용자 | 코디네이터 | 없음(위 REQ5 실측과 같은 방식으로 다시 올린 대기를 쓴다) | PR 전 |
| REQ8 | `real` 대기를 가짜 파일로 줌 | `approvals-pane.test.ts` | 대상 환경, 바꿀 것, 되돌리는 법이 빨강으로 보이고 첫 누름에는 `press` 가 불리지 않고 10초 안의 둘째 누름에 불린다. 10초가 지난 뒤 누르면 다시 첫 누름이다 | `claude plugin test .` | worker | 없음 | PR 전 |
| REQ9 | `command` 대기를 가짜 파일로 줌, `self` 의 터미널을 올린 터미널과 같게/다르게 | `approvals-pane.test.ts` | 같으면 「명령 채우기」 가 `! <명령>` 을 입력란에 채우고 `press` 와 `send` 는 불리지 않는다. 다르면 명령 글만 보이고 버튼이 없다 | `claude plugin test .` | worker | 없음 | PR 전 |
| REQ9 | 실제 Orca 코디네이터 창 | 코디네이터가 `orch board approval add demo-cmd --title 실측 --kind command --command "echo ok"` 를 올린다. 사용자가 「명령 채우기」 를 누른다 | 입력란에 `! echo ok` 가 채워지고 Orca 메시지는 가지 않는다 | 실제 Orca 코디네이터 세션과 사용자 | 코디네이터 | 없음(위 REQ5 실측과 같은 설치를 쓴다) | PR 전 |

사용자가 창에서 누르는 항목(REQ5, REQ6, REQ7, REQ9 의 실제 Orca 행)은 PR 직전에 ask 로 코디네이터에게 맡긴다. 코디네이터가 사용자에게 부탁하고 결과를 돌려주면 실측 결과를 PR 본문 근거 블록에 적는다. 실측이 끝나면 코디네이터는 `orch board approval cancel <id>` 로 남은 `demo-*` 대기를 닫는다.
