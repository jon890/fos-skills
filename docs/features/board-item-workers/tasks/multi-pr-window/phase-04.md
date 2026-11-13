# Phase 04. 창이 항목 아래에 worker 줄을 그린다

**Execution profile**: standard

## 목표

창이 보드 항목 아래에 작업 중 worker 를 한 줄씩(역할, 워크트리, PR·CI, Orca 상태) 그리고, 끝난 worker 는 「✓ 끝난 worker N」 으로 묶고, 끊긴 worker 는 빨간 줄로 보이게 한다. 펼친 보기(d)는 모든 줄을 그린다. 작업 중 줄이 있으면 「worker 없음」 을 그리지 않고, done 항목도 작업 중 줄은 끝날 때까지 그린다.

**범위 외**: 줄 끝내기 판정(PR1 의 보드 맞추기). 창은 판정하지 않고 저장된 `status` 를 읽는다.

## 컨텍스트

**요구사항**: REQ6, REQ7(창 몫)

**근거 문서**: `docs/features/board-item-workers/spec.md` REQ6·REQ7·DECISION5·DECISION23·DECISION24·DECISION26, `docs/features/board-item-workers/design.md` 「창」

- 선행: PR1(`attach-workers`). 항목의 `workers` 줄 꼴은 `docs/data-schema.md` 의 「보드 항목의 worker 줄」 절이다.
- `extensions/work-board/hooks/register.js`: `prFor`(509행), `workerFor`(515행), `unmappedWorkers`(521행, done 항목을 붙은 것으로 세지 않는다), `workerLine`(528행), `workerNoneText`(808행), 그리기의 `idleView`(1763행), `noteTexts`(1770행), `itemHead`(1822행, 제목 버튼이 `itemPrompt(item, worker, live.prs)` 에 worker 하나를 넘긴다), `itemView`(1849행, `!done && item.worktree` 일 때 worker 줄 하나 또는 `idleView`), 「항목에 안 붙은 worker」 상자(2053행). 살아 있는 worker 는 `parseWorkers` 가 `{ id: dispatchId, terminal, state, worktree }` 로 만든다.
- `live.test.ts`, `pane.test.ts` 는 `claude-code/testing` 을 import 하는 플러그인 테스트라 `node scripts/run-tests.ts` 가 아니라 저장소 루트의 `claude plugin test .` 가 돈다(`README.md` 의 테스트 설명).
- 창은 TypeScript 를 import 하지 못한다. 줄을 읽는 함수는 이 파일 안의 순수 함수로 두고 테스트가 직접 부른다.
- 테스트: `extensions/work-board/tests/live.test.ts`(순수 함수, 271행 근처에 `workerFor`·`unmappedWorkers` 사례), `extensions/work-board/tests/pane.test.ts`(그리기, 96행 접힌 보기 사례).

## 의도 메모

- 제목 버튼의 프롬프트(`itemPrompt`)에는 대표 줄의 worker 하나를 넘긴다. 지금 계약을 바꾸지 않는다.
- 줄이 없는 옛 항목은 지금 그림과 같아야 한다.

## 작업 항목

### 1. `extensions/work-board/hooks/register.js` 의 순수 함수

- `workerRowsFor(item, workers)`: `item.workers` 가 목록이면 객체 줄마다 `{ ...row, live }` 를 돌려준다. `live` 는 `workers` 가운데 `id === row.dispatch` 인 것, 없으면 `worktree === row.worktree` 인 것, 없으면 `null` 이다. 목록이 없으면 `workerFor(item, workers)` 가 살아 있는 worker 를 찾았을 때만 `[{ role: 'impl', worktree: item.worktree, status: 'working', live, legacy: true }]`, 아니면 `[]` 다. 그래서 옛 항목은 worker 가 없으면 지금처럼 `idleView` 를 그리고, `live` 가 없는 줄에 `workerLine` 을 부르지 않는다. 순서는 `at` 순이다(없으면 목록 순).
- `ROLE_LABELS = { impl: '구현', follow: '후속', review: '리뷰', verify: '검증' }`.
- `workerRowLine(row, prs)`: `<역할> <워크트리>` 뒤에 PR 과 CI 를 붙인다. PR 은 `row.pr` 이 있으면 `prs` 에서 그 번호를 찾아 `PR #N <CI 요약>`(열린 PR 목록에 없으면 `PR #N`), 없으면 `row.live` 로 지금의 `prFor`. 뒤에 `row.live.state`(ready 가 아닐 때)를 붙인다. 옛 줄(`legacy`)은 지금의 `workerLine(live, prs)` 와 같은 글이다.
- `unmappedWorkers(items, workers)`: 붙은 것으로 세는 것을 「done 이 아닌 항목의 `worktree`」 와 「모든 항목의 `working` 줄의 `dispatch` 와 `worktree`」 로 넓힌다.

### 2. 같은 파일의 그리기(`itemView`)

- 접힌 보기: `working` 줄마다 `⚙ ` + `workerRowLine` 한 줄(노란색, 끝에 `noteTexts(row.live)`), `lost` 줄마다 `⚠ 끊김 ` + `<역할> <워크트리>` 한 줄(빨간색), `done` 줄이 있으면 `✓ 끝난 worker N` 한 줄(흐리게)을 그린다.
- 펼친 보기: 모든 줄을 `at` 순으로 그린다. `done` 줄은 흐리게 `✓ `, `lost` 줄은 빨간 `⚠ 끊김 `, `working` 줄은 접힌 보기와 같다.
- `working` 줄이 없고 `item.worktree` 가 있으면 지금처럼 `idleView` 를 그린다. `working` 줄이 있으면 그리지 않는다.
- done 항목: 접힌 보기와 펼친 보기 모두 `working` 줄만 그린다(끝난 줄과 끊김 줄, `idleView` 는 그리지 않는다. 스펙 DECISION26).
- `itemHead` 에 넘기는 worker 는 `working` 구현·후속 줄 가운데 `worktree === item.worktree` 인 줄의 `live`, 없으면 `workerFor(item, live.workers)` 다.
- 「항목에 안 붙은 worker」 상자는 넓힌 `unmappedWorkers` 를 쓴다.

### 3. 테스트

- `extensions/work-board/tests/live.test.ts`: `workerRowsFor` 가 dispatch 로, 없으면 워크트리로 live 를 붙이고 옛 항목을 한 줄로 만든다. `workerRowLine` 이 리뷰 줄에 대상 PR 번호와 CI 요약을 붙인다. `unmappedWorkers` 가 done 항목의 작업 중 리뷰 줄 worker 를 붙은 것으로 센다.
- `extensions/work-board/tests/pane.test.ts`: 작업 중 둘, 끝남 둘인 항목은 접힌 보기에 worker 줄 둘과 「✓ 끝난 worker 2」, 펼친 보기에 네 줄이 있다. `lost` 줄은 접힌 보기에도 빨간 줄로 있다. 리뷰 줄만 작업 중인 항목에 「worker 없음」 이 없다. done 항목에 작업 중 리뷰 줄이 있으면 그 줄이 있다. 줄 없는 옛 항목의 기존 사례가 그대로 통과하고, worker 가 없는 옛 항목은 「worker 없음」 을 그린다.

## 검증

```bash
claude plugin test .
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/hooks/register.js` | 수정 (workerRowsFor, workerRowLine, unmappedWorkers, itemView 의 worker 줄) |
| `extensions/work-board/tests/live.test.ts` | 수정 |
| `extensions/work-board/tests/pane.test.ts` | 수정 |
