# 보드 항목 하위 worker PR2 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ4 | 앞 PR 이 열린 마일스톤 항목(단계 둘) | 새 브랜치 후속 지시서로 `registerBoard` 를 부르고, 가짜 gh 로 두 PR 을 연 뒤 보드 맞추기를 돌린다. 사례는 `skills/orch/tests/board-attach.spec.ts`, `skills/orch/tests/board-sync.spec.ts` | 전체 단계 수가 둘 늘고 `pr` 필드에 두 번호가 있다. 뒤 PR 만 머지되면 뒤 머지 단계만 끝나고 항목은 doing 이다. 리뷰 지시서를 붙이면 단계 수가 그대로다 | 임시 저장소, 가짜 gh | worker | 없음 | PR 전 |
| REQ4 | 두 PR 이 열린 항목, 배포 단계와 `board.done_after: deploy` 가 있는 보드 설정 | 앞 PR 머지 → 보드 맞추기, 뒤 PR 머지 → 배포 성공 → 보드 맞추기. 사례는 `skills/orch/tests/board-sync.spec.ts`, `skills/orch/tests/finish-pr.spec.ts` | 남은 열린 PR 이 있는 동안 done 이 아니다. 마지막 PR 의 배포 성공 뒤 done 이다 | 임시 저장소, 가짜 gh | worker | 없음 | PR 전 |
| REQ6 | 작업 중 둘, 끝남 둘, 끊김 하나인 항목 | 창 그리기 테스트로 접힌 보기와 펼친 보기를 그린다. 사례는 `extensions/work-board/tests/pane.test.ts` | 접힌 보기에 worker 줄 둘, 빨간 끊김 줄 하나, 「✓ 끝난 worker 2」 가 있고 펼친 보기에 다섯 줄이 있다 | 창 그리기 테스트(`claude plugin test .`) | worker | 없음 | PR 전 |
| REQ7 | 리뷰 줄만 작업 중인 항목, 작업 중 리뷰 줄이 있는 done 항목 | 창 그리기 테스트 | 앞 항목에 「worker 없음」 이 없다. done 항목에 그 리뷰 줄이 있다 | 창 그리기 테스트(`claude plugin test .`) | worker | 없음 | PR 전 |
| REQ4, REQ6, REQ7 | 이 브랜치 워크트리를 `claude --plugin-dir <워크트리>` 로 연 코디네이터 세션과 보드가 있는 저장소 | 구현 worker 의 PR 이 열린 채 같은 업무의 후속 worker 를 새 브랜치로 띄우고, 구현 PR 의 리뷰 worker 를 띄운다. `/board` 창을 연다 | 항목 하나 아래에 구현·후속·리뷰 줄이 보이고 단계가 둘 늘었다. 후속 PR 만 머지되면 후속 단계만 끝난다 | 실제 Orca 코디네이터 세션 | 코디네이터 | push | PR 뒤 |
| REQ8 | 이 PR 의 문서 | `extensions/work-board/references/behavior.md`, `skills/orch/references/board.md`, `docs/data-schema.md` 를 설계와 대조한다 | 창의 worker 줄과 동시 PR 단계 규칙이 적혀 있다 | 작업 공간 | worker | 없음 | PR 전 |
