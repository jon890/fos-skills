# Phase 03. worker 를 띄울 때 업무 번호와 주소를 저장한다

**Execution profile**: standard

## 목표

worker 를 띄울 때 지시서의 업무 연결 줄에서 번호(와 같은 줄의 업무 주소)를 읽어 보드 항목의 빈 칸에만 저장한다. 새 항목 제목에는 번호를 붙이지 않고, 같은 업무의 기존 항목은 번호 칸으로 먼저 찾는다.

**범위 외**: PR 연결 때 채우기(phase 04), 주소 만들기(phase 05).

## 컨텍스트

**요구사항**: REQ4, REQ7(띄울 때 몫), REQ8(문서 몫), REQ9

**근거 문서**: `docs/features/board-task-link/spec.md` REQ4·REQ9·DECISION5·DECISION11·DECISION17·DECISION18·DECISION21, `docs/features/board-task-link/design.md` 「띄울 때(`registerBoard`)」

- `skills/orch/scripts/lib/board.ts` 의 `registerBoardOnce` 가 네 길을 다룬다. 중간 과정 줄(`interim`, `write(['set', found[0].id, …, '--if-rev', …])`), 다시 열기(`item && ((explicit && item.status === 'done') || nextPr)`), 기존 항목(`if (item)`), 새 항목(마지막 `args`)이다. `--if-rev` 거절은 `registerBoard` 가 한 번 다시 돈다.
- `taskOf(text, pattern)` 는 `{ number, title }` 을 낸다. `pattern` 은 `boardSettings(repo).taskLine` 이고 없으면 `DEFAULT_TASK_LINE`(`core/milestones.ts` 44행)이다. 정규식은 `m`·`u` 플래그이고 `exec` 의 `index` 로 맞은 자리를 알 수 있다.
- 같은 업무 찾기는 `same` 의 둘째 갈래 `open.find((row) => !['decide', 'goal'].includes(...) && hasTask(row.title, task.number))` 다.
- `specTitle` 의 끝 줄이 번호를 제목 앞에 붙인다.
- 어댑터는 phase 01 의 `taskAdapter(repo)`(`lib/task-adapters.ts`), `normalizeRef`·`urlFromLine`(`core/task-adapters.ts`)이다. 보드 명령의 `--fill`, `--task-ref` 는 phase 02 에서 생겼다.
- 테스트는 `skills/orch/tests/launch-worker.spec.ts` 의 「업무 연결 줄만 있으면 그 줄의 제목 앞에 업무 번호를 붙인다」, 「같은 업무 번호의 끝나지 않은 항목은 …」, 「업무 번호도 제목 줄도 …」(1730-1790행 근처)가 지금 동작을 본다.

## 의도 메모

- 띄울 때는 업무 도구를 부르지 않는다(스펙 DECISION5). 주소는 지시서 줄에 있을 때만 쓴다.
- 설정 `board.task` 를 읽지 못하면 어댑터 없음으로 보고 stderr 에 한 줄 남긴다(설계 DECISION6). 보드 등록을 멈추지 않는다.

## 작업 항목

### 1. `skills/orch/scripts/lib/board.ts`

- `SpecTask` 에 `line: string` 을 더한다. `taskOf` 는 `number` 묶음이 든 줄 전체를 `line` 에 담는다. 정규식에 `d` 플래그를 더한 사본(`new RegExp(p.source, p.flags + 'd')`)의 `indices.groups.number[0]` 위치에서 앞뒤 줄바꿈까지 자른다. `exec().index` 로 자르면 안 된다. 기본 정규식의 `^\s*` 가 앞 빈 줄의 줄바꿈까지 먹어 빈 줄을 고른다. 주석을 고친다.
- `registerBoardOnce` 에서 `task` 가 있으면 어댑터를 한 번 읽는다(`try { taskAdapter(repo) } catch (ConfigError) { process.stderr.write('보드: 설정 board.task 를 읽지 못해 업무 번호를 맞추지 않는다: <이유>\n'); null }`). `ref = normalizeRef(adapter, task.number)`, `url = urlFromLine(adapter, task.line)`, `taskArgs = ['--fill', '--task-ref', ref, ...(url ? ['--task', url] : [])]`. `ref` 에 공백이 있으면(사용자 정의 `task_line`) `taskArgs` 를 비우고 stderr 에 한 줄 남긴다. 보드 명령이 거절해 등록 전체가 실패하지 않게 한다.
- 네 길의 `write` 인자 끝(`--if-rev` 앞)에 `taskArgs` 를 붙인다. `task` 가 없으면 빈 목록이다.
- 같은 업무 찾기를 둘로 나눈다. 먼저 `row['task-ref'] === ref`, 없으면 `!row['task-ref'] && hasTask(row.title, task.number)`. 둘 다 decide·goal 은 보지 않는다. 함수 위 주석 3번 줄을 고친다.
- `specTitle` 의 마지막 줄을 `return title` 로 바꾸고, 「업무 번호가 있고 제목에 아직 없으면 앞에 붙인다」 주석을 지운다. `task` 인자는 제목 고르기(3번)에만 쓴다.

### 2. `skills/orch/tests/launch-worker.spec.ts`

- 「업무 연결 줄만 있으면 그 줄의 제목 앞에 업무 번호를 붙인다」(1736행 근처)를 「업무 연결 줄의 제목을 쓰고 번호는 번호 칸에 둔다」 로 바꾼다. 제목에 번호가 없고 `task-ref` 가 번호다.
- 「board.task_line 정규식이 업무 연결 줄의 꼴을 바꾼다」(1742-1748행)의 기대 제목 `#12 이슈 고치기` 를 `이슈 고치기` 로 바꾸고 `task-ref` 가 `#12` 인지 본다.
- 더할 사례:
  - `두레이 업무: P/458 https://x.dooray.com/project/tasks/9 「제목」` 과 본문의 `https://x.dooray.com/wiki/1`, 설정 `board.task` 가 `dooray`(`web_url` `https://x.dooray.com`, project `P`)인 저장소: 새 항목의 `task` 가 `.../project/tasks/9` 이고 위키 주소가 아니다. `DOORAY_BIN` 을 부르면 기록 파일에 한 줄 쓰는 가짜로 가리키고, 띄운 뒤 그 기록 파일이 없거나 비었는지 본다.
  - 업무 연결 줄 앞에 빈 줄이 있는 지시서와 `- 두레이 업무: …` 목록 꼴 지시서에서도 같은 줄의 주소가 저장된다.
  - 설정이 없는 저장소: `task-ref` 만 들어가고 `task` 는 없다(DECISION17·19).
  - 이미 `task-ref` 가 `P/1` 이고 `task` 가 있는 기존 항목에 `P/458` 지시서를 같은 워크트리로 띄우면 두 칸이 그대로다(REQ7). `task` 만 있는 기존 항목도 `task-ref` 가 비어 있는 채로 남는다.
  - 다시 열기 길(`보드 항목 id:` 가 done 항목)과 중간 과정 길(`중간 과정: PR #N`)에서도 빈 번호 칸이 채워진다.
  - 같은 업무 찾기: 제목에 번호가 없고 `task-ref` 가 `P/458` 인 열린 항목을 다른 워크트리 지시서가 이어 쓴다. `task-ref` 가 다른 번호(`P/1`)이고 제목에 `P/458` 이 든 항목은 이어 쓰지 않는다. 번호 칸이 빈 옛 항목은 지금처럼 제목으로 찾는다.
  - 틀린 `board.task`(모르는 어댑터)에서도 항목이 만들어지고 stderr 에 한 줄이 있다.

### 3. 문서

- `skills/orch/references/board.md` 176행(「worker 를 띄운 뒤」 행)에 「업무 연결 줄의 번호를 `task-ref` 에, 같은 줄에서 어댑터 호스트와 같은 첫 주소를 `task` 에 빈 칸일 때만 넣는다. 새 항목 제목에는 번호를 붙이지 않는다. 같은 업무는 번호 칸으로 먼저 찾는다」 를 더한다.
- `docs/data-schema.md` 의 `board` `task_line` 행에서 「번호는 보드 항목 제목 앞에 붙고」 를 「번호는 보드 항목의 업무 번호 칸(`task-ref`)에 들어가고」 로 고친다.
- `skills/orch/references/spec-writing.md` 14행은 제목 순서의 원본(`specTitle`)만 가리켜 고치지 않는다.

### 4. 변경 이력 조각

`skills/orch/changes/board-task-link.minor.md` 에 「worker 를 띄울 때 업무 번호를 보드 항목 제목 앞에 붙이지 않고 업무 번호 칸에 저장한다. 같은 업무 항목은 번호 칸으로 먼저 찾는다」 줄을 더한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/launch-worker-functions.spec.ts skills/orch/tests/lib-board.spec.ts skills/orch/tests/spec-lint.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/board.ts` | 수정 (taskOf 의 line, 네 길의 번호·주소, 같은 업무 찾기, specTitle) |
| `skills/orch/tests/launch-worker.spec.ts` | 수정 |
| `skills/orch/references/board.md` | 수정 |
| `docs/data-schema.md` | 수정 (`task_line` 행) |
| `skills/orch/changes/board-task-link.minor.md` | 수정 |
