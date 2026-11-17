# 메인 코디네이터 PR1 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 등록 Run 과 가짜 orca CLI 의 터미널 목록 | `orch status`, 다른 Run 의 `loop start` | `MAIN <Run> terminal=<터미널>`, `MAIN-EXISTS` 와 6, 다른 Run 미등록 | 임시 저장소, 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ2 | 셸만 남은 앞 메인의 루프 | 새 Run 의 `loop start` | 앞 루프 종료, 새 Run 명의로 다시 뜸, `MAIN-TAKEN`, 쉬는 worker 이어 붙임, 작업 중 worker 는 `WORKER-NOT-MOVED` | 임시 저장소와 git 워크트리, 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ3 | 살아 있는 메인 | `--take-over` 만, 그다음 `--confirmed` 와 함께 | `TAKEOVER-CONFIRM` 과 6, 그다음 넘겨받고 앞 메인에 `MAIN-TAKEN` 알림 | 임시 저장소, 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ4, REQ5 | 저장소 둘과 보드 | `request send` | 요청 번호, 메인 Run 으로 메시지, 양쪽 보드 항목. 같은 저장소면 항목 하나. 메인 없으면 `REQUEST-NO-MAIN` | 임시 저장소 둘, 가짜 orca CLI, 실제 보드 명령 | worker | 없음 | PR 전 |
| REQ6, REQ8 | 보낸 요청 | accept, hold, reject, done, fail. 보낸 Run 이 끝난 경우 | 이유 필수, 답 대상(보낸 Run 또는 보낸 저장소 메인), 보드 갱신 | 임시 저장소 둘, 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ7 | 요청 항목과 마지막 PR | `finish-pr` | `REQUEST-DONE`, 기록 done. 보내기 실패면 `pending_done` 과 FINISH-DONE | finish-pr 테스트 도구 | worker | 없음 | PR 전 |
| REQ9 | 31분 된 sent 요청 | 루프 단계 두 번 | 알림 한 번 | 임시 저장소, 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ2(DECISION19 가정) | 에이전트를 끝낸 코디네이터 터미널 | `orca terminal list`, `orch status` | `agentIdentity` 가 비고 `MAIN-NONE` | 실제 Orca | 코디네이터 | PR 머지 | PR 뒤 |
