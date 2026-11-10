# Orca 깨움 검증

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
|REQ1| 실제 Run 과 루프, 대기 프로세스 없음 | worker 가 질문하고 답을 받은 뒤 루프 알림을 발생시킨다. 사용자 입력 직후에도 반복한다 | 코디네이터와 worker 가 깬다. 사용자 답을 먼저 처리한다. loop-events 파일이 생기지 않는다 | 실제 Orca | 코디네이터 | push | PR 뒤 |
|REQ3| 실제 Run 과 루프, 대기 프로세스 없음 | worker 가 질문하고 답을 받은 뒤 루프 알림을 발생시킨다. 사용자 입력 직후에도 반복한다 | 코디네이터와 worker 가 깬다. 사용자 답을 먼저 처리한다. loop-events 파일이 생기지 않는다 | 실제 Orca | 코디네이터 | push | PR 뒤 |
|REQ4| 실제 Run 과 루프, 대기 프로세스 없음 | worker 가 질문하고 답을 받은 뒤 루프 알림을 발생시킨다. 사용자 입력 직후에도 반복한다 | 코디네이터와 worker 가 깬다. 사용자 답을 먼저 처리한다. loop-events 파일이 생기지 않는다 | 실제 Orca | 코디네이터 | push | PR 뒤 |
|REQ6| 실제 Run 과 루프, 대기 프로세스 없음 | worker 가 질문하고 답을 받은 뒤 루프 알림을 발생시킨다. 사용자 입력 직후에도 반복한다 | 코디네이터와 worker 가 깬다. 사용자 답을 먼저 처리한다. loop-events 파일이 생기지 않는다 | 실제 Orca | 코디네이터 | push | PR 뒤 |
|REQ19| 실제 Run 과 루프, 대기 프로세스 없음 | worker 가 질문하고 답을 받은 뒤 루프 알림을 발생시킨다. 사용자 입력 직후에도 반복한다 | 코디네이터와 worker 가 깬다. 사용자 답을 먼저 처리한다. loop-events 파일이 생기지 않는다 | 실제 Orca | 코디네이터 | push | PR 뒤 |
|REQ5| 가짜 Orca 의 완료·끊김·질문 자료 | 틱을 반복하고 상태와 메시지·이벤트·보드 pr 을 대조한다. status 와 done 이 100행 초과인 자료도 각각 쓴다 | 보충 조회 부족은 WATCH-ERROR done, seen 미진행과 다음 틱 재시도; 최초 과거 보고 무알림, 신규 suspicious 는 dispatch 별 한 번, ready 보드 연결, 끊김 한 번, 질문 묶음 변경 때 한 번 | 임시 저장소 | worker | 없음 | PR 전 |
|REQ14| 가짜 Orca 의 완료·끊김·질문 자료 | 틱을 반복하고 상태와 메시지·이벤트·보드 pr 을 대조한다. status 와 done 이 100행 초과인 자료도 각각 쓴다 | 보충 조회 부족은 WATCH-ERROR done, seen 미진행과 다음 틱 재시도; 최초 과거 보고 무알림, 신규 suspicious 는 dispatch 별 한 번, ready 보드 연결, 끊김 한 번, 질문 묶음 변경 때 한 번 | 임시 저장소 | worker | 없음 | PR 전 |
|REQ15| 가짜 Orca 의 완료·끊김·질문 자료 | 틱을 반복하고 상태와 메시지·이벤트·보드 pr 을 대조한다. status 와 done 이 100행 초과인 자료도 각각 쓴다 | 보충 조회 부족은 WATCH-ERROR done, seen 미진행과 다음 틱 재시도; 최초 과거 보고 무알림, 신규 suspicious 는 dispatch 별 한 번, ready 보드 연결, 끊김 한 번, 질문 묶음 변경 때 한 번 | 임시 저장소 | worker | 없음 | PR 전 |
|REQ2| 옛 명령과 직접 경로 | retired 테스트와 check-peek 검사를 실행한다 | 한 줄 안내와 2, 메일 소비와 터미널 입력 없음 | 로컬 CLI | worker | 없음 | PR 전 |
|REQ8| 옛 명령과 직접 경로 | retired 테스트와 check-peek 검사를 실행한다 | 한 줄 안내와 2, 메일 소비와 터미널 입력 없음 | 로컬 CLI | worker | 없음 | PR 전 |
|REQ9| 옛 파일과 실패하는 send, 저장소 핸들러 | 정리 재실행, 기본·저장소 핸들러와 doctor 테스트 | 실패한 파일 보존 후 성공 시 휴지통 이동, 핸들러 우선, NUDGE-HANDLER 경고 | 임시 저장소 | worker | 없음 | PR 전 |
|REQ16| 옛 파일과 실패하는 send, 저장소 핸들러 | 정리 재실행, 기본·저장소 핸들러와 doctor 테스트 | 실패한 파일 보존 후 성공 시 휴지통 이동, 핸들러 우선, NUDGE-HANDLER 경고 | 임시 저장소 | worker | 없음 | PR 전 |
|REQ17| 옛 파일과 실패하는 send, 저장소 핸들러 | 정리 재실행, 기본·저장소 핸들러와 doctor 테스트 | 실패한 파일 보존 후 성공 시 휴지통 이동, 핸들러 우선, NUDGE-HANDLER 경고 | 임시 저장소 | worker | 없음 | PR 전 |

실제 Orca 실행은 ORCH_SCRIPTS_DIR=<검증할 워크트리>/skills/orch/scripts 를 붙인다. 코디네이터에게 절차와 기대값을 ask 로 넘기고, 결과 전에는 PR 에 실측 대기로 기록한다.
