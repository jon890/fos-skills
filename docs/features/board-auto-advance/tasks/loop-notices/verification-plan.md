# 루프 알림 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ4 | auto/ask 항목, 알림 기록 | `node --test skills/orch/tests/orch-loop-step-ready.spec.ts` | 틱과 재시작을 지나 같은 글은 한 번만 알리고 꼬리표는 무시, worker·PR·조회 실패의 auto 는 보류, ask 는 알림, 실패 전송은 재시도 | 임시 저장소와 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ5 | 표시별 항목과 띄운 기록 | `node --test skills/orch/tests/lib-movement.spec.ts skills/orch/tests/orch-loop-step-ready.spec.ts` | wait/ask/미실행 auto 는 멈춤 없음, 실행 auto 는 빈 연결 필드와 wait 상태에서도 30분 뒤 알림, 진행 중이거나 PR 모름이면 보류 | 격리된 테스트 | worker | 없음 | PR 전 |
| REQ6 | 지난/미래/잘못된 시각 wait | `node --test skills/orch/tests/board-sync.spec.ts skills/orch/tests/orch-loop-step-ready.spec.ts` | 지난 줄만 순서와 무관하게 완료, 상태 유지, 같은 틱에 다음 auto 알림 | 임시 저장소와 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ9 | 한도 기록과 앞 알림/띄운 기록 | `node --test skills/orch/tests/core-step-ready.spec.ts skills/orch/tests/board-auto-check.spec.ts skills/orch/tests/orch-loop-step-ready.spec.ts` | 30분 내 auto-check 거부, 이후 기존 미실행 auto 만 한 번 더 알림, 늦게 처음 알린 단계는 중복 없음 | 격리된 테스트 | worker | 없음 | PR 전 |
| REQ10 | 표시 없는 보드 | 기존 lib-movement·board-sync·loop-order 테스트 실행 | 이전 동작 유지 | 격리된 테스트 | worker | 없음 | PR 전 |
| REQ11 | false 와 잘못된 설정 | 위 틱 테스트와 auto-check 테스트 | false 면 알림 없음, wait 는 그대로 완료, boolean 아니면 시작 오류 | 임시 저장소와 가짜 orca CLI | worker | 없음 | PR 전 |
