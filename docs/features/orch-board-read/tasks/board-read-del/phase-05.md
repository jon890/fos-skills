# Phase 05. 보드 안내 문서와 창의 「오늘 시작」 요청문을 새 명령으로 바꾼다

**Execution profile**: standard

## 목표

보드를 보고 지우는 안내가 플러그인 경로의 `board.ts list`, `board.ts del` 대신 `orch board list`, `orch board del` 을 가리킨다. 코디네이터가 문서나 창의 요청문을 따라가다 플러그인 경로를 찾는 일이 없게 하려는 것이다. 앞 phase 들의 코드가 이미 들어와 있어 문서가 말하는 명령이 모두 돈다.

**범위 외**: 스크립트 동작(`board.ts`, `board-edit.ts`, `commands.ts`)은 고치지 않는다. 공통 지시서 틀(`skills/orch/templates/spec-common.md`)의 worker 금지 문장은 그대로 둔다.

## 컨텍스트

**요구사항**: REQ1, REQ7. 스펙 「스펙이 머지되면 바꿀 곳」 과 설계 「문서와 요청문」 의 표가 고칠 자리다.

**근거 문서**: `docs/features/orch-board-read/spec.md`, `docs/features/orch-board-read/design.md`(「문서와 요청문」, 「실패와 일관성」)

- 앞 phase 가 만든 명령과 출력:
  - `orch board get <항목> <칸>`, `get <항목> step <번호>`: 값만 한 줄. 값이 없으면 stdout 이 비고 종료 코드 4, 없는 항목과 없는 단계는 1, 모르는 칸 이름은 2 다.
  - `orch board list [--status <상태>[,<상태>…]]`: 항목마다 `BOARD <항목> <상태> <끝낸>/<전체> <제목>`, 없으면 `BOARD-NONE`. `--full` 은 항목마다 줄과 안 풀린 `BOARD-UNMATCHED` 를 잇는다.
  - `orch board del <항목>`: `done` 항목만 지운다. 다른 상태는 `--force`. `orch board del --done` 은 `done` 항목을 모두 지운다. 출력은 `BOARD-DEL <항목>`, 지울 것이 없으면 `BOARD-NONE` 이다.
  - `show`, `list`, `get` 의 `--json`: 항목 객체(저장된 칸, 계산한 `progress`, `lines`), `show` 는 `unmatched` 를 더하고 `get` 은 `{"id", "field", "value"}` 다. 거절은 stdout 이 빈다.
- 지우는 호출은 `<보드 파일>.bak` 에 지우기 전 파일을 한 세대 남긴다. `board.ts set --detail`, `--next` 가 쓰는 파일과 같아 다음 통째 저장이나 지우기가 덮는다.
- `skills/orch/tests/docs-contract.spec.ts` 의 「보드 안내는 파일 직접 수정 대신…」 사례가 `board.md` 에 `board.ts set`, `board.ts mark`, `board.ts del` 이 있는지 본다. `del` 안내를 바꾸면 이 사례를 함께 고쳐야 한다.
- `extensions/work-board/tests/prompts.spec.ts` 가 `START_PROMPT` 에 `done 항목은 board.ts del 로 비워` 와 `board.ts del` 이 있는지 본다(두 사례).
- `extensions/work-board/README.md` 는 해요체다. 고치는 문장도 같은 말투로 쓴다. `skills/orch/references/board.md` 와 `extensions/work-board/references/behavior.md` 는 한다체다.
- 변경 조각의 형식은 저장소 `README.md` 「버전과 변경 이력」 이 정한다. `- ` 줄 1~5개, 줄마다 160자 이하다. `extensions/work-board/changes/` 폴더는 지금 없어 새로 생긴다.

## 의도 메모

- 받는 칸 이름을 `board.md` 에 다시 늘어놓지 않는다. 「`board.ts set` 의 칸 옵션 이름과 같고 `status` 와 `step <번호>` 를 더한다」 고 쓰고 목록은 `orch board get --help` 를 가리킨다. 칸이 늘 때 문서가 낡지 않는다.
- `board.ts` 직접 호출 안내는 없애지 않고 칸 고치기(`board.ts set`)와 `board.ts mark` 로 좁힌다. 이 둘은 `orch board` 에 대응하는 동작이 없다(스펙 범위 밖).
- 창의 요청문은 `orch board del --done` 을 쓴다. 요청문이 플러그인 경로를 찾게 만들던 자리다(설계 DECISION7).

## 작업 항목

### 1. `skills/orch/references/board.md`

- 맨 위 보드 파일 안내의 「보드 창과 `board.ts` 직접 호출은 orch 설정을 읽지 않는다 … 직접 명령에는 `--file` 로 같은 파일을 준다」 문장: 보기와 지우기는 `orch board` 가 맡는다고 적고, `--file` 을 주라는 안내를 `board.ts set`(칸 고치기)과 `board.ts mark` 로 좁힌다.
- 「**worker 는 보드를 고치지 않는다.**」 문장의 명령 목록에 `del` 을 더한다.
- 「상태와 단계 고치기」 첫 문장의 「항목을 지울 때는 `board.ts del` 을 쓴다」 를 「항목을 지울 때는 아래 `orch board del` 을 쓴다」 로 바꾼다. `board.ts set`, `board.ts mark` 안내는 남긴다.
- 같은 절의 명령 목록 코드 블록에 아래 줄을 더한다.

  ```text
  orch board get <항목> <칸> [--json]
  orch board get <항목> step <번호> [--json]
  orch board list [--status <상태>[,<상태>…]] [--json]
  orch board show <항목> [--json]
  orch board del <항목> [--force]
  orch board del --done
  ```

- 같은 절에 설명 문단을 더한다. 담을 내용:
  - `get`: 값만 한 줄이라 `b=$(orch board get <항목> branch)` 로 바로 담는다. 칸 이름의 규칙(위 의도 메모). `progress` 는 `show` 머리와 같은 `<끝낸>/<전체>`, `step <번호>` 는 저장된 줄 글 그대로(끝냄 표시 `✓` 는 없다), 제목 칸이 없는 항목의 `title` 은 id 다.
  - 종료 코드: 값이 없으면 stdout 이 비고 4 다. `set -e` 셸에서는 `if b=$(orch board get <항목> branch); then …` 이나 `|| true` 로 받는다.
  - `list`: 한 줄 꼴, `--status`(쉼표로 여럿, 다섯 상태 밖은 종료 코드 1), `BOARD-NONE`, `--full`.
  - `del`: `done` 만 지우고 다른 상태는 `--force`, `--done` 은 `done` 을 모두 지운다. 출력 `BOARD-DEL <항목>`. 묻지 않고 바로 지우므로 먼저 보려면 `orch board list --status done` 을 부른다. 지우기 전 파일이 `<보드 파일>.bak` 에 한 세대 남고 다음 통째 저장이나 지우기가 덮으므로 되살리려면 바로 꺼낸다. `--force` 로 진행 중 항목을 지우면 루프의 동기화가 같은 id 로 다시 만들 수 있다.
  - `--json`: 항목 객체의 꼴 한두 문장과 `show` 의 `unmatched`, `get` 의 `{"id", "field", "value"}`(빈 값은 `null`). 거절은 stdout 이 비고 stderr 에 이유가 나온다.
  - 읽기(`get`, `list`, `show`)는 보드 잠금을 잡지 않는다.
- 같은 절 끝의 성공 출력 문단에 `BOARD-DEL`, `BOARD-NONE` 과 종료 코드 4 를 더한다.

### 2. `extensions/work-board/README.md` 「보드에 항목 적기」

- 예시 코드 블록의 `node … "$BOARD_BIN" list` 줄을 `orch board list` 로 바꾼다(주석 「모든 항목과 진행률을 봐요」 는 남긴다). `orch board get order-api branch`(값 하나를 꺼내요)와 `orch board del --done`(끝난 항목을 비워요) 줄을 더한다. `BOARD_BIN` 을 쓰는 줄은 `set`(새 항목과 칸 고치기)만 남는다.
- 블록 위아래 문장에서 보기와 지우기도 `orch board` 로 한다고 맞춘다.

### 3. `extensions/work-board/references/behavior.md`

- 「보드 쓰기 잠금」 항목의 「`list`, `steps`, `view` 는 잠그지 않는다」 에 `get`, `item`, `items` 를 더한다.
- 「항목 읽기」 항목 아래에 항목을 더한다.
  - 칸 값 읽기: `get <id> <칸>`, `get <id> step <번호>` 의 JSON 과 종료 코드 4.
  - 항목 객체: `item <id>`, `items [<상태>[,<상태>…]]` 가 내는 키와 `view` 와의 차이(`was`, `rev` 가 없고 저장된 칸이 있다).
  - 엄격한 지우기: `del <id> --exact`, `del-done <id>`, `del-done` 의 거절과 결과 JSON, `.bak` 를 남기는 호출. 옵션 없는 `del <id>` 는 그대로(상태를 보지 않고 없는 id 도 종료 코드 0, `.bak` 없음)라고 적는다.

### 4. `extensions/work-board/hooks/register.js` 의 `START_PROMPT`

- 2번 문장의 `done 항목은 board.ts del 로 비워 줘` 를 `done 항목은 orch board del --done 으로 비워 줘` 로 바꾼다. 나머지 글은 그대로다.

### 5. 이 phase 를 검증하는 `extensions/work-board/tests/prompts.spec.ts` 와 `skills/orch/tests/docs-contract.spec.ts`

- `prompts.spec.ts`: 「오늘 시작 요청문은…」 사례의 고정 글 `done 항목은 board.ts del 로 비워` 를 `done 항목은 orch board del --done 으로 비워` 로 바꾼다. 「시작 요청은 직접 JSON 수정 대신 보드 명령을 안내한다」 사례의 `START_PROMPT.includes('board.ts del')` 을 `START_PROMPT.includes('orch board del --done')` 과 `!START_PROMPT.includes('board.ts del')` 로 바꾼다.
- `docs-contract.spec.ts` 의 「보드 안내는 파일 직접 수정 대신…」 사례: 명령 표와 `board.md` 를 함께 보는 동작 목록에 `get`, `list`, `del` 을 더한다. `board.ts` 쪽 목록은 `['set', 'mark']` 로 줄이고 `board.md` 에 `board.ts del` 이 없다는 단언을 더한다.

### 6. 변경 조각

- `skills/orch/changes/board-read-del.minor.md`: `orch board get`, `list`, `del` 과 `--json` 을 더했다는 `- ` 줄.
- `extensions/work-board/changes/board-read-del.minor.md`: `board.ts` 의 `get`, `item`, `items`, `del-done`, `del --exact` 와 「오늘 시작」 요청문이 `orch board del --done` 을 쓴다는 `- ` 줄.

### 7. PR 본문에 옮길 것

계획서는 이 PR 에서 지워지므로 아래를 PR 본문에 적는다.

- 머지 알림: 「보드 보기와 끝난 항목 지우기는 `orch board list`, `orch board del --done` 으로 한다. 플러그인 경로의 `board.ts list`, `board.ts del` 을 외워 부르던 세션은 새 명령으로 바꾼다」(스펙 「스펙이 머지되면 바꿀 곳」 마지막 행).
- 후속 후보: `--force` 로 지운 진행 중 항목을 루프의 동기화가 다시 만들 수 있는 틈(설계 DECISION9).

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/docs-contract.spec.ts extensions/work-board/tests/prompts.spec.ts
node scripts/check-skill-docs.ts
node export-only-skills/korean-check/scripts/check.ts skills/orch/references/board.md extensions/work-board/README.md extensions/work-board/references/behavior.md skills/orch/changes/board-read-del.minor.md extensions/work-board/changes/board-read-del.minor.md
grep -l "board.ts del" skills/orch/references/board.md extensions/work-board/README.md extensions/work-board/hooks/register.js | wc -l
grep -c "^orch board \(get\|list\|del\) " skills/orch/references/board.md
grep -c "BOARD_BIN\" list" extensions/work-board/README.md
claude plugin test .
orch slot heavy --exclusive -- node scripts/run-tests.ts
node skills/orch/tests/fixtures/golden-run.ts
node skills/orch/tests/fixtures/loop-order-run.ts
```

기대값:

- 앞 세 명령은 종료 코드 0 이다.
- `board.ts del` 이 남은 파일 수는 0 이다.
- `board.md` 에서 `orch board get`, `list`, `del` 로 시작하는 줄은 5 이상이다(명령 목록 코드 블록의 `get` 둘, `list` 하나, `del` 둘).
- `README.md` 의 `BOARD_BIN" list` 는 0 이다.
- `claude plugin test .` 와 전체 테스트는 종료 코드 0 이다. 전체 테스트는 저장소 오버레이(`.orch/overlay.md`)대로 600초를 넘기면 `--background` 로 띄우고 `--wait` 로 기다린다. `orch` 가 PATH 에 없으면 감싸지 않고 `node scripts/run-tests.ts` 를 부른다.
- 고정 입력 기록 두 명령은 종료 코드 0 이다(루프와 마무리의 출력이 그대로다).

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/references/board.md` | 수정 |
| `extensions/work-board/README.md` | 수정 |
| `extensions/work-board/references/behavior.md` | 수정 |
| `extensions/work-board/hooks/register.js` | 수정 |
| `extensions/work-board/tests/prompts.spec.ts` | 수정 |
| `skills/orch/tests/docs-contract.spec.ts` | 수정 |
| `skills/orch/changes/board-read-del.minor.md` | 신규 |
| `extensions/work-board/changes/board-read-del.minor.md` | 신규 |
