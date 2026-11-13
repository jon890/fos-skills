# Phase 05. 상주 루프가 번호만 있는 항목의 업무 주소를 만든다

**Execution profile**: standard

## 목표

상주 루프가 틱마다 번호만 있고 주소가 없는 열린 항목의 주소를 어댑터로 만들어 채운다. 실패는 항목·번호마다 처음 한 번만 로그에 남기고 30분마다 다시 해 보며, 그 간격은 루프를 다시 띄워도 잇는다.

**범위 외**: 창의 칩(phase 06).

## 컨텍스트

**요구사항**: REQ6, REQ7(루프 몫), REQ8(상태 파일 문서 몫)

**근거 문서**: `docs/features/board-task-link/spec.md` REQ6·REQ7·DECISION11·DECISION12·DECISION19·DECISION20, `docs/features/board-task-link/design.md` 「루프의 주소 만들기」·「상태 파일」·「실패와 일관성」, 설계 DECISION6·DECISION7

- 루프의 틱 순서는 `skills/orch/scripts/loop/orch-loop.ts` 머리 주석 「틱」(66-82행)과 `tick` 함수의 `collect(state, await <단계>(ctx, state))` 줄(155-170행)이다. `skills/orch/tests/loop-steps.spec.ts` 가 둘이 같은지와 import 방향을 본다.
- 단계 한 파일의 꼴은 `skills/orch/scripts/loop/steps/board.ts` 를 따른다. `reporter(ctx)`(`steps/errors.ts`)로 오류 이유를 남기고 `{ errors }` 를 돌려준다. 로그는 `steps/shared.ts` 의 `log(line)` 이다.
- 상태 폴더는 `pathOf('state', repo)`(`lib/paths.ts`), 옆 파일에 쓰고 이름을 바꾸는 꼴은 `loop/completion-watch.ts` 의 `save` 와 같다.
- 보드 읽기는 `readBoard(boardPath(repo))`(`lib/board.ts`, `lib/board-file.ts`), 쓰기는 `run(scriptCommand(process.env.BOARD_BIN || BOARD_BIN, [...]))` 다.
- 주소 만들기는 phase 01 의 `taskAdapter(repo)`, `resolveTaskUrl(adapter, ref)`(`lib/task-adapters.ts`)다. 보드 명령의 `--fill`, `--if-task-ref` 는 phase 02 에서 생겼다.

## 의도 메모

- 기록 키는 항목 id 이고 값에 번호를 둔다. 번호가 바뀌면 새 번호의 첫 실패로 다시 한 줄을 남긴다(스펙 「항목과 번호마다」).
- `--if-task-ref` 거절은 실패가 아니다. 다음 틱이 새 번호로 본다.
- 틱마다 업무 도구 호출에 쓰는 시간은 60초까지, 호출마다 15초다(설계 DECISION7). 건수 상한은 두지 않는다. 테스트가 예산을 바꿀 수 있게 인자로 받는다.

## 작업 항목

### 1. `skills/orch/scripts/lib/task-links.ts`(신규)

- `fillTaskUrls(repo: string, opts: { now?: () => number; budgetMs?: number; log: (line: string) => void; resolve?: typeof resolveTaskUrl }): Promise<{ filled: string[]; failed: string[] }>`. 예산 기본값은 60000ms 다. 호출을 시작하기 전에 지난 시간이 예산을 넘었으면 멈춘다.
- 설계 「루프의 주소 만들기」 1~8 을 그대로 한다. 보드 파일이 없으면 바로 끝난다. `taskAdapter` 가 `ConfigError` 면 기록의 `config` 값과 이유가 다를 때만 `TASK-LINK-CONFIG <이유>` 를 남기고 끝난다. 이유가 없어지면 `config` 값을 지운다.
- 대상: `status !== 'done'`, `task-ref` 가 비지 않은 문자열, `task` 가 비었거나 없다. 보드 순서다.
- 기록 파일 `<state>/task-links.json` 은 `{ items: Record<string, { ref: string; at: string; reason: string }>, config?: string }` 이다. 깨졌으면 빈 기록으로 읽는다.
- 쓰기는 `['set', id, '--exact', '--fill', '--if-task-ref', ref, '--task', url, '--file', <보드 파일>]` 이다. 종료 코드 1 이고 stderr 가 「업무 번호가 바뀌어 저장하지 않았다」 나 「항목이 없다」 로 시작하면 조용히 넘어간다. 다른 실패(진행률 없는 doing 항목의 거절 따위)는 그 항목의 실패로 센다.
- 기록 정리 조건은 설계 8 그대로다. `task` 가 찬 항목(사람이 주소를 직접 넣었다)의 기록도 지운다.
- 로그 줄: 성공 `TASK-LINK <id> <번호>`, 첫 실패 `TASK-LINK-FAIL <id> <번호> <이유>`. 이유는 한 줄로 줄인다.
- 파일 맨 위 설명에 대상, 간격, 상한, 기록 꼴, 로그 줄을 적는다.

### 2. `skills/orch/scripts/loop/steps/task-links.ts`(신규)

`fillTaskLinks(ctx, state)` 가 `fillTaskUrls(ctx.repo, { log })` 를 `try` 로 부르고 `report('task-links', null | 이유)` 한다. 파일 맨 위 설명은 「업무 주소 채우기(틱 3-1)」 다.

### 3. `skills/orch/scripts/loop/orch-loop.ts`

- 머리 주석 「틱」 의 3 다음 줄에 `3-1. 업무 주소 채우기. steps/task-links.ts` 를 더한다.
- `tick` 의 `notifyPendingDecisions` 다음 줄에 `collect(state, await fillTaskLinks(ctx, state))` 를 더하고 import 한다.

### 4. `skills/orch/tests/loop-task-links.spec.ts`(신규)

임시 저장소(`ORCH_DIR` 를 임시 폴더로), 임시 보드, `resolve` 를 바꿔 넣은 가짜 주소 만들기, 고정 `now` 로 본다.

- `board.task` 가 `url-template` 인 저장소: 번호만 있는 doing 항목에 주소가 채워지고 `TASK-LINK` 한 줄이 남는다. done 항목은 건드리지 않는다. 이미 주소가 있는 항목도 그대로다.
- 설정이 없는 저장소: 아무 호출도 없고 보드가 그대로다.
- 가짜 주소 만들기가 실패하면 `TASK-LINK-FAIL` 한 줄이 남는다. `now` 를 29분 뒤로 두고 다시 부르면 호출도 로그도 없다. 31분 뒤에는 다시 부르고 로그는 남지 않는다. 그 뒤 성공하면 기록이 지워진다.
- 기록 파일을 남긴 채 새로 부르면(루프 다시 띄우기와 같다) 같은 간격이 이어진다.
- 실패 기록이 있는 항목의 번호를 바꾸면 새 번호의 첫 실패로 한 줄이 다시 남는다.
- 주소를 만든 뒤 쓰기 전에 번호가 바뀐 경우(가짜 주소 만들기 안에서 `board.ts set <id> --task-ref Z/9` 를 부른다)는 주소가 쓰이지 않고 실패 로그도 없다(REQ7).
- 예산을 넘긴 뒤에는 호출하지 않는다. 바꿔 넣은 주소 만들기가 `now` 를 예산보다 크게 밀면 대상 셋 가운데 첫 하나만 부른다.
- 실패 기록이 있는 항목에 `board.ts set <id> --task <주소>` 를 넣고 다시 부르면 기록이 지워진다.
- 틱 전체 사례: `board.task` 가 `dooray` 인 임시 저장소, `DOORAY_BIN` 이 종료 코드 1 로 끝나는 가짜, 번호만 있는 doing 항목 하나. `orch loop run --repo <저장소> --once` 을 돌린 뒤 같은 상태 폴더로 `orch loop run --repo <저장소> --once` 를 다시 돈다(그 사이 루프를 다시 띄운 것과 같다). 루프 로그(`loop.log`)에 `TASK-LINK-FAIL <id> <번호> dooray post get: …` 이 한 줄뿐이다. 틱 실행의 가짜 orca·gh 준비는 `skills/orch/tests/orch-loop.spec.ts` 의 꼴을 따른다.
- 틀린 `board.task` 는 `TASK-LINK-CONFIG` 한 줄이고, 같은 이유로 다시 부르면 줄이 없다.

### 5. 문서와 조각

- `docs/data-schema.md` 「orch 루트에 더하는 파일」 표에 `state/task-links.json` 행을 더한다. 담는 것은 설계 「상태 파일」, 수명은 「성공하거나 항목이 끝나면 그 기록을 지운다. 형식은 `lib/task-links.ts` 머리 주석이 소유한다」 다.
- `skills/orch/references/board.md` 「갱신 담당」 표에 「틱마다 | `orch-loop.ts` → `lib/task-links.ts` | 번호만 있는 열린 항목의 업무 주소를 어댑터로 만들어 채운다. 실패는 항목·번호마다 한 번 `TASK-LINK-FAIL` 로 남기고 30분마다 다시 해 본다」 행을 더한다.
- `skills/orch/changes/board-task-link.minor.md` 에 「상주 루프가 번호만 있는 열린 보드 항목의 업무 주소를 만들어 채운다」 줄을 더한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/loop-task-links.spec.ts skills/orch/tests/loop-steps.spec.ts skills/orch/tests/loop-order.spec.ts skills/orch/tests/orch-loop.spec.ts skills/orch/tests/orch-loop-import.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과. 고정 입력 기록(`loop-order.spec.ts`)이 새 단계 때문에 달라지면 기록 폴더의 결과를 고치고 변경 파일 표에 더한다. 설정에 `board.task` 가 없는 기록은 달라지지 않아야 한다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/task-links.ts` | 신규 |
| `skills/orch/scripts/loop/steps/task-links.ts` | 신규 |
| `skills/orch/scripts/loop/orch-loop.ts` | 수정 (틱 3-1) |
| `skills/orch/tests/loop-task-links.spec.ts` | 신규 |
| `docs/data-schema.md` | 수정 (`state/task-links.json` 행) |
| `skills/orch/references/board.md` | 수정 |
| `skills/orch/changes/board-task-link.minor.md` | 수정 |

| `skills/orch/tests/orch-loop.spec.ts` | 수정 (실제 틱 프로세스를 두 번 띄워 실패 간격 검증) |

성공한 단계는 앞 틱 오류가 있을 때만 null 로 해제한다. 설정 없는 저장소의 출력 기록을 유지한다.
