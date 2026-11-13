# 보드 항목 하위 worker PR1 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 임시 보드에 항목 하나 | `board.ts worker-add` 로 impl·follow 두 줄을 더하고 `item` 출력을 읽는다. `workers` 필드가 없는 옛 항목을 `item`·`list` 로 읽는다. 사례는 `extensions/work-board/tests/board-workers.spec.ts` | 두 줄이 있고 `worktree` 가 follow 줄을 가리킨다. 옛 항목은 지금 출력 그대로다 | 임시 폴더의 보드 파일 | worker | 없음 | PR 전 |
| REQ2 | PR #N 의 구현 항목(열린 것과 done 둘) | `리뷰 PR: #N` 지시서로 `registerBoard` 를 부르고 `board.json` 을 읽는다. `보드 항목 id:` 를 함께 쓴 지시서도 부른다. 사례는 `skills/orch/tests/board-attach.spec.ts` | 새 항목이 없고 그 항목에 review 줄이 하나 는다. status·단계·`worktree` 가 그대로다 | 임시 저장소와 실제 보드 명령 | worker | 없음 | PR 전 |
| REQ2, REQ7 | `보드 항목 id:` 와 `리뷰 PR:` 이 함께 있는 띄우기 이력, impl 줄이 있는 항목 | `board-sync.ts --completed-items` 와 대상 PR MERGED 가짜 gh 로 맞춘다. 사례는 `skills/orch/tests/review-item.spec.ts` | 항목이 done 이 되지 않는다 | 임시 저장소, 가짜 gh | worker | 없음 | PR 전 |
| REQ3 | 같은 업무 번호의 열린 항목 | 다른 워크트리의 후속 지시서로 `launch-worker` 를 부른다. 사례는 `skills/orch/tests/launch-worker.spec.ts` | stdout 에 `BOARD-ATTACH <항목> follow` 가 있고 원래 impl 줄이 남는다 | 임시 저장소, 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ5 | 같은 업무 번호의 열린 항목 | `보드 항목: 새로` 지시서로 `registerBoard` 를 부르고, 두 줄을 함께 쓴 지시서로 spec-lint 를 돌린다 | 새 항목이 생긴다. spec-lint 가 종료 코드 1 과 `보드:` 오류를 낸다 | 임시 저장소 | worker | 없음 | PR 전 |
| REQ7 | 작업 중 줄 셋(worker_done, 끝난 dispatch, 사라진 워크트리)이 있는 보드 | `board-sync.ts --worker-ends` 로 맞추고 `stalledStages` 를 리뷰 줄만 살아 있는 항목으로 부른다. Orca 행의 끝남 판정은 `skills/orch/tests/core-board-workers.spec.ts`, 루프가 넘기는 것은 `skills/orch/tests/board-path-callers.spec.ts`, 줄 끝내기는 `skills/orch/tests/board-sync.spec.ts`, 멈춤 알림은 `skills/orch/tests/lib-movement.spec.ts` | 셋이 각각 done, lost, lost 다. 리뷰 줄만 살아 있는 항목은 멈춘 단계로 나오지 않는다 | 임시 저장소 | worker | 없음 | PR 전 |
| REQ2, REQ3, REQ7 | 이 브랜치 워크트리를 `claude --plugin-dir <워크트리>` 로 연 코디네이터 세션과 보드가 있는 저장소 | 구현 worker 하나를 띄우고, 그 PR 의 리뷰 worker 를 `리뷰 PR:` 지시서로 띄운다. 리뷰 worker 가 worker_done 을 보낸 뒤 상주 루프 한 틱을 기다린다 | 보드 항목이 하나이고 `workers` 에 impl·review 두 줄이 있다. 리뷰 줄은 done, 구현 항목은 열려 있다. 띄우기 출력에 `BOARD-ATTACH <항목> review` 가 있다 | 실제 Orca 코디네이터 세션 | 코디네이터 | push | PR 뒤 |
| REQ8 | 이 PR 의 문서 | `docs/data-schema.md`, `skills/orch/references/board.md`, `skills/orch/references/spec-writing.md`, 두 지시서 틀을 설계와 대조한다 | worker 줄 목록, 자동 붙이기, `보드 항목: 새로`, `worker 역할: 검증` 이 적혀 있다 | 작업 공간 | worker | 없음 | PR 전 |
