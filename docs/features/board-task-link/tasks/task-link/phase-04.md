# Phase 04. PR 이 항목에 붙을 때 PR 제목의 업무 번호를 저장한다

**Execution profile**: standard

## 목표

상주 루프의 보드 맞추기와 worker 완료 확인이 PR 을 항목에 붙일 때, PR 제목에서 `finish.task_pattern` 으로 읽은 업무 번호를 빈 번호 칸에만 저장한다.

**범위 외**: 주소 만들기(phase 05). 사람이 직접 넣는 `board.ts set --pr` 은 번호를 채우지 않는다(스펙 DECISION6).

## 컨텍스트

**요구사항**: REQ5, REQ7(PR 연결 몫), REQ8(문서 몫)

**근거 문서**: `docs/features/board-task-link/spec.md` REQ5·DECISION6·DECISION11·DECISION16, `docs/features/board-task-link/design.md` 「PR 연결 때」, 설계 DECISION5

- 보드 맞추기 `skills/orch/scripts/board/board-sync.ts`: PR 칸이 빈 항목을 브랜치로 찾는 곳은 327-343행 근처다. 열린 PR 은 `--open-prs`(루프가 넘김)나 `gh pr list --state open --json number,headRefName`, 머지된 PR 은 `gh pr list --state merged --head <브랜치> --json number,headRefName,state` 로 읽고, 찾으면 `cmds.push(['set', id, '--pr', …, '--branch', branch])` 다. `--open-prs` 를 읽는 곳(`type Pr`, 옵션 풀이)도 같은 파일이다.
- 루프의 `skills/orch/scripts/loop/steps/board.ts` 가 `--open-prs` 를 `prs.mine.map((pr) => ({ number: pr.number, headRefName: pr.branch }))` 로 만든다. `prs.mine` 의 항목에는 `title` 이 있다(`loop/steps/prs.ts` 34행).
- worker 완료 확인 `skills/orch/scripts/loop/completion-watch.ts` 88행이 `linkBoardPr(boardPath(repo), String(pr.number), pr.branch)` 를 부른다. 같은 자리에서 `pr.title` 을 이미 읽었다.
- `linkBoardPr` 와 `findBoardItems` 는 `skills/orch/scripts/lib/board.ts` 에 있다.
- 마지막 PR 판정의 규칙 읽기는 `skills/orch/scripts/lib/last-pr.ts` 의 `rulesFrom(finish, repo)`(정규식은 Python 꼴, `pyRegExp`)다. 그 파일의 `extractTaskNumber` 는 영문·숫자·`._/-` 만 받아 한글 프로젝트 코드를 버리므로 쓰지 않는다. `finish` 절은 `section(loadConfig(repo), 'finish', FINISH_KEYS)` 로 읽는다(`board-sync.ts` 의 규칙 읽기와 같은 꼴).

## 의도 메모

- 번호 읽기 규칙은 `finish.task_pattern` 하나다(스펙 DECISION16). 새 설정 키를 만들지 않는다.
- 마지막 PR 판정의 `extractTaskNumber` 는 바꾸지 않는다(설계 DECISION5). 이 기능 범위 밖의 동작이다.

## 작업 항목

### 1. `skills/orch/scripts/lib/board.ts`

- `prTaskRef(repo: string, title: string): string | null` 를 더한다. `finish` 절에서 `rulesFrom` 으로 `taskPattern` 을 얻고, `taskPattern.exec(title)?.[1]` 이 `/^[\p{L}\p{N}._/-]+$/u` 에 맞을 때만 쓴다. 어댑터(`taskAdapter`)로 `normalizeRef` 한다. 규칙이 없거나, 맞지 않거나, 설정을 읽지 못하면(`ConfigError`, 정규식 오류) `null` 이다.
- `linkBoardPr(file, number, branch, ref?: string | null)` 로 넷째 인자를 더한다. `ref` 가 있으면 `set` 명령에 `--fill --task-ref <ref>` 를 붙인다. 주석을 고친다.

### 2. `skills/orch/scripts/board/board-sync.ts`

- `Pr` 타입에 `title?: string` 을 더하고 두 `gh pr list` 의 `--json` 에 `title` 을 넣는다.
- PR 을 찾아 `--pr` 을 쓰는 명령에 `prTaskRef(repo, discovered.title ?? '')` 가 낸 번호가 있으면 `--fill --task-ref <번호>` 를 붙인다.
- 머리 주석 60-61행(「done, goal 이 아닌 항목의 pr 칸이 비었으면 …」)에 「PR 제목에서 `finish.task_pattern` 으로 읽은 업무 번호를 빈 번호 칸에 넣는다」 를 더한다. `--open-prs` 설명에 `title` 을 더한다.

### 3. `skills/orch/scripts/loop/steps/board.ts`

`--open-prs` 의 항목에 `title: pr.title` 을 더한다.

### 4. `skills/orch/scripts/loop/completion-watch.ts`

88행의 호출을 `linkBoardPr(boardPath(repo), String(pr.number), pr.branch, prTaskRef(repo, String(pr.title ?? '')))` 로 바꾼다.

### 5. 테스트

- `skills/orch/tests/board-sync.spec.ts`: 가짜 gh 의 열린 PR 에 `title: '[P/458] 고침'` 을 두고 설정 `finish.task_pattern` 이 `\[([^\]]+)\]` 인 저장소에서, 번호 칸이 빈 항목은 `--pr` 과 함께 `task-ref` 가 `P/458` 로 채워진다. 이미 `task-ref` 가 `P/1` 인 항목은 그대로다. PR 칸이 찬 항목은 바뀌지 않는다. `task_pattern` 이 없으면 번호를 쓰지 않는다. `--open-prs` 로 받은 목록의 `title` 도 같은 결과다. 한글 프로젝트 코드(`AI-스마트홈-AI/458`)도 저장된다.
- `skills/orch/tests/completion-watch.spec.ts`: 준비됨 `worker_done` 의 PR 제목에 번호가 있으면 연결된 항목의 `task-ref` 가 채워진다. `task` 만 있는 항목은 번호를 쓰지 않는다.
- `skills/orch/tests/orch-loop.spec.ts`: `BOARD_SYNC` 를 받은 인자를 파일에 남기는 가짜 명령으로 바꾸고(`orch-loop-auto-merge.spec.ts` 105행의 `BOARD_SYNC` 바꾸기와 같은 꼴) 틱 하나를 돈 뒤, 넘긴 `--open-prs` 의 항목에 PR 의 `title` 이 있는지 본다. 이 줄이 빠지면 루프 경로에서 번호를 읽지 못한다.
- `skills/orch/tests/lib-board.spec.ts`: `prTaskRef` 의 규칙 없음, 맞지 않음, 한글 번호, `dooray` 어댑터의 기본 프로젝트 붙이기.

### 6. 문서와 조각

- `skills/orch/references/board.md` 「갱신 담당」 표의 「준비됨 `worker_done`」 행과 「틱마다」 행에 「PR 제목의 업무 번호(`finish.task_pattern`)를 빈 업무 번호 칸(`task-ref`)에 넣는다」 를 더한다.
- `skills/orch/changes/board-task-link.minor.md` 에 「PR 이 보드 항목에 붙을 때 PR 제목의 업무 번호를 빈 업무 번호 칸에 저장한다」 줄을 더한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/board-sync.spec.ts skills/orch/tests/completion-watch.spec.ts skills/orch/tests/lib-board.spec.ts skills/orch/tests/orch-loop.spec.ts skills/orch/tests/loop-steps.spec.ts skills/orch/tests/loop-order.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과. `loop-order.spec.ts` 의 기록이 `--open-prs` 값 때문에 달라지면 그 폴더(`skills/orch/tests/loop-order/`)의 기록을 고치고 변경 파일 표에 더한다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/board.ts` | 수정 (prTaskRef, linkBoardPr 의 번호) |
| `skills/orch/scripts/board/board-sync.ts` | 수정 |
| `skills/orch/scripts/loop/steps/board.ts` | 수정 |
| `skills/orch/scripts/loop/completion-watch.ts` | 수정 |
| `skills/orch/tests/board-sync.spec.ts` | 수정 |
| `skills/orch/tests/completion-watch.spec.ts` | 수정 |
| `skills/orch/tests/lib-board.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop.spec.ts` | 수정 |
| `skills/orch/references/board.md` | 수정 |
| `skills/orch/changes/board-task-link.minor.md` | 수정 |
