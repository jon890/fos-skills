# Phase 04. `orch board del` 을 더한다

**Execution profile**: standard

## 목표

코디네이터가 `orch board del <항목>` 으로 끝난 항목 하나를, `orch board del --done` 으로 끝난 항목 전부를 지운다. `done` 이 아닌 항목은 `--force` 를 붙여야 지워진다. 판정과 사본(`.bak`)은 phase 02 가 `board.ts` 에 둔 동작이 맡고, 이 phase 는 인자 풀이와 `BOARD-DEL` 출력만 더한다.

**범위 외**: 문서와 창의 요청문은 phase 05 가 맡는다. `extensions/work-board/` 아래는 고치지 않는다.

## 컨텍스트

**요구사항**: REQ1(`del`), REQ6, REQ7, REQ11. REQ8 은 phase 02 의 `board.ts` 가 지키고 이 phase 의 테스트가 명령을 거쳐 `.bak` 를 한 번 더 본다. REQ10 의 잠금 경쟁은 phase 02 의 테스트와 인수 검증 계획이 보고 이 phase 는 다시 보지 않는다.

**근거 문서**: `docs/features/orch-board-read/spec.md`, `docs/features/orch-board-read/design.md`(「새 명령」)

- 고칠 스크립트는 `skills/orch/scripts/board/board-edit.ts` 다. phase 03 이 `get`, `list`, `--json`, `--status` 를 같은 파일에 더했다.
- phase 02 가 더한 `board.ts` 동작(성공하면 stdout 에 `{"deleted":[id…]}` 한 줄):
  - `del-done <id>`: `done` 항목만 지운다. 없는 항목과 `done` 이 아닌 항목은 종료 코드 1 이다. 뒤의 것은 stderr 에 지금 상태와 `orch board del <id> --force` 안내를 낸다.
  - `del <id> --exact`: 있는 항목을 상태와 상관없이 지운다. 없는 항목은 종료 코드 1 이다.
  - `del-done`(id 없음): `done` 항목을 모두 지운다. 없으면 `{"deleted":[]}` 이고 보드 파일을 저장하지 않는다.
  - 지운 호출은 `<보드 파일>.bak` 에 지우기 전 파일을 남긴다.
- `deleted` 의 id 는 저장된 값 그대로라 숫자일 수 있다. 출력에는 `String` 으로 쓴다.
- 거절한 호출의 stderr 와 종료 코드는 지금처럼 그대로 넘긴다. `--force` 안내를 `board-edit.ts` 가 따로 붙이지 않는다(설계 DECISION4).

## 의도 메모

- `del <항목>` 이 `board.ts del` 이 아니라 `del-done <항목>` 을 부른다. 옵션 없는 `board.ts del` 은 상태를 보지 않고 없는 id 도 0 으로 끝난다.
- 지우기 전에 목록을 보이고 묻지 않는다. 확인 창은 코디네이터 셸에서 답할 수 없다(스펙 DECISION8). 먼저 보려면 `orch board list --status done` 을 부른다.
- `--json` 은 `del` 에 받지 않는다. 스펙 REQ9 가 `show`, `list`, `get` 만 정했다.

## 작업 항목

### 1. `skills/orch/scripts/board/board-edit.ts`

- `OPTIONS` 에 `done: { type: 'boolean' }`, `force: { type: 'boolean' }` 을 더한다. 지금 옵션과 첫 글자가 겹치지 않는다.
- `USAGE` 와 머리 주석에 아래 두 줄과 `BOARD-DEL`, `BOARD-NONE` 출력을 더한다.

  ```text
  orch board del <항목> [--force]
  orch board del --done
  ```

- 인자 꼴(틀리면 `usage()`, 종료 코드 2):
  - `--done`, `--force` 는 `del` 에만 받는다.
  - `del <항목>`(위치 인자 둘, `--done` 없음): `--force` 가 없으면 `command` 는 `['del-done', 항목]`, 있으면 `['del', 항목, '--exact']` 다. 항목이 빈 문자열이어도(`del "$빈변수"`) 위치 인자 수로만 판정해 그대로 넘긴다. `board.ts` 가 `id 가 필요하다` 로 거절한다. 빈 문자열을 빼고 `['del-done']` 을 만들면 끝난 항목이 모두 지워진다.
  - `del --done`(위치 인자 하나, `--force` 없음): `command` 는 `['del-done']` 이다.
  - 그 밖(`del` 만, `del <항목> --done`, `del --done --force`, 위치 인자 셋 이상, `--json`, `--status`, `--on` 과 함께)은 사용법 오류다.
- 출력: `deleted` 의 id 마다 `BOARD-DEL <id>` 한 줄, 배열이 비었으면 `BOARD-NONE` 한 줄이다. `fullAsked()` 여도 같다.

### 2. `skills/orch/scripts/lib/commands.ts` 의 board 묶음

- `[동작, 인자 글]` 배열에 `['del', '<항목> [--force] | --done']` 을 더한다.

### 3. 이 phase 를 검증하는 `skills/orch/tests/board-edit.spec.ts` 와 `skills/orch/tests/lib-commands.spec.ts`

`board-edit.spec.ts` 에 새 `test` 를 더한다. 기존 사례는 고치지 않는다(도움말 사례의 동작 목록에 `del` 을 더하는 것은 된다).

- `doing` 항목에 `del x`: `refused` 로 종료 코드 1, stderr 에 `지금 doing` 과 `--force` 가 있고 보드 바이트가 그대로다. `.bak` 가 생기지 않는다.
- 같은 항목에 `del x --force`: stdout 이 `BOARD-DEL x` 이고 항목이 사라진다. `.bak` 의 내용이 지우기 전 보드와 같다.
- `done` 항목에 `del x`: `BOARD-DEL x`.
- 없는 id: 종료 코드 1 과 `항목이 없다`. `--force` 를 붙여도 같다. 숫자 id 항목(`id: 99`)을 `del 99` 로 불러도 `항목이 없다` 이고 항목이 남는다.
- `del --done`: `done` 둘(하나는 숫자 id)과 `doing` 하나인 보드에서 stdout 이 `BOARD-DEL <id>` 두 줄(파일 순서)이고 `doing` 항목만 남는다. `.bak` 가 지우기 전 보드와 같다. 다시 부르면 `BOARD-NONE` 이고 보드 파일 바이트와 `.bak` 가 그대로다.
- 보드 파일이 없을 때 `del --done`: `BOARD-NONE`, 종료 코드 0, 파일이 생기지 않는다.
- 워크트리 안에서 `--repo` 없이 부른 `del x` 가 주 checkout 의 보드에서 지우고 워크트리에 `.omc` 가 생기지 않는다.
- 빈 id: `done` 항목이 있는 보드에서 `del ''` 과 `del '' --force` 가 종료 코드 1 이고 stdout 이 비고 보드 바이트가 그대로다.
- `del x --full` 의 stdout 이 `BOARD-DEL x` 한 줄이다.
- 사용법 오류(종료 코드 2, `사용법`): `del`, `del x --done`, `del --done --force`, `del x y`, `del x --json`, `set x done --force`, `show x --done`.

`lib-commands.spec.ts` 의 「보드 수정 명령은 동작 이름과 repo 문맥을 같은 스크립트에 넘긴다」 사례의 동작 목록에 `del` 을 더한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/board-edit.spec.ts skills/orch/tests/lib-commands.spec.ts
node scripts/run-tests.ts --tsc-only
git diff --name-only HEAD -- extensions/work-board | wc -l
```

기대값: 앞 두 명령은 종료 코드 0 이다. 마지막 명령은 0 이다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/board/board-edit.ts` | 수정 |
| `skills/orch/scripts/lib/commands.ts` | 수정 |
| `skills/orch/tests/board-edit.spec.ts` | 수정 |
| `skills/orch/tests/lib-commands.spec.ts` | 수정 |
