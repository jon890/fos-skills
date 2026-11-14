# 보드 항목 하위 worker 검증 기록

- 상태: PR 전 인수 조건은 PR1(#490), PR2(#491) 모두 통과했다. 실제 Orca·상주 루프에서 하는 확인 두 건도 2026-11-14 에 끝났다. 앞 PR 이 아직 이어지지 않은 후속의 실제 빈도는 재지 못했다.
- 원본: [스펙](spec.md), [설계](design.md), [ADR-033](../../adr/033-board-item-worker-rows.md), 개발 검증 [implementation-result.md](implementation-result.md).
- 이 기록은 끝난 계획 폴더(`tasks/attach-workers/`, `tasks/multi-pr-window/`)의 검증 계획과 결과를 옮긴 것이다. 두 계획 폴더는 이 PR 에서 지웠다.

## 요구사항별 인수 검증

PR 전 사례는 임시 저장소·임시 보드·가짜 gh·가짜 Orca CLI 에서 돌렸다. 사례 코드는 각 테스트 파일에 있다. 개발 검증 결과(테스트 통과 수, 실제 보드 사본 확인)와 독립 리뷰 반영은 [implementation-result.md](implementation-result.md) 가 갖는다.

### PR1 (#490)

| 요구사항 | 절차 | 기대 결과 | 관측 결과 |
| --- | --- | --- | --- |
| REQ1 | 임시 보드에서 `board.ts worker-add` 로 구현·후속 두 줄을 더하고 `item` 을 읽는다. `workers` 없는 옛 항목을 `item`·`list` 로 읽는다. `extensions/work-board/tests/board-workers.spec.ts` | 두 줄이 있고 `worktree` 가 후속 줄을 가리킨다. 옛 항목 출력은 그대로다 | 통과 |
| REQ2 | 대상 PR 의 구현 항목(열린 것과 done)에 `리뷰 PR:` 지시서와 `보드 항목 id:` 지시서로 `registerBoard` 를 부른다. `skills/orch/tests/board-attach.spec.ts` | 새 항목 없이 review 줄만 는다. 상태·단계·`worktree` 그대로다 | 통과 |
| REQ2, REQ7 | `보드 항목 id:` 와 `리뷰 PR:` 이 함께 있는 띄우기 이력에서 `orch board sync --completed-items` 와 대상 PR MERGED 가짜 gh. `skills/orch/tests/review-item.spec.ts` | 구현 항목이 done 이 되지 않는다 | 통과 |
| REQ3 | 같은 업무 번호 항목에 다른 워크트리의 후속 지시서로 `launch-worker`. `skills/orch/tests/launch-worker.spec.ts` | `BOARD-ATTACH <항목> follow` 출력, 원래 구현 줄 보존 | 통과 |
| REQ5 | `보드 항목: 새로` 지시서로 `registerBoard`, 두 줄을 함께 쓴 지시서로 spec-lint | 새 항목이 생긴다. spec-lint 가 종료 코드 1 과 `보드:` 오류를 낸다 | 통과 |
| REQ7 | `--worker-ends` 보드 맞추기, `stalledStages`. `core-board-workers.spec.ts`, `board-path-callers.spec.ts`, `board-sync.spec.ts`, `lib-movement.spec.ts` | worker_done·끝난 dispatch·사라진 워크트리가 각각 done·lost·lost. 리뷰 줄만 살아 있는 항목은 멈춘 단계로 나오지 않는다 | 통과 |
| REQ8 | `docs/data-schema.md`, `skills/orch/references/board.md`, `spec-writing.md`, 두 지시서 틀을 설계와 대조 | worker 줄 목록, 자동 붙이기, `보드 항목: 새로`, `worker 역할: 검증` 이 적혀 있다 | 통과 |

### PR2 (#491)

| 요구사항 | 절차 | 기대 결과 | 관측 결과 |
| --- | --- | --- | --- |
| REQ4 | 앞 PR 이 열린 마일스톤 항목에 새 브랜치 후속 지시서로 `registerBoard`, 가짜 gh 로 두 PR 을 열고 보드 맞추기. `board-attach.spec.ts`, `board-sync.spec.ts` | 단계 둘이 늘고 `pr` 에 두 번호가 있다. 뒤 PR 만 머지되면 뒤 머지 단계만 끝나고 항목은 doing. 리뷰 지시서를 붙여도 단계 수 그대로 | 통과 |
| REQ4 | 배포 단계와 `board.done_after: deploy` 가 있는 설정에서 앞 PR 머지 → 맞추기, 뒤 PR 머지 → 배포 성공 → 맞추기. `board-sync.spec.ts`, `finish-pr.spec.ts` | 남은 열린 PR 이 있는 동안 done 이 아니고, 마지막 PR 의 배포 성공 뒤 done | 통과 |
| REQ6 | 작업 중 둘, 끝남 둘, 끊김 하나인 항목을 창 그리기 테스트로 그린다. `pane.test.ts` | 접힌 보기에 worker 줄 둘, 빨간 끊김 줄, 「✓ 끝난 worker 2」, 펼친 보기에 다섯 줄 | 통과 |
| REQ7 | 리뷰 줄만 작업 중인 항목, 작업 중 리뷰 줄이 있는 done 항목을 그린다 | 앞 항목에 「worker 없음」이 없고 done 항목에 그 리뷰 줄이 있다 | 통과 |
| REQ8 | `behavior.md`, `skills/orch/references/board.md`, `docs/data-schema.md` 를 설계와 대조 | 창의 worker 줄과 동시 PR 단계 규칙이 적혀 있다 | 통과 |

개발 검증의 전체 테스트(`node scripts/run-tests.ts`, tsc 포함)는 PR2 에서 301건 통과, `claude plugin test .` 는 104건 통과였다.

## 실제 Orca·상주 루프 확인

PR 뒤에 코디네이터가 실제 환경에서 하기로 한 두 행이다. 둘 다 2026-11-14 에 확인됐다.

| 요구사항 | 후속 검증 | 확인한 것 | 결과 |
| --- | --- | --- | --- |
| REQ2, REQ3, REQ7 (PR1 #490) | 구현 worker 를 띄우고 그 PR 의 리뷰·검증 worker 를 `리뷰 PR:` 지시서로 띄운 뒤 worker_done 뒤 상주 루프 한 틱을 기다린다 | #491 의 리뷰·검증 worker 를 띄우자 새 항목 없이 구현 항목(board-item-workers-window)의 worker 줄로 붙었다. 리뷰 worker 의 worker_done 뒤 다음 틱(2026-11-14 00:58)에 그 줄만 끝남이 되고 구현 항목은 진행 중으로 남았다 | 확인됨 |
| REQ4, REQ6, REQ7 (PR2 #491) | 18.18.0 이상 번들로 연 work-board 창에서 항목 아래 worker 줄을 본다 | 사용자가 그 항목 아래 「✓ 끝난 worker 7」 묶음과 펼친 보기의 7줄을 확인했다 | 확인됨 |

두 PR 본문의 「후속 검증: 대기」 는 이 두 확인으로 닫혔다.

## 확인하지 못한 것

- 앞 PR 이 아직 `pr` 필드에 이어지지 않은 채 띄운 후속(단계를 더하지 않는 경우, [설계](design.md#실패와-일관성))의 실제 빈도. 실제 Orca 확인에서 이 경로는 만나지 않았다.
- 새 브랜치 후속이 앞 PR 이 열린 채 붙어 단계가 둘 늘고 후속 PR 만 먼저 머지되는 흐름을 실제 Orca 에서 끝까지 돌린 확인. 이 흐름은 실제 보드 사본과 가짜 gh 로만 확인했다(implementation-result.md 「실제 보드 사본 확인」).

## 문서 대조와 공통화 후보

| 문서 | 바뀐 사실 또는 영향 없음의 근거 | 처리 |
| --- | --- | --- |
| 기능 design.md | 계획 폴더 링크를 이 기록과 개발 검증 문서 링크로 바꿨다. 「앞 PR 이 아직 이어지지 않은 후속」 의 verify 위임 문장을 실제 상태로 고쳤다. 나머지는 머지된 구현과 맞는다 | 문구 수정 |
| 기능 spec.md | 인수 조건과 결정(DECISION20, DECISION23 의 PR 나눔 포함)이 머지된 두 PR 과 어긋나지 않는다 | 정합 |
| ADR-033 | 결정·대안 기각·결과가 설계와 머지된 구현(`worker-add`·`worker-end`·`worker-link`, 줄 `stages`)과 맞는다 | 정합 |
| implementation-result.md | 계획 폴더 링크를 이 기록 링크로 바꿨다 | 문구 수정 |

공통화 후보 없음: 이 기능이 다룬 규칙(worker 줄과 대표 칸, PR 마다 묶음 단계, 창의 줄 그리기)은 ADR-033, 설계, `extensions/work-board/references/behavior.md`, `docs/data-schema.md` 가 각자의 원본을 소유하고 다른 기능 스펙에 복제돼 있지 않다.
