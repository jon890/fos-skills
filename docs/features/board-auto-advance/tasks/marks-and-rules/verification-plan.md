# 표시와 코디네이터 규칙 인수 검증 계획

이 PR 이 맡는 요구사항만 다룬다. 루프 알림(REQ4, REQ5, REQ6)과 사용 한도 뒤 다시 알림은 다음 PR 의 계획이 맡는다. 절차와 기대값만 적고, 결과는 verify 가 PR 에 남긴다.

`orch board auto-check` 를 PR 전에 부르는 행은 작업 공간의 스크립트로 돈다. PATH 의 `orch` 는 설치된 번들을 고르므로, 그 행의 명령 앞에 `ORCH_SCRIPTS_DIR=<작업 공간>/skills/orch/scripts` 를 준다(`skills/orch/references/overlay.md` 의 「고치는 중인 체크아웃의 스크립트」). worker 목록과 열린 PR 을 답하는 가짜 조회 명령은 환경 변수 `ORCA`, `GH` 로 준다(표의 「가짜 조회 명령」). `skills/orch/tests/board-auto-check.spec.ts` 가 같은 준비를 코드로 갖고 있어, 표의 절차는 그 테스트의 해당 사례를 돌려 확인해도 된다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 없음 | `node scripts/run-tests.ts extensions/work-board/tests/step-marks.spec.ts` | 표시 넷을 표시와 본문으로 나눠 읽고, `[maybe]` 같은 모르는 표시는 표시 없는 줄로 읽는다 | 로컬 테스트 | worker | 없음 | PR 전 |
| REQ1 | 임시 보드에 `5. [wait] 기획 답 (#665 merge)` 줄 | `node scripts/run-tests.ts extensions/work-board/tests/step-marks.spec.ts extensions/work-board/tests/event-tags.spec.ts skills/orch/tests/board-sync.spec.ts` | 표시가 붙은 줄의 줄 끝 꼬리표가 지금과 같이 읽히고, 보드 동기화의 기존 사례가 고치지 않고 통과한다 | 로컬 테스트 | worker | 없음 | PR 전 |
| REQ1 | 없음 | `skills/orch/templates/spec-common.md` 를 읽고 `node scripts/run-tests.ts skills/orch/tests/docs-contract.spec.ts` 를 돌린다 | 공통 지시서 틀에 「남은 PR 목록을 `worker_done` 에 적는다」 규칙이 있다 | 로컬 테스트 | worker | 없음 | PR 전 |
| REQ2 | 없음 | `skills/orch/references/board.md` 의 「자동 진행 표시」 절을 읽고 `node scripts/run-tests.ts skills/orch/tests/docs-contract.spec.ts` 를 돌린다 | 절에 붙여도 되는 일, 안 되는 일, 근거 꼴 셋이 있고 문서 테스트가 통과한다 | 로컬 테스트 | worker | 없음 | PR 전 |
| REQ2 | `stages` 필드가 없고 `pr` 필드가 665 인 항목에 `1. PR #665 구현`, `2. [auto] PR4 (앞 사건: #665 merge)` 두 줄. #665 는 머지됨 | `node scripts/run-tests.ts skills/orch/tests/board-sync.spec.ts skills/orch/tests/finish-pr.spec.ts` | #665 머지를 반영해도 2번 `[auto]` 줄이 끝나지 않고 첫 미완료 단계로 남는다. 1번 줄만 끝난다 | 임시 보드와 가짜 `gh` | worker | 없음 | PR 전 |
| REQ2 | 임시 저장소의 보드에 근거 없는 `2. [auto] PR4` 줄 | `orch board auto-check <항목> --run <Run>` | `AUTO-REJECT <항목> 2 근거가 없다` 와 종료 코드 1. `replying.md` 가 이 이유에 「`[ask]` 로 바꿔 묻는다」 를 적었다 | 임시 git 저장소, 임시 보드, 가짜 조회 명령 | worker | 없음 | PR 전 |
| REQ3 | 확인 줄이 없는 스펙을 근거로 단 `[auto]` 줄 | `orch board auto-check <항목> --run <Run>` | `AUTO-REJECT <항목> <번호> 스펙에 확인 줄이 없다` 와 종료 코드 1 | 임시 git 저장소, 임시 보드, 가짜 조회 명령 | worker | 없음 | PR 전 |
| REQ3 | 주 checkout 에만 있는 계획 폴더를 상대경로로 적은 `[auto]` 줄과 `git worktree add` 로 만든 연결 워크트리 | 연결 워크트리 안에서 `orch board auto-check <항목> --run <Run>` | `AUTO-OK <항목> <번호> 계획: <상대경로>` 와 종료 코드 0. 상대경로를 부른 워크트리가 아니라 저장소 기본 checkout 에서 찾는다 | 임시 git 저장소, 임시 보드, 가짜 조회 명령 | worker | 없음 | PR 전 |
| REQ3 | 저장소 밖 폴더(다른 워크트리 자리)의 계획을 절대경로로 적은 `[auto]` 줄 | `orch board auto-check <항목> --run <Run>` | `AUTO-OK <항목> <번호> 계획: <절대경로>` 와 종료 코드 0 | 임시 git 저장소, 임시 보드, 가짜 조회 명령 | worker | 없음 | PR 전 |
| REQ3 | 다른 항목에 끝난 `3. 머지 (#665 merge)` 줄이 있는 보드와 `(앞 사건: #665 merge)` 근거의 `[auto]` 줄 | `orch board auto-check <항목> --run <Run>` 을 부르고, 그 줄을 끝나지 않은 것으로 되돌린 뒤 다시 부른다 | 처음은 `AUTO-OK`, 되돌린 뒤는 `앞 사건이 끝나지 않았다` | 임시 git 저장소, 임시 보드, 가짜 조회 명령 | worker | 없음 | PR 전 |
| REQ3 | 근거가 맞는 `[auto]` 줄. 가짜 조회 명령이 그 항목 worktree 에 열린 dispatch 를 답한다 | `orch board auto-check <항목> --run <Run>` 을 부르고, 가짜 조회 명령을 실패로 답하게 바꿔 다시 부른다 | 처음은 `worker 나 열린 PR 이 있다`, 다음은 `worker 나 PR 을 확인하지 못했다`. 둘 다 종료 코드 1 | 임시 git 저장소, 임시 보드, 가짜 조회 명령 | worker | 없음 | PR 전 |
| REQ3 | 위 통과 사례 | 호출 앞뒤의 보드 파일 바이트와 상태 폴더를 비교한다 | 보드가 바뀌지 않고 `step-launches.jsonl` 이 생기지 않는다 | 임시 git 저장소, 임시 보드, 가짜 조회 명령 | worker | 없음 | PR 전 |
| REQ7 | 없음 | `skills/orch/references/replying.md` 의 「다음 단계 이어 가기」 절과 `waiting.md` 를 읽고 `node scripts/run-tests.ts skills/orch/tests/docs-contract.spec.ts` 를 돌린다 | 절에 `[auto]` 면 같은 턴에 띄우고 `[ask]` 면 묻는 처리, 띄운 단계의 줄을 끝내는 법이 있고 `waiting.md` 가 그 절을 가리킨다 | 로컬 테스트 | worker | 없음 | PR 전 |
| REQ8 | 없음 | 같은 절을 읽고 `node scripts/run-tests.ts skills/orch/tests/docs-contract.spec.ts` 를 돌린다 | 절에 `다음 단계 자동 진행: <무엇을>, <agent·모델>, <묻지 않은 이유(근거)>` 꼴과 「따로 메시지를 보내지 않는다」 가 있다 | 로컬 테스트 | worker | 없음 | PR 전 |
| REQ9 | `[auto]` 가 첫 미완료인 항목의 보드 | `node scripts/run-tests.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/send-to-worker.spec.ts skills/orch/tests/board-auto-check.spec.ts` | 그 항목 id 의 지시서로 띄우면 띄운 기록이 한 줄 남고, 그 뒤 같은 단계 글의 `auto-check` 는 `이미 한 번 띄웠다` 로 거절한다. 그 줄에 꼬리표를 붙여도 거절하고, 본문이 바뀌면 통과한다 | 로컬 테스트 | worker | 없음 | PR 전 |
| REQ9 | 띄운 기록 파일에 쓸 수 없는 상태 폴더 | `node scripts/run-tests.ts skills/orch/tests/launch-worker.spec.ts` | 띄우기는 종료 코드 0 과 `LAUNCHED` 로 끝나고 stderr 에 기록을 남기지 못했다는 줄이 있다 | 로컬 테스트 | worker | 없음 | PR 전 |
| REQ9 | 실제 저장소의 보드에 근거가 맞는 `[auto]` 줄을 둔 시험 항목 | `orch board auto-check <항목>` 으로 `AUTO-OK` 를 본 뒤 그 항목 id 를 적은 지시서로 `orch worker launch` 를 부르고, worker 가 사는 동안과 끝난 뒤에 `orch board auto-check <항목>` 을 다시 부른다 | 띄운 뒤 `<orch 상태 폴더>/step-launches.jsonl` 에 그 항목과 단계 글의 줄이 있다. worker 가 사는 동안의 확인은 `worker 나 열린 PR 이 있다`, 끝난 뒤의 확인은 `이미 한 번 띄웠다` 다 | 실제 Orca 로 worker 를 띄우는 코디네이터 세션 | 코디네이터 | 머지 | PR 뒤 |
| REQ10 | 표시 없는 줄만 있는 보드 | `node scripts/run-tests.ts skills/orch/tests/board-sync.spec.ts skills/orch/tests/finish-pr.spec.ts skills/orch/tests/lib-movement.spec.ts skills/orch/tests/lib-board.spec.ts skills/orch/tests/orch-loop.spec.ts` | 기존 사례가 고치지 않고 통과한다. 표시 없는 보드의 알림과 동작이 그대로다 | 로컬 테스트 | worker | 없음 | PR 전 |
| REQ11 | `.orch/config.json` 의 `board.auto_advance` 가 `false` 인 임시 저장소 | `orch board auto-check <항목> --run <Run>` | `AUTO-REJECT <항목> - 자동 진행이 꺼져 있다` 와 종료 코드 1 | 임시 git 저장소, 임시 보드, 가짜 조회 명령 | worker | 없음 | PR 전 |
| REQ11 | `board.auto_advance` 가 문자열인 임시 저장소 | `orch board auto-check <항목> --run <Run>` | 설정 오류 글과 종료 코드 2 | 임시 git 저장소, 임시 보드, 가짜 조회 명령 | worker | 없음 | PR 전 |
| REQ11 | 없음 | `node scripts/run-tests.ts skills/orch/tests/lib-milestones.spec.ts skills/orch/tests/core-auto-advance.spec.ts` | `board.auto_advance` 가 틀린 값이어도 board 절의 다른 값 읽기(`boardSettings`)는 던지지 않는다. 그 값은 `autoAdvanceOf` 만 거절한다 | 로컬 테스트 | worker | 없음 | PR 전 |
| REQ12 | 없음 | `git grep -n "auto-check\|자동 진행 표시" -- .orch` 와 변경 파일 목록을 본다 | 저장소 오버레이에 규칙을 옮겨 적은 곳이 없다. 규칙은 `skills/orch/references/` 와 스크립트에만 있다 | 로컬 | worker | 없음 | PR 전 |
| REQ12 | 다른 저장소(orch 를 쓰는 저장소 하나) | 플러그인을 갱신한 뒤 그 저장소에서 `orch board auto-check <그 저장소의 항목>` 을 부른다 | 저장소 설정을 고치지 않고 명령이 돌고 판정 줄이 나온다 | 실제 다른 저장소의 코디네이터 세션 | 코디네이터 | 머지 | PR 뒤 |
