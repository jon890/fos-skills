# Phase 01. 스크립트를 묶음 폴더로 옮기고 코드의 경로를 명령 표로 푼다

**Execution profile**: deep

## 목표

`skills/orch/scripts` 의 진입 스크립트를 `scripts/<묶음>/` 으로 옮기고, 진입점·스크립트·lib·핸들러·doctor·테스트가 새 배치에서 지금과 같은 판정으로 돌게 한다.

**범위 외**: 스킬 문서와 다른 기능 문서의 경로(phase-02), 옛 배치 경로가 남지 않는지 보는 테스트(phase-02), lib 와 hooks 폴더의 배치(스펙 DECISION6 으로 그대로), 판정 규칙과 출력.

## 컨텍스트

**요구사항**: REQ9

**근거 문서**: `docs/features/orch-cli/spec.md`(REQ9, DECISION6, DECISION17, 부록), `docs/features/orch-cli/design.md`(REQ9 행, 「책임과 경계」 의 명령 표·핸들러 환경, 「PR3 의 Python 자리」)

- 이름과 경로의 원본은 `skills/orch/scripts/lib/commands.ts` 의 `ROWS` 다. 행의 `script` 값은 scripts 기준 상대경로이고 이 phase 에서 `<묶음>/<파일>` 꼴이 된다(설계 「명령 표 항목」).
- 파일 이름은 그대로다. `merge_queue.`, `merge-with-finish.` 처럼 ps 명령줄의 부분 문자열로 큐를 가리는 판정(`skills/orch/scripts/orch-loop.ts` 의 `QUEUE_COMMANDS`, `isQueue`, `extensions/work-board/bin/merge-queue.ts` 의 `isQueue`)은 파일 이름만 보므로 고치지 않는다.
- `orch-doctor.py`, `ts_shim.py` 는 `scripts/` 바로 아래에 남는다(설계 「PR3 의 Python 자리」). `orch-doctor.py` 는 지금 같은 폴더의 같은 이름 `.ts` 로 넘기므로 넘길 대상을 `doctor/orch-doctor.ts` 로 준다.
- 핸들러 환경의 `ORCH_SCRIPTS` 는 계속 스크립트 폴더(`skills/orch/scripts`)이고 `ORCH_BIN` 은 진입점이다(`lib/events.ts`). 둘 다 값이 바뀌지 않는다.

### 폴더 배치

묶음은 명령 표의 `group` 이다. 한 스크립트는 그 스크립트를 부르는 행의 묶음 하나에만 속한다(실측 2026-11-06: 스크립트마다 묶음이 하나다).

| 폴더 | 파일 |
| --- | --- |
| `wait/` | `wait-important.ts`, `triage-messages.ts`, `user-active.ts`, `watch-questions.ts` |
| `loop/` | `orch-loop.ts`, `stalled-workers.ts` |
| `worker/` | `launch-worker.ts`, `send-to-worker.ts`, `nudge-worker.ts`, `worker-ask.ts`, `adopt-sessions.ts`, `make-worktree.ts`, `worktree-deny.ts`, `link-claude-profile.ts` |
| `queue/` | `merge-with-finish.ts`, `merge_queue.ts`, `finish-pr.ts`, `ci-ready.ts`, `notify-conflicts.ts`, `overlap_units.ts`, `reserve-migration.ts` |
| `cleanup/` | `cleanup-sweep.ts`, `remove-worktree.ts`, `handoff-cleanup.ts` |
| `board/` | `board-sync.ts`, `board-release.ts`, `goal-progress.ts` |
| `study/` | `study-candidates.ts` |
| `spec/` | `spec-lint.ts`, `spec-line.ts` |
| `doctor/` | `orch-doctor.ts`, `migrate-orch-dir.ts`, `gh-usage.ts`, `install-cli.ts` |
| `paths/` | `orch_paths.ts` |
| `status/` | `orch-status.ts` |
| `slot/` | `heavy-slot.ts`, `mem-gate.ts` |
| 그대로 | `lib/`, `handlers/`, `orch-doctor.py`, `ts_shim.py` |

### 경로를 바꿀 자리(검색 명령과 결과, 2026-11-06)

`NAMES` 는 지금 `skills/orch/scripts/*.ts` 의 파일 이름(확장자 뺀 것)을 `|` 로 이은 것이다.

```bash
NAMES=$(cd skills/orch/scripts && ls *.ts | sed 's/\.ts$//' | paste -sd'|' -)
git grep -nE "join\(HERE|resolve\(HERE|new URL\(|'\.\.'" -- 'skills/orch/scripts/*.ts' skills/orch/scripts/handlers
git grep -nE "($NAMES)\.ts" -- skills/orch/scripts/lib skills/orch/scripts/handlers skills/orch/hooks skills/orch/bin extensions bin | grep -vE '^[^:]+:[0-9]+:\s*(//|\*)'
git grep -nE "scripts/($NAMES)\.ts|\.\./scripts/" -- skills/orch/tests scripts/tests extensions
```

결과(주석 줄 뺀 코드):

| 자리 | 지금 | 바꿀 것 |
| --- | --- | --- |
| 옮긴 스크립트의 import | `'./lib/…'` | `'../lib/…'`. 같은 묶음의 다른 스크립트 import(`wait-important.ts` → `./triage-messages.ts`)는 그대로 |
| 스크립트끼리 부르는 경로 | `join(HERE, '<이름>.ts')` 14곳(`board-sync`, `cleanup-sweep`, `finish-pr` 2, `heavy-slot`, `merge-with-finish` 2, `orch-loop` 7) | `scriptPath('<이름>')`. 환경 변수 덮어쓰기(`SEND_TO_WORKER` 등)는 그대로 앞에 둔다 |
| 같은 꼴의 다른 자리 | `make-worktree.ts` 의 `new URL('./worktree-deny.ts')`, `handlers/decision-pending.ts` 의 `new URL('../nudge-worker.ts')`, `lib/conflicts.ts`·`lib/tell-worker.ts` 의 `join(dirname(dirname(…)), 'send-to-worker.ts')` | `scriptPath(…)` |
| 보드 실행기 | `board-release`, `board-sync`, `finish-pr`, `goal-progress` 의 `resolve(HERE, '../../../extensions/…')` | 한 단계 더 올라간다(`'../../../../extensions/…'`). 그 파일에 `lib/board.ts` 의 `BOARD_BIN` 이 있으면 그것을 쓴다 |
| 스킬 폴더 기준 경로 | `spec-lint.ts` 의 `'..', 'templates'`, `install-cli.ts` 의 `'..', '..', '..', 'bin', 'orch'`, `orch-doctor.ts` 의 `new URL('.')`(스크립트 폴더)·`new URL('..')`(스킬 폴더) | 한 단계씩 더 올린다. doctor 의 스크립트 폴더는 `SCRIPTS_DIR`(아래 1)을 쓴다 |
| 진입점 `bin/orch.ts` | `commands.scriptPath(dir, bare)`, 없는 이름일 때 `names(dir)` 가 `dir` 의 `.ts` 를 나열 | `scriptIn(dir, bare)`. 이름 목록은 명령 표의 옛 이름에서 그 폴더에 파일이 있는 것 |
| `orch-doctor.py` | `ts_shim.exec_ts(__file__)` 가 같은 이름 `.ts` 로 넘긴다 | `exec_ts` 에 넘길 대상 경로 인자를 더하고 `doctor/orch-doctor.ts` 를 준다 |
| doctor `LOOP-STALE` | `staleLoops` 가 ps 의 `…/orch-loop.ts` 를 찾고 `staleBundle` 이 `dirname(dirname(script))` 를 스킬 폴더로 본다 | 스킬 폴더는 경로의 마지막 `/scripts/` 앞이다. 옛 배치(`scripts/orch-loop.ts`)와 새 배치(`scripts/loop/orch-loop.ts`)를 모두 같은 스킬 폴더로 읽는다. 옛 번들의 루프가 이 판정의 대상이기 때문이다 |
| doctor `DIRECT-PATH` | `orch/scripts/`, `$SKILL_DIR/scripts/`, `$ORCH_SCRIPTS/` 바로 뒤의 `<이름>.ts`, `join(ORCH_SCRIPTS, '<이름>.ts')` | 그 사이에 묶음 폴더 하나(`<묶음>/`, `join` 은 `'<묶음>', ` 이나 `'<묶음>/<이름>.ts'`)가 있어도 찾는다. 새 배치의 직접 경로도 직접 경로 호출이기 때문이다 |
| 테스트 | `skills/orch/tests/*.spec.ts` 의 `'../scripts/<이름>.ts'`(import, `new URL`) 60여 곳 | `'../scripts/<묶음>/<이름>.ts'`. doctor 와 훅 테스트의 입력 문자열(옛 경로를 판정하는 사례)은 그대로 |
| 테스트의 폴더 읽기 | `lib-bundle.spec.ts`(모든 직접 실행 스크립트가 `lib/bundle.ts` 에 닿는다), `lib-commands.spec.ts`(묶음 이름과 옛 스크립트 이름이 겹치지 않는다)가 `readdirSync(SCRIPTS)` 로 한 층만 읽는다 | 명령 표의 `script` 로 파일을 모은다. 폴더가 바뀌어도 빠지는 스크립트가 없게 한다 |
| `scripts/tests/test_doc_script_refs.py` | `DOCTOR = scripts/orch-doctor.ts`, 이름 목록을 `scripts/*.ts` 에서 읽는다 | `doctor/orch-doctor.ts`, 이름은 `scripts/*/*.ts` 와 `scripts/*.py` 에서 읽는다 |

## 의도 메모

- 옛 경로에 사본이나 링크를 두지 않는다(스펙 DECISION17). 다른 저장소의 직접 경로는 doctor 의 `DIRECT-PATH` 가 알리고 코디네이터가 머지 전에 고친다.
- 명령 표에 `scriptPath(name)` 을 더하고 지금의 두 인자 함수는 `scriptIn(dir, name)` 으로 이름을 바꾼다. 설계가 스크립트끼리 부르는 함수를 `scriptPath(이름)` 으로 적었고, 진입점은 고른 번들의 폴더를 따로 받아야 하기 때문이다. `scriptPath` 는 이 번들의 스크립트 폴더 기준 절대경로를 내고 파일이 있는지 보지 않는다. 표에 없는 이름이면 던진다(프로그래밍 오류다).
- 스크립트가 `lib/commands.ts` 를 import 해도 부수 효과는 없다. 모듈 수준에서 `ENTRY` 경로 계산과 빈 `Map` 하나만 만든다(실측: `orchWord` 는 부를 때만 PATH 를 읽는다).
- `HERE` 가 남는 곳이 없으면 선언도 지운다.

## 작업 항목

### 1. `skills/orch/scripts/lib/commands.ts`

- 행마다 `script` 를 `<묶음>/<파일>` 로 바꾼다(위 「폴더 배치」).
- `export const SCRIPTS_DIR`(이 번들의 `skills/orch/scripts` 절대경로)와 `export function scriptPath(name: string): string` 을 더한다. `name` 은 옛 이름이나 파일 이름(`merge_queue`, `merge_queue.ts`)이다.
- 지금의 `scriptPath(dir, name)` 을 `scriptIn(dir, name)` 으로 바꾼다. 행이 있으면 `join(dir, row.script)`, 없으면 지금처럼 `join(dir, '<이름>.ts')` 이고 파일이 없으면 `null` 이다.
- 머리 주석과 `helpText` 의 경로 설명을 새 배치에 맞춘다.

### 2. `git mv` 로 옮기기와 import

위 표대로 `git mv` 한다. 옮긴 파일의 `'./lib/` 을 `'../lib/` 로 바꾸고 위 「경로를 바꿀 자리」 표의 코드 자리를 고친다.

### 3. 진입점, doctor, Python 진입점

- `skills/orch/bin/orch.ts`: `scriptIn` 을 쓰고, 이름 목록을 명령 표에서 만든다. 머리 주석의 `scripts/NAME.ts` 설명을 명령 표 경로로 바꾼다.
- `skills/orch/scripts/doctor/orch-doctor.ts`: `LOOP-STALE` 의 스킬 폴더 풀이, `DIRECT-PATH` 정규식, 스크립트·스킬 폴더 경로.
- `skills/orch/scripts/ts_shim.py`, `orch-doctor.py`: 넘길 대상 경로.

### 4. 테스트

- 옮긴 스크립트를 가리키는 테스트 경로를 새 배치로 바꾼다.
- `lib-commands.spec.ts`: `scriptIn` 사례(새 배치의 경로, 없는 이름은 `null`)와 `scriptPath` 사례(모든 행의 파일이 있고 `dirname` 이 묶음 이름이다)를 더한다.
- `orch-doctor.spec.ts`: 새 배치 경로의 `DIRECT-PATH` 사례(`$SKILL_DIR/scripts/queue/merge-with-finish.ts`, `join(ORCH_SCRIPTS, 'worker', 'nudge-worker.ts')`)와, ps 에 새 배치 경로(`…/skills/orch/scripts/loop/orch-loop.ts`)로 도는 옛 번들 루프가 `LOOP-STALE` 로 나오는 사례를 더한다. 옛 배치 경로 사례는 그대로 통과한다.
- `ts-shim.spec.ts` 나 `orch-doctor.spec.ts`: `python3 skills/orch/scripts/orch-doctor.py --help` 가 0 으로 끝나는 사례가 없으면 더한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests extensions/work-board/tests scripts/tests
node --disable-warning=ExperimentalWarning skills/orch/bin/orch.ts --help
python3 skills/orch/scripts/orch-doctor.py --help
test -z "$(ls skills/orch/scripts/*.ts 2>/dev/null)"
```

## 변경 파일

`skills/orch/scripts/*.ts` 의 삭제와 `skills/orch/scripts/*/*.ts` 의 신규는 `git mv` 한 이동이다(위 「폴더 배치」 의 38개). `lib/` 와 `handlers/` 는 `*/*.ts` 에 걸리지만 그중 아래 수정 행의 파일만 고친다.

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/*.ts` | 삭제 |
| `skills/orch/scripts/*/*.ts` | 신규 |
| `skills/orch/scripts/lib/commands.ts` | 수정 |
| `skills/orch/scripts/lib/conflicts.ts` | 수정 |
| `skills/orch/scripts/lib/tell-worker.ts` | 수정 |
| `skills/orch/scripts/handlers/decision-pending.ts` | 수정 |
| `skills/orch/bin/orch.ts` | 수정 |
| `skills/orch/scripts/orch-doctor.py` | 수정 |
| `skills/orch/scripts/ts_shim.py` | 수정 |
| `skills/orch/tests/*.spec.ts` | 수정 |
| `skills/orch/tests/fixtures/cleanup-sweep.ts` | 수정 |
| `scripts/tests/test_doc_script_refs.py` | 수정 |
