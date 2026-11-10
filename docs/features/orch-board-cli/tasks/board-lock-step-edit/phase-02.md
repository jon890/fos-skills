# Phase 02. 엄격 호출(`--exact`), 항목 읽기(`view`), 결과 JSON, 낡은 목록 거절(`--if-rev`)

**Execution profile**: standard

## 목표

`board.ts` 가 「있는 항목과 하나뿐인 번호에만 듣는」 엄격 호출, 항목 하나를 JSON 으로 읽는 동작, 고친 결과를 JSON 한 줄로 내는 출력, 읽은 뒤 줄이 바뀌었으면 통째 저장을 거절하는 옵션을 받는다. orch 의 새 보드 명령과 통째 저장 호출자가 이것을 부른다.

**범위 외**: 단계 글 바꾸기와 더하기(`step-edit`, `step-add`, `--event`)는 phase 03 이다. orch 쪽 호출자를 고치는 일은 뒤 PR 이다. 새 옵션을 주지 않은 호출의 출력과 종료 코드는 바꾸지 않는다.

## 컨텍스트

**요구사항**: REQ3, REQ7, REQ8(결과 JSON), REQ9(`view`), REQ11(낡은 목록), REQ13

**근거 문서**: `docs/features/orch-board-cli/spec.md`, `docs/features/orch-board-cli/design.md` 의 「`board.ts` 에 더하는 것 (PR1)」, 「줄 지문과 낡은 목록 거절」

`extensions/work-board/bin/board.ts` 의 지금 구조다.

- `COMMANDS` 배열이 받는 동작 이름이고 `USAGE` 문자열이 `사용법: board.ts {set,detail-edit,detail-add,…}` 로 시작한다. 기존 테스트가 이 앞부분과 「`show` 는 모르는 명령(종료 코드 2)」 을 단언한다. 그래서 새 동작 이름은 목록 끝에 더하고 `show` 라는 이름은 쓰지 않는다.
- `parse` 가 `expand(argv, 옵션 이름들, 값 없는 옵션들)` 로 옵션의 고유한 앞 글자 줄임을 펼친다. 새 옵션 이름은 지금 옵션(`undo`, `title`, `owner`, `pr`, `worktree`, `branch`, `merged-pr`, `task`, `progress`, `stages`, `detail`, `next`, `file`, `help`)과 첫 글자가 겹치지 않아야 지금 듣는 줄임 꼴(`--s`, `--o`)이 그대로 듣는다.
- `find(board, id)` 는 문자열 id 만 찾는다. `stepSource(item)` 은 단계를 세는 쪽(`'details'`, `'next'`, 없으면 `null`)과 그 줄들을, `parseStep(line)` 은 `[번호, 끝냈는지]` 나 `null` 을, `progressOf(item)` 은 `[끝낸, 전체]` 나 `null` 을, `allLines(item)` 은 `details` 다음 `next` 순서의 빈 줄을 뺀 줄 객체를 돌려준다.
- `apply` 의 `step` 분기는 `lines.find(…)` 로 그 번호의 첫 줄을 고른다. `set` 분기는 항목이 없으면 새로 만든다.
- `main` 이 시작할 때 모든 항목에 `normalizeItem` 을 불러 `details`, `next` 를 `{text, done}` 객체 목록으로 바꿔 둔다.
- phase 01 뒤 `main` 은 쓰는 동작을 `withFileLock` 안에서 돌린다.

## 의도 메모

- 엄격 규칙을 `board.ts` 밖(orch 의 새 명령)에서 미리 읽어 검사하지 않는다. 잠금 밖의 판정이 되고 규칙이 두 곳에 생긴다.
- 줄 지문은 저장하지 않는다. 항목에 버전 칸을 더하면 보드 형식이 바뀐다.
- 지문에 끝냄 값도 넣는다. 통째 저장은 끝난 줄을 `✓` 로 넘겨, 그 사이 되돌린 줄을 다시 끝낸 것으로 덮기 때문이다.
- 결과 JSON 은 잠금 안에서 만든 값이다. 쓴 뒤 다시 읽어 만들지 않는다.

## 작업 항목

### 1. 옵션과 동작 이름

- `parse` 의 옵션에 `exact`(boolean), `if-rev`(string)를 더한다. `expand` 의 값 없는 옵션 목록에 `exact` 를 더한다. `Args` 에 `exact: boolean`, `ifRev?: string` 을 더한다.
- `COMMANDS` 끝에 `'view'` 를 더하고 `USAGE` 의 중괄호 목록 끝에도 더한다.
- `parse` 에서 사용법 오류(Error 를 던져 종료 코드 2)로 막는다: `--exact` 를 `set`, `step` 이 아닌 동작에 줬다, `--if-rev` 를 `set` 이 아닌 동작에 줬다.

### 2. 줄 지문 `linesRev`

```ts
export function linesRev(item: Record<string, unknown> | undefined): string
```

- `details` 와 `next` 를 각각 `normalizeLines` 로 맞춘다. 키가 없으면 빈 목록이다(`normalizeLines(undefined)` 는 빈 줄 하나를 돌려주므로 키가 있을 때만 부른다). 옛 문자열 줄과 객체 줄이 같은 글, 같은 끝냄 값이면 같은 지문이어야 한다.
- `JSON.stringify([details 의 [text, done] 목록, next 의 [text, done] 목록])` 을 `node:crypto` 의 sha1 로 줄인 16진 글의 앞 12 글자다.
- 항목이 `undefined` 면 두 목록이 빈 값의 지문이다.

### 3. 결과 JSON 과 `view`

항목 하나를 아래 꼴의 객체로 만드는 함수 `itemView(item, was, number?)` 를 둔다.

```json
{"id": "a", "status": "doing", "was": "doing", "progress": [1, 3], "rev": "9f2c41d07ab3", "number": 3, "lines": [{"number": 1, "done": true, "text": "1. 구현", "in": "details"}]}
```

- `status` 는 지금 상태, `was` 는 고치기 전 상태다(문자열이 아니면 `null`).
- `progress` 는 `progressOf(item)` 의 값 그대로(`[끝낸, 전체]` 나 `null`)다.
- `rev` 는 `linesRev(item)` 이다.
- `number` 는 받았을 때만 넣는다.
- `lines` 는 `details`, `next` 순서로 글이 빈 줄(공백뿐 포함)을 뺀 모든 줄이다. `in` 은 그 줄이 든 키다. `number` 는 그 줄이 `stepSource(item)` 이 고른 쪽에 있고 `parseStep` 이 번호를 읽을 때만 그 번호이고, 아니면 `null` 이다.
- 출력은 `JSON.stringify(값)` 한 줄과 줄바꿈이다.

`view <id>`: 보드를 고치지 않는다. 잠금을 잡지 않는다(`list`, `steps` 와 같은 길). 항목이 없으면 `Refused('항목이 없다: <id>')` 다. 있으면 `itemView(item, item.status)` 를 stdout 에 내고 0 이다.

쓰는 동작의 결과 출력: `apply` 가 지금은 「쓸 것이 있는가」 만 돌려준다. 결과 JSON 을 낼 동작은 낼 항목, 고치기 전 상태, 번호를 함께 돌려주게 바꾸고, `main` 이 `renameSync` 가 끝난 뒤(잠금 안)에 stdout 으로 낸다. 쓰기에 실패했거나 거절이면 내지 않는다. 결과 JSON 을 내는 호출은 이 phase 에서 `set --exact` 와 `step --exact` 다. `--exact` 가 없는 호출은 지금처럼 아무것도 내지 않는다.

### 4. `--exact`

- `set <id> … --exact`: 항목이 없으면 만들지 않고 `Refused('항목이 없다: <id>')` 다. 있으면 지금의 `set` 과 같다. 결과 JSON 을 낸다(`number` 없음).
- `step <id> <번호> [--undo] --exact`: 그 번호의 단계 줄을 아래 함수로 찾는다. 결과 JSON 에 `number` 를 넣는다. `--undo` 가 아니면 지금처럼 `closeDecided(item)` 을 부른다.

```ts
// 단계를 세는 쪽에서 그 번호의 줄을 찾는다. 없거나 둘 이상이면 Refused 다
function findStep(item: Item, id: string, number: number): { source: string; lines: Line[]; index: number }
```

  - 그 번호의 줄이 없으면 `` Refused(`${number} 번 단계가 없다. 있는 번호: ${있는 번호를 공백으로 이은 글}`) `` 다. 단계가 하나도 없으면 「있는 번호: 없음」 이다.
  - 둘 이상이면 `` Refused(`${number} 번 단계 줄이 둘 이상이다: ${id}`) `` 다.
- `--exact` 가 없는 `step` 은 지금 분기 그대로다(첫 줄을 고르고 지금 문구로 거절한다).

### 5. `--if-rev`

`set` 분기에서 항목을 찾은 직후, 아무것도 고치기 전에 본다.

- `a.ifRev` 가 있는데 항목이 없으면 `Refused('항목이 없다: <id>')` 다.
- `linesRev(item) !== a.ifRev` 면 `` Refused(`읽은 뒤 ${id} 의 줄이 바뀌어 저장하지 않았다. 다시 읽어 판정한다`) `` 다.
- 같으면 지금의 `set` 과 같다. `--exact` 가 없으면 아무것도 내지 않는다.

### 6. 파일 맨 위 설명과 `HELP`

「사용」 목록에 `--exact`, `--if-rev`, `view` 를 더하고 결과 JSON 의 칸을 적는다. `USAGE` 의 옵션 목록에 `[--exact] [--if-rev REV]` 를 더한다.

### 7. `extensions/work-board/tests/board-exact.spec.ts` 를 새로 만든다

`board-run.ts` 로 실행한다. 거절 사례마다 보드 파일의 바이트가 부르기 전과 같은지 본다.

- `set`: 없는 id 에 `set nope doing --exact` 는 종료 코드 1, stderr 「항목이 없다」, 보드 파일이 생기지 않거나 그대로다. 있는 항목에 `set a wait --exact` 는 종료 코드 0 이고 stdout 한 줄의 JSON 이 `id`, `status: "wait"`, `was`(앞 상태)를 갖는다. 단계 없는 항목에 `set a doing --exact` 는 종료 코드 1 이고 stderr 가 `--exact` 없는 호출의 stderr 와 같다. `--exact` 없는 `set nope wait` 는 지금처럼 항목을 만든다.
- `step`: 단계가 1~3번인 항목에 `step a 9 --exact` 는 종료 코드 1 이고 stderr 에 「9 번 단계가 없다. 있는 번호: 1 2 3」 이 있다. 같은 번호 줄이 둘인 항목에 `step a 2 --exact` 는 종료 코드 1 이다. 같은 항목에 `--exact` 없는 `step a 2` 는 지금처럼 종료 코드 0 이다. `step a 2 --exact` 의 JSON 은 `number: 2` 이고 그 줄의 `done` 이 참이다. `--undo --exact` 는 거짓으로 돌리고 `status` 가 그대로다.
- `decide`: 마지막 미완료 줄을 `step … --exact` 로 끝내면 JSON 이 `status: "done"`, `was: "decide"` 다.
- `view`: 단계 3개 중 1개를 끝낸 항목의 JSON 이 `progress: [1, 3]` 이고 `lines` 가 번호와 `done`, `in` 을 갖는다. 참고 줄의 `number` 는 `null` 이다. `progress` 필드가 `7/10` 이면 `[7, 10]` 이다. 단계도 `progress` 도 없으면 `null` 이다. 단계가 `next` 에만 있으면 그 줄의 `in` 이 `next` 이고 번호가 있다. 부른 뒤 보드 파일의 바이트가 같다. 없는 id 는 종료 코드 1 이다. `view` 는 새 잠금 파일이 있어도 종료 코드 0 이다.
- `linesRev`: import 해 부른 값이 `view` 의 `rev` 와 같다. 줄 글을 바꾸면 달라지고 `step` 으로 끝냄 값을 바꿔도 달라진다. 옛 문자열 줄(`'✓ 1. 구현'`)과 객체 줄(`{text: '1. 구현', done: true}`)의 지문이 같다.
- `--if-rev`: `view` 로 읽은 `rev` 를 주고 `set a --detail '1. 구현' --detail '2. 리뷰' --if-rev <rev>` 는 종료 코드 0 이다. 그 뒤 `detail-edit` 로 한 줄의 글을 바꾸고 처음의 `rev` 로 다시 통째 저장하면 종료 코드 1, stderr 「줄이 바뀌어」, 보드 파일 바이트가 같고 바꾼 글이 남아 있다. 없는 id 에 `--if-rev` 를 주면 종료 코드 1 이고 항목이 생기지 않는다.
- 사용법: `mark a 1 --exact` 와 `step a 1 --if-rev x` 는 종료 코드 2 다. `--s pr=1,merge=2` 와 `--o me` 가 지금처럼 `--stages`, `--owner` 로 듣는다(새 옵션이 줄임 꼴을 모호하게 만들지 않았다).

## 검증

```bash
node scripts/run-tests.ts extensions/work-board/tests/board-exact.spec.ts extensions/work-board/tests/board-lock.spec.ts extensions/work-board/tests/board.spec.ts
git diff --exit-code origin/main -- extensions/work-board/tests/board.spec.ts
node scripts/run-tests.ts --tsc-only
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/bin/board.ts` | 수정 (`--exact`, `--if-rev`, `view`, `linesRev`, 결과 JSON, 설명과 HELP) |
| `extensions/work-board/tests/board-exact.spec.ts` | 신규 |
