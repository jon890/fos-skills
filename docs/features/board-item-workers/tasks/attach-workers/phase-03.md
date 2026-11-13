# Phase 03. 띄울 때 역할을 정하고 기존 항목에 worker 줄로 붙인다

**Execution profile**: standard

## 목표

worker 를 띄우면 `registerBoard` 가 역할(구현, 후속, 리뷰, 검증)을 정하고, 리뷰·검증은 리뷰 PR 의 항목에, 후속은 겹치는 열린 항목에 worker 줄로 붙인다. 띄우기 출력에 `BOARD-ATTACH <항목> <역할>` 을 낸다.

**범위 외**: 줄 끝내기와 판정(phase 04~05), 새 브랜치 후속의 PR·머지 단계 더하기(PR2 계획 `multi-pr-window`). 이 phase 뒤에도 새 브랜치 후속은 지금처럼 단계를 더하지 않는다.

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ5

**근거 문서**: `docs/features/board-item-workers/spec.md` REQ2·REQ3·REQ5·DECISION3·DECISION4·DECISION9·DECISION10·DECISION15·DECISION17·DECISION18·DECISION19·DECISION21, `docs/features/board-item-workers/design.md` 「역할 정하기」·「띄우기 출력」

- `skills/orch/scripts/lib/board.ts`: `registerBoard`(50행, 재시도 고리)와 `registerBoardOnce`(64-167행). 갈래는 `중간 과정:`(91-104행), 지시서 id 와 같은 워크트리·브랜치·업무 번호 찾기(105-121행), 다시 열기(130-147행), 기존 항목 쓰기(151-156행), 새 항목(157-161행)이다. 보드 쓰기는 안쪽 함수 `write` 가 `BOARD_BIN`(환경 변수 `BOARD_BIN` 이 앞선다)으로 한다.
- phase 01 의 `board.ts worker-add <id> <역할> --worktree W [--branch B] [--dispatch D] [--pr N] [--keep-current]`.
- phase 02 의 `lib/spec.ts` 의 `boardNewOf`, `workerRoleOf`.
- 줄 읽기는 이 phase 에서 새 `skills/orch/scripts/core/board-workers.ts` 에 `export type WorkerRow` 와 `boardWorkerRows(item): WorkerRow[]`(필드가 목록이 아니면 빈 목록, 객체가 아니거나 `worktree` 가 문자열이 아닌 줄은 뺀다)만 두고 쓴다. `lib/workers.ts` 의 `workerRows`(Orca 행)와 이름이 겹치지 않게 한다. 나머지 함수는 phase 04 가 더한다. 리뷰 PR 번호는 `skills/orch/scripts/lib/review.ts` 의 `reviewPrOfSpec`(56행)이 읽는다.
- 호출부: `skills/orch/scripts/worker/launch-worker.ts` 977행(`dispatch` 변수가 이미 있다. `LAUNCHED` 줄은 934행), `skills/orch/scripts/worker/send-to-worker.ts` 356행(`dispatch` 변수가 있다). 짧은 출력에서도 대문자 판정 줄은 그대로 나간다(`lib/output.ts` 의 `VERDICT`).
- 기존 테스트 `skills/orch/tests/board-path-callers.spec.ts` 는 `registerBoard` 를 다섯 인자로 부르고 `BOARD_BIN` 을 감싼 경쟁 보드를 쓴다. 새 인자는 기본값을 두어 그 테스트가 그대로 돈다. 경쟁 보드가 `worker-add` 를 그대로 넘기는지 확인한다.

## 의도 메모

- 리뷰·검증 갈래는 지금의 「기존 항목 쓰기」 를 타지 않는다. 그 갈래는 대표 칸과 status 를 바꾼다(스펙 DECISION15, DECISION17).
- `보드 항목 id:` 와 `리뷰 PR:` 이 함께 있으면 리뷰 줄로 붙고 항목을 닫지 않는다. 닫지 않게 하는 판정은 phase 04 다.
- 후보가 둘 이상일 때 `stepAt` 으로 고른다. 보드 항목에 `updatedAt` 이 없다.

## 작업 항목

### 1. `skills/orch/scripts/lib/board.ts` 의 `registerBoard`

- 시그니처를 `registerBoard(repo, spec, worktree, name, branch, dispatch = ''): BoardAttach | null` 로 바꾼다. `export type BoardAttach = { item: string; role: 'impl' | 'follow' | 'review' | 'verify'; attached: boolean }`. 재시도 고리는 값을 돌려준다. 보드 파일이 없어 건너뛰면 `null` 이다.
- 역할: `workerRoleOf(text)` 가 `'verify'` 면 검증, 아니고 `reviewPrOfSpec(text)` 가 있으면 리뷰다.
- 옛 항목(`workers` 필드 없음)에 붙을 때 넘길 값을 정하는 도우미 `keepArgs(repo, item)`: 역할은 `reviewPrOfItem(item.id, reviewPrsByItem(repo)) !== null` 이면 `review`, 아니면 `impl` 이다. 판정과 dispatch 찾기 모두 지금 띄우는 dispatch 의 이력 줄(`row.dispatch === dispatch`)을 뺀다. `launch-worker.ts` 는 `recordHistory`(962행)를 `registerBoard`(977행)보다 먼저 불러, 빼지 않으면 지금 띄운 리뷰 지시서가 옛 구현 항목을 리뷰 항목으로 만든다. `reviewPrsByItem` 에 뺄 dispatch 를 받는 선택 인자를 더한다. dispatch 는 `lib/launch-history.ts` 의 `launchHistory(repo)` 가운데 `basename(row.worktree) === item.worktree` 인 가장 늦은 줄의 `dispatch` 다. 결과는 `['--keep-current', <역할>, ...(dispatch ? ['--keep-dispatch', dispatch] : [])]` 다. `workers` 필드가 있으면 빈 목록이다.
- **리뷰·검증 갈래**(`중간 과정:` 보다 먼저 본다): 새 함수 `targetItem(items, opts)` 가 아래 순서로 처음 찾은 항목을 고른다. 후보가 둘 이상이면 `stepAt` 이 가장 늦은 항목, 같거나 없으면 파일에서 뒤에 있는 항목이다.
  1. `workers` 줄 가운데 `worktree === basename(worktree)` 인 줄이 있는 항목(같은 줄로 다시 띄움)
  2. `boardNewOf(text)` 가 거짓이고 `보드 항목 id:` 가 가리키는 항목이 있으면 그 항목(done 포함)
  3. `boardNewOf` 가 거짓이고 리뷰 PR N 이 있으면 `prNumbers(row.pr).has(N)` 인 항목, 없으면 `prNumbers(row['merged-pr']).has(N)` 인 항목. done 포함, decide·goal 제외
  4. 3 에서 못 찾았고 리뷰 PR N 이 있으면 `gh pr view N --json headRefName`(`lib/gh.ts` 의 `ghJson`, `cwd: repo`) 한 번으로 head 브랜치를 읽어, 대표 `branch` 나 줄의 `branch` 가 같은 끝나지 않은 항목(decide·goal 제외). 조회가 실패하면 건너뛴다
  5. 검증이고 리뷰 PR 이 없고 `boardNewOf` 가 거짓이면 같은 브랜치(대표 칸이나 줄), 그다음 같은 업무 번호(`task-ref`)의 끝나지 않은 항목(decide·goal 제외). 검증 worker 는 자기 브랜치로 새 워크트리를 만들므로(구현 브랜치는 `make-worktree` 가 거부한다) 실제로는 업무 번호로 찾는다. PR 전 검증 틀은 `보드 항목 id:` 를 적어 2번으로 붙인다(phase 05)
  찾으면 `worker-add <id> <역할> --worktree <basename> [--branch] [--dispatch] [--pr N] ...keepArgs` 하나만 부르고 끝낸다. 이 `worker-add` 가 실패하면 stderr 에 한 줄을 남기고 `attached: false` 로 돌려준다(뒤에 부를 쓰기가 없다). `attached` 는 1번으로 찾지 않았을 때 참이다. 못 찾으면 지금의 새 항목 갈래(157-161행)로 항목을 만들고(대표 칸은 지금처럼 이 리뷰 worker) 같은 역할로 `worker-add`(`keepArgs` 없이)를 부른다. `attached: false` 다. 이 항목은 리뷰만 하는 항목이다. 새 항목 id 는 지금처럼 지시서 id, `--name`, 워크트리 이름 순이다.
- **`중간 과정:` 갈래**: 찾은 항목에 `worker-add <id> follow ... ...keepArgs` 를 먼저 부르고, 그 뒤 지금의 `set`(103행)을 `--worktree`·`--branch` 없이 부른다. 같은 워크트리의 줄이 이미 있으면 `attached: false` 다.
- **구현·후속 갈래**: `same` 찾기(117-118행)의 맨 앞에 「`workers` 줄 가운데 `worktree === basename(worktree)` 인 줄이 있는 끝나지 않은 항목」 을 둔다. 대표가 아닌 구현 줄의 워크트리로 충돌 풀기를 다시 띄워도 그 항목을 잇는다(스펙 DECISION18). `boardNewOf(text)` 가 참이면 `same` 찾기(117-118행)를 `row.worktree === basename(worktree)` 하나로 줄인다(같은 워크트리 다시 띄우기만 잇는다). 기존 항목(다시 열기 143행, 기존 항목 155행)이면 `worker-add` 를 먼저 부르고, 그 뒤 지금의 `set` 을 `--worktree`·`--branch` 없이 부른다. 새 항목(159행)은 지금의 `set` 뒤에 `worker-add impl`(`keepArgs` 없이)을 부른다. 역할은 새 항목이면 `impl`, 기존 항목에 같은 워크트리의 줄이 있으면 그 줄의 역할(`attached: false`), 그 밖에는 `follow`(`attached: true`)다. `workers` 가 없는 옛 항목에 같은 워크트리로 다시 띄우면 옮겨 적은 줄과 워크트리가 같아 한 줄만 남는다.
- `worker-add` 가 실패하면(종료 코드가 0 이 아님) stderr 에 `보드: worker 줄을 쓰지 못했다: <이유>` 를 남기고, 뒤의 `set` 에 지금처럼 `--worktree`·`--branch` 를 붙여 부른다. `registerBoard` 는 Error 를 던지지 않고 `attached: false` 로 돌려준다.
- 재시도 고리(50-55행)가 다시 부를 때는 첫 시도가 정한 역할과 `attached` 를 넘겨 그대로 돌려준다. 첫 시도가 이미 줄을 더했으면 둘째 시도가 같은 줄을 보고 `attached` 를 거짓으로 바꾸기 때문이다.
- 머리 주석(39-49행)의 순서 설명에 역할과 붙이기를 더한다. 원본은 설계 「역할 정하기」 와 「대표 칸」 이라고 적는다.

### 2. 호출부

- `launch-worker.ts`: `registerBoard(repo, a.spec, worktree, a.name, common.branch || '', dispatch)` 로 부르고, 결과의 `attached` 가 참이면 `out(\`BOARD-ATTACH ${r.item} ${r.role}\`)` 를 낸다. 머리 주석의 출력 목록(89행 근처)에 이 줄을 더한다.
- `send-to-worker.ts`: `registerBoard(repo, a.spec!, prior.worktree, '', launch.branch || '', dispatch)`. 출력은 더하지 않는다.

### 3. `skills/orch/tests/board-attach.spec.ts`(신규)

임시 저장소와 실제 `extensions/work-board/bin/board.ts` 로 `registerBoard` 를 부르고 `board.json` 을 읽는다. 저장소 만들기는 `board-path-callers.spec.ts` 의 꼴을 따른다. `gh` 는 `GH` 환경 변수로 가짜 실행 파일을 준다(`skills/orch/tests/fixtures/fake-bin.ts`).

- 구현 항목 `a`(doing, `pr: 7`, `workers` 에 `impl` 줄)에 `리뷰 PR: #7` 지시서를 띄우면 항목 수가 그대로이고 `a` 에 `review` 줄이 늘며 `status`·`details`·`worktree` 가 그대로다. 결과가 `{ item: 'a', role: 'review', attached: true }` 다.
- `merged-pr: 7` 인 done 항목도 같다(status `done` 그대로). `pr` 필드와 `merged-pr` 필드에 7 이 든 항목이 함께 있으면 `pr` 필드 항목이다. `pr` 필드 후보가 둘이면 `stepAt` 이 늦은 항목이다.
- `pr` 필드가 빈 항목(대표 `branch: feat/a`)에 `리뷰 PR: #7` 을 띄우고 가짜 gh 가 PR 7 의 head 를 `feat/a` 로 내면 그 항목에 붙는다. gh 가 실패하면 새 항목이다.
- `보드 항목 id: a` 와 `리뷰 PR: #7` 을 함께 쓴 지시서도 `a` 에 `review` 줄이다.
- `리뷰 PR: #99`(없는 PR, gh 실패)는 새 항목을 만들고 그 항목의 `workers` 가 `review` 한 줄, 대표 `worktree` 가 리뷰 워크트리다.
- `worker 역할: 검증` 과 `브랜치: feat/a`(항목 `a` 의 브랜치) 지시서는 `a` 에 `verify` 줄이다.
- 업무 번호가 같은 후속 지시서(다른 워크트리)는 `a` 에 `follow` 줄을 더하고 원래 `impl` 줄은 그대로다. 대표 칸은 새 워크트리다.
- `workers` 가 없는 옛 구현 항목(`worktree: old`)에 후속을 붙이면 옛 대표 칸이 `impl` 줄로 먼저 남는다. 띄우기 이력에 `old` 워크트리의 dispatch 가 있으면 그 줄의 `dispatch` 가 그 값이고 `working` 이다. 이력이 없으면 `done` 이다.
- `workers` 가 없는 옛 구현 항목 `a` 에 `보드 항목 id: a` 와 `리뷰 PR: #7` 지시서를 띄우되, 띄우기 이력에 지금 dispatch 의 그 지시서 줄을 미리 넣는다. 옮긴 줄이 `impl` 이다.
- `workers` 가 없는 옛 리뷰 항목(`review-pr-480`)에 `보드 항목 id: review-pr-480` 과 `리뷰 PR: #480` 재리뷰를 띄우면 옮긴 줄의 역할이 `review` 다.
- 후속 `w2` 가 대표인 항목에서 구현 줄 `w1` 의 워크트리로 다시 띄우면(업무 번호·id 없음) 새 항목이 생기지 않고 `w1` 줄의 dispatch 가 바뀐다.
- 같은 워크트리로 다시 띄우면 줄 수가 그대로이고 `dispatch` 가 새 값, `attached` 가 거짓이다.
- `보드 항목: 새로` 지시서는 같은 업무 번호의 열린 항목이 있어도 새 항목을 만든다. 같은 워크트리로 다시 띄우면 그 항목을 잇는다.
- `BOARD_BIN` 을 `worker-add` 만 실패하는 감싼 명령으로 주면 대표 칸이 지금처럼 새 워크트리로 바뀌고 stderr 에 한 줄이 있다.

### 4. `skills/orch/tests/board-path-callers.spec.ts`

- 경쟁 보드 사례(176-183행)가 감싼 보드 명령의 호출 수를 `mode === 'error' ? 1 : 2` 로 단언한다. 갈래마다 `worker-add` 가 앞에 붙으므로 단언을 `set` 호출만 세도록 바꾼다. 감싼 명령이 `worker-add` 를 실제 보드 명령에 그대로 넘기는지 확인한다.

### 5. `skills/orch/tests/launch-worker.spec.ts`

- 업무 번호가 같은 열린 항목이 있는 보드에서 띄우면 stdout 에 `BOARD-ATTACH <항목> follow` 줄이 있다. 새 항목이면 그 줄이 없다. 기존 사례(928-937행 근처의 보드 사례)의 꼴을 따른다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/core-boundary.spec.ts skills/orch/tests/board-attach.spec.ts skills/orch/tests/board-path-callers.spec.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/send-to-worker.spec.ts skills/orch/tests/lib-board.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/board.ts` | 수정 (역할, targetItem, keepArgs, worker-add 호출, 돌려주는 값) |
| `skills/orch/scripts/worker/launch-worker.ts` | 수정 (dispatch 인자, BOARD-ATTACH 줄) |
| `skills/orch/scripts/worker/send-to-worker.ts` | 수정 (dispatch 인자) |
| `skills/orch/tests/board-attach.spec.ts` | 신규 |
| `skills/orch/tests/launch-worker.spec.ts` | 수정 |
| `skills/orch/tests/board-path-callers.spec.ts` | 수정 (호출 수 단언) |
| `skills/orch/scripts/lib/review.ts` | 수정 (reviewPrsByItem 의 뺄 dispatch) |
| `skills/orch/scripts/core/board-workers.ts` | 신규 (boardWorkerRows) |
