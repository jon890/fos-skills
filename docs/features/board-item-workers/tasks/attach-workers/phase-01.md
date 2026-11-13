# Phase 01. 보드 명령의 worker 줄 쓰기(`worker-add`, `worker-end`)

**Execution profile**: standard

## 목표

보드 항목이 worker 줄 목록(`workers` 필드)을 갖고, 줄을 더하고 끝낼 때 대표 칸(`worktree`·`branch`)을 같은 잠금 안에서 다시 정하게 한다.

**범위 외**: 줄을 부르는 orch 쪽(phase 03~05), 동시 PR 의 `stages` 묶음과 `worker-set`(PR2 계획 `multi-pr-window`), 창의 그리기(PR2).

## 컨텍스트

**요구사항**: REQ1, REQ8(보드 명령 머리 주석과 도움말 몫)

**근거 문서**: `docs/features/board-item-workers/spec.md` REQ1·DECISION8·DECISION17·DECISION18·DECISION21, `docs/features/board-item-workers/design.md` 「worker 줄」·「보드 명령」, `docs/adr/033-board-item-worker-rows.md`, `docs/adr/029-board-write-lock.md`

- `extensions/work-board/bin/board.ts`: 명령 목록 `COMMANDS`(88행 근처), 옵션 표 `parse`(345행 근처), 위치 인자 수 `limit`(383행), 항목 객체 `itemObject`(440행의 키 목록), 명령 실행 `apply`(518행부터 `a.cmd === ...` 갈래), 쓰기 마무리(804행의 `stepAt` 갱신은 `status`·`details`·`next` 가 바뀐 때만이라 `workers` 쓰기는 `stepAt` 을 바꾸지 않는다). 거절은 `Refused`(종료 코드 1), 사용법 오류는 `parse` 의 `Error`(종료 코드 2)다.
- 항목 객체는 통째로 읽고 쓰므로 모르는 필드도 남는다. 이 phase 의 테스트가 옛 명령(`set`, `step`)이 `workers` 필드를 지우지 않는지 확인한다.
- 테스트 도우미: `extensions/work-board/tests/board-run.ts` 의 `tempBoard`, `run`, `write`, `item`.

## 의도 메모

- 대표 칸 계산을 orch 에 두지 않는다. 쓰기 둘 사이의 경쟁으로 줄 목록과 대표 칸이 어긋난다(설계 DECISION1).
- `set --worktree` 는 그대로 둔다. 옛 번들과 코디네이터가 쓰는 계약이다.

## 작업 항목

### 1. `extensions/work-board/bin/board.ts` 의 `worker-add`

```text
board.ts worker-add <id> <impl|follow|review|verify> --worktree W [--branch B] [--dispatch D] [--pr N] [--keep-current <role>] [--keep-dispatch D]
```

- `COMMANDS` 에 `worker-add`, `worker-end` 를 더한다. 옵션 `dispatch`, `'keep-current'`, `'keep-dispatch'`(문자열), `clear`(불리언)를 더하고 `expand` 의 불리언 목록에 `clear` 를 넣는다. `--dispatch`, `--keep-current`, `--keep-dispatch` 는 `worker-add` 에(`--dispatch` 는 `worker-end` 에도), `--clear` 는 `worker-end` 에만 쓴다(그 밖은 사용법 오류). `--pr` 은 지금처럼 `prValue` 로 숫자로 저장한다.
- 역할(위치 인자와 `--keep-current` 값)이 넷 밖이거나 `--worktree` 가 없거나 비었으면 사용법 오류다. 없는 항목은 `Refused`.
- 줄 객체: `{ role, dispatch: D ?? null, worktree: W, branch: B ?? null, pr: N ?? null, status: 'working', at: <ISO>, endedAt: null }`. 시각은 이 파일이 `stepAt` 에 쓰는 것과 같은 꼴을 쓴다.
- 열쇠는 `worktree` 하나다. 같은 워크트리의 줄이 있으면 그 줄의 `dispatch`·`branch`·`pr`(준 경우), `at` 을 바꾸고 `status` 를 `working`, `endedAt` 을 `null` 로 둔다. `role` 은 바꾸지 않는다. 없으면 목록 끝에 더한다.
- `--keep-current <role>`: 항목에 `workers` 필드가 없을 때만 먼저 지금 대표 칸으로 그 역할의 줄 하나를 만든다. `dispatch` 는 `--keep-dispatch` 값(없으면 `null`)이다. `worktree` 가 비었거나 `dispatch` 가 `null` 이면 `status: 'done'`, `endedAt` 은 지금 시각이다. 대표 칸이 모두 비어도 줄을 만든다(설계 DECISION5). 옮겨 적은 줄의 워크트리가 더할 줄과 같으면 하나만 남긴다(더할 줄 값으로 바꾼다).
- 역할이 `impl`·`follow` 면 항목의 `worktree`·`branch` 를 그 줄 값으로 바꾼다(`branch` 가 없으면 칸을 그대로 둔다). `review`·`verify` 는 대표 칸, `status`, 줄(`details`, `next`)을 건드리지 않는다. done 항목에도 더한다.

### 2. 같은 파일의 `worker-end`

```text
board.ts worker-end <id> <done|lost> (--dispatch D | --worktree W) [--clear]
```

- 열쇠는 둘 중 하나만 받는다(둘 다거나 없으면 사용법 오류). 값이 `done`·`lost` 밖이면 사용법 오류.
- `status` 가 `working` 이고 열쇠(`dispatch` 가 같거나, `--worktree` 면 `worktree` 가 같은) 줄을 모두 끝낸다. `status` 를 값으로, `endedAt` 을 지금 시각으로 둔다. 맞는 줄이 없으면 쓰지 않고 종료 코드 0 이다.
- 끝낸 줄이 `impl`·`follow` 이고 항목의 `worktree` 가 그 줄 값이면, 남은 `working` 구현·후속 줄 가운데 `at` 이 가장 늦은 줄로 `worktree`·`branch` 를 바꾼다. 없으면 대표 칸을 그대로 두고, `--clear` 를 줬으면 `worktree` 를 비운다(`branch` 는 지금 비우기처럼 둔다).

### 3. 읽기 출력과 문서

- `itemObject` 의 키 목록에 `workers` 를 더한다(`item`, `items` 출력). `view` 는 바꾸지 않는다.
- 머리 주석의 사용 목록과 `HELP`, `USAGE` 에 두 명령과 옵션을 적는다. 줄 필드와 대표 칸 규칙은 「대표 칸은 가장 최근의 작업 중 구현·후속 줄이다. 리뷰·검증 줄은 대표가 되지 않는다」 로 짧게 적고 원본으로 `docs/data-schema.md` 를 가리킨다(phase 05 가 그 절을 쓴다).
- `limit` 에 두 명령의 위치 인자 수(`worker-add` 는 3, `worker-end` 는 3)를 맞춘다.

### 4. `extensions/work-board/tests/board-workers.spec.ts`(신규)

`board-run.ts` 의 도우미로 임시 보드를 쓴다.

- `worker-add a impl --worktree w1 --branch b1 --dispatch d1` 뒤 `item a` 의 `workers` 가 한 줄이고 `worktree` 가 `w1` 이다. `stepAt` 과 `view` 의 `rev` 는 그대로다.
- 같은 항목에 `follow --worktree w2 --branch b2 --dispatch d2` 를 더하면 두 줄이고 대표가 `w2` 다. `review --worktree r1 --branch review/pr-5 --pr 5` 를 더하면 세 줄이고 대표와 `status` 가 그대로다. done 항목에 `review` 를 더해도 `status` 가 `done` 이다.
- 같은 `w2` 로 `--dispatch d3 --branch b9` 를 다시 주면 줄 수가 그대로이고 `dispatch` 가 `d3`, `branch` 가 `b9`, `status` 가 `working` 이다.
- `worker-end a done --dispatch d3` 뒤 대표가 `w1` 로 돌아간다. `worker-end a lost --dispatch d1` 뒤 작업 중 구현·후속 줄이 없어 대표 칸이 `w1` 그대로다. 새로 준비한 보드(작업 중 `impl` 줄 `w1` 하나)에서 `worker-end a lost --worktree w1 --clear` 는 대표 `worktree` 를 비운다. 작업 중 후속 줄이 남아 있으면 `--clear` 를 줘도 그 줄로 바뀐다. 없는 dispatch 는 종료 코드 0 이고 파일이 그대로다.
- `workers` 필드가 없는 항목(`worktree: 'old'`, `branch: 'feat/old'`)에 `--keep-current impl --keep-dispatch d0` 로 `follow` 를 더하면 첫 줄이 `impl`·`old`·`dispatch: 'd0'`·`working` 이다. `--keep-dispatch` 없이 주면 옮긴 줄이 `done` 이다. `--keep-current review` 면 옮긴 줄의 역할이 `review` 다. `worktree` 가 빈 항목은 옮긴 줄이 `done` 이다.
- 사용법 오류: 모르는 역할, 모르는 `--keep-current` 값, `--worktree` 없음, `worker-end` 에 열쇠 둘 다, `set` 에 `--dispatch`, `worker-add` 에 `--clear`. 모두 종료 코드 2.
- `workers` 가 있는 항목에 `set a doing --title T` 와 `step a 1` 을 불러도 `workers` 가 남는다.

### 5. 변경 이력 조각

- `extensions/work-board/changes/board-item-workers.minor.md`(신규)에 `- ` 줄로 「보드 항목에 worker 줄 목록(workers)과 worker-add, worker-end 명령을 더한다」.

## 검증

```bash
node scripts/run-tests.ts scripts/tests/check-skill-docs.spec.ts extensions/work-board/tests/board-workers.spec.ts extensions/work-board/tests/board.spec.ts extensions/work-board/tests/board-exact.spec.ts extensions/work-board/tests/board-read.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/bin/board.ts` | 수정 (worker-add, worker-end, itemObject 의 workers, 머리 주석과 도움말) |
| `extensions/work-board/tests/board-workers.spec.ts` | 신규 |
| `extensions/work-board/changes/board-item-workers.minor.md` | 신규 |
