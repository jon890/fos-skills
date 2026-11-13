# Phase 02. 보드의 업무 번호 칸과 `orch board set` 의 두 옵션

**Execution profile**: standard

## 목표

보드 항목이 업무 번호(`task-ref`)와 업무 주소(`task`)를 따로 저장하고, `orch board set` 이 상태를 바꾸지 않고 두 칸을 넣고 고치고 지우게 한다. 자동 경로가 쓸 「빈 칸만 채우기」 와 「번호가 같을 때만」 을 보드 명령에 둔다.

**범위 외**: 자동 경로의 호출(phase 03~05), 창의 칩(phase 06).

## 컨텍스트

**요구사항**: REQ1, REQ7(보드 명령 몫), REQ8(보드 문서 몫)

**근거 문서**: `docs/features/board-task-link/spec.md` REQ1·DECISION11·DECISION13·DECISION16, `docs/features/board-task-link/design.md` 「보드 항목 칸」·「`board.ts set` 에 더하는 것」·「`orch board set`」, `docs/adr/029-board-write-lock.md`

- `extensions/work-board/bin/board.ts`: 칸 목록 `FIELDS`(76행), 옵션 표 `parse`(345행 근처), `set` 의 칸 쓰기(`apply` 안 662-671행 근처의 `--task` 주소 검사와 `for (const key of FIELDS)`. 671행이 진행률 없는 doing 항목의 `set` 을 거절한다), 항목 객체 `itemObject`(427행의 키 목록), 머리 주석(1-60행)과 `HELP`. 옵션은 고유 접두로 줄여 쓸 수 있는데(`expand`, 301행) 정확히 같은 이름이 먼저라 `--task` 와 `--task-ref` 는 겹치지 않는다. `GET_FIELDS` 는 `FIELDS` 에서 만들어져 `get <id> task-ref` 가 따라온다.
- `skills/orch/scripts/board/board-edit.ts`: `verb === 'set' && args.length === 3` 만 받는다(66행). 옵션 표는 `OPTIONS`(29행), 접두 풀이는 `lib/args.ts` 의 `expandArgs` 다(같은 이름을 먼저 고른다).
- 번호 맞추기는 phase 01 의 `skills/orch/scripts/lib/task-adapters.ts` `taskAdapter` 와 `core/task-adapters.ts` `normalizeRef` 다.
- 보드 쓰기는 모두 `board.ts` 의 파일 잠금 안에서 다시 읽고 판정한다. `--fill` 과 `--if-task-ref` 도 그 안에서 판정한다.

## 의도 메모

- 보드 명령은 업무 도구를 모른다(ADR-031). 번호 맞추기는 `orch board set` 쪽에서 하고 보드 명령에는 맞춘 값을 넘긴다.
- `--fill` 을 부르는 쪽의 미리 읽기로 대신하지 않는다. 잠금 밖 판정이라 코디네이터의 쓰기와 겹친다(설계 DECISION3).

## 작업 항목

### 1. `extensions/work-board/bin/board.ts`

- `FIELDS` 에 `'task-ref'` 를 `'task'` 뒤에 더한다. `itemObject` 의 키 목록에도 더한다.
- 옵션 `'task-ref'`(문자열), `fill`(불리언), `'if-task-ref'`(문자열)를 더한다. `Args` 에 `fill?: boolean`, `ifTaskRef?: string` 을 둔다. `expand` 의 불리언 목록에 `fill` 을 넣는다.
- 사용법 검사(`parse`, 종료 코드 2): `--fill`, `--if-task-ref` 는 `set` 에만 쓴다. `--fill` 과 빈 값의 `--task ''`·`--task-ref ''` 를 함께 주면 사용법 오류다.
- `apply` 의 `set`(거절은 종료 코드 1): 항목을 찾은 뒤 `--if-task-ref` 가 있고 항목의 `task-ref` 가 그 값과 다르면 `Refused('업무 번호가 바뀌어 저장하지 않았다: <id> (지금 <값 또는 없음>)')`. `--task-ref` 값에 `/\s/` 가 있으면 `Refused('--task-ref 에는 공백을 쓰지 않는다: <값>')`. `fill` 이면 업무 칸 쓰기를 이렇게 정한다. `--if-task-ref` 가 없으면 항목의 `task` 와 `task-ref` 가 모두 비었을 때만 이 호출의 두 칸을 쓰고, 하나라도 차 있으면 둘 다 건너뛴다. `--if-task-ref` 가 있으면 빈 `task` 만 채운다.
- 머리 주석의 `set` 줄과 `--task` 설명을 고친다. `--task` 는 「업무 주소. 창이 제목 앞 업무 칩의 링크로 쓴다」, `--task-ref` 는 「업무 번호. 칩의 글이다」, `--fill` 과 `--if-task-ref` 의 뜻을 적는다. `HELP` 와 `USAGE` 에도 같은 옵션을 더한다.

### 2. `extensions/work-board/tests/board-task-ref.spec.ts`(신규)

`extensions/work-board/tests/board-run.ts` 의 실행 도우미로 임시 보드를 쓴다.

- `set a --task-ref X/1` 뒤 `get a task-ref` 가 `X/1` 이고 상태가 그대로다. `--task-ref ''` 는 그 칸만 지운다.
- `--task-ref 'X 1'` 은 종료 코드 1 이고 보드가 그대로다.
- `--fill --task-ref Y/2` 는 `X/1` 이 있는 항목을 바꾸지 않고 종료 코드 0, 빈 항목은 채운다. `task` 만 있는 항목에도 `--fill --task-ref Y/2` 는 쓰지 않는다. 같은 호출의 `--worktree` 는 `--fill` 과 상관없이 쓴다.
- `--fill --task ''` 는 종료 코드 2 다.
- `--if-task-ref X/1 --task https://x/1` 은 번호가 `X/1` 이면 쓰고, `Z/9` 면 종료 코드 1 이고 그대로다.
- `items` 출력에 `task-ref` 가 나온다.

### 3. `skills/orch/scripts/board/board-edit.ts`

- 옵션 `task`, `'task-ref'`(문자열)를 더한다.
- `set` 은 `args.length` 가 2(상태 없음)나 3 이고, 상태가 있거나 `values.task !== undefined` 나 `values['task-ref'] !== undefined` 일 때 받는다. 빈 값(`--task ''`)도 준 것으로 센다. 명령은 `['set', id, ...(third ? [third] : []), '--exact', ...task 옵션]` 이다. `--task`·`--task-ref` 는 `set` 밖의 동작에 주면 사용법 오류다.
- `--task-ref` 값이 비지 않았으면 `taskAdapter(values.repo ?? process.cwd())` 로 읽어 `normalizeRef` 로 맞춘다. `ConfigError` 면 stderr 에 이유를 내고 종료 코드 2 다.
- `USAGE` 의 `set` 줄을 `orch board set <항목> [<상태>] [--task <주소>] [--task-ref <번호>]` 로 바꾸고, 파일 맨 위 사용법 줄도 같게 고친다.

### 4. `skills/orch/tests/board-edit.spec.ts`

- `orch board set a --task-ref 458` 은 `board.task` 가 `dooray`(project `P`)인 저장소에서 `P/458` 로 저장하고 상태는 그대로다. 출력은 `BOARD-SET a <상태>` 다.
- `--task https://x/1` 만 준 호출, `--task ''` 만 준 호출(그 칸만 지운다), 상태와 두 옵션을 함께 준 호출, 아무것도 주지 않은 `set a`(종료 코드 2), 없는 항목(종료 코드 1, 항목을 만들지 않는다), `ftp://` 주소(종료 코드 1), 틀린 `board.task` 에서 `--task-ref`(종료 코드 2)를 본다.

### 5. 문서

- `skills/orch/references/board.md`: 41행의 `orch board set` 꼴에 두 옵션을 더하고 「업무 번호와 주소」 단락을 둔다(빈 값은 그 칸만 지운다, 번호만 넣으면 상주 루프가 주소를 만든다, `dooray` 어댑터는 `/` 없는 번호에 기본 프로젝트를 붙인다). 72행의 「`orch board set` 은 상태만 고치므로」 를 「`orch board set` 은 상태와 업무 칸만 고치므로」 로 고친다.
- `extensions/work-board/references/behavior.md` 60행의 항목 칸 목록에 업무 번호(`task-ref`)를 더한다.

### 6. 변경 이력 조각

- `extensions/work-board/changes/board-task-link.minor.md` 를 만든다. `- ` 줄로 「보드 항목에 업무 번호 칸(task-ref)과 set 의 --fill, --if-task-ref 를 더한다」.
- `skills/orch/changes/board-task-link.minor.md` 에 「orch board set 이 상태 없이 --task, --task-ref 로 업무 주소와 번호를 넣고 고치고 지운다」 줄을 더한다.

## 검증

```bash
node scripts/run-tests.ts extensions/work-board/tests/board-task-ref.spec.ts extensions/work-board/tests/board.spec.ts extensions/work-board/tests/board-exact.spec.ts extensions/work-board/tests/board-read.spec.ts skills/orch/tests/board-edit.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/bin/board.ts` | 수정 (task-ref 칸, --fill, --if-task-ref) |
| `extensions/work-board/tests/board-task-ref.spec.ts` | 신규 |
| `skills/orch/scripts/board/board-edit.ts` | 수정 (set 의 두 옵션) |
| `skills/orch/tests/board-edit.spec.ts` | 수정 |
| `skills/orch/references/board.md` | 수정 |
| `extensions/work-board/references/behavior.md` | 수정 (항목 칸 목록) |
| `extensions/work-board/changes/board-task-link.minor.md` | 신규 |
| `skills/orch/changes/board-task-link.minor.md` | 수정 |
