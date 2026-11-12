# Phase 02. `board.ts` 에 엄격한 지우기 `del --exact`, `del-done` 을 더한다

**Execution profile**: standard

## 목표

`extensions/work-board/bin/board.ts` 가 없는 항목을 거절하는 지우기(`del <id> --exact`), `done` 항목만 지우는 지우기(`del-done <id>`), `done` 항목을 모두 지우는 지우기(`del-done`)를 갖는다. 셋 다 잠금 안에서 판정하고, 저장이 확정된 뒤에 지우기 전 파일을 `.bak` 에 남기고, 지운 id 를 JSON 으로 낸다. 진행 중 항목을 id 오타로 지우지 않게 하려는 것이다.

**범위 외**: 옵션 없는 `del <id>` 의 동작은 바꾸지 않는다. `orch board del` 은 phase 04, 문서는 phase 05 가 맡는다. 이 phase 는 `skills/orch/` 아래를 고치지 않는다.

## 컨텍스트

**요구사항**: REQ6, REQ7, REQ8, REQ10(지우기의 잠금), REQ12

**근거 문서**: `docs/features/orch-board-read/spec.md`, `docs/features/orch-board-read/design.md`(「`board.ts` 에 더하는 것」, 「실패와 일관성」), `docs/adr/029-board-write-lock.md`

- 지금 `del` 분기는 `board.items = board.items.filter((item) => item.id !== id)` 뒤 `true` 를 돌려준다. 상태를 보지 않고, 없는 id 여도 저장하고 종료 코드 0 이다. **이 분기는 `--exact` 가 없을 때 그대로 둔다.**
- 쓰기 동작은 `main` 이 `withFileLock` 안에서 `read()` → `apply` → 저장 순서로 돈다. `apply` 가 `false` 를 돌려주면 저장하지 않고 종료 코드 0 이고, 객체를 돌려주면 저장한 뒤 그 객체를 `JSON.stringify` 한 줄로 stdout 에 쓴다. `true` 는 저장만 한다.
- `.bak` 는 지금 `a.cmd === 'set' && (a.detail !== undefined || a.next !== undefined) && existsSync(path)` 일 때 `saveBoard` 직전에 `copyFileSync(path, `${path}.bak`)` 로 남긴다. 잠금 안이다.
- `saveBoard(path, board, lock)` 는 임시 파일(`${path}.${process.pid}.tmp`)에 쓰고, `lock.held()` 가 거짓이면 `false` 를 돌려주고, 참이면 `renameSync` 로 바꾼 뒤 `true` 를 돌려준다. `finally` 에서 임시 파일을 지운다. 그래서 지금은 잠금을 잃은 호출이 저장하지 않으면서도 `.bak` 를 이미 덮는다. **스펙 REQ8 은 거절한 호출이 `.bak` 를 바꾸지 않는다고 정했으므로 이 순서를 고친다**(설계 「저장 순서」).
- `board-lock.spec.ts` 가 `saveBoard(file, 값, { held: () => false })` 와 `{ held: () => true }` 를 세 인자로 직접 부르고, 저장 뒤 폴더에 `.tmp` 로 끝나는 파일이 없는 것을 고정한다. 이 파일은 고치지 않는다.
- `main` 은 쓰기 동작에서 보드 폴더를 먼저 만들고(`mkdirSync`), 저장하지 않고 끝나면 `finally` 에서 그 폴더를 다시 지운다. 지울 것 없는 `del-done` 이 없는 보드 파일의 폴더를 남기지 않는 것은 이 동작이 맡는다.
- `--exact` 는 지금 `parse` 가 `set`, `step` 밖에서 사용법 오류로 막는다. `del <id> --exact` 는 지금 종료 코드 2 라 뜻을 주어도 듣던 호출이 바뀌지 않는다.
- `find` 는 문자열 id 만 맞춘다. 숫자 id 항목은 `del --exact` 와 `del-done <id>` 에서 「항목이 없다」 다. id 를 받지 않는 `del-done` 은 상태만 보고 숫자 id 항목도 지운다(스펙 DECISION16).
- 기존 테스트 파일은 고치지 않는다(스펙 REQ12).

## 의도 메모

- `del` 의 셋째 위치 인자에 뜻(`force` 따위)을 주지 않는다. 지금 `del <id> <남는 글>` 이 지우고 0 으로 끝나 듣던 호출이 바뀐다(설계 「설계 단계 실측」).
- `--force` 옵션을 `board.ts` 에 더하지 않는다. `--f` 가 `--file` 의 줄임 꼴로 듣는다(설계 DECISION1).
- 거절 글이 `orch board del <id> --force` 를 가리키는 것은 뜻한 것이다. `del-done` 은 `orch board del` 이 부르려고 둔 동작이고, 감싸는 쪽이 stderr 글을 읽어 안내를 붙이지 않게 하려는 것이다(설계 DECISION4).
- 지운 것이 없는 `del-done` 이 보드를 다시 저장하면 `updatedAt` 이 바뀌어 보드 창이 바뀐 것처럼 보인다(스펙 DECISION17). 그래서 `false` 를 돌려준다.

## 작업 항목

### 1. `extensions/work-board/bin/board.ts` 의 `parse` 와 상수

- `COMMANDS` 와 `USAGE` 의 `{…}` 목록 끝에 `'del-done'` 을 더한다.
- `--exact` 를 받는 동작에 `del` 을 더하고 오류 글을 `--exact 는 set, step, del 에만 쓴다` 로 고친다.
- `del-done` 의 위치 인자 상한은 2 다(`del-done <id> <남는 글>` 은 사용법 오류). `del` 의 상한은 `--exact` 가 있을 때만 2 로 줄이고, 없으면 지금(3) 그대로 둔다. 엄격한 길이 `del <id> <남는 글> --exact` 를 받아 지우지 않게 하려는 것이다.

### 2. 같은 파일의 `apply`

- 반환 타입에 `{ deleted: unknown[] }` 를 더한다.
- `del-done` 인데 `a.id === undefined` 인 분기를 `if (!a.id) throw new Refused('id 가 필요하다')` 보다 앞에 둔다. **`!a.id` 로 판정하지 않는다.** 빈 문자열 id(`del-done ''`)가 이 분기로 들어가면 항목 하나를 지우려던 호출이 `done` 항목을 모두 지운다. 빈 문자열은 그 아래의 지금 검사(`id 가 필요하다`, 종료 코드 1)로 떨어져야 한다.
  - `item.status === 'done'` 인 항목을 보드 파일 순서로 모은다.
  - 하나도 없으면 `{"deleted": []}` 를 `JSON.stringify` 로 한 줄 stdout 에 쓰고 `false` 를 돌려준다(저장하지 않는다).
  - 있으면 `board.items` 에서 빼고 `{ deleted: [지운 항목의 id(저장된 값 그대로)…] }` 를 돌려준다.
- `del-done <id>` 분기: `find` 로 찾고 없으면 `Refused('항목이 없다: <id>')`. `item.status !== 'done'` 이면 `Refused` 이고 글은 `done 이 아닌 항목은 지우지 않는다: <id> (지금 <상태>). 상태와 상관없이 지우려면 orch board del <id> --force 를 쓴다` 다(상태 칸이 글이 아니면 `<상태>` 자리에 `없음`). 통과하면 그 항목 객체 하나만 빼고(`row !== item`) `{ deleted: [item.id] }` 를 돌려준다.
- `del` 분기에서 `a.exact` 면: `find` 로 찾고 없으면 `Refused('항목이 없다: <id>')`, 있으면 그 항목 하나만 빼고 `{ deleted: [item.id] }` 를 돌려준다. `a.exact` 가 아니면 지금 코드 그대로다.

### 3. 같은 파일의 `main`

- `.bak` 조건에 「`apply` 가 `deleted` 를 가진 객체를 돌려줬다」 를 더한다.
- `main` 의 `copyFileSync(path, `${path}.bak`)` 줄을 없애고 사본 만들기를 `saveBoard` 안으로 옮긴다. `saveBoard` 에 넷째 인자(이름 예: `backup = false`)를 더하고 `main` 은 위 조건의 참거짓을 넘긴다. `saveBoard` 의 순서는 아래와 같다(설계 「저장 순서」).
  1. 새 보드를 임시 파일에 쓴다(지금 코드).
  2. `lock.held()` 가 거짓이면 `false` 를 돌려준다(지금 코드). 이때 `.bak` 는 건드리지 않았다.
  3. `backup` 이 참이고 `existsSync(path)` 면 지금 보드 파일을 사본용 임시 파일(이름 예: `${path}.bak.${process.pid}.tmp`)로 복사한다.
  4. 새 보드의 임시 파일을 `path` 로 `renameSync` 한다.
  5. 사본용 임시 파일을 `${path}.bak` 로 `renameSync` 한다.
  6. `finally` 에서 두 임시 파일을 지운다(없으면 넘어간다. 지금 코드의 `ENOENT` 처리와 같다).
- 세 인자 호출(`backup` 없음)은 지금과 결과가 같아야 한다. `set --detail`, `set --next` 도 이 순서를 지나며 성공한 호출의 `.bak` 내용은 지금과 같다.
- 결과 객체를 stdout 에 쓰는 지금 줄(`if (typeof result === 'object')`)이 `deleted` 객체도 쓴다. 따로 쓰지 않는다.

### 4. 같은 파일의 머리 주석과 `HELP`

- 사용 목록에 `del <id> --exact`(있는 항목만 지운다), `del-done <id>`(`done` 일 때만 지운다), `del-done`(`done` 항목을 모두 지운다)과 결과 JSON `{"deleted": [id…]}` 를 더한다.
- `.bak` 를 남기는 호출 설명(지금은 `--detail`, `--next`)에 엄격한 지우기를 더한다. 옵션 없는 `del` 은 남기지 않는다고 적는다.
- `del-done` 의 거절 글을 만드는 줄 위에 주석 한 줄을 둔다: 이 글은 `orch board del` 의 옵션 이름 `--force` 를 가리키므로 orch 가 그 이름을 바꾸면 함께 고친다(설계 DECISION4).
- `--exact` 설명(「set, step --exact」)에 `del` 을 더한다.

### 5. 이 phase 를 검증하는 `extensions/work-board/tests/board-del.spec.ts`(신규)

`extensions/work-board/tests/board-run.ts` 의 `run`, `runAsync`, `tempBoard`, `write`, `item` 을 쓴다. 거절한 호출은 stdout 이 비었는지, 보드 파일 바이트가 그대로인지, `.bak` 가 생기지 않았는지(미리 둔 `.bak` 는 내용이 그대로인지)를 함께 본다.

- `del-done a`(`done` 항목): 종료 코드 0, stdout 이 `{"deleted":["a"]}`, 그 항목만 사라지고 다른 항목이 남는다. `.bak` 가 지우기 전 보드 바이트와 같다. 저장 꼴이 `JSON.stringify(값, null, 1)` 과 같다.
- `del-done a`(`doing` 항목): 종료 코드 1, stderr 에 `지금 doing` 과 `--force` 가 있다.
- `del-done nope`, 숫자 id 항목을 `del-done 7` 로 부른 경우: 종료 코드 1 과 `항목이 없다`.
- `del a --exact`(`doing` 항목): 지우고 `{"deleted":["a"]}` 와 `.bak` 를 남긴다. `del nope --exact` 는 종료 코드 1 이다.
- 옵션 없는 `del nope`: 종료 코드 0, stdout 이 비고 `.bak` 가 생기지 않는다(지금 동작 그대로).
- `del-done`(id 없음): `done` 둘(하나는 숫자 id `7`)과 `doing` 하나인 보드에서 stdout 이 `{"deleted":["b",7]}`(파일 순서)이고 `doing` 항목만 남는다. `.bak` 가 지우기 전 바이트와 같다.
- 빈 문자열 id: `done` 항목이 있는 보드에서 `del-done ''` 과 `del '' --exact` 가 종료 코드 1 이고 stdout 이 비고 보드 바이트가 그대로다(`board-run.ts` 의 `run(file, ['del-done', ''])`).
- 지울 것 없는 `del-done`: stdout 이 `{"deleted":[]}`, 종료 코드 0, 보드 파일의 바이트와 수정 시각(`statSync(파일).mtimeMs`)이 그대로이고 `.bak` 가 그대로다. 보드 파일이 없는 경로(`join(t.dir, 'none', 'board.json')`)에서는 파일과 폴더가 생기지 않는다.
- 사용법 오류(종료 코드 2): `del-done a b`, `del-done a --exact`, `item a --exact`, `del a 남는글 --exact`(보드 바이트가 그대로다). 옵션 없는 `del a 남는글` 은 지금처럼 종료 코드 0 으로 지운다.
- 잠금 안의 상태 확인(스펙 REQ10): `board-lock.spec.ts` 의 첫 사례와 같은 방식이다. `<보드 파일>.lock` 을 만들어 두고 `runAsync(file, ['del-done', 'a'], { BOARD_LOCK_WAIT_MS: '3000' })` 을 띄운 뒤, 1초 뒤 보드를 `a` 가 `doing` 인 내용으로 다시 쓰고 잠금 파일을 지운다. 결과가 종료 코드 1 이고 `a` 가 남아 있다.
- 잠금 실패: 잠금 파일을 둔 채 `BOARD_LOCK_WAIT_MS: '20'` 으로 `del-done` 을 부르면 종료 코드 1 이고 보드와 미리 둔 `.bak` 가 그대로다.
- 잠금을 잃은 저장(스펙 REQ8): `board-lock.spec.ts` 의 「잠금을 잃으면 쓰지 않고 임시 파일을 정리한다」 처럼 `saveBoard` 를 `import` 해 직접 부른다. 보드 파일과 내용이 다른 `.bak` 를 미리 두고 `saveBoard(file, { items: [] }, { held: () => false }, true)` 를 부르면 `false` 이고, 보드와 `.bak` 의 바이트가 그대로이고, 폴더에 `.tmp` 로 끝나는 파일이 없다. 이어 `{ held: () => true }` 로 부르면 `true` 이고 `.bak` 가 저장 전 보드 바이트와 같고 `.tmp` 파일이 없다. 넷째 인자를 주지 않으면 `.bak` 가 바뀌지 않는다.
- 통째 저장의 `.bak`: `set a --detail '1. 새 줄'` 뒤 `.bak` 가 저장 전 보드 바이트와 같다(순서를 바꾼 뒤에도 기존 동작이 같은지 새 파일에서도 한 번 본다. 기존 `board.spec.ts` 의 `.bak` 사례는 그대로 통과해야 한다).

## 검증

```bash
node scripts/run-tests.ts extensions/work-board/tests/board-del.spec.ts extensions/work-board/tests/board-read.spec.ts extensions/work-board/tests/board.spec.ts extensions/work-board/tests/board-exact.spec.ts extensions/work-board/tests/board-step-edit.spec.ts extensions/work-board/tests/board-step-mark.spec.ts extensions/work-board/tests/board-lock.spec.ts
node scripts/run-tests.ts --tsc-only
git diff --quiet "$(git merge-base origin/main HEAD)" -- extensions/work-board/tests/board.spec.ts extensions/work-board/tests/board-exact.spec.ts extensions/work-board/tests/board-step-edit.spec.ts extensions/work-board/tests/board-step-mark.spec.ts extensions/work-board/tests/board-lock.spec.ts extensions/work-board/tests/board-run.ts
git diff --name-only HEAD -- skills/orch | wc -l
```

기대값: 앞 세 명령은 종료 코드 0 이다. 셋째는 이 브랜치가 main 에서 갈라진 뒤로 기존 테스트 파일이 그대로라는 뜻이다(움직이는 `origin/main` 이 아니라 갈라진 커밋과 비교한다). 마지막 명령은 0 이다(이 phase 가 `skills/orch/` 를 고치지 않았다).

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/bin/board.ts` | 수정 |
| `extensions/work-board/tests/board-del.spec.ts` | 신규 |
