# worker 후속 작업 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ6 | 활성 dispatch 와 가짜 명령 | send-to-worker.spec.ts 실행 | reply/send 뒤 0, nudge/터미널 입력 없음 | 임시 폴더 | worker | 없음 | PR 전 |
| REQ18 | 끝난 dispatch 와 허락/선택 줄 있는 지시서 | send-to-worker.spec.ts 실행 | FOLLOW-UP 과 새 dispatch/task/터미널 기록, 검사 실패 시 send 없음, 거절만 복구 | 임시 폴더 | worker | 없음 | PR 전 |
| REQ18 | reopened 의 앞 터미널과 다른 새 터미널 | cleanup-sweep 관련 사례 실행 | 새 터미널이 launchedOwn 으로 인정됨 | 임시 저장소 | worker | 없음 | PR 전 |
| REQ6 | 쉬는 worker | 브랜치의 worker send 로 본문 전송 | 터미널 입력 없이 Orca 가 깨움 | 실제 Orca | 코디네이터 | 없음: ORCH_SCRIPTS_DIR 에 이 워크트리의 skills/orch/scripts 지정 | PR 전 |
| REQ18 | 마친 worker 와 후속 지시서 | 브랜치의 worker send --spec 실행 뒤 worker-show 와 orch status 및 보드 조회 | 새 Task/dispatch 가 생기고 상태 및 띄우기 기록과 보드에서 보임 | 실제 Orca | 코디네이터 | 없음: ORCH_SCRIPTS_DIR 에 이 워크트리의 skills/orch/scripts 지정 | PR 전 |
