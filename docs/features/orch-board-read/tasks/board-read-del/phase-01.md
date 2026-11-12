# Phase 01. `board.ts` 에 읽기 동작 `get`, `item`, `items` 를 더한다

**Execution profile**: standard

## 목표

`extensions/work-board/bin/board.ts` 가 항목의 칸 값 하나(`get`), 항목 하나(`item`), 항목 목록(`items`)을 JSON 한 줄로 낸다. 뒤 phase 의 `orch board get`, `list`, `show --json` 이 이 출력을 받아 쓴다. 칸 값과 빈 값의 규칙을 `board.ts` 한 곳에 두려는 것이다.

**범위 외**: 지우기(`del --exact`, `del-done`)는 phase 02, `orch board` 쪽(`skills/orch/**`)은 phase 03 과 04, 문서(`README.md`, `references/*.md`)는 phase 05 가 맡는다. 이 phase 는 `skills/orch/` 아래를 고치지 않는다.

## 컨텍스트

**요구사항**: REQ2, REQ3, REQ4, REQ5(상태 필터), REQ9(JSON 의 꼴), REQ10(읽기는 잠그지 않는다), REQ12

**근거 문서**: `docs/features/orch-board-read/spec.md`, `docs/features/orch-board-read/design.md`(「`board.ts` 에 더하는 것」, 「항목 객체」)

- `board.ts` 는 명령 하나를 `parse`(인자 풀이, 실패하면 종료 코드 2) → `main`(읽기와 잠금) → `apply`(동작별 분기)로 처리한다. 읽기 동작은 `main` 의 `readonly` 목록(`list`, `steps`, `view`)에 들어 잠금과 폴더 만들기를 건너뛴다.
- 지금 `apply` 는 읽기 동작에서 `false` 를 돌려주고 `main` 은 `if (readonly) { apply(a, read()); return 0 }` 으로 끝낸다. 거절은 `throw new Refused(글)` 이고 `main` 이 stderr 한 줄과 종료 코드 1 로 바꾼다. `parse` 에서 던진 `Error` 는 사용법 줄과 함께 종료 코드 2 다.
- 위치 인자는 `parse` 가 `[cmd, id, status, text, condition]` 순서로 `Args` 에 담는다. 새 동작도 이 칸을 그대로 쓴다(`get` 은 `status` 가 칸 이름, `text` 가 단계 번호다. `items` 는 `id` 가 상태 목록이다).
- 재사용할 함수: `find`(문자열 id 만 맞춘다), `findStep`(없는 번호는 `N 번 단계가 없다. 있는 번호: …`, 같은 번호 둘은 거절), `progressOf`(`[끝낸, 전체]` 또는 `null`), `itemView`(`view` 의 JSON), `STATUSES`, `FIELDS`.
- **기존 테스트 파일은 고치지 않는다**(스펙 REQ12). `board.spec.ts` 가 고정한 것: 사용법 줄이 `사용법: board.ts {set,detail-edit,detail-add,` 로 시작한다, `show` 는 모르는 명령이다, `--p` 는 모호한 줄임 꼴이다. `board-exact.spec.ts` 는 `--s` 가 `--stages`, `--o` 가 `--owner` 로 듣는 것을 고정한다.
- **새 옵션을 더하지 않는다**(설계 DECISION1). `parse` 의 `options` 는 그대로 둔다.

## 의도 메모

- `get` 이 값만 내지 않고 JSON 을 내는 까닭: 감싸는 쪽이 `--json` 객체를 다시 만들지 않고, 빈 값(`null`)과 빈 문자열을 출력에서도 가릴 수 있다(설계 DECISION3).
- `view` 를 넓히지 않고 `item` 을 따로 둔다. `view` 의 꼴(`was`, `rev`)은 고치기 결과와 같고 문서가 계약으로 적었다(설계 DECISION5).
- 상태 필터를 `--status` 옵션으로 만들지 않는다. `--s` 가 모호해져 지금 듣는 호출이 사용법 오류로 바뀐다.
- 종료 코드 3 은 쓰지 않는다. `orch` 실행기가 설치본을 못 찾을 때 쓰는 값이다(스펙 DECISION6).

## 작업 항목

### 1. `extensions/work-board/bin/board.ts` 의 상수와 내보내는 값

- `COMMANDS` 끝에 `'get'`, `'item'`, `'items'` 를 더한다. `USAGE` 의 `{…}` 목록에도 끝에 붙인다(앞머리 `{set,detail-edit,detail-add,` 는 그대로).
- `export const GET_FIELDS = ['status', ...FIELDS, 'step'] as const` 를 둔다. `get` 이 받는 칸의 원본이다.
- 글로 바꾸는 작은 함수 하나를 둔다(이름 예: `fieldText(value: unknown): string | null`). 글이고 비어 있지 않으면 그 글, 숫자면 `String(값)`, 그 밖(없음, `null`, 빈 문자열, 객체, 배열, 불리언)은 `null` 이다.
- `export function itemTitle(item: Record<string, unknown>): string | null` 을 둔다. `'title' in item` 이 거짓일 때만 `String(item.id)` 이고, 키가 있으면 `fieldText(item.title)` 이다(빈 문자열은 `null`). 스펙 REQ3 이 id 로 대신하게 한 것은 제목 칸이 없는 옛 항목뿐이고, 빈 문자열은 REQ4 의 값 없음이다(설계 DECISION10). `fieldText(item.title) ?? String(item.id)` 로 쓰면 빈 제목이 id 가 되어 스펙과 달라진다.
- `itemView` 안의 `lines` 를 만드는 식을 함수(이름 예: `linesOf(item)`)로 빼 `itemView` 와 아래 `itemObject` 가 함께 쓴다. `itemView` 의 출력은 바이트까지 그대로여야 한다.
- 항목 객체를 만드는 함수(이름 예: `itemObject(item)`)를 둔다. `['id', 'title', 'status', 'owner', 'pr', 'merged-pr', 'branch', 'worktree', 'task', 'stages', 'stepAt']` 순서로 `key in item` 인 키만 저장된 값 그대로 담고, 끝에 `progress: progressOf(item)`, `lines: linesOf(item)` 을 붙인다. `was`, `rev`, `details`, `next` 와 저장된 `progress` 글은 담지 않는다.

### 2. 같은 파일의 `parse`

- 위치 인자 상한: `get` 은 4, `item` 과 `items` 는 2 다(지금 식은 `step-mark` 5, `detail-edit`·`step-edit` 4, 나머지 3 이다). 넘으면 지금처럼 `모르는 인자` 오류다.
- `get` 의 인자 꼴을 여기서 검사하고 틀리면 `Error` 를 던진다(종료 코드 2).
  - 칸 이름(`status` 자리)이 `GET_FIELDS` 에 없거나 빠졌다: 글에 `GET_FIELDS` 를 `, ` 로 이은 목록과 받은 이름을 넣는다. 예: `get 의 칸은 status, title, … step 중 하나다: foo`.
  - 칸이 `step` 인데 번호(`text` 자리)가 없거나 `/^\d+$/` 가 아니다.
  - 칸이 `step` 이 아닌데 번호를 줬다.
- `--exact`, `--if-rev`, `--event` 의 지금 검사는 그대로라 새 동작에 주면 사용법 오류다.

### 3. 같은 파일의 `apply` 와 `main`

- `apply` 의 반환 타입에 값 없음을 뜻하는 `'empty'` 를 더한다. `main` 의 읽기 분기를 `return apply(a, read()) === 'empty' ? 4 : 0` 으로 바꾸고 `readonly` 목록에 `get`, `item`, `items` 를 더한다.
- `items` 분기는 `list` 분기처럼 `if (!a.id) throw new Refused('id 가 필요하다')` 보다 앞에 둔다.
  - `a.id` 가 `undefined` 면 모든 항목, 아니면(빈 문자열 포함) 쉼표로 나눠 앞뒤 공백을 뗀 값들이다. `!a.id` 로 판정하면 `items ''` 가 모든 항목을 낸다. 값 가운데 `STATUSES` 에 없는 것(빈 값 포함)이 하나라도 있으면 `Refused` 다. 글은 `set` 의 `status 는 goal|decide|doing|wait|done 중 하나다` 뒤에 `: <받은 값>` 을 붙인다.
  - 보드 파일 순서를 지켜 `item.status` 가 그 값들에 든 항목만 남기고, `JSON.stringify(항목 객체 배열)` 한 줄을 stdout 에 쓴 뒤 `false` 를 돌려준다. 숫자 id 항목도 낸다.
- `item` 분기: `find` 로 찾고 없으면 `Refused('항목이 없다: <id>')`, 있으면 `JSON.stringify(itemObject(item))` 한 줄을 쓰고 `false` 다.
- `get` 분기: `find` 로 찾고 없으면 같은 거절이다.
  - 칸이 `step` 이면 `findStep(item, id, 번호)` 가 고른 줄의 `text` 가 값이다(거절은 `findStep` 것 그대로).
  - `title` 은 `itemTitle(item)`, `progress` 는 `progressOf` 가 `null` 이 아니면 `` `${끝낸}/${전체}` ``, 나머지 칸은 `fieldText(item[칸])` 이다.
  - `{"id": <항목의 id>, "field": <칸>, "value": <글 또는 null>}` 을 `JSON.stringify` 로 한 줄 쓴다. `step` 이면 `field` 뒤에 `"number": <번호(숫자)>` 를 넣는다.
  - 값이 `null` 이면 `'empty'`, 아니면 `false` 를 돌려준다.

### 4. 같은 파일의 머리 주석과 `HELP`

- 사용 목록에 세 동작과 한 줄 설명을 더한다. `get <id> <칸>`, `get <id> step <번호>`(JSON `{"id", "field", "value"}`, 빈 값은 `null` 과 종료 코드 4), `item <id>`(항목 객체), `items [<상태>[,<상태>…]]`(항목 객체 배열).
- 「list, steps, view 는 잠그지 않는다」 는 두 자리(머리 주석, `HELP` 둘째 줄)에 새 동작을 더한다.
- 종료 코드 줄에 `4 get 의 값이 비었다` 를 더한다.

### 5. 이 phase 를 검증하는 `extensions/work-board/tests/board-read.spec.ts`(신규)

`extensions/work-board/tests/board-run.ts` 의 `run`, `tempBoard`, `write` 를 쓴다(`board-exact.spec.ts` 가 같은 방식이다). 거절과 사용법 오류는 stdout 이 빈 문자열인지와 보드 파일 바이트가 그대로인지를 함께 본다.

- `get` 의 값: `branch`(글 그대로), `pr`(숫자 `555` 는 `"555"`, 글 `492, 495` 는 그대로), `merged-pr`, `status`, `owner`, `worktree`, `task`, `stages`, `title`(있을 때, 키가 없어 id 가 나올 때), `progress`(단계 줄로 센 값, 저장된 `progress: '7/8'` 이 앞서는 값).
- `get … step`: `2. [ask] 머지 (#70 merge)` 가 표시와 꼬리표째 나온다. 끝난 줄(`done: true`, 옛 문자열 `✓ 1. 구현`)의 값에 `✓` 가 없다. `number` 가 숫자다. 단계가 `next` 에만 있는 항목에도 듣는다.
- 빈 값: 칸이 없는 항목, 빈 문자열 칸, 단계도 `progress` 도 없는 항목의 `progress` 가 종료 코드 4 이고 stdout 의 `value` 가 `null` 이다. `title: ''` 인 항목의 `get … title` 도 종료 코드 4 와 `null` 이다(id 를 내지 않는다. 설계 DECISION10).
- 거절(종료 코드 1): 없는 id(`항목이 없다`), 숫자 id 항목을 문자열로 부른 경우, `step 9`(stderr 에 `있는 번호: 1 2`), 같은 번호 줄이 둘인 항목.
- 사용법 오류(종료 코드 2, stderr 가 `사용법: board.ts` 로 시작): `get a foo`(stderr 에 `GET_FIELDS` 의 이름이 모두 있다), `get a`, `get a branch 3`, `get a step`, `get a step x`, `item a b`, `items doing x`, `get a branch --exact`.
- `GET_FIELDS` 가 스펙 REQ2 의 이름(`status`, `title`, `owner`, `pr`, `merged-pr`, `branch`, `worktree`, `task`, `stages`, `progress`, `step`)을 모두 담는다. 개수는 단언하지 않는다.
- `item`: 키 순서와 값, `pr` 이 숫자로 남는다, 없는 칸의 키가 없다(`title` 포함), `title: ''` 은 빈 문자열 그대로 든다, `was`·`rev`·`details`·`next` 키가 없다, 진행률 없는 항목은 `progress` 가 `null` 이다, `lines` 가 같은 항목의 `view` 출력의 `lines` 와 같다. 없는 id 는 종료 코드 1 이다.
- `items`: 인자 없이 모든 항목(숫자 id 항목 포함, 파일 순서), `done`, `doing,wait`, 결과 없는 상태는 `[]`, `foo`, `doing,`, 빈 문자열 인자(`''`)는 종료 코드 1 이고 stderr 에 허용 값이 있다. 보드 파일이 없으면 `[]` 와 종료 코드 0 이고 파일과 그 폴더가 생기지 않는다.
- 잠금: `<보드 파일>.lock` 을 미리 만들어 둔 채 `get`, `item`, `items` 가 종료 코드 0(빈 값이면 4)이다. 읽기 뒤 보드 파일 바이트가 그대로다.

## 검증

```bash
node scripts/run-tests.ts extensions/work-board/tests/board-read.spec.ts extensions/work-board/tests/board.spec.ts extensions/work-board/tests/board-exact.spec.ts extensions/work-board/tests/board-step-edit.spec.ts extensions/work-board/tests/board-step-mark.spec.ts extensions/work-board/tests/board-lock.spec.ts
node scripts/run-tests.ts --tsc-only
git diff --quiet "$(git merge-base origin/main HEAD)" -- extensions/work-board/tests/board.spec.ts extensions/work-board/tests/board-exact.spec.ts extensions/work-board/tests/board-step-edit.spec.ts extensions/work-board/tests/board-step-mark.spec.ts extensions/work-board/tests/board-lock.spec.ts extensions/work-board/tests/board-run.ts
git diff --name-only HEAD -- skills/orch | wc -l
```

기대값: 앞 세 명령은 종료 코드 0 이다. 셋째는 이 브랜치가 main 에서 갈라진 뒤로 기존 테스트 파일이 그대로라는 뜻이다(움직이는 `origin/main` 이 아니라 갈라진 커밋과 비교한다). 마지막 명령은 0 이다(이 phase 가 `skills/orch/` 를 고치지 않았다).

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/bin/board.ts` | 수정 |
| `extensions/work-board/tests/board-read.spec.ts` | 신규 |
