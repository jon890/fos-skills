# Phase 04. 상주 루프가 끝난 worker 줄을 끝내고, 구현 항목을 리뷰 항목으로 닫지 않는다

**Execution profile**: standard

## 목표

worker_done, Orca 의 끝난 dispatch, 사라진 워크트리로 worker 줄을 끝낸다. 구현·후속 줄이 있는 항목은 리뷰 지시서가 붙어도 리뷰 항목으로 보지 않아, 리뷰가 끝나도 항목이 닫히지 않는다.

**범위 외**: 멈춘 단계 알림(phase 05), 창의 「끊김」 그리기(PR2).

## 컨텍스트

**요구사항**: REQ2(리뷰가 끝나도 항목이 닫히지 않는 몫), REQ7(데이터·판정 몫)

**근거 문서**: `docs/features/board-item-workers/spec.md` REQ7·DECISION14·DECISION15·DECISION21, `docs/features/board-item-workers/design.md` 「루프가 넘기는 끝남」·「대표 칸을 읽는 곳」, `docs/adr/028-orch-core-layer.md`

- `skills/orch/scripts/core/lost-workers.ts`: `lostWorkers(rows, watched)`(8-25행)가 끝난 dispatch 를 고른다. 이미 `completed`·`abandoned` 이거나 outcome 이 `succeeded`·`cancelled` 인 행은 건너뛰므로, 새 함수는 그 행들을 따로 판정한다. `LOST_WORKER_STATES` 를 재사용한다.
- `skills/orch/scripts/board/board-sync.ts`: 옵션 표 `OPTIONS`(115행), 옵션 읽기(252-269행의 `--completed-items` 꼴), 항목 고리의 워크트리 비우기(325행), 리뷰 항목 판정(345-356행). 리뷰 판정이 참인 항목은 PR 을 잇지 않고 worker_done·대상 PR 머지로 닫힌다. 머리 주석 47-65행의 옵션 설명.
- `skills/orch/scripts/loop/steps/board.ts`: 리뷰 항목 목록 `openItems`(27행), worker_done 목록 `messages`(30행), dispatch id 는 `context(message)[1]`. 이번 틱의 Run 은 `ctx.runs`, 행은 `loop/steps/shared.ts` 의 `rowsOf(run, ctx.lookup)`(149행)로 읽는다. 결과가 `ok: false` 면 그 Run 은 건너뛴다.
- core 파일은 같은 폴더 모듈과 `node:path`, `node:crypto` 만 import 하고 `process`, `Date.now()` 를 쓰지 않는다. `skills/orch/tests/core-boundary.spec.ts` 가 막는다.

## 의도 메모

- 루프가 Orca 행을 이미 읽으므로 보드 맞추기가 다시 읽지 않는다(설계 DECISION3).
- 넘기는 목록은 보드의 작업 중 줄에 있는 dispatch 로 줄인다. Run 에 쌓인 끝난 dispatch 를 모두 넘기면 인자가 길어진다.
- 오래 움직이지 않는 worker 는 끝내지 않는다(스펙 DECISION14). `idle` 판정을 쓰지 않는다.

## 작업 항목

### 1. `skills/orch/scripts/core/board-workers.ts`

- phase 03 이 만든 `WorkerRow`, `boardWorkerRows` 를 쓴다.
- `hasWorkRows(item): boolean | null`: `workers` 필드가 목록이 아니면 `null`, `role` 이 `impl`·`follow` 인 줄이 있으면 `true`, 그 밖(줄이 모두 리뷰·검증이거나 빈 목록)은 `false`.
- `rowsReviewPr(item): number | null`: 줄 가운데 `at` 이 가장 늦은 리뷰·검증 줄의 `pr`(양의 정수일 때).
- `workingDispatches(items): Set<string>`: 모든 항목의 `working` 줄의 비지 않은 `dispatch`.
- `workerEnds(rows: Json[], reported: ReadonlySet<string>, watched: ReadonlySet<string>): Record<string, 'done' | 'lost'>`: `watched` 안의 dispatch 만 본다. `reported`(이 Run 들에서 worker_done 을 보낸 dispatch. `ctx.completions` 는 그 Run 의 worker_done 전부다)에 있거나 행의 `projection.outcome` 이 `succeeded` 면 `done`. 그 밖에 `dispatchStatus` 가 `failed`·`abandoned`·`completed`, `workerState` 가 `LOST_WORKER_STATES` 안, `projection.outcome` 이 `cancelled`·`failed` 면 `lost`. 남은 것은 `lostWorkers(rows, watched)` 가 낸 dispatch 를 `lost` 로 더한다. `reported` 의 dispatch 는 행이 없어도 `done` 으로 넣는다.

### 2. `skills/orch/scripts/board/board-sync.ts`

- 옵션 `'worker-ends'`(문자열, JSON 객체 `{"<dispatch>":"done"|"lost"}`)를 더한다. 값이 객체가 아니거나 값이 둘 밖이면 `--completed-items` 처럼 사용법 오류(종료 코드 2)다. 머리 주석의 옵션 목록에 「루프 내부용. 끝난 worker 의 dispatch 와 끝남 종류. 그 dispatch 의 작업 중 줄을 끝낸다」 를 더한다.
- 항목 고리 맨 앞, 모든 항목(done, goal 포함)의 `working` 줄마다: `dispatch` 가 목록에 있으면 `['worker-end', id, <값>, '--dispatch', <dispatch>]`, 아니고 `names !== null` 이고 줄의 `worktree` 가 `names` 에 없으면 `['worker-end', id, 'lost', '--worktree', <worktree>, '--clear']` 를 `cmds` 맨 앞에 넣는다. 같은 워크트리는 한 번만 넣는다.
- 325행의 워크트리 비우기는 대표 `worktree` 와 같은 워크트리의 `working` 줄이 있으면 내지 않는다(위 `worker-end --clear` 가 대표 칸을 다른 작업 중 줄로 바꾸거나 비운다). 그런 줄이 없으면 지금처럼 비운다.
- 리뷰 항목 판정(346행): `const rows = hasWorkRows(item)` 로 `rows === true` 면 `target = null`, `rows === false` 면 `target = rowsReviewPr(item) ?? reviewPrOfItem(id, reviewItems)`, `rows === null` 이면 지금처럼 `reviewPrOfItem(id, reviewItems)` 다.
- 닫기 조건(348-349행)에 「`rows === false` 이고 줄이 하나 이상이고 완료·끊김을 반영한 뒤 남는 `working` 줄이 없다」 를 더한다.
- 머리 주석의 `--completed-items`·`--completed-reviews` 설명에 「구현·후속 줄이 있는 항목은 리뷰 항목이 아니다. 줄이 모두 리뷰·검증인 항목은 그 줄의 worker_done 으로도 닫힌다」 를 더한다.
- dry-run 출력과 짧은 출력(`BOARD <id> updated`)은 지금 꼴 그대로다. `worker-end` 만 부른 항목도 바뀐 항목으로 센다.

### 3. `skills/orch/scripts/loop/steps/board.ts`

- `openItems` 필터를 `hasWorkRows(item) !== true` 인 항목으로 줄인다. `hasWorkRows(item) === false` 인 항목은 `reviewPrOfItem` 대신 `rowsReviewPr(item)` 로도 리뷰 항목으로 센다.
- 보드를 한 번 읽어 `workingDispatches(items)` 를 만들고, 비지 않았으면 `ctx.runs` 마다 `rowsOf(run.run, ctx.lookup)` 의 `ok` 행을 모은다. `ctx.completions` 의 모든 메시지(outcome 과 상관없이)의 dispatch 를 `reported` 로 넘겨 `workerEnds` 를 부르고, 결과가 비지 않았으면 `--worker-ends` 로 넘긴다. 머리 주석에 한 줄 더한다.

### 4. 테스트

- `skills/orch/tests/core-board-workers.spec.ts`(신규): `workerEnds` 가 reported 목록과 outcome `succeeded` 를 `done`, `workerState: 'stopped'`·`dispatchStatus: 'failed'`·outcome `cancelled`·`projection.stage.detail: 'terminal_missing'` 을 `lost`, 살아 있는(`running`, liveness 없음) 행과 `watched` 밖 행을 빼는지 본다. reported 에 있으면 outcome 이 failed 여도 `done` 이다. `hasWorkRows` 의 세 값, `rowsReviewPr`.
- `skills/orch/tests/board-sync.spec.ts`:
  - `--worker-ends '{"d1":"done"}'` 로 `d1` 줄이 `done` 이 되고 다른 줄은 그대로다. done 항목의 작업 중 리뷰 줄도 끝난다. 틀린 JSON 은 종료 코드 2.
  - 대표 워크트리 `w1`(impl, 작업 중)이 목록에 없고 후속 `w2` 가 작업 중이면 한 틱 뒤 대표 `worktree` 가 `w2` 이고 `w1` 줄이 `lost` 다. 후속이 없으면 대표 `worktree` 가 빈다.
  - 작업 중 리뷰 줄이 있는 마일스톤 항목의 PR 이 머지되면 항목은 done 이 되고 리뷰 줄은 `working` 그대로다(스펙 REQ7).
  - 줄이 모두 리뷰인 항목(id `rev-a`, 줄 `pr: 7`)은 `--worker-ends` 로 그 줄이 `done` 이 되면 done 이 된다.
- `skills/orch/tests/review-item.spec.ts`: 띄우기 이력의 지시서가 `보드 항목 id: a` 와 `리뷰 PR: #7` 을 함께 가진 항목 `a` 에 `impl` 줄이 있으면, `--completed-items '["a"]'` 와 PR 7 MERGED 에도 `a` 가 done 이 되지 않는다. `workers` 가 없으면 지금처럼 닫힌다. 옮긴 줄이 `review` 인 옛 리뷰 항목은 지금처럼 닫힌다.
- `skills/orch/tests/board-path-callers.spec.ts`: `syncBoard` 를 부르는 사례(92행 근처)에 작업 중 줄이 있는 보드와 끝난 dispatch 행(`ctx.lookup.rows` 에 미리 넣은 값)으로 `--worker-ends` 가 넘어가 줄이 끝나는 사례를 더한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/core-board-workers.spec.ts skills/orch/tests/board-sync.spec.ts skills/orch/tests/review-item.spec.ts skills/orch/tests/board-path-callers.spec.ts skills/orch/tests/core-boundary.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/core/board-workers.ts` | 수정 (hasWorkRows, rowsReviewPr, workingDispatches, workerEnds) |
| `skills/orch/scripts/board/board-sync.ts` | 수정 (--worker-ends, 사라진 워크트리의 줄, 리뷰 항목 판정) |
| `skills/orch/scripts/loop/steps/board.ts` | 수정 (끝남 모으기, openItems) |
| `skills/orch/tests/core-board-workers.spec.ts` | 신규 |
| `skills/orch/tests/board-sync.spec.ts` | 수정 |
| `skills/orch/tests/review-item.spec.ts` | 수정 |
| `skills/orch/tests/board-path-callers.spec.ts` | 수정 |
