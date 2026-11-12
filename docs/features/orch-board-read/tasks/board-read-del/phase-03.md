# Phase 03. `orch board get`, `list` 와 `show --json` 을 더한다

**Execution profile**: standard

## 목표

코디네이터가 `orch board get <항목> <칸>` 으로 값 하나를 셸 변수에 담고, `orch board list` 로 보드 전체를 한 줄씩 보고, `show`·`list`·`get` 에 `--json` 을 붙여 같은 내용을 JSON 으로 받는다. 값과 꼴의 규칙은 phase 01 이 `board.ts` 에 둔 것을 받아 쓰고, 이 phase 는 인자 풀이와 출력만 더한다.

**범위 외**: `orch board del` 은 phase 04, 문서(`references/board.md` 따위)는 phase 05 가 맡는다. `extensions/work-board/` 아래는 고치지 않는다.

## 컨텍스트

**요구사항**: REQ1(`get`, `list`), REQ3, REQ4, REQ5, REQ9, REQ11

**근거 문서**: `docs/features/orch-board-read/spec.md`, `docs/features/orch-board-read/design.md`(「새 명령」, 「항목 객체」)

- 고칠 스크립트는 `skills/orch/scripts/board/board-edit.ts` 하나다. 지금 흐름: `parseArgs` → 동작별로 `board.ts` 에 넘길 `command` 배열을 만든다(꼴이 틀리면 `usage()` 로 종료 코드 2) → `--file <boardPath(...)>` 를 붙여 `run(scriptCommand(BOARD_BIN, command))` → stderr 를 그대로 쓰고, 종료 코드가 0 이 아니면 그대로 돌려준다 → stdout 의 JSON 을 읽어 한 줄 출력을 만든다.
- phase 01 이 더한 `board.ts` 동작과 출력(JSON 한 줄, `JSON.stringify` 꼴):
  - `get <id> <칸>` → `{"id","field","value"}`, `get <id> step <번호>` → `{"id","field":"step","number","value"}`. 값이 비면 `value` 가 `null` 이고 종료 코드 4 다. 칸 이름이 목록 밖이면 종료 코드 2 다.
  - `item <id>` → 항목 객체(`id`, 저장된 칸들, `progress`, `lines`).
  - `items [<상태>[,<상태>…]]` → 항목 객체 배열. 상태 값이 틀리면 종료 코드 1 이다.
  - `board.ts` 가 `GET_FIELDS`(받는 칸 목록)와 `itemTitle(item)`(제목이 없으면 id)을 내보낸다.
- `show` 의 JSON 없는 출력은 지금처럼 `board.ts view` 를 쓴다. 바꾸지 않는다(설계 DECISION5).
- `--full` 은 진입점이 떼어 신호로 넘기고 스크립트는 `fullAsked()` 로 읽는다. `--json` 은 진입점이 떼지 않아 스크립트의 옵션으로 온다.
- 못 맞춘 머지: `show` 가 지금 `unmatchedRecords(repo)[id]` 의 PR 가운데 `unmatchedResolved(단계 줄, pr)` 이 거짓인 것을 `unmatchedLine(id, pr)` 로 보인다. 단계 줄은 `lines` 에서 `number !== null` 인 것이다.
- 명령 표는 `skills/orch/scripts/lib/commands.ts` 의 board 묶음이다. `set`, `step`, `add-step`, `show` 를 `[동작, 인자 글]` 배열로 적고 `map` 으로 행을 만든다. 행을 더하면 `orch board --help` 에 저절로 보인다.
- 종료 코드 4 는 진입점(`skills/orch/bin/orch.ts`)과 실행기(`bin/orch`)가 자식의 값을 그대로 돌려줘 호출한 셸까지 간다. 두 파일은 고치지 않는다.

## 의도 메모

- 칸 이름은 `board-edit.ts` 가 `GET_FIELDS` 에 드는지만 보고 틀리면 자기 사용법을 낸다. 목록의 원본은 `board.ts` 의 상수 하나라 규칙이 두 곳에 생기지 않는다(스펙 REQ12, 설계 DECISION6). `board.ts` 에 그대로 넘기면 `board.ts` 의 긴 사용법 줄이 `orch board` 사용자에게 보인다. 상태 값은 검사하지 않고 넘긴다.
- 출력은 `lib/output.ts` 의 `emit` 을 거치지 않고 직접 쓴다. `emit` 은 대문자 낱말로 시작하지 않는 줄(값, JSON)을 버린다.
- `board-edit.ts` 는 보드 파일을 직접 읽지 않는다. 옛 문자열 줄 변환과 숫자 id 맞추기가 두 곳에 생긴다.
- 새 옵션 `--json`, `--status` 는 지금 옵션(`--repo`, `--board`, `--on`, `--help`)과 첫 글자가 달라 줄임 꼴이 모호해지지 않는다.

## 작업 항목

### 1. `skills/orch/scripts/lib/board.ts` 의 다시 내보내기

- `export { GET_FIELDS, itemTitle } from '../../../../extensions/work-board/bin/board.ts'` 를 더한다. 같은 파일이 이미 `linesRev` 를 그 경로에서 import 한다.

### 2. `skills/orch/scripts/board/board-edit.ts`

- `OPTIONS` 에 `json: { type: 'boolean' }`, `status: { type: 'string' }` 을 더한다.
- `USAGE` 에 아래 줄을 더하고 머리 주석의 사용법도 맞춘다. 머리 주석의 종료 코드 줄(「0 성공, 1 거절, 2 사용법·설정 오류」)에 `4 get 의 값이 없다` 를 더한다. 칸 목록은 `GET_FIELDS` 에서 `step` 을 뺀 이름을 공백으로 이어 넣는다(글로 다시 적지 않는다).

  ```text
  orch board get <항목> <칸> [--json]            칸: <GET_FIELDS 에서 step 을 뺀 이름>
  orch board get <항목> step <번호> [--json]
  orch board list [--status <상태>[,<상태>…]] [--json]
  orch board show <항목> [--json]
  ```

- 인자 꼴(틀리면 `usage()`, 종료 코드 2):
  - `--json` 은 `get`, `list`, `show` 에만, `--status` 는 `list` 에만 받는다. 새 동작에 `--on` 을 주면 사용법 오류다.
  - `get`: 위치 인자가 `get <항목> <칸>` 셋이고 칸이 `step` 이 아니거나, `get <항목> step <번호>` 넷이고 번호가 `/^\d+$/` 다. 칸이 `GET_FIELDS` 에 없으면 사용법 오류다. `command` 는 `['get', 항목, 칸]` 또는 `['get', 항목, 'step', 번호]` 다.
  - `list`: 위치 인자가 `list` 하나다. `command` 는 `['items']` 다. `--status` 가 있으면(빈 문자열 포함, `=== undefined` 로 판정) 그 값을 `--file <파일>` 뒤에 `--` 와 함께 붙여 `items --file <파일> -- <값>` 꼴로 부른다. 지금 코드는 `--file` 을 `command` 끝에 붙이므로 `--` 뒤에 올 인자를 따로 모아 그 뒤에 잇는다. `--status=-x` 가 `board.ts` 의 옵션으로 읽히지 않게 하려는 것이다.
  - `show --json`: `command` 는 `['item', 항목]` 이다. `--json` 이 없으면 지금의 `['view', 항목]` 이다.
- 종료 코드: `board.ts` 의 종료 코드를 그대로 돌려준다. stdout 을 쓰는 것은 종료 코드 0 과 `get` 의 4 뿐이다. 그 밖에는 지금처럼 stdout 에 아무것도 쓰지 않는다.
- `get` 의 출력: `--json` 이면 받은 stdout 을 그대로 쓴다. 아니면 `value` 가 `null` 이 아닐 때만 `value` 와 줄바꿈을 쓴다. 앞뒤에 다른 글을 붙이지 않는다.
- `list` 의 출력: `--json` 이면 받은 stdout 을 그대로 쓴다. 아니면 배열이 비었을 때 `BOARD-NONE`, 있으면 항목마다 `BOARD <id> <status> <끝낸>/<전체> <제목>` 한 줄이다. 진행률은 `show` 머리와 같은 식(`progress` 가 `null` 이면 `진행률 없음`), 상태는 글일 때만 그 값이고 아니면 `show` 머리처럼 `null`, 제목은 `itemTitle(item)` 이다. 머리 줄을 만드는 식은 `show` 와 함께 쓰는 함수 하나로 둔다.
- `list` 에서 `fullAsked()` 가 참이고 `--json` 이 없으면 항목마다 머리 줄 뒤에 그 항목의 안 풀린 `BOARD-UNMATCHED` 줄, 모든 줄(끝난 줄 앞에 `✓ `)을 잇는다. `show --full` 과 같은 순서다. `unmatchedRecords` 는 한 번만 부르고, `--full` 이 없는 `list` 와 `get` 에서는 부르지 않는다. 기록의 키는 문자열이라 `String(item.id)` 로 찾는다.
- `show --json` 의 출력: 받은 항목 객체에 `unmatched` 를 더해 `JSON.stringify` 한 줄로 쓴다. `unmatched` 는 지금 `show` 가 `BOARD-UNMATCHED` 줄을 고르는 판정에서 남은 PR 번호를 `Number` 로 바꾼 배열이다(없으면 `[]`). 안 풀린 PR 을 고르는 식은 `show`, `show --json`, `list --full` 이 함께 쓰는 함수 하나로 둔다.
- `--json` 과 `--full` 을 함께 받으면 JSON 만 쓴다.

### 3. `skills/orch/scripts/lib/commands.ts` 의 board 묶음

- `[동작, 인자 글]` 배열에 `['get', '<항목> <칸>|step <번호> [--json]']`, `['list', '[--status <상태,...>] [--json]']` 을 더하고 `show` 의 인자 글을 `'<항목> [--json]'` 으로 고친다.

### 4. 이 phase 를 검증하는 `skills/orch/tests/board-edit.spec.ts` 와 `skills/orch/tests/lib-commands.spec.ts`

`board-edit.spec.ts` 에 새 `test` 를 더한다. 기존 사례는 고치지 않는다(도움말 사례의 동작 목록에 `get`, `list` 를 더하는 것은 된다). 이 파일의 `orch`, `ok`, `refused`, `save`, `item`, `git`, `config` 를 쓴다. 종료 코드 4 는 `ok` 가 받지 않으므로 `orch` 의 결과를 직접 단언한다.

- `get` 의 값: `get x branch` 의 stdout 이 `<브랜치>\n` 과 바이트가 같다. `pr`(숫자로 저장된 값), `progress`(`1/2`), 제목 없는 항목의 `title`(id), `get x step 9`(`9) 리뷰`)를 본다.
- `get` 의 빈 값: 브랜치 칸이 없는 항목에서 stdout 이 빈 문자열이고 종료 코드 4 다. `--json` 을 붙이면 종료 코드 4 이고 `JSON.parse(stdout).value` 가 `null` 이다.
- `get --json`: `{"id":"x","field":"progress","value":"1/2"}` 와 같은 객체, `step` 은 `number` 가 숫자다.
- `get` 의 거절: 없는 항목(종료 코드 1, `항목이 없다`), `step 5`(종료 코드 1, `있는 번호: 1 9`), 숫자 id 항목(`항목이 없다`), `get x foo`(종료 코드 2, stderr 가 `orch board` 사용법이고 `branch` 와 `merged-pr` 가 있으며 `사용법: board.ts` 가 없다). `--json` 을 붙여도 stdout 이 빈다.
- `list`: 상태가 다른 항목 셋인 보드에서 세 줄이 파일 순서로 나온다(진행률 없는 항목은 `진행률 없음`, 제목 없는 항목은 id). `--status done` 은 한 줄, `--status doing,wait` 는 두 줄, 결과가 없으면 `BOARD-NONE`, 보드 파일이 없어도 `BOARD-NONE` 이고 파일이 생기지 않는다. `--status foo` 와 `--status=-x` 는 종료 코드 1 이고 stderr 에 허용 값이 있다.
- `list --json`: 배열 길이가 항목 수와 같고 `--status done --json` 은 `done` 항목 수다. 결과가 없으면 `[]` 다. 항목 객체에 `unmatched`, `was`, `rev` 키가 없다.
- `list --full`: 머리 줄 아래에 그 항목의 줄이 `show --full` 과 같은 꼴(`✓ 1. 구현`)로 나온다. 못 맞춘 머지 기록을 둔 항목은 머리 줄 바로 아래에 `BOARD-UNMATCHED x PR #70` 이 나오고, `--full` 이 없으면 나오지 않는다. 기록은 `skills/orch/tests/board-unmatched.spec.ts` 처럼 `recordUnmatched(repo, { id: 'x' }, [{ number: 9, done: false, text: '9) 리뷰' }], '70')` 로 둔다.
- `show --json`: `branch` 가 저장된 값이고 `lines` 가 있고 `unmatched` 가 `[]` 다. 기록을 둔 뒤에는 `[70]` 이다. `show x --json --full` 의 stdout 이 `--full` 없는 것과 같다. JSON 없는 `show x` 의 출력은 지금 사례 그대로다.
- 읽기 뒤 보드 파일 바이트가 그대로다.
- 워크트리와 설정: `git worktree` 로 만든 워크트리 안에서 `--repo` 없이 부른 `get x status` 가 주 checkout 의 보드 값을 낸다. `config('chosen.json')` 뒤에는 그 파일의 값을 낸다(이 파일의 「워크트리 기본은 주 checkout」 사례와 같은 준비다).
- 사용법 오류(종료 코드 2, `사용법`): `get`, `get x`, `get x step`, `get x step one`, `get x branch 3`, `list extra`, `set x done --json`, `show x --status doing`, `get x branch --on '1 merge'`.

`lib-commands.spec.ts` 의 「보드 수정 명령은 동작 이름과 repo 문맥을 같은 스크립트에 넘긴다」 사례의 동작 목록에 `get`, `list` 를 더한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/board-edit.spec.ts skills/orch/tests/lib-commands.spec.ts skills/orch/tests/board-unmatched.spec.ts
node scripts/run-tests.ts --tsc-only
node scripts/run-tests.ts skills/orch/tests/core-boundary.spec.ts
git diff --name-only HEAD -- extensions/work-board | wc -l
```

기대값: 앞 세 명령은 종료 코드 0 이다. 마지막 명령은 0 이다(이 phase 는 `extensions/work-board/` 를 고치지 않는다).

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/board.ts` | 수정 |
| `skills/orch/scripts/board/board-edit.ts` | 수정 |
| `skills/orch/scripts/lib/commands.ts` | 수정 |
| `skills/orch/tests/board-edit.spec.ts` | 수정 |
| `skills/orch/tests/lib-commands.spec.ts` | 수정 |
