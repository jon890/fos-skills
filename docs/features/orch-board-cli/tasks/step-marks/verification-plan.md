# 자동 진행 표시 동작 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ10 | 임시 저장소 보드에 `2. [auto] PR4 API (계획: x)`, 끝난 줄, 줄 끝 꼬리표 줄 `3. [wait] 기획 답 (#665 merge)` 이 든 항목 | 실제 진입점으로 `orch board step <항목> 2 ask` 를 부르고 보드 파일과 stdout 을 읽는다. `plain`, `auto`, 조건 없는 `wait`, `wait "2026-11-10 19:00"` 도 차례로 부르고 꼬리표 줄에도 부른다 | stdout 이 `BOARD-STEP <항목> 2 <동작>` 한 줄이고 그 줄만 `[ask]`, 표시 없음, `[auto]`, `[wait]`, `[wait: 2026-11-10 19:00]` 로 바뀐다. 다른 줄, 끝냄 상태, 줄 끝 `(#N 사건)` 꼬리표가 그대로다 | 임시 폴더의 git 저장소와 실제 `orch.ts`, `board.ts` | worker | 없음 | PR 전 |
| REQ10 | 줄 앞 `[merge]` 줄, `stages` 칸이 가리키는 줄, 없는 번호, 같은 번호 둘이 든 항목 | 각각에 `step <항목> <번호> auto` 를 부르고, 조건이 빈 `wait ""` 와 `]` 가 든 조건도 부른 뒤 보드 파일 바이트를 앞뒤로 비교한다 | 종료 코드 1, stderr 에 이유, 파일 바이트 같음 | 위와 같음 | worker | 없음 | PR 전 |
| REQ10 | 같은 보드 | `step <항목> 2 Auto`, `step <항목> 2 auto "조건"`, `step <항목> 2 ask --on "1 merge"` 를 부른다 | 종료 코드 2 와 사용법, 보드 그대로. `[Auto]` 같은 표시를 만들 길이 없다 | 위와 같음 | worker | 없음 | PR 전 |
| REQ10 | 주 checkout 과 그 워크트리 | 워크트리 안에서 `orch board step <항목> 2 ask` 를 부른다 | 주 checkout 의 보드가 바뀌고 워크트리에 보드 사본이 생기지 않는다 | 위와 같음 | worker | 없음 | PR 전 |

테스트 절차는 `skills/orch/tests/board-edit.spec.ts` 와 `extensions/work-board/tests/board-step-mark.spec.ts` 가 표현한다. 저장소 README 의 검증 명령(`claude plugin test .`, `node scripts/run-tests.ts`)도 PR 전에 돌린다.
